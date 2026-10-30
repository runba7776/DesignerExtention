import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DeckSpec, Outline, TextElement } from '../shared/contracts.js';
import { SessionEngine } from '../server/engine.js';
import { SettingsStore } from '../server/settings.js';
import { emptyUsage, parseJsonResponse, type CompletionRequest } from '../server/providers.js';
import { findBrowser, layoutHtmlSlides, type HtmlLayout } from '../server/html-layout.js';
import { validateSlide } from '../server/validation.js';
import { compileDeck } from '../shared/layouts.js';
import { isDarkColor } from '../shared/free-design.js';
import { paletteTheme } from '../shared/ai-theme.js';

const usage = { ...emptyUsage(), calls: 1 };
const title = (id: string, text: string) => ({
  t: 'text',
  x: 56,
  y: 30,
  w: 600,
  h: 44,
  text,
  size: 30,
  exact: true,
  role: id === 'slide-1' ? 'body' : 'title',
});

test('pages written one per fenced block, and a line of HTML ending with a backslash, are read as one answer (gemma4 on Ollama)', () => {
  const page = (id: string) => ({ mode: 'presentation', id, title: id, html: "<section class='slide'></section>" });
  assert.deepEqual(
    parseJsonResponse(
      ['```json', JSON.stringify(page('slide-1')), '```', '', '```json', JSON.stringify(page('slide-2')), '```'].join(
        '\n',
      ),
    ),
    {
      mode: 'presentation',
      slides: ['slide-1', 'slide-2'].map(id => (({ mode: _mode, ...rest }) => rest)(page(id))),
    },
  );
  const broken =
    '```json\n{"mode":"presentation","slides":[{"id":"slide-2","html":"<p>a</p>\\\n<p class=\\\'b\\\'>b</p>"}]}\n```';
  assert.deepEqual(parseJsonResponse(broken), {
    mode: 'presentation',
    slides: [{ id: 'slide-2', html: "<p>a</p>\n<p class='b'>b</p>" }],
  });
});

test('a local LLM that cannot make a page still finishes the deck: a page with slips in its HTML is kept as written, a page asked again in vain is asked once with layouts (an empty one is not kept), else made from the outline; each is a hint', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'de-local-finish-'));
  try {
    const settings = await new SettingsStore(dir, '').load();
    await settings.update({ provider: 'local', model: 'mock', slideCount: 4, mode: 'presentation' });
    const outline = {
      title: '4枚',
      mode: 'presentation',
      assumptions: [],
      slides: [
        { id: 'slide-1', title: '表紙', intent: '表紙', layoutId: 'cover', keyPoints: [] },
        { id: 'slide-2', title: '崩れる', intent: '説明', layoutId: 'free', keyPoints: [] },
        { id: 'slide-3', title: '型で作る', intent: '説明', layoutId: 'free', keyPoints: [] },
        { id: 'slide-4', title: '返らない', intent: '説明', layoutId: 'free', keyPoints: ['要点A', '要点B'] },
      ],
    } as Outline;
    const batches: string[][] = [],
      layoutSystems: string[] = [];
    const htmlLayout: HtmlLayout = async pages =>
      pages.map(p => ({
        elements: [title(p.id, /<h1>(.*?)<\/h1>/.exec(p.html)![1])],
        problems:
          p.id === 'slide-2'
            ? ['文字が囲みからはみ出して一部が隠れています（「本文」）。囲みを広げるか、文字を減らしてください。']
            : [],
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
          const ids: string[] = req.targetSlides.map((s: any) => s.id),
            layout = req.targetSlides[0].layoutId === 'summary';
          batches.push(ids.map(id => id + (layout ? ':layout' : '')));
          if (layout) layoutSystems.push(r.system);
          // slide-3 comes back with a layout; slide-4 with the layout but no items, which is not kept.
          if (layout) {
            const page = {
              id: ids[0],
              title: req.targetSlides[0].title,
              layoutId: 'summary',
              items: ids[0] === 'slide-3' ? [{ label: '項目', description: '説明' }] : [],
              notes: '',
              sources: [],
            };
            return { text: JSON.stringify({ mode: 'presentation', slides: [page] }), usage };
          }
          if (ids.some(id => id === 'slide-3' || id === 'slide-4'))
            return { text: '```json\n{"mode":"presentation","slides":[{"id":', usage };
          const slides = req.targetSlides.map((s: any) => ({
            id: s.id,
            title: s.title,
            layoutId: s.layoutId,
            notes: '',
            sources: [],
            html: `<section class="slide"><h1>${s.title}</h1></section>`,
          }));
          return { text: JSON.stringify({ mode: 'presentation', slides }), usage };
        },
      }),
    });
    const session = await engine.create({ prompt: '4枚' }, []);
    await engine.generate(session.id);
    assert.equal(session.phase, 'ready', JSON.stringify(session.recovery));
    assert.deepEqual(batches, [
      ['slide-1', 'slide-2'],
      ['slide-2'],
      ['slide-3'],
      ['slide-3:layout'],
      ['slide-4'],
      ['slide-4:layout'],
    ]);
    assert.match(layoutSystems[0], /利用できる文法/);
    assert.doesNotMatch(layoutSystems[0], /<section class="slide">/);
    const [, kept, asked, made] = session.variants[0].deck.slides;
    assert.equal((kept.design!.elements[0] as any).text, '崩れる');
    assert.deepEqual(
      asked.items.map(i => i.label),
      ['項目'],
    );
    assert.ok(!made.design && made.layoutId !== 'free', made.layoutId);
    assert.deepEqual(
      made.items.map(i => i.label),
      ['要点A', '要点B'],
    );
    assert.deepEqual(
      session.reviewHints?.map(h => [h.slideId, h.what.slice(0, 12)]),
      [
        ['slide-2', 'AIが直しきれなかった点'],
        ['slide-3', 'AIのデザインが崩れたた'],
        ['slide-4', 'AIが作れなかったため、'],
      ],
    );
    assert.match(session.reviewHints![0].what, /囲みからはみ出して/);
    assert.equal(
      compileDeck(session.variants[0].deck).slides.length,
      4,
      'layout pages in an AI-designed deck are drawn',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the page number on a band down to the slide bottom is drawn light', () => {
  const deck = (band: boolean): DeckSpec => ({
    id: 'd',
    title: '帯',
    mode: 'presentation',
    themeId: 'business',
    slides: [
      validateSlide(
        {
          id: 'slide-1',
          title: '表紙',
          layoutId: 'cover',
          notes: '',
          sources: [],
          design: { elements: [title('slide-1', '表紙')] },
        },
        'slide-1',
      ),
      validateSlide(
        {
          id: 'slide-2',
          title: '帯',
          layoutId: 'free',
          notes: '',
          sources: [],
          design: {
            elements: [
              title('slide-2', '帯'),
              ...(band ? [{ t: 'box', x: 0, y: 480, w: 960, h: 60, shape: 'rect', fill: '#1F2A44' }] : []),
            ],
          },
        },
        'slide-2',
      ),
    ],
  });
  const ink = (band: boolean) =>
    (compileDeck(deck(band)).slides[1].elements.find(e => e.kind === 'text' && e.text === '2 / 2') as TextElement)
      .color;
  assert.ok(isDarkColor(ink(false)) || ink(false) !== ink(true));
  assert.ok(!isDarkColor(ink(true)), ink(true));
});

test(
  'a real browser: text a little small is kept for a local model when larger it would not fit; a band stopping in the footer is reported',
  { skip: !findBrowser() },
  async () => {
    const theme = paletteTheme({
      name: '紺',
      background: '#F8F9FA',
      text: '#1F2A44',
      muted: '#6B7280',
      accent: '#0056B3',
      accent2: '#2F6F8F',
    });
    const text = '社外へ誤って送信した、パスワードを紛失した、不審なメールを開いてしまった。'.repeat(4);
    const full = `<section class="slide"><h1 style="position:absolute;left:56px;top:30px;margin:0;font-size:32px">報告</h1>
<p style="position:absolute;left:56px;top:430px;width:848px;margin:0;font-size:14px;line-height:1.5">${text}</p></section>`;
    const options = { minTextSize: { body: 16, caption: 12 } };
    const [strict, kept] = [
      ...(await layoutHtmlSlides([{ id: 'slide-2', html: full }], theme, options)),
      ...(await layoutHtmlSlides([{ id: 'slide-2', html: full }], theme, { ...options, keepSmall: true })),
    ];
    assert.ok(!('error' in strict) && strict.problems.some(p => p.includes('文字が小さすぎます')));
    assert.ok(!('error' in kept) && !kept.problems.length && kept.keptSmall, JSON.stringify(kept));
    const band = (top: number, height: number) =>
      `<section class="slide"><h1 style="position:absolute;left:56px;top:30px;margin:0;font-size:32px">帯</h1><div style="position:absolute;left:40px;top:${top}px;width:880px;height:${height}px;background:#0056B3"></div></section>`;
    const [stopping, bottom] = await layoutHtmlSlides(
      [
        { id: 'slide-2', html: band(457, 56) },
        { id: 'slide-3', html: band(480, 60) },
      ],
      theme,
    );
    assert.ok(!('error' in stopping) && stopping.problems.some(p => p.includes('ページ番号の欄')));
    assert.ok(!('error' in bottom) && !bottom.problems.length, JSON.stringify(bottom));
  },
);
