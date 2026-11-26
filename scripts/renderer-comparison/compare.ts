/** Pairs the objects of one slide drawn by the two renderers and lists where they differ. */
import type { ObjectKind, SlideObject, SlideStructure } from './structure';

export type DifferenceKind = 'missing' | 'extra' | 'kind' | 'place' | 'size' | 'text' | 'font' | 'fill' | 'geometry';
export interface Difference {
  kind: DifferenceKind;
  /** What the difference is, in Japanese, for the report. */
  message: string;
  native?: SlideObject;
  hosted?: SlideObject;
}
export interface SlideComparison {
  number: number;
  differences: Difference[];
  counts: { native: Partial<Record<ObjectKind, number>>; hosted: Partial<Record<ObjectKind, number>> };
  groups: { native: number; hosted: number };
  notesEqual: boolean;
  backgroundEqual: boolean;
}

/** Differences under this many points are rounding (EMU/inch conversions), not a different drawing. */
const TOLERANCE_PT = 1.5;
const kindNames: Record<ObjectKind, string> = {
  shape: '図形',
  text: 'テキスト',
  picture: '画像',
  chart: 'グラフ',
  table: '表',
  diagram: 'SmartArt',
  connector: 'コネクタ',
  line: '線',
};
const normalizeText = (text: string) => text.replace(/\s+/g, '');
const label = (o: SlideObject) =>
  `${kindNames[o.kind]}${o.text ? `「${o.text.length > 24 ? `${o.text.slice(0, 24)}…` : o.text}」` : ''}`;
/** A line can be written as a connector or a line shape; both draw the same stroke. */
const family = (kind: ObjectKind) => (kind === 'connector' || kind === 'line' ? 'stroke' : kind);

function count(objects: SlideObject[]) {
  const counts: Partial<Record<ObjectKind, number>> = {};
  for (const o of objects) counts[o.kind] = (counts[o.kind] ?? 0) + 1;
  return counts;
}

function cost(a: SlideObject, b: SlideObject) {
  const textA = normalizeText(a.text),
    textB = normalizeText(b.text);
  const distance = Math.abs(a.x - b.x) + Math.abs(a.y - b.y) + Math.abs(a.w - b.w) + Math.abs(a.h - b.h);
  // Same words matter most, then the same kind of object, then the place.
  return (
    (textA === textB ? 0 : textA && textB && (textA.includes(textB) || textB.includes(textA)) ? 300 : 1000) +
    (a.kind === b.kind ? 0 : family(a.kind) === family(b.kind) ? 50 : 400) +
    distance
  );
}

/** Pairs each native object with the closest hosted one (cheapest first), then lists what differs. */
export function compareSlide(native: SlideStructure, hosted: SlideStructure): SlideComparison {
  const pairs: { a: number; b: number; cost: number }[] = [];
  native.objects.forEach((a, i) => hosted.objects.forEach((b, j) => pairs.push({ a: i, b: j, cost: cost(a, b) })));
  pairs.sort((p, q) => p.cost - q.cost);
  const usedA = new Set<number>(),
    usedB = new Set<number>(),
    matched: [SlideObject, SlideObject][] = [];
  for (const p of pairs) {
    if (usedA.has(p.a) || usedB.has(p.b) || p.cost >= 1400) continue;
    usedA.add(p.a);
    usedB.add(p.b);
    matched.push([native.objects[p.a], hosted.objects[p.b]]);
  }
  const differences: Difference[] = [];
  native.objects.forEach((o, i) => {
    if (!usedA.has(i)) differences.push({ kind: 'missing', message: `TS版にない: ${label(o)}`, native: o });
  });
  hosted.objects.forEach((o, i) => {
    if (!usedB.has(i)) differences.push({ kind: 'extra', message: `TS版だけにある: ${label(o)}`, hosted: o });
  });
  for (const [a, b] of matched) {
    const both = { native: a, hosted: b };
    if (a.kind !== b.kind && family(a.kind) !== family(b.kind))
      differences.push({
        kind: 'kind',
        message: `${label(a)}: C#は${kindNames[a.kind]}、TSは${kindNames[b.kind]}`,
        ...both,
      });
    const dx = b.x - a.x,
      dy = b.y - a.y,
      dw = b.w - a.w,
      dh = b.h - a.h;
    if (Math.abs(dx) > TOLERANCE_PT || Math.abs(dy) > TOLERANCE_PT)
      differences.push({
        kind: 'place',
        message: `${label(a)}: 位置が ${signed(dx)}, ${signed(dy)} pt ずれている`,
        ...both,
      });
    if (Math.abs(dw) > TOLERANCE_PT || Math.abs(dh) > TOLERANCE_PT)
      differences.push({
        kind: 'size',
        message: `${label(a)}: 大きさが ${signed(dw)} × ${signed(dh)} pt 違う`,
        ...both,
      });
    if (normalizeText(a.text) !== normalizeText(b.text))
      differences.push({ kind: 'text', message: `文字が違う: C#「${a.text}」 / TS「${b.text}」`, ...both });
    if (a.fontSizes.join() !== b.fontSizes.join() && a.fontSizes.length && b.fontSizes.length)
      differences.push({
        kind: 'font',
        message: `${label(a)}: 文字サイズ C# ${a.fontSizes.join('/')}pt / TS ${b.fontSizes.join('/')}pt`,
        ...both,
      });
    if (a.fonts.join() !== b.fonts.join() && a.fonts.length && b.fonts.length)
      differences.push({
        kind: 'font',
        message: `${label(a)}: 書体 C# ${a.fonts.join('/')} / TS ${b.fonts.join('/')}`,
        ...both,
      });
    if (a.kind === b.kind && a.kind === 'shape' && a.fill !== b.fill && a.fill && b.fill)
      differences.push({ kind: 'fill', message: `${label(a)}: 塗り C# ${a.fill} / TS ${b.fill}`, ...both });
    if (a.kind === b.kind && a.kind === 'shape' && a.geometry !== b.geometry)
      differences.push({
        kind: 'geometry',
        message: `${label(a)}: 形 C# ${a.geometry ?? '-'} / TS ${b.geometry ?? '-'}`,
        ...both,
      });
  }
  return {
    number: native.number,
    differences,
    counts: { native: count(native.objects), hosted: count(hosted.objects) },
    groups: { native: native.groups, hosted: hosted.groups },
    notesEqual: normalizeText(native.notes) === normalizeText(hosted.notes),
    backgroundEqual: (native.background ?? 'none') === (hosted.background ?? 'none'),
  };
}
const signed = (n: number) => `${n > 0 ? '+' : ''}${Math.round(n * 10) / 10}`;

export function compareDecks(native: SlideStructure[], hosted: SlideStructure[]) {
  if (native.length !== hosted.length)
    throw new Error(`スライド数が違います: C# ${native.length}枚 / TS ${hosted.length}枚`);
  return native.map((slide, i) => compareSlide(slide, hosted[i]));
}
