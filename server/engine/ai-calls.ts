import { appendFile } from 'node:fs/promises';
import path from 'node:path';
import type { AiTarget, SendRecord, Outline, Session, Settings, Usage } from '../../shared/contracts.js';
import { documentContext } from '../document-model.js';
import { AppError } from '../errors.js';
import { createProvider, OutputLimitError, parseJsonResponse } from '../providers.js';
import { systemPrompt, type ModelTask } from '../prompts.js';
import { repairReason, repairInstruction } from '../repair-policy.js';
import { candidateLayoutIds } from '../../shared/layout-selection.js';
import { Masker, sha256 } from '../../shared/confidential.js';
import type { SessionEngine } from '../engine.js';
import type { RepairOperation, AiRun, SessionState } from './session-state.js';
import { OPERATION_CALL_LIMIT, SESSION_CALL_LIMIT } from './session-state.js';
import { chatServiceName, targetLabel, settingsFor } from './helpers.js';

/** Every call to an AI goes through here: where the material may go, the call limits, masking, automatic retries and usage. */
export class AiCalls {
  constructor(private readonly engine: SessionEngine) {}

  async complete(
    state: SessionState,
    task: ModelTask,
    payload: unknown,
    maxTokens: number,
    run?: AiRun,
    images?: string[],
  ) {
    const settings = run ? this.targetSettings(state, run.target) : state.settings;
    if (settings.provider === 'claude')
      throw new AppError(400, '有料APIは無効です。月額版との連携で新しく作成してください。', 'PAID_API_DISABLED');
    if (settings.provider === 'chat')
      throw new AppError(
        409,
        '月額版との連携は、画面の指示をコピーして返答を取り込んでください。',
        'CHAT_HANDOFF_REQUIRED',
      );
    this.checkDestination(state, settings, !!run);
    if (state.session.cloudConsentRequired)
      throw new AppError(
        400,
        `履歴の指示・資料・会話を${state.settings.subscriptionService === 'claude' ? 'Claude' : 'ChatGPT'}へ送ることを確認してください。`,
        'CLOUD_CONSENT_REQUIRED',
      );
    // 12 calls per operation (each AI of the session has its own), 40 per presentation.
    if (!this.callsLeft(state, run))
      throw new AppError(
        429,
        state.session.usage.calls >= SESSION_CALL_LIMIT
          ? `1つの資料でのAI呼び出しは${SESSION_CALL_LIMIT}回までです。履歴に保存して、新しく作成してください。`
          : `1回の操作でのAI呼び出しは${OPERATION_CALL_LIMIT}回までです。要点をまとめて指示し直してください。`,
        'CALL_LIMIT',
      );
    const provider = (this.engine.options.providerFactory ?? createProvider)(
      settings,
      this.engine.options.settings.secret(settings.provider),
    );
    state.session.usage.calls++;
    if (run) run.calls++;
    try {
      const request = { ...(payload as any) };
      const operation = run ? run.repair : state.repairOperation,
        correction = operation?.next;
      if (correction?.task === task) {
        request.repair = {
          reason: correction.code,
          instruction: repairInstruction(correction.code),
          ...(correction.detail ? { detail: correction.detail } : {}),
        };
        delete operation!.next;
      }
      if (task === 'generate' && request.outline?.inputBrief) {
        request.confirmedInstructions = request.outline.inputBrief;
        delete request.messages;
      }
      const selected =
        task === 'generate'
          ? request.targetSlides?.map((s: any) => s.layoutId)
          : task === 'revise'
            ? [request.targetSlide?.layoutId]
            : undefined;
      const masker = settings.provider === 'subscription' ? this.masking(state) : undefined,
        protect = <T>(value: T) => (masker ? masker.maskDeep(value) : value);
      const response = await provider.complete({
        system:
          systemPrompt(task, selected ? candidateLayoutIds(selected) : undefined, {
            ...this.engine.pages.designOptions(state, request.outline, run),
            ...(task === 'plan' && request.proposals ? { proposals: request.proposals } : {}),
          }) +
          (masker
            ? '\n\n## 伏せ字について\nこのメッセージの資料・指示・会話では、社名・指定された語・連絡先・数値を【社名1】【語1】【連絡先1】【数値1】のような伏せ字にしています。伏せ字は、そのままの形で文章・見出し・出典の引用に使い、分解・計算・推測をしません。グラフの値には、資料にある数値の伏せ字（【数値n】の形）を文字列のまま書きます。アプリがこのPCで元の語と数値に戻します。'
            : ''),
        content: JSON.stringify(
          protect({
            mode: state.settings.mode,
            projectContext: { audience: state.project.audience, designAndWritingGuidance: state.project.guidance },
            preferences: {
              ...this.engine.pages.stylePreferences(state),
              ...(task === 'plan' && !this.engine.pages.freeDesign(state)
                ? { recentLayouts: this.engine.recentLayouts.slice(-40), variationSeed: state.session.id }
                : {}),
            },
            documents:
              task === 'summarize' || task === 'review'
                ? []
                : documentContext(
                    task === 'generate' ? this.batchDocuments(state, request.targetSlides) : state.documents,
                  ),
            request,
          }),
        ),
        maxTokens,
        ...(images?.length ? { images: images.map(data => ({ mediaType: 'image/png' as const, data })) } : {}),
      });
      this.addUsage(state.session.usage, response.usage);
      return this.unmask(state, parseJsonResponse(response.text));
    } catch (error) {
      if (error && typeof error === 'object' && 'usage' in error)
        this.addUsage(state.session.usage, error.usage as Usage);
      // A limit signal can arrive at the JSON boundary. Only accept complete JSON;
      // never add braces, clip a condition, or expose unfinished content as a plan.
      if (error instanceof OutputLimitError) {
        try {
          return this.unmask(state, parseJsonResponse(error.partialText));
        } catch {
          /* Preserve the original output-limit error. */
        }
      }
      throw error;
    }
  }
  /** Material goes only where the user agreed for this session: the provider it was
   * created with, or the AIs chosen at creation with the accounts connected then. */
  checkDestination(state: SessionState, settings: Settings, other = false) {
    const current = this.engine.options.settings.get();
    if (!state.targets && !other) {
      if (
        current.provider !== state.settings.provider ||
        (current.provider === 'local' && current.endpoint !== state.settings.endpoint)
      )
        throw new AppError(409, '処理先が変更されています。資料の送信先を確認して新しく作成してください。');
      if (state.settings.provider === 'subscription') this.checkSubscriptionBinding(state);
      return;
    }
    if (settings.provider === 'local' && current.endpoint !== state.settings.endpoint)
      throw new AppError(409, 'ローカルLLMの接続先が変更されています。送信先を確認して新しく作成してください。');
    if (settings.provider === 'subscription') {
      const service = settings.subscriptionService ?? 'chatgpt',
        binding = this.engine.options.subscriptionBinding?.(service);
      if (!binding)
        throw new AppError(
          409,
          `${chatServiceName(service)}のアカウントが接続されていません。設定から接続し、新しく作成してください。`,
          'SUBSCRIPTION_CONNECTION_REQUIRED',
        );
      if (state.bindings?.[service] !== binding)
        throw new AppError(
          409,
          `${chatServiceName(service)}の接続アカウントが変更されています。送信先を確認し、新しく作成してください。`,
          'SUBSCRIPTION_ACCOUNT_CHANGED',
        );
    }
  }
  /** An existing task may never silently start sending material to another account. */
  checkSubscriptionBinding(state: SessionState) {
    const current = this.engine.options.settings.get();
    const service = state.settings.subscriptionService ?? 'chatgpt';
    if (current.provider !== 'subscription' || (current.subscriptionService ?? 'chatgpt') !== service)
      throw new AppError(
        409,
        '送信するサービスが変更されています。送信先を確認し、新しく作成するか履歴を開き直してください。',
        'SUBSCRIPTION_SERVICE_CHANGED',
      );
    const binding = this.engine.options.subscriptionBinding?.(service);
    if (!binding)
      throw new AppError(
        409,
        '月額サービスのアカウントが接続されていません。設定から接続し、新しく作成するか履歴を開き直してください。',
        'SUBSCRIPTION_CONNECTION_REQUIRED',
      );
    if (!state.subscriptionBinding || state.subscriptionBinding !== binding)
      throw new AppError(
        409,
        '接続アカウントが変更されています。送信先を確認し、新しく作成するか履歴を開き直してください。',
        'SUBSCRIPTION_ACCOUNT_CHANGED',
      );
  }
  /** The settings of one AI chosen for this session. */
  targetSettings(state: SessionState, target: AiTarget): Settings {
    return settingsFor(state.settings, target);
  }
  /** Whether another AI call is allowed: 12 per operation (or per AI of the session), 40 per presentation. */
  callsLeft(state: SessionState, run?: AiRun) {
    return (
      (run ? run.calls : this.operationCalls(state)) < OPERATION_CALL_LIMIT &&
      state.session.usage.calls < SESSION_CALL_LIMIT
    );
  }
  private operationCalls(state: SessionState) {
    return state.session.usage.calls - (state.repairOperation?.startedCalls ?? 0);
  }
  newRun(state: SessionState, target: AiTarget): AiRun {
    return {
      target,
      label: targetLabel(target),
      repair: {
        remaining: this.engine.options.settings.get().autoRepair !== false ? 2 : 0,
        startedCalls: state.session.usage.calls,
      },
      calls: 0,
      notes: [],
    };
  }
  tryRepair(state: SessionState, task: ModelTask, error: unknown, adjustment: string, run?: AiRun) {
    const reason = repairReason(error),
      operation = run ? run.repair : state.repairOperation;
    if (
      !reason ||
      !operation ||
      operation.remaining <= 0 ||
      !this.callsLeft(state, run) ||
      this.engine.options.settings.get().autoRepair === false
    )
      return false;
    // The app's own finding (which page and element, and what to change) goes with the retry, so the
    // same slip is not repeated. Quoted fragments of the model's text are left out.
    const code = (error as AppError).code,
      detail = ['INVALID_CONTENT', 'INVALID_SOURCE', 'INVALID_QUOTE', 'TEXT_FIT_REQUIRED'].includes(code)
        ? (error as AppError).message
            .replace(/^生成内容を確認できません: /, '')
            .replace(/「[^」]*」/g, '（該当の文字）')
            .slice(0, 400)
        : undefined;
    operation.remaining--;
    operation.next = { task, code, ...(detail ? { detail } : {}) };
    if (run) run.notes.push(reason.reason);
    else this.recordRepair(state, error, adjustment, true);
    return true;
  }
  recordRepair(state: SessionState, error: unknown, adjustment: string, retry: boolean) {
    const reason = repairReason(error);
    if (!reason) return;
    const report = state.session.repairReport ?? { status: 'stopped' as const, retries: 0, apiCalls: 0, steps: [] };
    if (retry) report.retries++;
    report.steps.push({ reason: reason.reason, adjustment });
    state.session.repairReport = report;
  }
  async withRepairs<T>(state: SessionState, operation: () => Promise<T>): Promise<T> {
    const context: RepairOperation = {
      remaining: this.engine.options.settings.get().autoRepair !== false ? 2 : 0,
      startedCalls: state.session.usage.calls,
    };
    state.repairOperation = context;
    delete state.session.repairReport;
    let failed = false;
    try {
      return await operation();
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      const report = state.session.repairReport as Session['repairReport'];
      if (report) {
        report.apiCalls = state.session.usage.calls - context.startedCalls;
        report.status = failed || state.session.recovery ? 'stopped' : 'recovered';
        if (report.status === 'recovered')
          state.session.messages.push({
            role: 'assistant',
            text: `自動対処${report.retries}回：${report.steps.map(s => s.reason + ' → ' + s.adjustment).join(' / ')}。検証が通り、処理を完了しました。この操作のAI呼び出しは${report.apiCalls}回です。`,
          });
      }
      delete state.repairOperation;
    }
  }
  addUsage(total: Usage, value: Usage) {
    for (const field of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const)
      total[field] += value[field] || 0;
  }
  /** The documents a generation batch needs: those its pages name in the outline
   * (sourceIds). When any page names none, every document is sent as before. */
  private batchDocuments(state: SessionState, targets: Outline['slides'] | undefined) {
    const pages = (targets ?? []).filter(s => s.layoutId !== 'cover');
    if (!pages.length || state.documents.length < 2) return state.documents;
    const ids = new Set<string>();
    for (const page of pages) {
      const named = (page.sourceIds ?? [])
        .map(id => id.split(':')[0])
        .filter(id => state.documents.some(d => d.id === id));
      if (!named.length) return state.documents;
      named.forEach(id => ids.add(id));
    }
    return state.documents.filter(d => ids.has(d.id));
  }
  /** The masker of a session whose project sends masked content to a cloud AI. */
  masking(state: SessionState): Masker | undefined {
    const privacy = (() => {
      try {
        return this.engine.projects.get(state.project.id).privacy;
      } catch {
        return state.project.privacy;
      }
    })();
    if (
      (state.sendScope ?? privacy?.mode) !== 'masked' ||
      (!['chat', 'subscription'].includes(state.settings.provider) && !state.targets?.some(t => t !== 'local'))
    )
      return undefined;
    state.masker ??= new Masker(privacy?.terms ?? []);
    return state.masker.learn([
      ...state.documents.flatMap(d => [d.name, ...d.sources.map(u => u.text)]),
      ...state.session.messages.map(m => m.text),
      state.project.audience,
      state.project.guidance,
    ]);
  }
  unmask<T>(state: SessionState, value: T): T {
    if (!state.masker) return value;
    const { value: restored, unknown } = state.masker.unmaskDeep(value);
    if (unknown.length)
      throw new AppError(
        422,
        `返答に、渡していない伏せ字（${unknown.slice(0, 3).join('、')}）があります。渡した伏せ字だけを、そのままの形で使ってください。`,
        'INVALID_CONTENT',
      );
    return restored;
  }
  /** Proof for a masked hand-off: no masked original remains in the instruction. */
  recordMasked(state: SessionState, masker: Masker, task: string, service: string) {
    const handoff = state.session.chatHandoff!,
      residual = masker.residual(handoff.instruction);
    if (residual.length) {
      delete state.session.chatHandoff;
      throw new AppError(
        422,
        `伏せ字にした語が指示に${residual.length}件残っているため、指示の作成を止めました。`,
        'MASK_LEAK_BLOCKED',
      );
    }
    const hash = sha256(handoff.instruction),
      checked = state.documents.reduce((n, d) => n + d.sources.reduce((m, u) => m + u.text.length, 0), 0);
    handoff.privacy = {
      level: 'masked',
      checkedCharacters: checked,
      hits: 0,
      sha256: hash,
      characters: handoff.instruction.length,
      masked: masker.size,
      items: masker.items(),
    };
    const record: SendRecord = {
      at: new Date().toISOString(),
      task,
      service,
      level: 'masked',
      characters: handoff.instruction.length,
      checkedCharacters: checked,
      hits: 0,
      sha256: hash,
      masked: masker.size,
    };
    void appendFile(
      path.join(this.engine.options.dataDir, 'send-log.jsonl'),
      JSON.stringify(record) + '\n',
      'utf8',
    ).catch(() => {});
  }
  checkConversation(messages: Session['messages']) {
    if (messages.reduce((sum, m) => sum + m.text.length, 0) > 240_000)
      throw new AppError(
        413,
        '会話全体が24万文字を超えました。作成済み資料を履歴に保存し、要点を整理して新しく作成してください。',
      );
  }
}
