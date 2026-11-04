import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FreeElement, Outline } from '../shared/contracts.js';
import { paletteTheme } from '../shared/ai-theme.js';
import { coverCrop } from '../shared/free-design.js';
import { iconElements, iconSvg } from '../shared/icons.js';
import { tidyDesign } from '../shared/tidy.js';
import { SessionEngine } from '../server/engine.js';
import { findBrowser, layoutHtmlSlides, slidePage, type HtmlLayout } from '../server/html-layout.js';
import { emptyUsage, type CompletionRequest } from '../server/providers.js';
import { SettingsStore } from '../server/settings.js';
import { validateDesign, validateReview } from '../server/validation.js';

const theme = paletteTheme({
  name: '試験',
  background: '#FFFFFF',
  text: '#1F2937',
  muted: '#6B7280',
  accent: '#225588',
  accent2: '#AA5522',
});
const heading = '<h1 style="position:absolute;left:56px;top:20px;margin:0;font-size:28px">題名</h1>';
const place = (left: number, top: number, size = 18, width = 300) =>
  `position:absolute;left:${left}px;top:${top}px;width:${width}px;margin:0;font-size:${size}px;line-height:1.3`;
const box = (left: number, top: number, width: number, height: number, look = 'background:#DDE3EA') =>
  `<div style="position:absolute;left:${left}px;top:${top}px;width:${width}px;height:${height}px;${look}"></div>`;
const read = async (body: string, options = {}) => {
  const [r] = await layoutHtmlSlides(
    [{ id: 'slide-2', html: `<section class="slide">${heading}${body}</section>` }],
    theme,
    options,
  );
  if ('error' in r) assert.fail(r.error);
  return r;
};
const says = async (body: string, words: RegExp) => (await read(body)).problems.filter(p => words.test(p));
const browser = { skip: !findBrowser() };
/** The parts of a page below its heading, in drawing order. */
const below = (page: { elements: unknown }) =>
  (page.elements as (FreeElement & { y: number })[]).filter(e => e.y > 100);

test('text on a chart is found, and text beside it is not', browser, async () => {
  const chart = `<div data-chart='{"type":"bar","categories":["A","B"],"series":[{"name":"売上","values":[1,2]}]}' style="position:absolute;left:100px;top:120px;width:400px;height:300px"></div>`;
  const found = await says(chart + `<p style="${place(150, 200)}">売上は伸びている</p>`, /グラフに重なって/);
  assert.equal(found.length, 1);
  assert.match(found[0], /「売上は伸びている」/);
  assert.deepEqual(await says(chart + `<p style="${place(540, 200)}">売上は伸びている</p>`, /グラフに重なって/), []);
});

test(
  'a line through text is found; a rule under it, or a connector hidden behind a label, is not',
  browser,
  async () => {
    const words = /線が文字を横切って/,
      text = `<p style="${place(100, 200, 18, 400)}">線の近くの文字です</p>`;
    assert.equal((await says(text + box(100, 211, 400, 1, 'background:#888888'), words)).length, 1);
    assert.deepEqual(await says(text + box(100, 226, 400, 1, 'background:#888888'), words), [], 'under the text');
    const line = `<svg style="position:absolute;left:100px;top:200px;width:400px;height:24px" viewBox="0 0 400 24"><line x1="0" y1="12" x2="400" y2="12" stroke="#888888" stroke-width="2"/></svg>`;
    assert.equal((await says(text + line, words)).length, 1, 'a line of an SVG');
    const plate = box(90, 196, 240, 32, 'background:#FFFFFF');
    assert.deepEqual(await says(line + plate + text, words), [], 'a plate between the line and the text');
  },
);

test(
  'text running out of a card is found; text on its own plate, in an outline, or a wrapped word on its colour is not',
  browser,
  async () => {
    const words = /端をまたいで/,
      text = `<p style="${place(100, 200, 18, 400)}">カードからはみ出す長い文章です</p>`;
    assert.equal((await says(box(90, 190, 120, 60) + text, words)).length, 1);
    assert.deepEqual(await says(box(90, 190, 500, 60) + text, words), [], 'inside');
    assert.deepEqual(
      await says(box(90, 190, 120, 60) + box(95, 195, 410, 40, 'background:#FFFFFF') + text, words),
      [],
      'its plate holds it all',
    );
    assert.deepEqual(
      await says(box(90, 190, 120, 60, 'border:1px solid #888888') + text, words),
      [],
      'an outline is not a card',
    );
    const marked = `<p style="${place(100, 200, 24, 200)}"><span style="background:#FFEE88">色を付けた言葉が折り返して二行になる</span></p>`;
    assert.deepEqual(await says(marked, words), [], 'one box per line of a marked word');
  },
);

test('text touching the edge of a card or an icon is found; text clear of them is not', browser, async () => {
  const text = (top: number) => `<p style="${place(100, top, 20, 400)}">カードの端の文字</p>`,
    edge = /カードや帯の端にかかって/,
    icon = /アイコンに重なって/;
  // Every middle lies above the card's lower edge at y=214, so no character counts as outside it.
  assert.equal((await says(box(90, 150, 400, 64) + text(200), edge)).length, 1);
  assert.deepEqual(await says(box(90, 150, 400, 120) + text(200), edge), [], 'well inside');
  assert.deepEqual(await says(box(90, 150, 400, 40) + text(200), edge), [], 'below it');
  const mark = (left: number) =>
    `<i data-icon="sun" style="position:absolute;left:${left}px;top:195px;width:40px;height:40px;color:#225588"></i>`;
  assert.equal((await says(mark(120) + text(200), icon)).length, 1);
  assert.deepEqual(await says(mark(40) + text(200), icon), [], 'beside it');
});

test('text across a circle is found, and text inside it is not', browser, async () => {
  const circle = box(90, 150, 120, 120, 'background:#DDE3EA;border-radius:50%'),
    words = /端をまたいで/;
  assert.equal((await says(circle + `<p style="${place(120, 200)}">円からはみ出す長い文章です</p>`, words)).length, 1);
  assert.deepEqual(await says(circle + `<p style="${place(130, 200)}">短い</p>`, words), []);
});

test('the elements follow the stacking order of the page, and a page with z-index is checked', browser, async () => {
  const label = `<p style="${place(100, 170, 20).replace('position:absolute', 'position:absolute;z-index:2')}">前の文字</p>`,
    stacked = await read(label + box(80, 150, 300, 80));
  assert.deepEqual(stacked.problems, []);
  assert.deepEqual(
    below(stacked).map(e => e.t),
    ['box', 'text'],
    'PowerPoint draws in this order',
  );
  const under = `<p style="${place(100, 170, 20)}">隠れる文字</p>`,
    raised = box(80, 150, 300, 80).replace('position:absolute', 'position:absolute;z-index:1');
  assert.equal((await read(under + raised)).unreadable, true);
});

test(
  'a card whose text follows a group inside it is one group, so its shape stays under that group',
  browser,
  async () => {
    const badge = `<div style="width:60px;height:60px;background:#225588"><p style="margin:0;font-size:18px;color:#FFFFFF">1</p></div>`,
      card = (inner: string) =>
        `<div style="position:absolute;left:100px;top:150px;width:400px;height:200px;background:#DDE3EA">${inner}</div>`;
    const after = below(await read(card(`${badge}<p style="margin:0;font-size:18px">続く文字</p>`))).map(e => e.g);
    assert.equal(new Set(after).size, 1, 'one group');
    assert.notEqual(after[0], undefined);
    const before = below(await read(card(`<p style="margin:0;font-size:18px">先の文字</p>${badge}`))).map(e => e.g);
    assert.equal(new Set(before).size, 2, 'the inner group stays its own: nothing is lifted over it');
  },
);

test(
  'text a third hidden by a shape drawn after it is found, though the middle of each character shows',
  browser,
  async () => {
    const text = `<p style="${place(100, 200, 20, 400)}">隠れかける文字です</p>`,
      middle = 200 + 13;
    // Made smaller, this text comes out from under the shape: the page was found to need it.
    const hidden = await read(text + box(90, middle + 2, 400, 40));
    assert.deepEqual([hidden.problems, !!hidden.fitted], [[], true]);
    const touched = await read(text + box(90, middle + 8, 400, 40));
    assert.deepEqual([touched.problems, touched.fitted], [[], undefined], 'a touch of the edge');
  },
);

test('text that cannot be read is told apart from text only in the footer band', browser, async () => {
  const over = `<p style="${place(100, 200)}">読めない文字</p>${box(90, 190, 300, 60)}`;
  // The spacing cannot move a shape placed by position: it stays over the text.
  assert.equal((await read(over)).unreadable, true);
  const footer = await read(`<p style="${place(100, 505)}">出典欄の文字</p>`);
  assert.ok(footer.problems.length);
  assert.equal(footer.unreadable, undefined);
  assert.equal((await read(`<p style="${place(100, 600)}">外の文字</p>`)).unreadable, true, 'off the slide');
});

test('a local model: text a little small does not stop a page from being fitted by its spacing', browser, async () => {
  // A rule at a fixed distance from the bottom, on text in a flow pushed down by its gap.
  const body = `<div style="position:absolute;left:100px;top:100px;width:400px;height:300px;display:flex;flex-direction:column"><div style="height:150px;margin-bottom:60px"></div><p style="margin:0;font-size:18px;line-height:1.3">積まれた文字</p></div>${box(100, 321, 400, 1, 'background:#888888')}<p style="${place(100, 340, 14, 400)}">少し小さい文字</p>`;
  const options = { minTextSize: { body: 16, caption: 12 } };
  const asked = await read(body, options);
  assert.ok(asked.problems.some(p => /線が文字を横切って/.test(p)));
  const kept = await read(body, { ...options, keepSmall: true });
  assert.deepEqual(kept.problems, []);
  assert.ok(kept.squeezed);
});

test('the browser measures characters as PowerPoint sets them: no trimmed brackets, no kerning', () => {
  const page = slidePage('<section class="slide"></section>', theme);
  assert.match(page, /text-spacing-trim:space-all!important/);
  assert.match(page, /font-kerning:none!important/);
});

test('a text on a chart placed by position is refused; one measured by the browser was checked there', () => {
  const text = (extra = {}) => ({ t: 'text', x: 150, y: 200, w: 200, h: 30, text: '売上', size: 18, ...extra });
  const chart = {
    t: 'chart',
    x: 100,
    y: 120,
    w: 400,
    h: 300,
    chart: { type: 'bar', categories: ['A', 'B'], series: [{ name: '売上', values: [1, 2] }] },
  };
  const title = { t: 'text', x: 56, y: 20, w: 600, h: 44, text: '題名', size: 28, role: 'title' };
  assert.throws(() => validateDesign({ elements: [title, chart, text()] }, 0), /グラフに重なって/);
  assert.doesNotThrow(() => validateDesign({ elements: [title, chart, text({ exact: true })] }, 0));
  assert.doesNotThrow(() => validateDesign({ elements: [title, chart, text({ x: 520 })] }, 0));
  // A box is wider than its text: one only partly over the chart does not say the text is on it.
  assert.doesNotThrow(() => validateDesign({ elements: [title, chart, text({ x: 0, w: 180 })] }, 0));
});

test('a local model: a page with unreadable text is not kept as written; it is made from a layout', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'de-unreadable-'));
  try {
    const settings = await new SettingsStore(dir, '').load();
    await settings.update({ provider: 'local', model: 'mock', slideCount: 2, mode: 'presentation' });
    const usage = { ...emptyUsage(), calls: 1 };
    const outline = {
      title: '2枚',
      mode: 'presentation',
      assumptions: [],
      slides: [
        { id: 'slide-1', title: '表紙', intent: '表紙', layoutId: 'cover', keyPoints: [] },
        { id: 'slide-2', title: '重なる', intent: '説明', layoutId: 'free', keyPoints: [] },
      ],
    } as Outline;
    const htmlLayout: HtmlLayout = async pages =>
      pages.map(p => ({
        elements: [
          { t: 'text', x: 56, y: 30, w: 600, h: 44, text: '題名', size: 30, exact: true, role: 'title' },
        ] as Record<string, unknown>[],
        ...(p.id === 'slide-2'
          ? { problems: ['文字がグラフに重なっています（「本文」）。'], unreadable: true }
          : { problems: [] }),
      }));
    const engine = new SessionEngine({
      settings,
      dataDir: dir,
      htmlLayout,
      render: async () => ({ artifactId: 'x', pptxUrl: 'x', thumbnails: [], warnings: [], native: false }),
      providerFactory: () => ({
        complete: async (r: CompletionRequest) => {
          const req = JSON.parse(r.content).request;
          if (!req.targetSlides) return { text: JSON.stringify({ kind: 'outline', outline }), usage };
          const slides = req.targetSlides.map((s: any) =>
            s.layoutId === 'summary'
              ? { id: s.id, title: s.title, layoutId: 'summary', items: [{ label: '項目' }], notes: '', sources: [] }
              : {
                  id: s.id,
                  title: s.title,
                  layoutId: s.layoutId,
                  notes: '',
                  sources: [],
                  html: '<section class="slide"></section>',
                },
          );
          return { text: JSON.stringify({ mode: 'presentation', slides }), usage };
        },
      }),
    });
    const session = await engine.create({ prompt: '2枚' }, []);
    await engine.generate(session.id);
    const page = session.variants[0].deck.slides[1];
    assert.equal(page.design, undefined);
    assert.deepEqual(
      page.items.map(i => i.label),
      ['項目'],
    );
    assert.match(session.reviewHints![0].what, /型に当てはめて作りました/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the lines of an icon that meet are one freeform with no notches; a line meeting nothing stays a line', () => {
  const rect = { x: 40, y: 50, w: 48, h: 48 };
  const [star, ...rest] = iconElements('star', rect, '#123456');
  assert.deepEqual(rest, [], 'one figure');
  assert.equal(star.kind, 'shape');
  assert.ok(star.kind === 'shape' && star.path);
  if (star.kind !== 'shape' || !star.path) return;
  assert.match(star.path, /^M \S+ \S+( L \S+ \S+){9} Z$/);
  assert.equal(star.fill, 'none');
  assert.equal(star.stroke, '#123456');
  const points = star.path.match(/[\d.]+ [\d.]+/g)!.map(p => p.split(' ').map(Number));
  assert.ok(
    points.every(
      ([x, y]) =>
        x >= star.x - 0.01 && x <= star.x + star.w + 0.01 && y >= star.y - 0.01 && y <= star.y + star.h + 0.01,
    ),
    'its box holds its outline (the no-install build draws from the box)',
  );
  const document = iconElements('document', rect, '#123456');
  assert.deepEqual(
    document.map(e => e.kind),
    ['shape', 'line', 'line', 'line'],
  );
  assert.match(iconSvg('star'), /<path d="M [^"]+ Z" fill="none"\/>/);
  assert.doesNotMatch(iconSvg('star'), /<line/);
});

const title = { t: 'text', x: 56, y: 30, w: 600, h: 40, text: '題名', size: 28, role: 'title' } as const;
const body = (y: number, h: number) => ({ t: 'box', x: 56, y, w: 400, h, shape: 'rect', fill: 'surface' }) as const;
const tops = (elements: FreeElement[]) => elements.map(e => ('y' in e ? e.y : e.t === 'line' ? e.y1 : -1));

test('content that stops far above the footer moves down as one, halfway to even room; the page itself stays', () => {
  const page = [title, body(100, 100), body(220, 60)];
  // Room over the content 30, under it 216: down by 93.
  assert.deepEqual(tops(tidyDesign({ elements: page }, 28).elements), [30, 193, 313]);
  assert.deepEqual(page[1], body(100, 100), 'the design given is not changed');
  assert.deepEqual(tops(tidyDesign({ elements: page }).elements), [30, 100, 220], 'the cover');
  const even = [title, body(100, 350)];
  assert.deepEqual(tops(tidyDesign({ elements: even }, 28).elements), [30, 100], 'room within reason');
});

test('all kinds of parts move; what is fixed to the title, the page or the footer stays', () => {
  const parts: FreeElement[] = [
    title,
    { t: 'box', x: 56, y: 74, w: 400, h: 2, shape: 'rect', fill: 'accent' },
    { t: 'box', x: 700, y: 0, w: 260, h: 540, shape: 'rect', fill: 'surface' },
    { t: 'box', x: 0, y: 510, w: 960, h: 30, shape: 'rect', fill: 'accent' },
    { t: 'line', x1: 56, y1: 100, x2: 300, y2: 110 },
    { t: 'icon', icon: 'star', x: 56, y: 120, size: 40 },
    { t: 'path', x: 100, y: 120, w: 20, h: 20, d: 'M 100 120 L 120 120 C 110 125 115 130 120 140 Z' },
    { t: 'text', x: 56, y: 170, w: 200, h: 30, text: '本文', size: 18 },
  ];
  const elements = tidyDesign({ elements: parts }, 28).elements,
    // Room over the content 24 (from the rule), under it 296: down by 136.
    down = 136;
  assert.deepEqual(tops(elements.slice(0, 4)), [30, 74, 0, 510]);
  const [line, icon, shape, text] = elements.slice(4);
  assert.ok(line.t === 'line' && line.y1 === 100 + down && line.y2 === 110 + down);
  assert.ok(icon.t === 'icon' && icon.y === 120 + down);
  assert.ok(shape.t === 'path' && shape.y === 120 + down);
  assert.ok(shape.t === 'path' && shape.d === 'M 100 256 L 120 256 C 110 261 115 266 120 276 Z');
  assert.ok(text.t === 'text' && text.y === 170 + down);
});

test('a part beside the title that runs down into the content keeps the page as it is', () => {
  const page = [
    title,
    { t: 'box', x: 700, y: 20, w: 200, h: 300, shape: 'rect', fill: 'surface' } as const,
    body(100, 60),
  ];
  assert.deepEqual(tops(tidyDesign({ elements: page }, 28).elements), [30, 20, 100]);
});

test('a photo is cut at the middle, or keeps the side asked for on the side it is cut', () => {
  assert.deepEqual(coverCrop(800, 400, 300, 300), [0.25, 0, 0.25, 0]);
  assert.deepEqual(coverCrop(800, 400, 300, 300, 'left'), [0, 0, 0.5, 0]);
  assert.deepEqual(coverCrop(800, 400, 300, 300, 'right'), [0.5, 0, 0, 0]);
  assert.deepEqual(coverCrop(800, 400, 300, 300, 'top'), [0.25, 0, 0.25, 0], 'not cut at the top');
  assert.deepEqual(coverCrop(400, 800, 300, 300, 'top'), [0, 0, 0, 0.5]);
  assert.deepEqual(coverCrop(400, 800, 300, 300, 'bottom'), [0, 0.5, 0, 0]);
  assert.deepEqual(
    validateReview(
      {
        pages: [
          {
            id: 'slide-2',
            problems: [
              { severity: 'medium', what: '切れる', fix: '', crop: 'left' },
              { severity: 'low', what: '別', fix: '', crop: 'middle' },
            ],
          },
        ],
      },
      ['slide-2'],
    )[0].problems.map(p => p.crop),
    ['left', undefined],
  );
});
