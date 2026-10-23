import { randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  FREE_CHAT_BATCH_SIZE,
  CHAT_GENERATION_BATCH_SIZE,
  CHAT_READING_BATCH_SIZE,
  READING_BATCH_SIZE,
  OUTLINE_PROPOSALS,
  type ChatService,
  type DeckSpec,
  type Outline,
  type Session,
  type SlideSpec,
} from '../../shared/contracts.js';
import { documentContext } from '../document-model.js';
import { AppError } from '../errors.js';
import { aiKitVersion, systemPrompt, type ModelTask } from '../prompts.js';
import { validateDeck, validateOutline, validatePlanResponse, validateSlide } from '../validation.js';
import { repairReason } from '../repair-policy.js';
import { fitProblems, applySummaries, assertTextFits } from '../text-fit.js';
import { candidateLayoutIds, diversifyDeck, improveTextFit } from '../../shared/layout-selection.js';
import { prepareChatHandoff, parseChatResponse } from '../chat-handoff.js';
import { applySavedDesign } from '../design-application.js';
import { fillBlanks } from '../../shared/blanks.js';
import type { SessionEngine } from '../engine.js';
import type { ChatDraft, SessionState } from './session-state.js';
import { chatServiceName, knownTheme, continued, factValues, deckFindings } from './helpers.js';

/** Manual chat: the instruction the user copies to an AI chat, and the reply pasted back. */
export class ChatHandoffService {
  constructor(private readonly engine: SessionEngine) {}

  prepareChatPlan(state: SessionState, messages: Session['messages']) {
    this.engine.checkChatMode(state);
    delete state.draft;
    delete state.revision;
    delete state.session.recovery;
    state.session.messages = messages;
    const needsInputBrief = messages.filter(m => m.role === 'user').reduce((sum, m) => sum + m.text.length, 0) > 12_000,
      proposals = this.engine.planning.wantsProposals(state, needsInputBrief);
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
    state.chat = {
      task: 'plan',
      payload: {
        messages,
        currentOutline: state.session.outline,
        needsInputBrief,
        compactOutline: true,
        ...(proposals ? { proposals: OUTLINE_PROPOSALS, ...previous } : {}),
        ...(state.oneShot && !state.session.variants.length ? { oneShot: true } : {}),
      },
      messages,
    };
    this.exposeChat(state);
  }
  prepareChatGeneration(
    state: SessionState,
    outline: Outline,
    issues?: string[],
    correctionCode?: string,
    start?: { purpose: 'generate' | 'alternate'; service?: ChatService },
  ) {
    this.engine.checkChatMode(state);
    const purpose = start?.purpose ?? (state.chat?.purpose === 'alternate' ? 'alternate' : 'generate'),
      service = start?.service ?? (purpose === 'alternate' ? state.chat?.service : undefined);
    const key = JSON.stringify({
      outline,
      messages: state.session.messages,
      settings: state.settings,
      purpose,
      service,
    });
    if (state.draft?.key !== key)
      state.draft = {
        key,
        slides: [],
        themeId: outline.themeId ?? this.engine.preferredTheme,
        batchSize: this.engine.pages.freeDesign(state)
          ? FREE_CHAT_BATCH_SIZE
          : outline.mode === 'reading'
            ? CHAT_READING_BATCH_SIZE
            : CHAT_GENERATION_BATCH_SIZE,
        singleFailures: 0,
        compact: false,
      };
    const draft = state.draft,
      targetSlides = outline.slides.slice(draft.slides.length, draft.slides.length + draft.batchSize);
    if (!targetSlides.length)
      throw new AppError(409, '本文は作成済みです。現在表示されている文字量調整の指示を使用してください。');
    state.chat = {
      full: state.chat?.full,
      task: 'generate',
      purpose,
      ...(service ? { service } : {}),
      targetIds: targetSlides.map(s => s.id),
      payload: {
        outline,
        targetSlides,
        messages: state.session.messages,
        compactOutput: true,
        continuedFrom: draft.slides.map(continued),
      },
    };
    this.exposeChat(state, issues, correctionCode);
  }
  exposeChat(state: SessionState, issues?: string[], correctionCode?: string) {
    const pending = state.chat!;
    const request = { ...pending.payload };
    if (pending.task === 'generate' && request.outline?.inputBrief) {
      request.confirmedInstructions = request.outline.inputBrief;
      delete request.messages;
    }
    const selected =
      pending.task === 'generate'
        ? request.targetSlides?.map((s: any) => s.layoutId)
        : pending.task === 'revise'
          ? [request.targetSlide?.layoutId]
          : undefined;
    const current = this.engine.options.settings.get(),
      service = pending.service ?? current.chatService ?? 'chatgpt',
      link = current.chatProjects?.[service];
    const projectMode =
      !!link &&
      link.kitVersion === aiKitVersion() &&
      !pending.full &&
      pending.task !== 'summarize' &&
      this.engine.pages.freeDesign(state);
    const candidateIds = selected ? candidateLayoutIds(selected) : undefined;
    const masker = this.engine.ai.masking(state);
    state.session.chatHandoff = prepareChatHandoff({
      task: pending.task,
      service,
      candidateIds,
      ...(pending.task === 'summarize'
        ? masker
          ? {
              system:
                systemPrompt('summarize') +
                '\n\n## 伏せ字について\nこのメッセージの資料・指示・会話では、社名・指定された語・連絡先・数値を【社名1】【語1】【連絡先1】【数値1】のような伏せ字にしています。伏せ字は、そのままの形で文章・見出し・出典の引用に使い、分解・計算・推測をしません。グラフの値には、資料にある数値の伏せ字（【数値n】の形）を文字列のまま書きます。アプリがこのPCで元の語と数値に戻します。',
            }
          : {}
        : {
            system: (masker
              ? (text: string) =>
                  text +
                  '\n\n## 伏せ字について\nこのメッセージの資料・指示・会話では、社名・指定された語・連絡先・数値を【社名1】【語1】【連絡先1】【数値1】のような伏せ字にしています。伏せ字は、そのままの形で文章・見出し・出典の引用に使い、分解・計算・推測をしません。グラフの値には、資料にある数値の伏せ字（【数値n】の形）を文字列のまま書きます。アプリがこのPCで元の語と数値に戻します。'
              : (text: string) => text)(
              systemPrompt(pending.task as ModelTask, candidateIds, {
                mode: projectMode ? 'project' : 'full',
                focusIds: selected,
                oneShot: request.oneShot === true,
                ...this.engine.pages.designOptions(state, request.outline),
                ...(pending.task === 'plan' && request.proposals ? { proposals: request.proposals } : {}),
              }),
            ),
          }),
      serviceUrl: link?.url,
      instructionMode: projectMode ? 'project' : 'full',
      projectStale: !!link && link.kitVersion !== aiKitVersion(),
      content: (masker ? <T>(value: T) => masker.maskDeep(value) : <T>(value: T) => value)({
        mode: state.settings.mode,
        projectContext: { audience: state.project.audience, designAndWritingGuidance: state.project.guidance },
        preferences: {
          ...this.engine.pages.stylePreferences(state),
          ...(pending.task === 'plan' && !this.engine.pages.freeDesign(state)
            ? { recentLayouts: this.engine.recentLayouts.slice(-40), variationSeed: state.session.id }
            : {}),
        },
        documents: pending.task === 'summarize' ? [] : documentContext(state.documents),
        request,
      }),
      ...(pending.purpose === 'generate'
        ? { completedSlides: state.draft?.slides.length ?? 0, totalSlides: state.session.outline?.slides.length }
        : {}),
      ...(pending.purpose === 'revise' ? { slideId: pending.targetIds?.[0] } : {}),
      validationIssues: issues,
      correctionCode,
    });
    if (masker) this.engine.ai.recordMasked(state, masker, pending.task, service);
    delete state.session.recovery;
  }
  async cancelChat(id: string) {
    return this.engine.lock(
      id,
      async state => {
        if (state.chat?.task !== 'design') this.engine.checkChatMode(state);
        delete state.chat;
        delete state.draft;
        delete state.revision;
        delete state.session.chatHandoff;
        delete state.session.recovery;
        state.session.phase = state.session.variants.length
          ? 'ready'
          : state.session.outline
            ? 'outline'
            : 'clarifying';
        return state.session;
      },
      false,
    );
  }
  async chatResponse(id: string, input: { requestId?: unknown; response?: unknown }) {
    return this.engine.lock(
      id,
      async state => {
        const pending = state.chat;
        if (pending?.task === 'design') return this.engine.designRequests.designResponse(state, pending, input);
        this.engine.checkChatMode(state);
        if (!pending || !state.session.chatHandoff) throw new AppError(409, '取り込むAIの指示がありません。');
        if (typeof input.requestId !== 'string' || input.requestId !== state.session.chatHandoff.requestId)
          throw new AppError(
            409,
            '古い指示への返答です。現在表示されている指示と返答を使用してください。',
            'STALE_CHAT_RESPONSE',
          );
        if (pending.purpose === 'revise') {
          const variant = this.engine.variant(state, pending.variantId);
          if (JSON.stringify(variant.deck) !== pending.variantBase)
            throw new AppError(
              409,
              '修正対象が変更されました。現在のスライドに指示を送り直してください。',
              'STALE_CHAT_RESPONSE',
            );
        }
        const warnings = [...state.session.warnings],
          priorDraftCount = state.draft?.slides.length ?? 0;
        try {
          const raw = this.engine.ai.unmask(state, parseChatResponse(input.response));
          if (pending.task === 'plan' && (raw as any)?.kind === 'deck') {
            if (!pending.payload.oneShot)
              throw new AppError(
                422,
                '今回は構成の確認です。kindをquestionsまたはoutlineにして返してください。',
                'INVALID_CONTENT',
              );
            await this.acceptOneShot(state, pending, raw as any);
            return state.session;
          }
          if (pending.task === 'plan') {
            const result = validatePlanResponse(
              raw,
              pending.payload.proposals
                ? outline => {
                    this.engine.planning.checkOutline(state, outline);
                    for (const s of outline.slides)
                      if (s.sourceIds?.some(id => !state.documents.some(d => d.id === id)))
                        throw new AppError(422, '構成案に資料にない出典IDがあります。', 'INVALID_SOURCE');
                  }
                : undefined,
            );
            const offered = result.proposals;
            if (offered && offered.items.length > 1) {
              state.session.messages = pending.messages ?? state.session.messages;
              if (offered.problems.length)
                state.session.warnings.push(
                  `AIが出した構成案のうち${offered.problems.length}案は、条件（枚数・表示モードなど）に合わないため外しました。`,
                );
              state.session.proposals = await this.engine.planning.orderProposals(state, {
                items: offered.items,
                candidates: offered.candidates,
                ...(offered.recommended !== undefined ? { recommended: offered.recommended } : {}),
                ...(offered.reason ? { reason: offered.reason } : {}),
              });
              state.session.phase = 'clarifying';
              state.session.messages.push({
                role: 'assistant',
                text: `AIの返答から、方向の違う構成案を${offered.items.length}つ取り込みました。進める案を1つ選んでください。`,
              });
              delete state.chat;
              delete state.session.chatHandoff;
              return state.session;
            }
            if (offered) {
              result.outline = offered.items[0].outline;
              state.session.warnings.push('条件に合う構成案が1つだけだったため、その案で進めます。');
            }
            if (result.outline && !offered) {
              if (result.outline.mode !== state.settings.mode)
                throw new AppError(422, '構成案のモードが設定と異なります。', 'INVALID_CONTENT');
              this.engine.pages.checkSlideCount(state, result.outline);
              const original = (raw as any).outline.slides;
              if (original.some((s: any, i: number) => s.id !== `slide-${i + 1}`))
                throw new AppError(422, '構成案のページIDはslide-1から順番に指定してください。', 'INVALID_CONTENT');
              for (const s of result.outline.slides)
                if (s.sourceIds?.some(id => !state.documents.some(d => d.id === id)))
                  throw new AppError(422, '構成案に資料にない出典IDがあります。', 'INVALID_SOURCE');
            }
            state.session.messages = pending.messages ?? state.session.messages;
            if (result.question) {
              state.session.phase = 'clarifying';
              state.session.messages.push({ role: 'assistant', text: result.question });
            } else {
              state.session.outline = result.outline;
              state.session.phase = 'outline';
              state.session.messages.push({
                role: 'assistant',
                text: 'AIの構成案を取り込みました。順番と条件を確認してから作成してください。',
              });
            }
            delete state.chat;
            delete state.session.chatHandoff;
            return state.session;
          }
          if (pending.task === 'generate') {
            const outline = state.session.outline!,
              draft = state.draft!,
              targetIds = pending.targetIds!;
            const value = raw as any;
            if (
              !value ||
              value.mode !== outline.mode ||
              !Array.isArray(value.slides) ||
              value.slides.length !== targetIds.length ||
              value.slides.some((s: any, i: number) => s?.id !== targetIds[i])
            )
              throw new AppError(
                422,
                '返答のページID・順序・枚数・モードが今回の対象と一致しません。',
                'INVALID_CONTENT',
              );
            const slides = value.slides.map((s: unknown, i: number) => validateSlide(s, targetIds[i]));
            if (slides.some((s: SlideSpec) => (s.id === 'slide-1') !== (s.layoutId === 'cover')))
              throw new AppError(422, '表紙と本文の役割を変更できません。', 'INVALID_CONTENT');
            this.engine.pages.verifySources(state, slides);
            const themeId = knownTheme(value.themeId) ? value.themeId : draft.themeId;
            draft.slides.push(...slides);
            if (draft.slides.length === slides.length) draft.themeId = themeId;
            if (draft.slides.length < outline.slides.length) {
              this.prepareChatGeneration(state, outline);
              return state.session;
            }
            let deck = validateDeck(
              {
                id: randomUUID(),
                title: outline.title,
                mode: outline.mode,
                themeId: draft.themeId,
                slides: draft.slides,
              },
              outline,
            );
            this.engine.pages.styleDeck(state, deck, outline);
            deck.typographyId =
              state.settings.typographyId && state.settings.typographyId !== 'auto'
                ? state.settings.typographyId
                : outline.typographyId;
            await this.finishChatDeck(state, improveTextFit(deck), pending);
            return state.session;
          }
          if (pending.task === 'revise') {
            const variant = this.engine.variant(state, pending.variantId),
              old = pending.payload.targetSlide as SlideSpec;
            if ((raw as any)?.id !== old.id)
              throw new AppError(422, '修正するページIDが一致しません。', 'INVALID_CONTENT');
            const slide = validateSlide(raw, old.id);
            if ((slide.layoutId === 'cover') !== (old.layoutId === 'cover'))
              throw new AppError(422, '表紙と本文の役割を変更できません。', 'INVALID_CONTENT');
            this.engine.pages.verifySources(state, [slide]);
            this.engine.revision.verifyRevisionValues(old, slide, pending.instruction!, state);
            await this.finishChatDeck(
              state,
              improveTextFit({ ...variant.deck, slides: variant.deck.slides.map(s => (s.id === old.id ? slide : s)) }),
              pending,
            );
            return state.session;
          }
          const deck = pending.summaryDeck!,
            ids = pending.payload.slides.map((s: any) => s.slideId);
          const fitted = applySummaries(deck, raw, ids);
          if (fitProblems(fitted).some(p => ids.includes(p.slideId)))
            throw new AppError(
              422,
              '要約後も文章が枠に収まりません。指定の文字量へ短くしてください。',
              'TEXT_FIT_REQUIRED',
            );
          await this.finishChatDeck(state, fitted, pending);
          return state.session;
        } catch (error) {
          state.session.warnings = warnings;
          if (pending.task === 'generate' && state.chat === pending && state.draft)
            state.draft.slides.splice(priorDraftCount);
          if (
            !(error instanceof AppError) ||
            (!repairReason(error) && !['CHAT_RESPONSE_REQUIRED', 'CHAT_RESPONSE_TOO_LARGE'].includes(error.code))
          )
            throw error;
          // A reply that is not complete JSON was often cut off by the chat's output
          // limit. Ask for half as many slides; validated slides are kept.
          if (
            pending.task === 'generate' &&
            state.draft &&
            state.session.outline &&
            ['INVALID_MODEL_JSON', 'CHAT_RESPONSE_TOO_LARGE'].includes(error.code) &&
            (pending.targetIds?.length ?? 0) > 1
          ) {
            state.draft.batchSize = Math.max(1, Math.ceil(pending.targetIds!.length / 2));
            this.prepareChatGeneration(
              state,
              state.session.outline,
              [
                `${error.message} 返答が長すぎて途中で切れた可能性があるため、今回の対象を${state.draft.batchSize}枚に減らしました。`,
              ],
              error.code,
            );
            return state.session;
          }
          // Keep old slides, original instructions and validated batches. Never
          // replay raw failed responses as instructions to an external model.
          this.exposeChat(state, [error.message], error.code);
          return state.session;
        }
      },
      false,
    );
  }
  /** Uses the self-contained instruction for the current request, e.g. when the
   * chat could not read the project's catalog file. */
  async useFullInstruction(id: string) {
    return this.engine.lock(
      id,
      async state => {
        this.engine.checkChatMode(state);
        if (!state.chat || !state.session.chatHandoff) throw new AppError(409, '切り替えるAIへの指示がありません。');
        if (state.chat.task === 'design') throw new AppError(409, 'デザインだけの依頼は、常に完全な指示です。');
        state.chat.full = true;
        this.exposeChat(state, state.session.chatHandoff.validationIssues);
        return state.session;
      },
      false,
    );
  }
  /** Outline and every slide returned at once (manual chat, "一度に作る"). The
   * same validation as the batch path applies; nothing is accepted partially. */
  private async acceptOneShot(state: SessionState, pending: ChatDraft, raw: { outline?: unknown; deck?: any }) {
    const outline = validateOutline(raw.outline);
    if (outline.mode !== state.settings.mode)
      throw new AppError(422, '構成案のモードが設定と異なります。', 'INVALID_CONTENT');
    this.engine.pages.checkSlideCount(state, outline);
    for (const s of outline.slides)
      if (s.sourceIds?.some(id => !state.documents.some(d => d.id === id)))
        throw new AppError(422, '構成案に資料にない出典IDがあります。', 'INVALID_SOURCE');
    const value = raw.deck;
    if (
      !value ||
      !Array.isArray(value.slides) ||
      value.slides.length !== outline.slides.length ||
      value.slides.some((s: any, i: number) => s?.id !== outline.slides[i].id)
    )
      throw new AppError(
        422,
        'deckのページID・順序・枚数がoutlineと一致しません。全ページを同じidで返してください。',
        'INVALID_CONTENT',
      );
    const slides = value.slides.map((s: unknown, i: number) => validateSlide(s, outline.slides[i].id));
    if (slides.some((s: SlideSpec) => (s.id === 'slide-1') !== (s.layoutId === 'cover')))
      throw new AppError(422, '表紙と本文の役割が構成と一致しません。', 'INVALID_CONTENT');
    this.engine.pages.verifySources(state, slides);
    let deck = validateDeck(
      {
        id: randomUUID(),
        title: outline.title,
        mode: outline.mode,
        themeId: outline.themeId ?? this.engine.preferredTheme,
        slides,
      },
      outline,
    );
    this.engine.pages.styleDeck(state, deck, outline);
    deck.typographyId =
      state.settings.typographyId && state.settings.typographyId !== 'auto'
        ? state.settings.typographyId
        : outline.typographyId;
    state.session.messages = pending.messages ?? state.session.messages;
    state.session.outline = outline;
    deck = improveTextFit(deck);
    await this.finishChatDeck(state, deck, { ...pending, purpose: 'generate' });
  }
  async finishChatDeck(state: SessionState, deck: DeckSpec, pending: ChatDraft) {
    if (pending.purpose === 'generate' && state.session.outline)
      deck = fillBlanks(deck, factValues(state.session.outline)).deck;
    if (pending.purpose === 'generate' && state.settings.preferredDesignId && state.design)
      deck = applySavedDesign(deck, state.design, false, this.engine.pages.templateTheme(state)).deck;
    const problems = fitProblems(deck).slice(0, READING_BATCH_SIZE);
    if (problems.length) {
      state.chat = { ...pending, task: 'summarize', payload: { slides: problems }, summaryDeck: deck };
      this.exposeChat(state);
      return;
    }
    this.engine.pages.verifySources(state, deck.slides);
    assertTextFits(deck);
    if (pending.purpose === 'revise') {
      const variant = this.engine.variant(state, pending.variantId),
        id = pending.targetIds![0],
        old = variant.deck.slides.find(s => s.id === id)!,
        result = deck.slides.find(s => s.id === id)!;
      const labels: Record<string, string> = {
        title: '見出し',
        headline: '要旨',
        body: '本文',
        items: '項目',
        notes: '発表者ノート',
        sources: '出典',
        chart: 'グラフ',
        table: '表',
        diagram: '図解',
        equation: '数式',
        layoutId: '構図',
      };
      const changes = Object.entries(labels)
        .filter(
          ([key]) => JSON.stringify(old[key as keyof SlideSpec]) !== JSON.stringify(result[key as keyof SlideSpec]),
        )
        .map(([, label]) => label);
      for (const item of state.session.variants) {
        item.deck.slides = item.deck.slides.map(s => (s.id === id ? structuredClone(result) : s));
        delete item.render;
      }
      const entry = state.session.outline?.slides.find(s => s.id === id);
      if (entry) {
        entry.title = result.title;
        entry.layoutId = result.layoutId;
      }
      state.session.messages.push(
        { role: 'user', text: `「${old.title}」の修正: ${pending.instruction}` },
        {
          role: 'assistant',
          text: `AIの返答を検証し、${changes.length ? changes.join('・') : '内容（変更なし）'}を反映しました。外部APIの呼び出しはありません。`,
        },
      );
    } else if (pending.purpose === 'alternate') {
      deck = diversifyDeck(deck, state.session.id, this.engine.recentLayouts);
      assertTextFits(deck);
      const ai = chatServiceName(pending.service ?? 'other');
      state.session.variants.push({ id: randomUUID(), label: ai, deck, origin: { kind: 'ai', ai } });
      state.session.messages.push({
        role: 'assistant',
        text: `${ai}の案を追加しました。同じページを並べて比べ、ページごとに内容とデザインを組み合わせられます。`,
      });
    } else {
      deck = diversifyDeck(deck, state.session.id, this.engine.recentLayouts);
      if (state.settings.preferredDesignId && state.design)
        deck = applySavedDesign(deck, state.design, true, this.engine.pages.templateTheme(state)).deck;
      assertTextFits(deck);
      const ai = chatServiceName(
        state.chat?.service ??
          this.engine.options.settings.get().chatService ??
          state.settings.chatService ??
          'chatgpt',
      );
      state.session.variants = [{ id: randomUUID(), label: ai, deck, origin: { kind: 'ai', ai } }];
      await this.engine.rememberLayouts(deck, state.session);
      // No look at drawn pages here: what the app finds itself (notes to the maker, the same kind of page three in a row) is shown as hints.
      const findings = deckFindings(deck.slides);
      if (findings.length) state.session.reviewHints = findings.map(f => ({ ...f, severity: 'medium' as const }));
      else delete state.session.reviewHints;
      state.session.messages.push({
        role: 'assistant',
        text: `AIの返答から${deck.slides.length}枚を作成しました。検証済みのページを再利用し、外部APIは呼び出していません。`,
      });
    }
    state.session.phase = 'ready';
    delete state.chat;
    delete state.session.chatHandoff;
    delete state.draft;
    delete state.revision;
    delete state.session.recovery;
    await this.engine.persist(state);
  }
}
