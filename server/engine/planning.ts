import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  MAX_PROMPT_CHARACTERS,
  PLAN_OUTPUT_TOKENS,
  PLAN_RETRY_OUTPUT_TOKENS,
  OUTLINE_PROPOSALS,
  type AiTarget,
  type SendScope,
  type Outline,
  type OutlineProposal,
  type ProposalSet,
  type Session,
  type Settings,
  type SubscriptionService,
  type ProjectProfile,
} from '../../shared/contracts.js';
import { documentContext, type ParsedDocument } from '../document-model.js';
import { AppError, requireText } from '../errors.js';
import { emptyUsage, OutputLimitError } from '../providers.js';
import { validatePlanResponse } from '../validation.js';
import { demoOutline, DEMO_WARNING } from '../demo.js';
import { SHOWCASE_WARNING } from '../showcase.js';
import { repairReason } from '../repair-policy.js';
import { TEMPLATE_THEME_ID } from '../../shared/themes.js';
import type { SessionEngine } from '../engine.js';
import type { SessionState } from './session-state.js';
import { PROPOSAL_CHOICES_FILE, MAX_VARIANTS, SESSION_CALL_LIMIT } from './session-state.js';
import { darkPalette, chatServiceName, settingsFor } from './helpers.js';

/** Starting a presentation and agreeing on its outline: questions, the three directions, the pick and the memory of picks. */
export class PlanningService {
  constructor(private readonly engine: SessionEngine) {}

  async create(
    input: {
      prompt: unknown;
      mode?: unknown;
      cloudConsent?: unknown;
      oneShot?: unknown;
      targets?: unknown;
      sendScope?: unknown;
    },
    documents: ParsedDocument[],
  ) {
    const prompt = requireText(input.prompt, '指示', MAX_PROMPT_CHARACTERS);
    const settings = this.engine.options.settings.get();
    const project = this.engine.projects.get(settings.activeProjectId);
    if (input.mode !== undefined) {
      if (!['presentation', 'reading'].includes(String(input.mode)))
        throw new AppError(400, '表示モードが正しくありません。');
      settings.mode = input.mode as Settings['mode'];
    }
    const choice = this.creationTargets(settings, input, project);
    if (choice) {
      Object.assign(settings, settingsFor(settings, choice.targets[0]));
      if (choice.scope === 'design') settings.designMode = 'template';
    } else if (settings.provider === 'subscription' && input.cloudConsent !== true)
      throw new AppError(
        400,
        `${settings.subscriptionService === 'claude' ? 'Claude' : 'ChatGPT'}へ指示・資料・会話を送ることを確認してください。`,
        'CLOUD_CONSENT_REQUIRED',
      );
    const subscriptionBinding =
      settings.provider === 'subscription'
        ? (choice?.bindings[settings.subscriptionService ?? 'chatgpt'] ??
          this.engine.options.subscriptionBinding?.(settings.subscriptionService ?? 'chatgpt'))
        : undefined;
    if (settings.provider === 'subscription' && !subscriptionBinding)
      throw new AppError(
        409,
        '設定から月額サービスのアカウントに接続してから作成してください。',
        'SUBSCRIPTION_CONNECTION_REQUIRED',
      );
    // Manual chat: what the instruction carries, as is or with names and numbers masked (the project's choice
    // when not given here). The design-only way needs a local LLM, so it is not offered for a chat.
    const chatScope =
      settings.provider === 'chat' && (input.sendScope === 'full' || input.sendScope === 'masked')
        ? input.sendScope
        : undefined;
    if (settings.provider === 'chat' && input.sendScope !== undefined && !chatScope)
      throw new AppError(400, '手動チャット連携で選べる送る内容は、そのまま送るか伏せ字にするかです。');
    documentContext(documents);
    this.engine.reserveSession();
    const session: Session = {
      id: randomUUID(),
      provider: settings.provider,
      projectId: project.id,
      ...(choice ? { targets: choice.targets, sendScope: choice.scope } : {}),
      ...(chatScope ? { sendScope: chatScope } : {}),
      ...(settings.provider === 'subscription'
        ? { subscriptionService: settings.subscriptionService ?? 'chatgpt' }
        : {}),
      phase: 'clarifying',
      messages: [{ role: 'user', text: prompt }],
      variants: [],
      usage: emptyUsage(),
      warnings: documents.flatMap(document => document.warnings.map(warning => `${document.name}: ${warning}`)),
    };
    const state: SessionState = {
      ...(choice ? { targets: choice.targets, sendScope: choice.scope, bindings: choice.bindings } : {}),
      ...(chatScope ? { sendScope: chatScope } : {}),
      ...(settings.provider === 'chat' && input.oneShot === true ? { oneShot: true } : {}),
      session,
      documents,
      settings,
      project,
      subscriptionBinding,
      busy: false,
      createdAt: Date.now(),
      design: await this.engine.library.preferredDesign(settings, project.id, session.warnings),
    };
    this.engine.states.set(session.id, state);
    try {
      const showcase = settings.provider === 'demo' ? await this.engine.sample.loadShowcase() : undefined;
      if (showcase) {
        // The recording: its request and its three directions, with the samples made when it was recorded.
        state.showcase = showcase;
        settings.mode = showcase.mode;
        settings.slideCount = 'auto';
        session.warnings.unshift(SHOWCASE_WARNING);
        session.messages = [
          { role: 'user', text: showcase.prompt },
          {
            role: 'assistant',
            text: `この依頼に、${showcase.ai}が方向の違う構成案を${showcase.proposals.items.length}つ出した記録です。見本と「ありがちさ」「向いている場面」「AIのおすすめ」を見比べて、進める案を1つ選んでください。`,
          },
        ];
        const { chosen: _chosen, orderNote: _note, fresh: _fresh, ...set } = structuredClone(showcase.proposals);
        session.proposals = set;
      } else if (settings.provider === 'demo') {
        session.warnings.unshift(DEMO_WARNING);
        session.messages.push({
          role: 'assistant',
          text: 'デモとして構成と図形配置を確認します。読み手や説明時間、特に伝えたいことを教えてください。「おまかせ」でも進められます。',
        });
      } else if (settings.provider === 'chat') this.engine.chat.prepareChatPlan(state, session.messages);
      else await this.engine.ai.withRepairs(state, () => this.plan(state, session.messages));
      return session;
    } catch (error) {
      this.engine.states.delete(session.id);
      throw error;
    }
  }

  /** The AIs chosen for one creation, checked: connected accounts, a configured local
   * LLM, and consent for what each may receive. Undefined when none were chosen. */
  private creationTargets(
    settings: Settings,
    input: { targets?: unknown; sendScope?: unknown; cloudConsent?: unknown },
    project: ProjectProfile,
  ) {
    if (input.targets === undefined) return undefined;
    if (settings.provider !== 'subscription' && settings.provider !== 'local')
      throw new AppError(400, '作成するAIを選べるのは、月額版での自動作成かローカルLLMを使う設定のときです。');
    const targets = input.targets;
    if (
      !Array.isArray(targets) ||
      !targets.length ||
      targets.length > MAX_VARIANTS ||
      targets.some(t => t !== 'claude' && t !== 'chatgpt' && t !== 'local') ||
      new Set(targets).size !== targets.length
    )
      throw new AppError(400, `作成するAIを1〜${MAX_VARIANTS}つ選んでください。`);
    const scope = input.sendScope ?? (project.privacy?.mode === 'masked' ? 'masked' : 'full');
    if (scope !== 'full' && scope !== 'masked' && scope !== 'design')
      throw new AppError(400, '外部のAIに送る内容を選んでください。');
    const cloud = targets.filter((t): t is SubscriptionService => t !== 'local');
    if (targets.includes('local') && !settingsFor(settings, 'local').model)
      throw new AppError(400, '設定でローカルLLMの接続先とモデル名を登録してください。', 'LOCAL_MODEL_REQUIRED');
    if (scope === 'design' && (!targets.includes('local') || !cloud.length))
      throw new AppError(
        400,
        '内容を送らない作成では、内容を書くローカルLLMと、デザインを頼むAI（ClaudeかChatGPT）を選んでください。',
        'DESIGN_TARGETS_REQUIRED',
      );
    const bindings: Partial<Record<SubscriptionService, string>> = {};
    for (const service of cloud) {
      const binding = this.engine.options.subscriptionBinding?.(service);
      if (!binding)
        throw new AppError(
          409,
          `設定から${chatServiceName(service)}のアカウントに接続してから作成してください。`,
          'SUBSCRIPTION_CONNECTION_REQUIRED',
        );
      bindings[service] = binding;
    }
    if (scope !== 'design' && cloud.length && input.cloudConsent !== true)
      throw new AppError(
        400,
        `${cloud.map(chatServiceName).join('・')}へ指示・資料・会話を送ることを確認してください。`,
        'CLOUD_CONSENT_REQUIRED',
      );
    return {
      targets: scope === 'design' ? ['local' as AiTarget, ...cloud] : (targets as AiTarget[]),
      scope: scope as SendScope,
      bindings,
    };
  }
  async message(id: string, text: unknown) {
    return this.engine.lock(
      id,
      async state => {
        const messages = [
          ...state.session.messages,
          { role: 'user' as const, text: requireText(text, 'メッセージ', MAX_PROMPT_CHARACTERS) },
        ];
        this.engine.ai.checkConversation(messages);
        if (state.settings.provider === 'chat') {
          this.engine.chat.prepareChatPlan(state, messages);
          return state.session;
        }
        if (state.showcase) {
          state.session.messages.push(
            { role: 'user', text: messages[messages.length - 1].text },
            {
              role: 'assistant',
              text: 'サンプル体験は記録の再生のため、指示で構成を変えることはできません。案を選び、構成を確認して「この構成で作成」を押してください。',
            },
          );
          return state.session;
        }
        if (state.settings.provider === 'demo') {
          state.session.messages = messages;
          state.session.outline = demoOutline(
            messages[0].text,
            state.settings.mode,
            state.documents,
            state.settings.slideCount,
          );
          // The company template is applied after generation (styleDeck); the outline keeps a built-in theme.
          state.session.outline.themeId =
            state.settings.themeId === 'auto' || state.settings.themeId === TEMPLATE_THEME_ID
              ? this.engine.preferredTheme
              : state.settings.themeId;
          state.session.phase = 'outline';
          state.session.messages.push({
            role: 'assistant',
            text: 'デモの構成案を用意しました。内容は分析結果ではなく配置確認用です。「この構成で作成」でスライドを作れます。',
          });
        } else await this.plan(state, messages);
        return state.session;
      },
      true,
      true,
    );
  }

  async retryPlan(id: string) {
    return this.engine.lock(
      id,
      async state => {
        if (!state.pendingPlan || state.session.recovery?.task !== 'plan')
          throw new AppError(409, '再試行する構成の指示がありません。');
        if (state.pendingPlan.failures >= 2)
          throw new AppError(
            429,
            '同じ指示での出力上限が繰り返されました。追加の呼び出しは行っていません。プロンプト欄で優先する条件を整理してから送信してください。',
          );
        await this.plan(state, state.pendingPlan.messages, true);
        return state.session;
      },
      false,
      true,
    );
  }

  private async plan(state: SessionState, messages: Session['messages'], retry = false) {
    const needsInputBrief = messages.filter(m => m.role === 'user').reduce((sum, m) => sum + m.text.length, 0) > 12_000;
    let failures = retry ? (state.pendingPlan?.failures ?? 0) : 0,
      compact = retry;
    let response: ReturnType<typeof validatePlanResponse>;
    while (true) {
      // After a failed attempt the retry asks for one outline only, which is shorter.
      const proposals = !compact && this.wantsProposals(state, needsInputBrief);
      const previous =
        proposals && state.session.proposals
          ? {
              previousProposals: state.session.proposals.items.map(({ direction, difference, typicality }) => ({
                direction,
                difference,
                typicality,
              })),
            }
          : {};
      try {
        response = validatePlanResponse(
          await this.engine.ai.complete(
            state,
            'plan',
            {
              messages,
              currentOutline: state.session.outline,
              ...(proposals ? { proposals: OUTLINE_PROPOSALS, ...previous } : {}),
              needsInputBrief,
              compactOutline: true,
              outputRetry: compact,
            },
            compact ? PLAN_RETRY_OUTPUT_TOKENS : PLAN_OUTPUT_TOKENS,
          ),
          proposals ? outline => this.checkOutline(state, outline) : undefined,
        );
        if (response.outline) this.checkOutline(state, response.outline);
        break;
      } catch (error) {
        if (
          !repairReason(error) ||
          (this.engine.options.settings.get().autoRepair === false && !(error instanceof OutputLimitError))
        )
          throw error;
        failures++;
        compact = true;
        if (
          this.engine.ai.tryRepair(
            state,
            'plan',
            error,
            '指定の枚数と条件を保持し、回答枠20,000トークンで見出し・役割・短い要点だけの構成を再作成します。',
          )
        )
          continue;
        state.pendingPlan = { messages: structuredClone(messages), failures };
        state.session.messages = messages;
        state.session.phase = 'clarifying';
        state.session.recovery = {
          task: 'plan',
          retryAvailable: failures < 2 && state.session.usage.calls < SESSION_CALL_LIMIT,
          message:
            failures < 2
              ? '構成案を完了できませんでした。指示・資料・利用量を保持しています。回答枠を広げて、見出しと要点だけの構成を再試行できます。'
              : '構成案の不備が繰り返されました。指示と資料は保持しています。プロンプト欄で優先する条件を整理してから送信してください。',
        };
        return;
      }
    }
    delete state.pendingPlan;
    delete state.session.recovery;
    delete state.draft;
    delete state.revision;
    state.session.messages = messages;
    const offered = response.proposals;
    if (offered?.problems.length)
      state.session.warnings.push(
        `AIが出した構成案のうち${offered.problems.length}案は、条件（枚数・表示モードなど）に合わないため外しました。`,
      );
    if (response.question) {
      state.session.phase = 'clarifying';
      state.session.messages.push({ role: 'assistant', text: response.question });
    } else if (offered && offered.items.length > 1) {
      // The user picks one direction (chooseProposal) before the outline is reviewed.
      state.session.proposals = await this.orderProposals(state, {
        items: offered.items,
        candidates: offered.candidates,
        ...(offered.recommended !== undefined ? { recommended: offered.recommended } : {}),
        ...(offered.reason ? { reason: offered.reason } : {}),
      });
      delete state.previewSeeds;
      state.session.phase = 'clarifying';
      state.session.messages.push({
        role: 'assistant',
        text: `方向の違う構成案を${offered.items.length}つ用意しました。進める案を1つ選んでください。別の方向がよい場合は、同じ入力欄から指示できます。`,
      });
    } else {
      const outline = response.outline ?? offered!.items[0].outline;
      if (offered) state.session.warnings.push('条件に合う構成案が1つだけだったため、その案で進めます。');
      state.session.outline = outline;
      if (needsInputBrief && !outline.inputBrief)
        state.session.warnings.push(
          '長文の確認用条件が返されませんでした。原文を省略せずに生成へ送ります。入力量が多い場合は条件を整理するよう指示してください。',
        );
      state.session.phase = 'outline';
      state.session.messages.push({
        role: 'assistant',
        text: '構成案を用意しました。見出しと説明の順番を確認してください。変更は同じ入力欄から指示できます。',
      });
    }
  }
  /** The first outline of an AI-designed deck made through a monthly plan comes as several
   * directions, each with the AI's own estimate of how typical it is, and the user picks one.
   * Later changes to the chosen outline, long instructions (inputBrief) and template designs
   * keep the single outline. */
  wantsProposals(state: SessionState, needsInputBrief: boolean) {
    return (
      state.settings.outlineProposals !== false &&
      this.engine.pages.freeDesign(state) &&
      (state.settings.provider === 'subscription' || (state.settings.provider === 'chat' && !state.oneShot)) &&
      !state.session.outline &&
      !needsInputBrief
    );
  }
  checkOutline(state: SessionState, outline: Outline) {
    if (outline.mode !== state.settings.mode)
      throw new AppError(422, '構成案の表示モードが指定と異なります。', 'INVALID_CONTENT');
    this.engine.pages.checkSlideCount(state, outline);
  }
  /** Makes one of the offered directions the outline. Allowed until slides are made. */
  async chooseProposal(id: string, index: unknown) {
    return this.engine.lock(
      id,
      async state => {
        const offered = state.session.proposals;
        if (
          !offered ||
          typeof index !== 'number' ||
          !Number.isInteger(index) ||
          index < 0 ||
          index >= offered.items.length
        )
          throw new AppError(400, '構成案を一覧から選んでください。');
        if (state.session.variants.length)
          throw new AppError(409, 'スライドを作成した後は、構成案を選び直せません。新しく作成してください。');
        const proposal = offered.items[index];
        state.session.outline = structuredClone(proposal.outline);
        offered.chosen = index;
        delete state.session.recovery;
        delete state.draft;
        delete state.pendingPlan;
        state.session.phase = 'outline';
        state.session.messages.push({
          role: 'assistant',
          text: `「${proposal.direction}」の案で進めます。見出しと説明の順番を確認してください。変更は同じ入力欄から指示できます。`,
        });
        if (state.settings.provider !== 'demo')
          await this.remember(state, {
            type: 'choice',
            typicality: proposal.typicality,
            dark: darkPalette(proposal.outline.palette),
            recommended: index === offered.recommended,
          });
        return state.session;
      },
      false,
    );
  }
  /** What is kept of a pick of the three directions and of the rating of the deck made from it: numbers
   * and yes/no only, per project and session. No text of the request, the outline or the deck. */
  async remember(
    state: SessionState,
    entry:
      { type: 'choice'; typicality: number; dark: boolean; recommended: boolean } | { type: 'rating'; rating: number },
  ) {
    try {
      await mkdir(this.engine.options.dataDir, { recursive: true });
      await appendFile(
        path.join(this.engine.options.dataDir, PROPOSAL_CHOICES_FILE),
        `${JSON.stringify({ version: 1, at: new Date().toISOString(), project: state.project.id, session: state.session.id, ...entry })}\n`,
        { mode: 0o600 },
      );
    } catch {
      /* The order of later directions simply stays as the AI gave it. */
    }
  }
  /** Earlier picks in this project, the last one per session, with that session's last rating. */
  private async proposalHistory(projectId: string) {
    let rows: any[] = [];
    try {
      rows = (await readFile(path.join(this.engine.options.dataDir, PROPOSAL_CHOICES_FILE), 'utf8'))
        .split('\n')
        .filter(Boolean)
        .slice(-1000)
        .flatMap(line => {
          try {
            return [JSON.parse(line)];
          } catch {
            return [];
          }
        });
    } catch {
      return [];
    }
    const ratings = new Map<string, number>(),
      picks = new Map<string, { typicality: number; dark: boolean; recommended: boolean }>();
    for (const row of rows) {
      if (row?.type === 'rating' && typeof row.session === 'string' && Number.isInteger(row.rating))
        ratings.set(row.session, row.rating);
      if (
        row?.type === 'choice' &&
        row.project === projectId &&
        typeof row.session === 'string' &&
        typeof row.typicality === 'number'
      )
        picks.set(row.session, {
          typicality: row.typicality,
          dark: row.dark === true,
          recommended: row.recommended === true,
        });
    }
    return [...picks].map(([session, pick]) => ({ ...pick, rating: ratings.get(session) }));
  }
  /** Orders the directions by the user's earlier picks in this project: how typical the picked ones were,
   * light or dark, and whether the AI's recommendation was taken. A pick whose deck was rated well counts
   * more, one rated poorly less. From two earlier picks on; the AI's recommendation stays marked. */
  async orderProposals(state: SessionState, set: ProposalSet): Promise<ProposalSet> {
    const history = await this.proposalHistory(state.project.id);
    if (history.length < 2 || set.items.length < 2) return set;
    const weight = (rating?: number) => (rating === undefined ? 1 : rating >= 4 ? 2 : rating === 3 ? 1 : 0.4);
    let total = 0,
      typical = 0,
      dark = 0,
      followed = 0;
    for (const pick of history) {
      const w = weight(pick.rating);
      total += w;
      typical += w * pick.typicality;
      dark += w * (pick.dark ? 1 : 0);
      followed += w * (pick.recommended ? 1 : 0);
    }
    const preferredTypicality = typical / total,
      preferredDark = dark / total,
      followsAi = followed / total >= 0.6;
    const score = (item: OutlineProposal, index: number) =>
      -Math.abs(item.typicality - preferredTypicality) -
      0.2 * Math.abs((darkPalette(item.outline.palette) ? 1 : 0) - preferredDark) +
      (followsAi && index === set.recommended ? 0.15 : 0);
    const order = set.items
      .map((item, index) => ({ item, index, score: score(item, index) }))
      .sort((a, b) => b.score - a.score);
    // The direction furthest from the earlier picks comes second, so the order does not narrow what is picked over time.
    const fresh = order.length > 2 ? 1 : undefined;
    if (fresh !== undefined) order.splice(1, 0, order.pop()!);
    const recommended = set.recommended === undefined ? undefined : order.findIndex(o => o.index === set.recommended);
    const habits = [
      `ありがちさ${Math.round(preferredTypicality * 100)}%前後の案`,
      ...(preferredDark >= 0.6 ? ['暗い背景'] : preferredDark <= 0.2 ? ['明るい背景'] : []),
      ...(followsAi ? ['AIのおすすめ'] : []),
    ];
    return {
      ...set,
      items: order.map(o => o.item),
      ...(recommended !== undefined ? { recommended } : {}),
      ...(fresh !== undefined ? { fresh } : {}),
      orderNote: `これまでの${history.length}回の選び方（${habits.join('・')}を選ぶことが多い）に一番近い案を先頭に、${fresh !== undefined ? 'いつもと違う方向の案をその次に' : '残りをその後に'}並べています。`,
    };
  }
}
