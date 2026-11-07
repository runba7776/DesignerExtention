import type {
  ChartElement,
  DeckSpec,
  Rect,
  RenderDocument,
  RenderResult,
  SceneElement,
  SmartArtElement,
  TableElement,
  TextElement,
} from '../../shared/contracts';
import { compileDeck } from '../../shared/layouts';
import { TEMPLATE_THEME_ID } from '../../shared/themes';
import { assertTextFits } from '../../server/text-fit';

/** Browser PPTX writer for the no-install build. It draws the same compiled
 * scene as the PowerPoint (COM) renderer: editable text boxes, shapes, native
 * charts with embedded data, diagrams as grouped editable shapes, and notes. */
type Pptx = import('pptxgenjs').default;
type Slide = ReturnType<Pptx['addSlide']>;
type BorderProps = import('pptxgenjs').default.BorderProps;
const inch = (points: number) => points / 72;
const hex = (color: string | undefined, fallback = '000000') =>
  (color && /^#[0-9a-f]{6}$/i.test(color) ? color.slice(1) : fallback).toUpperCase();
const safeFont = (font: string | undefined) => (font ?? 'Yu Gothic').replace(/[&<>"]/g, '');
const japanese = /[　-ヿ㐀-鿿＀-￯]/;
/** PptxGenJS loads an SVG into an image to make its PNG fallback, so it needs a full data URL. Without "data:" the
 * image fails and so does the whole file. */
export const svgDataUrl = (svg: string) => `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`;

/** A text with coloured or bold parts (runs, such as the blanks still to fill) as PowerPoint text runs, line by line. */
function textRuns(e: Pick<TextElement, 'text' | 'runs'>) {
  type Run = { text: string; options: { color?: string; bold?: boolean; breakLine?: boolean } };
  const out: Run[] = [],
    lines = e.text.split('\n');
  let start = 0;
  lines.forEach((line, index) => {
    const cuts = [
      ...new Set([
        0,
        line.length,
        ...(e.runs ?? [])
          .flatMap(run => [run.start - start, run.start + run.length - start])
          .filter(at => at > 0 && at < line.length),
      ]),
    ].sort((a, b) => a - b);
    const parts: Run[] = [];
    for (let i = 0; i + 1 < cuts.length; i++) {
      const from = cuts[i],
        to = cuts[i + 1],
        options: Run['options'] = {};
      for (const run of e.runs ?? [])
        if (run.start <= start + from && run.start + run.length >= start + to) {
          if (run.color) options.color = hex(run.color);
          if (run.bold !== undefined) options.bold = run.bold;
        }
      parts.push({ text: line.slice(from, to), options });
    }
    if (!parts.length) parts.push({ text: '', options: {} });
    if (index < lines.length - 1) parts[parts.length - 1].options.breakLine = true;
    out.push(...parts);
    start += line.length + 1;
  });
  return out;
}
type TextLook = Pick<
  TextElement,
  | 'text'
  | 'fontSize'
  | 'color'
  | 'bold'
  | 'align'
  | 'font'
  | 'fontFarEast'
  | 'noWrap'
  | 'italic'
  | 'verticalAlign'
  | 'lineHeight'
  | 'runs'
  | 'spacing'
>;
function addText(
  slide: Slide,
  e: TextLook & Pick<TextElement, 'x' | 'y' | 'w' | 'h'>,
  valign: 'top' | 'middle' | 'bottom' = e.verticalAlign ?? 'top',
  margin = 0,
) {
  slide.addText(e.runs?.length ? textRuns(e) : e.text, {
    x: inch(e.x),
    y: inch(e.y),
    w: inch(e.w),
    h: inch(e.h),
    ...textOptions(e, valign, margin),
  });
}
/** A text's look as PptxGenJS options; margin in pt (left, right, bottom, top). */
function textOptions(
  e: TextLook,
  valign: 'top' | 'middle' | 'bottom',
  margin: number | [number, number, number, number],
) {
  return {
    margin,
    fontFace: safeFont(japanese.test(e.text) ? (e.fontFarEast ?? e.font) : e.font),
    fontSize: e.fontSize,
    color: hex(e.color),
    bold: !!e.bold,
    italic: !!e.italic,
    align: e.align ?? 'left',
    valign,
    wrap: !e.noWrap,
    fit: 'none',
    ...(e.lineHeight ? { lineSpacing: e.lineHeight } : { lineSpacingMultiple: 1.05 }),
    ...(e.spacing ? { charSpacing: e.spacing } : {}),
    paraSpaceAfter: 0,
  } as const;
}

/** A PowerPoint table: each cell keeps its own fill, borders, margins and text look. */
function addTable(slide: Slide, e: TableElement) {
  const side = (border?: { width: number; color: string } | null) =>
    border ? { type: 'solid' as const, pt: border.width, color: hex(border.color) } : { type: 'none' as const };
  const rows = e.cells.map(row =>
    row.map(cell => {
      // PptxGenJS reads a margin as points when the first (top) one is 1 or more, else as inches.
      const margin: [number, number, number, number] = cell.margin
        ? [cell.margin[1], cell.margin[2], cell.margin[3], cell.margin[0]]
        : [0, 0, 0, 0];
      return {
        text: cell.runs?.length ? textRuns(cell) : cell.text,
        options: {
          fontFace: safeFont(japanese.test(cell.text) ? (e.fontFarEast ?? e.font) : e.font),
          fontSize: cell.fontSize,
          color: hex(cell.color),
          bold: !!cell.bold,
          italic: !!cell.italic,
          align: cell.align ?? 'left',
          valign: cell.verticalAlign ?? 'top',
          margin: margin[0] >= 1 ? margin : (margin.map(inch) as typeof margin),
          border: [0, 1, 2, 3].map(i => side(cell.borders?.[i])) as [
            BorderProps,
            BorderProps,
            BorderProps,
            BorderProps,
          ],
          ...(cell.fill
            ? {
                fill: {
                  color: hex(cell.fill),
                  ...(cell.opacity !== undefined && cell.opacity < 1
                    ? { transparency: Math.round((1 - cell.opacity) * 100) }
                    : {}),
                },
              }
            : {}),
          // Not in the cell type, but every line of the cell takes it (as in a text box).
          ...(cell.lineHeight ? { lineSpacing: cell.lineHeight } : {}),
        },
      };
    }),
  );
  slide.addTable(rows, {
    x: inch(e.x),
    y: inch(e.y),
    w: inch(e.w),
    h: inch(e.h),
    colW: e.columns.map(inch),
    rowH: e.rows.map(inch),
  });
}

function addChart(pptx: Pptx, slide: Slide, e: ChartElement, font: string, ink: string) {
  const share = e.chartType === 'pie' || e.chartType === 'doughnut',
    stacked = e.chartType === 'stackedBar' || e.chartType === 'stackedColumn';
  const type =
    e.chartType === 'line'
      ? pptx.ChartType.line
      : e.chartType === 'pie'
        ? pptx.ChartType.pie
        : e.chartType === 'doughnut'
          ? pptx.ChartType.doughnut
          : pptx.ChartType.bar;
  const values = e.series.flatMap(series => series.values),
    fractional = values.some(value => value !== Math.trunc(value)),
    number = fractional ? 'General' : '#,##0';
  const colors = (e.colors.length ? e.colors : ['#245DA8']).map(color => hex(color));
  slide.addChart(
    type,
    e.series.map(series => ({ name: series.name, labels: e.categories, values: series.values })),
    {
      x: inch(e.x),
      y: inch(e.y),
      w: inch(e.w),
      h: inch(e.h),
      barDir: e.chartType === 'bar' || e.chartType === 'stackedBar' ? 'bar' : 'col',
      ...(stacked ? { barGrouping: 'stacked' } : {}),
      chartColors: share
        ? e.categories.map((_, i) => colors[i % colors.length])
        : e.series.map((_, i) => colors[i % colors.length]),
      showLegend: e.series.length > 1 || share,
      legendPos: 'b',
      legendFontSize: e.labelSize ?? 14,
      legendFontFace: font,
      legendColor: ink,
      catAxisLabelFontSize: e.labelSize ?? 14,
      valAxisLabelFontSize: e.labelSize ?? 14,
      catAxisLabelColor: ink,
      valAxisLabelColor: ink,
      catAxisLabelFontFace: font,
      valAxisLabelFontFace: font,
      valGridLine: { color: hex(e.gridColor, 'E3E8EE'), size: 0.75 },
      catGridLine: { style: 'none' },
      // Thousands separators on the scale, and category names kept horizontal.
      valAxisLabelFormatCode: fractional ? '#,##0.0' : '#,##0',
      catAxisLabelRotate: 0,
      ...(!share && !stacked && e.chartType !== 'line' && !values.some(value => value < 0) ? { valAxisMinVal: 0 } : {}),
      ...(e.unit && !share
        ? { showValAxisTitle: true, valAxisTitle: e.unit, valAxisTitleFontSize: 12, valAxisTitleColor: ink }
        : {}),
      showValue: !!e.showValues && !share,
      showPercent: !!e.showValues && share,
      dataLabelFontSize: e.labelSize ?? 14,
      dataLabelFontBold: true,
      dataLabelFontFace: font,
      dataLabelColor: stacked || share ? 'FFFFFF' : ink,
      // A zero part of a stacked bar has nothing to label (the empty third section hides it).
      dataLabelFormatCode: share ? '0.0%' : stacked ? `${number};-${number};` : number,
      ...(stacked || share ? { dataLabelPosition: 'ctr' } : {}),
      ...(e.chartType === 'line' ? { lineSize: 2.5, lineDataSymbol: 'circle', lineDataSymbolSize: 7 } : {}),
      ...(e.chartType === 'doughnut' ? { holeSize: 42 } : {}),
      ...(e.alt ? { altText: e.alt } : {}),
    },
  );
}

/** SmartArt is not writable from the browser; diagrams use editable shapes laid
 * out like the preview (process/list grid, cycle, hierarchy). */
function addDiagram(pptx: Pptx, slide: Slide, e: SmartArtElement, font: string) {
  const count = e.items.length;
  if (!count) return;
  const box = (index: number, x: number, y: number, w: number, h: number) => {
    slide.addShape(pptx.ShapeType.roundRect, {
      x: inch(x),
      y: inch(y),
      w: inch(w),
      h: inch(h),
      rectRadius: 0.08,
      fill: { color: hex(e.accent) },
      line: { type: 'none' },
    });
    const item = e.items[index];
    slide.addText(
      item.description
        ? [
            { text: item.label, options: { bold: true, fontSize: e.fontSize, breakLine: true } },
            { text: item.description, options: { fontSize: Math.max(11, e.fontSize - 4) } },
          ]
        : [{ text: item.label, options: { bold: true, fontSize: e.fontSize } }],
      {
        x: inch(x + 8),
        y: inch(y + 6),
        w: inch(w - 16),
        h: inch(h - 12),
        margin: 0,
        align: 'center',
        valign: 'middle',
        color: hex(e.color, 'FFFFFF'),
        fontFace: safeFont(font),
        fit: 'none',
      },
    );
  };
  const connector = (x1: number, y1: number, x2: number, y2: number, arrow = false) =>
    slide.addShape(pptx.ShapeType.line, {
      x: inch(Math.min(x1, x2)),
      y: inch(Math.min(y1, y2)),
      w: inch(Math.max(0.01, Math.abs(x2 - x1))),
      h: inch(Math.max(0.01, Math.abs(y2 - y1))),
      flipH: x2 < x1,
      flipV: y2 < y1,
      line: { color: hex(e.accent), width: 1.5, ...(arrow ? { endArrowType: 'triangle' } : {}) },
    });
  if (e.layout === 'cycle') {
    const radius = Math.min(e.w * 0.3, e.h * 0.32),
      cx = e.x + e.w / 2,
      cy = e.y + e.h / 2,
      w = Math.min(150, e.w * 0.27),
      h = 70;
    const points = e.items.map((_, i) => ({
      x: cx + Math.cos((i / count) * Math.PI * 2 - Math.PI / 2) * radius,
      y: cy + Math.sin((i / count) * Math.PI * 2 - Math.PI / 2) * radius,
    }));
    points.forEach((p, i) => {
      const q = points[(i + 1) % count];
      if (count > 1) connector(p.x, p.y, q.x, q.y, true);
    });
    points.forEach((p, i) => box(i, p.x - w / 2, p.y - h / 2, w, h));
    return;
  }
  if (e.layout === 'hierarchy') {
    const rootW = Math.min(230, e.w * 0.38),
      childW = Math.min(190, (e.w - 12 * (count - 2)) / Math.max(1, count - 1));
    const topX = e.x + (e.w - rootW) / 2,
      topY = e.y + 12,
      childY = e.y + e.h * 0.55,
      childH = Math.min(100, e.h * 0.38);
    if (count > 1) connector(e.x + e.w / 2, topY + 75, e.x + e.w / 2, childY - 20);
    e.items.slice(1).forEach((_, i) => {
      const x = e.x + (e.w * (i + 0.5)) / (count - 1) - childW / 2;
      connector(
        Math.min(e.x + e.w / 2, x + childW / 2),
        childY - 20,
        Math.max(e.x + e.w / 2, x + childW / 2),
        childY - 20,
      );
      connector(x + childW / 2, childY - 20, x + childW / 2, childY);
      box(i + 1, x, childY, childW, childH);
    });
    box(0, topX, topY, rootW, 75);
    return;
  }
  const columns = e.layout === 'list' ? Math.min(count, 3) : count,
    rows = Math.ceil(count / columns),
    gap = e.layout === 'list' ? 18 : 25;
  const w = (e.w - gap * (columns - 1)) / columns,
    h = Math.min(e.layout === 'list' ? 115 : 145, (e.h - gap * (rows - 1)) / rows),
    startY = e.y + (e.h - (h * rows + gap * (rows - 1))) / 2;
  e.items.forEach((_, i) => {
    const x = e.x + (i % columns) * (w + gap),
      y = startY + Math.floor(i / columns) * (h + gap);
    if (e.layout === 'process' && i < count - 1) connector(x + w + 3, y + h / 2, x + w + gap - 3, y + h / 2, true);
    box(i, x, y, w, h);
  });
}

function addElement(pptx: Pptx, slide: Slide, e: SceneElement, doc: RenderDocument, label?: TextElement) {
  if (e.kind === 'text') {
    addText(slide, e);
    return;
  }
  if (e.kind === 'line') {
    slide.addShape(pptx.ShapeType.line, {
      x: inch(e.x),
      y: inch(e.y),
      w: inch(Math.max(e.w, 0.01)),
      h: inch(Math.max(e.h, 0)),
      flipV: !!e.flipY,
      line: {
        color: hex(e.stroke),
        width: e.strokeWidth ?? 1,
        ...(e.dash ? { dashType: 'dash' } : {}),
        ...(e.arrow ? { endArrowType: 'triangle' } : {}),
        ...(e.arrowStart ? { beginArrowType: 'triangle' } : {}),
      },
    });
    return;
  }
  if (e.kind === 'chart') {
    addChart(pptx, slide, e, safeFont(doc.theme.font), hex(doc.theme.foreground));
    return;
  }
  if (e.kind === 'smartart') {
    addDiagram(pptx, slide, e, safeFont(doc.theme.font));
    return;
  }
  if (e.kind === 'table') {
    addTable(slide, e);
    return;
  }
  if (e.kind === 'image') {
    const data = e.svg ? svgDataUrl(e.svg) : e.png ? `image/png;base64,${e.png}` : '';
    if (data) slide.addImage({ data, x: inch(e.x), y: inch(e.y), w: inch(e.w), h: inch(e.h) });
    return;
  }
  const shapes = {
    rect: pptx.ShapeType.rect,
    roundRect: pptx.ShapeType.roundRect,
    ellipse: pptx.ShapeType.ellipse,
    triangle: pptx.ShapeType.triangle,
    arrow: pptx.ShapeType.rightArrow,
    leftArrow: pptx.ShapeType.leftArrow,
    upArrow: pptx.ShapeType.upArrow,
    downArrow: pptx.ShapeType.downArrow,
    chevron: pptx.ShapeType.chevron,
    pentagon: pptx.ShapeType.homePlate,
    hexagon: pptx.ShapeType.hexagon,
    diamond: pptx.ShapeType.diamond,
    parallelogram: pptx.ShapeType.parallelogram,
    trapezoid: pptx.ShapeType.trapezoid,
    octagon: pptx.ShapeType.octagon,
    donut: pptx.ShapeType.donut,
  } as const;
  const transparent = (color?: string) => !color || color === 'none' || color === 'transparent';
  // PptxGenJS draws no gradient: the shape keeps its first colour.
  // A freeform is PptxGenJS's custom geometry (drawn from its points; the name is missing from its types).
  const type = e.path
    ? ('custGeom' as unknown as import('pptxgenjs').default.SHAPE_NAME)
    : (shapes[e.shape] ?? pptx.ShapeType.rect);
  const options: import('pptxgenjs').default.ShapeProps = {
    x: inch(e.x),
    y: inch(e.y),
    w: inch(e.w),
    h: inch(e.h),
    ...(e.shape === 'roundRect' ? { rectRadius: inch((e.radius ?? 0.12) * Math.min(e.w, e.h)) } : {}),
    ...(e.rotation ? { rotate: e.rotation } : {}),
    fill: transparent(e.fill)
      ? { type: 'none' }
      : {
          color: hex(e.fill),
          ...(e.opacity !== undefined && e.opacity < 1 ? { transparency: Math.round((1 - e.opacity) * 100) } : {}),
        },
    line: transparent(e.stroke)
      ? { type: 'none' }
      : {
          color: hex(e.stroke),
          width: e.strokeWidth ?? 1,
          ...(e.dash ? { dashType: 'dash' } : {}),
          ...(e.arrow ? { endArrowType: 'triangle' } : {}),
          ...(e.arrowStart ? { beginArrowType: 'triangle' } : {}),
        },
    ...(e.path ? { points: freeformPoints(e.path, e) } : {}),
    ...(e.shadow
      ? {
          shadow: {
            type: 'outer',
            blur: e.shadow.blur,
            offset: Math.hypot(e.shadow.x, e.shadow.y),
            angle: Math.round(((Math.atan2(e.shadow.y, e.shadow.x) * 180) / Math.PI + 360) % 360),
            color: hex(e.shadow.color),
            opacity: e.shadow.opacity,
          },
        }
      : {}),
  };
  // The one text of a box is written in its shape, where the browser drew it (PptxGenJS has no groups).
  if (label?.inShape) {
    const [left, top, right, bottom] = label.inShape.margin;
    slide.addText(label.runs?.length ? textRuns(label) : label.text, {
      ...options,
      shape: type,
      ...textOptions(label, label.inShape.middle ? 'middle' : 'top', [left, right, bottom, top]),
    });
  } else slide.addShape(type, options);
}

/** A freeform's outline (M, L, C and Z in slide points) as PptxGenJS points, in inches from its box's corner. */
function freeformPoints(path: string, box: Rect) {
  const t = path.split(' '),
    at = (k: number, origin: number) => inch(Number(t[k]) - origin),
    points: NonNullable<import('pptxgenjs').default.ShapeProps['points']> = [];
  for (let i = 0; i < t.length;) {
    const c = t[i++];
    if (c === 'Z') points.push({ close: true });
    else if (c === 'C') {
      const [x1, y1, x2, y2] = [at(i, box.x), at(i + 1, box.y), at(i + 2, box.x), at(i + 3, box.y)];
      points.push({ x: at(i + 4, box.x), y: at(i + 5, box.y), curve: { type: 'cubic', x1, y1, x2, y2 } });
      i += 6;
    } else {
      points.push({ x: at(i, box.x), y: at(i + 1, box.y), ...(c === 'M' ? { moveTo: true } : {}) });
      i += 2;
    }
  }
  return points;
}

/** Builds the PPTX for a deck. Decks that follow the company template leave the
 * slide background to the destination master when inserted into a deck. */
export async function deckToPptx(deck: DeckSpec): Promise<{ blob: Blob; warnings: string[] }> {
  assertTextFits(deck);
  const doc = compileDeck(deck);
  const { default: PptxGenJS } = await import('pptxgenjs');
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';
  pptx.title = doc.title;
  pptx.author = 'Designer Extension';
  pptx.company = '';
  pptx.theme = {
    headFontFace: safeFont(doc.theme.headingFont ?? doc.theme.font),
    bodyFontFace: safeFont(doc.theme.font),
  };
  for (const scene of doc.slides) {
    const slide = pptx.addSlide();
    const ground = scene.background ?? (deck.themeId !== TEMPLATE_THEME_ID ? doc.theme.background : undefined);
    if (ground) slide.background = { color: hex(ground, 'FFFFFF') };
    scene.elements.forEach((element, i) => {
      const next = scene.elements[i + 1];
      if (element.kind === 'text' && element.inShape && scene.elements[i - 1]?.kind === 'shape') return;
      addElement(pptx, slide, element, doc, next?.kind === 'text' && next.inShape ? next : undefined);
    });
    if (scene.notes.trim()) slide.addNotes(scene.notes.trim());
  }
  const blob = (await pptx.write({ outputType: 'blob', compression: true })) as Blob;
  return { blob, warnings: [...new Set(doc.slides.flatMap(scene => scene.warnings))] };
}

const urls = new Map<string, string>();
/** Render callback for the in-browser engine. The file stays in this page as a
 * blob URL; nothing is uploaded. */
export async function renderInBrowser(deck: DeckSpec, variantId: string): Promise<RenderResult> {
  const { blob, warnings } = await deckToPptx(deck);
  const previous = urls.get(variantId);
  if (previous) URL.revokeObjectURL(previous);
  const url = URL.createObjectURL(blob);
  urls.set(variantId, url);
  return {
    artifactId: crypto.randomUUID(),
    pptxUrl: url,
    thumbnails: [],
    warnings: [...warnings, 'ブラウザ版で作成したPPTXです。SmartArtは編集できる図形で描画しています。'],
    native: false,
  };
}
