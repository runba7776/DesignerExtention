import JSZip from 'jszip';
import { SaxesParser } from 'saxes';
import { AppError } from './errors.js';

const P = 'http://schemas.openxmlformats.org/presentationml/2006/main',
  A = 'http://schemas.openxmlformats.org/drawingml/2006/main',
  C = 'http://schemas.openxmlformats.org/drawingml/2006/chart',
  R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
type Node = { local: string; uri: string; attrs: Record<string, string>; children: (Node | string)[] };
function xml(text: string): Node {
  const root: Node = { local: 'root', uri: '', attrs: {}, children: [] },
    stack = [root],
    parser = new SaxesParser({ xmlns: true });
  parser.on('doctype', () => {
    throw new AppError(422, '外部実体やDTDを含むXMLには対応していません。');
  });
  parser.on('opentag', tag => {
    const node: Node = { local: tag.local, uri: tag.uri, attrs: {}, children: [] };
    for (const value of Object.values(tag.attributes)) node.attrs[`${value.uri}|${value.local}`] = value.value;
    stack.at(-1)!.children.push(node);
    stack.push(node);
  });
  parser.on('text', text => stack.at(-1)!.children.push(text));
  parser.on('cdata', text => stack.at(-1)!.children.push(text));
  parser.on('closetag', () => stack.pop());
  parser.write(text).close();
  return root;
}
const attr = (node: Node, name: string, uri = '') => node.attrs[`${uri}|${name}`];
function find(node: Node, name: string, uri?: string): Node[] {
  return [
    ...(node.local === name && (!uri || node.uri === uri) ? [node] : []),
    ...node.children.flatMap(c => (typeof c === 'string' ? [] : find(c, name, uri))),
  ];
}
const content = (node: Node): string => node.children.map(c => (typeof c === 'string' ? c : content(c))).join('');
function paragraphs(node: Node) {
  return find(node, 'p', A)
    .map(p =>
      p.children
        .map(c => (typeof c === 'string' ? '' : c.local === 'br' ? '\n' : find(c, 't', A).map(content).join('')))
        .join(''),
    )
    .join('\n')
    .trim();
}
function part(base: string, target: string) {
  const url = new URL(target, `https://package/${base}`);
  if (url.protocol !== 'https:' || url.hostname !== 'package')
    throw new AppError(422, '外部のPowerPoint部品は読み込みません。');
  return decodeURIComponent(url.pathname.slice(1));
}
// The ZIP central directory records each part's expanded size; check it before
// inflating so the same code runs in Node and in the browser build.
const PART_LIMIT = 8 * 1024 * 1024;
async function readPart(zip: JSZip, name: string) {
  const file = zip.file(name);
  if (!file) throw new AppError(422, `PowerPointの部品が見つかりません（${name}）。`);
  const declared = (file as any)._data?.uncompressedSize;
  if (typeof declared === 'number' && declared > PART_LIMIT)
    throw new AppError(413, 'PowerPointの1部品が大きすぎます。スライドを分けてください。');
  const bytes = await file.async('uint8array');
  if (bytes.length > PART_LIMIT) throw new AppError(413, 'PowerPointの1部品が大きすぎます。スライドを分けてください。');
  return xml(new TextDecoder('utf-8').decode(bytes));
}
async function relations(zip: JSZip, name: string) {
  const relName = pathForRelations(name);
  if (!zip.file(relName)) return new Map<string, string>();
  const tree = await readPart(zip, relName);
  return new Map(
    find(tree, 'Relationship')
      .filter(r => attr(r, 'TargetMode') !== 'External')
      .map(r => [attr(r, 'Id'), part(name, attr(r, 'Target'))]),
  );
}
function pathForRelations(name: string) {
  const slash = name.lastIndexOf('/');
  return `${name.slice(0, slash + 1)}_rels/${name.slice(slash + 1)}.rels`;
}
function cache(node: Node, kind: 'str' | 'num') {
  const cached = find(node, `${kind}Cache`, C)[0] ?? find(node, `${kind}Lit`, C)[0];
  if (!cached) return [];
  const points = find(cached, 'pt', C),
    indexes = points.map(p => Number(attr(p, 'idx'))),
    declared = Number(attr(find(cached, 'ptCount', C)[0] ?? cached, 'val') ?? 0);
  if (
    !Number.isInteger(declared) ||
    declared < 0 ||
    indexes.some(i => !Number.isInteger(i) || i < 0) ||
    new Set(indexes).size !== indexes.length
  )
    throw new AppError(422, 'グラフの保存値の位置が正しくありません。');
  const count = Math.max(declared, ...indexes.map(i => i + 1));
  if (count > 12_000) throw new AppError(413, 'グラフの保存値は12,000件までです。');
  const values = new Map(points.map((p, i) => [indexes[i], content(find(p, 'v', C)[0] ?? { ...p, children: [] })]));
  return Array.from({ length: count }, (_, i) => values.get(i) ?? '[保存値なし]');
}

/** Read content only. No Office automation, macros, links, or remote image fetches. */
export async function readPowerPoint(
  buffer: Uint8Array,
  add: (locator: string, text: string) => void,
  warnings: string[],
  maxSlides: number,
) {
  const zip = await JSZip.loadAsync(buffer);
  if (!zip.file('ppt/presentation.xml')) throw new AppError(422, 'PPTXの構造を読み取れません。');
  if (Object.keys(zip.files).some(n => /vbaProject\.bin$/i.test(n)))
    throw new AppError(415, 'マクロを含むPowerPointには対応していません。通常の.pptxとして保存してください。');
  const pres = await readPart(zip, 'ppt/presentation.xml'),
    presRels = await relations(zip, 'ppt/presentation.xml'),
    slides = find(pres, 'sldId', P);
  if (slides.length > maxSlides) throw new AppError(413, `PowerPointは${maxSlides}スライドまでです。`);
  let pictureCount = 0,
    emptySlides = 0;
  for (const [index, slideRef] of slides.entries()) {
    const name = presRels.get(attr(slideRef, 'id', R));
    if (!name) throw new AppError(422, 'PowerPointのスライド参照が見つかりません。');
    const slide = await readPart(zip, name),
      rels = await relations(zip, name),
      prefix = `スライド ${index + 1}`;
    let units = 0;
    if (attr(find(slide, 'sld', P)[0], 'show') === '0')
      warnings.push(`${prefix}は非表示ですが、抽出対象に含めています。`);
    for (const [i, shape] of find(slide, 'sp', P).entries()) {
      const text = paragraphs(shape);
      if (text) {
        add(`${prefix} 図形 ${i + 1}`, text);
        units++;
      }
    }
    for (const [i, table] of find(slide, 'tbl', A).entries())
      for (const [rowIndex, row] of find(table, 'tr', A).entries()) {
        const cells = row.children.filter((c): c is Node => typeof c !== 'string' && c.local === 'tc').map(paragraphs);
        add(`${prefix} 表 ${i + 1} 行 ${rowIndex + 1}`, JSON.stringify(cells));
        units++;
      }
    for (const [i, ref] of find(slide, 'chart', C).entries()) {
      const chartName = rels.get(attr(ref, 'id', R));
      if (!chartName) {
        warnings.push(`${prefix}の外部グラフは取得していません。`);
        continue;
      }
      const chart = await readPart(zip, chartName),
        headings = find(chart, 'title', C).map(paragraphs).filter(Boolean),
        series = find(chart, 'ser', C);
      let valuesFound = false;
      for (const [sIndex, s] of series.entries()) {
        const tx = find(s, 'tx', C)[0],
          label = tx ? (cache(tx, 'str')[0] ?? find(tx, 'v', C).map(content).join('')) : `系列 ${sIndex + 1}`;
        const cat = find(s, 'cat', C)[0] ?? find(s, 'xVal', C)[0],
          val = find(s, 'val', C)[0] ?? find(s, 'yVal', C)[0];
        const categories = cat ? (cache(cat, 'str').length ? cache(cat, 'str') : cache(cat, 'num')) : [],
          values = val ? cache(val, 'num') : [];
        if (values.length) {
          add(
            `${prefix} グラフ ${i + 1} 系列 ${sIndex + 1}`,
            JSON.stringify({ 見出しと単位: headings, 系列: label, 項目: categories, 数値: values }),
          );
          units++;
          valuesFound = true;
          if (categories.length && categories.length !== values.length)
            warnings.push(
              `${prefix} グラフ ${i + 1}: 保存された項目名と数値の数が異なります。原本を確認してください。`,
            );
          if ([...values, ...categories].includes('[保存値なし]'))
            warnings.push(`${prefix} グラフ ${i + 1}: 欠けた保存値があります。位置を保持し、数値を推測していません。`);
        }
      }
      if (!valuesFound)
        warnings.push(`${prefix} グラフ ${i + 1}: 保存された数値を読み取れませんでした。数値を推測していません。`);
    }
    for (const [i, ids] of find(slide, 'relIds').entries()) {
      const dm = Object.entries(ids.attrs).find(([key]) => key.endsWith('|dm'))?.[1],
        data = dm ? rels.get(dm) : undefined;
      if (data) {
        const text = paragraphs(await readPart(zip, data));
        if (text) {
          add(`${prefix} SmartArt ${i + 1}`, text);
          units++;
        }
      }
    }
    const notesName = [...rels.values()].find(name => name.startsWith('ppt/notesSlides/') && name.endsWith('.xml'));
    if (notesName) {
      const notes = await readPart(zip, notesName);
      for (const shape of find(notes, 'sp', P)) {
        if (!find(shape, 'ph', P).some(ph => attr(ph, 'type') === 'body')) continue;
        const text = paragraphs(shape);
        if (text) {
          add(`${prefix} 発表者ノート`, text);
          units++;
        }
      }
    }
    pictureCount += find(slide, 'pic', P).length;
    if (!units) emptySlides++;
  }
  warnings.push(
    'PowerPointの文字・表・SmartArt内の文字・保存済みグラフ数値・発表者ノートを抽出します。元の配置やテーマの再現、画像内の文字認識は行いません。外部リンク・マクロは実行しません。',
  );
  if (pictureCount)
    warnings.push(`${pictureCount}個の画像は解析していません。画像だけで示した情報は原本を確認してください。`);
  if (emptySlides) warnings.push(`${emptySlides}スライドから文字や保存済み数値を抽出できませんでした。`);
}
