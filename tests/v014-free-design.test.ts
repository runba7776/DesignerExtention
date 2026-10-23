import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DeckSpec, LineElement, Session, ShapeElement, SlideSpec, TextElement } from '../shared/contracts.js';
import { compileDeck } from '../shared/layouts.js';
import { themes } from '../shared/themes.js';
import { contrast } from '../shared/color.js';
import { lineElement } from '../shared/free-design.js';
import { SettingsStore } from '../server/settings.js';
import { SessionEngine } from '../server/engine.js';
import { demoOutline } from '../server/demo.js';
import { systemPrompt } from '../server/prompts.js';
import { validateDeck, validateSlide } from '../server/validation.js';
import { textFields, applySummaries, fitProblems } from '../server/text-fit.js';

const title = (text: string) => ({
  t: 'text',
  x: 56,
  y: 28,
  w: 848,
  h: 52,
  text,
  size: 30,
  bold: true,
  color: 'ink',
  role: 'title',
});
function freeSlide(id: string, heading: string, elements: unknown[] = []): any {
  return {
    id,
    title: heading,
    layoutId: id === 'slide-1' ? 'cover' : 'free',
    items: [],
    notes: '話す内容',
    sources: [],
    design: { elements: [title(heading), ...elements] },
  };
}
const process = [
  { t: 'box', x: 56, y: 148, w: 280, h: 64, shape: 'chevron', fill: 'accent' },
  { t: 'text', x: 92, y: 148, w: 208, h: 64, text: '1 試行', size: 22, color: 'onAccent', va: 'm', role: 'heading' },
  { t: 'box', x: 340, y: 148, w: 280, h: 64, shape: 'chevron', fill: 'accent', op: 0.6 },
  { t: 'text', x: 376, y: 148, w: 208, h: 64, text: '2 展開', size: 22, color: 'ink', va: 'm', role: 'heading' },
  { t: 'box', x: 56, y: 244, w: 56, h: 56, shape: 'ellipse', fill: 'surface' },
  { t: 'icon', icon: 'people', x: 68, y: 256, size: 32, color: 'accent' },
  { t: 'line', x1: 620, y1: 330, x2: 340, y2: 330, color: 'rule', arrow: 'end', dash: true },
  {
    t: 'text',
    x: 56,
    y: 316,
    w: 264,
    h: 96,
    text: '2部署・30人で試し、作業時間の変化を記録します',
    size: 16,
    color: 'ink',
    role: 'body',
  },
  {
    t: 'chart',
    x: 560,
    y: 350,
    w: 344,
    h: 130,
    chart: { type: 'column', categories: ['前年', '当期'], series: [{ name: '時間', values: [12, 9] }], unit: '時間' },
  },
];
const deckOf = (slides: SlideSpec[]): DeckSpec => ({
  id: 'd',
  title: '自由デザイン',
  mode: 'presentation',
  themeId: 'business',
  slides,
});

test('free-design prompts leave the design to the AI: only facts, sources and the checked technical limits', () => {
  const theme = themes.business,
    plan = systemPrompt('plan', undefined, { design: 'free', outputMode: 'presentation' }),
    generate = systemPrompt('generate', undefined, { design: 'free', theme, outputMode: 'presentation' });
  for (const prompt of [plan, generate]) {
    assert.match(prompt, /幅960×高さ540/);
    assert.match(prompt, /Element = Text\|Box\|Line\|Icon\|Chart\|Table/);
    assert.match(prompt, /すべてあなたに任せます/);
    // No layout hints, examples or style rules that would steer the composition.
    assert.doesNotMatch(prompt, /シェブロン|題名の下線|x:56|"x":56|余白と整列|見本の|例（/);
    assert.match(prompt, /最優先の制約/);
    assert.match(prompt, /出典はdocuments中の実在するdocumentId/);
    assert.doesNotMatch(prompt, /design_metric_rows|textBudget|maxItems厳守/);
  }
  assert.match(plan, /layoutId:"free"/);
  assert.match(plan, /visualStyle/);
  assert.match(generate, new RegExp(`accent=${theme.accent}`));
  assert.ok(generate.length < 20_000, `${generate.length} characters`);
  assert.ok(systemPrompt('generate', undefined, { design: 'free', theme, mode: 'project' }).length < generate.length);
});

test('validation accepts a designed slide and rejects what would be unreadable or outside the slide', () => {
  const ok = validateSlide(freeSlide('slide-2', '導入は2段階で進める', process), 'slide-2');
  assert.equal(ok.design!.elements.length, process.length + 1);
  const bad = (elements: unknown[], pattern: RegExp, extra: Record<string, unknown> = {}) =>
    assert.throws(() => validateSlide({ ...freeSlide('slide-2', '題名', elements), ...extra }, 'slide-2'), pattern);
  bad([{ t: 'text', x: 900, y: 100, w: 100, h: 30, text: '外', size: 16 }], /はみ出し/);
  bad([{ t: 'text', x: 56, y: 480, w: 300, h: 40, text: '出典欄', size: 16 }], /出典欄/);
  bad(
    [
      { t: 'text', x: 56, y: 100, w: 300, h: 60, text: '一つ目', size: 16 },
      { t: 'text', x: 60, y: 104, w: 300, h: 60, text: '二つ目', size: 16 },
    ],
    /重なって/,
  );
  bad(
    [
      {
        t: 'chart',
        x: 56,
        y: 100,
        w: 400,
        h: 200,
        chart: {
          type: 'waterfall',
          categories: ['前年', '要因', '当期'],
          series: [{ name: '利益', values: [100, 10, 200] }],
        },
      },
    ],
    /終点/,
  );
  bad([{ t: 'box', x: 56, y: 100, w: 100, h: 100, fill: 12 }], /色/);
  // The page title cannot be told apart: two equally large texts at the top, neither repeating the title.
  assert.throws(
    () =>
      validateSlide(
        {
          ...freeSlide('slide-2', '題名'),
          design: {
            elements: [
              { t: 'text', x: 56, y: 40, w: 300, h: 40, text: '左', size: 24 },
              { t: 'text', x: 500, y: 40, w: 300, h: 40, text: '右', size: 24 },
            ],
          },
        },
        'slide-2',
      ),
    /role:"title"/,
  );
  assert.throws(
    () => validateSlide({ id: 'slide-2', title: '型なし', layoutId: 'free', notes: '', sources: [] }, 'slide-2'),
    /design/,
  );
  // The cover is designed too and needs no title role.
  assert.ok(
    validateSlide(
      {
        ...freeSlide('slide-1', '表紙'),
        design: {
          background: 'ink',
          elements: [{ t: 'text', x: 64, y: 160, w: 800, h: 120, text: '表紙の題名', size: 44, color: 'white' }],
        },
      },
      'slide-1',
    ).design,
  );
});

test('technical slips are fixed in place instead of costing another AI call', () => {
  const slide = (elements: unknown[]) =>
    validateSlide({ ...freeSlide('slide-2', '題名'), design: { elements } }, 'slide-2').design!.elements as any[];
  // A few points past the edge or into the footer are trimmed; a text keeps at least one line.
  const [edge, footer] = slide([
    { t: 'text', x: 620, y: 28, w: 350, h: 52, text: '題名', size: 28, role: 'title' },
    { t: 'text', x: 56, y: 440, w: 300, h: 70, text: '注記', size: 16 },
  ]);
  assert.deepEqual([edge.x, edge.w], [620, 340]);
  assert.equal(footer.y + footer.h, 496);
  // Synonyms and short colour codes are understood; unknown values fall back to the theme's default.
  const [, box] = slide([
    { t: 'text', x: 56, y: 28, w: 400, h: 52, text: '題名', size: 28, role: 'title', align: 'center' },
    { t: 'box', x: 56, y: 120, w: 100, h: 100, shape: 'circle', fill: '#FFF', line: 'red' },
  ]);
  assert.equal(box.shape, 'ellipse');
  assert.equal(box.fill, '#FFFFFF');
  assert.equal(box.line, undefined);
  // An unknown icon and a citation number without a source are dropped; the rest stays.
  const kept = slide([
    { t: 'text', x: 56, y: 28, w: 400, h: 52, text: '題名', size: 28, role: 'title', refs: [2] },
    { t: 'icon', icon: 'logo-of-a-company', x: 56, y: 100, size: 32 },
  ]);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].refs, undefined);
  // The title role is given to the text that repeats the slide title, or to the one largest text at the top.
  assert.equal(
    slide([
      { t: 'text', x: 56, y: 28, w: 400, h: 52, text: '題名', size: 28 },
      { t: 'text', x: 56, y: 120, w: 400, h: 60, text: '本文', size: 40 },
    ])[0].role,
    'title',
  );
  assert.equal(
    slide([
      { t: 'text', x: 56, y: 28, w: 400, h: 52, text: '大見出し', size: 30 },
      { t: 'text', x: 56, y: 120, w: 400, h: 60, text: '本文', size: 16 },
    ])[0].role,
    'title',
  );
  // Numbers written as text in a chart become numbers when they are plain numbers.
  const chart = slide([
    { t: 'text', x: 56, y: 28, w: 400, h: 52, text: '題名', size: 28, role: 'title' },
    {
      t: 'chart',
      x: 56,
      y: 120,
      w: 400,
      h: 250,
      chart: { type: 'column', categories: ['A', 'B'], series: [{ name: '売上', values: ['1,200', '980'] }] },
    },
  ])[1];
  assert.deepEqual(chart.chart.series[0].values, [1200, 980]);
  assert.throws(
    () =>
      slide([
        { t: 'text', x: 56, y: 28, w: 400, h: 52, text: '題名', size: 28, role: 'title' },
        {
          t: 'chart',
          x: 56,
          y: 120,
          w: 400,
          h: 250,
          chart: { type: 'column', categories: ['A'], series: [{ name: '売上', values: ['約1,200'] }] },
        },
      ]),
    /グラフ/,
  );
});

test('designed slides compile to editable shapes with readable text, arrows on the right ends and light footers on dark pages', () => {
  const cover = {
    ...freeSlide('slide-1', '表紙'),
    design: {
      background: 'ink',
      elements: [{ t: 'text', x: 64, y: 160, w: 800, h: 120, text: '自由デザインの表紙', size: 44, color: 'ink' }],
    },
    sources: [{ documentId: 'doc', documentName: '資料.pdf', locator: 'p.1' }],
  };
  const body = { ...validateSlide(freeSlide('slide-2', '導入は2段階で進める', process), 'slide-2'), sources: [] };
  const scene = compileDeck(deckOf([cover as SlideSpec, body]));
  const [first, second] = scene.slides,
    theme = themes.business;
  const coverTitle = first.elements.find(
    (e): e is TextElement => e.kind === 'text' && e.text.includes('自由デザイン'),
  )!;
  assert.ok(
    contrast(coverTitle.color, theme.foreground) >= 4.5,
    'ink on an ink background is switched to a readable colour',
  );
  const footer = first.elements.find((e): e is TextElement => e.kind === 'text' && e.text.startsWith('出典'))!;
  assert.ok(contrast(footer.color, theme.foreground) >= 3, 'footer is light on a dark page');
  const shapes = second.elements.filter((e): e is ShapeElement => e.kind === 'shape');
  assert.ok(shapes.some(s => s.shape === 'chevron' && s.fill === theme.accent));
  assert.ok(shapes.some(s => s.opacity === 0.6));
  const onChevron = second.elements.find((e): e is TextElement => e.kind === 'text' && e.text === '1 試行')!;
  assert.equal(onChevron.verticalAlign, 'middle');
  assert.ok(contrast(onChevron.color, theme.accent) >= 3);
  const arrow = second.elements.find((e): e is LineElement => e.kind === 'line' && !!e.dash)!;
  assert.equal(arrow.arrowStart, true, 'a leftward arrow keeps its head on the left');
  assert.notEqual(arrow.arrow, true);
  assert.ok(second.elements.some(e => e.kind === 'chart'));
  assert.ok(!second.elements.some(e => e.kind === 'text' && e.y === 34 && e.w === 848), 'no template title is added');
  assert.doesNotMatch(
    second.notes,
    /2部署・30人で試し|内容:/,
    'the page shows all its text; the notes are not filled with a copy',
  );
  assert.deepEqual(lineElement({ t: 'line', x1: 100, y1: 300, x2: 100, y2: 200, arrow: 'end' }, '#000000'), {
    kind: 'line',
    x: 100,
    y: 200,
    w: 0,
    h: 100,
    stroke: '#000000',
    strokeWidth: 1.5,
    arrowStart: true,
  });
});

test('overflowing designed text can be shortened in place without changing numbers', () => {
  const slide = validateSlide(
    freeSlide('slide-2', '長い説明', [
      {
        t: 'text',
        x: 56,
        y: 100,
        w: 200,
        h: 30,
        text: '作業時間を12時間から9時間に短縮し、残りの時間を顧客対応と品質の確認に充てました',
        size: 18,
        role: 'body',
      },
    ]),
    'slide-2',
  );
  const deck = deckOf([validateSlide(freeSlide('slide-1', '表紙'), 'slide-1'), slide]);
  const problems = fitProblems(deck);
  assert.equal(problems.length, 1);
  assert.ok(Object.hasOwn(textFields(slide), 'design.elements.1.text'));
  assert.ok(
    Object.hasOwn(textFields(slide), 'design.elements.0.text'),
    'a title that does not fit can be shortened too',
  );
  const next = applySummaries(
    deck,
    { replacements: [{ slideId: 'slide-2', path: 'design.elements.1.text', text: '12時間を9時間に短縮' }] },
    ['slide-2'],
  );
  assert.equal((next.slides[1].design!.elements[1] as any).text, '12時間を9時間に短縮');
  assert.deepEqual(fitProblems(next), []);
  assert.throws(
    () =>
      applySummaries(
        deck,
        { replacements: [{ slideId: 'slide-2', path: 'design.elements.1.text', text: '15時間を9時間に' }] },
        ['slide-2'],
      ),
    /数値/,
  );
});

test('manual chat uses free design by default: free prompt, smaller batches, repair request for overlapping text', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'de-free-'));
  try {
    const settings = await new SettingsStore(dir, '').load();
    await settings.update({ provider: 'chat', mode: 'presentation', slideCount: 6 });
    assert.equal(settings.get().designMode, undefined);
    await assert.rejects(settings.update({ designMode: 'svg' as any }), /作り方/);
    const engine = new SessionEngine({
      settings,
      dataDir: dir,
      render: async () => ({ artifactId: 'x', pptxUrl: '/x.pptx', thumbnails: [], warnings: [], native: false }),
      providerFactory: () => {
        throw new Error('no provider call');
      },
    });
    const outline = demoOutline('自由デザインの確認', 'presentation', [], 6);
    outline.slides = outline.slides.map((s, i) => ({ ...s, layoutId: i ? 'free' : 'cover' }));
    const reply = (session: Session, value: unknown) =>
      engine.chatResponse(session.id, { requestId: session.chatHandoff!.requestId, response: JSON.stringify(value) });
    const session = await engine.create({ prompt: '導入計画を図解で説明' }, []);
    assert.match(session.chatHandoff!.instruction, /各ページのデザインまで行います/);
    await reply(session, { kind: 'outline', outline: { ...outline, visualStyle: '濃紺の表紙、本文は白地に青1色' } });
    await engine.generate(session.id);
    const packet = JSON.parse(session.chatHandoff!.instruction.split('\n\n').at(-2)!);
    assert.equal(packet.request.targetSlides.length, 4);
    assert.match(session.chatHandoff!.instruction, /design\.elements/);
    const slides = packet.request.targetSlides.map((s: any) =>
      s.id === 'slide-1'
        ? {
            ...freeSlide('slide-1', s.title),
            design: {
              background: 'ink',
              elements: [{ t: 'text', x: 64, y: 160, w: 800, h: 120, text: s.title, size: 44, color: 'white' }],
            },
          }
        : freeSlide(s.id, s.title, [{ t: 'text', x: 56, y: 120, w: 400, h: 60, text: '要点', size: 20 }]),
    );
    // Two overlapping text boxes: the app asks the AI to fix positions, keeping nothing half-done.
    const broken = structuredClone(slides);
    broken[1].design.elements.push({ t: 'text', x: 60, y: 124, w: 400, h: 60, text: '重なる文字', size: 20 });
    await reply(session, {
      mode: 'presentation',
      themeId: 'business',
      id: 'd',
      title: '自由デザインの確認',
      slides: broken,
    });
    assert.ok(
      session.chatHandoff?.validationIssues?.some(issue => /重なって/.test(issue)),
      JSON.stringify(session.chatHandoff?.validationIssues),
    );
    await reply(session, { mode: 'presentation', themeId: 'business', id: 'd', title: '自由デザインの確認', slides });
    const rest = JSON.parse(session.chatHandoff!.instruction.split('\n\n').at(-2)!).request.targetSlides;
    assert.ok(rest.length >= 1);
    assert.ok(
      JSON.parse(session.chatHandoff!.instruction.split('\n\n').at(-2)!).request.continuedFrom.some((c: any) =>
        /text×/.test(c.composition ?? ''),
      ),
    );
    await reply(session, {
      mode: 'presentation',
      themeId: 'business',
      id: 'd',
      title: '自由デザインの確認',
      slides: rest.map((s: any) =>
        freeSlide(s.id, s.title, [
          { t: 'box', x: 56, y: 120, w: 300, h: 200, shape: 'roundRect', fill: 'surface', r: 0.1 },
        ]),
      ),
    });
    assert.equal(session.phase, 'ready');
    const deck = session.variants[0].deck;
    assert.ok(deck.slides.every(s => s.design));
    assert.equal(validateDeck(deck).slides.length, 6);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('browser-measured text and SVG artwork pass through unchanged as text and pictures', () => {
  const design = {
    elements: [
      { t: 'text', x: 56, y: 30, w: 500, h: 40, text: '題名', size: 30, bold: true, role: 'title', exact: true },
      { t: 'text', x: 56, y: 100, w: 200, h: 60, text: '一行目\n二行目', size: 15, lh: 24, exact: true },
      {
        t: 'svg',
        x: 300,
        y: 100,
        w: 40,
        h: 40,
        svg: '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><circle cx="20" cy="20" r="18" fill="#245DA8"/></svg>',
      },
    ],
  } as any;
  const scene = compileDeck(
    deckOf([
      {
        id: 'slide-1',
        title: '表紙',
        layoutId: 'cover',
        items: [],
        notes: '',
        sources: [],
        design: { elements: [{ t: 'text', x: 56, y: 100, w: 500, h: 60, text: '表紙', size: 40, exact: true }] },
      } as any,
      { id: 'slide-2', title: '題名', layoutId: 'free', items: [], notes: '', sources: [], design } as any,
    ]),
  ).slides[1];
  const texts = scene.elements.filter((e): e is TextElement => e.kind === 'text' && e.exact === true);
  assert.equal(texts.length, 2);
  assert.equal(texts[1].text, '一行目\n二行目');
  assert.equal(texts[1].lineHeight, 24);
  assert.equal(texts[1].noWrap, true);
  assert.deepEqual(scene.textIssues ?? [], []);
  const image = scene.elements.find(e => e.kind === 'image');
  assert.ok(image && image.kind === 'image' && image.svg?.includes('<circle'));
  // SVG artwork (from the HTML method's conversion) is kept only without scripts, events or outside references.
  assert.throws(
    () =>
      validateSlide(freeSlide('slide-2', '題名', [{ t: 'svg', x: 0, y: 0, w: 10, h: 10, svg: 'not svg' }]), 'slide-2'),
    /SVG/,
  );
  const cleaned = validateSlide(
    freeSlide('slide-2', '題名', [
      {
        t: 'svg',
        x: 0,
        y: 100,
        w: 10,
        h: 10,
        svg: '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><image href="http://example.com/a.png"/><circle onclick="x()" r="1" fill="url(http://example.com/p)"/><use xlink:href="http://example.com/s#a"/></svg>',
      },
    ]),
    'slide-2',
  );
  const svg = (cleaned.design!.elements.find(e => e.t === 'svg') as any).svg as string;
  assert.doesNotMatch(svg, /script|<image|onclick|example\.com/);
  assert.match(svg, /<circle/);
});
