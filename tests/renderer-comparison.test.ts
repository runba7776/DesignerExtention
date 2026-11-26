import test from 'node:test';
import assert from 'node:assert/strict';
import { deckToPptx } from '../web/hosted/pptx-renderer';
import { comparisonDecks } from '../scripts/renderer-comparison/decks';
import { readPptx, type SlideStructure } from '../scripts/renderer-comparison/structure';
import { compareDecks, compareSlide } from '../scripts/renderer-comparison/compare';
import { decodePng, diffPictures, encodePng, halve, halveDiff } from '../scripts/renderer-comparison/png';
import { buildReport } from '../scripts/renderer-comparison/report';

const pptx = async (deck: Parameters<typeof deckToPptx>[0]) =>
  readPptx(await (await deckToPptx(deck)).blob.arrayBuffer());

test('the comparison decks cover every layout, chart and free-page object, and the TS renderer draws them all', async () => {
  const decks = comparisonDecks();
  for (const item of decks) {
    assert.ok(item.deck.slides.length <= 30, 'the native renderer takes up to 30 slides');
    assert.equal(item.labels.length, item.deck.slides.length);
    const slides = await pptx(item.deck);
    assert.equal(slides.length, item.deck.slides.length);
    // Every page has its title on it, and the notes come through.
    slides.forEach((slide, i) => {
      const title = item.deck.slides[i].title.replace(/\s+/g, '');
      assert.ok(
        slide.objects.some(o => o.text.replace(/\s+/g, '').includes(title.slice(0, 6))),
        `${item.id} p.${i + 1}`,
      );
    });
  }
  const free = await pptx(decks.find(d => d.id === 'free')!.deck);
  const kinds = new Set(free.flatMap(s => s.objects.map(o => o.kind)));
  for (const kind of ['shape', 'text', 'picture', 'chart', 'table'] as const) assert.ok(kinds.has(kind), kind);
  assert.ok(
    free[2].objects.some(o => o.geometry === 'custom'),
    'the freeform is read as a custom shape',
  );
  assert.equal(comparisonDecks(true).length, 3);
});

test('a deck compared with itself has no differences; a moved, rewritten or missing object is named', async () => {
  const deck = comparisonDecks(true)[0].deck;
  const slides = await pptx({ ...deck, slides: deck.slides.slice(0, 3) });
  assert.deepEqual(
    compareDecks(slides, slides).flatMap(c => c.differences),
    [],
  );
  const base = slides[1];
  const target = base.objects.findIndex(o => o.kind === 'text' && o.text.length > 1);
  const changed: SlideStructure = {
    ...base,
    objects: base.objects.map((o, i) =>
      i === target ? { ...o, x: o.x + 10, text: `${o.text}（改）`, fontSizes: [o.fontSizes[0] + 2] } : o,
    ),
  };
  const kinds = compareSlide(base, changed).differences.map(d => d.kind);
  assert.deepEqual([...new Set(kinds)].sort(), ['font', 'place', 'text']);
  const dropped = compareSlide(base, { ...base, objects: base.objects.filter((_, i) => i !== target) });
  assert.deepEqual(
    dropped.differences.map(d => d.kind),
    ['missing'],
  );
  // A small rounding shift is not a difference.
  const rounded = compareSlide(base, { ...base, objects: base.objects.map(o => ({ ...o, x: o.x + 1 })) });
  assert.deepEqual(rounded.differences, []);
  assert.throws(() => compareDecks(slides, slides.slice(1)), /スライド数/);
});

test('PNG pictures round-trip, differ by the share of changed pixels, and halve for the report', () => {
  const width = 4,
    height = 2,
    data = new Uint8Array(width * height * 4).fill(255);
  const white = { width, height, data };
  const decoded = decodePng(encodePng(white));
  assert.deepEqual([decoded.width, decoded.height], [4, 2]);
  assert.deepEqual(decoded.data, data);
  const marked = new Uint8Array(data);
  marked.set([0, 0, 0, 255], 0);
  marked.set([0, 0, 0, 255], 4);
  const diff = diffPictures(white, { width, height, data: marked });
  assert.equal(diff.share, 2 / 8);
  // Ink only the second picture has is blue; ink only the first has is red.
  assert.deepEqual([...diff.picture.data.subarray(0, 4)], [30, 100, 230, 255]);
  const reverse = diffPictures({ width, height, data: marked }, white);
  assert.deepEqual([...reverse.picture.data.subarray(0, 4)], [220, 30, 40, 255]);
  // Halving keeps a marked pixel's colour instead of averaging it away.
  const sharp = halveDiff(reverse.picture);
  assert.deepEqual([...sharp.data.subarray(0, 4)], [220, 30, 40, 255]);
  const half = halve({ width, height, data: marked });
  assert.deepEqual([half.width, half.height], [2, 1]);
  assert.equal(half.data[0], 128);
  assert.throws(() => diffPictures(white, half), /大きさ/);
});

test('the report lists the worst slides first and escapes what the slides say', async () => {
  const deck = comparisonDecks(true)[0].deck;
  const slides = await pptx({ ...deck, slides: deck.slides.slice(0, 2) });
  const comparisons = compareDecks(slides, slides);
  const html = buildReport({
    createdAt: '2026/11/26',
    slides: comparisons.map((comparison, i) => ({
      deck: '<比較>',
      label: i ? '二枚目' : '表紙',
      comparison,
      pixelShare: i ? 0.2 : 0,
      images: { native: 'a.png', hosted: 'b.png', diff: 'c.png' },
    })),
  });
  assert.match(html, /^<!DOCTYPE html>/);
  assert.match(html, /&lt;比較&gt;/);
  assert.doesNotMatch(html, /<比較>/);
  assert.ok(html.indexOf('二枚目') < html.indexOf('表紙</td>'));
  assert.match(html, /20\.0%/);
});

test('a slide PowerPoint exports with a palette (few colours) is read too, with its transparency', () => {
  // 5x3, 2 bits a pixel from a palette of four colours; the second also marks the first colour transparent.
  const plain = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAUAAAADAgMAAAAmWC1rAAAADFBMVEX6+voKyB4AgP//AAAtpqFaAAAAEUlEQVR4nGN8codl/VuW3Z8AFuEFE2yggxwAAAAASUVORK5CYII=',
    'base64',
  );
  const clear = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAUAAAADAgMAAAAmWC1rAAAADFBMVEX6+voKyB4AgP//AAAtpqFaAAAAAXRSTlMAQObYZgAAABFJREFUeJxjfHKHZf1blt2fABbhBRNsoIMcAAAAAElFTkSuQmCC',
    'base64',
  );
  const colours = [
    [255, 0, 0],
    [0, 128, 255],
    [10, 200, 30],
    [250, 250, 250],
  ];
  const picture = decodePng(plain);
  assert.deepEqual([picture.width, picture.height], [5, 3]);
  for (let y = 0; y < 3; y++)
    for (let x = 0; x < 5; x++)
      assert.deepEqual(
        [...picture.data.subarray((y * 5 + x) * 4, (y * 5 + x) * 4 + 4)],
        [...colours[(x + y) % 4], 255],
      );
  const withAlpha = decodePng(clear);
  assert.equal(withAlpha.data[3 * 4 + 3], 0, 'the transparent colour');
  assert.equal(withAlpha.data[3], 255);
});
