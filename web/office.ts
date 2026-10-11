import type {OpenSlideContent,RehearsalSlide} from '../shared/contracts';

// Minimal Office.js surface used by the task pane. office.js is loaded from
// Microsoft's CDN only on taskpane.html, so every call is feature-detected.
type Loadable<T> = T & { load: (props: string) => void };
type OfficeTextRange = Loadable<{ text: string }>;
type OfficeShape = Loadable<{ id: string; name: string; type: string; textFrame: Loadable<{ hasText?: boolean; textRange: OfficeTextRange }> }>;
type OfficeShapes = Loadable<{ items: OfficeShape[] }>;
type OfficeSlide = { id: string; shapes: OfficeShapes; delete: () => void };
type OfficeSlides = Loadable<{ items: OfficeSlide[]; getItem?: (id: string) => OfficeSlide }>;
type PowerPointContext = {
  presentation: {
    slides: OfficeSlides;
    getSelectedSlides?: () => OfficeSlides;
    insertSlidesFromBase64: (base64: string, options?: { formatting?: string; targetSlideId?: string }) => void;
  };
  sync: () => Promise<void>;
};
type OfficeFile = { size: number; sliceCount: number; getSliceAsync: (index: number, callback: (result: AsyncResult<{ data: number[] | Uint8Array }>) => void) => void; closeAsync: (callback?: () => void) => void };
type AsyncResult<T> = { status: string; value: T; error?: { message?: string } };
type OfficeGlobal = {
  context?: { host?: string; requirements?: { isSetSupported: (name: string, version?: string) => boolean }; document?: { getFileAsync?: (type: string, options: { sliceSize: number }, callback: (result: AsyncResult<OfficeFile>) => void) => void } };
  HostType?: { PowerPoint: string };
  FileType?: { Compressed: string };
};
declare global {
  interface Window { Office?: OfficeGlobal; PowerPoint?: { run: <T>(batch: (context: PowerPointContext) => Promise<T>) => Promise<T> } }
}

function supports(version: string) {
  try { return !!window.Office?.context?.requirements?.isSetSupported('PowerPointApi', version); } catch { return false; }
}
/** True inside PowerPoint (desktop, web or Mac), regardless of API level. */
export function inPowerPoint() {
  const office = window.Office;
  try { return !!office?.context?.requirements && office.context.host === (office.HostType?.PowerPoint ?? 'PowerPoint') && !!window.PowerPoint?.run; } catch { return false; }
}
/** True only inside PowerPoint with insertSlidesFromBase64 (PowerPointApi 1.2). */
export function canInsertIntoPresentation() { return inPowerPoint() && supports('1.2'); }
/** Reading the selected slide's shapes and text needs PowerPointApi 1.5. */
export function canReadSelection() { return inPowerPoint() && supports('1.5'); }
/** PowerPoint for the web: the pane is a frame inside a public page, so the
 * browser blocks connections to this PC (localhost) from it. */
export function inWebPowerPoint() { try { return inPowerPoint() && (window.Office?.context as { platform?: string } | undefined)?.platform === 'OfficeOnline'; } catch { return false; } }
export function canReadPresentationFile() { return inPowerPoint() && !!window.Office?.context?.document?.getFileAsync; }

function toBase64(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}

/** Inserts a generated deck after the given slide, the selected slide, or at the
 * end of the open presentation. Existing slides are never changed.
 * UseDestinationTheme lets slides made with the company template pick up the
 * deck's own master (logo, footer); otherwise the generated design is kept. */
export async function insertIntoPresentation(pptxUrl: string, options: { signal?: AbortSignal; afterSlideId?: string; useDestinationTheme?: boolean } = {}) {
  if (!canInsertIntoPresentation() || !window.PowerPoint) throw new Error('このPowerPointでは資料への直接挿入に対応していません。「保存」したファイルを開いてください。');
  const response = await fetch(pptxUrl, { signal: options.signal, credentials: 'same-origin' });
  if (!response.ok) throw new Error('作成したファイルを読み込めませんでした。もう一度作成してください。');
  const base64 = toBase64(await response.arrayBuffer());
  const selectionSupported = supports('1.5');
  return window.PowerPoint.run(async context => {
    const presentation = context.presentation;
    const selected = !options.afterSlideId && selectionSupported && presentation.getSelectedSlides ? presentation.getSelectedSlides() : undefined;
    selected?.load('items/id');
    presentation.slides.load('items/id');
    await context.sync();
    const target = options.afterSlideId ?? selected?.items.at(-1)?.id ?? presentation.slides.items.at(-1)?.id;
    presentation.insertSlidesFromBase64(base64, { formatting: options.useDestinationTheme ? 'UseDestinationTheme' : 'KeepSourceFormatting', ...(target ? { targetSlideId: target } : {}) });
    await context.sync();
  });
}

const TEXT_TYPES = new Set(['GeometricShape', 'TextBox', 'Placeholder', 'Freeform', 'Unsupported']);
async function shapeTexts(context: PowerPointContext, slide: OfficeSlide) {
  slide.shapes.load('items/id,items/name,items/type');
  await context.sync();
  const candidates = slide.shapes.items.filter(shape => TEXT_TYPES.has(shape.type));
  const read = async (shapes: OfficeShape[]) => { for (const shape of shapes) shape.textFrame.textRange.load('text'); await context.sync(); return shapes.map(shape => ({ id: shape.id, name: shape.name, text: shape.textFrame.textRange.text ?? '' })); };
  try { return await read(candidates); }
  catch {
    // One shape without a text frame fails the batch; read them one by one.
    const result: { id: string; name: string; text: string }[] = [];
    for (const shape of candidates) { try { result.push(...await read([shape])); } catch { /* No text in this shape. */ } }
    return result;
  }
}
function pickTitle(shapes: { name: string; text: string }[]) {
  return (shapes.find(shape => /title|タイトル/i.test(shape.name)) ?? shapes[0])?.text.split(/\r?\n/)[0]?.trim().slice(0, 200);
}

/** Text of the selected slide (first one when several are selected). */
export async function readSelectedSlide(): Promise<OpenSlideContent> {
  if (!canReadSelection() || !window.PowerPoint) throw new Error('この操作には、選択中のスライドを読み取れるPowerPoint（Microsoft 365の最新版）が必要です。');
  return window.PowerPoint.run(async context => {
    const selected = context.presentation.getSelectedSlides!();
    selected.load('items/id');
    context.presentation.slides.load('items/id');
    await context.sync();
    const slide = selected.items[0];
    if (!slide) throw new Error('スライドを1枚選択してください。');
    const shapes = (await shapeTexts(context, slide)).filter(shape => shape.text.trim());
    const index = context.presentation.slides.items.findIndex(item => item.id === slide.id);
    return { slideId: slide.id, index, title: pickTitle(shapes), shapes };
  });
}

/** Every slide's text, for presentation preparation of the open deck. */
export async function readAllSlides(limit = 60): Promise<RehearsalSlide[]> {
  if (!canReadSelection() || !window.PowerPoint) throw new Error('この操作には、スライドの文章を読み取れるPowerPoint（Microsoft 365の最新版）が必要です。');
  return window.PowerPoint.run(async context => {
    context.presentation.slides.load('items/id');
    await context.sync();
    const result: RehearsalSlide[] = [];
    for (const [index, slide] of context.presentation.slides.items.slice(0, limit).entries()) {
      const shapes = (await shapeTexts(context, slide)).filter(shape => shape.text.trim());
      const title = pickTitle(shapes) ?? `スライド ${index + 1}`;
      result.push({ id: slide.id, title, text: shapes.map(shape => shape.text.trim()).filter(text => !text.startsWith(title)).join('\n').slice(0, 6000) });
    }
    return result;
  });
}

/** Replaces the text of the given shapes on one slide (Ctrl+Z restores it). */
export async function replaceShapeTexts(slideId: string, replacements: { id: string; text: string }[]) {
  if (!canReadSelection() || !window.PowerPoint) throw new Error('このPowerPointでは文章を書き換えられません。');
  return window.PowerPoint.run(async context => {
    context.presentation.slides.load('items/id');
    await context.sync();
    const slide = context.presentation.slides.items.find(item => item.id === slideId);
    if (!slide) throw new Error('対象のスライドが見つかりません。削除または移動された可能性があります。');
    slide.shapes.load('items/id');
    await context.sync();
    for (const replacement of replacements) {
      const shape = slide.shapes.items.find(item => item.id === replacement.id);
      if (!shape) throw new Error('対象の図形が見つかりません。スライドを編集した場合はもう一度読み取ってください。');
      shape.textFrame.textRange.text = replacement.text;
    }
    await context.sync();
  });
}

export async function deleteSlide(slideId: string) {
  if (!canInsertIntoPresentation() || !window.PowerPoint) return;
  await window.PowerPoint.run(async context => {
    context.presentation.slides.load('items/id');
    await context.sync();
    context.presentation.slides.items.find(item => item.id === slideId)?.delete();
    await context.sync();
  });
}

/** The open presentation as PPTX bytes (to read its theme). Nothing is uploaded. */
export function readPresentationFile(maxBytes = 60 * 1024 * 1024): Promise<Uint8Array> {
  const office = window.Office;
  return new Promise((resolve, reject) => {
    const getFile = office?.context?.document?.getFileAsync;
    if (!getFile) { reject(new Error('このPowerPointでは開いている資料を読み取れません。テンプレートのファイルを選んでください。')); return; }
    getFile.call(office!.context!.document, office!.FileType?.Compressed ?? 'compressed', { sliceSize: 4 * 1024 * 1024 }, result => {
      if (result.status !== 'succeeded') { reject(new Error(result.error?.message || '開いている資料を読み取れませんでした。')); return; }
      const file = result.value;
      if (file.size > maxBytes) { file.closeAsync(); reject(new Error('資料が大きすぎるため読み取りを止めました。テンプレートのファイル（.potx）を選んでください。')); return; }
      const chunks: Uint8Array[] = [];
      const next = (index: number) => {
        if (index >= file.sliceCount) {
          file.closeAsync();
          const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
          let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
          resolve(bytes); return;
        }
        file.getSliceAsync(index, slice => {
          if (slice.status !== 'succeeded') { file.closeAsync(); reject(new Error('資料の読み取りに失敗しました。')); return; }
          chunks.push(slice.value.data instanceof Uint8Array ? slice.value.data : new Uint8Array(slice.value.data));
          next(index + 1);
        });
      };
      next(0);
    });
  });
}

/** Desktop app link for a chat page. Claude Desktop handles claude://claude.ai/…
 * (the same paths as the web). Other services open in the browser. */
export function appUrlFor(url: string) {
  try { const parsed = new URL(url); return parsed.hostname === 'claude.ai' ? `claude://claude.ai${parsed.pathname}${parsed.search}` : undefined; } catch { return undefined; }
}
/** Opens a chat service outside the task pane: the user's default browser (with
 * their own sign-in) or, when chosen, the desktop app. */
export function openExternal(url: string, inApp = false) {
  const app = inApp ? appUrlFor(url) : undefined;
  if (app) { window.open(app, '_blank'); return 'app'; }
  const ui = (window.Office?.context as { ui?: { openBrowserWindow?: (url: string) => void } } | undefined)?.ui;
  if (inPowerPoint() && ui?.openBrowserWindow) { try { ui.openBrowserWindow(url); return 'browser'; } catch { /* Fall back to a normal link. */ } }
  window.open(url, '_blank', 'noopener,noreferrer');
  return 'browser';
}
