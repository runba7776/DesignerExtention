import type { ChartSpec, FreeElement, SlideSpec, TableSpec } from './contracts';

/** Content and design of a slide, kept apart so one slide's content can be set in
 * another slide's design (combining drafts of different AIs), and so a design can be
 * requested with placeholders only (designs that never receive confidential text). */
export type SlotRole = 'heading' | 'number' | 'body' | 'caption';
export interface ContentSlot {
  role: SlotRole;
  text: string;
  refs?: number[];
}
export interface SlideContent {
  title: string;
  texts: ContentSlot[];
  charts: ChartSpec[];
  tables: TableSpec[];
}
type TextElement = Extract<FreeElement, { t: 'text' }>;

const readingOrder = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.abs(a.y - b.y) > 8 ? a.y - b.y : a.x - b.x;
const isTitle = (e: TextElement, slide: SlideSpec) =>
  e.role === 'title' || (slide.layoutId === 'cover' && e.text === slide.title);
/** Indexes of text elements in reading order: the texts of one card (the smallest
 * filled or framed box around them) stay together, cards and loose texts are read
 * top to bottom, then left to right. */
function textOrder(elements: FreeElement[], indexes: number[]) {
  const boxes = elements
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => e.t === 'box' && (e.fill !== 'none' || !!e.line)) as {
    e: Extract<FreeElement, { t: 'box' }>;
    i: number;
  }[];
  const groups = new Map<string, { x: number; y: number; items: number[] }>();
  for (const index of indexes) {
    const t = elements[index] as TextElement,
      cx = t.x + t.w / 2,
      cy = t.y + Math.min(t.h, t.size * 1.4) / 2;
    const box = boxes
      .filter(({ e }) => cx >= e.x && cx <= e.x + e.w && cy >= e.y && cy <= e.y + e.h && e.w * e.h < 940 * 520)
      .sort((a, b) => a.e.w * a.e.h - b.e.w * b.e.h)[0];
    const key = box ? `box${box.i}` : `text${index}`,
      group = groups.get(key) ?? { x: box ? box.e.x : t.x, y: box ? box.e.y : t.y, items: [] };
    group.items.push(index);
    groups.set(key, group);
  }
  return [...groups.values()]
    .sort(readingOrder)
    .flatMap(g => g.items.sort((a, b) => readingOrder(elements[a] as TextElement, elements[b] as TextElement)));
}

/** What a slide says, independent of how it is laid out (reading order). */
export function slideContent(slide: SlideSpec): SlideContent {
  if (slide.design) {
    const elements = slide.design.elements;
    const texts = textOrder(
      elements,
      elements.flatMap((e, i) => (e.t === 'text' && !isTitle(e, slide) ? [i] : [])),
    )
      .map(i => elements[i] as TextElement)
      .map(e => ({
        role: (e.role === 'title' || !e.role ? 'body' : e.role) as SlotRole,
        text: e.text,
        ...(e.refs?.length ? { refs: e.refs } : {}),
      }));
    return {
      title: slide.title,
      texts,
      charts: elements.flatMap(e => (e.t === 'chart' ? [e.chart] : [])),
      tables: elements.flatMap(e => (e.t === 'table' ? [{ headers: e.headers, rows: e.rows }] : [])),
    };
  }
  const texts: ContentSlot[] = [];
  const add = (role: SlotRole, text?: string, refs?: number[]) => {
    if (text && text.trim()) texts.push({ role, text, ...(refs?.length ? { refs } : {}) });
  };
  add('body', slide.headline);
  add('body', slide.body);
  for (const item of [...slide.items, ...(slide.diagram?.items ?? [])]) {
    add('heading', item.label, item.refs);
    add('number', item.value);
    add('body', item.description);
  }
  add('body', slide.equation?.text);
  add('caption', slide.equation?.explanation);
  return {
    title: slide.title,
    texts,
    charts: slide.chart ? [slide.chart] : [],
    tables: slide.table ? [slide.table] : [],
  };
}

/** Places of a designed slide that hold content, in reading order. */
export function designSlots(slide: SlideSpec) {
  const elements = slide.design?.elements ?? [];
  const indexed = elements.map((e, index) => ({ e, index }));
  return {
    title: indexed.find(({ e }) => e.t === 'text' && isTitle(e, slide))?.index,
    texts: textOrder(
      elements,
      indexed.filter(({ e }) => e.t === 'text' && !isTitle(e as TextElement, slide)).map(({ index }) => index),
    ).map(index => {
      const e = elements[index] as TextElement;
      return { index, role: (e.role === 'title' || !e.role ? 'body' : e.role) as SlotRole };
    }),
    charts: indexed.filter(({ e }) => e.t === 'chart').map(({ index }) => index),
    tables: indexed.filter(({ e }) => e.t === 'table').map(({ index }) => index),
  };
}

export type TransplantResult =
  | { slide: SlideSpec; method: 'role' | 'order'; reason?: undefined }
  | { slide?: undefined; method?: undefined; reason: string };
/** Sets the content of `content` in the design of `design`. Texts go to places of the
 * same role (or, when only the total matches, in reading order); charts and tables go
 * to the design's charts and tables. Nothing is invented and nothing is dropped: when
 * the places do not match one to one the result is a reason instead of a slide. */
export function transplant(content: SlideSpec, design: SlideSpec): TransplantResult {
  if (!design.design) return { reason: 'デザイン側のページが型で作られているため、配置を取り出せません。' };
  const source = slideContent(content),
    slots = designSlots(design);
  if (source.charts.length !== slots.charts.length)
    return { reason: `グラフの数が違います（内容${source.charts.length}・デザイン${slots.charts.length}）。` };
  if (source.tables.length !== slots.tables.length)
    return { reason: `表の数が違います（内容${source.tables.length}・デザイン${slots.tables.length}）。` };
  if (source.texts.length !== slots.texts.length)
    return { reason: `文章の数が違います（内容${source.texts.length}・デザイン${slots.texts.length}）。` };
  const roles: SlotRole[] = ['heading', 'number', 'body', 'caption'];
  const byRole = roles.every(
    role => source.texts.filter(t => t.role === role).length === slots.texts.filter(s => s.role === role).length,
  );
  const assignment = new Map<number, ContentSlot>();
  if (byRole)
    for (const role of roles) {
      const texts = source.texts.filter(t => t.role === role);
      slots.texts.filter(s => s.role === role).forEach((slot, i) => assignment.set(slot.index, texts[i]));
    }
  else slots.texts.forEach((slot, i) => assignment.set(slot.index, source.texts[i]));
  const elements = structuredClone(design.design.elements)
    .map((e, index): FreeElement => {
      if (e.t === 'text') {
        if (index === slots.title) return { ...e, text: source.title, refs: undefined };
        const value = assignment.get(index);
        if (!value) return e;
        const { refs: _refs, ...rest } = e;
        return { ...rest, text: value.text, ...(value.refs?.length ? { refs: value.refs } : {}) };
      }
      if (e.t === 'chart') return { ...e, chart: structuredClone(source.charts[slots.charts.indexOf(index)]) };
      if (e.t === 'table') {
        const table = source.tables[slots.tables.indexOf(index)];
        return { ...e, headers: [...table.headers], rows: table.rows.map(r => [...r]) };
      }
      return e;
    })
    .map(e => (e.t === 'text' && e.refs === undefined ? ((({ refs: _r, ...rest }) => rest)(e) as FreeElement) : e));
  const slide: SlideSpec = {
    id: content.id,
    title: content.title,
    layoutId: content.layoutId === 'cover' ? 'cover' : 'free',
    items: [],
    notes: content.notes,
    sources: structuredClone(content.sources),
    design: { ...(design.design.background ? { background: design.design.background } : {}), elements },
  };
  return { slide, method: byRole ? 'role' : 'order' };
}
