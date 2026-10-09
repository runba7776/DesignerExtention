// pdf-parse compatible text extraction for the browser build, using pdf.js.
// Only text is read: no scripts, forms, fonts or images are evaluated.
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

type PageRender = (page: { pageNumber: number; getTextContent: (options?: unknown) => Promise<{ items: { str?: string; transform?: number[] }[] }> }) => Promise<string>;

export default async function pdfParse(data: Uint8Array, options: { max?: number; pagerender?: PageRender } = {}) {
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  // Character maps let pdf.js decode Japanese text in PDFs that use CID fonts.
  const cMapUrl = new URL('pdfjs/cmaps/', document.baseURI).href;
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(data), cMapUrl, cMapPacked: true, isEvalSupported: false, disableFontFace: true, enableXfa: false, stopAtErrors: false }).promise;
  try {
    let text = '';
    const last = options.max ? Math.min(options.max, pdf.numPages) : pdf.numPages;
    for (let number = 1; number <= last; number++) {
      const page = await pdf.getPage(number);
      text += options.pagerender ? await options.pagerender(page as never) : '';
      page.cleanup();
    }
    return { numpages: pdf.numPages, text };
  } finally { await pdf.destroy(); }
}
