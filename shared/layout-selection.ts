import type { DeckSpec, FreeDesign, FreeElement, SlideSpec, SceneSlide, TextElement } from './contracts';
import { citationMarker, compileDeck, listLayouts, measureText, wrapText } from './layouts';
import { designMarkedText, designTextBox, FOOTER_TOP, SLIDE_H, SLIDE_W } from './free-design';

const clean = (s: string) => s.replace(/\s/g, '');
function fields(slide: SlideSpec): string[] {
  return [
    slide.title,
    slide.headline,
    slide.body,
    ...slide.items.flatMap(i => [i.label, i.description, i.value]),
    ...(slide.diagram?.items.flatMap(i => [i.label, i.description, i.value]) ?? []),
    ...(slide.table?.headers ?? []),
    ...(slide.table?.rows.flat() ?? []),
    slide.equation?.text,
    slide.equation?.explanation,
    slide.chart?.caption,
  ].filter((s): s is string => !!s);
}
function visible(scene: SceneSlide) {
  return clean(
    scene.elements
      .flatMap(e =>
        e.kind === 'text'
          ? [e.text]
          : e.kind === 'smartart'
            ? e.items.flatMap(i => [i.label, i.description ?? ''])
            : [],
      )
      .join('\n'),
  );
}
export function inspectSlide(deck: DeckSpec, slide: SlideSpec) {
  return compileDeck({ ...deck, slides: [slide] }).slides[0];
}
export function fittingLayouts(deck: DeckSpec, slide: SlideSpec, includeOverflow = false) {
  const current = listLayouts().find(l => l.id === slide.layoutId);
  if (!current) return [];
  const sourceScene = inspectSlide(deck, slide),
    sourceText = visible(sourceScene);
  const required = fields(slide).filter(text => sourceText.includes(clean(text)));
  return listLayouts().filter(candidate => {
    if (candidate.id !== slide.layoutId && candidate.autoSelect === false) return false;
    const group = slide.table ? 'table' : slide.chart ? 'chart' : slide.equation ? 'concept' : current.group;
    if (group === 'table' ? !candidate.table : group === 'chart' ? !candidate.chart : candidate.group !== group)
      return false;
    if (slide.items.length > candidate.maxItems || slide.items.length < candidate.minItems) return false;
    if (
      slide.diagram &&
      (!candidate.diagram ||
        candidate.diagramType !== slide.diagram.type ||
        slide.diagram.items.length > candidate.maxItems)
    )
      return false;
    if (slide.table && candidate.tableMaxRows && slide.table.rows.length > candidate.tableMaxRows) return false;
    if (slide.equation && !candidate.equation) return false;
    const scene = inspectSlide(deck, { ...slide, layoutId: candidate.id });
    if (!includeOverflow && scene.textIssues?.length) return false;
    const text = visible(scene);
    // A local layout switch may not quietly move previously visible facts to notes.
    if (!required.every(value => text.includes(clean(value)))) return false;
    if (slide.chart && !scene.elements.some(e => e.kind === 'chart')) return false;
    if (slide.diagram && !scene.elements.some(e => e.kind === 'smartart')) return false;
    return true;
  });
}
function tie(seed: string, id: string) {
  let h = 2166136261;
  for (const ch of seed + id) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296;
}
/** Prefer a visible hierarchy, without creating an unsupported ranking of items. */
export function visualHierarchyScore(scene: SceneSlide) {
  const texts = scene.elements.filter((e): e is TextElement => e.kind === 'text' && e.y >= 150 && e.y < 490);
  const bodies = texts
    .filter(e => e.role === 'body')
    .map(e => e.fontSize)
    .sort((a, b) => a - b);
  const body = bodies[Math.floor(bodies.length / 2)] ?? 18;
  const labels = texts.filter(e => e.role === 'label'),
    values = texts.filter(e => e.role === 'number' && e.noWrap);
  const label = labels.length ? Math.min(...labels.map(e => e.fontSize)) : body;
  const value = values.length ? Math.min(...values.map(e => e.fontSize)) : body;
  const containers = scene.elements.filter(e => e.kind === 'shape' && e.y >= 150 && e.w >= 140 && e.h >= 55).length;
  return (
    Math.max(0, Math.min(4, (label / body - 1) * 12)) +
    (values.length ? Math.max(0, Math.min(7, (value / body - 1) * 8)) : 0) +
    Math.min(2, containers * 0.5)
  );
}
/** Stable within a generation/retry; a new generation uses a new seed. */
export function diversifyDeck(deck: DeckSpec, seed: string, recent: string[] = []): DeckSpec {
  const used = new Map<string, number>(),
    history = new Map<string, number>();
  recent.slice(-128).forEach(id => history.set(id, (history.get(id) ?? 0) + 1));
  const slides = deck.slides.map((slide, index) => {
    if (index === 0 || slide.layoutId === 'cover') return structuredClone(slide);
    const options = fittingLayouts(deck, slide);
    if (!options.length) return structuredClone(slide);
    // Explicitly selected priority/relationship grammars are not generalized.
    if (listLayouts().find(l => l.id === slide.layoutId)?.autoSelect === false) return structuredClone(slide);
    const scores = new Map(
      options.map(({ id }) => [
        id,
        (used.get(id) ?? 0) * 100 +
          (history.get(id) ?? 0) * 2 +
          tie(`${seed}:${index}`, id) * 6 -
          visualHierarchyScore(inspectSlide(deck, { ...slide, layoutId: id })),
      ]),
    );
    options.sort((a, b) => scores.get(a.id)! - scores.get(b.id)!);
    const id = options[0].id;
    used.set(id, (used.get(id) ?? 0) + 1);
    return { ...structuredClone(slide), layoutId: id };
  });
  return { ...deck, slides };
}

/** Prefer a roomier compatible layout before paying for summarization. */
/** An AI-designed text a little long for its box is set smaller (to 75%, never below
 * 10pt) here, so a few extra characters never cost an AI call to shorten the wording.
 * Boxes, positions and the words stay as the AI wrote them. */
type DesignText = Extract<FreeElement, { t: 'text' }>;
type Box = { x: number; y: number; w: number; h: number };
/** How small a designed text may become: large numbers and titles keep presence,
 * body text stays readable. Forced (the user's "finish with smaller text") goes further. */
function floorOf(e: DesignText, force: boolean) {
  if (force) return Math.max(8, Math.floor(e.size * 0.5));
  return e.role === 'number'
    ? Math.max(14, Math.floor(e.size * 0.6))
    : e.role === 'title'
      ? Math.max(18, Math.floor(e.size * 0.7))
      : Math.max(10, Math.floor(e.size * 0.75));
}
const boxOf = (e: FreeElement): Box | undefined =>
  e.t === 'icon'
    ? { x: e.x, y: e.y, w: e.size, h: e.size }
    : e.t === 'line'
      ? undefined
      : { x: e.x, y: e.y, w: e.w, h: e.h };
const meets = (a: Box, b: Box) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
/** The boxes a designed text may grow into: wider (by its alignment) and taller (by its
 * vertical alignment), within its card (the smallest filled or framed shape around it)
 * or the slide's content area, never over another text, chart, table, icon or card. */
function growthOptions(e: DesignText, design: FreeDesign): Box[] {
  const cx = e.x + e.w / 2,
    cy = e.y + Math.min(e.h, e.size * 1.4) / 2,
    inside = (o: Box) => cx >= o.x && cx <= o.x + o.w && cy >= o.y && cy <= o.y + o.h;
  const card = design.elements
    .filter(
      (o): o is Extract<FreeElement, { t: 'box' }> =>
        o.t === 'box' && (o.fill !== 'none' || !!o.line) && o.w * o.h < SLIDE_W * SLIDE_H * 0.9 && inside(o),
    )
    .sort((a, b) => a.w * a.h - b.w * b.h)[0];
  const area = card
    ? { x0: card.x + 6, y0: card.y + 6, x1: card.x + card.w - 6, y1: Math.min(card.y + card.h - 6, FOOTER_TOP) }
    : { x0: 24, y0: 16, x1: SLIDE_W - 24, y1: FOOTER_TOP - 2 };
  const own = { x: e.x, y: e.y, w: e.w, h: e.h };
  // Shapes already under or around the text are part of its design, not obstacles.
  const obstacles = design.elements
    .filter(o => o !== e && o !== card && o.t !== 'line' && (o.t !== 'box' || o.fill !== 'none' || !!o.line))
    .map(boxOf)
    .filter((b): b is Box => !!b && !meets(b, own) && !(b.w * b.h >= SLIDE_W * SLIDE_H * 0.9));
  const x0 = Math.min(
    e.x,
    Math.max(
      area.x0,
      ...obstacles.filter(b => b.y < e.y + e.h && b.y + b.h > e.y && b.x + b.w <= e.x).map(b => b.x + b.w + 6),
    ),
  );
  const x1 = Math.max(
    e.x + e.w,
    Math.min(
      area.x1,
      ...obstacles.filter(b => b.y < e.y + e.h && b.y + b.h > e.y && b.x >= e.x + e.w).map(b => b.x - 6),
    ),
  );
  const align = e.align ?? 'l',
    grow = align === 'c' ? Math.min(e.x - x0, x1 - e.x - e.w) : 0;
  const wide: Box =
    align === 'l'
      ? { ...own, w: x1 - e.x }
      : align === 'r'
        ? { ...own, x: x0, w: e.x + e.w - x0 }
        : { ...own, x: e.x - grow, w: e.w + grow * 2 };
  const taller = (b: Box): Box => {
    const y0 = Math.min(
      b.y,
      Math.max(
        area.y0,
        ...obstacles.filter(o => o.x < b.x + b.w && o.x + o.w > b.x && o.y + o.h <= b.y).map(o => o.y + o.h + 4),
      ),
    );
    const y1 = Math.max(
      b.y + b.h,
      Math.min(
        area.y1,
        ...obstacles.filter(o => o.x < b.x + b.w && o.x + o.w > b.x && o.y >= b.y + b.h).map(o => o.y - 4),
      ),
    );
    const va = e.va ?? 't',
      up = va === 'm' ? Math.min(b.y - y0, y1 - b.y - b.h) : 0;
    return va === 't'
      ? { ...b, h: y1 - b.y }
      : va === 'b'
        ? { ...b, y: y0, h: b.y + b.h - y0 }
        : { ...b, y: b.y - up, h: b.h + up * 2 };
  };
  return [own, taller(own), wide, taller(wide)];
}
/** A designed text that does not fit is first given room it can take, then set smaller
 * down to its floor; the larger the text can stay, the better. Only the needed room is
 * taken. The words always stay as the AI wrote them. */
function fitDesignText(slide: SlideSpec, force = false): SlideSpec {
  if (!slide.design) return slide;
  let design = slide.design;
  design.elements.forEach((original, index) => {
    const e = design.elements[index];
    if (e.t !== 'text' || e.exact || original.t !== 'text') return;
    const text = designMarkedText(e, citationMarker);
    const fits = (box: Box, size: number) => {
      const candidate: DesignText = { ...e, ...box, size },
        next = { ...design, elements: design.elements.map((o, i) => (i === index ? candidate : o)) };
      return !measureText(text, designTextBox(candidate, next, text, wrapText), size).overflow;
    };
    if (fits(e, e.size)) return;
    const options = growthOptions(e, design);
    for (let size = e.size; size >= floorOf(e, force); size--) {
      const box = options.find(b => fits(b, size));
      if (!box) continue;
      // Take only the room needed: trim the grown width and height back while it still fits.
      let chosen = { ...box };
      for (const key of ['w', 'h'] as const) {
        const minimum = e[key];
        let low = minimum,
          high = chosen[key];
        while (high - low > 1) {
          const mid = (low + high) / 2,
            trial = {
              ...chosen,
              [key]: mid,
              ...(key === 'w' && (e.align ?? 'l') === 'r' ? { x: chosen.x + chosen.w - mid } : {}),
              ...(key === 'h' && (e.va ?? 't') === 'b' ? { y: chosen.y + chosen.h - mid } : {}),
            };
          if (fits(trial, size)) high = mid;
          else low = mid;
        }
        const fitted = Math.ceil(high);
        chosen = {
          ...chosen,
          [key]: fitted,
          ...(key === 'w' && (e.align ?? 'l') === 'r' ? { x: chosen.x + chosen.w - fitted } : {}),
          ...(key === 'h' && (e.va ?? 't') === 'b' ? { y: chosen.y + chosen.h - fitted } : {}),
        };
        if (!fits(chosen, size)) chosen = { ...chosen, [key]: box[key], x: box.x, y: box.y };
      }
      design = { ...design, elements: design.elements.map((o, i) => (i === index ? { ...e, ...chosen, size } : o)) };
      return;
    }
  });
  return { ...slide, design };
}
/** Overflowing text resolved without an AI: a roomier compatible layout for a template
 * page; room and smaller type for an AI-designed one (force: down to half size). */
export function improveTextFit(deck: DeckSpec, force = false): DeckSpec {
  return {
    ...deck,
    slides: deck.slides.map(slide => {
      if (!inspectSlide(deck, slide).textIssues?.length) return slide;
      if (slide.design) return fitDesignText(slide, force);
      const candidate = fittingLayouts(deck, slide)[0];
      return candidate ? { ...slide, layoutId: candidate.id } : slide;
    }),
  };
}
export function candidateLayoutIds(ids: string[]) {
  const all = listLayouts(),
    groups = new Set(ids.map(id => all.find(l => l.id === id)?.group));
  return all.filter(l => ids.includes(l.id) || groups.has(l.group)).map(l => l.id);
}
