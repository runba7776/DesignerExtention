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
 * one only), its cards evened and, after the cover (no titleSize), its content balanced top to bottom. The
 * composition itself is not changed. */
export function tidyDesign(design: FreeDesign, titleSize?: number): FreeDesign {
  const elements = design.elements.map(e =>
    e.t === 'text' && e.role === 'title' && titleSize && e.size > titleSize ? { ...e, size: titleSize } : e,
  );
  const even = evenCards(elements);
  return { ...design, elements: titleSize ? balanced(even) : even };
}

const FOOTER_Y = 496;
/** The room under the content that shows as a page ending early (and how much more than over it). */
const UNBALANCED = 40;
/** Content that stops far above the footer moves down as one, halfway to even room over and under it: the page
 * no longer looks cut short, and nothing stretches or changes place within it (asked to fill the room, the AI
 * stretched a table down to the footer). Stays where it is: the title and a rule right under it, what is as tall
 * as the page, and what stands on the footer. A part beside the title and running down into the content is lined
 * up with the content, so such a page is left alone. */
function balanced(elements: FreeElement[]) {
  const title = elements.find(e => e.t === 'text' && e.role === 'title');
  if (!title || title.t !== 'text') return elements;
  let top = title.y + title.h,
    floor = FOOTER_Y;
  const moved = new Set<FreeElement>();
  for (const e of elements) {
    const a = area(e);
    if (e === title || a.h >= 405 || a.y + a.h <= top + 1) continue;
    if (a.y < top - 1) return elements;
    if (a.y + a.h >= 500) floor = Math.min(floor, a.y);
    else if (a.h <= 4 && a.w >= 30 && a.y - top <= 12) top = a.y + a.h;
    else moved.add(e);
  }
  if (!moved.size) return elements;
  const spans = [...moved].map(area),
    above = Math.min(...spans.map(a => a.y)) - top,
    below = floor - Math.max(...spans.map(a => a.y + a.h));
  if (below - above < UNBALANCED) return elements;
  const down = Math.round((below - above) / 2);
  return elements.map(e => (moved.has(e) ? movedDown(e, down) : e));
}

function movedDown(e: FreeElement, down: number): FreeElement {
  if (e.t === 'line') return { ...e, y1: e.y1 + down, y2: e.y2 + down };
  if (e.t !== 'path') return { ...e, y: e.y + down };
  // The outline holds slide points: x y pairs after each of M, L and C.
  let number = 0;
  const d = e.d
    .split(' ')
    .map(t => (/^[MLCZ]$/.test(t) ? t : ++number % 2 ? t : String(Math.round((Number(t) + down) * 100) / 100)))
    .join(' ');
  return { ...e, y: e.y + down, d };
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
