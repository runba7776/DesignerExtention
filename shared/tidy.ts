import type { FreeDesign, FreeElement, ReviewHint, SlideSpec } from './contracts';
import { SLIDE_H, SLIDE_W } from './free-design';

type Box = Extract<FreeElement, { t: 'box' }>;
interface Area {
  x: number;
  y: number;
  w: number;
  h: number;
}
const area = (e: FreeElement): Area =>
  e.t === 'line'
    ? { x: Math.min(e.x1, e.x2), y: Math.min(e.y1, e.y2), w: Math.abs(e.x2 - e.x1), h: Math.abs(e.y2 - e.y1) }
    : e.t === 'icon'
      ? { x: e.x, y: e.y, w: e.size, h: e.size }
      : e;
const within = (a: Area, b: Area) =>
  a.x >= b.x - 1 && a.y >= b.y - 1 && a.x + a.w <= b.x + b.w + 1 && a.y + a.h <= b.y + b.h + 1;

/** The app's own finishing of an AI-designed page as it is drawn: its title in the deck's title size (a larger
 * one only) and its cards evened. The design itself is not changed. */
export function tidyDesign(design: FreeDesign, titleSize?: number): FreeDesign {
  const elements = design.elements.map(e =>
    e.t === 'text' && e.role === 'title' && titleSize && e.size > titleSize ? { ...e, size: titleSize } : e,
  );
  return { ...design, elements: evenCards(elements) };
}

/** The title size of a deck's AI-designed pages after the cover: the smallest one, so that the title does not
 * change size from page to page and no title grows out of its place. */
export function deckTitleSize(slides: SlideSpec[]) {
  const sizes = slides.flatMap(s =>
    s.layoutId === 'cover'
      ? []
      : (s.design?.elements ?? []).flatMap(e => (e.t === 'text' && e.role === 'title' ? [e.size] : [])),
  );
  return sizes.length ? Math.min(...sizes) : undefined;
}

/** Cards meant to line up: of boxes that start at one left edge (or top), those whose right edges (or bottoms) are
 * at most 4pt apart take the edge most of them have (the nearer to the start on a tie). A box keeps what it holds
 * inside, and a box inside another one (a card's band) is not compared with them. */
function evenCards(elements: FreeElement[]) {
  const out = elements.map(e => (e.t === 'box' && !e.rot ? { ...e } : e)),
    boxes = out.filter((e): e is Box => e.t === 'box' && !e.rot && e.w >= 24 && e.h >= 24);
  for (const [start, size] of [
    ['x', 'w'],
    ['y', 'h'],
  ] as const)
    for (const box of boxes) {
      const near = boxes.filter(b => Math.abs(b[start] - box[start]) <= 1),
        set = near.filter(b => !near.some(o => o !== b && within(b, o)));
      if (set.length < 2 || !set.includes(box)) continue;
      const ends = set.map(b => b[start] + b[size]),
        end = box[start] + box[size],
        count = (t: number) => ends.filter(v => Math.abs(v - t) <= 0.5).length,
        target = ends.filter(t => Math.abs(t - end) <= 4).sort((a, b) => count(b) - count(a) || a - b)[0];
      if (Math.abs(target - end) <= 0.5) continue;
      const held = out.filter(e => e !== box && within(area(e), box));
      if (held.every(e => within(area(e), { ...box, [size]: target - box[start] }))) box[size] = target - box[start];
    }
  return out;
}

const KIND: Record<FreeElement['t'], string> = {
  text: '文字',
  box: '図形',
  line: '線',
  path: '図形',
  svg: '図',
  icon: 'アイコン',
  chart: 'グラフ',
  table: '表',
  image: '写真',
};

/** What the app measures on an AI-designed page and gives back to the AI to fix: a part closer to a side than
 * the slide's margin (parts running off an edge on purpose aside). Empty space is left to the look: asked to fill a
 * band under the content, the AI stretched a table down to the footer. */
export function pageFindings(slide: SlideSpec): Pick<ReviewHint, 'severity' | 'what' | 'fix'>[] {
  const elements = slide.design?.elements ?? [],
    title = elements.find(e => e.t === 'text' && e.role === 'title');
  if (slide.layoutId === 'cover' || !title || title.t !== 'text') return [];
  const side = Math.min(40, title.x - 8);
  const near = elements
    .filter(e => e !== title)
    .map(e => [e, area(e)] as const)
    .find(
      ([e, a]) =>
        (e.t === 'text' || (a.w >= 24 && a.h >= 24)) &&
        a.x > 1 &&
        a.y > 1 &&
        a.x + a.w < SLIDE_W - 1 &&
        a.y + a.h < SLIDE_H - 1 &&
        (a.x < side || SLIDE_W - a.x - a.w < side),
    );
  if (!near) return [];
  const [e, a] = near,
    left = a.x < side;
  return [
    {
      severity: 'medium',
      what: `${left ? '左' : '右'}端の${KIND[e.t]}が端から${Math.round(left ? a.x : SLIDE_W - a.x - a.w)}ptまで寄っています`,
      fix: `題名と同じく端から${Math.round(title.x)}pt以上内側に収める`,
    },
  ];
}
