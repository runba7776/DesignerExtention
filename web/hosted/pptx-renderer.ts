import type { ChartElement, DeckSpec, RenderDocument, RenderResult, SceneElement, SmartArtElement, TextElement } from '../../shared/contracts';
import { compileDeck } from '../../shared/layouts';
import { TEMPLATE_THEME_ID } from '../../shared/themes';
import { assertTextFits } from '../../server/text-fit';

/** Browser PPTX writer for the no-install build. It draws the same compiled
 * scene as the PowerPoint (COM) renderer: editable text boxes, shapes, native
 * charts with embedded data, diagrams as grouped editable shapes, and notes. */
type Pptx = import('pptxgenjs').default;
type Slide = ReturnType<Pptx['addSlide']>;
const inch = (points: number) => points / 72;
const hex = (color: string | undefined, fallback = '000000') => (color && /^#[0-9a-f]{6}$/i.test(color) ? color.slice(1) : fallback).toUpperCase();
const safeFont = (font: string | undefined) => (font ?? 'Yu Gothic').replace(/[&<>"]/g, '');
const japanese = /[　-ヿ㐀-鿿＀-￯]/;

function addText(slide: Slide, e: Pick<TextElement, 'x' | 'y' | 'w' | 'h' | 'text' | 'fontSize' | 'color' | 'bold' | 'align' | 'font' | 'fontFarEast' | 'noWrap'>, valign: 'top' | 'middle' = 'top', margin = 0) {
  slide.addText(e.text, {
    x: inch(e.x), y: inch(e.y), w: inch(e.w), h: inch(e.h), margin,
    fontFace: safeFont(japanese.test(e.text) ? e.fontFarEast ?? e.font : e.font), fontSize: e.fontSize, color: hex(e.color), bold: !!e.bold,
    align: e.align ?? 'left', valign, wrap: !e.noWrap, fit: 'none', lineSpacingMultiple: 1.05, paraSpaceAfter: 0,
  });
}

function addChart(pptx: Pptx, slide: Slide, e: ChartElement, font: string, ink: string) {
  const share = e.chartType === 'pie' || e.chartType === 'doughnut', stacked = e.chartType === 'stackedBar' || e.chartType === 'stackedColumn';
  const type = e.chartType === 'line' ? pptx.ChartType.line : e.chartType === 'pie' ? pptx.ChartType.pie : e.chartType === 'doughnut' ? pptx.ChartType.doughnut : pptx.ChartType.bar;
  const values = e.series.flatMap(series => series.values), fractional = values.some(value => value !== Math.trunc(value));
  const colors = (e.colors.length ? e.colors : ['#245DA8']).map(color => hex(color));
  slide.addChart(type, e.series.map(series => ({ name: series.name, labels: e.categories, values: series.values })), {
    x: inch(e.x), y: inch(e.y), w: inch(e.w), h: inch(e.h),
    barDir: e.chartType === 'bar' || e.chartType === 'stackedBar' ? 'bar' : 'col', ...(stacked ? { barGrouping: 'stacked' } : {}),
    chartColors: share ? e.categories.map((_, i) => colors[i % colors.length]) : e.series.map((_, i) => colors[i % colors.length]),
    showLegend: e.series.length > 1 || share, legendPos: 'b', legendFontSize: e.labelSize ?? 14, legendFontFace: font, legendColor: ink,
    catAxisLabelFontSize: e.labelSize ?? 14, valAxisLabelFontSize: e.labelSize ?? 14, catAxisLabelColor: ink, valAxisLabelColor: ink, catAxisLabelFontFace: font, valAxisLabelFontFace: font,
    valGridLine: { color: hex(e.gridColor, 'E3E8EE'), size: 0.75 }, catGridLine: { style: 'none' },
    ...(!share && !stacked && e.chartType !== 'line' && !values.some(value => value < 0) ? { valAxisMinVal: 0 } : {}),
    ...(e.unit && !share ? { showValAxisTitle: true, valAxisTitle: e.unit, valAxisTitleFontSize: 12, valAxisTitleColor: ink } : {}),
    showValue: !!e.showValues && !share, showPercent: !!e.showValues && share,
    dataLabelFontSize: e.labelSize ?? 14, dataLabelFontBold: true, dataLabelFontFace: font, dataLabelColor: stacked || share ? 'FFFFFF' : ink,
    dataLabelFormatCode: share ? '0.0%' : fractional ? 'General' : '#,##0', ...(stacked || share ? { dataLabelPosition: 'ctr' } : {}),
    ...(e.chartType === 'line' ? { lineSize: 2.5, lineDataSymbol: 'circle', lineDataSymbolSize: 7 } : {}), ...(e.chartType === 'doughnut' ? { holeSize: 42 } : {}),
  });
}

/** SmartArt is not writable from the browser; diagrams use editable shapes laid
 * out like the preview (process/list grid, cycle, hierarchy). */
function addDiagram(pptx: Pptx, slide: Slide, e: SmartArtElement, font: string) {
  const count = e.items.length; if (!count) return;
  const box = (index: number, x: number, y: number, w: number, h: number) => {
    slide.addShape(pptx.ShapeType.roundRect, { x: inch(x), y: inch(y), w: inch(w), h: inch(h), rectRadius: 0.08, fill: { color: hex(e.accent) }, line: { type: 'none' } });
    const item = e.items[index];
    slide.addText(item.description ? [{ text: item.label, options: { bold: true, fontSize: e.fontSize, breakLine: true } }, { text: item.description, options: { fontSize: Math.max(11, e.fontSize - 4) } }] : [{ text: item.label, options: { bold: true, fontSize: e.fontSize } }],
      { x: inch(x + 8), y: inch(y + 6), w: inch(w - 16), h: inch(h - 12), margin: 0, align: 'center', valign: 'middle', color: hex(e.color, 'FFFFFF'), fontFace: safeFont(font), fit: 'none' });
  };
  const connector = (x1: number, y1: number, x2: number, y2: number, arrow = false) => slide.addShape(pptx.ShapeType.line, { x: inch(Math.min(x1, x2)), y: inch(Math.min(y1, y2)), w: inch(Math.max(0.01, Math.abs(x2 - x1))), h: inch(Math.max(0.01, Math.abs(y2 - y1))), flipH: x2 < x1, flipV: y2 < y1, line: { color: hex(e.accent), width: 1.5, ...(arrow ? { endArrowType: 'triangle' } : {}) } });
  if (e.layout === 'cycle') {
    const radius = Math.min(e.w * .3, e.h * .32), cx = e.x + e.w / 2, cy = e.y + e.h / 2, w = Math.min(150, e.w * .27), h = 70;
    const points = e.items.map((_, i) => ({ x: cx + Math.cos(i / count * Math.PI * 2 - Math.PI / 2) * radius, y: cy + Math.sin(i / count * Math.PI * 2 - Math.PI / 2) * radius }));
    points.forEach((p, i) => { const q = points[(i + 1) % count]; if (count > 1) connector(p.x, p.y, q.x, q.y, true); });
    points.forEach((p, i) => box(i, p.x - w / 2, p.y - h / 2, w, h));
    return;
  }
  if (e.layout === 'hierarchy') {
    const rootW = Math.min(230, e.w * .38), childW = Math.min(190, (e.w - 12 * (count - 2)) / Math.max(1, count - 1));
    const topX = e.x + (e.w - rootW) / 2, topY = e.y + 12, childY = e.y + e.h * .55, childH = Math.min(100, e.h * .38);
    if (count > 1) connector(e.x + e.w / 2, topY + 75, e.x + e.w / 2, childY - 20);
    e.items.slice(1).forEach((_, i) => {
      const x = e.x + e.w * (i + .5) / (count - 1) - childW / 2;
      connector(Math.min(e.x + e.w / 2, x + childW / 2), childY - 20, Math.max(e.x + e.w / 2, x + childW / 2), childY - 20);
      connector(x + childW / 2, childY - 20, x + childW / 2, childY);
      box(i + 1, x, childY, childW, childH);
    });
    box(0, topX, topY, rootW, 75);
    return;
  }
  const columns = e.layout === 'list' ? Math.min(count, 3) : count, rows = Math.ceil(count / columns), gap = e.layout === 'list' ? 18 : 25;
  const w = (e.w - gap * (columns - 1)) / columns, h = Math.min(e.layout === 'list' ? 115 : 145, (e.h - gap * (rows - 1)) / rows), startY = e.y + (e.h - (h * rows + gap * (rows - 1))) / 2;
  e.items.forEach((_, i) => {
    const x = e.x + (i % columns) * (w + gap), y = startY + Math.floor(i / columns) * (h + gap);
    if (e.layout === 'process' && i < count - 1) connector(x + w + 3, y + h / 2, x + w + gap - 3, y + h / 2, true);
    box(i, x, y, w, h);
  });
}

function addElement(pptx: Pptx, slide: Slide, e: SceneElement, doc: RenderDocument) {
  if (e.kind === 'text') { addText(slide, e); return; }
  if (e.kind === 'line') { slide.addShape(pptx.ShapeType.line, { x: inch(e.x), y: inch(e.y), w: inch(Math.max(e.w, 0.01)), h: inch(Math.max(e.h, 0)), flipV: !!e.flipY, line: { color: hex(e.stroke), width: e.strokeWidth ?? 1 } }); return; }
  if (e.kind === 'chart') { addChart(pptx, slide, e, safeFont(doc.theme.font), hex(doc.theme.foreground)); return; }
  if (e.kind === 'smartart') { addDiagram(pptx, slide, e, safeFont(doc.theme.font)); return; }
  const type = e.shape === 'roundRect' ? pptx.ShapeType.roundRect : e.shape === 'ellipse' ? pptx.ShapeType.ellipse : e.shape === 'triangle' ? pptx.ShapeType.triangle : e.shape === 'arrow' ? pptx.ShapeType.rightArrow : pptx.ShapeType.rect;
  const transparent = (color?: string) => !color || color === 'none' || color === 'transparent';
  slide.addShape(type, { x: inch(e.x), y: inch(e.y), w: inch(e.w), h: inch(e.h), ...(e.shape === 'roundRect' ? { rectRadius: 0.1 } : {}),
    fill: transparent(e.fill) ? { type: 'none' } : { color: hex(e.fill) }, line: transparent(e.stroke) ? { type: 'none' } : { color: hex(e.stroke), width: e.strokeWidth ?? 1 } });
}

/** Builds the PPTX for a deck. Decks that follow the company template leave the
 * slide background to the destination master when inserted into a deck. */
export async function deckToPptx(deck: DeckSpec): Promise<{ blob: Blob; warnings: string[] }> {
  assertTextFits(deck);
  const doc = compileDeck(deck);
  const { default: PptxGenJS } = await import('pptxgenjs');
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';
  pptx.title = doc.title; pptx.author = 'Designer Extention'; pptx.company = '';
  pptx.theme = { headFontFace: safeFont(doc.theme.headingFont ?? doc.theme.font), bodyFontFace: safeFont(doc.theme.font) };
  for (const scene of doc.slides) {
    const slide = pptx.addSlide();
    if (deck.themeId !== TEMPLATE_THEME_ID) slide.background = { color: hex(doc.theme.background, 'FFFFFF') };
    for (const element of scene.elements) addElement(pptx, slide, element, doc);
    if (scene.notes.trim()) slide.addNotes(scene.notes.trim());
  }
  const blob = await pptx.write({ outputType: 'blob', compression: true }) as Blob;
  return { blob, warnings: [...new Set(doc.slides.flatMap(scene => scene.warnings))] };
}

const urls = new Map<string, string>();
/** Render callback for the in-browser engine. The file stays in this page as a
 * blob URL; nothing is uploaded. */
export async function renderInBrowser(deck: DeckSpec, variantId: string): Promise<RenderResult> {
  const { blob, warnings } = await deckToPptx(deck);
  const previous = urls.get(variantId); if (previous) URL.revokeObjectURL(previous);
  const url = URL.createObjectURL(blob); urls.set(variantId, url);
  return { artifactId: crypto.randomUUID(), pptxUrl: url, thumbnails: [], warnings: [...warnings, 'ブラウザ版で作成したPPTXです。SmartArtは編集できる図形で描画しています。'], native: false };
}
