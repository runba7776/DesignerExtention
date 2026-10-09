import pdfParse from '../pdf';

// node:module for the browser build. server/documents.ts loads pdf-parse with
// createRequire; the browser build answers with a pdf.js-based equivalent.
export function createRequire(_base: string) {
  return (id: string) => {
    if (id.includes('pdf-parse')) return pdfParse;
    throw new Error(`${id} is not available in the browser build.`);
  };
}
export default { createRequire };
