import { randomUUID } from 'node:crypto';
import { appendFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  FREE_CHAT_BATCH_SIZE,
  FREE_GENERATION_BATCH_SIZE,
  GENERATION_OUTPUT_TOKENS,
  type ChatService,
  type SendRecord,
  type DeckSpec,
  type SlideSpec,
  type Usage,
} from '../../shared/contracts.js';
import { AppError } from '../errors.js';
import { createProvider, OutputLimitError, parseJsonResponse } from '../providers.js';
import { validateDeck } from '../validation.js';
import { repairReason } from '../repair-policy.js';
import { assertTextFits } from '../text-fit.js';
import { slideContent } from '../../shared/slots.js';
import {
  designRequest,
  leakCheck,
  phraseLeak,
  sha256,
  type DesignPacket,
  type ShareLevel,
} from '../../shared/confidential.js';
import { designOnlyPrompt } from '../free-prompts.js';
import { prepareChatHandoff, parseChatResponse } from '../chat-handoff.js';
import type { SessionEngine } from '../engine.js';
import type { ChatDraft, AiRun, SessionState } from './session-state.js';
import { MAX_VARIANTS } from './session-state.js';
import { chatServiceName, fillDesign } from './helpers.js';

/** Asking a cloud AI for the design only: the content stays on this PC, and what is sent is recorded. */
export class DesignRequestService {
  constructor(private readonly engine: SessionEngine) {}

  /** Asks a chat AI for a design only. The AI receives the places of each slide
   * (role, length, dummy sample), chart and table shapes and colour names; the
   * wording, numbers, documents, conversation and project notes stay on this PC.
   * Works for decks made by any provider, including a local LLM. */
  async requestDesign(
    id: string,
    input: { variantId?: unknown; service?: unknown; level?: unknown; topic?: unknown; direct?: unknown },
  ) {
    return this.engine.lock(
      id,
      async state => {
        if (state.session.phase !== 'ready' || !state.session.variants.length)
          throw new AppError(409, '先にスライドを作成してください。');
        if (state.session.chatHandoff)
          throw new AppError(409, '進行中のAIとの受け渡しを終えるか取り消してから依頼してください。');
        if (state.session.variants.length >= MAX_VARIANTS)
          throw new AppError(409, `比較できる案は${MAX_VARIANTS}つまでです。不要な案を削除してから依頼してください。`);
        const variant = this.engine.variant(state, input.variantId),
          service = input.service;
        if (typeof service !== 'string' || !['chatgpt', 'claude', 'gemini', 'copilot', 'other'].includes(service))
          throw new AppError(400, 'デザインを頼むAIを一覧から選んでください。');
        if (input.level !== 'structure' && input.level !== 'topic')
          throw new AppError(400, '送る範囲を選んでください。');
        let topic: string | undefined;
        if (input.level === 'topic') {
          if (
            typeof input.topic !== 'string' ||
            !input.topic.trim() ||
            input.topic.length > 40 ||
            /[\r\n]/.test(input.topic)
          )
            throw new AppError(400, '送ってよい話題名を40文字以内で入力してください（例：四半期の業績報告）。');
          topic = input.topic.trim();
        }
        if (input.direct === true) {
          // Sent straight to the connected account: retries and text fitting happen here, with no copying.
          if (service !== 'chatgpt' && service !== 'claude')
            throw new AppError(400, '直接送れるのは、設定で接続したClaudeかChatGPTです。');
          const binding = this.engine.options.subscriptionBinding?.(service);
          if (!binding)
            throw new AppError(
              409,
              `設定から${chatServiceName(service)}のアカウントに接続してください。`,
              'SUBSCRIPTION_CONNECTION_REQUIRED',
            );
          state.bindings = { ...state.bindings, [service]: binding };
          const run = this.engine.ai.newRun(state, service),
            designed = await this.designPages(state, variant.deck, input.level, topic, run);
          state.session.variants.push({
            id: randomUUID(),
            label: `デザイン：${run.label}`,
            deck: designed,
            origin: {
              kind: 'ai',
              ai: run.label,
              parents: [variant.id],
              notes: [
                `${run.label}には内容を送らず、${input.level === 'topic' ? `許可した話題名「${topic}」と` : ''}文字の枠の役割・文字数・グラフと表の形だけを渡しました。`,
                ...run.notes.map(n => `自動で対処：${n}`),
              ],
            },
          });
          state.session.messages.push({
            role: 'assistant',
            text: `${run.label}のデザインに、このPCで内容を入れた案を追加しました。内容・数値・資料は送信していません（AIの呼び出し${run.calls}回）。`,
          });
          await this.engine.persist(state);
          return state.session;
        }
        const ids = variant.deck.slides.map(s => s.id),
          { contents } = designRequest(variant.deck, ids, input.level, topic);
        state.chat = {
          task: 'design',
          purpose: 'design',
          service: service as ChatService,
          payload: {},
          design: {
            variantId: variant.id,
            level: input.level,
            topic,
            ids,
            done: [],
            contents,
            base: JSON.stringify(variant.deck),
          },
        };
        await this.exposeDesign(state);
        return state.session;
      },
      false,
    );
  }
  /** Everything the user typed, uploaded or received for this deck. Nothing of it may
   * appear in a design-only request. */
  private protectedTexts(state: SessionState, deck: DeckSpec) {
    return [
      ...state.documents.flatMap(d => [d.name, ...d.sources.map(u => u.text)]),
      ...state.session.messages.map(m => m.text),
      state.project.audience,
      state.project.guidance,
      state.project.name,
      deck.title,
      ...deck.slides.flatMap(s => [
        s.title,
        s.notes,
        ...slideContent(s).texts.map(t => t.text),
        ...slideContent(s).charts.flatMap(c => [
          ...c.categories,
          ...c.series.map(x => x.name),
          c.caption ?? '',
          c.unit ?? '',
          ...c.series.flatMap(x => x.values.map(String)),
        ]),
        ...slideContent(s).tables.flatMap(t => [...t.headers, ...t.rows.flat()]),
        ...s.sources.map(x => x.quote ?? ''),
      ]),
    ].filter(Boolean);
  }
  private async exposeDesign(state: SessionState, issues?: string[]) {
    const pending = state.chat!,
      draft = pending.design!,
      variant = this.engine.variant(state, draft.variantId);
    const remaining = draft.ids.filter(id => !draft.done.some(s => s.id === id)),
      batch = remaining.slice(0, FREE_CHAT_BATCH_SIZE);
    const { packet } = designRequest(variant.deck, batch, draft.level, draft.topic);
    // The packet is built only from roles, lengths and dummy samples; this check proves
    // it holds none of the protected wording or numbers before anything is shown.
    const protectedTexts = this.protectedTexts(state, variant.deck),
      check = leakCheck(packet, protectedTexts, draft.topic ? [draft.topic] : []);
    if (check.hits.length)
      throw new AppError(
        422,
        `送信内容に資料・本文と同じ文字（${check.hits.length}件）が見つかったため、指示の作成を止めました。`,
        'DESIGN_LEAK_BLOCKED',
      );
    // Correction notes are sent too; if one ever names real wording, a generic note replaces it.
    if (
      issues?.length &&
      phraseLeak(issues, [
        ...protectedTexts.filter(t => !state.session.messages.some(m => m.role === 'assistant' && m.text === t)),
      ])
    )
      issues = [
        '前の返答に不備がありました。すべてのslotを1回ずつ、文字数が収まる大きさで、枠が重ならないように配置してください。',
      ];
    pending.payload = packet;
    const handoff = prepareChatHandoff({
      task: 'design',
      service: pending.service ?? 'chatgpt',
      system: designOnlyPrompt(draft.level),
      content: { request: packet },
      validationIssues: issues,
      completedSlides: draft.done.length,
      totalSlides: draft.ids.length,
    });
    const hash = sha256(handoff.instruction);
    state.session.chatHandoff = {
      ...handoff,
      privacy: {
        level: draft.level,
        ...(draft.topic ? { topic: draft.topic } : {}),
        checkedCharacters: check.checkedCharacters,
        hits: 0,
        sha256: hash,
        characters: handoff.instruction.length,
      },
    };
    const record: SendRecord = {
      at: new Date().toISOString(),
      task: 'design',
      service: pending.service ?? 'chatgpt',
      level: draft.level,
      ...(draft.topic ? { topic: draft.topic } : {}),
      slides: batch.length,
      characters: handoff.instruction.length,
      checkedCharacters: check.checkedCharacters,
      hits: 0,
      sha256: hash,
    };
    await appendFile(
      path.join(this.engine.options.dataDir, 'send-log.jsonl'),
      JSON.stringify(record) + '\n',
      'utf8',
    ).catch(() => {});
  }
  async designResponse(state: SessionState, pending: ChatDraft, input: { requestId?: unknown; response?: unknown }) {
    const draft = pending.design!;
    if (
      !state.session.chatHandoff ||
      typeof input.requestId !== 'string' ||
      input.requestId !== state.session.chatHandoff.requestId
    )
      throw new AppError(
        409,
        '古い指示への返答です。現在表示されている指示と返答を使用してください。',
        'STALE_CHAT_RESPONSE',
      );
    const variant = this.engine.variant(state, draft.variantId);
    if (JSON.stringify(variant.deck) !== draft.base)
      throw new AppError(409, '元の案が変更されました。デザインの依頼をやり直してください。', 'STALE_CHAT_RESPONSE');
    try {
      const raw = parseChatResponse(input.response),
        packet = pending.payload as DesignPacket;
      draft.done.push(...fillDesign(raw, packet, draft.contents, variant.deck));
      if (draft.done.length < draft.ids.length) {
        await this.exposeDesign(state);
        return state.session;
      }
      const deck = validateDeck({
        ...structuredClone(variant.deck),
        id: randomUUID(),
        slides: draft.ids.map(id => draft.done.find(s => s.id === id)!),
      });
      if (variant.deck.customTheme) deck.customTheme = structuredClone(variant.deck.customTheme);
      if (variant.deck.typographyId) deck.typographyId = variant.deck.typographyId;
      this.engine.pages.verifySources(state, deck.slides);
      assertTextFits(deck);
      const ai = chatServiceName(pending.service ?? 'other');
      state.session.variants.push({
        id: randomUUID(),
        label: `デザイン：${ai}`,
        deck,
        origin: {
          kind: 'ai',
          ai,
          parents: [variant.id],
          notes: [
            `${ai}には内容を送らず、${draft.level === 'topic' ? `許可した話題名「${draft.topic}」と` : ''}文字の枠の役割・文字数・グラフと表の形だけを渡しました。`,
          ],
        },
      });
      state.session.messages.push({
        role: 'assistant',
        text: `${ai}のデザインに、このPCで内容を入れた案を追加しました。内容・数値・資料は送信していません。`,
      });
      delete state.chat;
      delete state.session.chatHandoff;
      state.session.phase = 'ready';
      await this.engine.persist(state);
      return state.session;
    } catch (error) {
      if (
        !(error instanceof AppError) ||
        (!repairReason(error) &&
          !['CHAT_RESPONSE_REQUIRED', 'CHAT_RESPONSE_TOO_LARGE', 'TEXT_FIT_REQUIRED'].includes(error.code))
      )
        throw error;
      // The correction is built from slot names and dummy text only.
      await this.exposeDesign(state, [error.message]);
      return state.session;
    }
  }
  /** A design-only request sent directly to a connected AI, batch by batch. Only the
   * skeleton is sent (roles, lengths, dummy samples, chart and table shapes), each request
   * is checked against everything the user provided first, the reply is checked on the
   * dummy text, filled with the real content here, and slightly long text is set smaller
   * locally. Problems are retried with notes that name slots only. */
  async designPages(
    state: SessionState,
    deck: DeckSpec,
    level: ShareLevel,
    topic: string | undefined,
    run: AiRun,
  ): Promise<DeckSpec> {
    const ids = deck.slides.map(s => s.id),
      { contents } = designRequest(deck, ids, level, topic),
      protectedTexts = this.protectedTexts(state, deck),
      done: SlideSpec[] = [];
    let issues: string[] | undefined,
      batchSize = FREE_GENERATION_BATCH_SIZE;
    while (done.length < ids.length) {
      const batch = ids.filter(id => !done.some(s => s.id === id)).slice(0, batchSize),
        { packet } = designRequest(deck, batch, level, topic);
      const check = leakCheck(packet, protectedTexts, topic ? [topic] : []);
      if (check.hits.length)
        throw new AppError(
          422,
          `送信内容に資料・本文と同じ文字（${check.hits.length}件）が見つかったため、送信を止めました。`,
          'DESIGN_LEAK_BLOCKED',
        );
      // The app's own messages in the conversation are not the user's content.
      if (
        issues?.length &&
        phraseLeak(
          issues,
          protectedTexts.filter(t => !state.session.messages.some(m => m.role === 'assistant' && m.text === t)),
        )
      )
        issues = [
          '前の返答に不備がありました。すべてのslotを1回ずつ、文字数が収まる大きさで、枠が重ならないように配置してください。',
        ];
      const system = designOnlyPrompt(level),
        content = JSON.stringify({ request: packet, ...(issues?.length ? { issues } : {}) });
      await this.recordSend(
        {
          task: 'design',
          service: run.target,
          level,
          ...(topic ? { topic } : {}),
          slides: batch.length,
          checkedCharacters: check.checkedCharacters,
        },
        system + content,
      );
      try {
        const raw = await this.callDirect(
          state,
          run,
          system,
          content,
          Math.min(GENERATION_OUTPUT_TOKENS, 3000 + batch.length * 3500),
        );
        done.push(...fillDesign(raw, packet, contents, deck));
        issues = undefined;
        if (batchSize < FREE_GENERATION_BATCH_SIZE) batchSize++;
      } catch (error) {
        const reason = repairReason(error);
        if (
          !(error instanceof AppError) ||
          !reason ||
          run.repair.remaining <= 0 ||
          run.calls >= 12 ||
          this.engine.options.settings.get().autoRepair === false
        )
          throw error;
        run.repair.remaining--;
        run.notes.push(reason.reason);
        const broken = error instanceof OutputLimitError || error.code === 'INVALID_MODEL_JSON';
        issues = [
          broken
            ? '前の返答がJSONとして読めませんでした。説明を付けず、最後まで閉じたJSONだけを返してください。'
            : error.message,
        ];
        if (broken) batchSize = Math.max(1, Math.floor(batch.length / 2));
      }
    }
    const result = validateDeck({
      ...structuredClone(deck),
      id: randomUUID(),
      slides: ids.map(id => done.find(s => s.id === id)!),
    });
    if (deck.customTheme) result.customTheme = structuredClone(deck.customTheme);
    if (deck.typographyId) result.typographyId = deck.typographyId;
    this.engine.pages.verifySources(state, result.slides);
    assertTextFits(result);
    return result;
  }
  /** Exactly the given instruction and input, to one AI (no documents or conversation are added). */
  private async callDirect(state: SessionState, run: AiRun, system: string, content: string, maxTokens: number) {
    const settings = this.engine.ai.targetSettings(state, run.target);
    this.engine.ai.checkDestination(state, settings, true);
    if (run.calls >= 12) throw new AppError(429, '1つの作業につきLLM呼び出しは12回までです。', 'CALL_LIMIT');
    const provider = (this.engine.options.providerFactory ?? createProvider)(
      settings,
      this.engine.options.settings.secret(settings.provider),
    );
    state.session.usage.calls++;
    run.calls++;
    try {
      const response = await provider.complete({ system, content, maxTokens });
      this.engine.ai.addUsage(state.session.usage, response.usage);
      return parseJsonResponse(response.text);
    } catch (error) {
      if (error && typeof error === 'object' && 'usage' in error)
        this.engine.ai.addUsage(state.session.usage, error.usage as Usage);
      if (error instanceof OutputLimitError) {
        try {
          return parseJsonResponse(error.partialText);
        } catch {
          /* Keep the output-limit error. */
        }
      }
      throw error;
    }
  }
  /** One send-log line: what was sent, how it was checked, and a fingerprint of the exact text. */
  private async recordSend(record: Omit<SendRecord, 'at' | 'characters' | 'hits' | 'sha256'>, instruction: string) {
    const line: SendRecord = {
      at: new Date().toISOString(),
      ...record,
      characters: instruction.length,
      hits: 0,
      sha256: sha256(instruction),
    };
    await appendFile(
      path.join(this.engine.options.dataDir, 'send-log.jsonl'),
      JSON.stringify(line) + '\n',
      'utf8',
    ).catch(() => {});
  }
  async sendLog(): Promise<{ records: SendRecord[] }> {
    const text = await readFile(path.join(this.engine.options.dataDir, 'send-log.jsonl'), 'utf8').catch(() => '');
    return {
      records: text
        .split('\n')
        .filter(Boolean)
        .slice(-50)
        .flatMap(line => {
          try {
            return [JSON.parse(line) as SendRecord];
          } catch {
            return [];
          }
        })
        .reverse(),
    };
  }
}
