import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  GENERATION_OUTPUT_TOKENS,
  REVIEW_BATCH_SIZE,
  REVIEW_OUTPUT_TOKENS,
  type DeckSpec,
  type DeckVariant,
  type Outline,
  type PolishState,
  type ReviewHint,
  type SlideSpec,
} from '../../shared/contracts.js';
import { AppError } from '../errors.js';
import { validateReview } from '../validation.js';
import { fitProblems, assertTextFits } from '../text-fit.js';
import { improveTextFit } from '../../shared/layout-selection.js';
import { applySavedDesign } from '../design-application.js';
import { draftMarks } from '../../shared/blanks.js';
import type { SessionEngine } from '../engine.js';
import type { SessionState } from './session-state.js';
import { continued, plainOutline } from './helpers.js';

/** A page made again after the look at it, with its picture when it was drawn in a browser. */
interface RemadePage {
  slide: SlideSpec;
  shot?: string;
}

/** Looking at drawn pages as pictures: samples of the directions, the look after the deck is shown, a page on request. */
export class ReviewService {
  constructor(private readonly engine: SessionEngine) {}

  /** Shows the drawn pages to the AI a few at a time and makes the pages with a high problem again once
   * with the finding. Returns the new pages (checked, not yet finished), the findings by weight, and the
   * pages that could not be made again. Nothing in the deck is changed here. */
  private async reviewPages(
    state: SessionState,
    outline: Outline,
    slides: SlideSpec[],
    shots: Record<string, string>,
    compact: boolean,
    known: ReviewHint[] = [],
  ) {
    const pages = slides.filter(s => shots[s.id]),
      hints: ReviewHint[] = [],
      severe = new Map<string, ReviewHint[]>(),
      replaced: Record<string, RemadePage> = {},
      unresolved: string[] = [];
    // What the app found itself (a note to the maker left on a slide, the same kind of page three in a row) is made again too.
    for (const hint of known) severe.set(hint.slideId, [...(severe.get(hint.slideId) ?? []), hint]);
    let checked = 0;
    for (let i = 0; i < pages.length && this.engine.ai.callsLeft(state); i += REVIEW_BATCH_SIZE) {
      const batch = pages.slice(i, i + REVIEW_BATCH_SIZE);
      try {
        const reply = validateReview(
          await this.engine.ai.complete(
            state,
            'review',
            { pages: batch.map(s => ({ id: s.id, title: s.title })) },
            REVIEW_OUTPUT_TOKENS,
            undefined,
            batch.map(s => shots[s.id]),
          ),
          batch.map(s => s.id),
        );
        checked += batch.length;
        for (const page of reply)
          for (const problem of page.problems) {
            const hint: ReviewHint = { slideId: page.id, title: batch.find(s => s.id === page.id)!.title, ...problem };
            if (problem.severity === 'high') severe.set(page.id, [...(severe.get(page.id) ?? []), hint]);
            else hints.push(hint);
          }
      } catch (error) {
        if (error instanceof AppError && error.code === 'CALL_LIMIT') break;
        state.session.warnings.push(
          '描画したページの画像による見直しを一部行えませんでした。作成した資料はそのまま使えます。',
        );
      }
    }
    // One page per call: several pages remade at once can run past the answer limit, and then all of them are lost.
    for (const [id, found] of severe) {
      const done = this.engine.ai.callsLeft(state)
        ? await this.redoPages(
            state,
            outline,
            slides,
            [id],
            found.map(h => `${id}：${h.what}。${h.fix}`).join(' '),
            compact,
          )
        : {};
      if (done[id]) replaced[id] = done[id];
      else unresolved.push(id);
    }
    return { checked, hints, severe, replaced, unresolved };
  }
  /** Makes the given pages again with the finding from the look at them. Returns the new versions that
   * pass the checks, with their pictures when drawn in a browser; a page missing from the result keeps its
   * earlier version. */
  private async redoPages(
    state: SessionState,
    outline: Outline,
    slides: SlideSpec[],
    ids: string[],
    detail: string,
    compact: boolean,
    again = true,
  ): Promise<Record<string, RemadePage>> {
    const targetSlides = outline.slides.filter(s => ids.includes(s.id));
    try {
      const response: any = await this.engine.ai.complete(
        state,
        'generate',
        {
          outline,
          targetSlides,
          messages: state.session.messages,
          compactOutput: compact,
          continuedFrom: slides.filter(s => !ids.includes(s.id)).map(continued),
          repair: {
            reason: 'VISUAL_REVIEW',
            instruction:
              '描画したページを画像で見直して見つかった問題です。文章・数値・出典は保ったまま、指摘されたページの図と配置を直してください。',
            detail: detail.slice(0, 1500),
          },
        },
        Math.min(GENERATION_OUTPUT_TOKENS, 3000 + targetSlides.length * 5500),
      );
      if (!response || response.mode !== outline.mode || !Array.isArray(response.slides)) return {};
      if (this.engine.pages.htmlFor(state))
        await this.engine.pages.layoutPages(state, outline, response.slides.slice(0, targetSlides.length));
      const done: Record<string, RemadePage> = {},
        refused: { id: string; why: string }[] = [];
      targetSlides.forEach((target, i) => {
        try {
          const slide = this.engine.pages.checkPage(state, response.slides[i], target.id),
            marks = draftMarks(slide);
          if (marks.length)
            throw new AppError(
              422,
              `${target.id}：作り手向けのメモか空欄（「${marks[0].sample}」）が残っています。未定の事実は［項目名］の記入欄にし、メモはノートへ移してください。`,
              'INVALID_CONTENT',
            );
          const shot = response.slides[i]?.shot;
          done[target.id] = { slide, ...(typeof shot === 'string' ? { shot } : {}) };
        } catch (error) {
          refused.push({ id: target.id, why: error instanceof Error ? error.message : '検査を通りませんでした' });
        }
      });
      // A remade page refused by the checks is often better than the earlier one in every other way, so
      // it is asked once more with what the checks found.
      if (refused.length && again && this.engine.ai.callsLeft(state))
        Object.assign(
          done,
          await this.redoPages(
            state,
            outline,
            slides,
            refused.map(r => r.id),
            `${detail} / 作り直した案は次の検査で通りませんでした。見直しの指摘を生かしたまま直してください：${refused.map(r => r.why).join(' ')}`,
            compact,
            false,
          ),
        );
      return done;
    } catch {
      return {};
    }
  }
  /** A second look at remade pages, as pictures: a remake can bring a new problem (text hidden under a shape
   * that was moved, for example). Returns the findings per page; pages without a picture are not looked at. */
  private async lookAgain(state: SessionState, pages: { slide: SlideSpec; shot?: string }[]) {
    const found: Record<string, { severity: 'high' | 'medium' | 'low'; what: string; fix: string }[]> = {};
    const drawn = pages.filter((p): p is { slide: SlideSpec; shot: string } => !!p.shot);
    for (let i = 0; i < drawn.length && this.engine.ai.callsLeft(state); i += REVIEW_BATCH_SIZE) {
      const batch = drawn.slice(i, i + REVIEW_BATCH_SIZE);
      try {
        const reply = validateReview(
          await this.engine.ai.complete(
            state,
            'review',
            { pages: batch.map(p => ({ id: p.slide.id, title: p.slide.title })) },
            REVIEW_OUTPUT_TOKENS,
            undefined,
            batch.map(p => p.shot),
          ),
          batch.map(p => p.slide.id),
        );
        for (const page of reply) found[page.id] = page.problems;
      } catch (error) {
        if (error instanceof AppError && error.code === 'CALL_LIMIT') break;
      }
    }
    return found;
  }
  /** A remade page gets the finishing the deck had (saved design, text fit); undefined when it no longer fits. */
  private finishPage(state: SessionState, deck: DeckSpec, slide: SlideSpec): SlideSpec | undefined {
    let single: DeckSpec = { ...deck, slides: [slide] };
    const saved = state.settings.preferredDesignId && state.design;
    if (saved) single = applySavedDesign(single, state.design!, false, this.engine.pages.templateTheme(state)).deck;
    single = improveTextFit(single);
    if (fitProblems(single).length) return undefined;
    if (saved) single = applySavedDesign(single, state.design!, true, this.engine.pages.templateTheme(state)).deck;
    try {
      assertTextFits(single);
    } catch {
      return undefined;
    }
    return single.slides[0];
  }
  /** The look at the drawn pages, after the deck is shown: pages with a high problem are made again and
   * swapped in (the earlier version is kept to go back to); the other findings become hints. */
  async polish(id: string) {
    return this.engine.lock(id, async state => {
      const job = state.polish,
        status = state.session.polish;
      if (!status || status.state !== 'pending') throw new AppError(409, '見直す資料がありません。');
      if (state.showcase) return this.engine.sample.replayPolish(state);
      const variant = job && state.session.variants.find(v => v.id === job.variantId);
      if (!job || !variant) {
        state.session.polish = { state: 'skipped' };
        delete state.polish;
        return state.session;
      }
      const started = Date.now(),
        startCalls = state.session.usage.calls,
        operation = state.repairOperation;
      // Its own operation: the calls of writing the pages do not count against this one's 12.
      state.repairOperation = { remaining: 0, startedCalls: startCalls };
      try {
        const result = await this.reviewPages(
          state,
          job.outline,
          variant.deck.slides,
          job.shots,
          job.compact,
          job.findings,
        );
        const fixed: string[] = [],
          unresolved = [...result.unresolved],
          versions: NonNullable<PolishState['versions']> = {};
        const remade: { slide: SlideSpec; shot?: string }[] = [];
        for (const [slideId, page] of Object.entries(result.replaced)) {
          const at = variant.deck.slides.findIndex(s => s.id === slideId),
            finished = at >= 0 ? this.finishPage(state, variant.deck, page.slide) : undefined;
          if (!finished) {
            unresolved.push(slideId);
            continue;
          }
          versions[slideId] = {
            before: structuredClone(variant.deck.slides[at]),
            after: structuredClone(finished),
            applied: 'after',
          };
          variant.deck.slides[at] = finished;
          fixed.push(slideId);
          remade.push({ slide: finished, ...(page.shot ? { shot: page.shot } : {}) });
        }
        // The remade pages are looked at once more; one with a high problem of its own is not used (the user can
        // still switch to it), and its other findings join the hints.
        const second = remade.length ? await this.lookAgain(state, remade) : {},
          secondHints: ReviewHint[] = [];
        for (const slideId of [...fixed]) {
          const problems = second[slideId] ?? [],
            title = variant.deck.slides.find(s => s.id === slideId)!.title;
          const high = problems.filter(p => p.severity === 'high');
          if (high.length) {
            const at = variant.deck.slides.findIndex(s => s.id === slideId);
            variant.deck.slides[at] = structuredClone(versions[slideId].before);
            versions[slideId].applied = 'before';
            fixed.splice(fixed.indexOf(slideId), 1);
            unresolved.push(slideId);
            secondHints.push(
              ...high.map(p => ({
                slideId,
                title,
                ...p,
                what: `作り直した版にも重い問題：${p.what}`,
                unresolved: true,
              })),
            );
          } else secondHints.push(...problems.map(p => ({ slideId, title, ...p })));
        }
        if (Object.keys(versions).length) delete variant.render;
        // Findings of the first look at a page that was remade described its old version; the second look replaces them.
        const hints = [...result.hints.filter(h => !fixed.includes(h.slideId)), ...secondHints];
        for (const slideId of unresolved)
          hints.push(...(result.severe.get(slideId) ?? []).map(h => ({ ...h, unresolved: true })));
        for (const slideId of fixed) hints.push(...result.severe.get(slideId)!.map(h => ({ ...h, fixed: true })));
        const order = (slideId: string) => job.outline.slides.findIndex(s => s.id === slideId),
          rank = { high: 0, medium: 1, low: 2 } as const;
        state.session.reviewHints = hints.sort(
          (a, b) => order(a.slideId) - order(b.slideId) || rank[a.severity] - rank[b.severity],
        );
        const calls = state.session.usage.calls - startCalls,
          notes = hints.filter(h => h.severity !== 'high').length;
        state.session.reviewReport = { checked: result.checked, fixed, unresolved, calls };
        state.session.polish = {
          state: 'done',
          variantId: job.variantId,
          pages: result.checked,
          seconds: Math.round((Date.now() - started) / 1000),
          ...(Object.keys(versions).length ? { versions } : {}),
        };
        if (result.checked)
          state.session.messages.push({
            role: 'assistant',
            text: `描画した${result.checked}枚を画像で見直しました。${fixed.length ? `重い問題のあった${fixed.length}枚を作り直し、作り直したページももう一度確かめました（「確認のヒント」から直す前に戻せます）。` : '作り直しが必要な重い問題はありませんでした。'}${unresolved.length ? `${unresolved.length}枚は自動で直せなかったため、確認のヒントに載せています。` : ''}${notes ? `細かな気づき${notes}件は「確認のヒント」にあります。` : ''}この見直しのAI呼び出しは${calls}回です。`,
          });
      } catch {
        state.session.polish = { state: 'failed' };
        state.session.warnings.push(
          '描画したページの画像による見直しを行えませんでした。作成した資料はそのまま使えます。',
        );
      } finally {
        state.repairOperation = operation;
        delete state.polish;
      }
      return state.session;
    });
  }
  /** Samples of one offered direction before the user picks: its cover and its most telling page, made
   * as real pages. When that direction is picked, these pages are used in the deck as they are. */
  async previewProposal(id: string, index: unknown) {
    return this.engine.lock(
      id,
      async state => {
        const set = state.session.proposals,
          proposal = typeof index === 'number' && Number.isInteger(index) ? set?.items[index] : undefined;
        if (!set || !proposal) throw new AppError(400, '見本を作る構成案を選んでください。');
        if (proposal.preview || proposal.previewError || state.session.variants.length) return state.session;
        if (
          state.settings.proposalPreviews === false ||
          !this.engine.pages.freeDesign(state) ||
          state.settings.provider !== 'subscription'
        )
          throw new AppError(409, '見本は、月額版の自動作成でAIがデザインするときに作れます。');
        const outline = proposal.outline,
          ids = [...new Set(['slide-1', proposal.previewSlide].filter((v): v is string => !!v))];
        const targetSlides = outline.slides.filter(s => ids.includes(s.id));
        // Its own operation; notes about these pages (sources, palette) do not stay with the session.
        const operation = state.repairOperation,
          warnings = [...state.session.warnings];
        state.repairOperation = { remaining: 0, startedCalls: state.session.usage.calls };
        try {
          const response: any = await this.engine.ai.complete(
            state,
            'generate',
            { outline, targetSlides, messages: state.session.messages, compactOutput: true, continuedFrom: [] },
            Math.min(GENERATION_OUTPUT_TOKENS, 3000 + targetSlides.length * 5500),
          );
          if (!response || response.mode !== outline.mode || !Array.isArray(response.slides))
            throw new AppError(422, '見本のページが返されませんでした。', 'INVALID_CONTENT');
          if (this.engine.pages.htmlFor(state))
            await this.engine.pages.layoutPages(state, outline, response.slides.slice(0, targetSlides.length));
          const slides: SlideSpec[] = [],
            shots: Record<string, string> = {};
          targetSlides.forEach((target, i) => {
            try {
              const raw = response.slides[i];
              slides.push(this.engine.pages.checkPage(state, raw, target.id));
              if (typeof raw.shot === 'string') shots[target.id] = raw.shot;
            } catch {
              /* this page is not shown */
            }
          });
          if (!slides.length) throw new AppError(422, '見本のページが検査を通りませんでした。', 'INVALID_CONTENT');
          const deck: DeckSpec = {
            id: randomUUID(),
            title: outline.title,
            mode: outline.mode,
            themeId: this.engine.preferredTheme,
            slides: structuredClone(slides),
          };
          this.engine.pages.styleDeck(state, deck, outline);
          proposal.preview = improveTextFit(deck);
          (state.previewSeeds ??= []).push({ outline: plainOutline(outline), slides, shots });
        } catch (error) {
          proposal.previewError =
            error instanceof AppError && error.code !== 'CALL_LIMIT'
              ? '見本を作れませんでした。構成案の文章から選んでください。'
              : '見本を作れませんでした（AIの呼び出しの上限）。';
        } finally {
          state.repairOperation = operation;
          state.session.warnings = warnings;
        }
        return state.session;
      },
      false,
    );
  }
  /** The user asks for one page to be looked at as a picture and made again with what is seen. Every
   * finding counts here (the user chose the page); the earlier version is kept to go back to. */
  async refinePage(id: string, variantId: unknown, slideId: unknown) {
    return this.engine.lock(id, async state => {
      if (state.session.phase !== 'ready' || !state.session.outline)
        throw new AppError(409, 'スライドを作成してから見直してください。');
      const variant = this.engine.variant(state, variantId),
        at = typeof slideId === 'string' ? variant.deck.slides.findIndex(s => s.id === slideId) : -1;
      if (at < 0) throw new AppError(404, '見直すページが見つかりません。');
      if (!this.engine.pages.canLook(state))
        throw new AppError(
          409,
          'ページの見直しは、月額版のAIがデザインした資料で使えます（伏せ字を使うプロジェクトを除く）。',
          'LOOK_UNAVAILABLE',
        );
      const slide = variant.deck.slides[at],
        outline = state.session.outline,
        image = await this.pageImage(variant, at);
      const operation = state.repairOperation,
        startCalls = state.session.usage.calls;
      state.repairOperation = { remaining: 0, startedCalls: startCalls };
      try {
        const reply = validateReview(
          await this.engine.ai.complete(
            state,
            'review',
            { pages: [{ id: slide.id, title: slide.title }], focus: true },
            REVIEW_OUTPUT_TOKENS,
            undefined,
            [image],
          ),
          [slide.id],
        );
        const problems = reply[0]?.problems ?? [];
        const others = (state.session.reviewHints ?? []).filter(h => h.slideId !== slide.id),
          findings = problems.map(p => ({ slideId: slide.id, title: slide.title, ...p }));
        if (!problems.length) {
          state.session.messages.push({
            role: 'assistant',
            text: `${at + 1}枚目を画像で見直しましたが、直すべき点は見つかりませんでした。`,
          });
          return state.session;
        }
        const page = (
          await this.redoPages(
            state,
            outline,
            variant.deck.slides,
            [slide.id],
            problems.map(p => `${slide.id}：${p.what}。${p.fix}`).join(' '),
            false,
          )
        )[slide.id];
        const finished = page && this.finishPage(state, variant.deck, page.slide);
        const second = finished
            ? ((await this.lookAgain(state, [{ slide: finished, shot: page.shot }]))[slide.id] ?? [])
            : [],
          high = second.filter(p => p.severity === 'high'),
          calls = state.session.usage.calls - startCalls;
        if (finished && high.length) {
          // The remake has a high problem of its own: the page stays as it was; the remake can still be chosen.
          const versions = ((state.session.polish ??= { state: 'done', variantId: variant.id }).versions ??= {});
          versions[slide.id] = { before: structuredClone(slide), after: structuredClone(finished), applied: 'before' };
          if (state.session.polish.variantId !== variant.id) state.session.polish.variantId = variant.id;
          state.session.reviewHints = [
            ...others,
            ...findings.map(h => ({ ...h, unresolved: true })),
            ...high.map(p => ({
              slideId: slide.id,
              title: slide.title,
              ...p,
              what: `作り直した版にも重い問題：${p.what}`,
              unresolved: true,
            })),
          ];
          state.session.messages.push({
            role: 'assistant',
            text: `${at + 1}枚目を作り直しましたが、作り直した版にも重い問題（${high[0].what}）があったため、元のページのままにしています。「確認のヒント」から作り直した版に切り替えられます。AI呼び出し${calls}回。`,
          });
        } else if (finished) {
          const versions = ((state.session.polish ??= { state: 'done', variantId: variant.id }).versions ??= {});
          versions[slide.id] = { before: structuredClone(slide), after: structuredClone(finished), applied: 'after' };
          if (state.session.polish.variantId !== variant.id) state.session.polish.variantId = variant.id;
          variant.deck.slides[at] = finished;
          delete variant.render;
          state.session.reviewHints = [
            ...others,
            ...findings.map(h => ({ ...h, fixed: true })),
            ...second.map(p => ({ slideId: slide.id, title: slide.title, ...p })),
          ];
          state.session.messages.push({
            role: 'assistant',
            text: `${at + 1}枚目を画像で見直し、${problems.length}点を直して作り直しました（「確認のヒント」から直す前に戻せます）。AI呼び出し${calls}回。`,
          });
        } else {
          state.session.reviewHints = [...others, ...findings.map(h => ({ ...h, unresolved: true }))];
          state.session.messages.push({
            role: 'assistant',
            text: `${at + 1}枚目を画像で見直しましたが、作り直したページが検査を通らなかったため、元のページのままです。気づいた点は「確認のヒント」にあります。AI呼び出し${calls}回。`,
          });
        }
        return state.session;
      } finally {
        state.repairOperation = operation;
      }
    });
  }
  /** One page as the user sees it: the PowerPoint thumbnail of the deck (drawn now if it is not yet). */
  private async pageImage(variant: DeckVariant, index: number) {
    try {
      if (!variant.render) variant.render = await this.engine.options.render(variant.deck, variant.id);
      const file = variant.render.thumbnails[index];
      if (!file || !this.engine.options.artifactRoot) throw new Error('no thumbnail');
      return (
        await readFile(path.join(this.engine.options.artifactRoot, variant.render.artifactId, path.basename(file)))
      ).toString('base64');
    } catch {
      throw new AppError(
        503,
        'ページの画像を作れませんでした。PowerPointで描画できるか確認してください。',
        'PAGE_IMAGE_UNAVAILABLE',
      );
    }
  }
  /** Switches a page remade by the look at it back to its earlier version, or to the remade one again. */
  async reviewVersion(id: string, slideId: unknown, version: unknown) {
    return this.engine.lock(id, async state => {
      const versions = state.session.polish?.versions,
        entry = typeof slideId === 'string' ? versions?.[slideId] : undefined;
      if (!entry || (version !== 'before' && version !== 'after'))
        throw new AppError(400, '戻すページと版を選んでください。');
      const variant =
          state.session.variants.find(v => v.id === state.session.polish?.variantId) ?? state.session.variants[0],
        at = variant?.deck.slides.findIndex(s => s.id === slideId) ?? -1;
      if (!variant || at < 0) throw new AppError(404, 'ページが見つかりません。');
      if (JSON.stringify(variant.deck.slides[at]) !== JSON.stringify(entry[entry.applied]))
        throw new AppError(409, 'このページは見直しの後に変更されたため、切り替えられません。');
      variant.deck.slides[at] = structuredClone(entry[version]);
      entry.applied = version;
      delete variant.render;
      return state.session;
    });
  }
}
