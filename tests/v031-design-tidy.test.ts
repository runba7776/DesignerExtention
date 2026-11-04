import test from 'node:test';
import assert from 'node:assert/strict';
import type { DeckSpec, FreeElement, SlideSpec, TextElement } from '../shared/contracts.js';
import { compileDeck } from '../shared/layouts.js';
import { deckTitleSize, pageFindings, tidyDesign } from '../shared/tidy.js';

const title = (size: number) =>
  ({ t: 'text', x: 48, y: 32, w: 600, h: 44, text: '題名', size, role: 'title' }) as const;
const card = (x: number, y: number, w: number, h: number) =>
  ({ t: 'box', x, y, w, h, shape: 'roundRect', fill: 'surface' }) as const;
const page = (id: string, elements: FreeElement[]): SlideSpec => ({
  id,
  title: id,
  layoutId: id === 'slide-1' ? 'cover' : 'free',
  items: [],
  notes: '',
  sources: [],
  design: { elements },
});

test('the pages after the cover take the smallest title size of the deck; the designs themselves stay as they were', () => {
  const deck: DeckSpec = {
    id: 'd',
    title: 'd',
    mode: 'presentation',
    themeId: 'paper',
    slides: [
      page('slide-1', [{ ...title(48), role: 'body' }]),
      page('slide-2', [title(34), card(48, 120, 400, 200)]),
      page('slide-3', [title(28), card(48, 120, 400, 200)]),
      page('slide-4', [title(30), card(48, 120, 400, 200)]),
    ],
  };
  assert.equal(deckTitleSize(deck.slides), 28);
  const titles = compileDeck(deck).slides.map(
    s => (s.elements.find(e => e.kind === 'text' && e.title) as TextElement | undefined)?.fontSize,
  );
  assert.deepEqual(titles.slice(1), [28, 28, 28]);
  assert.ok(
    compileDeck(deck).slides[0].elements.some(e => e.kind === 'text' && e.fontSize === 48),
    'the cover keeps its own',
  );
  assert.equal((deck.slides[1].design!.elements[0] as { size: number }).size, 34);
  assert.equal(deckTitleSize([page('slide-1', [])]), undefined);
});

test('cards meant to line up are evened when their edges are a few points apart, keeping what they hold inside', () => {
  const held = { t: 'text', x: 608, y: 192, w: 193, h: 25, text: '目標', size: 16 } as const,
    band = { ...card(49, 251, 866, 20), fill: 'accent' } as const;
  const column = tidyDesign({
    elements: [
      title(30),
      card(48, 120, 864, 36),
      card(48, 168, 868, 76),
      held,
      card(48, 250, 868, 76),
      band,
      card(48, 332, 864, 72),
      card(48, 420, 864, 52),
    ],
  }).elements;
  assert.deepEqual(
    column.filter(e => e.t === 'box').map(e => (e as { w: number }).w),
    [864, 864, 868, 866, 864, 864],
    'the 868 card holding a band as wide as itself keeps its width; the band is not compared with the cards',
  );
  assert.deepEqual(column[3], held);
  const row = tidyDesign({
    elements: [card(100, 300, 200, 150), card(320, 300, 200, 153), card(540, 300, 200, 150), card(760, 300, 150, 180)],
  }).elements;
  assert.deepEqual(
    row.map(e => (e as { h: number }).h),
    [150, 150, 150, 180],
    'side by side from one top: the bottom 3pt off is evened, one 30pt lower is a different card',
  );
});

test('the app measures a part close to a side, to be fixed by the AI; empty space is left to the look', () => {
  const findings = pageFindings(
    page('slide-2', [
      title(30),
      card(48, 120, 200, 120),
      card(702, 140, 226, 84),
      { t: 'image', x: 0, y: 0, w: 300, h: 540, q: 'harbor' },
      card(20, 100, 6, 300),
    ]),
  );
  assert.deepEqual(findings, [
    {
      severity: 'medium',
      what: '右端の図形が端から32ptまで寄っています',
      fix: '題名と同じく端から48pt以上内側に収める',
    },
  ]);
  assert.deepEqual(
    pageFindings(page('slide-2', [title(30), card(48, 120, 864, 120)])),
    [],
    'inside the margins, with the lower half empty',
  );
  assert.deepEqual(pageFindings(page('slide-1', [title(30), card(900, 100, 50, 50)])), [], 'the cover is free');
});
