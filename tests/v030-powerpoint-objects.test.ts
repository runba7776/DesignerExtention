import test from 'node:test';
import assert from 'node:assert/strict';
import type {
  ChartElement,
  DeckSpec,
  FreeCell,
  FreeElement,
  ImageElement,
  ShapeElement,
  TableElement,
  TextElement,
} from '../shared/contracts.js';
import { compileDeck } from '../shared/layouts.js';
import { fillBlanks } from '../shared/blanks.js';
import { paletteTheme } from '../shared/ai-theme.js';
import { findBrowser, layoutHtmlSlides } from '../server/html-layout.js';
import { validateDesign } from '../server/validation.js';

const title = { t: 'text', x: 56, y: 30, w: 600, h: 44, text: '題名', size: 30, role: 'title' } as const;
const deck = (elements: FreeElement[]): DeckSpec => ({
  id: 'd',
  title: 'd',
  mode: 'presentation',
  themeId: 'paper',
  slides: [
    { id: 'slide-1', title: '表紙', layoutId: 'cover', items: [], notes: '', sources: [] },
    { id: 'slide-2', title: '題名', layoutId: 'free', items: [], notes: '', sources: [], design: { elements } },
  ],
});

test('a photo carries what it shows and a chart its values in words, as PowerPoint alternative text', () => {
  const photo = { t: 'image', x: 0, y: 100, w: 400, h: 300, q: 'harbor morning', src: '0123456789abcdef.jpg' } as const;
  const chart: Extract<FreeElement, { t: 'chart' }> = {
    t: 'chart',
    x: 500,
    y: 100,
    w: 400,
    h: 300,
    chart: {
      type: 'column',
      categories: ['新規', '解約'],
      series: [{ name: '社数', values: [35, 8] }],
      unit: '社',
    },
  };
  const scene = compileDeck(deck([{ ...photo, alt: '朝の港' }, chart, title])).slides[1];
  assert.equal(scene.elements.find((e): e is ImageElement => e.kind === 'image')!.alt, '朝の港');
  assert.equal(
    scene.elements.find((e): e is ChartElement => e.kind === 'chart')!.alt,
    '縦棒グラフ（社）：新規 35、解約 8',
  );
  const words = compileDeck(deck([photo, title])).slides[1];
  assert.equal(
    words.elements.find((e): e is ImageElement => e.kind === 'image')!.alt,
    'harbor morning',
    'without a description, the search words',
  );
  const two = compileDeck(
    deck([
      {
        ...chart,
        chart: {
          type: 'line',
          categories: ['4月', '5月'],
          series: [
            { name: '東', values: [1.5, 2] },
            { name: '西', values: [3, 1200] },
          ],
        },
      },
      title,
    ]),
  ).slides[1];
  assert.equal(
    two.elements.find((e): e is ChartElement => e.kind === 'chart')!.alt,
    '折れ線グラフ：東（4月 1.5、5月 2）、西（4月 3、5月 1,200）',
  );
});

test("a slide's title, page number and full-bleed colour, and the deck's colours, are PowerPoint's own", () => {
  const own = compileDeck({ ...deck([title]), themeId: 'business' });
  const [cover] = own.slides;
  assert.equal(cover.background, own.theme.foreground, 'a full-bleed cover is the slide background');
  assert.ok(!cover.elements.some(e => e.kind === 'shape' && e.w === 960 && e.h === 540));
  assert.deepEqual(
    own.slides.map(s => s.elements.flatMap(e => (e.kind === 'text' && e.title ? [e.text] : []))),
    [['表紙'], ['題名']],
    'one title placeholder each: a layout title and a design title',
  );
  assert.deepEqual(
    own.slides.map(s => s.elements.flatMap(e => (e.kind === 'text' && e.slideNumber ? [e.text] : []))),
    [['1 / 2'], ['2 / 2']],
  );
  const { foreground, background, muted, pale, accent, secondary } = own.theme;
  assert.deepEqual(own.themeColors?.slice(0, 6), [foreground, background, muted, pale, accent, secondary]);
  assert.equal(own.themeColors?.length, 10, 'six accents, as a PowerPoint theme has');
  assert.equal(
    compileDeck({ ...deck([title]), themeId: 'template', customTheme: own.theme }).themeColors,
    undefined,
    'a company template deck takes that deck’s theme when inserted',
  );

  const ground = (color: string) => {
    const spec = deck([title]);
    spec.slides[1].design!.background = color;
    return compileDeck(spec).slides[1].background;
  };
  assert.equal(ground('#102030'), '#102030');
  assert.equal(
    ground(compileDeck(deck([title])).theme.background),
    undefined,
    'the theme’s background is the master’s',
  );
});

const tableOf = (scene: ReturnType<typeof compileDeck>['slides'][number]) =>
  scene.elements.find((e): e is TableElement => e.kind === 'table')!;

test(
  'a table on a page becomes a PowerPoint table with its widths, heights, fills, lines and bold parts; merged cells stay drawn',
  { skip: !findBrowser() },
  async () => {
    const theme = paletteTheme({
      name: 't',
      background: '#FFFFFF',
      text: '#1F2A44',
      muted: '#6B7280',
      accent: '#1F4E8C',
      accent2: '#C37527',
    });
    const head = 'background:#1F4E8C;color:#FFFFFF;padding:8px;text-align:left',
      cell = 'padding:8px;border-bottom:1px solid #9AA3AE';
    const [page, merged] = await layoutHtmlSlides(
      [
        {
          id: 'slide-2',
          html: `<section class="slide"><h1 style="position:absolute;left:56px;top:30px;margin:0;font-size:30px">件数</h1>
<table style="position:absolute;left:56px;top:120px;width:500px;border-collapse:collapse;font-size:16px">
<thead><tr><th style="${head}">項目</th><th style="${head}">件数</th></tr></thead>
<tbody><tr><td style="${cell}">新規</td><td style="${cell};text-align:right"><strong>35</strong>件</td></tr>
<tr><td style="${cell}">解約</td><td style="${cell};text-align:right">8件</td></tr></tbody></table></section>`,
        },
        {
          id: 'slide-3',
          html: `<section class="slide"><h1 style="position:absolute;left:56px;top:30px;margin:0;font-size:30px">結合</h1>
<table style="position:absolute;left:56px;top:120px;width:500px;font-size:16px"><tr><th colspan="2">見出し</th></tr><tr><td>左</td><td>右</td></tr></table></section>`,
        },
      ],
      theme,
    );
    assert.ok(!('error' in page) && !('error' in merged));
    if ('error' in page || 'error' in merged) return;
    const read = page.elements.find(e => e.t === 'table') as Extract<FreeElement, { t: 'table' }>;
    assert.ok(read.cols && read.rowH && read.cells);
    assert.deepEqual(
      [read.headers, read.rows, read.head],
      [
        ['項目', '件数'],
        [
          ['新規', '35件'],
          ['解約', '8件'],
        ],
        true,
      ],
    );
    assert.equal(Math.round(read.cols.reduce((a, b) => a + b)), 500);
    assert.equal(read.rowH.length, 3);
    assert.ok(!merged.elements.some(e => e.t === 'table'), 'merged cells keep the drawn parts');
    assert.ok(['見出し', '左', '右'].every(t => merged.elements.some(e => e.t === 'text' && e.text === t)));

    const design = validateDesign({ elements: page.elements }, 0);
    const table = tableOf(
      compileDeck({
        ...deck(design.elements),
        themeId: 'ai',
        aiTheme: theme,
      }).slides[1],
    );
    assert.deepEqual([table.columns, table.rows, table.header], [read.cols, read.rowH, true]);
    const [[label], [, count]] = [table.cells[0], table.cells[1]];
    assert.deepEqual([label.text, label.fill, label.color, label.bold], ['項目', theme.accent, '#FFFFFF', true]);
    // The look most of the text has is the cell's own; the rest is a run.
    assert.deepEqual(
      [count.text, count.align, count.bold, count.runs],
      ['35件', 'right', true, [{ start: 2, length: 1, bold: false }]],
    );
    assert.deepEqual(count.borders?.[2], { width: 1, color: '#9AA3AE' });
  },
);

test('a filled blank keeps a page table look while it fits its column; a table of the app is one PowerPoint table', () => {
  const look: FreeCell = { size: 16, pad: [8, 8, 8, 8] };
  const table: FreeElement = {
    t: 'table',
    x: 56,
    y: 120,
    w: 300,
    h: 80,
    headers: ['項目', '日'],
    rows: [['集合', '［集合日］']],
    cols: [100, 200],
    rowH: [40, 40],
    cells: [
      [look, look],
      [look, { ...look, runs: [{ s: 0, l: 5, color: 'accent' }] }],
    ],
    head: true,
  };
  const filled = (value: string) =>
    fillBlanks(deck([table, title]), { 集合日: value }).deck.slides[1].design!.elements[0];
  const short = filled('11月9日');
  assert.ok(short.t === 'table' && short.cells);
  assert.deepEqual([short.rows, short.cells[1][1].runs], [[['集合', '11月9日']], undefined]);
  const long = filled('第二公園の北側広場（雨天時は公民館の大ホール）');
  assert.ok(long.t === 'table' && !long.cells && !long.cols, 'too wide for its column: the app lays the table out');

  const app = tableOf(compileDeck(deck([{ ...long, h: 160 }, title])).slides[1]);
  assert.equal(app.cells.length, 2);
  assert.equal(app.cells[1][1].text.replace(/\n/g, ''), '第二公園の北側広場（雨天時は公民館の大ホール）');
  assert.equal(app.header, true);
});

test(
  'the parts of a card stay together as a PowerPoint group with its icon inside; a box with one text holds that text',
  { skip: !findBrowser() },
  async () => {
    const theme = paletteTheme({
      name: 't',
      background: '#FFFFFF',
      text: '#1F2A44',
      muted: '#6B7280',
      accent: '#1F4E8C',
      accent2: '#C37527',
    });
    const [page] = await layoutHtmlSlides(
      [
        {
          id: 'slide-2',
          html: `<section class="slide"><div style="position:absolute;left:0;top:0;width:960px;height:90px;background:#1F4E8C"><h1 style="margin:24px 56px;font-size:30px;color:#FFFFFF">まとまり</h1></div>
<div style="position:absolute;left:56px;top:120px;width:260px;height:160px;background:#EEF2F7;border-radius:12px;padding:20px">
<i data-icon="lock" style="display:block;width:32px;height:32px;color:#1F4E8C"></i><h3 style="margin:8px 0;font-size:20px">長くする</h3><p style="margin:0;font-size:16px">12文字以上</p></div>
<div style="position:absolute;left:420px;top:120px;width:200px;height:80px;background:#1F4E8C;color:#FFFFFF;border-radius:40px;display:flex;align-items:center;justify-content:center;font-size:20px">気づく</div></section>`,
        },
      ],
      theme,
    );
    assert.ok(!('error' in page));
    if ('error' in page) return;
    const design = validateDesign({ elements: page.elements }, 0);
    const scene = compileDeck({ ...deck(design.elements), themeId: 'ai', aiTheme: theme }).slides[1];
    const groupOf = (text: string) => scene.elements.find(e => e.kind === 'text' && e.text === text)!.group;
    const card = groupOf('長くする')!,
      icon = scene.elements.filter(e => e.group?.startsWith(`${card}/`));
    assert.deepEqual(
      scene.elements.filter(e => e.group === card).map(e => (e.kind === 'text' ? e.text : e.kind)),
      ['shape', '長くする', '12文字以上'],
    );
    assert.ok(icon.length > 1 && new Set(icon.map(e => e.group)).size === 1, 'the icon strokes: a group in the card');
    const label = scene.elements.find(e => e.kind === 'text' && e.text === '気づく')!;
    assert.equal(scene.elements[scene.elements.indexOf(label) - 1].kind, 'shape');
    assert.ok(label.kind === 'text' && label.inShape?.middle && !label.group, 'one text in its box: in the shape');
    assert.equal(groupOf('まとまり'), undefined, 'a title stays on its own');
  },
);

test(
  "an SVG drawing becomes PowerPoint shapes, lines and freeforms in one group; data-shape is PowerPoint's own shape with its label in it",
  { skip: !findBrowser() },
  async () => {
    const theme = paletteTheme({
      name: 't',
      background: '#FFFFFF',
      text: '#1F2A44',
      muted: '#6B7280',
      accent: '#1F4E8C',
      accent2: '#C37527',
    });
    const step =
      'width:220px;height:70px;background:#1F4E8C;color:#FFFFFF;display:flex;align-items:center;justify-content:center;font-size:20px';
    const [page] = await layoutHtmlSlides(
      [
        {
          id: 'slide-2',
          html: `<section class="slide"><h1 style="position:absolute;left:56px;top:30px;margin:0;font-size:30px">流れ</h1>
<div style="position:absolute;left:56px;top:100px;display:flex;gap:6px"><div data-shape="pentagon" style="${step}">計画</div><div data-shape="chevron" style="${step}">実行</div></div>
<div style="position:absolute;left:560px;top:100px;width:200px;height:70px;border:2px dashed #1F4E8C"></div>
<svg style="position:absolute;left:56px;top:200px" width="400" height="300" viewBox="0 0 200 150">
<defs><marker id="m" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L10 5L0 10z"/></marker></defs>
<rect x="10" y="10" width="60" height="30" rx="5" fill="#EEF2F7" stroke="#1F4E8C"/>
<circle cx="130" cy="75" r="40" fill="none" stroke="#1F4E8C" stroke-width="2" stroke-dasharray="4 3"/>
<line x1="70" y1="25" x2="100" y2="50" stroke="#C37527" stroke-width="2" marker-end="url(#m)"/>
<polygon points="20,100 60,120 20,140" fill="#1F4E8C"/>
<path d="M100 140a30 30 0 0 1 60 0" fill="none" stroke="#1F2A44" stroke-width="2" marker-end="url(#m)"/></svg>
<svg style="position:absolute;left:560px;top:200px" width="200" height="100"><rect width="200" height="100" fill="#EEF2F7"/><text x="20" y="50">文字</text></svg></section>`,
        },
      ],
      theme,
    );
    assert.ok(!('error' in page));
    if ('error' in page) return;
    const elements = page.elements as FreeElement[],
      line = elements.find(e => e.t === 'line')!,
      parts = elements.filter(e => e.g !== undefined && e.g === line.g);
    assert.deepEqual(
      parts.map(e => (e.t === 'box' ? e.shape : e.t)),
      ['roundRect', 'ellipse', 'line', 'path', 'path'],
    );
    const [, ring, , mark, arc] = parts;
    assert.deepEqual(ring, {
      t: 'box',
      x: 236,
      y: 270,
      w: 160,
      h: 160,
      shape: 'ellipse',
      fill: 'none',
      line: 'accent',
      lw: 4,
      dash: true,
      g: line.g,
    });
    assert.deepEqual(line, {
      t: 'line',
      x1: 196,
      y1: 250,
      x2: 256,
      y2: 300,
      color: 'accent2',
      lw: 4,
      arrow: 'end',
      g: line.g,
    });
    assert.ok(mark.t === 'path' && mark.d === 'M 96 400 L 176 440 L 96 480 Z');
    assert.ok(arc.t === 'path' && arc.arrow === 'end' && /^M 256 480 C .* 376 480$/.test(arc.d));
    assert.deepEqual([arc.x, arc.y, arc.w, arc.h], [256, 420, 120, 60]);
    assert.equal(page.elements.filter(e => e.t === 'svg').length, 1, 'a drawing with text stays a picture');

    const design = validateDesign({ elements: page.elements }, 0);
    const scene = compileDeck({ ...deck(design.elements), themeId: 'ai', aiTheme: theme }).slides[1];
    const shapes = scene.elements.filter((e): e is ShapeElement => e.kind === 'shape'),
      label = (text: string) => scene.elements.find((e): e is TextElement => e.kind === 'text' && e.text === text)!;
    assert.deepEqual(
      shapes.slice(0, 3).map(e => [e.shape, !!e.dash]),
      [
        ['pentagon', false],
        ['chevron', false],
        ['rect', true],
      ],
    );
    // PowerPoint's text area of a pentagon stops short of its point; the label stays in the middle of the shape.
    assert.deepEqual(
      [label('計画').align, label('計画').inShape, label('実行').inShape],
      ['center', { margin: [17.5, 0, 0, 0], middle: true }, { margin: [0, 0, 0, 0], middle: true }],
    );
    assert.ok(shapes.some(e => e.path === arc.d && e.arrow && e.fill === 'none' && e.stroke === '#1F2A44'));
  },
);

test('a line running square into the middle of a box side is glued to it as a connector and drawn up to it', () => {
  const box = (x: number, shape: 'rect' | 'ellipse' = 'rect'): FreeElement => ({
    t: 'box',
    x,
    y: 120,
    w: 200,
    h: 100,
    shape,
    fill: 'surface',
  });
  const line = (x1: number, y1: number, x2: number, y2: number, arrow?: 'end'): FreeElement => ({
    t: 'line',
    x1,
    y1,
    x2,
    y2,
    color: 'accent',
    lw: 2,
    ...(arrow ? { arrow } : {}),
  });
  const scene = compileDeck(
    deck([
      title,
      box(56),
      box(336),
      box(616, 'ellipse'),
      line(264, 170, 328, 170, 'end'),
      line(536, 170, 616, 170),
      line(264, 200, 328, 200, 'end'),
      line(156, 230, 156, 300),
      { t: 'text', x: 56, y: 450, w: 300, h: 30, text: '注記', size: 14 },
    ]),
  ).slides[1];
  const lines = scene.elements.filter(e => e.kind === 'line');
  assert.deepEqual(
    lines.map(e => [e.x, e.y, e.w, e.h, e.from, e.to]),
    [
      // An arrow stopping short of both boxes is drawn from side to side.
      [256, 170, 80, 0, { shape: 0, site: 4 }, { shape: 1, site: 2 }],
      [536, 170, 80, 0, { shape: 1, site: 4 }, { shape: 2, site: 3 }],
      // Off the middles, or a plain line short of the box: left as drawn.
      [264, 200, 64, 0, undefined, undefined],
      [156, 230, 0, 70, undefined, undefined],
    ],
  );
});

test(
  'an arrow drawn as a line and a triangle or chevron head on a page is one PowerPoint arrow between the boxes',
  { skip: !findBrowser() },
  async () => {
    const theme = paletteTheme({
      name: 't',
      background: '#FFFFFF',
      text: '#1F2A44',
      muted: '#6B7280',
      accent: '#1F4E8C',
      accent2: '#C37527',
    });
    const card = (left: number, text: string) =>
      `<div style="position:absolute;left:${left}px;top:120px;width:220px;height:100px;background:#EEF2F7;display:flex;align-items:center;justify-content:center;font-size:20px">${text}</div>`;
    const [page] = await layoutHtmlSlides(
      [
        {
          id: 'slide-2',
          html: `<section class="slide"><h1 style="position:absolute;left:56px;top:30px;margin:0;font-size:30px">流れ</h1>${card(56, '受付')}
<svg style="position:absolute;left:284px;top:154px" width="40" height="32"><line x1="2" y1="16" x2="28" y2="16" stroke="#C37527" stroke-width="4"/><polygon points="26,8 38,16 26,24" fill="#C37527"/></svg>
${card(332, '審査')}
<svg style="position:absolute;left:560px;top:154px" width="40" height="32"><path d="M2 16 H34 M26 8 L38 16 L26 24" stroke="#C37527" stroke-width="4" fill="none"/></svg>
${card(608, '承認')}</section>`,
        },
      ],
      theme,
    );
    assert.ok(!('error' in page));
    if ('error' in page) return;
    const elements = page.elements as FreeElement[];
    assert.ok(!elements.some(e => e.t === 'path'), 'the heads are the lines’ own');
    assert.deepEqual(
      elements.filter(e => e.t === 'line').map(e => e.t === 'line' && [e.x1, e.y1, e.x2, e.y2, e.arrow]),
      [
        [286, 170, 322, 170, 'end'],
        [562, 170, 598, 170, 'end'],
      ],
    );
    const design = validateDesign({ elements }, 0);
    const scene = compileDeck({ ...deck(design.elements), themeId: 'ai', aiTheme: theme }).slides[1];
    assert.deepEqual(
      scene.elements.filter(e => e.kind === 'line').map(e => [e.x, e.w, e.from?.site, e.to?.site]),
      [
        [276, 56, 4, 2],
        [552, 56, 4, 2],
      ],
    );
  },
);
