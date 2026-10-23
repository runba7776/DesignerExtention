import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import ExcelJS from 'exceljs';
import Papa from 'papaparse';
import { AppError } from './errors.js';
import { readPowerPoint } from './pptx.js';

const require = createRequire(import.meta.url);
const pdfParse = require('pdf-parse/lib/pdf-parse.js');

export {
  DOCUMENT_LIMITS,
  documentSummary,
  documentContext,
  type SourceUnit,
  type ParsedDocument,
} from './document-model.js';
import { DOCUMENT_LIMITS, type ParsedDocument } from './document-model.js';

/** Parse locally; extracted units enter user-authorized history after generation. No hidden clipping. */
export async function parseDocument(name: string, buffer: Buffer): Promise<ParsedDocument> {
  if (!buffer.length) throw new AppError(400, `${name}: ファイルが空です。`);
  if (buffer.length > DOCUMENT_LIMITS.bytes) throw new AppError(413, `${name}: 1ファイルは15 MBまでです。`);
  const safeName = name
    .split(/[\\/]/)
    .pop()!
    .replace(/[\u0000-\u001f]/g, '')
    .slice(0, 200);
  const extension = safeName.split('.').pop()!.toLowerCase();
  const id = randomUUID();
  const document: ParsedDocument = {
    id,
    name: safeName,
    kind: extension as ParsedDocument['kind'],
    units: 0,
    characters: 0,
    warnings: [],
    sources: [],
  };
  const add = (locator: string, text: string) => {
    if (document.sources.length >= DOCUMENT_LIMITS.rows + DOCUMENT_LIMITS.pages)
      throw new AppError(413, `${safeName}: 抽出した項目が多すぎます。対象スライドやシートを分けてください。`);
    document.characters += text.length;
    if (document.characters > DOCUMENT_LIMITS.characters)
      throw new AppError(
        413,
        `${safeName}: 抽出量が12万文字を超えました。対象ページやシートを分けてください。省略して送信することはありません。`,
      );
    document.sources.push({ id: `${id}:${document.sources.length + 1}`, locator, text });
  };
  try {
    if (extension === 'csv') {
      const text = decodeText(buffer, document.warnings);
      const parsed = Papa.parse<string[]>(text.replace(/^\uFEFF/, ''), { skipEmptyLines: false });
      if (parsed.errors.length)
        throw new AppError(422, `${safeName}: CSVの形式を確認してください（${parsed.errors[0].code}）。`);
      if (parsed.data.length > DOCUMENT_LIMITS.rows) throw new AppError(413, `${safeName}: CSVは12,000行までです。`);
      parsed.data.forEach((cells, index) => {
        if (cells.some(cell => cell.trim()))
          add(
            `行 ${index + 1}`,
            cells.map((value, column) => `${columnName(column + 1)}${index + 1}=${JSON.stringify(value)}`).join(' | '),
          );
      });
    } else if (extension === 'xlsx') {
      verifyZipBudget(buffer);
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(buffer as any);
      let rowCount = 0;
      workbook.eachSheet(sheet => {
        if (sheet.state !== 'visible')
          document.warnings.push(`「${sheet.name}」は非表示シートです。内容を抽出対象に含めています。`);
        sheet.eachRow({ includeEmpty: false }, row => {
          if (++rowCount > DOCUMENT_LIMITS.rows) throw new AppError(413, `${safeName}: Excelは合計12,000行までです。`);
          const parts: string[] = [];
          row.eachCell({ includeEmpty: false }, cell => {
            const value = cell.value;
            let text = cell.text;
            if (value && typeof value === 'object' && ('formula' in value || 'sharedFormula' in value)) {
              if (!('result' in value) || value.result === undefined) {
                text = '[数式の保存済み計算結果なし]';
                document.warnings.push(
                  `${sheet.name}!${cell.address}: 数式を再計算できません。Excelで計算・保存してから再入力してください。`,
                );
              } else text = typeof value.result === 'object' ? JSON.stringify(value.result) : String(value.result);
            } else if (value instanceof Date) text = value.toISOString();
            else if (typeof value === 'number')
              text = `${value}${cell.numFmt && cell.numFmt !== 'General' ? ` (表示形式: ${cell.numFmt})` : ''}`;
            if (cell.isMerged && cell.master.address !== cell.address) text = `[結合元 ${cell.master.address}]`;
            parts.push(`${cell.address}=${JSON.stringify(text)}`);
          });
          if (parts.length) add(`${sheet.name}!行 ${row.number}`, parts.join(' | '));
        });
      });
      document.warnings.push(
        'Excel数式は実行せず、ファイルに保存された計算結果を使用します。外部リンクは取得しません。',
      );
    } else if (extension === 'pptx') {
      verifyZipBudget(buffer);
      await readPowerPoint(buffer, add, document.warnings, DOCUMENT_LIMITS.pages);
    } else if (extension === 'pdf') {
      if (!buffer.subarray(0, 1024).includes(Buffer.from('%PDF-')))
        throw new AppError(422, `${safeName}: PDFファイルとして読み取れません。`);
      let pageCount = 0;
      let emptyPages = 0;
      await pdfParse(buffer, {
        max: 0,
        pagerender: async (page: any) => {
          if (++pageCount > DOCUMENT_LIMITS.pages)
            throw new AppError(413, `${safeName}: PDFは180ページまでです。対象ページを分けてください。`);
          const content = await page.getTextContent({ normalizeWhitespace: false, disableCombineTextItems: false });
          let previousY: number | undefined;
          const chunks: string[] = [];
          for (const item of content.items) {
            const y = item.transform?.[5];
            if (previousY !== undefined && y !== previousY) chunks.push('\n');
            else if (chunks.length) chunks.push(' ');
            chunks.push(item.str || '');
            previousY = y;
          }
          const text = chunks.join('').trim();
          if (text.length < 10) emptyPages++;
          add(`p.${page.pageNumber ?? pageCount}`, text || '[抽出可能な文字なし]');
          return '';
        },
      });
      if (emptyPages === pageCount)
        throw new AppError(
          422,
          `${safeName}: 文字を抽出できません。画像のみのPDFには現在対応していません。文字認識済みPDFを使用してください。`,
          'OCR_REQUIRED',
        );
      if (emptyPages)
        document.warnings.push(
          `${emptyPages}ページで文字をほぼ抽出できませんでした。画像や図中の文字を含むページは原本を確認してください。`,
        );
      document.warnings.push(
        'PDFの図・画像は解析しません。表の読み順が変わる場合があるため、数値の対応を原本で確認してください。',
      );
    } else if (extension === 'txt' || extension === 'md') {
      document.kind = 'txt';
      const text = decodeText(buffer, document.warnings);
      text.split(/\r?\n/).forEach((line, index) => {
        if (line.trim()) add(`行 ${index + 1}`, line);
      });
    } else
      throw new AppError(
        415,
        `${safeName}: 未対応の形式です。PDF / CSV / XLSX / PPTX / TXT / MDを使用してください。.xlsは.xlsx、.pptは.pptxとして保存してください。`,
      );
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(
      422,
      `${safeName}: ファイルを読み取れません。破損・暗号化・形式を確認してください。`,
      'PARSE_FAILED',
    );
  }
  if (!document.sources.length) throw new AppError(422, `${safeName}: 使用できる文字やデータがありません。`);
  document.units = document.sources.length;
  document.warnings = [...new Set(document.warnings)];
  return document;
}

function columnName(number: number): string {
  let result = '';
  while (number > 0) {
    number--;
    result = String.fromCharCode(65 + (number % 26)) + result;
    number = Math.floor(number / 26);
  }
  return result;
}

function decodeText(buffer: Buffer, warnings: string[]): string {
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return new TextDecoder('utf-16le').decode(buffer);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    warnings.push('UTF-8として読めなかったため、Shift_JISで読み取りました。文字化けがないか確認してください。');
    return new TextDecoder('shift_jis', { fatal: true }).decode(buffer);
  }
}

/** Check central-directory size before ExcelJS expands ZIP entries. Reject ZIP64 and oversized archives. */
export function verifyZipBudget(buffer: Buffer) {
  let total = 0;
  let count = 0;
  for (let i = 0; i + 46 <= buffer.length; i++) {
    if (buffer.readUInt32LE(i) !== 0x02014b50) continue;
    const bytes = buffer.readUInt32LE(i + 24);
    const compressed = buffer.readUInt32LE(i + 20);
    if (bytes === 0xffffffff || compressed === 0xffffffff)
      throw new AppError(413, 'ZIP64形式には対応していません。小さなファイルに分けてください。');
    total += bytes;
    count++;
    if (total > DOCUMENT_LIMITS.uncompressedBytes || count > 10_000)
      throw new AppError(413, '展開後の資料が大きすぎます。対象シート・スライドだけを保存してください。');
    i += 45 + buffer.readUInt16LE(i + 28) + buffer.readUInt16LE(i + 30) + buffer.readUInt16LE(i + 32);
  }
  if (!count) throw new AppError(422, 'XLSX / PPTXの構造を読み取れません。');
}
