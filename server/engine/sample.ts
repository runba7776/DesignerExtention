import { randomUUID } from 'node:crypto';
import type { DeckVariant, Outline, PolishState, SlideSpec } from '../../shared/contracts.js';
import { AppError } from '../errors.js';
import { parseShowcase } from '../showcase.js';
import { improveTextFit } from '../../shared/layout-selection.js';
import { deckBlanks, fillBlanks } from '../../shared/blanks.js';
import type { SessionEngine } from '../engine.js';
import type { SessionState } from './session-state.js';
import { factValues } from './helpers.js';

/** The sample experience: replays a creation recorded with a monthly plan, without an AI. */
export class SampleService {
  constructor(private readonly engine: SessionEngine) {}

  async loadShowcase() {
    try {
      return this.engine.options.showcase ? parseShowcase(await this.engine.options.showcase()) : undefined;
    } catch {
      return undefined;
    }
  }
  /** The sample experience: the deck recorded for the picked direction, with the user's answers to its open facts. */
  replayDeck(state: SessionState, outline: Outline) {
    const index = state.session.proposals?.chosen ?? 0,
      record = state.showcase!.decks[index];
    if (!record) throw new AppError(404, 'この案の記録がありません。');
    const filled = fillBlanks({ ...structuredClone(record.deck), id: randomUUID() }, factValues(outline)),
      deck = filled.changed.length ? improveTextFit(filled.deck) : filled.deck;
    const main: DeckVariant = {
      id: randomUUID(),
      label: `記録（${state.showcase!.ai}）`,
      deck,
      origin: { kind: 'ai', ai: state.showcase!.ai },
    };
    state.session.variants = [main];
    state.session.phase = 'ready';
    delete state.session.reviewHints;
    delete state.session.reviewReport;
    if (record.polish) {
      state.polish = { shots: {}, html: {}, outline, compact: false, variantId: main.id, findings: [] };
      state.session.polish = { state: 'pending', pages: record.polish.report.checked };
    }
    const blanks = deckBlanks(deck).length;
    state.session.messages.push({
      role: 'assistant',
      text: `記録した${deck.slides.length}枚を表示しました（記録時の作成時間は約${Math.round(record.seconds ?? 0)}秒）。${record.polish ? '続けて、描画したページを画像で見直した記録を再生します。' : ''}${blanks ? `まだ決まっていない事実は［　］の記入欄です（${blanks}項目）。「記入欄」から入力すると資料全体に反映します。` : ''}`,
    });
    return state.session;
  }
  /** The sample experience: what the look at the drawn pages and the follow-up instructions changed when it was recorded. */
  async replayPolish(state: SessionState) {
    const job = state.polish,
      entry = state.showcase!.decks[state.session.proposals?.chosen ?? 0],
      record = entry?.polish,
      followUps = entry?.followUps,
      variant = job && state.session.variants.find(v => v.id === job.variantId);
    delete state.polish;
    if (!record || !variant || !job) {
      state.session.polish = { state: 'skipped' };
      return state.session;
    }
    await new Promise(resolve => setTimeout(resolve, 1200));
    const values = factValues(job.outline),
      versions: NonNullable<PolishState['versions']> = {},
      fixed: string[] = [];
    const finish = (page: SlideSpec) =>
      improveTextFit(fillBlanks({ ...variant.deck, slides: [structuredClone(page)] }, values).deck).slides[0];
    for (const [slideId, after] of Object.entries(record.replaced)) {
      const at = variant.deck.slides.findIndex(s => s.id === slideId);
      if (at < 0) continue;
      const remade = finish(after);
      versions[slideId] = {
        before: structuredClone(variant.deck.slides[at]),
        after: structuredClone(remade),
        applied: 'after',
      };
      variant.deck.slides[at] = remade;
      fixed.push(slideId);
    }
    // These came after the look, so a page they changed has no earlier version to switch back to.
    for (const [slideId, page] of Object.entries(followUps?.slides ?? {})) {
      const at = variant.deck.slides.findIndex(s => s.id === slideId);
      if (at < 0) continue;
      variant.deck.slides[at] = finish(page);
      delete versions[slideId];
    }
    if (fixed.length || followUps) delete variant.render;
    state.session.reviewHints = structuredClone(record.hints);
    state.session.reviewReport = { ...record.report, fixed };
    state.session.polish = {
      state: 'done',
      variantId: variant.id,
      pages: record.report.checked,
      seconds: Math.round(record.seconds ?? 0),
      ...(Object.keys(versions).length ? { versions } : {}),
    };
    const notes = record.hints.filter(h => !h.fixed && !h.unresolved).length;
    state.session.messages.push({
      role: 'assistant',
      text: `記録した見直しを再生しました。描画した${record.report.checked}枚を画像で見直し、${fixed.length ? `${fixed.length}枚を作り直しています${Object.keys(versions).length ? '（「確認のヒント」から直す前に戻せます）' : ''}。` : ''}${record.report.unresolved.length ? `${record.report.unresolved.length}枚は自動で直せませんでした。` : ''}${notes ? `気づいた点${notes}件は「確認のヒント」にあります（自動では直していません）。` : ''}記録時の見直しは約${Math.round(record.seconds ?? 0)}秒、AI呼び出し${record.report.calls}回でした。`,
    });
    if (followUps?.asked.length)
      state.session.messages.push(...followUps.asked.map(text => ({ role: 'user' as const, text })), {
        role: 'assistant',
        text: `記録した追加の指示を再生しました。できたページを資料と照合し、${Object.keys(followUps.slides).length}枚に${followUps.asked.length}回の修正を指示しています。`,
      });
    return state.session;
  }
}
