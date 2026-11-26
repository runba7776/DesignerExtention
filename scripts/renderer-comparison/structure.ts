/** Reads what a PPTX holds on each slide (the kind, place, text and look of each object) so the files of the two
 * renderers can be compared object by object, without PowerPoint. */
import JSZip from 'jszip';
import { SaxesParser } from 'saxes';

const P = 'http://schemas.openxmlformats.org/presentationml/2006/main',
  A = 'http://schemas.openxmlformats.org/drawingml/2006/main',
  R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const EMU_PER_PT = 12700;

type Node = { local: string; uri: string; attrs: Record<string, string>; children: (Node | string)[] };
function xml(text: string): Node {
  const root: Node = { local: 'root', uri: '', attrs: {}, children: [] },
    stack = [root],
    parser = new SaxesParser({ xmlns: true });
  parser.on('doctype', () => {
    throw new Error('DTD in a PPTX part');
  });
  parser.on('opentag', tag => {
    const node: Node = { local: tag.local, uri: tag.uri, attrs: {}, children: [] };
    for (const value of Object.values(tag.attributes)) node.attrs[value.local] = value.value;
    stack.at(-1)!.children.push(node);
    stack.push(node);
  });
  parser.on('text', text => stack.at(-1)!.children.push(text));
  parser.on('closetag', () => stack.pop());
  parser.write(text).close();
  return root;
}
const kids = (node: Node) => node.children.filter((c): c is Node => typeof c !== 'string');
const child = (node: Node | undefined, local: string) => node && kids(node).find(c => c.local === local);
function all(node: Node, local: string, uri = A): Node[] {
  return kids(node).flatMap(c => [...(c.local === local && c.uri === uri ? [c] : []), ...all(c, local, uri)]);
}
const content = (node: Node): string => node.children.map(c => (typeof c === 'string' ? c : content(c))).join('');

export type ObjectKind = 'shape' | 'text' | 'picture' | 'chart' | 'table' | 'diagram' | 'connector' | 'line';
/** One object of a slide, in points from the slide's top left corner (a group's parts at their place on the slide). */
export interface SlideObject {
  kind: ObjectKind;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Preset geometry (rect, ellipse…), or custom for a freeform. */
  geometry?: string;
  text: string;
  fontSizes: number[];
  fonts: string[];
  fill?: string;
  line?: string;
  rotation?: number;
  /** The path of groups it is in (1/2: the second group inside the first). */
  group?: string;
  placeholder?: string;
}
export interface SlideStructure {
  number: number;
  background?: string;
  objects: SlideObject[];
  groups: number;
  notes: string;
}

type Transform = (x: number, y: number, w: number, h: number) => [number, number, number, number];
const identity: Transform = (x, y, w, h) => [x, y, w, h];

function color(fillParent: Node | undefined): string | undefined {
  if (!fillParent) return undefined;
  if (child(fillParent, 'noFill')) return 'none';
  const solid = child(fillParent, 'solidFill');
  if (solid) {
    const srgb = child(solid, 'srgbClr'),
      scheme = child(solid, 'schemeClr');
    return srgb ? `#${srgb.attrs.val.toUpperCase()}` : scheme ? `scheme:${scheme.attrs.val}` : undefined;
  }
  if (child(fillParent, 'gradFill')) return 'gradient';
  if (child(fillParent, 'blipFill')) return 'picture';
  return undefined;
}

function xfrm(node: Node | undefined) {
  const off = child(node, 'off'),
    ext = child(node, 'ext');
  if (!off || !ext) return undefined;
  return {
    x: Number(off.attrs.x) / EMU_PER_PT,
    y: Number(off.attrs.y) / EMU_PER_PT,
    w: Number(ext.attrs.cx) / EMU_PER_PT,
    h: Number(ext.attrs.cy) / EMU_PER_PT,
    rotation: node!.attrs.rot ? Number(node!.attrs.rot) / 60000 : undefined,
    chOff: child(node, 'chOff'),
    chExt: child(node, 'chExt'),
  };
}

function textOf(node: Node) {
  const body = kids(node).find(c => c.local === 'txBody');
  if (!body) return { text: '', fontSizes: [], fonts: [] };
  const text = all(body, 'p')
    .map(p => all(p, 't').map(content).join(''))
    .join('\n')
    .trim();
  const sizes = all(body, 'rPr').flatMap(r => (r.attrs.sz ? [Number(r.attrs.sz) / 100] : []));
  const fonts = all(body, 'ea').flatMap(f => (f.attrs.typeface ? [f.attrs.typeface] : []));
  return { text, fontSizes: [...new Set(sizes)].sort((a, b) => a - b), fonts: [...new Set(fonts)].sort() };
}

function tableText(node: Node) {
  return all(node, 'tc')
    .map(tc =>
      all(tc, 'p')
        .map(p => all(p, 't').map(content).join(''))
        .join('\n'),
    )
    .join(' | ');
}

function walk(
  tree: Node,
  place: Transform,
  group: string | undefined,
  out: SlideObject[],
  counter: { groups: number },
) {
  let index = 0;
  for (const node of kids(tree)) {
    if (node.uri !== P) continue;
    const props = child(node, 'spPr') ?? child(node, 'grpSpPr');
    const nv = kids(node).find(c => c.local.startsWith('nv'));
    const cNvPr = nv && child(nv, 'cNvPr');
    const name = cNvPr?.attrs.name ?? '';
    const ph = nv && child(child(nv, 'nvPr'), 'ph');
    if (node.local === 'grpSp') {
      counter.groups++;
      const t = xfrm(child(props, 'xfrm'));
      const path = `${group ? `${group}/` : ''}${++index}`;
      let inner = place;
      if (t?.chOff && t.chExt) {
        const cx = Number(t.chOff.attrs.x) / EMU_PER_PT,
          cy = Number(t.chOff.attrs.y) / EMU_PER_PT,
          cw = Number(t.chExt.attrs.cx) / EMU_PER_PT || 1,
          ch = Number(t.chExt.attrs.cy) / EMU_PER_PT || 1,
          sx = t.w / cw,
          sy = t.h / ch;
        inner = (x, y, w, h) => place(t.x + (x - cx) * sx, t.y + (y - cy) * sy, w * sx, h * sy);
      }
      walk(node, inner, path, out, counter);
      continue;
    }
    if (!['sp', 'pic', 'graphicFrame', 'cxnSp'].includes(node.local)) continue;
    const t = xfrm(node.local === 'graphicFrame' ? child(node, 'xfrm') : child(props, 'xfrm'));
    const [x, y, w, h] = t ? place(t.x, t.y, t.w, t.h) : [0, 0, 0, 0];
    const geometry = child(props, 'prstGeom')?.attrs.prst ?? (child(props, 'custGeom') ? 'custom' : undefined);
    const { text, fontSizes, fonts } = textOf(node);
    let kind: ObjectKind;
    let objectText = text;
    if (node.local === 'pic') kind = 'picture';
    else if (node.local === 'cxnSp') kind = 'connector';
    else if (node.local === 'graphicFrame') {
      const uri = all(node, 'graphicData')[0]?.attrs.uri ?? '';
      kind = uri.endsWith('/chart') ? 'chart' : uri.endsWith('/table') ? 'table' : 'diagram';
      if (kind === 'table') objectText = tableText(node);
    } else if (geometry === 'line') kind = 'line';
    else {
      const fill = color(props),
        line = color(child(props, 'ln'));
      // A box with words and nothing drawn around it is a text; anything with a fill or an outline is a shape.
      const drawn = (fill && fill !== 'none') || (line && line !== 'none');
      kind = text && !drawn ? 'text' : 'shape';
    }
    out.push({
      kind,
      name,
      x: round(x),
      y: round(y),
      w: round(w),
      h: round(h),
      ...(geometry ? { geometry } : {}),
      text: objectText,
      fontSizes,
      fonts,
      ...(color(props) ? { fill: color(props) } : {}),
      ...(color(child(props, 'ln')) ? { line: color(child(props, 'ln')) } : {}),
      ...(t?.rotation ? { rotation: t.rotation } : {}),
      ...(group ? { group } : {}),
      ...(ph ? { placeholder: ph.attrs.type ?? 'body' } : {}),
    });
    index++;
  }
}
const round = (n: number) => Math.round(n * 10) / 10;

function relationships(text: string | undefined, base: string) {
  const map = new Map<string, string>();
  if (!text) return map;
  for (const rel of all(xml(text), 'Relationship', 'http://schemas.openxmlformats.org/package/2006/relationships')) {
    const target = rel.attrs.Target;
    map.set(rel.attrs.Id, target.startsWith('/') ? target.slice(1) : normalize(`${base}/${target}`));
  }
  return map;
}
function normalize(path: string) {
  const parts: string[] = [];
  for (const part of path.split('/'))
    if (part === '..') parts.pop();
    else if (part && part !== '.') parts.push(part);
  return parts.join('/');
}

/** The slides of a PPTX in their order. */
export async function readPptx(data: Uint8Array | ArrayBuffer): Promise<SlideStructure[]> {
  const zip = await JSZip.loadAsync(data);
  const read = (name: string) => zip.file(name)?.async('string');
  const presentation = xml((await read('ppt/presentation.xml')) ?? '');
  const rels = relationships(await read('ppt/_rels/presentation.xml.rels'), 'ppt');
  const ids = all(presentation, 'sldId', P).map(s => s.attrs.id && rels.get(s.attrs.id));
  const slides: SlideStructure[] = [];
  for (const [i, file] of ids.entries()) {
    if (!file) continue;
    const root = xml((await read(file)) ?? '');
    const tree = all(root, 'spTree', P)[0];
    const objects: SlideObject[] = [],
      counter = { groups: 0 };
    if (tree) walk(tree, identity, undefined, objects, counter);
    const bg = all(root, 'bgPr', P)[0];
    const slideRels = relationships(
      await read(file.replace(/slides\/(slide\d+\.xml)$/, 'slides/_rels/$1.rels')),
      file.replace(/\/[^/]+$/, ''),
    );
    const notesFile = [...slideRels.values()].find(target => /notesSlide\d+\.xml$/.test(target));
    let notes = '';
    if (notesFile) {
      const notesRoot = xml((await read(notesFile)) ?? '');
      // The body placeholder holds the notes; the slide image placeholder holds none.
      notes = all(notesRoot, 'sp', P)
        .map(sp => textOf(sp).text)
        .filter(Boolean)
        .filter(text => !/^\d+$/.test(text))
        .join('\n');
    }
    slides.push({
      number: i + 1,
      ...(bg && color(bg) ? { background: color(bg) } : {}),
      objects,
      groups: counter.groups,
      notes,
    });
  }
  return slides;
}
