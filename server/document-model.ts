import { AppError } from './errors.js';

/** Document types and limits shared by the local server and the browser build.
 * Parsing (PDF/XLSX/PPTX) lives in documents.ts and is loaded only when needed. */
export const DOCUMENT_LIMITS = {
  bytes: 15 * 1024 * 1024,
  files: 8,
  characters: 120_000,
  pages: 180,
  rows: 12_000,
  uncompressedBytes: 80 * 1024 * 1024,
};
export interface SourceUnit {
  id: string;
  locator: string;
  text: string;
}
export interface ParsedDocument {
  id: string;
  name: string;
  kind: 'pdf' | 'csv' | 'xlsx' | 'pptx' | 'txt';
  units: number;
  characters: number;
  warnings: string[];
  sources: SourceUnit[];
}

export function documentSummary({ sources: _sources, ...metadata }: ParsedDocument) {
  return metadata;
}

export function documentContext(documents: ParsedDocument[]) {
  const context = documents.map(document => ({
    documentId: document.id,
    name: document.name,
    warnings: document.warnings,
    units: document.sources,
  }));
  const characters = documents.reduce((sum, document) => sum + document.characters, 0);
  if (characters > DOCUMENT_LIMITS.characters)
    throw new AppError(
      413,
      '資料の合計抽出量が12万文字を超えました。資料を分けてください。省略して送信することはありません。',
    );
  return context;
}
