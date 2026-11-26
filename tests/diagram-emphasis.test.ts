import test from 'node:test';
import assert from 'node:assert/strict';
import { compileDeck, diagramWeights } from '../core/shared/layouts';
import { sampleDeck, sampleSlide } from '../core/shared/layout-samples';
import { themes } from '../core/shared/themes';
import type { SmartArtElement } from '../core/shared/contracts';

const items = (n: number) => Array.from({ length: n }, (_, i) => ({ label: `項目${i + 1}` }));

test('a process builds up to its last step, which carries the full accent', () => {
  const weights = diagramWeights('process', items(4));
  assert.deepEqual(
    weights.map(w => Math.round(w * 100)),
    [45, 63, 82, 100],
  );
});

test('a hierarchy leads with its root and steps back by depth', () => {
  const tree = [
    { label: '本社' },
    { label: '営業', parent: 0 },
    { label: '開発', parent: 0 },
    { label: '東日本', parent: 1 },
  ];
  assert.deepEqual(diagramWeights('hierarchy', tree), [1, 0.62, 0.62, 0.4]);
});

test('cycles and lists keep every box equal', () => {
  assert.deepEqual(diagramWeights('cycle', items(3)), [1, 1, 1]);
  assert.deepEqual(diagramWeights('list', items(3)), [1, 1, 1]);
});

test('diagram scenes carry a fill and a readable text colour for every item', () => {
  const deck = sampleDeck([sampleSlide('cover'), sampleSlide('hierarchy')], 'business');
  const art = compileDeck(deck)
    .slides.flatMap(s => s.elements)
    .find((e): e is SmartArtElement => e.kind === 'smartart');
  assert.ok(art, 'the hierarchy page draws a diagram');
  assert.equal(art.fills?.length, art.items.length);
  assert.equal(art.inks?.length, art.items.length);
  assert.equal(art.fills?.[0], themes.business.accent, 'the root keeps the full accent');
  assert.ok(
    art.fills?.slice(1).every(f => f !== themes.business.accent),
    'the other boxes step back',
  );
});
