import { randomUUID } from 'node:crypto';
import type { DeckVariant, Outline, PolishState } from '../../shared/contracts.js';
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
      state.polish = { shots: {}, outline, compact: false, variantId: main.id, findings: [] };
      state.session.polish = { state: 'pending', pages: record.polish.report.checked };
    }
    const blanks = deckBlanks(deck).length;
    state.session.messages.push({
      role: 'assistant',
      text: `記録した${deck.slides.length}枚を表示しました（記録時の作成時間は約${Math.round(record.seconds ?? 0)}秒）。${record.polish ? '続けて、描画したページを画像で見直した記録を再生します。' : ''}${blanks ? `まだ決まっていない事実は［　］の記入欄です（${blanks}項目）。「記入欄」から入力すると資料全体に反映します。` : ''}`,
    });
    return state.session;
  }
  /** The sample experience: what the look at the drawn pages changed when it was recorded. */
  async replayPolish(state: SessionState) {
    const job = state.polish,
      record = state.showcase!.decks[state.session.proposals?.chosen ?? 0]?.polish,
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
    for (const [slideId, after] of Object.entries(record.replaced)) {
      const at = variant.deck.slides.findIndex(s => s.id === slideId);
      if (at < 0) continue;
      const remade = improveTextFit(fillBlanks({ ...variant.deck, slides: [structuredClone(after)] }, values).deck)
        .slides[0];
      versions[slideId] = {
        before: structuredClone(variant.deck.slides[at]),
        after: structuredClone(remade),
        applied: 'after',
      };
      variant.deck.slides[at] = remade;
      fixed.push(slideId);
    }
    if (fixed.length) delete variant.render;
    state.session.reviewHints = structuredClone(record.hints);
    state.session.reviewReport = { ...record.report, fixed };
    state.session.polish = {
      state: 'done',
      variantId: variant.id,
      pages: record.report.checked,
      seconds: Math.round(record.seconds ?? 0),
      ...(fixed.length ? { versions } : {}),
    };
    const notes = record.hints.filter(h => h.severity !== 'high').length;
    state.session.messages.push({
      role: 'assistant',
      text: `記録した見直しを再生しました。描画した${record.report.checked}枚を画像で見直し、${fixed.length ? `重い問題のあった${fixed.length}枚を作り直しています（「確認のヒント」から直す前に戻せます）。` : '作り直しが必要な重い問題はありませんでした。'}${notes ? `細かな気づき${notes}件は「確認のヒント」にあります。` : ''}記録時の見直しは約${Math.round(record.seconds ?? 0)}秒、AI呼び出し${record.report.calls}回でした。`,
    });
    return state.session;
  }
}
