import type { DeckSpec, OutputMode, ProposalSet, ReviewHint, ReviewReport, SlideSpec } from './shared/contracts.js';

/** A recorded creation replayed in the sample experience: the request, the three directions with their
 * samples, and for each direction the deck the AI made, what the look at its pages changed, and what follow-up
 * instructions changed after that (null for a direction marked sampleOnly, which was not made). It was made once
 * with a monthly plan; replaying it calls no AI, so the no-install version can show the whole flow. */
export interface Showcase {
  version: 1;
  prompt: string;
  mode: OutputMode;
  ai: string;
  proposals: ProposalSet;
  decks: ({
    deck: DeckSpec;
    seconds?: number;
    polish?: { replaced: Record<string, SlideSpec>; hints: ReviewHint[]; report: ReviewReport; seconds?: number };
    followUps?: { asked: string[]; slides: Record<string, SlideSpec> };
  } | null)[];
}
export const SHOWCASE_WARNING =
  'サンプル体験：実際にAIで作った記録を再生しています。この画面ではAIを呼び出さず、入力や資料も使いません。';

/** A recording read from the app's own files; anything malformed is treated as absent (the plain sample is used). */
export function parseShowcase(value: unknown): Showcase | undefined {
  const data = value as Showcase | undefined;
  if (
    !data ||
    data.version !== 1 ||
    typeof data.prompt !== 'string' ||
    (data.mode !== 'presentation' && data.mode !== 'reading')
  )
    return undefined;
  if (
    !Array.isArray(data.proposals?.items) ||
    data.proposals.items.length < 2 ||
    !Array.isArray(data.decks) ||
    data.decks.length !== data.proposals.items.length
  )
    return undefined;
  const made = (d: Showcase['decks'][number]) => Array.isArray(d?.deck?.slides) && d.deck.slides.length > 0;
  if (!data.decks.some(made) || data.decks.some((d, i) => !made(d) && !data.proposals.items[i].sampleOnly))
    return undefined;
  return data;
}
