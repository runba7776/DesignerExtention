import type {
  AiPalette,
  ChartSpec,
  ChartType,
  DeckSpec,
  FreeDesign,
  FreeElement,
  IconId,
  OpenFact,
  Outline,
  OutlineProposal,
  SlideSpec,
  SourceRef,
  Theme,
} from '../shared/contracts.js';
import { colorTokens, freeShapes, FREE_LAYOUT_ID, FOOTER_TOP, SLIDE_H, SLIDE_W } from '../shared/free-design.js';
import { dummyText, type DesignPacket, type SlotContent } from '../shared/confidential.js';
import { AppError } from './errors.js';
import { listLayouts } from '../shared/layouts.js';
import { MAX_SLIDES } from '../shared/contracts.js';
import { themes, TEMPLATE_THEME_ID } from '../shared/themes.js';
import { AI_THEME_ID } from '../shared/ai-theme.js';
import { typographyProfiles } from '../shared/typography.js';
import { iconCatalog } from '../shared/icons.js';
import { chartCatalog, chartDataProblem } from '../shared/charts.js';
import { blankLabel } from '../shared/blanks.js';

// Kept separate from orchestration so additional layout grammars can be registered centrally.
export const SUPPORTED_LAYOUTS = listLayouts().map(entry => entry.id);

function bad(message: string): never {
  throw new AppError(422, `生成内容を確認できません: ${message}`, 'INVALID_CONTENT');
}
function object(value: unknown, field: string): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) bad(`${field}の形式`);
  return value as Record<string, any>;
}
function text(value: unknown, field: string, max: number, optional = false): string | undefined {
  if ((value === undefined || value === null) && optional) return undefined;
  if (typeof value !== 'string' || (!optional && !value.trim()) || value.length > max) bad(`${field}は${max}文字以内`);
  return value;
}
function array(value: unknown, field: string, max: number): any[] {
  if (!Array.isArray(value) || value.length > max) bad(`${field}は${max}項目以内`);
  return value;
}
function stringList(value: unknown, field: string, max: number, length = 200): string[] {
  return array(value, field, max).map(v => text(v, field, length)!);
}
function layout(value: unknown): string {
  if (typeof value !== 'string' || !SUPPORTED_LAYOUTS.includes(value)) bad('未登録の図形文法');
  return value;
}
function mode(value: unknown): 'presentation' | 'reading' {
  if (value !== 'presentation' && value !== 'reading') bad('表示モード');
  return value;
}

export function validateOutline(value: unknown): Outline {
  const data = object(value, '構成案');
  const slides = array(data.slides, 'スライド', MAX_SLIDES).map((entry, index) => {
    const slide = object(entry, 'スライド');
    return {
      id: `slide-${index + 1}`,
      title: text(slide.title, '見出し', 70)!,
      intent: text(slide.intent, '役割', 240)!,
      layoutId: layout(slide.layoutId),
      keyPoints: stringList(slide.keyPoints ?? [], '要点', 5, 180),
      ...(slide.sourceIds ? { sourceIds: stringList(slide.sourceIds, '参照資料', 12, 100) } : {}),
    };
  });
  if (slides.length < 2) bad(`表紙を含め2〜${MAX_SLIDES}枚にしてください`);
  if (slides[0].layoutId !== 'cover') bad('1枚目は表紙です');
  if (slides.slice(1).some(slide => slide.layoutId === 'cover')) bad('表紙は1枚目だけです');
  const facts = openFacts(data.openFacts);
  return {
    title: text(data.title, '資料名', 100)!,
    mode: mode(data.mode),
    ...(data.themeId && data.themeId !== AI_THEME_ID ? { themeId: validateTheme(data.themeId) } : {}),
    ...(data.typographyId ? { typographyId: validateTypography(data.typographyId) } : {}),
    ...(data.inputBrief ? { inputBrief: text(data.inputBrief, '確認用の条件', 6000)! } : {}),
    ...(data.visualStyle ? { visualStyle: text(data.visualStyle, 'デザインの方針', 600)! } : {}),
    ...(palette(data.palette) ? { palette: palette(data.palette) } : {}),
    audience: text(data.audience, '対象者', 150, true),
    assumptions: stringList(data.assumptions ?? [], '前提', 8, 250),
    ...(facts.length ? { openFacts: facts } : {}),
    slides,
  };
}

/** The facts the deck needs that the request and documents do not give. Malformed entries are skipped
 * (the blanks on the slides still list them); names are kept without the blank's brackets. */
function openFacts(value: unknown): OpenFact[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>(),
    out: OpenFact[] = [];
  for (const entry of value.slice(0, 8)) {
    if (!entry || typeof entry !== 'object') continue;
    const raw = entry as Record<string, unknown>,
      label = typeof raw.label === 'string' ? blankLabel(raw.label.replace(/[［］\[\]]/g, '')).slice(0, 16) : '';
    if (!label || seen.has(label)) continue;
    seen.add(label);
    const hint = typeof raw.hint === 'string' && raw.hint.trim() ? raw.hint.trim().slice(0, 60) : undefined,
      given =
        typeof raw.value === 'string' && raw.value.trim()
          ? raw.value
              .trim()
              .replace(/[［］]/g, '')
              .slice(0, 80)
          : undefined;
    out.push({ label, ...(hint ? { hint } : {}), ...(given ? { value: given } : {}) });
    if (out.length >= 6) break;
  }
  return out;
}

/** The AI's palette for the deck. A malformed one is ignored (the theme is used
 * instead) rather than costing another request. */
function palette(value: unknown): AiPalette | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const p = value as Record<string, unknown>,
    hex = (v: unknown) =>
      typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v.trim()) ? v.trim().toUpperCase() : undefined;
  const colors = {
    background: hex(p.background),
    text: hex(p.text),
    muted: hex(p.muted),
    accent: hex(p.accent),
    accent2: hex(p.accent2),
  };
  if (Object.values(colors).some(c => !c)) return undefined;
  const font = (v: unknown) =>
    typeof v === 'string' && v.trim() && !/[\u0000-\u001f<>]/.test(v) ? v.trim().slice(0, 60) : undefined;
  return {
    ...(typeof p.name === 'string' && p.name.trim() ? { name: p.name.trim().slice(0, 40) } : {}),
    ...(colors as Omit<AiPalette, 'name' | 'surface'>),
    ...(hex(p.surface) ? { surface: hex(p.surface) } : {}),
    ...(font(p.headingFont) ? { headingFont: font(p.headingFont) } : {}),
    ...(font(p.bodyFont) ? { bodyFont: font(p.bodyFont) } : {}),
  };
}
export function validateTheme(value: unknown): string {
  if (typeof value !== 'string' || !Object.hasOwn(themes, value)) bad('未登録のテーマ');
  return value;
}
export function validateTypography(value: unknown): string {
  if (typeof value !== 'string' || !Object.hasOwn(typographyProfiles, value)) bad('未登録の書体');
  return value;
}

export function validateSlide(value: unknown, expectedId?: string): SlideSpec {
  const data = object(value, 'スライド');
  const layoutId = layout(data.layoutId);
  const maximum = listLayouts().find(entry => entry.id === layoutId)!.maxItems;
  const items = array(data.items ?? [], '図形の項目', maximum).map((entry, index) => {
    const item = object(entry, '項目');
    if (item.parent !== undefined && (!Number.isInteger(item.parent) || item.parent < 0 || item.parent >= index))
      bad('階層の親は先行する項目を指定してください');
    if (
      item.icon !== undefined &&
      (typeof item.icon !== 'string' || (item.icon !== 'none' && !Object.hasOwn(iconCatalog, item.icon)))
    )
      bad('未登録のアイコン');
    if (
      item.refs !== undefined &&
      (!Array.isArray(item.refs) ||
        item.refs.length > 5 ||
        item.refs.some((n: unknown) => !Number.isInteger(n) || (n as number) < 1 || (n as number) > 10))
    )
      bad('項目の出典番号は1から始まる番号で5件以内');
    return {
      label: text(item.label, '項目名', 65)!,
      description: text(item.description, '項目の説明', 170, true),
      value: text(item.value, '強調値', 40, true),
      ...(item.parent !== undefined ? { parent: item.parent } : {}),
      ...(item.icon !== undefined ? { icon: item.icon } : {}),
      ...(Array.isArray(item.refs) && item.refs.length ? { refs: [...new Set(item.refs as number[])] } : {}),
    };
  });
  const slide: SlideSpec = {
    id: expectedId ?? text(data.id, '識別子', 100)!,
    title: text(data.title, '見出し', 70)!,
    layoutId: layout(data.layoutId),
    headline: text(data.headline, '要旨', 150, true),
    body: text(data.body, '本文', 800, true),
    items,
    notes: text(data.notes ?? '', '発表者ノート', 4000, true) ?? '',
    sources: array(data.sources ?? [], '出典', 10).map((entry): SourceRef => {
      const source = object(entry, '出典');
      return {
        documentId: text(source.documentId, '資料ID', 100)!,
        locator: text(source.locator, '出典位置', 160)!,
        quote: text(source.quote, '引用', 500, true),
      };
    }),
  };
  if (data.chart !== undefined) slide.chart = chartSpec(data.chart);
  if (data.design !== undefined)
    slide.design = validateDesign(data.design, slide.sources.length, layoutId === 'cover', slide.title);
  else if (layoutId === FREE_LAYOUT_ID) bad('自由デザインのページ（layoutId:"free"）にはdesign.elementsが必要です');
  if (data.diagram !== undefined) {
    const diagram = object(data.diagram, '図解');
    if (!['process', 'cycle', 'hierarchy', 'list'].includes(diagram.type)) bad('SmartArtの種類');
    const checked = validateSlide({
      id: 'diagram-items',
      title: 'items',
      layoutId: 'hierarchy',
      items: diagram.items,
      sources: [],
      notes: '',
    });
    if (!checked.items.length) bad('図解の項目がありません');
    if (checked.items.length > maximum) bad(`この文法の図解は${maximum}項目以内です`);
    slide.diagram = { type: diagram.type, items: checked.items };
  }
  if (data.table !== undefined) {
    const table = object(data.table, '表');
    const headers = stringList(table.headers, '表の列', 4, 45);
    const rows = array(table.rows, '表の行', 5).map(row => stringList(row, '表のセル', 4, 100));
    if (!headers.length || !rows.length || rows.some(row => row.length !== headers.length))
      bad('表の列数が一致しません');
    slide.table = { headers, rows };
  }
  if (data.equation !== undefined) {
    const equation = object(data.equation, '数式');
    slide.equation = {
      text: text(equation.text, '数式', 160)!,
      explanation: text(equation.explanation, '数式の説明', 400, true),
    };
  }
  // Citation markers must point at a source of this slide.
  if ([...slide.items, ...(slide.diagram?.items ?? [])].some(item => item.refs?.some(n => n > slide.sources.length)))
    bad('項目の出典番号がスライドの出典の数を超えています');
  const grammar = listLayouts().find(item => item.id === slide.layoutId)!;
  if (slide.items.length < grammar.minItems) bad(`この構図には${grammar.minItems}項目以上必要です`);
  if (grammar.group === 'cause' && !slide.headline && !slide.body) bad('原因図には結果・問題の要旨が必要です');
  if (slide.chart && !grammar.chart) bad('グラフに対応した文法を使用してください');
  if (slide.table && !grammar.table) bad('表に対応した文法を使用してください');
  if (slide.chart && slide.table) bad('1枚にグラフと表を同時に指定しないでください');
  if (slide.equation && !grammar.equation) bad('数式に対応した文法を使用してください');
  if (slide.diagram && !grammar.diagram) bad('SmartArtに対応した文法を使用してください');
  if (slide.diagram && slide.diagram.type !== grammar.diagramType) bad('図形文法とSmartArtの種類が一致しません');
  if (slide.table && grammar.tableMaxRows && slide.table.rows.length > grammar.tableMaxRows)
    bad(`この表の構図は${grammar.tableMaxRows}行以内です`);
  if (
    ['process', 'hierarchy', 'cycle', 'timeline'].includes(slide.layoutId) &&
    !(slide.diagram?.items.length || slide.items.length)
  )
    bad('図解には項目が必要です');
  return slide;
}

function chartSpec(value: unknown): ChartSpec {
  const chart = object(value, 'グラフ');
  if (typeof chart.type !== 'string' || !Object.hasOwn(chartCatalog, chart.type)) bad('グラフ形式');
  const categories = stringList(chart.categories, 'グラフ項目', 8, 40);
  const series = array(chart.series, 'グラフ系列', 3).map(entry => {
    const series = object(entry, '系列');
    const values = array(series.values, '数値', 8);
    if (values.length !== categories.length || values.some(v => typeof v !== 'number' || !Number.isFinite(v)))
      bad('グラフの項目と数値の対応');
    return { name: text(series.name, '系列名', 45)!, values };
  });
  if (!categories.length || !series.length) bad('グラフのデータがありません');
  const result: ChartSpec = {
    type: chart.type as ChartType,
    categories,
    series,
    unit: text(chart.unit, '単位', 40, true),
    caption: text(chart.caption, 'グラフ注釈', 240, true),
  };
  const chartProblem = chartDataProblem(result);
  if (chartProblem) bad(chartProblem);
  return result;
}

const number = (value: unknown, field: string, min: number, max: number) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max)
    bad(`${field}は${min}〜${max}の数値`);
  return Math.round(value * 10) / 10;
};
/** Shares (corner radius, opacity) keep three decimals: a 6px corner on a 300px card is 0.02. */
const share = (value: unknown, field: string, min: number, max: number) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max)
    bad(`${field}は${min}〜${max}の数値`);
  return Math.round(value * 1000) / 1000;
};
const designColor = (value: unknown, field: string) => {
  if (value === undefined) return undefined;
  if (
    typeof value !== 'string' ||
    !((colorTokens as readonly string[]).includes(value) || value === 'none' || /^#[0-9a-f]{6}$/i.test(value))
  )
    bad(`${field}の色は${colorTokens.join('・')}・none・#RRGGBBのいずれか`);
  return value;
};
const oneOf = <T extends string>(value: unknown, allowed: readonly T[], field: string): T | undefined => {
  if (value === undefined) return undefined;
  if (!allowed.includes(value as T)) bad(`${field}は${allowed.join('・')}のいずれか`);
  return value as T;
};
const colorWords: Record<string, string> = {
  black: 'ink',
  text: 'ink',
  foreground: 'ink',
  primary: 'accent',
  secondary: 'accent2',
  background: 'bg',
  gray: 'muted',
  grey: 'muted',
  transparent: 'none',
};
const alignWords: Record<string, string> = { left: 'l', center: 'c', centre: 'c', middle: 'c', right: 'r' };
const vAlignWords: Record<string, string> = { top: 't', middle: 'm', center: 'm', centre: 'm', bottom: 'b' };
const shapeWords: Record<string, string> = {
  rectangle: 'rect',
  square: 'rect',
  rounded: 'roundRect',
  roundedrect: 'roundRect',
  roundrect: 'roundRect',
  circle: 'ellipse',
  oval: 'ellipse',
  ring: 'donut',
};
/** Technical slips that would otherwise cost a whole regeneration are fixed here:
 * a few points past the slide edge or into the footer, synonyms for colours,
 * alignment and shapes, an unknown icon (dropped), citation numbers that do not
 * exist (dropped), numbers written as strings in a chart, and a title without its
 * role. Positions, sizes and colours the AI chose are otherwise kept as they are. */
function lenientDesign(data: Record<string, any>, cover: boolean, title?: string) {
  if (!Array.isArray(data.elements)) return data;
  const near = 24,
    round = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) ? Math.round(n * 10) / 10 : n);
  const color = (value: unknown) => {
    if (typeof value !== 'string') return value;
    const v = value.trim();
    if (/^#[0-9a-f]{3}$/i.test(v)) return '#' + [...v.slice(1)].map(c => c + c).join('');
    if (/^#[0-9a-f]{6}$/i.test(v) || (colorTokens as readonly string[]).includes(v) || v === 'none') return v;
    return colorWords[v.toLowerCase()];
  };
  const elements = (structuredClone(data.elements) as any[]).flatMap(e => {
    if (!e || typeof e !== 'object') return [e];
    for (const key of ['x', 'y', 'w', 'h', 'x1', 'y1', 'x2', 'y2', 'size']) if (key in e) e[key] = round(e[key]);
    for (const key of ['color', 'fill', 'line'])
      if (key in e) {
        const c = color(e[key]);
        if (c === undefined) delete e[key];
        else e[key] = c;
      }
    if (typeof e.align === 'string' && alignWords[e.align.toLowerCase()]) e.align = alignWords[e.align.toLowerCase()];
    if (typeof e.va === 'string' && vAlignWords[e.va.toLowerCase()]) e.va = vAlignWords[e.va.toLowerCase()];
    if (typeof e.shape === 'string' && !(freeShapes as readonly string[]).includes(e.shape)) {
      const s = shapeWords[e.shape.toLowerCase()];
      if (s) e.shape = s;
      else delete e.shape;
    }
    if (e.t === 'icon' && (typeof e.icon !== 'string' || !Object.hasOwn(iconCatalog, e.icon))) return [];
    if (e.t === 'text' && e.role !== undefined && !['title', 'heading', 'body', 'number', 'caption'].includes(e.role))
      delete e.role;
    if (e.t === 'text' && typeof e.size === 'number') e.size = Math.min(110, Math.max(9, e.size));
    if (typeof e.lw === 'number') e.lw = Math.min(12, Math.max(e.t === 'line' ? 0.25 : 0, e.lw));
    if (typeof e.op === 'number') e.op = Math.min(1, Math.max(0, e.op));
    if (typeof e.r === 'number') e.r = Math.min(0.5, Math.max(0, e.r));
    const box =
      ['text', 'box', 'chart', 'table'].includes(e.t) && [e.x, e.y, e.w, e.h].every(n => typeof n === 'number');
    if (box) {
      if (e.x < 0 && e.x >= -near) {
        e.w += e.x;
        e.x = 0;
      }
      if (e.y < 0 && e.y >= -near) {
        e.h += e.y;
        e.y = 0;
      }
      if (e.x + e.w > SLIDE_W && e.x + e.w <= SLIDE_W + near) e.w = round(SLIDE_W - e.x);
      if (e.y + e.h > SLIDE_H && e.y + e.h <= SLIDE_H + near) e.h = round(SLIDE_H - e.y);
      // Text reaching a little into the footer keeps at least one line above it.
      if (
        e.t === 'text' &&
        e.y + e.h > FOOTER_TOP &&
        e.y + e.h <= FOOTER_TOP + near &&
        FOOTER_TOP - e.y >= (typeof e.size === 'number' ? e.size : 12) * 1.35
      )
        e.h = round(FOOTER_TOP - e.y);
    }
    if (e.t === 'line')
      for (const [key, max] of [
        ['x1', SLIDE_W],
        ['x2', SLIDE_W],
        ['y1', SLIDE_H],
        ['y2', SLIDE_H],
      ] as const)
        if (typeof e[key] === 'number' && ((e[key] < 0 && e[key] >= -near) || (e[key] > max && e[key] <= max + near)))
          e[key] = Math.min(max, Math.max(0, e[key]));
    if (e.t === 'icon' && typeof e.size === 'number' && typeof e.x === 'number' && typeof e.y === 'number') {
      if (e.x + e.size > SLIDE_W && e.x + e.size <= SLIDE_W + near) e.x = SLIDE_W - e.size;
      if (e.y + e.size > SLIDE_H && e.y + e.size <= SLIDE_H + near) e.y = SLIDE_H - e.size;
    }
    if (e.t === 'chart' && e.chart && Array.isArray(e.chart.series))
      for (const series of e.chart.series)
        if (series && Array.isArray(series.values))
          series.values = series.values.map((v: unknown) =>
            typeof v === 'string' && /^[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/.test(v.trim())
              ? Number(v.trim().replace(/,/g, ''))
              : v,
          );
    return [e];
  });
  const texts = elements.filter(e => e?.t === 'text' && typeof e.text === 'string');
  if (!cover && texts.length && !texts.some(e => e.role === 'title')) {
    // The page title is the text that repeats the slide title, or the one clearly largest text near the top.
    const same = title ? texts.filter(e => e.text.replace(/\s/g, '') === title.replace(/\s/g, '')) : [];
    const top = texts.filter(e => typeof e.y === 'number' && e.y < 170 && typeof e.size === 'number'),
      largest = Math.max(...top.map(e => e.size));
    const chosen =
      same.length === 1
        ? same[0]
        : top.filter(e => e.size === largest).length === 1
          ? top.find(e => e.size === largest)
          : undefined;
    if (chosen) chosen.role = 'title';
  }
  return { ...data, elements };
}

/** A font name chosen by the AI (or read from the browser): kept as a name only. */
const elementFont = (value: unknown) =>
  typeof value === 'string' && value.trim() && !/[\u0000-\u001f<>"]/.test(value)
    ? value.trim().slice(0, 60)
    : undefined;
/** SVG artwork read from a page's HTML: no scripts, external references or embedded documents. */
export function sanitizeSvg(value: unknown, field: string) {
  if (typeof value !== 'string' || value.length > 150_000 || !/^\s*<svg[\s>]/i.test(value))
    bad(`${field}のSVGが正しくありません`);
  return (value as string)
    .replace(/<\s*(script|foreignObject|iframe|image|a)\b[\s\S]*?<\/\s*\1\s*>/gi, '')
    .replace(/<\s*\/?\s*(script|foreignObject|iframe|image|a)\b[^>]*>/gi, '')
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s(href|xlink:href|src)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/url\(\s*["']?(?!#)[^)]*\)/gi, 'none')
    .replace(/<!ENTITY[^>]*>|<!DOCTYPE[^>]*>/gi, '');
}
/** An AI-designed slide. Positions, shapes and colours are the AI's; the app only
 * rejects what would be unreadable or untrue: text outside the slide or in the
 * footer, overlapping text boxes, unknown icons, and charts whose data fail. */
export function validateDesign(value: unknown, sourceCount: number, cover = false, title?: string): FreeDesign {
  const data = lenientDesign(object(value, 'デザイン'), cover, title);
  // An HTML page read back by the browser can hold more parts than the JSON method's 90.
  const elements = array(data.elements, 'デザインの要素', 200).map((entry, i): FreeElement => {
    const e = object(entry, `要素${i + 1}`),
      field = `要素${i + 1}`;
    const rect = () => {
      const x = number(e.x, `${field}のx`, 0, SLIDE_W),
        y = number(e.y, `${field}のy`, 0, SLIDE_H),
        w = number(e.w, `${field}のw`, 1, SLIDE_W),
        h = number(e.h, `${field}のh`, 1, SLIDE_H);
      if (x + w > SLIDE_W + 1 || y + h > SLIDE_H + 1)
        bad(`${field}がスライドの外にはみ出しています（幅${SLIDE_W}・高さ${SLIDE_H}の範囲に収めてください）`);
      return { x, y, w, h };
    };
    if (e.t === 'text') {
      // Browser-measured text: its box includes line spacing below the glyphs (the browser already checked the glyphs).
      const r = rect(),
        spacing = e.exact === true && typeof e.size === 'number' ? e.size * 0.35 + 3 : 0;
      if (r.y + r.h > FOOTER_TOP + 1 + spacing)
        bad(`${field}の文字が下端の出典欄（y=${FOOTER_TOP}以降）に入っています。y+hを${FOOTER_TOP}以下にしてください`);
      // A citation number with no matching source is dropped: the text stays, only its marker is lost.
      const refs =
        e.refs === undefined
          ? undefined
          : (array(e.refs, `${field}の出典番号`, 5).filter(
              n => Number.isInteger(n) && n >= 1 && n <= sourceCount,
            ) as number[]);
      const runs =
        e.exact === true && Array.isArray(e.runs)
          ? (e.runs as unknown[]).slice(0, 40).flatMap(run => {
              const p = run && typeof run === 'object' ? (run as Record<string, unknown>) : {};
              if (!Number.isInteger(p.s) || !Number.isInteger(p.l) || (p.s as number) < 0 || (p.l as number) < 1)
                return [];
              return [
                {
                  s: p.s as number,
                  l: p.l as number,
                  ...(p.color !== undefined ? { color: designColor(p.color, field) } : {}),
                  ...(typeof p.bold === 'boolean' ? { bold: p.bold } : {}),
                  ...(typeof p.italic === 'boolean' ? { italic: p.italic } : {}),
                },
              ];
            })
          : [];
      return {
        t: 'text',
        ...r,
        text: text(e.text, `${field}の文字`, 800)!,
        size: number(e.size, `${field}の文字の大きさ`, 9, 110),
        ...(e.color !== undefined ? { color: designColor(e.color, field) } : {}),
        ...(e.bold !== undefined ? { bold: e.bold === true } : {}),
        ...(e.italic === true ? { italic: true } : {}),
        ...(e.align !== undefined ? { align: oneOf(e.align, ['l', 'c', 'r'] as const, `${field}のalign`) } : {}),
        ...(e.va !== undefined ? { va: oneOf(e.va, ['t', 'm', 'b'] as const, `${field}のva`) } : {}),
        ...(e.role !== undefined
          ? { role: oneOf(e.role, ['title', 'heading', 'body', 'number', 'caption'] as const, `${field}のrole`) }
          : {}),
        ...(refs?.length ? { refs: [...new Set(refs)] } : {}),
        ...(elementFont(e.font) ? { font: elementFont(e.font) } : {}),
        ...(elementFont(e.fontFarEast) ? { fontFarEast: elementFont(e.fontFarEast) } : {}),
        ...(e.exact === true ? { exact: true } : {}),
        ...(e.exact === true && typeof e.lh === 'number' ? { lh: number(e.lh, `${field}の行の高さ`, 4, 240) } : {}),
        ...(runs.length ? { runs } : {}),
      };
    }
    if (e.t === 'box') {
      const r = rect();
      return {
        t: 'box',
        ...r,
        ...(e.shape !== undefined ? { shape: oneOf(e.shape, freeShapes, `${field}のshape`) } : {}),
        ...(e.fill !== undefined ? { fill: designColor(e.fill, field) } : {}),
        ...(e.line !== undefined ? { line: designColor(e.line, field) } : {}),
        ...(e.lw !== undefined ? { lw: number(e.lw, `${field}の線の太さ`, 0, 12) } : {}),
        ...(e.op !== undefined ? { op: share(e.op, `${field}の不透明度`, 0, 1) } : {}),
        ...(e.r !== undefined ? { r: share(e.r, `${field}の角丸`, 0, 0.5) } : {}),
        ...(e.rot !== undefined ? { rot: number(e.rot, `${field}の回転`, -360, 360) } : {}),
      };
    }
    if (e.t === 'line')
      return {
        t: 'line',
        x1: number(e.x1, `${field}のx1`, 0, SLIDE_W),
        y1: number(e.y1, `${field}のy1`, 0, SLIDE_H),
        x2: number(e.x2, `${field}のx2`, 0, SLIDE_W),
        y2: number(e.y2, `${field}のy2`, 0, SLIDE_H),
        ...(e.color !== undefined ? { color: designColor(e.color, field) } : {}),
        ...(e.lw !== undefined ? { lw: number(e.lw, `${field}の線の太さ`, 0.25, 12) } : {}),
        ...(e.dash === true ? { dash: true } : {}),
        ...(e.arrow !== undefined
          ? { arrow: oneOf(e.arrow, ['none', 'end', 'start', 'both'] as const, `${field}のarrow`) }
          : {}),
      };
    if (e.t === 'icon') {
      if (typeof e.icon !== 'string' || !Object.hasOwn(iconCatalog, e.icon))
        bad(`${field}のアイコンは一覧のIDを使ってください`);
      const x = number(e.x, `${field}のx`, 0, SLIDE_W),
        y = number(e.y, `${field}のy`, 0, SLIDE_H),
        size = number(e.size, `${field}のsize`, 8, 240);
      if (x + size > SLIDE_W + 1 || y + size > SLIDE_H + 1) bad(`${field}がスライドの外にはみ出しています`);
      return {
        t: 'icon',
        icon: e.icon as IconId,
        x,
        y,
        size,
        ...(e.color !== undefined ? { color: designColor(e.color, field) } : {}),
      };
    }
    if (e.t === 'chart') {
      const r = rect();
      if (r.w < 120 || r.h < 90) bad(`${field}のグラフは幅120・高さ90以上にしてください`);
      return { t: 'chart', ...r, chart: chartSpec(e.chart) };
    }
    if (e.t === 'table') {
      const r = rect(),
        headers = stringList(e.headers, `${field}の表の列`, 6, 60),
        rows = array(e.rows, `${field}の表の行`, 10).map(row => stringList(row, `${field}の表のセル`, 6, 90));
      if (!headers.length || !rows.length || rows.some(row => row.length !== headers.length))
        bad(`${field}の表の列数が一致しません`);
      return {
        t: 'table',
        ...r,
        headers,
        rows,
        ...(e.size !== undefined ? { size: number(e.size, `${field}の文字の大きさ`, 10, 28) } : {}),
      };
    }
    if (e.t === 'svg') {
      const r = rect();
      return { t: 'svg', ...r, svg: sanitizeSvg(e.svg, field) };
    }
    bad(`${field}のtはtext・box・line・icon・chart・tableのいずれか`);
  });
  if (!elements.length) bad('デザインの要素がありません');
  const texts = elements.filter((e): e is Extract<FreeElement, { t: 'text' }> => e.t === 'text');
  if (!texts.length) bad('デザインに文字の要素がありません');
  if (!cover && !texts.some(e => e.role === 'title')) bad('見出しのtext要素（role:"title"）がありません');
  if (elements.filter(e => e.t === 'chart').length > 4 || elements.filter(e => e.t === 'table').length > 2)
    bad('1枚のグラフは4つ、表は2つまでです');
  // Text boxes may sit on shapes, but two texts on top of each other are unreadable.
  for (let i = 0; i < texts.length; i++)
    for (let j = i + 1; j < texts.length; j++) {
      const a = texts[i],
        b = texts[j],
        w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x),
        h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      // Browser-measured texts were compared glyph by glyph when the page was read; a large decorative
      // numeral behind other text (3x its size or more) may be layered on purpose.
      if ((a.exact && b.exact) || Math.max(a.size, b.size) >= 3 * Math.min(a.size, b.size)) continue;
      if (w > 0 && h > 0 && w * h > 0.25 * Math.min(a.w * a.h, b.w * b.h))
        bad(
          `文字の枠が重なっています（「${a.text.slice(0, 12)}」と「${b.text.slice(0, 12)}」）。位置か大きさを調整してください`,
        );
    }
  return { ...(data.background !== undefined ? { background: designColor(data.background, '背景') } : {}), elements };
}

/** A design returned for slots only. It is checked with the dummy samples first,
 * so every problem reported back to the design AI names slots and dummy text, never
 * the real wording; the real content is filled in only after that check. */
export function validateDesignReply(
  raw: unknown,
  packet: DesignPacket,
  contents: Record<string, SlotContent>,
  deck: DeckSpec,
): SlideSpec[] {
  const data = object(raw, 'デザインの返答'),
    replies = array(data.slides, 'ページ', packet.slides.length);
  return packet.slides.map(request => {
    const reply = replies.find(r => r && typeof r === 'object' && r.id === request.id);
    if (!reply) bad(`${request.id}のデザインがありません`);
    const design = object(reply.design, `${request.id}のデザイン`),
      elements = array(design.elements, `${request.id}の要素`, 90);
    const slots = new Map(request.slots.map(s => [s.id, s])),
      charts = new Set(request.charts.map(c => c.id)),
      tables = new Set(request.tables.map(t => t.id)),
      used = new Set<string>();
    const sampled = elements.map((entry, i) => {
      const e = object(entry, `${request.id}の要素${i + 1}`);
      const slot = typeof e.slot === 'string' ? e.slot : undefined;
      if (slot && used.has(slot)) bad(`${request.id}の${slot}が2回配置されています`);
      if (e.t === 'text') {
        if (slot) {
          const target = slots.get(slot);
          if (!target) bad(`${request.id}に${slot}という文字の枠はありません`);
          used.add(slot);
          const { slot: _s, ...rest } = e;
          return { ...rest, text: target.sample, ...(slot === 't' ? { role: 'title' } : {}) };
        }
        if (typeof e.text !== 'string' || !/^[0-9０-９\s.,:・\-–—→←↑↓▶▷►●○◆◇■□#％%]{1,4}$/u.test(e.text))
          bad(`${request.id}の要素${i + 1}：slotのない文字は番号や記号（4文字以内）だけにしてください`);
        return e;
      }
      if (e.t === 'chart') {
        if (!slot || !charts.has(slot)) bad(`${request.id}の要素${i + 1}：グラフにはchartsのslotを指定してください`);
        used.add(slot!);
        const { slot: _s, ...rest } = e;
        return { ...rest, chart: contents[request.id].charts[slot!] };
      }
      if (e.t === 'table') {
        if (!slot || !tables.has(slot)) bad(`${request.id}の要素${i + 1}：表にはtablesのslotを指定してください`);
        used.add(slot!);
        const { slot: _s, ...rest } = e;
        const table = contents[request.id].tables[slot!];
        return { ...rest, headers: table.headers.map(dummyText), rows: table.rows.map(r => r.map(dummyText)) };
      }
      return e;
    });
    const missing = [...request.slots.map(s => s.id), ...charts, ...tables].filter(id => !used.has(id));
    if (missing.length)
      bad(`${request.id}の${missing.join('・')}が配置されていません。すべてのslotを1回ずつ配置してください`);
    const original = deck.slides.find(s => s.id === request.id)!;
    // Structure, bounds and overlap are checked on the dummy text.
    validateDesign(
      { ...(design.background !== undefined ? { background: design.background } : {}), elements: sampled },
      original.sources.length,
      request.cover,
    );
    const filled = sampled.map((e: any, i: number) => {
      const slot = typeof (elements[i] as any).slot === 'string' ? (elements[i] as any).slot : undefined;
      if (e.t === 'text' && slot) {
        const content = contents[request.id].texts[slot];
        const { refs: _r, ...rest } = e;
        return { ...rest, text: content.text, ...(content.refs?.length ? { refs: content.refs } : {}) };
      }
      if (e.t === 'table' && slot) {
        const table = contents[request.id].tables[slot];
        return { ...e, headers: table.headers, rows: table.rows };
      }
      return e;
    });
    const result = validateDesign(
      { ...(design.background !== undefined ? { background: design.background } : {}), elements: filled },
      original.sources.length,
      request.cover,
    );
    return {
      id: original.id,
      title: original.title,
      layoutId: request.cover ? 'cover' : 'free',
      items: [],
      notes: original.notes,
      sources: structuredClone(original.sources),
      design: result,
    };
  });
}

export function validateDeck(value: unknown, expectedOutline?: Outline): DeckSpec {
  const data = object(value, '資料');
  const slides = array(data.slides, 'スライド', MAX_SLIDES).map((slide, index) =>
    validateSlide(slide, `slide-${index + 1}`),
  );
  if (slides.length < 2 || slides[0].layoutId !== 'cover' || slides.slice(1).some(s => s.layoutId === 'cover'))
    bad(`表紙1枚を含む2〜${MAX_SLIDES}枚が必要です`);
  if (expectedOutline && slides.length !== expectedOutline.slides.length) bad('承認した構成案と枚数が異なります');
  const template = data.themeId === TEMPLATE_THEME_ID,
    ai = data.themeId === AI_THEME_ID;
  if (ai && data.aiTheme === undefined) bad('AIの配色がありません');
  return {
    id: typeof data.id === 'string' ? data.id.slice(0, 100) : 'deck',
    title: text(data.title, '資料名', 100)!,
    mode: mode(data.mode),
    themeId: template ? TEMPLATE_THEME_ID : ai ? AI_THEME_ID : validateTheme(data.themeId ?? 'paper'),
    ...(data.aiTheme !== undefined ? { aiTheme: validateCustomTheme(data.aiTheme) } : {}),
    ...(data.typographyId ? { typographyId: validateTypography(data.typographyId) } : {}),
    ...(template ? { customTheme: validateCustomTheme(data.customTheme) } : {}),
    ...(data.referencesSlide === true ? { referencesSlide: true } : {}),
    slides,
  };
}

const color = (value: unknown, field: string) => {
  if (typeof value !== 'string' || !/^#[0-9A-F]{6}$/i.test(value)) bad(`${field}の色`);
  return value.toUpperCase();
};
const fontName = (value: unknown, field: string, optional = false) => {
  if (value === undefined && optional) return undefined;
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > 64 ||
    [...value].some(ch => ch.charCodeAt(0) < 32 || '<>"'.includes(ch))
  )
    bad(`${field}の書体名`);
  return value.trim();
};
/** A company template theme copied into a deck. Only colors, font names and the
 * fixed style choices are accepted; no markup or free-form drawing. */
export function validateCustomTheme(value: unknown): Theme {
  const data = object(value, '会社テンプレート');
  const pick = <T extends string>(field: unknown, allowed: readonly T[], fallback: T): T =>
    allowed.includes(field as T) ? (field as T) : fallback;
  const itemColors = array(data.itemColors ?? [], '項目の色', 6).map((c, i) => color(c, `項目${i + 1}`));
  return {
    name: text(data.name ?? '会社テンプレート', 'テンプレート名', 100)!,
    description: text(data.description ?? '', 'テンプレートの説明', 200, true) ?? '',
    background: color(data.background, '背景'),
    foreground: color(data.foreground, '文字'),
    muted: color(data.muted, '補足文字'),
    accent: color(data.accent, '強調'),
    secondary: color(data.secondary, '第2強調'),
    pale: color(data.pale, '淡色'),
    font: fontName(data.font, '本文')!,
    headingFont: fontName(data.headingFont, '見出し', true),
    numberFont: fontName(data.numberFont, '数字', true),
    equationFont: fontName(data.equationFont, '数式', true),
    itemColors: itemColors.length ? itemColors : undefined,
    panelStyle: pick(data.panelStyle, ['tint', 'outline', 'header'] as const, 'tint'),
    coverStyle: pick(data.coverStyle, ['editorial', 'split', 'band', 'block'] as const, 'band'),
    headingStyle: pick(data.headingStyle, ['rule', 'accent', 'band'] as const, 'rule'),
    tableStyle: pick(data.tableStyle, ['minimal', 'striped', 'contrast'] as const, 'striped'),
  };
}

/** proposals: when the AI was asked for several directions, the check each outline must pass
 * (mode, slide count). Without it only questions or one outline are accepted. */
export function validatePlanResponse(
  value: unknown,
  proposals?: (outline: Outline) => void,
): { question?: string; outline?: Outline; proposals?: ReturnType<typeof validateProposals> } {
  const data = object(value, '構成の応答');
  if (data.kind === 'questions') return { question: text(data.message, '確認事項', 2500)! };
  if (data.kind === 'outline') return { outline: validateOutline(data.outline) };
  if (data.kind === 'proposals' && proposals) return { proposals: validateProposals(data, proposals) };
  bad(proposals ? 'kindはquestions・outline・proposalsのどれかです' : 'kindはquestionsまたはoutlineです');
}

/** The AI's look at drawn pages. Only the pages that were shown count; a malformed finding is
 * skipped instead of refusing the whole answer (the look is extra, never required). */
export function validateReview(
  value: unknown,
  ids: string[],
): { id: string; problems: { severity: 'high' | 'medium' | 'low'; what: string; fix: string }[] }[] {
  const data = object(value, '点検の応答');
  return array(data.pages, '点検したページ', ids.length + 2).flatMap((entry: unknown) => {
    if (!entry || typeof entry !== 'object' || !ids.includes((entry as any).id)) return [];
    const page = entry as Record<string, any>;
    const problems = (Array.isArray(page.problems) ? page.problems : [])
      .flatMap((p: any) =>
        p && ['high', 'medium', 'low'].includes(p.severity) && typeof p.what === 'string' && p.what.trim()
          ? [
              {
                severity: p.severity,
                what: p.what.trim().slice(0, 80),
                fix: typeof p.fix === 'string' ? p.fix.trim().slice(0, 120) : '',
              },
            ]
          : [],
      )
      .slice(0, 3);
    return [{ id: String(page.id), problems }];
  });
}

/** A direction whose outline fails a check is left out with its reason; the response is
 * refused only when no direction is usable. */
function validateProposals(data: Record<string, any>, check: (outline: Outline) => void) {
  const items: OutlineProposal[] = [],
    problems: AppError[] = [],
    kept: number[] = [];
  array(data.proposals, '構成案の候補', 5).forEach((entry, index) => {
    try {
      const proposal = object(entry, '構成案の候補');
      const outline = validateOutline(proposal.outline);
      check(outline);
      const suitedFor =
        typeof proposal.suitedFor === 'string' && proposal.suitedFor.trim()
          ? proposal.suitedFor.trim().slice(0, 40)
          : undefined;
      // The page shown as the direction's sample besides the cover: the AI's pick, else a middle page.
      const pages = outline.slides.filter(s => s.layoutId !== 'cover');
      const previewSlide = pages.some(s => s.id === proposal.previewSlide)
        ? String(proposal.previewSlide)
        : pages[Math.floor(pages.length / 2)]?.id;
      items.push({
        direction: text(proposal.direction, '方向の名前', 40)!,
        difference: text(proposal.difference, 'ほかの案との違い', 200, true) ?? '',
        typicality: likelihood(proposal.typicality),
        ...(suitedFor ? { suitedFor } : {}),
        ...(previewSlide ? { previewSlide } : {}),
        outline,
      });
      kept.push(index);
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      problems.push(error);
    }
  });
  if (!items.length) throw problems[0] ?? bad('構成案の候補がありません');
  // The recommendation points into the reply; after dropping unusable directions it points into items.
  const recommended =
    Number.isInteger(data.recommended) && kept.includes(data.recommended) ? kept.indexOf(data.recommended) : undefined;
  const reason =
    recommended !== undefined && typeof data.reason === 'string' && data.reason.trim()
      ? data.reason.trim().slice(0, 120)
      : undefined;
  // The wider list the AI compared is shown for reference only; a malformed entry is skipped.
  const candidates = (Array.isArray(data.candidates) ? data.candidates.slice(0, 8) : []).flatMap((entry: unknown) => {
    try {
      const c = object(entry, '比べた方向');
      return [{ direction: text(c.direction, '比べた方向', 40)!, typicality: likelihood(c.typicality) }];
    } catch {
      return [];
    }
  });
  return {
    items,
    candidates,
    problems,
    ...(recommended !== undefined ? { recommended } : {}),
    ...(reason ? { reason } : {}),
  };
}
/** The AI's estimate of how often a direction is chosen, 0-1 (a percentage is accepted). */
function likelihood(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) bad('ありがちさは0〜1の数値');
  return Math.round((value > 1 ? value / 100 : value) * 100) / 100;
}
