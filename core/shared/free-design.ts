import type {
  ChartSpec,
  FreeDesign,
  FreeElement,
  LineElement,
  PhotoSide,
  Rect,
  SceneElement,
  SlideSpec,
  TableCell,
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
/** A file of the app's image store (runtime/images). */
export const IMAGE_SRC = /^[0-9a-f]{16}\.(jpg|png)$/;
/** The shares of a picture (iw x ih) cut from the left, top, right and bottom so it fills a w x h box: as much from
 * both ends, or all from one to keep the focus side (a side it is not cut on changes nothing). */
export function coverCrop(
  iw: number,
  ih: number,
  w: number,
  h: number,
  focus?: PhotoSide,
): [number, number, number, number] {
  const keep = iw / ih / (w / h),
    wide = keep > 1,
    half = Math.round(((1 - (wide ? 1 / keep : keep)) / 2) * 10000) / 10000,
    start = focus === (wide ? 'left' : 'top') ? 0 : focus === (wide ? 'right' : 'bottom') ? 2 * half : half,
    end = 2 * half - start;
  return wide ? [start, 0, end, 0] : [0, start, 0, end];
}
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
function markBlanks(el: Pick<TextElement, 'text' | 'runs' | 'blankColor'>, theme: Theme, ground: string) {
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
  if (background !== 'none' && background.toUpperCase() !== theme.background.toUpperCase())
    c.scene.background = background;
  // Opaque surfaces drawn so far, so text colour can be checked against what is under it (none over a photo:
  // its colours are not known, so text on it keeps the AI's colour).
  const surfaces: { rect: Rect; color?: string }[] = [
    { rect: { x: 0, y: 0, w: SLIDE_W, h: SLIDE_H }, color: background },
  ];
  const under = (x: number, y: number) =>
    [...surfaces]
      .reverse()
      .find(s => x >= s.rect.x && x <= s.rect.x + s.rect.w && y >= s.rect.y && y <= s.rect.y + s.rect.h)!.color;
  const readable = (color: string, ground: string | undefined, size: number) =>
    ground && (color === 'none' || contrast(color, ground) < (size >= 24 ? 3 : 4.5))
      ? readableColor(color === 'none' ? theme.foreground : color, ground)
      : color === 'none'
        ? theme.foreground
        : color;
  // Where the parts of each element begin, to keep the parts of one card together.
  const spans: [number, FreeElement][] = [];
  for (const e of design.elements) {
    spans.push([c.scene.elements.length, e]);
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
        ...(e.dash ? { dash: true } : {}),
        ...(e.shadow
          ? {
              shadow: {
                ...e.shadow,
                color: resolveColor(theme, e.shadow.color, '#000000'),
                opacity: e.shadow.op ?? 0.25,
              },
            }
          : {}),
        ...(e.grad && fill !== 'none'
          ? {
              gradient: {
                angle: e.grad.angle,
                stops: e.grad.stops.map(stop => ({ ...stop, color: resolveColor(theme, stop.color, fill) })),
              },
            }
          : {}),
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
          color: opacity < 1 && base ? mixColor(fill, base, opacity) : opacity < 1 ? undefined : fill,
        });
      }
    } else if (e.t === 'line')
      c.scene.elements.push(lineElement(e, resolveColor(theme, e.color, themeTokens(theme).rule)));
    else if (e.t === 'icon')
      c.scene.elements.push(
        ...iconElements(e.icon, { x: e.x, y: e.y, w: e.size, h: e.size }, resolveColor(theme, e.color, theme.accent)),
      );
    else if (e.t === 'chart') helpers.chart(c, e.chart, { x: e.x, y: e.y, w: e.w, h: e.h });
    else if (e.t === 'table' && e.cells && e.cols && e.rowH) {
      // A table read from a page: PowerPoint's table with the browser's widths, heights, lines and cell looks.
      const texts = [e.headers, ...e.rows],
        cols = e.cols,
        rowH = e.rowH,
        left = (i: number) => e.x + cols.slice(0, i).reduce((a, b) => a + b, 0),
        top = (r: number) => e.y + rowH.slice(0, r).reduce((a, b) => a + b, 0);
      const cells = e.cells.map((row, r) =>
        row.map((look, i): TableCell => {
          const fill = look.fill ? resolveColor(theme, look.fill, 'none') : 'none',
            opacity = look.op ?? 1,
            ground = fill !== 'none' && opacity >= 0.5 ? fill : under(left(i) + cols[i] / 2, top(r) + rowH[r] / 2);
          const color = readable(resolveColor(theme, look.color, theme.foreground), ground, look.size),
            text = texts[r][i] ?? '',
            runs = (look.runs ?? [])
              .filter(run => run.s + run.l <= text.length)
              .map(run => ({
                start: run.s,
                length: run.l,
                ...(run.color ? { color: resolveColor(theme, run.color, color) } : {}),
                ...(run.bold !== undefined ? { bold: run.bold } : {}),
                ...(run.italic !== undefined ? { italic: run.italic } : {}),
              }));
          const cell: TableCell = {
            text,
            fontSize: look.size,
            color,
            ...(look.bold ? { bold: true } : {}),
            ...(look.italic ? { italic: true } : {}),
            align: look.align === 'c' ? 'center' : look.align === 'r' ? 'right' : 'left',
            verticalAlign: look.va === 'm' ? 'middle' : look.va === 'b' ? 'bottom' : 'top',
            ...(fill !== 'none' ? { fill, ...(opacity < 1 ? { opacity } : {}) } : {}),
            ...(look.lh ? { lineHeight: look.lh } : {}),
            ...(look.pad ? { margin: look.pad } : {}),
            ...(look.bd?.some(Boolean)
              ? {
                  borders: look.bd.map(side =>
                    side ? { width: side.w, color: resolveColor(theme, side.c, themeTokens(theme).rule) } : null,
                  ),
                }
              : {}),
            ...(runs.length ? { runs } : {}),
          };
          markBlanks(cell, theme, ground ?? background);
          return cell;
        }),
      );
      c.scene.elements.push({
        kind: 'table',
        x: e.x,
        y: e.y,
        w: e.w,
        h: e.h,
        columns: cols,
        rows: rowH,
        cells,
        ...(e.head ? { header: true } : {}),
        font: theme.font,
        fontFarEast: theme.font,
        noWrap: true,
      });
    } else if (e.t === 'table')
      helpers.table(c, { headers: e.headers, rows: e.rows }, { x: e.x, y: e.y, w: e.w, h: e.h }, e.size);
    else if (e.t === 'svg') c.scene.elements.push({ kind: 'image', x: e.x, y: e.y, w: e.w, h: e.h, svg: e.svg });
    else if (e.t === 'path') {
      const stroke = e.line ? resolveColor(theme, e.line, 'none') : 'none';
      c.scene.elements.push({
        kind: 'shape',
        x: e.x,
        y: e.y,
        w: e.w,
        h: e.h,
        shape: 'rect',
        path: e.d,
        fill: resolveColor(theme, e.fill, 'none'),
        ...(stroke !== 'none' ? { stroke, strokeWidth: e.lw ?? 1 } : {}),
        ...(e.op !== undefined && e.op < 1 ? { opacity: e.op } : {}),
        ...(e.dash ? { dash: true } : {}),
        ...(e.arrow === 'end' || e.arrow === 'both' ? { arrow: true } : {}),
        ...(e.arrow === 'start' || e.arrow === 'both' ? { arrowStart: true } : {}),
      });
    } else if (e.t === 'image') {
      const rect = { x: e.x, y: e.y, w: e.w, h: e.h };
      // A place no picture was found for stays a plain frame with a picture mark, for the user's own photo.
      if (e.src)
        c.scene.elements.push({
          kind: 'image',
          ...rect,
          src: e.src,
          ...(e.iw && e.ih ? { crop: coverCrop(e.iw, e.ih, e.w, e.h, e.focus) } : {}),
          // The AI's description, or its search words when it gave none.
          alt: e.alt ?? e.q,
        });
      else {
        c.shape(rect, themeTokens(theme).surface);
        const size = Math.min(48, e.w / 3, e.h / 3);
        c.scene.elements.push(
          ...iconElements(
            'camera',
            { x: e.x + (e.w - size) / 2, y: e.y + (e.h - size) / 2, w: size, h: size },
            theme.muted,
          ),
        );
      }
      surfaces.push({ rect, ...(e.src ? {} : { color: themeTokens(theme).surface }) });
    } else if (e.t === 'text' && e.exact) {
      // Text measured by a browser: lines and positions are already final. It uses the
      // deck's font for its role (the browser drew it with the same font) and a readable colour.
      const ground = under(e.x + e.w / 2, e.y + Math.min(e.h, e.size * 1.4) / 2);
      const color = readable(resolveColor(theme, e.color, theme.foreground), ground, e.size);
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
        ...(e.sp ? { spacing: e.sp } : {}),
        role: roles[e.role ?? 'body'],
        ...(e.role === 'title' ? { title: true } : {}),
        font:
          e.role === 'number'
            ? (theme.numberFont ?? theme.font)
            : e.role === 'title' || e.role === 'heading'
              ? (theme.headingFont ?? theme.font)
              : theme.font,
        fontFarEast: e.role === 'title' || e.role === 'heading' ? (theme.headingFont ?? theme.font) : theme.font,
      };
      markBlanks(el, theme, ground ?? background);
      c.scene.elements.push(el);
    } else if (e.t === 'text') {
      const ground = under(e.x + e.w / 2, e.y + Math.min(e.h, e.size * 1.4) / 2);
      // Keep the AI's colour when it reads; otherwise switch to a readable ink.
      const color = readable(
        resolveColor(theme, e.color, e.role === 'caption' ? theme.muted : theme.foreground),
        ground,
        e.size,
      );
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
        if (e.role === 'title') added.title = true;
        // A font the AI chose for this text; one the PC may not have becomes the nearest standard font.
        if (e.font) {
          added.font = resolveFont(e.font, added.font ?? theme.font);
          added.fontFarEast = resolveFont(e.fontFarEast ?? e.font, added.fontFarEast ?? theme.font);
        }
        markBlanks(added, theme, ground ?? background);
      }
    }
  }
  keepTogether(c.scene.elements, spans);
}
/** The parts of one card of an HTML page become a PowerPoint group, an icon's strokes a group in it; a shape with
 * only one text in it becomes that shape with the text written in it. A title and a table stay on their own. */
function keepTogether(elements: SceneElement[], spans: [number, FreeElement][]) {
  spans.forEach(([start, e], i) => {
    const end = spans[i + 1]?.[0] ?? elements.length,
      path = [e.g === undefined ? '' : `g${e.g}`, e.t === 'icon' && end - start > 1 ? `i${start}` : '']
        .filter(Boolean)
        .join('/');
    if (path && !(e.t === 'text' && e.role === 'title'))
      for (const el of elements.slice(start, end)) if (el.kind !== 'table') el.group = path;
  });
  const members = new Map<string, SceneElement[]>();
  for (const el of elements) if (el.group) members.set(el.group, [...(members.get(el.group) ?? []), el]);
  for (const [path, [shape, text, ...rest]] of members) {
    if (rest.length || shape.kind !== 'shape' || text?.kind !== 'text' || !text.exact || shape.rotation) continue;
    if (
      elements.indexOf(text) !== elements.indexOf(shape) + 1 ||
      [...members.keys()].some(p => p.startsWith(`${path}/`))
    )
      continue;
    // PowerPoint sets the text area of a rounded rectangle, an ellipse, a chevron or a pentagon in from its edges
    // (left, top, right).
    const ss = Math.min(shape.w, shape.h),
      inset =
        shape.shape === 'rect'
          ? [0, 0, 0]
          : shape.shape === 'roundRect'
            ? [0, 0, 0].map(() => (shape.radius ?? 1 / 6) * ss * 0.293)
            : shape.shape === 'ellipse'
              ? [shape.w * 0.146, shape.h * 0.146, shape.w * 0.146]
              : shape.shape === 'chevron'
                ? [ss / 2, 0, ss / 2]
                : shape.shape === 'pentagon'
                  ? [0, 0, ss / 4]
                  : undefined;
    if (!inset) continue;
    const centred = (a: number, b: number) => Math.abs(a - b) <= 2.5,
      middle = centred(text.y + text.h / 2, shape.y + shape.h / 2),
      // A one-line label in the middle of its shape stays there when it is changed in PowerPoint.
      align =
        !text.text.includes('\n') && centred(text.x + text.w / 2, shape.x + shape.w / 2)
          ? 'center'
          : (text.align ?? 'left'),
      left = text.x - shape.x - inset[0],
      right = shape.x + shape.w - text.x - text.w - inset[2],
      top = text.y - shape.y - inset[1],
      // A centred text stays on the shape's middle in a text area set in more on one side.
      shift = inset[2] - inset[0];
    if (
      align === 'center' ? !centred(text.x + text.w / 2, shape.x + shape.w / 2) : (align === 'left' ? left : right) < 0
    )
      continue;
    if (!middle && (top < 0 || text.y + text.h > shape.y + shape.h + 2)) continue;
    text.inShape = {
      margin: [
        align === 'left' ? left : align === 'center' ? Math.max(0, shift) : 0,
        middle ? 0 : top,
        align === 'right' ? right : align === 'center' ? Math.max(0, -shift) : 0,
        0,
      ],
      ...(middle ? { middle: true } : {}),
    };
    text.align = align;
    delete shape.group;
    delete text.group;
  }
}
/** Light ink for footers on a dark designed background, or on a dark band the design laid under the footer
 * at x (a band down to the slide's bottom edge would hide the page number in the theme's grey). */
export function footerInk(theme: Theme, design: FreeDesign | undefined, x = SLIDE_W / 2) {
  const band = [...(design?.elements ?? [])]
    .reverse()
    .find(
      e =>
        e.t === 'box' &&
        e.fill !== 'none' &&
        !e.rot &&
        (e.op ?? 1) >= 0.5 &&
        e.x <= x &&
        e.x + e.w >= x &&
        e.y <= 516 &&
        e.y + e.h >= 516,
    );
  const ground =
    band?.t === 'box' ? resolveColor(theme, band.fill, themeTokens(theme).surface) : designBackground(theme, design);
  return isDarkColor(ground) ? mixColor(readableColor('#FFFFFF', ground), ground, 0.62) : theme.muted;
}
