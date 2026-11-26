import type { DeckSpec, RehearsalPlan, RehearsalSlide, SlideSpec } from './contracts';

export const REHEARSAL_LIMITS = { minMinutes: 1, maxMinutes: 180, slides: 60, characters: 60_000 };

/** Visible text of a generated slide, in reading order, for timing and notes. */
export function slideText(slide: SlideSpec) {
  return [
    slide.headline,
    slide.body,
    ...slide.items.map(item => [item.label, item.value, item.description].filter(Boolean).join(' ')),
    ...(slide.diagram?.items.map(item => [item.label, item.description].filter(Boolean).join(' ')) ?? []),
    ...(slide.table ? [slide.table.headers.join(' / '), ...slide.table.rows.map(row => row.join(' / '))] : []),
    slide.chart
      ? `グラフ: ${slide.chart.categories.join('、')}（${slide.chart.series.map(s => `${s.name}: ${s.values.join('、')}`).join(' / ')}${slide.chart.unit ? ` ${slide.chart.unit}` : ''}）`
      : undefined,
    slide.chart?.caption,
    slide.equation?.text,
    slide.equation?.explanation,
  ]
    .filter((value): value is string => !!value && !!value.trim())
    .join('\n');
}
export function deckRehearsalSlides(deck: DeckSpec): RehearsalSlide[] {
  return deck.slides.map(slide => ({ id: slide.id, title: slide.title, text: slideText(slide) }));
}

/** Splits the total time by the amount of content on each slide. The cover and
 * short pages get less time; charts and tables get extra time to read. */
export function allocateTime(
  slides: RehearsalSlide[],
  totalSeconds: number,
  hints: { cover?: boolean; visual?: boolean }[] = [],
): number[] {
  if (!slides.length) return [];
  const weights = slides.map((slide, i) => {
    const characters = (slide.title + slide.text).replace(/\s/g, '').length;
    if (hints[i]?.cover ?? (i === 0 && slides.length > 1 && characters < 80)) return 0.45;
    return 1 + Math.min(2.5, characters / 220) + (hints[i]?.visual ? 0.5 : 0);
  });
  return rescaleSeconds(weights, totalSeconds);
}

/** Proportional split of the total in 5-second (15 for 10 min+) steps whose sum
 * is exactly the total; rounding differences go to the heaviest pages. */
export function rescaleSeconds(weights: number[], totalSeconds: number): number[] {
  const sum = weights.reduce((a, b) => a + b, 0) || 1,
    step = totalSeconds >= 600 ? 15 : 5;
  const seconds = weights.map(weight => Math.max(step, Math.round((totalSeconds * weight) / sum / step) * step));
  let difference = totalSeconds - seconds.reduce((a, b) => a + b, 0);
  const order = weights.map((_, i) => i).sort((a, b) => weights[b] - weights[a]);
  for (let k = 0; difference !== 0 && k < order.length * 60; k++) {
    const i = order[k % order.length],
      delta = Math.sign(difference) * Math.min(step, Math.abs(difference));
    if (seconds[i] + delta >= Math.min(step, 1)) {
      seconds[i] += delta;
      difference -= delta;
    }
  }
  return seconds;
}

/** A plan without AI: time allocation plus a speaking outline from the slide text. */
export function localRehearsal(
  slides: RehearsalSlide[],
  totalSeconds: number,
  hints: { cover?: boolean; visual?: boolean }[] = [],
): RehearsalPlan {
  const seconds = allocateTime(slides, totalSeconds, hints);
  return {
    totalSeconds,
    generated: 'local',
    questions: [],
    slides: slides.map((slide, i) => {
      const points = slide.text
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)
        .slice(0, 4);
      const notes =
        i === 0 && hints[i]?.cover !== false && points.length <= 1
          ? `「${slide.title}」について、目的と聞き手に伝えたいことを最初に述べます。`
          : [`「${slide.title}」`, ...points.map(point => `・${point}`)].join('\n');
      return { id: slide.id, title: slide.title, seconds: seconds[i], notes };
    }),
  };
}

export function formatDuration(seconds: number) {
  const m = Math.floor(seconds / 60),
    s = seconds % 60;
  return m ? `${m}分${s ? `${String(s).padStart(2, '0')}秒` : ''}` : `${s}秒`;
}
