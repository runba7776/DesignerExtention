import { randomUUID } from 'node:crypto';
import {
  FREE_GENERATION_BATCH_SIZE,
  GENERATION_BATCH_SIZE,
  READING_BATCH_SIZE,
  GENERATION_OUTPUT_TOKENS,
  type DeckSpec,
  type DeckVariant,
  type Outline,
  type SlideSpec,
  type SubscriptionService,
} from '../../shared/contracts.js';
import { AppError } from '../errors.js';
import { OutputLimitError } from '../providers.js';
import { validateDeck, validateOutline, validateSlide } from '../validation.js';
import { demoDeck } from '../demo.js';
import { completeSlidePrefix } from '../partial-generation.js';
import { repairReason } from '../repair-policy.js';
import { fitProblems, applySummaries, assertTextFits } from '../text-fit.js';
import { diversifyDeck, improveTextFit } from '../../shared/layout-selection.js';
import { applySavedDesign } from '../design-application.js';
import { deckBlanks, fillBlanks } from '../../shared/blanks.js';
import type { SessionEngine } from '../engine.js';
import type { FitDraft, GenerationDraft, AiRun, SessionState } from './session-state.js';
import { MAX_VARIANTS, SESSION_CALL_LIMIT } from './session-state.js';
import { sameContent, knownTheme, continued, factValues, plainOutline, deckFindings } from './helpers.js';

/** Writing the pages of an agreed outline, fitting their text, and filling blanks the user answers. */
export class GenerationService {
  constructor(private readonly engine: SessionEngine) {}

  async generate(id: string, inputOutline?: unknown, force = false, facts?: unknown) {
    return this.engine.lock(
      id,
      async state => {
        let outline = inputOutline ? validateOutline(inputOutline) : state.session.outline;
        if (!outline || state.session.phase === 'clarifying') throw new AppError(409, '先に構成案を確認してください。');
        if (facts !== undefined) outline = this.withFacts(outline, facts);
        if (outline.mode !== state.settings.mode)
          throw new AppError(422, '構成案のモードが作成時の設定と異なります。新しく作成してください。');
        this.engine.pages.checkSlideCount(state, outline);
        if (state.session.recovery?.task === 'generate' && !state.session.recovery.retryAvailable && !force)
          throw new AppError(
            429,
            '再開の上限に達しました。追加の呼び出しは行っていません。構成から情報を分けるか、優先条件を整理してください。',
          );
        state.session.outline = outline;
        if (state.showcase) return this.engine.sample.replayDeck(state, outline);
        if (state.settings.provider === 'chat') {
          this.engine.chat.prepareChatGeneration(state, outline);
          return state.session;
        }
        let value: unknown,
          extras: Promise<void> = Promise.resolve();
        if (state.settings.provider === 'demo') value = demoDeck(outline);
        else {
          const key = JSON.stringify({ outline, messages: state.session.messages, settings: state.settings });
          if (state.draft?.key !== key) {
            state.draft = {
              key,
              slides: [],
              themeId: outline.themeId ?? this.engine.preferredTheme,
              batchSize: this.baseBatch(state, outline),
              singleFailures: 0,
              compact: false,
            };
            delete state.session.reviewHints;
            delete state.session.reviewReport;
            delete state.session.polish;
            delete state.polish;
            // The sample pages of the picked direction are already made: they join the deck in their places.
            // They were made before the user answered the open facts, so their blanks are filled with the answers.
            const seed = state.previewSeeds?.find(s => s.outline === plainOutline(outline!));
            if (seed) {
              const slides = fillBlanks(
                {
                  id: 'seed',
                  title: outline.title,
                  mode: outline.mode,
                  themeId: '',
                  slides: seed.slides.map(s => structuredClone(s)),
                },
                factValues(outline),
              ).deck.slides;
              state.draft.pending = Object.fromEntries(slides.map(s => [s.id, s]));
              state.draft.shots = { ...seed.shots };
            }
          }
          const draft = state.draft;
          // Other AIs chosen at creation write their drafts of the same outline at the same time.
          extras = this.startExtras(state, outline);
          const stopped = await this.writePages(state, outline, draft);
          if (stopped) {
            await extras;
            return this.generationRecovery(state, outline, 'content', stopped.canRetry);
          }
          value = {
            id: 'draft',
            title: outline.title,
            mode: outline.mode,
            themeId: draft.themeId,
            slides: draft.slides,
          };
        }
        let deck = validateDeck(value, outline);
        if (deck.mode !== outline.mode) throw new AppError(422, '生成された資料のモードが構成案と異なります。');
        deck.title = outline.title;
        deck.id = randomUUID();
        this.engine.pages.verifySources(state, deck.slides);
        this.engine.pages.styleDeck(state, deck, outline);
        // Blanks the AI still wrote for facts the user gave are filled with them.
        deck = fillBlanks(deck, factValues(outline)).deck;
        const typography = state.settings.typographyId;
        deck.typographyId =
          typography && typography !== 'auto' ? typography : (outline.typographyId ?? deck.typographyId);
        if (state.settings.preferredDesignId && state.design)
          deck = applySavedDesign(deck, state.design, false, this.engine.pages.templateTheme(state)).deck;
        const draft = state.draft;
        if (draft && !draft.fit)
          draft.fit = { deck: improveTextFit(deck), batchSize: READING_BATCH_SIZE, singleFailures: 0 };
        if (force && draft?.fit) draft.fit.force = true;
        try {
          deck = await this.fitText(state, draft?.fit?.deck ?? improveTextFit(deck), draft?.fit);
        } catch (error) {
          if (!draft?.fit || (!repairReason(error) && !(error instanceof AppError && error.code === 'CALL_LIMIT')))
            throw error;
          await extras;
          return this.generationRecovery(
            state,
            outline,
            'text-fit',
            error instanceof AppError && error.code === 'CALL_LIMIT'
              ? state.session.usage.calls < SESSION_CALL_LIMIT
              : !!repairReason(error) && draft.fit.singleFailures < 2,
          );
        }
        deck = diversifyDeck(deck, state.session.id, this.engine.recentLayouts);
        if (state.settings.preferredDesignId && state.design)
          deck = applySavedDesign(deck, state.design, true, this.engine.pages.templateTheme(state)).deck;
        assertTextFits(deck);
        state.session.outline = outline;
        const ai =
          state.settings.provider === 'local'
            ? 'ローカルLLM'
            : state.settings.provider === 'demo'
              ? 'サンプル'
              : state.settings.provider === 'subscription'
                ? state.settings.subscriptionService === 'claude'
                  ? 'Claude'
                  : 'ChatGPT'
                : 'AI';
        const main: DeckVariant = {
          id: randomUUID(),
          label: state.sendScope === 'design' ? '内容（ローカルLLM）' : ai,
          deck,
          origin: { kind: 'ai', ai },
        };
        state.session.variants = [main];
        await extras;
        for (const variant of state.extras?.ready ?? [])
          if (state.session.variants.length < MAX_VARIANTS) state.session.variants.push(variant);
        for (const failure of state.extras?.failed ?? []) state.session.warnings.push(failure);
        // Content written on this PC; each chosen cloud AI receives only the skeleton for its design.
        if (state.sendScope === 'design')
          await Promise.all(
            (state.targets ?? [])
              .filter((t): t is SubscriptionService => t !== 'local')
              .map(async target => {
                const run = this.engine.ai.newRun(state, target);
                try {
                  const designed = await this.engine.designRequests.designPages(
                    state,
                    main.deck,
                    'structure',
                    undefined,
                    run,
                  );
                  state.session.variants.push({
                    id: randomUUID(),
                    label: `デザイン：${run.label}`,
                    deck: designed,
                    origin: {
                      kind: 'ai',
                      ai: run.label,
                      parents: [main.id],
                      notes: [`${run.label}には内容を送らず、文字の枠の役割・文字数・グラフと表の形だけを渡しました。`],
                    },
                  });
                } catch (error) {
                  state.session.warnings.push(
                    `${run.label}のデザインは作成できませんでした（${error instanceof AppError ? error.message : '接続または応答の不備'}）。内容の案はこのPCで作成済みです。`,
                  );
                }
              }),
          );
        state.session.phase = 'ready';
        // The drawn pages are looked at after the deck is shown (polish), so the user can read it meanwhile.
        const shots = state.draft?.shots,
          findings = deckFindings(main.deck.slides);
        if (shots && Object.keys(shots).length && this.engine.pages.wantsReview(state)) {
          state.polish = { shots, outline, compact: state.draft!.compact, variantId: main.id, findings };
          state.session.polish = { state: 'pending', pages: Object.keys(shots).length };
        }
        // Without the look at the pages, what the app found itself is shown to the user to fix.
        else if (findings.length)
          state.session.reviewHints = findings.map(f => ({ ...f, severity: 'medium' as const }));
        delete state.session.recovery;
        delete state.draft;
        delete state.extras;
        await this.engine.rememberLayouts(deck, state.session);
        const others = state.session.variants.slice(1).map(v => v.label);
        state.session.messages.push({
          role: 'assistant',
          text: `${deck.slides.length}枚を作成しました。${others.length ? `${others.join('・')}の案も同じ構成で作りました。並べて比べたり、ページごとに組み合わせたりできます。` : ''}${state.session.polish?.state === 'pending' ? '続けて、描画したページを画像で見直して仕上げます。その間も資料を確認できます。' : 'サムネイルで確認し、必要なら対象のスライドに修正を指示してください。'}${state.session.reviewHints?.length ? `直したほうがよい点を「確認のヒント」に${state.session.reviewHints.length}件載せています。` : ''}${deckBlanks(deck).length ? `まだ決まっていない事実は［　］の記入欄にしています（${deckBlanks(deck).length}項目）。「記入欄」から入力すると、資料全体に反映します。` : ''}`,
        });
        return state.session;
      },
      true,
      true,
    );
  }

  private baseBatch(state: SessionState, outline: Outline) {
    return this.engine.pages.freeDesign(state)
      ? FREE_GENERATION_BATCH_SIZE
      : outline.mode === 'reading'
        ? READING_BATCH_SIZE
        : GENERATION_BATCH_SIZE;
  }
  /** Writes the outline's pages into draft.slides batch by batch, keeping every page that
   * passes. Returns why it stopped, or undefined when all pages are written. The session's
   * own provider writes unless run names another AI chosen for this session. */
  private async writePages(
    state: SessionState,
    outline: Outline,
    draft: GenerationDraft,
    run?: AiRun,
  ): Promise<{ canRetry: boolean } | undefined> {
    const free = this.engine.pages.freeDesign(state),
      html = this.engine.pages.htmlFor(state, run),
      baseBatch = this.baseBatch(state, outline);
    if (state.settings.designMode === 'html' && !html && !state.session.warnings.some(w => w.startsWith('HTML方式')))
      state.session.warnings.push(
        'HTML方式（試験）は、月額版の自動作成でインストール版を使うときだけ使えます。この資料は座標の方式で作成しました。',
      );
    /** One returned page, checked on its own: a later page's problem never discards an earlier valid page. */
    const accept = (
      raw: any,
      expected: string,
      keep: (slide: SlideSpec) => void = slide => draft.slides.push(slide),
    ) => {
      keep(this.engine.pages.checkPage(state, raw, expected));
      if (typeof raw.shot === 'string') (draft.shots ??= {})[expected] = raw.shot;
    };
    const pending = (draft.pending ??= {});
    while (draft.slides.length < outline.slides.length) {
      while (draft.slides.length < outline.slides.length && pending[outline.slides[draft.slides.length].id]) {
        const id = outline.slides[draft.slides.length].id;
        draft.slides.push(pending[id]);
        delete pending[id];
      }
      if (draft.slides.length >= outline.slides.length) break;
      const start = draft.slides.length,
        targetSlides: Outline['slides'] = [];
      for (const slide of outline.slides.slice(start)) {
        if (pending[slide.id] || targetSlides.length >= draft.batchSize) break;
        targetSlides.push(slide);
      }
      let response: any;
      try {
        // AI-designed pages carry every element's position, so each page needs a larger answer
        // budget. The budget is a ceiling, not usage; a cut reply costs a whole extra call.
        response = await this.engine.ai.complete(
          state,
          'generate',
          {
            outline,
            targetSlides,
            messages: state.session.messages,
            compactOutput: draft.compact,
            continuedFrom: draft.slides.map(continued),
          },
          draft.compact
            ? GENERATION_OUTPUT_TOKENS
            : Math.min(
                GENERATION_OUTPUT_TOKENS,
                free ? 3000 + targetSlides.length * (html ? 5500 : 4000) : 4000 + targetSlides.length * 2500,
              ),
          run,
        );
        if (!response || response.mode !== outline.mode || !Array.isArray(response.slides))
          throw new AppError(422, '指定したページ数・モードで応答されませんでした。', 'INVALID_CONTENT');
        if (start === 0 && knownTheme(response.themeId)) draft.themeId = response.themeId;
        if (html)
          await this.engine.pages.layoutPages(state, outline, response.slides.slice(0, targetSlides.length), run);
        targetSlides.forEach((target, i) => accept(response.slides[i], target.id));
        draft.singleFailures = 0;
        // After a failure the batch was made smaller; each success restores it step by step,
        // up to a size below one whose reply was cut or broken.
        const cap = Math.min(baseBatch, draft.ceiling ?? baseBatch);
        if (draft.batchSize < cap) draft.batchSize = Math.min(cap, draft.batchSize * 2);
      } catch (error) {
        // An operation's 12 calls are used up: the next operation may continue, until the presentation's 40.
        if (error instanceof AppError && error.code === 'CALL_LIMIT')
          return { canRetry: !run && state.session.usage.calls < SESSION_CALL_LIMIT };
        if (
          !repairReason(error) ||
          (this.engine.options.settings.get().autoRepair === false && !(error instanceof OutputLimitError))
        )
          throw error;
        // A reply cut off or broken partway still holds finished pages; keep those that pass.
        const partial =
          error instanceof OutputLimitError
            ? error.partialText
            : error instanceof AppError && error.code === 'INVALID_MODEL_JSON'
              ? (error as AppError & { partialText?: string }).partialText
              : undefined;
        const prefix = partial ? completeSlidePrefix(partial) : undefined;
        if (prefix?.mode === outline.mode) {
          const from = draft.slides.length - start,
            pages = prefix.slides.slice(from, targetSlides.length).map((s: unknown) => this.engine.ai.unmask(state, s));
          if (html) await this.engine.pages.layoutPages(state, outline, pages, run);
          for (let i = from; i < Math.min(prefix.slides.length, targetSlides.length); i++) {
            try {
              if (start === 0 && i === 0 && knownTheme(prefix.themeId)) draft.themeId = prefix.themeId;
              accept(pages[i - from], targetSlides[i].id);
            } catch {
              break;
            }
          }
        }
        // The pages after the rejected one in the same reply are checked and kept for later.
        if (response && Array.isArray(response.slides))
          for (let i = draft.slides.length - start + 1; i < targetSlides.length; i++) {
            try {
              accept(response.slides[i], targetSlides[i].id, slide => {
                pending[targetSlides[i].id] = slide;
              });
            } catch {
              /* asked again with the rejected page */
            }
          }
        const gained = draft.slides.length - start + targetSlides.filter(s => pending[s.id]).length;
        draft.singleFailures = targetSlides.length === 1 && !gained ? draft.singleFailures + 1 : 0;
        draft.batchSize = Math.max(1, Math.floor(targetSlides.length / 2));
        draft.compact = true;
        if (error instanceof OutputLimitError || (error instanceof AppError && error.code === 'INVALID_MODEL_JSON'))
          draft.ceiling = Math.max(1, Math.min(draft.ceiling ?? baseBatch, targetSlides.length - 1));
        if (draft.slides.length === outline.slides.length && this.engine.options.settings.get().autoRepair !== false) {
          if (!run)
            this.engine.ai.recordRepair(
              state,
              error,
              '最後まで返された全ページを検証し、追加の本文生成なしで仕上げへ進めました。',
              false,
            );
          continue;
        }
        if (
          draft.singleFailures < 2 &&
          this.engine.ai.tryRepair(
            state,
            'generate',
            error,
            `検証できた${draft.slides.length}枚を再利用し、残りを最大${draft.batchSize}枚ずつ、回答枠16,000トークンで再生成。文章とノートの重複を減らし、ページ・図表・出典を検証します。`,
            run,
          )
        )
          continue;
        return { canRetry: draft.singleFailures < 2 };
      }
    }
    return undefined;
  }
  /** Other AIs chosen at creation write their own drafts of the same outline while the
   * main draft is written. A failed one is reported and never stops the main draft. */
  private startExtras(state: SessionState, outline: Outline): Promise<void> {
    const targets = state.sendScope === 'design' ? [] : (state.targets ?? []).slice(1);
    if (!targets.length || state.extras?.started) return Promise.resolve();
    const extras = (state.extras = { started: true, ready: [] as DeckVariant[], failed: [] as string[] });
    return Promise.all(
      targets.map(async target => {
        const run = this.engine.ai.newRun(state, target);
        try {
          const deck = await this.draftFor(state, outline, run);
          extras.ready.push({
            id: randomUUID(),
            label: run.label,
            deck,
            origin: {
              kind: 'ai',
              ai: run.label,
              ...(run.notes.length ? { notes: run.notes.map(n => `自動で対処：${n}`) } : {}),
            },
          });
        } catch (error) {
          extras.failed.push(
            `${run.label}の案は作成できませんでした（${error instanceof AppError ? error.message : '接続または応答の不備'}）。`,
          );
        }
      }),
    ).then(() => undefined);
  }
  /** A whole draft of the outline by one chosen AI, checked and fitted like the main one. */
  async draftFor(state: SessionState, outline: Outline, run: AiRun): Promise<DeckSpec> {
    const draft: GenerationDraft = {
      key: run.target,
      slides: [],
      themeId: outline.themeId ?? this.engine.preferredTheme,
      batchSize: this.baseBatch(state, outline),
      singleFailures: 0,
      compact: false,
    };
    const stopped = await this.writePages(state, outline, draft, run);
    if (stopped)
      throw new AppError(422, `${draft.slides.length} / ${outline.slides.length}枚で止まりました`, 'EXTRA_STOPPED');
    let deck = validateDeck(
      { id: randomUUID(), title: outline.title, mode: outline.mode, themeId: draft.themeId, slides: draft.slides },
      outline,
    );
    deck.title = outline.title;
    this.engine.pages.verifySources(state, deck.slides);
    this.engine.pages.styleDeck(state, deck, outline);
    deck = fillBlanks(deck, factValues(outline)).deck;
    const typography = state.settings.typographyId;
    deck.typographyId = typography && typography !== 'auto' ? typography : (outline.typographyId ?? deck.typographyId);
    deck = await this.fitText(state, improveTextFit(deck), undefined, run);
    deck = diversifyDeck(deck, randomUUID(), this.engine.recentLayouts);
    assertTextFits(deck);
    return deck;
  }
  private generationRecovery(state: SessionState, outline: Outline, stage: 'content' | 'text-fit', canRetry: boolean) {
    const draft = state.draft!,
      complete = draft.slides.length;
    const hasRemaining = stage === 'text-fit' || complete < outline.slides.length;
    const retryAvailable = canRetry && (!hasRemaining || state.session.usage.calls < SESSION_CALL_LIMIT);
    state.session.phase = 'outline';
    state.session.recovery = {
      task: 'generate',
      stage,
      completedSlides: complete,
      totalSlides: outline.slides.length,
      nextBatchSize: stage === 'text-fit' ? draft.fit!.batchSize : draft.batchSize,
      retryAvailable,
      message: retryAvailable
        ? stage === 'text-fit'
          ? `本文${complete}枚は保持しています。文字量の調整を完了できませんでした。調整済みの文章を再利用し、未調整のページだけ小分けに処理します。`
          : `検証できた${complete} / ${outline.slides.length}枚を保持しています。途中のページや検証が通らないページは使いません。残りは最大${draft.batchSize}枚ずつ作成します。`
        : `検証できた本文${complete}枚と指示・資料を保持しています。同じ1枚での不備が繰り返されたか、呼び出し回数の上限に達したため再開を止めました。構成から情報を分けるか、優先する条件を整理してください。`,
    };
    return state.session;
  }

  /** Text that does not fit is resolved in this order: room and smaller type on this PC;
   * for an AI-designed page, the AI lays that page out again with the same words; for a
   * template page, the AI shortens the wording. When the user chose to finish anyway,
   * type may become as small as half, still without cutting a word or calling an AI. */
  async fitText(state: SessionState, deck: DeckSpec, memo?: FitDraft, run?: AiRun) {
    if (state.settings.provider === 'demo') {
      assertTextFits(deck);
      return deck;
    }
    let fitted = improveTextFit(deck, !!memo?.force);
    if (memo?.force) {
      const left = fitProblems(fitted);
      if (left.length)
        throw new AppError(
          422,
          `${left.map(p => fitted.slides.findIndex(s => s.id === p.slideId) + 1).join('・')}枚目は、文字を半分の大きさにしても枠に収まりません。そのページを修正（鉛筆ボタン）で直すか、構成で情報を分けてください。`,
          'TEXT_FIT_FORCED',
        );
      const pages = deck.slides.flatMap((s, i) =>
        JSON.stringify(s.design) !== JSON.stringify(fitted.slides[i].design) ? [i + 1] : [],
      );
      if (pages.length)
        state.session.warnings.push(
          `${pages.join('・')}枚目は、文字を小さくして枠に収めました（最小で元の半分）。PowerPointで読みやすさを確認してください。`,
        );
      memo.deck = fitted;
      return fitted;
    }
    if (memo) memo.deck = fitted;
    while (true) {
      const all = fitProblems(fitted);
      if (!all.length) return fitted;
      const designed = all.find(p => fitted.slides.find(s => s.id === p.slideId)?.design);
      if (designed) {
        const slide = fitted.slides.find(s => s.id === designed.slideId)!;
        try {
          fitted = await this.relayout(
            state,
            fitted,
            slide,
            designed.issues.map(i => i.text),
            run,
          );
          if (memo) {
            memo.deck = fitted;
            memo.singleFailures = 0;
          }
        } catch (error) {
          if (memo && repairReason(error)) memo.singleFailures++;
          if (
            (memo?.singleFailures ?? 0) < 2 &&
            this.engine.ai.tryRepair(
              state,
              'revise',
              error,
              `${slide.id}だけ、文章と数値を変えずに配置を直すよう再依頼します。`,
              run,
            )
          )
            continue;
          throw error;
        }
        continue;
      }
      const problems = all.slice(0, memo?.batchSize ?? READING_BATCH_SIZE);
      try {
        const response = await this.engine.ai.complete(
          state,
          'summarize',
          { slides: problems },
          memo?.singleFailures ? 14000 : Math.min(14000, 3000 + problems.length * 2500),
          run,
        );
        const ids = problems.map(p => p.slideId),
          next = improveTextFit(applySummaries(fitted, response, ids));
        // Progress is kept even when not every text is short enough yet.
        const issues = (list: typeof all) =>
          list.filter(p => ids.includes(p.slideId)).reduce((n, p) => n + p.issues.length, 0);
        if (issues(fitProblems(next)) >= issues(problems))
          throw new AppError(
            422,
            '要約後も文章が枠に収まりません。構成で情報を分けるか、短くする指示を追加してください。',
            'TEXT_FIT_REQUIRED',
          );
        fitted = next;
        if (memo) {
          memo.deck = fitted;
          memo.singleFailures = 0;
        }
      } catch (error) {
        if (error instanceof OutputLimitError && memo) {
          memo.singleFailures = problems.length === 1 ? memo.singleFailures + 1 : 0;
          memo.batchSize = Math.max(1, Math.floor(problems.length / 2));
        }
        if (
          (memo?.singleFailures ?? 0) < 2 &&
          this.engine.ai.tryRepair(
            state,
            'summarize',
            error,
            `本文は再生成せず、未調整の最大${memo?.batchSize ?? READING_BATCH_SIZE}枚だけを要約。表示枠・変更できる欄・数値の保持を確認します。`,
            run,
          )
        )
          continue;
        throw error;
      }
    }
  }

  /** An AI-designed page whose text does not fit is laid out again by the AI with the
   * same words, numbers, charts and tables; a reply that changes any of them is refused. */
  private async relayout(
    state: SessionState,
    deck: DeckSpec,
    slide: SlideSpec,
    texts: string[],
    run?: AiRun,
  ): Promise<DeckSpec> {
    const instruction = `この1枚では、次の文字が枠に収まりません：${texts.map(t => `「${t.slice(0, 40)}」`).join('、')}。文章・数値・グラフと表の内容は一字も変えずに、枠を広げる・文字を小さくする・配置を変えるなどして、すべての文字が枠に収まるデザインに直してください。`;
    const raw: any = await this.engine.ai.complete(
      state,
      'revise',
      { outline: state.session.outline, targetSlide: slide, instruction, compactOutput: true },
      GENERATION_OUTPUT_TOKENS,
      run,
    );
    if (raw?.id !== slide.id) throw new AppError(422, '配置を直したページの識別子が一致しません。', 'INVALID_CONTENT');
    const result = validateSlide(raw, slide.id);
    if (!sameContent(slide, result))
      throw new AppError(
        422,
        `${slide.id}：配置の直しで文章や数値が変わりました。文章と数値は一字も変えず、枠と文字の大きさ・配置だけを直してください。`,
        'INVALID_CONTENT',
      );
    // The words were not to change, so the page keeps its own title, notes and sources.
    const kept: SlideSpec = {
      ...result,
      title: slide.title,
      notes: slide.notes,
      sources: slide.sources,
      layoutId: slide.layoutId,
    };
    for (const e of kept.design?.elements ?? [])
      if (e.t === 'text' && e.refs) {
        const refs = e.refs.filter(n => n <= slide.sources.length);
        if (refs.length) e.refs = refs;
        else delete e.refs;
      }
    const next = improveTextFit({ ...deck, slides: deck.slides.map(s => (s.id === slide.id ? kept : s)) });
    if (fitProblems(next).some(p => p.slideId === slide.id))
      throw new AppError(
        422,
        `${slide.id}：配置を直しても文字が枠に収まりません。枠を広げるか、文字を小さくしてください。`,
        'TEXT_FIT_REQUIRED',
      );
    return next;
  }
  /** The last step when text fitting stopped: text is set smaller (down to half) where it
   * does not fit, so the finished pages are kept. Nothing is cut and no AI is called. */
  async finishSmaller(id: string) {
    const state = this.engine.state(id),
      recovery = state.session.recovery;
    if (recovery?.task === 'generate' && recovery.stage === 'text-fit') return this.generate(id, undefined, true);
    if (recovery?.task === 'revise' && recovery.stage === 'text-fit' && state.revision)
      return this.engine.lock(
        id,
        async s => {
          const p = s.revision!;
          return this.engine.revision.performRevision(
            s,
            { slideId: p.slideId, variantId: p.variantId, instruction: p.instruction },
            true,
            true,
          );
        },
        true,
        true,
      );
    if (state.chat?.task === 'summarize' && state.chat.summaryDeck)
      return this.engine.lock(id, async s => {
        const pending = s.chat!,
          deck = improveTextFit(pending.summaryDeck!, true),
          left = fitProblems(deck);
        if (left.length)
          throw new AppError(
            422,
            `${left.map(p => deck.slides.findIndex(x => x.id === p.slideId) + 1).join('・')}枚目は、文字を半分の大きさにしても枠に収まりません。そのページを修正で直すか、構成で情報を分けてください。`,
            'TEXT_FIT_FORCED',
          );
        s.session.warnings.push(
          '文字が収まらなかったページは、AIに要約を頼まず、文字を小さくして仕上げました。PowerPointで読みやすさを確認してください。',
        );
        await this.engine.chat.finishChatDeck(s, deck, pending);
        return s.session;
      });
    throw new AppError(409, '文字の調整で止まった作成・修正がありません。');
  }
  /** The user's answers to the open facts of an outline: only the facts it names, short, without blank brackets. */
  private withFacts(outline: Outline, facts: unknown): Outline {
    if (!facts || typeof facts !== 'object' || Array.isArray(facts))
      throw new AppError(400, '入力した事実の形式が正しくありません。');
    const given = facts as Record<string, unknown>;
    return {
      ...outline,
      ...(outline.openFacts
        ? {
            openFacts: outline.openFacts.map(fact => {
              const raw = given[fact.label];
              if (raw === undefined) return fact;
              if (typeof raw !== 'string' || raw.length > 80)
                throw new AppError(400, `「${fact.label}」は80文字以内で入力してください。`);
              const value = raw.trim().replace(/[［］]/g, '');
              const { value: _old, ...rest } = fact;
              return value ? { ...rest, value } : rest;
            }),
          }
        : {}),
    };
  }
  /** Fills the blanks (［実施日］) of every draft with what the user typed, without an AI. A filled text that no
   * longer fits its place even when set smaller is refused, so nothing is cut. */
  async fillBlanks(id: string, input: unknown) {
    return this.engine.lock(id, async state => {
      if (state.session.phase !== 'ready' || !state.session.variants.length)
        throw new AppError(409, 'スライドを作成してから記入してください。');
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length > 30)
        throw new AppError(400, '記入する内容を選んでください。');
      const values: Record<string, string> = {};
      for (const [label, value] of Object.entries(input as Record<string, unknown>)) {
        if (typeof value !== 'string' || value.length > 80 || label.length > 30)
          throw new AppError(400, '記入欄の内容は80文字以内で入力してください。');
        if (value.trim()) values[label] = value.trim().replace(/[［］]/g, '');
      }
      if (!Object.keys(values).length) throw new AppError(400, '記入する内容を入力してください。');
      const finish = (deck: DeckSpec) => {
        const filled = fillBlanks(deck, values);
        return { deck: filled.changed.length ? improveTextFit(filled.deck) : filled.deck, changed: filled.changed };
      };
      const results = state.session.variants.map(variant => ({ variant, ...finish(variant.deck) }));
      for (const { deck, changed } of results) {
        const problems = fitProblems(deck).filter(p => changed.includes(p.slideId));
        if (problems.length)
          throw new AppError(
            422,
            `記入した内容が長く、${problems.map(p => `${deck.slides.findIndex(s => s.id === p.slideId) + 1}枚目`).join('・')}の枠に収まりません。短くして入力してください。`,
            'TEXT_FIT_REQUIRED',
          );
      }
      let count = 0;
      for (const { variant, deck, changed } of results) {
        if (!changed.length) continue;
        count += changed.length;
        variant.deck = deck;
        delete variant.render;
        // A page remade by the look keeps its way back: both of its versions are filled the same way.
        const versions = state.session.polish?.variantId === variant.id ? state.session.polish.versions : undefined;
        for (const [slideId, entry] of Object.entries(versions ?? {})) {
          const now = deck.slides.find(s => s.id === slideId);
          if (!now) continue;
          const other = entry.applied === 'after' ? 'before' : 'after',
            single = finish({ ...deck, slides: [entry[other]] });
          entry[entry.applied] = structuredClone(now);
          entry[other] = single.deck.slides[0];
        }
      }
      if (state.session.outline?.openFacts)
        state.session.outline = {
          ...state.session.outline,
          openFacts: state.session.outline.openFacts.map(f => (values[f.label] ? { ...f, value: values[f.label] } : f)),
        };
      state.session.messages.push({
        role: 'assistant',
        text: count
          ? `記入欄に入力した内容を反映しました（${Object.keys(values).join('・')}）。AIは呼び出していません。`
          : '入力した項目の記入欄は、資料にありませんでした。',
      });
      return state.session;
    });
  }
}
