import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AppStatus,
  ChartType,
  ChatService,
  CombinePick,
  DeckVariant,
  DesignEntry,
  DocumentInfo,
  ProjectProfile,
  RenderResult,
  RestoredPresentation,
  Session,
  Settings,
  SubscriptionStatus,
} from '../shared/contracts';
import { compileDeck } from '../shared/layouts';
import { api, apiFetch } from './api';
import { canInsertIntoPresentation, inPowerPoint, insertIntoPresentation, readAllSlides } from './office';
import { SlideActionsPanel } from './SlideActionsPanel';
import { RehearsalPanel } from './RehearsalPanel';
import { SourcesDialog } from './SourcesDialog';
import { AddinGuide } from './AddinGuide';
import { deckRehearsalSlides } from '../shared/rehearsal';
import { Icon, Modal, Spinner } from './ui';
import { SettingsDialog, withProvider } from './SettingsDialog';
import { SlidePreview } from './SlidePreview';
import { themes, TEMPLATE_THEME_ID } from '../shared/themes';
import { AI_THEME_ID } from '../shared/ai-theme';
import { typographyProfiles } from '../shared/typography';
import { MAX_SLIDES, APP_VERSION, MAX_PROMPT_CHARACTERS } from '../shared/contracts';
import { HistoryDialog } from './HistoryDialog';
import { LayoutDialog } from './LayoutDialog';
import { ChartDialog } from './ChartDialog';
import { ChatHandoffPanel, chatServices } from './ChatHandoffPanel';
import { DesignDialog, SaveDesignDialog } from './DesignDialog';
import { subscriptionNames } from './SubscriptionConnectionPanel';
import { ProjectDialog } from './ProjectDialog';
import { CombinePanel } from './CombinePanel';
import { RefreshPanel, RefreshResult, refreshMarks } from './RefreshPanel';
import {
  RoutePanel,
  availableTargets,
  defaultChoice,
  routeOf,
  routeSummary,
  targetNames,
  type AiChoice,
  type Route,
} from './RoutePanel';
import { ProposalPicker } from './ProposalPicker';
import { ReviewHints } from './ReviewHints';
import { BlankFields, OpenFactsForm } from './BlankFields';
import { deckBlanks } from '../shared/blanks';

const defaultSettings: Settings = {
  provider: 'chat',
  model: 'manual-chat',
  chatService: 'chatgpt',
  mode: 'presentation',
  activeProjectId: '00000000-0000-4000-8000-000000000001',
};
const providerLabel = {
  subscription: '月額版で自動作成',
  chat: '手動チャット連携',
  claude: '手動チャット連携',
  local: 'ローカル LLM',
  demo: 'サンプル体験',
};
const ratingLabels = ['改善が必要', 'やや使いにくい', 'ふつう', '良い', 'とても良い'];
const feedbackReasons = ['見やすさ', '説明の分かりやすさ', '内容の正確さ', '情報量', '配色・雰囲気'];
const updateMessage =
  '更新を反映する準備ができました。作成中の資料と入力中の指示・返答を保存してから、Restart-DesignerExtension.cmd を実行し、この画面を開き直してください。';
const activeSessionStorageKey = 'designer-extension.current-session';
const opaqueSessionId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function storedSessionId(): string | undefined {
  try {
    const id = sessionStorage.getItem(activeSessionStorageKey);
    if (id && opaqueSessionId.test(id)) return id;
    if (id) sessionStorage.removeItem(activeSessionStorageKey);
  } catch {
    /* Storage can be unavailable inside a PowerPoint task pane. */
  }
  return undefined;
}
function rememberSessionId(id: string | undefined) {
  try {
    if (id && opaqueSessionId.test(id)) sessionStorage.setItem(activeSessionStorageKey, id);
    else sessionStorage.removeItem(activeSessionStorageKey);
  } catch {
    /* Saving or restoring the document still works without browser storage. */
  }
}
async function resumePresentation(
  id: string,
  signal: AbortSignal,
): Promise<{ restored?: RestoredPresentation; missing?: boolean; error?: string }> {
  try {
    const response = await apiFetch(`/sessions/${id}/resume`, { signal });
    if (response.status === 404 || response.status === 410) return { missing: true };
    if (!response.ok)
      return {
        error:
          '前回の作業を開けませんでした。接続を確認して画面を再読み込みしてください。作業の識別情報は保持しています。',
      };
    const restored = (await response.json()) as RestoredPresentation;
    if (
      restored?.session?.id !== id ||
      !Array.isArray(restored.documents) ||
      (restored.mode !== 'presentation' && restored.mode !== 'reading')
    )
      return { error: '前回の作業の情報を確認できませんでした。画面を再読み込みしてください。' };
    return { restored };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    return {
      error:
        '前回の作業に接続できませんでした。接続を確認して画面を再読み込みしてください。作業の識別情報は保持しています。',
    };
  }
}

export default function App() {
  const [settings, setSettings] = useState<Settings>(defaultSettings);
  const [projects, setProjects] = useState<ProjectProfile[]>([]);
  const [status, setStatus] = useState<AppStatus>();
  const [loading, setLoading] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [projectsOpen, setProjectsOpen] = useState(false);
  const [designsOpen, setDesignsOpen] = useState(false);
  const [saveDesignTarget, setSaveDesignTarget] = useState<{ variantId: string; slideId?: string; name: string }>();
  const [chartPicker, setChartPicker] = useState<{ variantId: string; index: number }>();
  const [layoutPicker, setLayoutPicker] = useState<'catalog' | { variantId: string; index: number }>();
  const [documents, setDocuments] = useState<DocumentInfo[]>([]);
  const [prompt, setPrompt] = useState('');
  const [session, setSession] = useState<Session>();
  const [selectedVariant, setSelectedVariant] = useState('');
  const [selectedSlide, setSelectedSlide] = useState<{ id: string; index: number; variantId: string }>();
  const [compareIndex, setCompareIndex] = useState<number>();
  const [cloudConsent, setCloudConsent] = useState(false);
  const [transmissionOpen, setTransmissionOpen] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [dropActive, setDropActive] = useState(false);
  const [rating, setRating] = useState(0);
  const [reasons, setReasons] = useState<string[]>([]);
  const [feedbackSaved, setFeedbackSaved] = useState(false);
  const [sourcesOpen, setSourcesOpen] = useState<{ variantId: string; slideId?: string }>();
  const [guideOpen, setGuideOpen] = useState(false);
  const [setupFromHandoff, setSetupFromHandoff] = useState(false);
  const [oneShot, setOneShot] = useState(false);
  const [showMarks, setShowMarks] = useState(true);
  const [connections, setConnections] = useState<SubscriptionStatus>();
  const [aiChoice, setAiChoice] = useState<AiChoice>();
  // Manual chat: whether the instruction carries the material as it is or masked (the project's choice by default).
  const [chatScope, setChatScope] = useState<'full' | 'masked'>('full');
  // The samples of the offered directions are made in the background, one card after another.
  const [previewing, setPreviewing] = useState<number>();
  // Answers to the facts the outline needs but the request does not give, typed before the pages are made.
  const [facts, setFacts] = useState<Record<string, string>>({});
  const previewRun = useRef<{ id: string; stopped: boolean; current?: Promise<unknown> }>();
  const request = useRef<AbortController>();
  const liveSession = useRef<Session>();
  const externalPreview = useRef<string>();
  liveSession.current = session;
  const fileInput = useRef<HTMLInputElement>(null);
  const promptInput = useRef<HTMLTextAreaElement>(null);
  const recoveryPanel = useRef<HTMLElement>(null);
  const repairPanel = useRef<HTMLElement>(null);
  const phase = session?.phase;
  const updateRequired = !!status && status.version !== APP_VERSION;
  const isDemo = settings.provider === 'demo';
  const activeProvider = session?.provider ?? settings.provider;
  const isChat = activeProvider === 'chat' || activeProvider === 'claude';
  const isSubscription = activeProvider === 'subscription';
  const isRemote = isChat || isSubscription;
  // Choosing the AIs at creation: available when slides are written automatically (monthly services or the local LLM).
  const pickerActive =
    !session && !__HOSTED__ && (settings.provider === 'subscription' || settings.provider === 'local');
  const subscriptionService = session?.subscriptionService ?? settings.subscriptionService ?? 'chatgpt';
  const handoffPending = !!session?.chatHandoff;
  const aiName = isSubscription
    ? subscriptionNames[subscriptionService]
    : chatServices[session?.chatHandoff?.service ?? settings.chatService ?? 'chatgpt'].name;
  const variants = session?.variants ?? [];
  const currentVariant = variants.find(variant => variant.id === selectedVariant) ?? variants[0];
  // The two drafts shown side by side (any two when there are three).
  const [pairIds, setPairIds] = useState<string[]>([]);
  const pair = useMemo(() => {
    const chosen = pairIds.map(id => variants.find(v => v.id === id)).filter((v): v is DeckVariant => !!v);
    return [...new Set([...chosen, ...variants])].slice(0, 2);
  }, [pairIds, variants]);
  const letterOf = (variant: DeckVariant) => String.fromCharCode(65 + Math.max(0, variants.indexOf(variant)));
  const variantCount = useRef(0);
  useEffect(() => {
    if (variants.length > variantCount.current && variantCount.current > 0)
      setPairIds([currentVariant?.id ?? variants[0].id, variants[variants.length - 1].id]);
    variantCount.current = variants.length;
  }, [variants.length]);
  const activeProjectId = session?.projectId ?? settings.activeProjectId ?? defaultSettings.activeProjectId!;
  const activeProject = projects.find(project => project.id === activeProjectId) ?? projects[0];
  const scenes = useMemo(() => new Map(variants.map(variant => [variant.id, compileDeck(variant.deck)])), [variants]);
  const activeRender = currentVariant?.render;
  const factKey = JSON.stringify(session?.outline?.openFacts ?? []);
  useEffect(() => {
    setFacts(Object.fromEntries((session?.outline?.openFacts ?? []).map(f => [f.label, f.value ?? ''])));
  }, [session?.id, factKey]);
  const blanksLeft = useMemo(() => (currentVariant ? deckBlanks(currentVariant.deck).length : 0), [currentVariant]);
  const officeInsert = useMemo(() => canInsertIntoPresentation(), []);
  const officeHost = useMemo(() => inPowerPoint(), []);
  const projectTemplate = activeProject?.template;
  const themeName = (id?: string) =>
    id === TEMPLATE_THEME_ID ? '会社テンプレート' : id === AI_THEME_ID ? 'AIが決めた配色' : themes[id ?? '']?.name;
  const hasSources = !!currentVariant?.deck.slides.some(slide => slide.sources.length);
  const chartVariant = chartPicker ? variants.find(v => v.id === chartPicker.variantId) : undefined;
  const chartSlide = chartPicker ? chartVariant?.deck.slides[chartPicker.index] : undefined;
  const layoutVariant =
    typeof layoutPicker === 'object' ? variants.find(v => v.id === layoutPicker.variantId) : undefined;
  const layoutSlide = typeof layoutPicker === 'object' ? layoutVariant?.deck.slides[layoutPicker.index] : undefined;
  const warnings = [
    ...new Set([
      ...documents.flatMap(doc => doc.warnings),
      ...(session?.warnings ?? []),
      ...variants.flatMap(variant => variant.render?.warnings ?? []),
    ]),
  ];

  useEffect(() => {
    if (session?.recovery) recoveryPanel.current?.scrollIntoView({ block: 'center', behavior: 'auto' });
  }, [session?.recovery]);
  useEffect(() => {
    if (session?.repairReport && !session.recovery)
      repairPanel.current?.scrollIntoView({ block: 'center', behavior: 'auto' });
  }, [session?.repairReport, session?.recovery]);

  useEffect(() => {
    const controller = new AbortController();
    const previousId = storedSessionId();
    Promise.all([
      api<Settings>('/settings', { signal: controller.signal }),
      api<AppStatus>('/status', { signal: controller.signal }),
      api<{ projects: ProjectProfile[] }>('/projects', { signal: controller.signal }),
      previousId
        ? resumePresentation(previousId, controller.signal)
        : Promise.resolve({} as { restored?: RestoredPresentation; missing?: boolean; error?: string }),
    ])
      .then(([value, appStatus, projectList, resumed]) => {
        if (controller.signal.aborted) return;
        setProjects(projectList.projects);
        setSettings(value);
        setStatus(appStatus);
        if (resumed.restored) {
          const restored = resumed.restored,
            deck = restored.session.variants[0]?.deck;
          liveSession.current = restored.session;
          setSession(restored.session);
          setSelectedVariant(restored.session.variants[0]?.id ?? '');
          setDocuments(restored.documents);
          setSettings({
            ...value,
            activeProjectId: restored.session.projectId ?? value.activeProjectId,
            mode: restored.mode,
            ...(deck
              ? { slideCount: deck.slides.length, themeId: deck.themeId, typographyId: deck.typographyId ?? 'auto' }
              : {}),
          });
          setNotice(
            restored.session.chatHandoff
              ? '前回の連携を再開しました。AIの返答を下の欄に取り込めます。'
              : '前回の作業を開きました。AIは呼び出していません。',
          );
        } else if (resumed.missing) {
          if (storedSessionId() === previousId) rememberSessionId(undefined);
          setNotice('前回の作業は終了しています。保存済みの資料は履歴から開いてください。');
        } else if (resumed.error) setError(resumed.error);
        setLoading(false);
      })
      .catch(error => {
        if (error.name !== 'AbortError') {
          setLoading(false);
          setError(error.message || 'アプリに接続できません。起動用ファイルから開き直してください。');
        }
      });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    if (session?.id) rememberSessionId(session.id);
  }, [session?.id]);

  const run = useCallback(
    async (label: string, operation: (signal: AbortSignal) => Promise<void>) => {
      if (updateRequired) {
        setError(updateMessage);
        return;
      }
      if (request.current) return;
      const controller = new AbortController();
      request.current = controller;
      setBusy(label);
      setError('');
      setNotice('');
      try {
        await operation(controller.signal);
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError')
          setNotice('待機を中止しました。サーバー側の処理が続いている場合があります。');
        else {
          setError(error instanceof Error ? error.message : '処理に失敗しました。もう一度お試しください。');
          if (session)
            try {
              const latest = await api<Session>(`/sessions/${session.id}`);
              setSession(previous => (previous?.id === latest.id ? latest : previous));
            } catch {
              /* Keep the operation's original error. */
            }
        }
      } finally {
        if (request.current === controller) {
          request.current = undefined;
          setBusy('');
        }
      }
    },
    [updateRequired, session],
  );

  const updateSession = (next: Session) => {
    rememberSessionId(next.id);
    liveSession.current = next;
    setSession(next);
    if (!next.variants.some(variant => variant.id === selectedVariant)) setSelectedVariant(next.variants[0]?.id ?? '');
    setFeedbackSaved(false);
    setRating(0);
    setReasons([]);
  };

  useEffect(() => {
    const sessionId = session?.id,
      pendingId = session?.chatHandoff?.requestId;
    if (!sessionId || !pendingId || busy || updateRequired) return;
    let stopped = false,
      timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    async function refresh() {
      if (stopped || request.current) return;
      try {
        const latest = await api<Session>(`/sessions/${sessionId}`, { signal: controller.signal });
        const current = liveSession.current;
        if (
          stopped ||
          request.current ||
          !current ||
          current.id !== sessionId ||
          current.chatHandoff?.requestId !== pendingId
        )
          return;
        if (JSON.stringify(latest) !== JSON.stringify(current)) {
          updateSession(latest);
          if (!latest.chatHandoff) {
            setPrompt('');
            setSelectedSlide(undefined);
            if (latest.phase === 'ready' && latest.variants.length) {
              const previewKey = `${sessionId}:${pendingId}`;
              if (externalPreview.current !== previewKey) {
                externalPreview.current = previewKey;
                await run('連携したAIの結果を反映しています', async signal => {
                  await nativePreview(
                    latest,
                    latest.variants.find(v => v.id === selectedVariant) ?? latest.variants[0],
                    signal,
                  );
                });
              }
            }
          }
        }
      } catch {
        /* A temporary connection error must not erase the reply or repeatedly interrupt the user. */
      } finally {
        const current = liveSession.current;
        if (!stopped && current && current.id === sessionId && current.chatHandoff?.requestId === pendingId)
          timer = setTimeout(() => void refresh(), 2000);
      }
    }
    timer = setTimeout(() => void refresh(), 1200);
    return () => {
      stopped = true;
      controller.abort();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [session?.id, session?.chatHandoff?.requestId, busy, updateRequired, status?.nativeAvailable, selectedVariant]);

  function addFiles(files: FileList | File[] | null) {
    if (!files?.length || busy || session) return;
    if (isDemo) {
      setNotice('サンプル体験では資料を読み込みません。設定で AIチャット連携 またはローカル LLM を選んでください。');
      return;
    }
    const chosen = Array.from(files),
      invalid = chosen.filter(file => !/\.(pdf|csv|xlsx|pptx|txt|md)$/i.test(file.name));
    if (invalid.length) {
      setError('PDF、CSV、XLSX、PPTX、TXT、MD ファイルを選んでください。');
      return;
    }
    if (chosen.length + documents.length > 8) {
      setError('一度に追加できる資料は 8 件までです。');
      return;
    }
    const body = new FormData();
    chosen.forEach(file => body.append('files', file));
    void run('資料を読み取っています', async signal => {
      const data = await api<{ documents: DocumentInfo[] }>('/documents', { method: 'POST', body, signal });
      setDocuments(previous => [...previous, ...data.documents]);
      setCloudConsent(false);
    });
    if (fileInput.current) fileInput.current.value = '';
  }

  // Mirrors the server (wantsProposals): the first outline of an AI-designed deck made through a monthly plan.
  // A page can be looked at as a picture through a monthly plan when the AI designs (the server checks masking).
  const canRefine = isSubscription && settings.designMode !== 'template';
  const proposalsExpected =
    isSubscription &&
    settings.designMode !== 'template' &&
    settings.outlineProposals !== false &&
    (!pickerActive || (aiChoice?.targets[0] !== 'local' && aiChoice?.scope !== 'design'));
  /** Makes the samples of the offered directions one after another, without blocking the screen. */
  async function makePreviews(next: Session) {
    if (next.phase !== 'clarifying' || !next.proposals || settings.proposalPreviews === false) return;
    if (previewRun.current) previewRun.current.stopped = true;
    const job: { id: string; stopped: boolean; current?: Promise<unknown> } = { id: next.id, stopped: false };
    previewRun.current = job;
    for (let index = 0; index < next.proposals.items.length; index++) {
      const item = next.proposals.items[index];
      if (job.stopped || previewRun.current !== job) break;
      if (item.preview || item.previewError) continue;
      setPreviewing(index);
      job.current = api<Session>(`/sessions/${next.id}/proposal-preview`, {
        method: 'POST',
        body: JSON.stringify({ index }),
      }).then(
        latest => {
          if (!job.stopped && liveSession.current?.id === latest.id) updateSession(latest);
        },
        () => undefined,
      );
      await job.current;
    }
    if (previewRun.current === job) {
      previewRun.current = undefined;
      setPreviewing(undefined);
    }
  }
  /** Stops making samples; waits for the one being made (the AI takes one request at a time). */
  async function stopPreviews() {
    const job = previewRun.current;
    if (!job) return;
    job.stopped = true;
    previewRun.current = undefined;
    if (job.current) {
      setBusy('作成中の見本が仕上がるのを待っています');
      await job.current;
    }
    setPreviewing(undefined);
  }
  async function submit() {
    if (loading || busy || handoffPending) return;
    if (prompt.length > MAX_PROMPT_CHARACTERS) {
      setError('指示は60,000文字までです。参考本文はTXTなどの資料として追加し、指示欄には目的や条件を残してください。');
      return;
    }
    if (!session) {
      if (!prompt.trim() && !isDemo) {
        promptInput.current?.focus();
        return;
      }
      if (pickerActive && (!aiChoice?.targets.length || pickerProblem)) {
        setError(pickerProblem || '作成するAIを選んでください。');
        return;
      }
      if (needsConsent && !cloudConsent) {
        setError(
          pickerActive
            ? `${cloudTargets.map(t => targetNames[t]).join('・')}へ送信する内容を確認し、送信への同意にチェックしてください。`
            : isSubscription
              ? `${aiName}へ送信する内容を確認し、送信への同意にチェックしてください。`
              : 'AIチャットに渡す内容を確認し、確認のチェックを入れてください。',
        );
        return;
      }
      rememberSessionId(undefined);
      await run(
        isDemo
          ? 'サンプルの記録を読み込んでいます'
          : proposalsExpected
            ? '方向の違う構成案を3つ考えています（1分ほどかかります）'
            : '資料と指示から構成を考えています',
        async signal => {
          if (isSubscription && !pickerActive) await ensureSubscription(signal);
          const next = await api<Session>('/sessions', {
            method: 'POST',
            body: JSON.stringify({
              prompt: isDemo ? 'サンプルを体験する' : prompt,
              documentIds: isDemo ? [] : documents.map(doc => doc.id),
              mode: settings.mode,
              cloudConsent: needsConsent && cloudConsent,
              ...(pickerActive && aiChoice ? { targets: aiChoice.targets, sendScope: aiChoice.scope } : {}),
              ...(isChat && oneShot ? { oneShot: true } : {}),
              ...(isChat ? { sendScope: chatScope } : {}),
            }),
            signal,
          });
          updateSession(next);
          if (!next.chatHandoff) setPrompt('');
          void makePreviews(next);
        },
      );
      return;
    }
    if (!prompt.trim()) return;
    if (session.cloudConsentRequired && !cloudConsent) {
      setError(
        isSubscription
          ? `履歴の指示・資料を${aiName}へ送信することに同意してください。`
          : '履歴の指示・資料をAIチャットへ渡すことを確認し、確認のチェックを入れてください。',
      );
      return;
    }
    await run(
      selectedSlide
        ? '選んだスライドを修正しています'
        : !session.outline && proposalsExpected
          ? '方向の違う構成案を考えています（1分ほどかかります）'
          : '内容を確認しています',
      async signal => {
        if (isSubscription) await ensureSubscription(signal);
        if (session.cloudConsentRequired)
          updateSession(
            await api<Session>(`/sessions/${session.id}/cloud-consent`, {
              method: 'POST',
              body: JSON.stringify({ cloudConsent: true }),
              signal,
            }),
          );
        const path = selectedSlide ? `/sessions/${session.id}/revise` : `/sessions/${session.id}/messages`;
        const body = selectedSlide
          ? { slideId: selectedSlide.id, variantId: selectedSlide.variantId, instruction: prompt }
          : { text: prompt };
        await stopPreviews();
        const next = await api<Session>(path, { method: 'POST', body: JSON.stringify(body), signal });
        updateSession(next);
        if (!selectedSlide) void makePreviews(next);
        if (next.recovery?.task !== 'revise' && !next.chatHandoff) {
          setPrompt('');
          setSelectedSlide(undefined);
          if (selectedSlide)
            await nativePreview(
              next,
              next.variants.find(item => item.id === selectedSlide.variantId),
              signal,
            );
        }
      },
    );
  }

  const available = useMemo(() => availableTargets(settings, connections), [settings, connections]);
  const cloudTargets = (aiChoice?.targets ?? []).filter(t => t !== 'local');
  const needsConsent = pickerActive ? aiChoice?.scope !== 'design' && cloudTargets.length > 0 : isRemote;
  const pickerProblem =
    pickerActive && aiChoice?.scope === 'design'
      ? !aiChoice.targets.includes('local')
        ? '内容を書くローカルLLMを選んでください。'
        : !cloudTargets.length
          ? 'デザインを頼むClaudeかChatGPTを選んでください。'
          : ''
      : '';
  const connectedServices = useMemo(
    () => (connections?.services ?? []).filter(s => s.canGenerate).map(s => s.service),
    [connections],
  );
  useEffect(() => {
    if (__HOSTED__ || loading) return;
    const controller = new AbortController();
    api<SubscriptionStatus>('/subscriptions', { signal: controller.signal })
      .then(setConnections)
      .catch(() => setConnections({ services: [] }));
    return () => controller.abort();
  }, [loading, settings.provider, settings.subscriptionService, settingsOpen]);
  useEffect(() => {
    if (!pickerActive || !connections) return;
    setAiChoice(previous =>
      previous && previous.targets.every(t => available[t]) && previous.targets.length
        ? previous
        : defaultChoice(settings, available, activeProject?.privacy?.mode === 'masked'),
    );
  }, [pickerActive, connections, available]);
  function chooseAi(value: AiChoice) {
    setAiChoice(value);
    setCloudConsent(false);
    // The chosen AIs become the default for the next creation.
    const { apiKey: unusedKey, hasKey: unusedHasKey, ...safeSettings } = settings;
    void api<Settings>('/settings', {
      method: 'PUT',
      body: JSON.stringify({ ...safeSettings, targets: value.targets }),
    })
      .then(setSettings)
      .catch(() => {});
  }
  useEffect(() => {
    setChatScope(activeProject?.privacy?.mode === 'masked' ? 'masked' : 'full');
  }, [activeProject?.id, activeProject?.privacy?.mode]);
  /** Switches the way of making a deck. Automatic making needs a connected service or a local LLM; without one,
   * the settings open where they are set up. */
  async function chooseRoute(route: Route) {
    if (routeOf(settings.provider) === route) return;
    const service = available.claude ? 'claude' : available.chatgpt ? 'chatgpt' : undefined;
    const provider =
      route === 'chat'
        ? 'chat'
        : route === 'demo'
          ? 'demo'
          : !__HOSTED__ && service
            ? 'subscription'
            : available.local
              ? 'local'
              : undefined;
    if (!provider) {
      setNotice('自動で作るには、設定でClaude・ChatGPTの月額版に接続するか、ローカルLLMを登録してください。');
      setSettingsOpen(true);
      return;
    }
    const { apiKey: unusedKey, hasKey: unusedHasKey, ...safeSettings } = withProvider(settings, provider);
    const next = {
      ...safeSettings,
      ...(provider === 'subscription' && service ? { subscriptionService: service } : {}),
    };
    try {
      setSettings(await api<Settings>('/settings', { method: 'PUT', body: JSON.stringify(next) }));
      setCloudConsent(false);
      setNotice('');
    } catch (e) {
      setError(e instanceof Error ? e.message : '作り方を切り替えられませんでした。');
    }
  }
  async function ensureSubscription(signal: AbortSignal) {
    const connections = await api<SubscriptionStatus>('/subscriptions', { signal }),
      connection = connections.services.find(value => value.service === subscriptionService);
    if (!connection?.canGenerate) {
      setSettingsOpen(true);
      throw new Error(connection?.message || `${aiName}との接続を設定から確認してください。`);
    }
  }

  async function applyChatResponse(requestId: string, response: string) {
    if (!session) return;
    await run('AIの返答を検証して取り込んでいます', async signal => {
      const next = await api<Session>(`/sessions/${session.id}/chat-response`, {
        method: 'POST',
        body: JSON.stringify({ requestId, response }),
        signal,
      });
      updateSession(next);
      if (next.chatHandoff?.validationIssues?.length) return;
      if (!next.chatHandoff) {
        setPrompt('');
        setSelectedSlide(undefined);
        if (next.phase === 'ready')
          await nativePreview(next, next.variants.find(v => v.id === selectedVariant) ?? next.variants[0], signal);
      }
    });
  }
  function switchToFullInstruction() {
    if (!session) return;
    void run('完全版の指示を用意しています', async signal => {
      updateSession(await api<Session>(`/sessions/${session.id}/chat-full`, { method: 'POST', body: '{}', signal }));
      setNotice('完全版の指示に切り替えました。新しいチャットに貼り付けても使えます。');
    });
  }
  function cancelChat() {
    if (!session) return;
    void run('AIチャットとの連携を取り消しています', async signal => {
      updateSession(await api<Session>(`/sessions/${session.id}/chat-cancel`, { method: 'POST', body: '{}', signal }));
      setNotice('連携を取り消しました。完成済みのスライドは保持しています。');
    });
  }

  async function nativePreview(next: Session, variant: DeckVariant | undefined, signal: AbortSignal) {
    if (!status?.nativeAvailable || !variant) return;
    setBusy('PowerPoint で描画とサムネイルを作成しています');
    await api<RenderResult>(`/sessions/${next.id}/render`, {
      method: 'POST',
      body: JSON.stringify({ variantId: variant.id }),
      signal,
    });
    const saved = await api<Session>(`/sessions/${next.id}`, { signal });
    setSession(previous => (previous?.id === next.id ? saved : previous));
  }
  function generate() {
    if (!session || handoffPending || (session.recovery?.task === 'generate' && !session.recovery.retryAvailable))
      return;
    void run(
      session.recovery?.task === 'generate'
        ? '保持したページを再利用し、残りを作成しています'
        : 'スライドの内容と配置を作成しています',
      async signal => {
        const next = await api<Session>(`/sessions/${session.id}/generate`, {
          method: 'POST',
          body: JSON.stringify(session.outline?.openFacts?.length ? { facts } : {}),
          signal,
        });
        updateSession(next);
        setSelectedSlide(undefined);
        if (next.phase === 'ready' && !next.chatHandoff)
          await nativePreview(await polishDeck(next, signal), next.variants[0], signal);
      },
    );
  }
  /** The deck is already shown; the drawn pages are looked at and the remade ones swapped in. */
  async function polishDeck(next: Session, signal: AbortSignal) {
    if (next.polish?.state !== 'pending') return next;
    setBusy('描画したページを画像で見直して仕上げています（資料はこのまま確認できます）');
    const polished = await api<Session>(`/sessions/${next.id}/polish`, { method: 'POST', body: '{}', signal });
    updateSession(polished);
    return polished;
  }
  function polishNow() {
    if (!session || session.polish?.state !== 'pending') return;
    void run('描画したページを画像で見直して仕上げています（資料はこのまま確認できます）', async signal => {
      const polished = await polishDeck(session, signal);
      await nativePreview(polished, polished.variants[0], signal);
    });
  }
  /** The blanks left on the slides, filled across every draft at once (no AI). */
  function fillBlanks(values: Record<string, string>) {
    if (!session) return;
    void run('記入欄に入力した内容を反映しています', async signal => {
      const next = await api<Session>(`/sessions/${session.id}/blanks`, {
        method: 'POST',
        body: JSON.stringify({ values }),
        signal,
      });
      updateSession(next);
      await nativePreview(next, next.variants.find(v => v.id === currentVariant?.id) ?? next.variants[0], signal);
    });
  }
  function switchReviewVersion(slideId: string, version: 'before' | 'after') {
    if (!session) return;
    void run(version === 'before' ? '直す前のページに戻しています' : '直したページに戻しています', async signal => {
      const next = await api<Session>(`/sessions/${session.id}/review-version`, {
        method: 'POST',
        body: JSON.stringify({ slideId, version }),
        signal,
      });
      updateSession(next);
      await nativePreview(next, next.variants.find(v => v.id === next.polish?.variantId) ?? next.variants[0], signal);
    });
  }
  /** Finish a deck stopped at text fitting: smaller text where it does not fit, no AI call. */
  function finishSmaller() {
    if (!session) return;
    void run('文字を小さくして仕上げています（AIは使いません）', async signal => {
      const next = await api<Session>(`/sessions/${session.id}/finish-smaller`, { method: 'POST', body: '{}', signal });
      updateSession(next);
      if (next.phase === 'ready') {
        setPrompt('');
        setSelectedSlide(undefined);
        setNotice(
          '文字が収まらなかったページは、文字を小さくして仕上げました。PowerPointで読みやすさを確認してください。',
        );
        await nativePreview(next, next.variants.find(v => v.id === selectedVariant) ?? next.variants[0], signal);
      }
    });
  }
  function chooseProposal(index: number) {
    if (!session) return;
    void run('選んだ案を構成案にしています', async signal => {
      await stopPreviews();
      updateSession(
        await api<Session>(`/sessions/${session.id}/proposal`, {
          method: 'POST',
          body: JSON.stringify({ index }),
          signal,
        }),
      );
    });
  }
  /** One page looked at as a picture and made again with what the AI sees (the user's pick). */
  function refineSlide(variantId: string, slideId: string) {
    if (!session) return;
    void run('このページを画像で見直して作り直しています', async signal => {
      const next = await api<Session>(`/sessions/${session.id}/refine`, {
        method: 'POST',
        body: JSON.stringify({ variantId, slideId }),
        signal,
      });
      updateSession(next);
      await nativePreview(next, next.variants.find(v => v.id === variantId) ?? next.variants[0], signal);
    });
  }
  function retryPlan() {
    if (!session || session.recovery?.task !== 'plan' || !session.recovery.retryAvailable) return;
    void run('保存した指示から構成を考え直しています', async signal => {
      updateSession(await api<Session>(`/sessions/${session.id}/retry-plan`, { method: 'POST', body: '{}', signal }));
    });
  }
  function retryRevision() {
    if (!session || session.recovery?.task !== 'revise' || !session.recovery.retryAvailable) return;
    void run('保存した修正指示から再開しています', async signal => {
      const next = await api<Session>(`/sessions/${session.id}/retry-revision`, { method: 'POST', body: '{}', signal });
      updateSession(next);
      if (!next.recovery && !next.chatHandoff) {
        setPrompt('');
        setSelectedSlide(undefined);
        await nativePreview(next, next.variants.find(v => v.id === selectedVariant) ?? next.variants[0], signal);
      }
    });
  }
  function addVariant() {
    if (!session) return;
    void run('別の見た目を組み立てています', async signal => {
      const next = await api<Session>(`/sessions/${session.id}/variants`, { method: 'POST', body: '{}', signal });
      updateSession(next);
      await nativePreview(next, next.variants.at(-1), signal);
    });
  }
  function changeTheme(themeId: string, typographyId?: string) {
    if (!session || !currentVariant) return;
    const variantId = currentVariant.id;
    void run('見た目を変更しています', async signal => {
      const next = await api<Session>(`/sessions/${session.id}/theme`, {
        method: 'POST',
        body: JSON.stringify({ variantId, themeId, ...(typographyId !== undefined ? { typographyId } : {}) }),
        signal,
      });
      updateSession(next);
      await nativePreview(
        next,
        next.variants.find(v => v.id === variantId),
        signal,
      );
    });
  }
  function changeChart(type: ChartType) {
    if (!session || !chartVariant || !chartSlide) return;
    const variantId = chartVariant.id,
      slideId = chartSlide.id;
    setChartPicker(undefined);
    void run('グラフを変更しています', async signal => {
      const next = await api<Session>(`/sessions/${session.id}/chart`, {
        method: 'POST',
        body: JSON.stringify({ variantId, slideId, type }),
        signal,
      });
      updateSession(next);
      await nativePreview(
        next,
        next.variants.find(v => v.id === variantId),
        signal,
      );
    });
  }
  function changeLayout(layoutId: string) {
    if (!session || !layoutVariant || !layoutSlide) return;
    const variantId = layoutVariant.id,
      slideId = layoutSlide.id;
    setLayoutPicker(undefined);
    void run('構図を変更しています', async signal => {
      const next = await api<Session>(`/sessions/${session.id}/layout`, {
        method: 'POST',
        body: JSON.stringify({ variantId, slideId, layoutId }),
        signal,
      });
      updateSession(next);
      await nativePreview(
        next,
        next.variants.find(v => v.id === variantId),
        signal,
      );
    });
  }
  function render() {
    if (!session || !currentVariant) return;
    void run('PowerPoint ファイルを作成しています', async signal => {
      const result = await api<RenderResult>(`/sessions/${session.id}/render`, {
        method: 'POST',
        body: JSON.stringify({ variantId: currentVariant.id }),
        signal,
      });
      setSession(await api<Session>(`/sessions/${session.id}`, { signal }));
      setNotice(
        result.native
          ? 'PowerPoint の描画を反映しました。ファイルを保存できます。'
          : 'PowerPoint ファイルを作成しました。ダウンロードして確認できます。',
      );
    });
  }
  function insertIntoDeck() {
    if (!activeRender) return;
    const url = activeRender.pptxUrl;
    void run('開いている資料にスライドを挿入しています', async signal => {
      await insertIntoPresentation(url, {
        signal,
        useDestinationTheme: currentVariant?.deck.themeId === TEMPLATE_THEME_ID,
      });
      setNotice('開いている資料にスライドを挿入しました。元のスライドは変更していません。');
    });
  }
  function openPowerPoint() {
    if (!session || !currentVariant) return;
    void run('PowerPoint で開いています', async signal => {
      await api(`/sessions/${session.id}/open`, {
        method: 'POST',
        body: JSON.stringify({ variantId: currentVariant.id }),
        signal,
      });
      setNotice('PowerPoint で資料を開きました。');
    });
  }
  function alternate(service: ChatService, direct = false) {
    if (!session) return;
    void run(
      direct
        ? `${chatServices[service].name}で同じ構成の案を作っています（数分かかります）`
        : `${chatServices[service].name}への指示を用意しています`,
      async signal => {
        const next = await api<Session>(`/sessions/${session.id}/alternate`, {
          method: 'POST',
          body: JSON.stringify({ service, ...(direct ? { direct: true, cloudConsent: true } : {}) }),
          signal,
        });
        updateSession(next);
        if (direct) {
          const made = next.variants.at(-1);
          if (made) {
            setPairIds([next.variants[0].id, made.id]);
            await nativePreview(next, made, signal);
          }
        }
      },
    );
  }
  function combine(picks: CombinePick[], themeFrom: string) {
    if (!session) return;
    void run('案を組み合わせています', async signal => {
      const next = await api<Session>(`/sessions/${session.id}/combine`, {
        method: 'POST',
        body: JSON.stringify({ picks, themeFrom }),
        signal,
      });
      updateSession(next);
      const made = next.variants.find(v => v.origin?.kind === 'combined');
      if (made) {
        selectVariant(made.id);
        setPairIds([themeFrom, made.id]);
        await nativePreview(next, made, signal);
      }
    });
  }
  function requestDesign(input: {
    variantId: string;
    service: ChatService;
    level: 'structure' | 'topic';
    topic?: string;
    direct?: boolean;
  }) {
    if (!session) return;
    void run(
      input.direct
        ? `${chatServices[input.service].name}にデザインだけを頼んでいます（内容は送りません）`
        : '内容を伏せたデザインの依頼を用意しています',
      async signal => {
        const next = await api<Session>(`/sessions/${session.id}/design-request`, {
          method: 'POST',
          body: JSON.stringify(input),
          signal,
        });
        updateSession(next);
        if (input.direct) {
          const made = next.variants.at(-1);
          if (made) {
            setPairIds([input.variantId, made.id]);
            await nativePreview(next, made, signal);
          }
        }
      },
    );
  }
  function openRefreshed(restored: RestoredPresentation) {
    const previous = session;
    updateSession(restored.session);
    setSelectedVariant(restored.session.variants[0]?.id ?? '');
    setDocuments(restored.documents);
    setPrompt('');
    setSelectedSlide(undefined);
    setCompareIndex(undefined);
    setCloudConsent(false);
    setShowMarks(true);
    setNotice(
      `新しい資料の数値で更新した資料を開きました（${restored.session.refresh?.changes.length ?? 0}か所を変更）。前回の資料は履歴にそのまま残っています。AIは呼び出していません。`,
    );
    if (previous) void api(`/sessions/${previous.id}`, { method: 'DELETE' }).catch(() => {});
  }
  function removeVariant(variantId: string) {
    if (!session) return;
    void run('案を削除しています', async signal => {
      updateSession(
        await api<Session>(`/sessions/${session.id}/variants/${encodeURIComponent(variantId)}`, {
          method: 'DELETE',
          signal,
        }),
      );
    });
  }
  function selectVariant(variantId: string) {
    setSelectedVariant(variantId);
    setFeedbackSaved(false);
    setRating(0);
    setReasons([]);
    setSelectedSlide(undefined);
  }
  function revise(variant: DeckVariant, index: number) {
    selectVariant(variant.id);
    setSelectedSlide({ id: variant.deck.slides[index].id, index, variantId: variant.id });
    setPrompt('');
    setCompareIndex(undefined);
    setTimeout(() => {
      promptInput.current?.focus();
      promptInput.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 30);
  }
  function reset() {
    rememberSessionId(undefined);
    liveSession.current = undefined;
    if (session) void api(`/sessions/${session.id}`, { method: 'DELETE' }).catch(() => {});
    for (const document of documents) void api(`/documents/${document.id}`, { method: 'DELETE' }).catch(() => {});
    setSession(undefined);
    setDocuments([]);
    setSelectedVariant('');
    setSelectedSlide(undefined);
    setPrompt('');
    setError('');
    setNotice('');
    setCompareIndex(undefined);
    setCloudConsent(false);
    setRating(0);
    setReasons([]);
    setFeedbackSaved(false);
    setLoading(true);
    void api<Settings>('/settings')
      .then(setSettings)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }
  function openHistory(id: string, duplicate: boolean, revision?: number) {
    void run('保存した資料を開いています', async signal => {
      const path = revision === undefined ? `/history/${id}/open` : `/history/${id}/versions/${revision}/open`;
      const restored = await api<RestoredPresentation>(path, {
        method: 'POST',
        body: JSON.stringify({ duplicate }),
        signal,
      });
      if (session) await api(`/sessions/${session.id}`, { method: 'DELETE', signal }).catch(() => {});
      updateSession(restored.session);
      setDocuments(restored.documents);
      const deck = restored.session.variants[0].deck;
      setSettings(previous => ({
        ...previous,
        activeProjectId: restored.session.projectId ?? previous.activeProjectId,
        mode: restored.mode,
        slideCount: deck.slides.length,
        themeId: deck.themeId,
        typographyId: deck.typographyId ?? 'auto',
      }));
      setPrompt('');
      setSelectedSlide(undefined);
      setCompareIndex(undefined);
      setCloudConsent(false);
      setHistoryOpen(false);
      setNotice(
        revision !== undefined
          ? `保存版 ${revision} を編集用に複製しました。元の履歴は保持しています。`
          : duplicate
            ? '編集用に複製しました。AIは呼び出していません。'
            : '保存した資料を開きました。AIは呼び出していません。',
      );
    });
  }
  function saveHistory() {
    if (!session) return;
    void run('履歴を保存しています', async signal => {
      updateSession(await api<Session>(`/sessions/${session.id}/save`, { method: 'POST', signal }));
      setNotice('このPCの履歴に保存しました。');
    });
  }
  function feedback() {
    if (!session || !currentVariant || !rating) return;
    void run('評価を保存しています', async signal => {
      await api('/feedback', {
        method: 'POST',
        body: JSON.stringify({
          sessionId: session.id,
          variantId: currentVariant.id,
          rating,
          reason: reasons.join('、'),
        }),
        signal,
      });
      setFeedbackSaved(true);
    });
  }
  function saveDesign(name: string) {
    if (!session || !saveDesignTarget) return;
    const target = saveDesignTarget;
    void run('良かったデザインを保存しています', async signal => {
      await api<DesignEntry>(`/sessions/${session.id}/designs`, {
        method: 'POST',
        body: JSON.stringify({ variantId: target.variantId, slideId: target.slideId, name }),
        signal,
      });
      setSaveDesignTarget(undefined);
      setNotice('デザインを保存し、1票を記録しました。お気に入りから再利用できます。');
    });
  }
  function applyDesign(designId: string) {
    if (!session || !currentVariant) return;
    const variantId = currentVariant.id;
    void run('お気に入りのデザインを適用しています', async signal => {
      const next = await api<Session>(`/sessions/${session.id}/apply-design`, {
        method: 'POST',
        body: JSON.stringify({ variantId, designId }),
        signal,
      });
      updateSession(next);
      setDesignsOpen(false);
      await nativePreview(
        next,
        next.variants.find(v => v.id === variantId),
        signal,
      );
      setNotice('本文を保持してデザインを適用しました。AIは呼び出していません。');
    });
  }
  async function preferDesign(entry: DesignEntry | undefined) {
    const { apiKey: unusedKey, hasKey: unusedHasKey, ...safeSettings } = settings;
    setSettings(
      await api<Settings>('/settings', {
        method: 'PUT',
        body: JSON.stringify({
          ...safeSettings,
          preferredDesignId: entry?.id ?? '',
          ...(entry ? { themeId: entry.themeId, typographyId: entry.typographyId ?? 'auto' } : {}),
        }),
      }),
    );
  }
  async function selectProject(project: ProjectProfile) {
    const { apiKey: unusedKey, hasKey: unusedHasKey, ...safeSettings } = settings;
    setSettings(
      await api<Settings>('/settings', {
        method: 'PUT',
        body: JSON.stringify({
          ...safeSettings,
          activeProjectId: project.id,
          ...(safeSettings.activeProjectId === project.id ? {} : { preferredDesignId: '' }),
        }),
      }),
    );
  }
  async function useTemplate() {
    const { apiKey: unusedKey, hasKey: unusedHasKey, ...safeSettings } = settings;
    setSettings(
      await api<Settings>('/settings', {
        method: 'PUT',
        body: JSON.stringify({ ...safeSettings, themeId: TEMPLATE_THEME_ID, preferredDesignId: '' }),
      }),
    );
    setProjectsOpen(false);
    setNotice('次の作成から、会社テンプレートの配色と書体を使います。');
  }
  async function applyNotes(notes: { slideId: string; notes: string }[]) {
    if (!session) return;
    const next = await api<Session>(`/sessions/${session.id}/notes`, {
      method: 'POST',
      body: JSON.stringify({ notes }),
    });
    updateSession(next);
    setNotice('発表者ノートに反映しました。PowerPoint ファイルを作り直すと、ノートに入ります。');
  }
  function toggleReferences(enabled: boolean) {
    if (!session) return;
    void run('出典一覧の設定を変更しています', async signal => {
      updateSession(
        await api<Session>(`/sessions/${session.id}/references`, {
          method: 'POST',
          body: JSON.stringify({ enabled }),
          signal,
        }),
      );
      setNotice(enabled ? '書き出すファイルの末尾に「出典一覧」を付けます。' : '「出典一覧」を付けずに書き出します。');
    });
  }
  async function saveProject(project: ProjectProfile) {
    setProjects(previous =>
      [...previous.filter(item => item.id !== project.id), project].sort((a, b) =>
        a.createdAt.localeCompare(b.createdAt),
      ),
    );
    await selectProject(project);
  }

  const composer = (
    <>
      {!session && (
        <RoutePanel
          route={routeOf(settings.provider)}
          hosted={__HOSTED__}
          available={available}
          choice={pickerActive ? aiChoice : undefined}
          chatScope={chatScope}
          maskedTerms={activeProject?.privacy?.terms.length ?? 0}
          disabled={!!busy || loading}
          onRoute={route => void chooseRoute(route)}
          onChoice={chooseAi}
          onChatScope={scope => {
            if (scope !== 'design') setChatScope(scope);
            setCloudConsent(false);
          }}
          onSettings={() => setSettingsOpen(true)}
          onProject={() => setProjectsOpen(true)}
        />
      )}
      <div
        className={`editor ${dropActive ? 'drop-active' : ''}`}
        onDragOver={event => {
          event.preventDefault();
          if (!session && !busy) setDropActive(true);
        }}
        onDragLeave={event => {
          if (!event.currentTarget.contains(event.relatedTarget as Node)) setDropActive(false);
        }}
        onDrop={event => {
          event.preventDefault();
          setDropActive(false);
          addFiles(event.dataTransfer.files);
        }}
      >
        <div className="materials">
          <div className="section-label">
            <Icon name="file" size={14} />
            資料<span className="optional">任意</span>
          </div>
          {documents.length > 0 && (
            <div className="files">
              {documents.map(doc => (
                <div className="file-chip" key={doc.id} title={`${doc.name} · ${doc.characters.toLocaleString()}文字`}>
                  <Icon name="file" size={13} />
                  <span>{doc.name}</span>
                  {!session && (
                    <button
                      className="icon-button"
                      disabled={!!busy}
                      aria-label={`${doc.name}を外す`}
                      onClick={() =>
                        void run('資料を外しています', async signal => {
                          await api('/documents/' + doc.id, { method: 'DELETE', signal });
                          setDocuments(previous => previous.filter(item => item.id !== doc.id));
                          setCloudConsent(false);
                        })
                      }
                    >
                      <Icon name="close" size={13} />
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
          {!session && (
            <div className="upload-area">
              <button
                type="button"
                className="attachment-button"
                onClick={() => fileInput.current?.click()}
                disabled={!!busy || loading || isDemo}
              >
                <Icon name="plus" size={16} />
                資料を追加
              </button>
              <span className="upload-hint">
                PDF / CSV / XLSX / PPTX / TXT / MD{!isDemo && ' · ドロップもできます'}
              </span>
              <input
                ref={fileInput}
                type="file"
                className="sr-only"
                tabIndex={-1}
                multiple
                accept=".pdf,.csv,.xlsx,.pptx,.txt,.md"
                onChange={event => addFiles(event.target.files)}
              />
            </div>
          )}
          {session && documents.length === 0 && (
            <span className="upload-hint">{isDemo ? 'サンプル内のデータを使用' : '添付資料なし'}</span>
          )}
        </div>
        <div className="prompt-area">
          <label className="section-label" htmlFor="prompt">
            {selectedSlide ? `スライド ${String(selectedSlide.index + 1).padStart(2, '0')} の修正` : 'プロンプト'}
            {selectedSlide && (
              <button
                className="text-link"
                style={{ marginLeft: 'auto', fontSize: 10 }}
                onClick={() => setSelectedSlide(undefined)}
              >
                取り消す
              </button>
            )}
          </label>
          <textarea
            id="prompt"
            ref={promptInput}
            value={prompt}
            onChange={event => setPrompt(event.target.value)}
            disabled={!!busy || loading || handoffPending || (!session && isDemo)}
            onKeyDown={event => {
              if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                event.preventDefault();
                void submit();
              }
            }}
            placeholder={
              selectedSlide
                ? '変えたいところを教えてください。\n例：説明を短くして、比較グラフを大きく'
                : session?.recovery?.task === 'plan'
                  ? '優先する条件や、構成を短くする希望を入力できます。'
                  : phase === 'clarifying'
                    ? '質問への回答を入力してください。\nまだ決まっていないことは「おまかせ」で大丈夫です。'
                    : phase === 'outline'
                      ? '変えたい構成があれば、ここに入力してください。'
                      : phase === 'ready'
                        ? '資料全体の構成を見直す指示、または各スライドの鉛筆ボタンから修正できます。'
                        : isDemo
                          ? 'サンプル体験では、実際にAIで作った記録を再生して\n3案の比較・作成・見直しの流れを試せます。'
                          : '伝えたいことを、自由に。\n例：数学の面白さを、身近な例から紹介したい\n例：添付資料を比べて、違いが伝わるようにまとめて'
            }
          />
        </div>
        <p className={`prompt-count ${prompt.length > MAX_PROMPT_CHARACTERS ? 'over' : ''}`}>
          {prompt.length.toLocaleString()} / {MAX_PROMPT_CHARACTERS.toLocaleString()}文字 ·
          長文は構成確認で条件を整理します
        </p>
        <div className="editor-footer">
          <div className="editor-meta">
            <button className="mode-button" onClick={() => setSettingsOpen(true)}>
              {settings.mode === 'reading' ? '読む資料' : '発表用'}
            </button>
            <span className="meta-divider" />
            <button className="mode-button" onClick={() => setSettingsOpen(true)}>
              {typeof settings.slideCount === 'number'
                ? `表紙込み ${settings.slideCount} 枚`
                : `枚数おまかせ（最大${MAX_SLIDES}枚）`}
            </button>
            <button className="mode-button" onClick={() => setSettingsOpen(true)}>
              {themeName(settings.themeId) ?? 'テーマおまかせ'}
            </button>
          </div>
          <button
            type="button"
            className="button primary"
            onClick={() => void submit()}
            disabled={!!busy || loading || handoffPending || (!prompt.trim() && (!isDemo || !!session))}
          >
            {busy ? <Spinner /> : <Icon name={selectedSlide ? 'edit' : 'arrow'} size={16} />}
            <span>
              {handoffPending
                ? 'AIの返答を待っています'
                : selectedSlide
                  ? '修正する'
                  : !session
                    ? isDemo
                      ? 'サンプルを見る'
                      : '構成を考える'
                    : '送信'}
            </span>
          </button>
        </div>
      </div>
      {!session && isChat && (
        <div className="consent one-shot">
          <input
            id="one-shot"
            type="checkbox"
            checked={oneShot}
            onChange={event => setOneShot(event.target.checked)}
            disabled={!!busy}
          />
          <label htmlFor="one-shot">
            構成の確認を省いて一度に作る（おまかせ）
            <small>1回の貼り付けで構成と全スライドを作ります。構成を確かめながら作る方が品質は安定します。</small>
          </label>
        </div>
      )}
      {((!session && needsConsent) || session?.cloudConsentRequired) && (
        <div className="consent">
          <input
            id="cloud-consent"
            type="checkbox"
            checked={cloudConsent}
            onChange={event => setCloudConsent(event.target.checked)}
            disabled={!!busy}
          />
          <label htmlFor="cloud-consent">
            {pickerActive
              ? `指示・資料の抽出内容・追加の会話を、${cloudTargets.map(t => targetNames[t]).join('・')}のクラウドへ送信することに同意します。${aiChoice?.scope === 'masked' ? '社名・数値などは伏せ字にして送ります。' : ''}`
              : isSubscription
                ? `指示・資料の抽出内容・追加の会話を、${aiName}のクラウドへ送信することに同意します。`
                : '指示・資料の抽出内容・追加の会話が、AIチャットへ渡す指示に含まれることを確認しました。'}{' '}
            <button type="button" onClick={() => setTransmissionOpen(true)}>
              {isSubscription ? '送信する内容' : '含まれる内容'}
            </button>
          </label>
        </div>
      )}
    </>
  );

  const sessionRoute =
    session &&
    routeSummary(routeOf(session.provider ?? settings.provider), {
      cloud: (
        session.targets ?? (session.provider === 'subscription' ? [session.subscriptionService ?? 'chatgpt'] : [])
      )
        .filter(t => t !== 'local')
        .map(t => targetNames[t]),
      scope: session.sendScope ?? (activeProject?.privacy?.mode === 'masked' ? 'masked' : 'full'),
      local: session.provider === 'local' || !!session.targets?.includes('local'),
      hosted: __HOSTED__,
    });
  const conversation = session && session.messages.length > 0 && (
    <div className="conversation">
      {session.messages.map((message, index) => (
        <div className={`message ${message.role}`} key={`${index}-${message.role}`}>
          <div className="message-role">{message.role === 'assistant' ? 'DESIGNER' : 'あなた'}</div>
          <div className="message-body">{message.text}</div>
        </div>
      ))}
    </div>
  );
  const renderSlide = (variant: DeckVariant, index: number) => {
    const scene = scenes.get(variant.id);
    const marks =
      scene && showMarks && session?.refresh && variant.origin?.kind === 'refresh'
        ? refreshMarks(scene, variant.deck, session.refresh, index)
        : undefined;
    return scene ? (
      <SlidePreview
        document={scene}
        index={index}
        marks={marks}
        nativeUrl={variant.render?.native ? variant.render.thumbnails[index] : undefined}
      />
    ) : (
      <div className="slide-fallback">
        <h3>{variant.deck.slides[index]?.title}</h3>
      </div>
    );
  };
  const selectedDeckTitle = currentVariant?.deck.title ?? session?.outline?.title;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-symbol">
            <Icon name="slides" size={20} />
          </span>
          <div>
            <div className="brand-name">Designer Extention</div>
            <div className="brand-caption">FOR POWERPOINT</div>
          </div>
        </div>
        <div className="topbar-right">
          <button
            className="project-badge"
            disabled={!!busy || loading}
            onClick={() => setProjectsOpen(true)}
            aria-label={`プロジェクト：${activeProject?.name ?? '選択中'}。プロジェクト管理を開く`}
          >
            {activeProject?.name ?? 'プロジェクト'}
          </button>
          <button
            className="button ghost small"
            disabled={!!busy || loading || updateRequired}
            onClick={() => setHistoryOpen(true)}
          >
            履歴
          </button>
          <button
            className="button ghost small"
            disabled={!!busy || loading || updateRequired}
            onClick={() => setDesignsOpen(true)}
          >
            <Icon name="star" size={13} />
            お気に入り
          </button>
          <button className="button ghost small" onClick={() => setLayoutPicker('catalog')}>
            構図一覧
          </button>
          <button
            className="provider-badge"
            onClick={() => setSettingsOpen(true)}
            aria-label={`処理先：${providerLabel[activeProvider]}。設定を開く`}
          >
            <span className="provider-dot" />
            {isSubscription ? `${aiName} · 月額版` : isChat ? aiName : providerLabel[activeProvider]}
          </button>
          <button className="icon-button" aria-label="設定" onClick={() => setSettingsOpen(true)}>
            <Icon name="settings" size={20} />
          </button>
        </div>
      </header>
      <main className={`workspace ${!session ? 'empty' : ''}`}>
        {updateRequired && (
          <p className="update-notice" role="status">
            {updateMessage}
          </p>
        )}
        {__HOSTED__ && !officeHost && !session && (
          <p className="hosted-banner">
            インストール不要のブラウザ版です。このままブラウザで作成してPPTXを保存できます。
            <button className="text-link" onClick={() => setGuideOpen(true)}>
              PowerPointに追加する方法
            </button>
          </p>
        )}
        {!session ? (
          <div className="intro">
            <div className="eyebrow">FROM THOUGHT TO SLIDE</div>
            <h1>
              伝えたいことを、
              <br />
              伝わるスライドに。
            </h1>
            <p>
              資料からも、ひとつのアイデアからも。
              <br />
              対話で構成を整え、見やすいプレゼンテーションへ。
            </p>
          </div>
        ) : (
          <>
            <div className="active-header">
              <div>
                <div className="eyebrow">YOUR PRESENTATION</div>
                <h1>{selectedDeckTitle ?? '伝える順序を、一緒に整える。'}</h1>
                <p>
                  {phase === 'ready'
                    ? 'スライドを選んで拡大。気になる部分は、指示して修正できます。'
                    : session.recovery
                      ? '指示と資料を保持しています。下の案内から再開できます。'
                      : phase === 'outline'
                        ? '構成を確認してください。変更したいところは、プロンプトから伝えられます。'
                        : 'より伝わる資料にするために、少しだけ確認させてください。'}
                </p>
              </div>
              <button type="button" className="button ghost small" onClick={reset} disabled={!!busy}>
                <Icon name="plus" size={14} />
                新しく作成
              </button>
            </div>
            <div className="stage-line" aria-label="作成の進捗">
              <span className={phase === 'clarifying' ? 'current' : 'done'}>01 内容を整理</span>
              <i />
              <span
                className={
                  phase === 'outline' && session.recovery?.task !== 'generate'
                    ? 'current'
                    : phase === 'ready' || session.recovery?.task === 'generate'
                      ? 'done'
                      : ''
                }
              >
                02 構成を確認
              </span>
              <i />
              <span className={phase === 'ready' || session.recovery?.task === 'generate' ? 'current' : ''}>
                03 スライドを作成
              </span>
            </div>
          </>
        )}
        {error && (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            <button className="icon-button" aria-label="エラーを閉じる" onClick={() => setError('')}>
              <Icon name="close" size={15} />
            </button>
          </div>
        )}
        {notice && (
          <p className="success-note" role="status" style={{ marginBottom: 18 }}>
            <Icon name="info" size={15} />
            {notice}
          </p>
        )}
        {officeHost && (
          <details className="pane-tools" open={!session}>
            <summary>開いている資料で使う</summary>
            <SlideActionsPanel busy={!!busy} run={run} provider={settings.provider} onNotice={setNotice} />
            <RehearsalPanel
              title="この資料の発表準備"
              loadSlides={() => readAllSlides()}
              busy={!!busy}
              run={run}
              provider={settings.provider}
              mode={settings.mode}
              onNotice={setNotice}
            />
          </details>
        )}
        {!session ? (
          composer
        ) : (
          <div className={`session-grid ${phase === 'ready' ? 'ready' : ''}`}>
            <section className="sidebar" aria-label="入力と対話">
              {session.chatHandoff && (
                <ChatHandoffPanel
                  handoff={session.chatHandoff}
                  busy={!!busy}
                  onApply={applyChatResponse}
                  onCancel={cancelChat}
                  openIn={settings.chatOpenIn}
                  onUseFull={session.chatHandoff.instructionMode === 'project' ? switchToFullInstruction : undefined}
                  onFinishSmaller={session.chatHandoff.task === 'summarize' ? finishSmaller : undefined}
                  onSetup={() => {
                    setSetupFromHandoff(true);
                    setSettingsOpen(true);
                  }}
                  projectReady={!!settings.chatProjects?.[session.chatHandoff.service]}
                />
              )}
              {session.recovery && (
                <section ref={recoveryPanel} className="plan-recovery" role="status">
                  <h2>
                    {session.recovery.task === 'plan'
                      ? '構成案の作成が途中で止まりました'
                      : session.recovery.task === 'revise'
                        ? 'スライドの修正を完了できませんでした'
                        : session.recovery.stage === 'text-fit'
                          ? '文字量の調整で止まりました'
                          : 'スライド作成が途中で止まりました'}
                  </h2>
                  {session.recovery.task === 'generate' && (
                    <p className="recovery-progress">
                      本文を保持：{session.recovery.completedSlides} / {session.recovery.totalSlides} 枚
                    </p>
                  )}
                  <p>{session.recovery.message}</p>
                  <small>
                    {session.recovery.retryAvailable
                      ? '再試行すると接続したAIを呼び出します。自動対処は1回の操作で最大2回です。'
                      : '再試行を停止しています。優先する条件を整理して、指示を送り直してください。'}
                  </small>
                  {session.recovery.stage === 'text-fit' && (
                    <button
                      className="button primary small"
                      disabled={!!busy || updateRequired}
                      onClick={finishSmaller}
                    >
                      文字を小さくして仕上げる（AIは使いません）
                    </button>
                  )}
                  {session.recovery.retryAvailable && (
                    <button
                      className="button secondary small"
                      disabled={!!busy || updateRequired}
                      onClick={
                        session.recovery.task === 'plan'
                          ? retryPlan
                          : session.recovery.task === 'revise'
                            ? retryRevision
                            : generate
                      }
                    >
                      {session.recovery.task === 'plan'
                        ? '保存した指示で構成を再試行'
                        : session.recovery.task === 'revise'
                          ? '保存した修正指示で再試行'
                          : session.recovery.completedSlides === session.recovery.totalSlides
                            ? '保持した本文を仕上げる'
                            : '残りのスライドから再開'}
                    </button>
                  )}
                </section>
              )}

              {session.repairReport && (
                <section
                  ref={repairPanel}
                  className={`repair-report ${session.repairReport.status}`}
                  role="status"
                  aria-label="自動対処の結果"
                >
                  <h2>
                    {session.repairReport.status === 'recovered'
                      ? '自動で対処し、処理を完了しました'
                      : '自動対処では完了できず、停止しました'}
                  </h2>
                  <ol>
                    {session.repairReport.steps.map((step, index) => (
                      <li key={index}>
                        <strong>{step.reason}</strong>
                        <p>{step.adjustment}</p>
                      </li>
                    ))}
                  </ol>
                  {session.repairReport.changes && (
                    <p className="repair-usage">
                      反映した変更：
                      {session.repairReport.changes.length ? session.repairReport.changes.join('・') : '内容の変更なし'}
                    </p>
                  )}
                  <p className="repair-usage">
                    自動再試行：{session.repairReport.retries} 回 · この操作のAI呼び出し：
                    {session.repairReport.apiCalls} 回
                  </p>
                  <small>対処内容は上記の通りです。有料APIは使用していません。</small>
                </section>
              )}

              {phase === 'ready' ? (
                <details className="conversation">
                  <summary>ここまでの対話を見る</summary>
                  {conversation}
                </details>
              ) : (
                conversation
              )}
              {session.proposals && (phase === 'clarifying' || phase === 'outline') && (
                <ProposalPicker
                  set={session.proposals}
                  busy={!!busy || handoffPending}
                  folded={phase === 'outline'}
                  previewing={previewing}
                  samples={isSubscription && settings.proposalPreviews !== false}
                  onChoose={chooseProposal}
                />
              )}
              {phase === 'outline' && session.outline && (
                <section className="outline" aria-label="構成案">
                  <div className="outline-heading">
                    <h2>スライドの構成案</h2>
                    <span>{session.outline.slides.length} 枚</span>
                  </div>
                  {session.outline.assumptions.length > 0 && (
                    <p className="outline-description">{session.outline.assumptions.join(' / ')}</p>
                  )}
                  {!!session.outline.openFacts?.length && (
                    <OpenFactsForm
                      facts={session.outline.openFacts}
                      values={facts}
                      disabled={!!busy || handoffPending}
                      onChange={setFacts}
                    />
                  )}
                  {session.outline.inputBrief && (
                    <details className="input-brief" open>
                      <summary>確認する条件</summary>
                      <p>{session.outline.inputBrief}</p>
                      <small>
                        原文は会話に保持します。この条件と構成を確認してから作成してください。作成時は整理した条件を使って送信量を減らします。
                      </small>
                    </details>
                  )}
                  {session.outline.slides.map((slide, index) => (
                    <div className="outline-row" key={slide.id}>
                      <span className="outline-number">{String(index + 1).padStart(2, '0')}</span>
                      <div>
                        <h3>{slide.title}</h3>
                        <p>{slide.intent}</p>
                        {slide.keyPoints.length > 0 && <p>{slide.keyPoints.join(' · ')}</p>}
                      </div>
                    </div>
                  ))}
                  {session.recovery?.task !== 'generate' && (
                    <div className="outline-actions">
                      <button className="button primary" disabled={!!busy || handoffPending} onClick={generate}>
                        <Icon name="slides" size={16} />
                        この構成で作成
                      </button>
                    </div>
                  )}
                </section>
              )}
              {composer}
              {phase === 'ready' && (
                <div className="history-save">
                  <button className="button secondary small" disabled={!!busy} onClick={saveHistory}>
                    履歴に保存
                  </button>
                  <span role={session.historySaveError ? 'alert' : 'status'}>
                    {session.historySaveError ??
                      (session.savedAt
                        ? `このPCに自動保存 · ${new Date(session.savedAt).toLocaleTimeString('ja-JP')}`
                        : '履歴の保存状況を確認してください')}
                  </span>
                </div>
              )}
              {sessionRoute && (
                <p className="route-summary compact" aria-label="この資料の送り先">
                  <span>
                    <strong>送り先</strong>
                    {sessionRoute.to}
                  </span>
                  <span>
                    <strong>渡すもの</strong>
                    {sessionRoute.what}
                  </span>
                </p>
              )}
              {isChat ? (
                <p className="workspace-note">
                  有料APIの呼び出し：0回 · ご利用のAIチャットの契約・上限が適用されます。
                </p>
              ) : (
                session.usage &&
                (phase === 'ready' || session.usage.calls > 0) && (
                  <p className="workspace-note">
                    {activeProvider === 'local'
                      ? 'ローカルLLMの呼び出し'
                      : isSubscription
                        ? `${aiName}の月額版での処理`
                        : '今回のAI呼び出し'}
                    ：{session.usage.calls} 回
                    {session.usage.inputTokens + session.usage.outputTokens > 0 &&
                      ` · ${(session.usage.inputTokens + session.usage.outputTokens).toLocaleString()} トークン`}{' '}
                    · {isSubscription ? 'ご契約の利用枠を消費します。' : '有料APIは使用していません。'}
                  </p>
                )
              )}
            </section>
            {phase === 'ready' && variants.length > 0 && (
              <section className="previews" aria-label="作成したスライド">
                <div className="preview-header">
                  <div>
                    <h2>スライド</h2>
                    <p>
                      {currentVariant?.deck.slides.length} 枚 ·{' '}
                      {activeRender?.native ? 'PowerPoint の描画' : 'レイアウトのプレビュー'}
                      {variants.length > 1 ? ' · 同じページで比較' : ''}
                    </p>
                  </div>
                  <div className="preview-actions">
                    {variants.length < 3 && (
                      <button
                        className="button secondary small"
                        onClick={addVariant}
                        disabled={!!busy || handoffPending}
                      >
                        <Icon name="compare" size={14} />
                        別の見た目を作る
                      </button>
                    )}
                    <button className="button ghost small" onClick={() => setCompareIndex(0)}>
                      <Icon name="expand" size={14} />
                      {variants.length > 1 ? '大きく比較' : '拡大'}
                    </button>
                  </div>
                </div>
                {session.refresh && (
                  <RefreshResult summary={session.refresh} marks={showMarks} onMarks={setShowMarks} />
                )}
                {session.polish?.state === 'pending' && !busy && (
                  <div className="review-pending" role="status">
                    <span>描画したページの画像での見直しが、まだ終わっていません。</span>
                    <button className="button secondary small" disabled={handoffPending} onClick={polishNow}>
                      画像で見直して仕上げる
                    </button>
                  </div>
                )}
                {(session.reviewHints?.length || session.reviewReport) && (
                  <ReviewHints
                    hints={session.reviewHints ?? []}
                    report={session.reviewReport}
                    versions={session.polish?.versions}
                    busy={!!busy || handoffPending}
                    onSwitch={switchReviewVersion}
                    pageOf={id => Math.max(0, variants[0]?.deck.slides.findIndex(slide => slide.id === id) ?? 0)}
                  />
                )}
                {currentVariant && (
                  <BlankFields
                    deck={currentVariant.deck}
                    facts={session.outline?.openFacts}
                    busy={!!busy || handoffPending}
                    onFill={fillBlanks}
                  />
                )}
                {variants.length > 1 && (
                  <div className="variant-headings">
                    {pair.map((variant, index) => (
                      <div className="variant-label" key={variant.id}>
                        <span>
                          {variants.length > 2 ? (
                            <select
                              className="variant-pick"
                              aria-label={`${index + 1}列目に表示する案`}
                              value={variant.id}
                              disabled={!!busy}
                              onChange={event =>
                                setPairIds(
                                  index ? [pair[0].id, event.target.value] : [event.target.value, pair[1]?.id ?? ''],
                                )
                              }
                            >
                              {variants.map(v => (
                                <option key={v.id} value={v.id}>
                                  {letterOf(v)} 案 · {v.label}
                                </option>
                              ))}
                            </select>
                          ) : (
                            <>
                              {letterOf(variant)} 案<span className="variant-title">{variant.label}</span>
                            </>
                          )}
                        </span>
                        <button
                          className={`button small ${currentVariant?.id === variant.id ? 'secondary active' : 'secondary'}`}
                          aria-pressed={currentVariant?.id === variant.id}
                          disabled={!!busy}
                          onClick={() => selectVariant(variant.id)}
                        >
                          {currentVariant?.id === variant.id ? (
                            <>
                              <Icon name="check" size={12} />
                              選択中
                            </>
                          ) : (
                            'この案を選ぶ'
                          )}
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <div className="output-style">
                  <label className="output-theme">
                    選択中の案のテーマ
                    <select
                      aria-label="作成した資料のテーマ"
                      value={currentVariant?.deck.themeId}
                      disabled={!!busy || handoffPending}
                      onChange={event => changeTheme(event.target.value)}
                    >
                      {(projectTemplate || currentVariant?.deck.themeId === TEMPLATE_THEME_ID) && (
                        <option value={TEMPLATE_THEME_ID}>会社テンプレート</option>
                      )}
                      {currentVariant?.deck.aiTheme && <option value={AI_THEME_ID}>AIが決めた配色</option>}
                      {Object.entries(themes).map(([id, theme]) => (
                        <option key={id} value={id}>
                          {theme.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="output-theme">
                    書体
                    <select
                      aria-label="作成した資料の書体"
                      value={currentVariant?.deck.typographyId ?? 'auto'}
                      disabled={!!busy || handoffPending}
                      onChange={event => changeTheme(currentVariant!.deck.themeId, event.target.value)}
                    >
                      <option value="auto">テーマに合わせる</option>
                      {Object.entries(typographyProfiles).map(([id, p]) => (
                        <option key={id} value={id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    className="button secondary small"
                    disabled={!!busy || handoffPending}
                    onClick={() =>
                      currentVariant &&
                      setSaveDesignTarget({
                        variantId: currentVariant.id,
                        name: `${themeName(currentVariant.deck.themeId) ?? 'お気に入り'}のデザイン`,
                      })
                    }
                  >
                    <Icon name="star" size={13} />
                    デザインを保存
                  </button>
                  <small>見た目の変更・デザインの保存にAIを呼び出しません。</small>
                  {currentVariant?.deck.typographyId && (
                    <p className="font-description">
                      {
                        typographyProfiles[currentVariant.deck.typographyId as keyof typeof typographyProfiles]
                          ?.description
                      }
                    </p>
                  )}
                </div>
                <div className="slide-grid">
                  {currentVariant?.deck.slides.map((_, index) => (
                    <div className={`slide-row ${variants.length > 1 ? 'paired' : ''}`} key={index}>
                      {pair.map(
                        variant =>
                          variant.deck.slides[index] && (
                            <div className="slide-card" key={variant.id}>
                              <button
                                type="button"
                                className={`slide-preview ${variants.length > 1 && variant.id === currentVariant.id ? 'selected' : ''}`}
                                aria-label={`${variant.label}、スライド ${index + 1}：${variant.deck.slides[index].title}を拡大`}
                                onClick={() => setCompareIndex(index)}
                              >
                                {renderSlide(variant, index)}
                                <span className="expand-overlay">
                                  <Icon name="expand" size={15} />
                                </span>
                              </button>
                              <div className="slide-caption">
                                <span>
                                  <strong>{String(index + 1).padStart(2, '0')}</strong>
                                  <span className="slide-title">{variant.deck.slides[index].title}</span>
                                </span>
                                <button
                                  type="button"
                                  className="button ghost small"
                                  disabled={!!busy || handoffPending}
                                  aria-label={`${variant.label}のスライド ${index + 1}の構図を変更`}
                                  onClick={() => setLayoutPicker({ variantId: variant.id, index })}
                                >
                                  構図
                                </button>
                                {canRefine && (
                                  <button
                                    type="button"
                                    className="button ghost small"
                                    disabled={!!busy || handoffPending}
                                    title="このページを画像でAIに見直させ、気づいた点を直して作り直します（直す前に戻せます）"
                                    aria-label={`${variant.label}のスライド ${index + 1}を画像で見直して作り直す`}
                                    onClick={() => refineSlide(variant.id, variant.deck.slides[index].id)}
                                  >
                                    見直す
                                  </button>
                                )}
                                {variant.deck.slides[index].chart && (
                                  <button
                                    type="button"
                                    className="button ghost small"
                                    disabled={!!busy || handoffPending}
                                    aria-label={`${variant.label}のスライド ${index + 1}のグラフを変更`}
                                    onClick={() => setChartPicker({ variantId: variant.id, index })}
                                  >
                                    グラフ
                                  </button>
                                )}
                                {variant.deck.slides[index].sources.length > 0 && (
                                  <button
                                    type="button"
                                    className="button ghost small source-button"
                                    aria-label={`${variant.label}のスライド ${index + 1}の出典と根拠を確認`}
                                    onClick={() =>
                                      setSourcesOpen({ variantId: variant.id, slideId: variant.deck.slides[index].id })
                                    }
                                  >
                                    出典 {variant.deck.slides[index].sources.length}
                                  </button>
                                )}
                                <button
                                  type="button"
                                  className="icon-button"
                                  disabled={!!busy || handoffPending}
                                  aria-label={`${variant.label}のスライド ${index + 1}のデザインを保存`}
                                  onClick={() =>
                                    setSaveDesignTarget({
                                      variantId: variant.id,
                                      slideId: variant.deck.slides[index].id,
                                      name: `スライド${index + 1}のデザイン`,
                                    })
                                  }
                                >
                                  <Icon name="star" size={13} />
                                </button>
                                <button
                                  type="button"
                                  className="icon-button"
                                  disabled={!!busy || handoffPending}
                                  aria-label={`${variant.label}のスライド ${index + 1}を修正`}
                                  onClick={() => revise(variant, index)}
                                >
                                  <Icon name="edit" size={13} />
                                </button>
                              </div>
                            </div>
                          ),
                      )}
                    </div>
                  ))}
                </div>
                <div className="export-bar">
                  <p>
                    {activeRender?.native
                      ? 'PowerPoint で図形やテキストを編集できます。'
                      : '表示は概略です。ファイル作成後、PowerPoint で実際の表示を確認できます。'}
                    {blanksLeft > 0 && <strong className="blank-left"> 記入欄が{blanksLeft}項目残っています。</strong>}
                  </p>
                  <div className="preview-actions">
                    {!activeRender ? (
                      <button className="button primary" disabled={!!busy} onClick={render}>
                        <Icon name="slides" size={16} />
                        PowerPoint ファイルを作成
                      </button>
                    ) : (
                      <>
                        <a className="button secondary" href={activeRender.pptxUrl} download>
                          <Icon name="download" size={15} />
                          保存
                        </a>
                        {status?.nativeAvailable && (
                          <button
                            className={`button ${officeInsert ? 'secondary' : 'primary'}`}
                            disabled={!!busy}
                            onClick={openPowerPoint}
                          >
                            <Icon name="slides" size={16} />
                            {officeInsert ? '別ファイルで開く' : 'PowerPoint で開く'}
                          </button>
                        )}
                        {officeInsert && (
                          <button className="button primary" disabled={!!busy} onClick={insertIntoDeck}>
                            <Icon name="plus" size={16} />
                            この資料に挿入
                          </button>
                        )}
                      </>
                    )}
                  </div>
                </div>
                {hasSources && currentVariant && (
                  <div className="source-export">
                    <label>
                      <input
                        type="checkbox"
                        checked={!!currentVariant.deck.referencesSlide}
                        disabled={!!busy || handoffPending}
                        onChange={event => toggleReferences(event.target.checked)}
                      />
                      書き出すファイルの末尾に「出典一覧」を付ける
                    </label>
                    <button
                      className="button ghost small"
                      onClick={() => setSourcesOpen({ variantId: currentVariant.id })}
                    >
                      出典と根拠を確認
                    </button>
                  </div>
                )}
                {currentVariant && !handoffPending && (
                  <RefreshPanel
                    key={session.id}
                    sessionId={session.id}
                    variant={currentVariant}
                    hasSources={documents.length > 0}
                    busy={!!busy}
                    run={run}
                    onOpened={openRefreshed}
                  />
                )}
                <CombinePanel
                  variants={variants}
                  busy={!!busy || handoffPending}
                  canAlternate={isChat && !!session.outline}
                  connected={connectedServices}
                  automatic={!isChat && !!session.outline}
                  currentId={currentVariant?.id}
                  onAlternate={alternate}
                  onCombine={combine}
                  onRemove={removeVariant}
                  onDesign={requestDesign}
                />
                {currentVariant && (
                  <RehearsalPanel
                    title="発表準備"
                    loadSlides={async () => deckRehearsalSlides(currentVariant.deck)}
                    busy={!!busy || handoffPending}
                    run={run}
                    provider={activeProvider}
                    mode={currentVariant.deck.mode}
                    onApply={applyNotes}
                    onNotice={setNotice}
                  />
                )}
                <section className="feedback" aria-label="評価">
                  <h3>{variants.length > 1 ? `${currentVariant?.label}を評価` : 'この資料は、どうでしたか？'}</h3>
                  {feedbackSaved ? (
                    <p className="success-note">
                      <Icon name="check" size={15} />
                      評価をこの PC に保存しました。ありがとうございます。
                    </p>
                  ) : (
                    <>
                      <div className="feedback-row" role="group" aria-label="5段階で評価">
                        {[1, 2, 3, 4, 5].map(value => (
                          <button
                            className={`rating-button ${rating >= value ? 'chosen' : ''}`}
                            key={value}
                            onClick={() => setRating(value)}
                            aria-label={`${value}点：${ratingLabels[value - 1]}`}
                            aria-pressed={rating === value}
                          >
                            <Icon name="star" size={22} />
                          </button>
                        ))}
                        <span className="rating-name">
                          {rating ? ratingLabels[rating - 1] : '良かった点や、改善したい点を教えてください'}
                        </span>
                      </div>
                      {rating > 0 && (
                        <>
                          <div className="feedback-reasons">
                            {feedbackReasons.map(reason => (
                              <button
                                key={reason}
                                type="button"
                                className={reasons.includes(reason) ? 'active' : ''}
                                aria-pressed={reasons.includes(reason)}
                                onClick={() =>
                                  setReasons(previous =>
                                    previous.includes(reason)
                                      ? previous.filter(item => item !== reason)
                                      : [...previous, reason],
                                  )
                                }
                              >
                                {reason}
                              </button>
                            ))}
                          </div>
                          <div className="feedback-submit">
                            <button className="button secondary small" onClick={feedback} disabled={!!busy}>
                              評価を保存
                            </button>
                          </div>
                        </>
                      )}
                    </>
                  )}
                </section>
              </section>
            )}
          </div>
        )}
        {busy && (
          <div className="busy-status" role="status" aria-live="polite">
            <Spinner />
            <span>{busy}</span>
            <button className="button ghost small" onClick={() => request.current?.abort()}>
              <Icon name="stop" size={12} />
              待機を中止
            </button>
          </div>
        )}
        {loading && (
          <div className="busy-status" role="status">
            <Spinner />
            アプリに接続しています
          </div>
        )}
        {warnings.length > 0 && (
          <details className="warnings">
            <summary>確認しておきたいこと（{warnings.length}）</summary>
            {warnings.map((warning, index) => (
              <p key={index}>{warning}</p>
            ))}
          </details>
        )}
      </main>
      <footer className="app-footer">
        <span>
          DESIGNER EXTENTION <span style={{ opacity: 0.65 }}> / PREVIEW {status?.version ?? ''}</span>
        </span>
        {__HOSTED__ && !officeHost ? (
          <button className="text-link footer-link" onClick={() => setGuideOpen(true)}>
            PowerPointのアドインとして使う
          </button>
        ) : (
          <span>ひとつのアイデアから。</span>
        )}
      </footer>
      {guideOpen && <AddinGuide onClose={() => setGuideOpen(false)} />}
      {historyOpen && activeProject && (
        <HistoryDialog
          busy={!!busy}
          projectId={activeProjectId}
          projectName={activeProject.name}
          onOpen={openHistory}
          onDeleted={id => {
            if (session?.historyId === id)
              setSession(previous => (previous ? { ...previous, historyId: undefined, savedAt: undefined } : previous));
          }}
          onClose={() => setHistoryOpen(false)}
        />
      )}
      {designsOpen && activeProject && (
        <DesignDialog
          busy={!!busy}
          canApply={phase === 'ready' && !!currentVariant && !handoffPending}
          preferredId={settings.preferredDesignId}
          projectId={activeProjectId}
          projectName={activeProject.name}
          onApply={applyDesign}
          onPrefer={preferDesign}
          onDeleted={id => {
            if (settings.preferredDesignId === id)
              setSettings(previous => ({ ...previous, preferredDesignId: undefined }));
          }}
          onClose={() => setDesignsOpen(false)}
        />
      )}
      {projectsOpen && (
        <ProjectDialog
          projects={projects}
          activeProjectId={session?.projectId ?? settings.activeProjectId ?? defaultSettings.activeProjectId!}
          busy={!!busy}
          activeSession={!!session}
          onSelect={selectProject}
          onSaved={saveProject}
          onTemplateSaved={async project =>
            setProjects(previous => previous.map(item => (item.id === project.id ? project : item)))
          }
          onUseTemplate={useTemplate}
          onClose={() => setProjectsOpen(false)}
        />
      )}
      {sourcesOpen && session && (
        <SourcesDialog
          sessionId={session.id}
          variantId={sourcesOpen.variantId}
          focusSlideId={sourcesOpen.slideId}
          onClose={() => setSourcesOpen(undefined)}
        />
      )}
      {saveDesignTarget && (
        <SaveDesignDialog
          initialName={saveDesignTarget.name}
          busy={!!busy}
          onSave={saveDesign}
          onClose={() => setSaveDesignTarget(undefined)}
        />
      )}
      {settingsOpen && (
        <SettingsDialog
          settings={settings}
          template={projectTemplate}
          activeSession={!!session}
          initialSetup={setupFromHandoff}
          onChanged={setSettings}
          onClose={() => {
            setSettingsOpen(false);
            setSetupFromHandoff(false);
          }}
          onSaved={value => {
            setSettings(value);
            setCloudConsent(false);
            void api<AppStatus>('/status')
              .then(setStatus)
              .catch(() => {});
          }}
        />
      )}
      {chartPicker && chartVariant && chartSlide?.chart && (
        <ChartDialog
          deck={chartVariant.deck}
          slide={chartSlide}
          onSelect={changeChart}
          onClose={() => setChartPicker(undefined)}
        />
      )}
      {layoutPicker && (
        <LayoutDialog
          deck={layoutVariant?.deck}
          slide={layoutSlide}
          onSelect={layoutSlide ? changeLayout : undefined}
          onClose={() => setLayoutPicker(undefined)}
        />
      )}
      {transmissionOpen && (
        <Modal
          title={isSubscription ? `${aiName}へ送信する内容` : 'AIチャットに渡す指示に含まれる内容'}
          onClose={() => setTransmissionOpen(false)}
        >
          <p className="modal-prose">
            {isSubscription
              ? `構成・作成・修正のため、次の内容を接続した${aiName}のクラウドへ送信します。APIキーは使用せず、ご契約の利用権限と上限が適用されます。`
              : '次の内容を含む指示を、このPCで組み立てます。AIのチャットへの貼り付けやファイルの添付は、ご自身で行います。このアドインから自動送信はしません。'}
          </p>
          <ul className="transmission-list">
            <li>プロンプトと、その後の会話・修正指示</li>
            <li>添付資料のファイル名と、抽出した文章・表・数値（上限12万文字）</li>
            <li>構成案、生成した内容、表示モード</li>
          </ul>
          <p className="transmission-prompt">{prompt || 'プロンプトはまだ入力されていません。'}</p>
          {documents.length > 0 && (
            <ul className="transmission-list">
              {documents.map(doc => (
                <li key={doc.id}>
                  {doc.name} · 抽出 {doc.characters.toLocaleString()} 文字
                </li>
              ))}
            </ul>
          )}
          <p className="modal-prose">
            {isSubscription
              ? '月額版もクラウドへ情報を送信します。'
              : '実際に渡す全文は「AIに渡す指示」から確認できます。月額版のチャットもクラウドへ情報を渡します。'}
            機密資料には、設定からローカルLLMを選んでください。
          </p>
          <div className="settings-actions">
            <button className="button primary" onClick={() => setTransmissionOpen(false)}>
              確認しました
            </button>
          </div>
        </Modal>
      )}
      {compareIndex !== undefined && currentVariant && (
        <Modal
          title={variants.length > 1 ? 'スライドを比較' : 'スライドを確認'}
          wide
          onClose={() => setCompareIndex(undefined)}
        >
          <div className="compare-toolbar">
            <p>
              {variants.every(item => item.render?.native)
                ? 'PowerPoint の描画を表示しています。'
                : '未書き出しの案はレイアウトの概略です。実際の PowerPoint では表示が変わる場合があります。'}
            </p>
            <div className="compare-pages">
              <button
                className="icon-button"
                aria-label="前のスライド"
                disabled={compareIndex === 0}
                onClick={() => setCompareIndex(compareIndex - 1)}
              >
                <Icon name="chevron" size={16} />
              </button>
              <span>
                {compareIndex + 1} / {currentVariant.deck.slides.length}
              </span>
              <button
                className="icon-button"
                aria-label="次のスライド"
                disabled={compareIndex >= currentVariant.deck.slides.length - 1}
                onClick={() => setCompareIndex(compareIndex + 1)}
              >
                <Icon name="chevron" size={16} />
              </button>
            </div>
          </div>
          <div className={`compare-grid ${variants.length === 1 ? 'single' : ''}`}>
            {pair.map(variant => (
              <div key={variant.id}>
                <div className="compare-variant-label">
                  <span>
                    {letterOf(variant)} 案 · {variant.label}
                  </span>
                  <div className="preview-actions">
                    {variants.length > 1 && (
                      <button
                        className={`button secondary small ${currentVariant.id === variant.id ? 'active' : ''}`}
                        onClick={() => selectVariant(variant.id)}
                      >
                        {currentVariant.id === variant.id ? (
                          <>
                            <Icon name="check" size={12} />
                            選択中
                          </>
                        ) : (
                          'この案を選ぶ'
                        )}
                      </button>
                    )}
                    <button
                      className="button ghost small"
                      disabled={!!busy || handoffPending}
                      onClick={() => revise(variant, compareIndex)}
                    >
                      <Icon name="edit" size={13} />
                      修正
                    </button>
                  </div>
                </div>
                <div className="compare-slide">{renderSlide(variant, compareIndex)}</div>
                {variant.deck.slides[compareIndex]?.notes && (
                  <details className="speaker-notes">
                    <summary>発表者ノート・補足</summary>
                    <p>{variant.deck.slides[compareIndex].notes}</p>
                  </details>
                )}
              </div>
            ))}
          </div>
        </Modal>
      )}
    </div>
  );
}
