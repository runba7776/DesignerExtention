import type { DeckSpec, FreeElement, SlideSpec, TextRun } from './contracts';
import { BLANK, designTexts } from './free-design';
import { wrapText } from './layouts';

/** Blanks (［実施日］) are what the AI writes instead of an empty date or a note to the maker; the app
 * marks them in a colour (free-design), lists them, and fills them with what the user types (no AI). */
export { BLANK };
/** The name of a blank, as listed and filled: spacing and line breaks inside it do not count. */
export const blankLabel = (raw: string) => raw.replace(/\s+/g, '');
export interface DeckBlank {
  label: string;
  pages: number[];
}

/** Every text of a slide the reader sees (not the notes). */
export function visibleTexts(slide: SlideSpec): string[] {
  return [
    slide.title,
    slide.headline,
    slide.body,
    ...slide.items.flatMap(i => [i.label, i.description, i.value]),
    ...(slide.diagram?.items.flatMap(i => [i.label, i.description, i.value]) ?? []),
    ...(slide.table?.headers ?? []),
    ...(slide.table?.rows.flat() ?? []),
    slide.chart?.caption,
    slide.equation?.explanation,
    ...designTexts(slide),
  ].filter((v): v is string => typeof v === 'string' && !!v);
}
export function blanksIn(text: string) {
  return [...text.matchAll(BLANK)].map(m => blankLabel(m[1])).filter(Boolean);
}
/** The blanks left in a deck, in the order they first appear, with the pages (1-based) that show them. */
export function deckBlanks(deck: DeckSpec): DeckBlank[] {
  const found = new Map<string, Set<number>>();
  deck.slides.forEach((slide, index) => {
    for (const text of visibleTexts(slide))
      for (const label of blanksIn(text)) {
        if (!found.has(label)) found.set(label, new Set());
        found.get(label)!.add(index + 1);
      }
  });
  return [...found].map(([label, pages]) => ({ label, pages: [...pages] }));
}

/** The text with its blanks filled, and where each filled blank was, so styled parts can follow. */
function fillText(text: string, values: Map<string, string>) {
  const edits: { start: number; end: number; length: number }[] = [];
  let out = '',
    at = 0;
  for (const m of text.matchAll(BLANK)) {
    const value = values.get(blankLabel(m[1]));
    if (value === undefined) continue;
    out += text.slice(at, m.index) + value;
    edits.push({ start: m.index!, end: m.index! + m[0].length, length: value.length });
    at = m.index! + m[0].length;
  }
  return { text: out + text.slice(at), edits };
}
/** A position in the old text moved to the new one (a position inside a filled blank goes to its edge). */
function moved(position: number, edits: { start: number; end: number; length: number }[], end: boolean) {
  let shift = 0;
  for (const e of edits) {
    if (position >= e.end) {
      shift += e.length - (e.end - e.start);
      continue;
    }
    if (position > e.start) return e.start + shift + (end ? e.length : 0);
    break;
  }
  return position + shift;
}
/** The styled parts of a browser-measured text after its blanks are filled (a filled blank's own colour is
 * dropped), or null when a line holding a filled blank no longer fits the measured width. */
function refit(
  before: string,
  filled: ReturnType<typeof fillText>,
  runs: TextRun[] | undefined,
  width: number,
  size: number,
) {
  const { text, edits } = filled;
  const changed = new Set(edits.map(x => before.slice(0, x.start).split('\n').length - 1));
  if (text.split('\n').some((line, i) => changed.has(i) && wrapText(line, width, size).length > 1)) return null;
  return (runs ?? [])
    .filter(run => !edits.some(x => x.start === run.s && x.end === run.s + run.l))
    .map(run => {
      const s = moved(run.s, edits, false),
        end = moved(run.s + run.l, edits, true);
      return { ...run, s, l: end - s };
    })
    .filter(run => run.l > 0);
}
/** Fills one designed text. A browser-measured text keeps its lines when the filled lines still fit their
 * box; otherwise it becomes a text the app wraps and fits like any other (its styled parts are dropped).
 * A table read from a page keeps its look the same way, while every filled cell fits its column. */
function fillElement(e: FreeElement, values: Map<string, string>): FreeElement {
  if (e.t === 'table') {
    const before = [e.headers, ...e.rows],
      filled = before.map(row => row.map(cell => fillText(cell, values)));
    const table = { ...e, headers: filled[0].map(f => f.text), rows: filled.slice(1).map(row => row.map(f => f.text)) };
    if (!e.cells || !e.cols) return table;
    const cols = e.cols,
      cells = e.cells.map(row => [...row]);
    let fits = true;
    e.cells.forEach((row, r) =>
      row.forEach((look, c) => {
        if (!filled[r][c].edits.length) return;
        const runs = refit(
          before[r][c],
          filled[r][c],
          look.runs,
          cols[c] - (look.pad?.[0] ?? 0) - (look.pad?.[2] ?? 0),
          look.size,
        );
        if (runs) cells[r][c] = { ...look, runs: runs.length ? runs : undefined };
        else fits = false;
      }),
    );
    if (fits) return { ...table, cells };
    const { cells: _cells, cols: _cols, rowH: _rowH, ...plain } = table;
    return plain;
  }
  if (e.t === 'chart')
    return {
      ...e,
      chart: { ...e.chart, ...(e.chart.caption ? { caption: fillText(e.chart.caption, values).text } : {}) },
    };
  if (e.t !== 'text') return e;
  const filled = fillText(e.text, values);
  if (!filled.edits.length) return e;
  if (!e.exact) return { ...e, text: filled.text };
  const runs = refit(e.text, filled, e.runs, e.w, e.size);
  if (!runs) {
    const { exact: _exact, lh: _lh, runs: _runs, ...rest } = e;
    return { ...rest, text: filled.text };
  }
  return { ...e, text: filled.text, ...(runs.length ? { runs } : { runs: undefined }) };
}
/** Fills the blanks named in values everywhere in the deck: slide texts, tables, captions and notes.
 * Returns the filled deck and the ids of the slides that changed. Empty values are left as blanks. */
export function fillBlanks(deck: DeckSpec, values: Record<string, string>): { deck: DeckSpec; changed: string[] } {
  const map = new Map(
    Object.entries(values)
      .map(([k, v]) => [blankLabel(k), v.trim()] as const)
      .filter(([k, v]) => k && v),
  );
  if (!map.size) return { deck, changed: [] };
  const changed: string[] = [];
  const fill = (text: string | undefined) => (text === undefined ? undefined : fillText(text, map).text);
  const slides = deck.slides.map(slide => {
    const next: SlideSpec = {
      ...slide,
      title: fill(slide.title)!,
      notes: fill(slide.notes)!,
      ...(slide.headline !== undefined ? { headline: fill(slide.headline) } : {}),
      ...(slide.body !== undefined ? { body: fill(slide.body) } : {}),
      items: slide.items.map(i => ({
        ...i,
        label: fill(i.label)!,
        ...(i.description !== undefined ? { description: fill(i.description) } : {}),
        ...(i.value !== undefined ? { value: fill(i.value) } : {}),
      })),
      ...(slide.diagram
        ? {
            diagram: {
              ...slide.diagram,
              items: slide.diagram.items.map(i => ({
                ...i,
                label: fill(i.label)!,
                ...(i.description !== undefined ? { description: fill(i.description) } : {}),
                ...(i.value !== undefined ? { value: fill(i.value) } : {}),
              })),
            },
          }
        : {}),
      ...(slide.table
        ? {
            table: {
              headers: slide.table.headers.map(h => fill(h)!),
              rows: slide.table.rows.map(r => r.map(c => fill(c)!)),
            },
          }
        : {}),
      ...(slide.chart?.caption ? { chart: { ...slide.chart, caption: fill(slide.chart.caption) } } : {}),
      ...(slide.design
        ? { design: { ...slide.design, elements: slide.design.elements.map(e => fillElement(e, map)) } }
        : {}),
    };
    if (JSON.stringify(next) !== JSON.stringify(slide)) changed.push(slide.id);
    return next;
  });
  return { deck: { ...deck, slides }, changed };
}

/** What a slide shows that was meant for its maker: an empty date written as spaces or marks, empty
 * brackets, or a note such as "confirm before writing". Each found text is returned once, shortened. */
const DRAFT_MARKS: [RegExp, 'blank' | 'memo'][] = [
  [/(?<![0-9０-９〇一二三四五六七八九十百])月[ 　]+日(?![曜])/, 'blank'],
  [/(?<![0-9０-９〇一二三四五六七八九十])時[ 　]+分/, 'blank'],
  [/[○〇●◯□■×✕＿]{1,3}[ 　]*[年月日時分]/, 'blank'],
  [/[（(][ 　]{0,3}[）)]/, 'blank'],
  [/[XＸ]{2,}|＿{3,}|_{3,}/, 'blank'],
  [/確認(?:して|の上|後に?)(?:から)?(?:記載|記入|差し替|更新|追記)/, 'memo'],
  [/(?:確定|決定)(?:後|次第)に?(?:記載|記入|差し替|更新|追記)/, 'memo'],
  [/仮置き|差し替え(?:る|ます|予定)|記入予定|後で記入|\bTBD\b|\bTODO\b/i, 'memo'],
];
export function draftMarks(slide: SlideSpec): { kind: 'blank' | 'memo'; sample: string }[] {
  const found = new Map<string, 'blank' | 'memo'>();
  for (const text of visibleTexts(slide).map(t => t.replace(BLANK, '')))
    for (const [pattern, kind] of DRAFT_MARKS) {
      const m = pattern.exec(text);
      if (m) {
        const at = Math.max(0, m.index - 4);
        found.set(
          text
            .slice(at, at + 16)
            .replace(/\s+/g, ' ')
            .trim(),
          kind,
        );
      }
    }
  return [...found].map(([sample, kind]) => ({ kind, sample }));
}
