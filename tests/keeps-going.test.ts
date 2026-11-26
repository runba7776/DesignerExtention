import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Outline } from '../shared/contracts.js';
import { SessionEngine } from '../server/engine.js';
import { SettingsStore } from '../server/settings.js';
import { parseDocument } from '../server/documents.js';
import { emptyUsage, type CompletionRequest } from '../server/providers.js';
import type { HtmlLayout } from '../server/html-layout.js';

// A deck made with a monthly plan is not stopped by one page or one citation: the app switches, finishes the deck,
// and lists what the user is to check (docs/system-design.md, 5).
const usage = { ...emptyUsage(), calls: 1 };
const outline = {
  title: '止めない作成',
  mode: 'presentation',
  assumptions: [],
  palette: {
    name: '紺',
    background: '#FFFFFF',
    text: '#1F2A44',
    muted: '#6B7280',
    accent: '#C8902E',
    accent2: '#2F6F8F',
  },
  slides: [
    { id: 'slide-1', title: '表紙', intent: '表紙', layoutId: 'cover', keyPoints: [] },
    { id: 'slide-2', title: '本文', intent: '本文', layoutId: 'free', keyPoints: ['要点A', '要点B'] },
    { id: 'slide-3', title: 'まとめ', intent: 'まとめ', layoutId: 'free', keyPoints: ['要点C'] },
  ],
} as unknown as Outline;
const asksHtml = (system: string) => /ルート要素は<section class="slide">/.test(system);

/** Stands in for the browser: the h1 becomes the title; text marked FOOTER is reported in the footer. */
const browser: HtmlLayout = async pages =>
  pages.map(p => ({
    elements: [
      {
        t: 'text',
        x: 56,
        y: 30,
        w: 600,
        h: 44,
        text: /<h1[^>]*>(.*?)<\/h1>/.exec(p.html)?.[1] ?? '',
        size: 30,
        role: p.id === 'slide-1' ? 'body' : 'title',
      },
    ],
    problems: p.html.includes('FOOTER') ? ['文字が下端の出典欄に入っています。'] : [],
  }));
const htmlPage = (id: string, title: string, extra = '', sources: object[] = []) => ({
  id,
  title,
  layoutId: id === 'slide-1' ? 'cover' : 'free',
  notes: '話す内容',
  sources,
  html: `<section class="slide"><h1>${title}</h1>${extra}</section>`,
});
const designedPage = (id: string, title: string) => ({
  id,
  title,
  layoutId: id === 'slide-1' ? 'cover' : 'free',
  notes: '話す内容',
  sources: [],
  design: {
    elements: [
      { t: 'text', x: 56, y: 30, w: 600, h: 44, text: title, size: 30, ...(id === 'slide-1' ? {} : { role: 'title' }) },
    ],
  },
});

async function fixture(
  page: (id: string, title: string, request: any, system: string) => object,
  layout: HtmlLayout = browser,
) {
  const dir = await mkdtemp(path.join(tmpdir(), 'de-keeps-going-'));
  const settings = await new SettingsStore(dir).load();
  await settings.update({
    provider: 'subscription',
    subscriptionService: 'claude',
    slideCount: 3,
    visualReview: false,
  });
  const asked: { system: string; request: any }[] = [];
  let layouts = 0;
  const engine = new SessionEngine({
    settings,
    dataDir: dir,
    htmlLayout: async (pages, theme, options) => {
      layouts++;
      return layout(pages, theme, options);
    },
    subscriptionBinding: () => 'account',
    render: async () => ({ artifactId: 'x', pptxUrl: 'x', thumbnails: [], warnings: [], native: false }),
    providerFactory: () => ({
      complete: async (r: CompletionRequest) => {
        const request = JSON.parse(r.content).request;
        if (!request.targetSlides && !request.targetSlide)
          return { text: JSON.stringify({ kind: 'outline', outline }), usage };
        asked.push({ system: r.system, request });
        if (request.targetSlide)
          return { text: JSON.stringify(page(request.targetSlide.id, '直した本文', request, r.system)), usage };
        const slides = request.targetSlides.map((s: any) => page(s.id, s.title, request, r.system));
        return { text: JSON.stringify({ mode: 'presentation', id: 'd', title: outline.title, slides }), usage };
      },
    }),
  });
  return { engine, asked, layouts: () => layouts, dispose: () => rm(dir, { recursive: true, force: true }) };
}

test('a page the AI cannot get right does not stop the deck: kept as written when only the browser found slips, with a hint', async () => {
  const f = await fixture((id, title) => htmlPage(id, title, id === 'slide-2' ? '<p>FOOTER</p>' : ''));
  try {
    const session = await f.engine.create({ prompt: '3枚', cloudConsent: true }, []);
    await f.engine.generate(session.id);
    assert.equal(session.phase, 'ready', JSON.stringify(session.recovery));
    assert.equal(session.recovery, undefined);
    assert.equal(f.asked.length, 3, 'two pages, the page alone once (no third time), the last page');
    assert.deepEqual(
      f.asked[1].request.targetSlides.map((s: any) => s.id),
      ['slide-2'],
    );
    const slide = session.variants[0].deck.slides[1];
    assert.equal((slide.design!.elements[0] as any).text, '本文');
    const hint = session.reviewHints!.find(h => h.slideId === 'slide-2')!;
    assert.match(hint.what, /AIが直しきれなかった点があります（文字が下端の出典欄に入っています。）/);
  } finally {
    await f.dispose();
  }
});

test('a page that keeps coming back broken is asked once with a layout, and the deck is finished', async () => {
  const f = await fixture((id, title, request) =>
    id !== 'slide-2'
      ? htmlPage(id, title)
      : request.targetSlides?.[0]?.layoutId === 'summary'
        ? { id, title, layoutId: 'summary', items: [{ label: '要点A' }, { label: '要点B' }], notes: '', sources: [] }
        : htmlPage('slide-9', title),
  );
  try {
    const session = await f.engine.create({ prompt: '3枚', cloudConsent: true }, []);
    await f.engine.generate(session.id);
    assert.equal(session.phase, 'ready', JSON.stringify(session.recovery));
    assert.equal(f.asked.length, 4, 'two pages, the page alone, the page with a layout, the last page');
    const slide = session.variants[0].deck.slides[1];
    assert.equal(slide.design, undefined, 'made from a layout');
    assert.deepEqual(
      slide.items.map(i => i.label),
      ['要点A', '要点B'],
    );
    assert.match(session.reviewHints!.find(h => h.slideId === 'slide-2')!.what, /型に当てはめて作りました/);
    assert.equal((session.variants[0].deck.slides[2].design!.elements[0] as any).text, 'まとめ');
  } finally {
    await f.dispose();
  }
});

test('when the browser that reads HTML cannot start, the same pages are asked again in coordinates, and later changes too', async () => {
  const f = await fixture(
    (id, title, _request, system) => (asksHtml(system) ? htmlPage(id, title) : designedPage(id, title)),
    async () => {
      throw new Error('HTML方式の変換に使うMicrosoft Edgeを起動できませんでした。');
    },
  );
  try {
    const session = await f.engine.create({ prompt: '3枚', cloudConsent: true }, []);
    await f.engine.generate(session.id);
    assert.equal(session.phase, 'ready', JSON.stringify(session.recovery));
    assert.equal(f.asked.length, 3, 'two pages in HTML, the same two in coordinates, the last page');
    assert.ok(asksHtml(f.asked[0].system));
    assert.ok(!asksHtml(f.asked[1].system), 'asked again in coordinates');
    assert.equal(f.layouts(), 1, 'the browser is not tried again in this session');
    assert.ok(
      session.warnings.includes(
        'HTML方式の変換に使うMicrosoft Edgeを起動できませんでした。この資料は座標の方式で作成しました。',
      ),
    );
    await f.engine.revise(session.id, { slideId: 'slide-2', instruction: '題名を直す' });
    assert.match(f.asked[3].system, /JSONのSlideSpec（designを含む）だけを返します/);
    assert.equal((session.variants[0].deck.slides[1].design!.elements[0] as any).text, '直した本文');
    assert.equal(f.layouts(), 1);
  } finally {
    await f.dispose();
  }
});

test('a quote whose numbers are not in the cited line is asked for once more, then that citation is left out', async () => {
  const document = await parseDocument('facts.txt', Buffer.from('売上は12億円でした。\n利益は3億円でした。\n'));
  const cited = (quote: string) => [
    { documentId: document.id, locator: '行 1', quote },
    { documentId: document.id, locator: '行 2' },
  ];
  const f = await fixture((id, title) =>
    htmlPage(id, title, '', id === 'slide-2' ? cited('売上は99億円でした。') : []),
  );
  try {
    const session = await f.engine.create({ prompt: '3枚', cloudConsent: true }, [document]);
    await f.engine.generate(session.id);
    assert.equal(session.phase, 'ready', JSON.stringify(session.recovery));
    assert.equal(f.asked.length, 3);
    assert.match(f.asked[1].request.repair.detail, /引用が原資料と一致しません。quoteは資料の原文をそのまま短く使うか/);
    assert.deepEqual(
      session.variants[0].deck.slides[1].sources.map(s => s.locator),
      ['行 2'],
    );
    assert.ok(session.warnings.some(w => /引用の数値が資料のその位置にないものを外しました/.test(w)));
  } finally {
    await f.dispose();
  }
});
