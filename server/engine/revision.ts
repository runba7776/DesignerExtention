import { READING_BATCH_SIZE, MAX_PROMPT_CHARACTERS, type DeckSpec, type SlideSpec } from '../../shared/contracts.js';
import { AppError, requireText } from '../errors.js';
import { validateSlide } from '../validation.js';
import { DEMO_WARNING } from '../demo.js';
import { repairReason } from '../repair-policy.js';
import { improveTextFit } from '../../shared/layout-selection.js';
import { designTexts } from '../../shared/free-design.js';
import type { SessionEngine } from '../engine.js';
import type { RevisionDraft, ChatDraft, SessionState } from './session-state.js';
import { SESSION_CALL_LIMIT } from './session-state.js';

/** Changing one page on the user's instruction, with its numbers checked against the sources. */
export class RevisionService {
  constructor(private readonly engine: SessionEngine) {}

  async revise(id: string, input: { slideId?: unknown; instruction?: unknown; variantId?: unknown }) {
    return this.engine.lock(id, state => this.performRevision(state, input), true, true);
  }
  async retryRevision(id: string) {
    return this.engine.lock(
      id,
      async state => {
        const pending = state.revision;
        if (!pending || state.session.recovery?.task !== 'revise')
          throw new AppError(409, '再開する修正指示がありません。');
        if (!state.session.recovery.retryAvailable)
          throw new AppError(
            429,
            'この修正の再試行を止めました。優先する条件を整理して再送してください。追加の呼び出しは行っていません。',
          );
        return this.performRevision(
          state,
          { slideId: pending.slideId, variantId: pending.variantId, instruction: pending.instruction },
          true,
        );
      },
      true,
      true,
    );
  }
  async performRevision(
    state: SessionState,
    input: { slideId?: unknown; instruction?: unknown; variantId?: unknown },
    resume = false,
    force = false,
  ) {
    if (state.session.phase !== 'ready') throw new AppError(409, 'スライドを作成してから修正してください。');
    const variant = this.engine.variant(state, input.variantId);
    const slide = variant.deck.slides.find(slide => slide.id === input.slideId);
    if (!slide) throw new AppError(404, '修正するスライドが見つかりません。');
    const instruction = requireText(input.instruction, '修正指示', MAX_PROMPT_CHARACTERS);
    this.engine.ai.checkConversation([...state.session.messages, { role: 'user', text: instruction }]);
    if (state.settings.provider === 'chat') {
      this.engine.checkChatMode(state);
      const pending: ChatDraft = {
        task: 'revise',
        payload: { outline: state.session.outline, targetSlide: slide, instruction },
        purpose: 'revise',
        variantBase: JSON.stringify(variant.deck),
        variantId: variant.id,
        instruction,
        targetIds: [slide.id],
      };
      state.chat = pending;
      this.engine.chat.exposeChat(state);
      return state.session;
    }
    const base = JSON.stringify(variant.deck);
    let pending = state.revision;
    if (resume && pending?.base !== base)
      throw new AppError(409, '修正対象の資料が変更されました。現在のスライドへ指示を送り直してください。');
    if (
      !pending ||
      pending.base !== base ||
      pending.slideId !== slide.id ||
      pending.variantId !== variant.id ||
      pending.instruction !== instruction
    ) {
      pending = {
        base,
        variantId: variant.id,
        slideId: slide.id,
        instruction,
        title: slide.title,
        failures: 0,
        compact: false,
      };
      state.revision = pending;
    }
    if (pending.failures >= 3 && !force)
      throw new AppError(429, '同じ修正の不備が繰り返されました。優先する条件を整理して再送してください。');
    while (!pending.result) {
      const warnings = [...state.session.warnings];
      try {
        const raw =
          state.settings.provider === 'demo'
            ? { ...slide, headline: instruction.slice(0, 120), notes: `${DEMO_WARNING}\n修正指示: ${instruction}` }
            : await this.engine.ai.complete(
                state,
                'revise',
                {
                  outline: state.session.outline,
                  targetSlide: slide,
                  instruction,
                  compactOutput: pending.compact,
                  compressionLevel: pending.failures,
                },
                pending.compact ? 16_000 : 8_000,
              );
        if ((raw as any)?.id !== slide.id)
          throw new AppError(422, '修正されたページの識別子が一致しません。', 'INVALID_CONTENT');
        const result = validateSlide(raw, slide.id);
        if ((slide.layoutId === 'cover') !== (result.layoutId === 'cover'))
          throw new AppError(422, '表紙と本文の役割は変更できません。', 'INVALID_CONTENT');
        this.engine.pages.verifySources(state, [result]);
        pending.result = result;
      } catch (error) {
        state.session.warnings = warnings;
        if (!repairReason(error) && !(error instanceof AppError && error.code === 'CALL_LIMIT')) throw error;
        pending.failures++;
        pending.compact = true;
        if (
          pending.failures < 3 &&
          this.engine.ai.tryRepair(
            state,
            'revise',
            error,
            `修正対象の1枚だけを、回答枠16,000トークンで再試行。ノートは通常${pending.failures >= 2 ? 200 : 400}文字を目安に重複を減らし、必須条件・図表・ページ番号・出典を再確認します。`,
          )
        )
          continue;
        return this.revisionRecovery(state, pending, 'content');
      }
    }
    if (!pending.fit)
      pending.fit = {
        deck: improveTextFit({
          ...variant.deck,
          slides: variant.deck.slides.map(s => (s.id === slide.id ? pending.result! : s)),
        }),
        batchSize: READING_BATCH_SIZE,
        singleFailures: 0,
      };
    if (force) pending.fit.force = true;
    let fitted: DeckSpec;
    try {
      fitted = await this.engine.generation.fitText(state, pending.fit.deck, pending.fit);
    } catch (error) {
      if (!repairReason(error) && !(error instanceof AppError && error.code === 'CALL_LIMIT')) throw error;
      pending.failures++;
      return this.revisionRecovery(state, pending, 'text-fit');
    }
    const result = fitted.slides.find(s => s.id === slide.id)!;
    const changes = Object.entries({
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
    })
      .filter(
        ([key]) => JSON.stringify(slide[key as keyof SlideSpec]) !== JSON.stringify(result[key as keyof SlideSpec]),
      )
      .map(([, label]) => label);
    if (state.session.repairReport) state.session.repairReport.changes = changes;
    // Variants compare the same content; a content edit invalidates all exports and updates both.
    for (const item of state.session.variants) {
      item.deck.slides = item.deck.slides.map(old => (old.id === slide.id ? structuredClone(result) : old));
      delete item.render;
    }
    if (state.session.outline) {
      const entry = state.session.outline.slides.find(entry => entry.id === slide.id);
      if (entry) {
        entry.title = result.title;
        entry.layoutId = result.layoutId;
      }
    }
    state.session.messages.push(
      { role: 'user', text: `「${slide.title}」の修正: ${instruction}` },
      {
        role: 'assistant',
        text: `指定したスライドの${changes.length ? changes.join('・') : '内容（変更なし）'}を確認し、比較案にも同じ内容を反映しました。`,
      },
    );
    delete state.revision;
    delete state.session.recovery;
    return state.session;
  }
  private revisionRecovery(state: SessionState, pending: RevisionDraft, stage: 'content' | 'text-fit') {
    state.session.recovery = {
      task: 'revise',
      stage,
      slideId: pending.slideId,
      retryAvailable:
        pending.failures < 3 &&
        (pending.fit?.singleFailures ?? 0) < 2 &&
        state.session.usage.calls < SESSION_CALL_LIMIT,
      message:
        stage === 'text-fit'
          ? '修正する本文は保持していますが、文字量の調整を完了できませんでした。修正前のスライドを保持しています。保存した指示から調整だけを再開できます。'
          : '修正指示を保持しています。検証が通る修正を作れなかったため、修正前のスライドはそのままです。優先条件を整理して再送することもできます。',
    };
    return state.session;
  }

  verifyRevisionValues(old: SlideSpec, revised: SlideSpec, instruction: string, state: SessionState) {
    // Compare exact decimal values without rounding or unit conversion. A
    // percentage label may back a numeric chart value only with its original
    // unit retained by the author; this check does not prove unit semantics.
    const canonical = (token: string) => {
      const normalized = token
        .normalize('NFKC')
        .replace(/,/g, '')
        .replace(/[−△]/g, '-')
        .replace(/^\+/, '')
        .replace(/%$/, '');
      const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(normalized);
      if (!match) return normalized;
      const exponent = Number(match[4] ?? 0);
      if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 1000) return normalized;
      const digits = match[2] + (match[3] ?? ''),
        point = match[2].length + exponent;
      const expanded =
        point <= 0
          ? '0.' + '0'.repeat(-point) + digits
          : point >= digits.length
            ? digits + '0'.repeat(point - digits.length)
            : digits.slice(0, point) + '.' + digits.slice(point);
      const [integer, fraction = ''] = expanded.split('.'),
        whole = integer.replace(/^0+(?=\d)/, ''),
        tail = fraction.replace(/0+$/, '');
      const value = whole + (tail ? '.' + tail : '');
      return (match[1] && value !== '0' ? '-' : '') + value;
    };
    const numbers = (text: string) =>
      Array.from(
        text.normalize('NFKC').match(/[+−△-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:[eE][+−-]?\d+)?%?/g) ?? [],
      ).map(canonical);
    const existingText = [
      old.title,
      old.headline,
      old.body,
      old.notes,
      ...old.items.flatMap(i => [i.label, i.description, i.value]),
      ...(old.diagram?.items.flatMap(i => [i.label, i.description, i.value]) ?? []),
      ...(old.table?.headers ?? []),
      ...(old.table?.rows.flat() ?? []),
      old.chart?.caption,
      old.chart?.unit,
      old.equation?.text,
      old.equation?.explanation,
      ...designTexts(old),
    ]
      .filter((v): v is string => typeof v === 'string')
      .join(' ');
    const chartsOf = (slide: SlideSpec) =>
      [slide.chart, ...(slide.design?.elements.flatMap(e => (e.t === 'chart' ? [e.chart] : [])) ?? [])].filter(
        (c): c is NonNullable<SlideSpec['chart']> => !!c,
      );
    const allowed = new Set([
      ...numbers(instruction + ' ' + existingText),
      ...chartsOf(old).flatMap(c => c.series.flatMap(s => s.values.map(v => canonical(String(v))))),
    ]);
    for (const source of revised.sources) {
      const document = state.documents.find(d => d.id === source.documentId);
      const unit = document?.sources.find(u => u.locator === source.locator);
      for (const value of numbers(unit?.text ?? '')) allowed.add(value);
    }
    const newValues = [
      ...chartsOf(revised).flatMap(c => c.series.flatMap(s => s.values.map(v => canonical(String(v))))),
      ...revised.items.flatMap(i => numbers(i.value ?? '')),
      ...(revised.design?.elements.flatMap(e => (e.t === 'text' && e.role === 'number' ? numbers(e.text) : [])) ?? []),
    ];
    if (newValues.some(v => !allowed.has(v)))
      throw new AppError(
        422,
        '修正で根拠のない数値が追加されました。元の数値、指示で指定した数値、または実在する出典の数値を使用してください。',
        'INVALID_CONTENT',
      );
  }
}
