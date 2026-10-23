import type {
  ChartSpec,
  FreeDesign,
  FreeElement,
  LineElement,
  Rect,
  SlideSpec,
  TableSpec,
  TextElement,
  Theme,
} from './contracts';
import type { LayoutContext } from './layouts';
import { contrast, luminance, mixColor, negativeColor, panelFill, readableColor, ruleColor } from './color';
import { iconElements } from './icons';
import { fontFor, resolveFont } from './typography';

/** Slides the AI designs itself. The AI decides every position, shape and colour;
 * the app only resolves theme colours, keeps text readable on what is under it,
 * measures text and turns the elements into editable PowerPoint objects. */
export const FREE_LAYOUT_ID = 'free';
export const SLIDE_W = 960,
  SLIDE_H = 540,
  FOOTER_TOP = 496;
export const colorTokens = [
  'bg',
  'ink',
  'muted',
  'accent',
  'accent2',
  'surface',
  'rule',
  'negative',
  'onAccent',
  'white',
] as const;
export const freeShapes = [
  'rect',
  'roundRect',
  'ellipse',
  'triangle',
  'arrow',
  'leftArrow',
  'upArrow',
  'downArrow',
  'chevron',
  'pentagon',
  'hexagon',
  'diamond',
  'parallelogram',
  'trapezoid',
  'octagon',
  'donut',
] as const;

export function themeTokens(theme: Theme): Record<(typeof colorTokens)[number], string> {
  return {
    bg: theme.background,
    ink: theme.foreground,
    muted: theme.muted,
    accent: theme.accent,
    accent2: theme.secondary,
    surface: panelFill(theme),
    rule: ruleColor(theme),
    negative: negativeColor(theme),
    onAccent: readableColor('#FFFFFF', theme.accent),
    white: '#FFFFFF',
  };
}
export function resolveColor(theme: Theme, value: string | undefined, fallback: string) {
  if (!value) return fallback;
  if (value === 'none') return 'none';
  if (/^#[0-9a-f]{6}$/i.test(value)) return value.toUpperCase();
  return (themeTokens(theme) as Record<string, string>)[value] ?? fallback;
}
/** The slide's own background colour (a full-bleed design background or the theme's). */
export function designBackground(theme: Theme, design: FreeDesign | undefined) {
  return design?.background ? resolveColor(theme, design.background, theme.background) : theme.background;
}
export const isDarkColor = (color: string) => luminance(color) < 0.2;
/** One kind of blank for facts still unknown when the deck was made: the item's name in full-width square
 * brackets, ［実施日］ (see blanks.ts). A browser line break may fall inside one. */
export const BLANK = /［([^［］]{1,30})］/g;

/** Every visible text of an AI-designed slide, for source checks, notes and text fitting. */
export function designTexts(slide: Pick<SlideSpec, 'design'>): string[] {
  return (slide.design?.elements ?? [])
    .flatMap(e =>
      e.t === 'text'
        ? [e.text]
        : e.t === 'table'
          ? [...e.headers, ...e.rows.flat()]
          : e.t === 'chart'
            ? [e.chart.caption ?? '', ...e.chart.categories, ...e.chart.series.map(s => s.name)]
            : [],
    )
    .filter(Boolean);
}

/** A line from (x1,y1) to (x2,y2) in the scene's box form, with arrowheads kept on the same ends. */
export function lineElement(e: Extract<FreeElement, { t: 'line' }>, stroke: string): LineElement {
  const x = Math.min(e.x1, e.x2),
    y = Math.min(e.y1, e.y2),
    w = Math.abs(e.x2 - e.x1),
    h = Math.abs(e.y2 - e.y1),
    flipY = (e.x2 - e.x1) * (e.y2 - e.y1) < 0;
  const sameStart = Math.abs(e.x1 - x) < 1e-6 && Math.abs(e.y1 - (flipY ? y + h : y)) < 1e-6;
  const atEnd = e.arrow === 'end' || e.arrow === 'both',
    atStart = e.arrow === 'start' || e.arrow === 'both';
  return {
    kind: 'line',
    x,
    y,
    w,
    h,
    stroke,
    strokeWidth: e.lw ?? 1.5,
    ...(flipY ? { flipY: true } : {}),
    ...((sameStart ? atEnd : atStart) ? { arrow: true } : {}),
    ...((sameStart ? atStart : atEnd) ? { arrowStart: true } : {}),
    ...(e.dash ? { dash: true } : {}),
  };
}

/** The box a designed text is drawn in. A box a little too short for its own lines (an
 * AI's rounding) grows by up to most of a line; it may grow further (up to one more
 * line) into empty space below that holds no other text. Anything more is a real
 * overflow. Shared by the renderer and the local text fitting. */
export function designTextBox(
  e: Extract<FreeElement, { t: 'text' }>,
  design: FreeDesign,
  text: string,
  wrap: (text: string, width: number, size: number) => string[],
): Rect {
  const needed = wrap(text, e.w - 8, e.size).length * e.size * 1.35 + 4,
    extra = needed - e.h;
  const clear = (h: number) =>
    e.y + h <= FOOTER_TOP &&
    !design.elements.some(
      o =>
        o !== e && o.t === 'text' && o.x < e.x + e.w && o.x + o.w > e.x && o.y < e.y + h && o.y + o.h > e.y + e.h - 1,
    );
  if (extra > 0 && extra <= e.size * 0.7) {
    const y = e.va === 'm' ? Math.max(0, e.y - extra / 2) : e.va === 'b' ? Math.max(0, e.y - extra) : e.y;
    return { x: e.x, y, w: e.w, h: Math.min(needed, SLIDE_H - y) };
  }
  if (extra > 0 && extra <= e.size * 1.45 && (e.va ?? 't') === 't' && clear(needed))
    return { x: e.x, y: e.y, w: e.w, h: needed };
  return { x: e.x, y: e.y, w: e.w, h: e.h };
}
/** A designed text as drawn: citation markers follow body text, but not a title or a
 * large number, where "1,737¹" reads as a different number. The footer and the
 * source check still show where those come from. */
export function designMarkedText(e: Extract<FreeElement, { t: 'text' }>, marker: (refs?: number[]) => string) {
  return e.role === 'number' || e.role === 'title' ? e.text : e.text + marker(e.refs);
}
/** Blanks still to fill (［実施日］) are drawn in one colour that stands out on the page, the same everywhere. */
function markBlanks(el: TextElement, theme: Theme, ground: string) {
  const found = [...el.text.matchAll(BLANK)];
  if (!found.length) return;
  let color = negativeColor(theme);
  if (contrast(color, ground) < 3) color = readableColor(color, ground);
  el.blankColor = color;
  el.runs = [...(el.runs ?? []), ...found.map(m => ({ start: m.index!, length: m[0].length, color }))];
}
type Helpers = {
  chart: (c: LayoutContext, data: ChartSpec, rect: Rect) => void;
  table: (c: LayoutContext, data: TableSpec, rect: Rect, size?: number) => void;
  marker: (refs?: number[]) => string;
  wrap: (text: string, width: number, size: number) => string[];
};
const roles: Record<string, TextElement['role']> = {
  title: 'heading',
  heading: 'label',
  number: 'number',
  body: 'body',
  caption: 'body',
};

export function drawDesign(c: LayoutContext, design: FreeDesign, helpers: Helpers) {
  const theme = c.theme,
    background = designBackground(theme, design);
  if (design.background) c.shape({ x: 0, y: 0, w: SLIDE_W, h: SLIDE_H }, background);
  // Opaque surfaces drawn so far, so text colour can be checked against what is under it.
  const surfaces: { rect: Rect; color: string }[] = [
    { rect: { x: 0, y: 0, w: SLIDE_W, h: SLIDE_H }, color: background },
  ];
  const under = (x: number, y: number) =>
    [...surfaces]
      .reverse()
      .find(s => x >= s.rect.x && x <= s.rect.x + s.rect.w && y >= s.rect.y && y <= s.rect.y + s.rect.h)!.color;
  for (const e of design.elements) {
    if (e.t === 'box') {
      const fill = resolveColor(theme, e.fill, themeTokens(theme).surface),
        stroke = e.line ? resolveColor(theme, e.line, 'none') : undefined,
        opacity = e.op ?? 1;
      c.scene.elements.push({
        kind: 'shape',
        x: e.x,
        y: e.y,
        w: e.w,
        h: e.h,
        shape: e.shape ?? 'rect',
        fill,
        ...(stroke && stroke !== 'none' ? { stroke, strokeWidth: e.lw ?? 1 } : {}),
        ...(opacity < 1 ? { opacity } : {}),
        ...(e.r !== undefined ? { radius: e.r } : {}),
        ...(e.rot ? { rotation: e.rot } : {}),
      });
      if (
        fill !== 'none' &&
        opacity >= 0.5 &&
        !e.rot &&
        ['rect', 'roundRect', 'ellipse', 'hexagon', 'octagon', 'pentagon', 'chevron', 'diamond'].includes(
          e.shape ?? 'rect',
        )
      ) {
        const base = under(e.x + e.w / 2, e.y + e.h / 2);
        surfaces.push({
          rect: { x: e.x, y: e.y, w: e.w, h: e.h },
          color: opacity < 1 ? mixColor(fill, base, opacity) : fill,
        });
      }
    } else if (e.t === 'line')
      c.scene.elements.push(lineElement(e, resolveColor(theme, e.color, themeTokens(theme).rule)));
    else if (e.t === 'icon')
      c.scene.elements.push(
        ...iconElements(e.icon, { x: e.x, y: e.y, w: e.size, h: e.size }, resolveColor(theme, e.color, theme.accent)),
      );
    else if (e.t === 'chart') helpers.chart(c, e.chart, { x: e.x, y: e.y, w: e.w, h: e.h });
    else if (e.t === 'table')
      helpers.table(c, { headers: e.headers, rows: e.rows }, { x: e.x, y: e.y, w: e.w, h: e.h }, e.size);
    else if (e.t === 'svg') c.scene.elements.push({ kind: 'image', x: e.x, y: e.y, w: e.w, h: e.h, svg: e.svg });
    else if (e.t === 'text' && e.exact) {
      // Text measured by a browser: lines and positions are already final. It uses the
      // deck's font for its role (the browser drew it with the same font) and a readable colour.
      const ground = under(e.x + e.w / 2, e.y + Math.min(e.h, e.size * 1.4) / 2);
      let color = resolveColor(theme, e.color, theme.foreground);
      if (color === 'none' || contrast(color, ground) < (e.size >= 24 ? 3 : 4.5))
        color = readableColor(color === 'none' ? theme.foreground : color, ground);
      const length = e.text.length,
        runs = (e.runs ?? [])
          .filter(run => run.s + run.l <= length)
          .map(run => ({
            start: run.s,
            length: run.l,
            ...(run.color ? { color: resolveColor(theme, run.color, color) } : {}),
            ...(run.bold !== undefined ? { bold: run.bold } : {}),
            ...(run.italic !== undefined ? { italic: run.italic } : {}),
          }));
      const el: TextElement = {
        kind: 'text',
        x: e.x,
        y: e.y,
        w: e.w,
        h: e.h,
        text: e.text,
        fontSize: e.size,
        color,
        ...fontFor(theme, roles[e.role ?? 'body']),
        ...(e.font ? { font: e.font, fontFarEast: e.fontFarEast ?? e.font } : {}),
        ...(runs.length ? { runs } : {}),
        bold: !!e.bold,
        ...(e.italic ? { italic: true } : {}),
        align: e.align === 'c' ? 'center' : e.align === 'r' ? 'right' : 'left',
        noWrap: true,
        exact: true,
        ...(e.lh ? { lineHeight: e.lh } : {}),
        role: roles[e.role ?? 'body'],
        font:
          e.role === 'number'
            ? (theme.numberFont ?? theme.font)
            : e.role === 'title' || e.role === 'heading'
              ? (theme.headingFont ?? theme.font)
              : theme.font,
        fontFarEast: e.role === 'title' || e.role === 'heading' ? (theme.headingFont ?? theme.font) : theme.font,
      };
      markBlanks(el, theme, ground);
      c.scene.elements.push(el);
    } else if (e.t === 'text') {
      const ground = under(e.x + e.w / 2, e.y + Math.min(e.h, e.size * 1.4) / 2);
      let color = resolveColor(theme, e.color, e.role === 'caption' ? theme.muted : theme.foreground);
      // Keep the AI's colour when it reads; otherwise switch to a readable ink.
      if (color === 'none' || contrast(color, ground) < (e.size >= 24 ? 3 : 4.5))
        color = readableColor(color === 'none' ? theme.foreground : color, ground);
      const text = designMarkedText(e, helpers.marker),
        box = designTextBox(e, design, text, helpers.wrap);
      const count = c.scene.elements.length;
      c.text(
        text,
        box,
        e.size,
        color,
        e.bold ?? (e.role === 'title' || e.role === 'heading' || e.role === 'number'),
        e.align === 'c' ? 'center' : e.align === 'r' ? 'right' : 'left',
        roles[e.role ?? 'body'],
      );
      const added = c.scene.elements[count];
      if (added?.kind === 'text') {
        if (e.va && e.va !== 't') added.verticalAlign = e.va === 'm' ? 'middle' : 'bottom';
        if (e.italic) added.italic = true;
        // A font the AI chose for this text; one the PC may not have becomes the nearest standard font.
        if (e.font) {
          added.font = resolveFont(e.font, added.font ?? theme.font);
          added.fontFarEast = resolveFont(e.fontFarEast ?? e.font, added.fontFarEast ?? theme.font);
        }
        markBlanks(added, theme, ground);
      }
    }
  }
}
/** Light ink for footers on a dark designed background. */
export function footerInk(theme: Theme, design: FreeDesign | undefined) {
  const ground = designBackground(theme, design);
  return isDarkColor(ground) ? mixColor(readableColor('#FFFFFF', ground), ground, 0.62) : theme.muted;
}
