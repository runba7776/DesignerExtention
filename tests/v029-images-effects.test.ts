import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DeckSpec, FreeElement, ImageElement, Outline, ShapeElement, TextElement } from '../shared/contracts.js';
import { SessionEngine } from '../server/engine.js';
import { SettingsStore } from '../server/settings.js';
import { emptyUsage, type CompletionRequest } from '../server/providers.js';
import { findBrowser, layoutHtmlSlides, type HtmlLayout } from '../server/html-layout.js';
import { createImageStore, type ImageStore } from '../server/images.js';
import { freeSystemPrompt, designOnlyPrompt } from '../server/free-prompts.js';
import { EDITORIAL_GUIDE, EDITORIAL_GUIDE_SHORT } from '../server/editorial-guide.js';
import { validateDesign } from '../server/validation.js';
import { compileDeck } from '../shared/layouts.js';
import { coverCrop } from '../shared/free-design.js';
import { paletteTheme } from '../shared/ai-theme.js';

const usage = { ...emptyUsage(), calls: 1 };
const title = { t: 'text', x: 56, y: 30, w: 600, h: 44, text: '題名', size: 30, role: 'title' } as const;

/** Wikimedia Commons as the store sees it: a search answer and the thumbnails. */
function commons(pages: Record<string, unknown>[]) {
  const calls: { url: string; agent: string | null }[] = [];
  const fetcher = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, agent: new Headers(init?.headers).get('User-Agent') });
    if (url.startsWith('https://commons.wikimedia.org/w/api.php'))
      return new Response(JSON.stringify({ query: { pages: Object.fromEntries(pages.map((p, i) => [i, p])) } }));
    return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/jpeg' } });
  }) as typeof fetch;
  return { fetcher, calls };
}
const result = (index: number, name: string, license: string, w: number, h: number, mime = 'image/jpeg') => ({
  index,
  title: `File:${name}`,
  imageinfo: [
    {
      thumburl: `https://upload.wikimedia.org/thumb/${name}`,
      thumbwidth: w,
      thumbheight: h,
      mime,
      descriptionurl: `https://commons.wikimedia.org/wiki/File:${name}`,
      extmetadata: {
        LicenseShortName: { value: license },
        Artist: { value: '<a href="//commons.wikimedia.org/wiki/User:Example">Example &amp; Co</a>' },
      },
    },
  ],
});

test('a photo place is filled from Wikimedia Commons with a freely licensed picture closest to its shape, credited, and kept for the next time', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'de-images-'));
  try {
    const { fetcher, calls } = commons([
      result(1, 'Solar rights.jpg', 'All rights reserved', 1280, 720),
      result(2, 'Solar moving.webp', 'CC BY 4.0', 1280, 720, 'image/webp'),
      result(3, 'Solar tall.jpg', 'CC0', 720, 1280),
      result(4, 'Solar wide.jpg', 'CC BY-SA 4.0', 1280, 720),
    ]);
    const store = createImageStore(dir, fetcher);
    const place = { t: 'image', x: 0, y: 0, w: 480, h: 270, q: 'solar panels rooftop' } as Record<string, unknown>;
    assert.equal(await store.place({ variants: [{ deck: { slides: [{ design: { elements: [place] } }] } }] }), 0);
    assert.match(String(place.src), /^[0-9a-f]{16}\.jpg$/);
    assert.deepEqual([place.iw, place.ih], [1280, 720], 'the wide one, not the tall one or the ones it may not use');
    assert.equal(place.credit, 'Example & Co, CC BY-SA 4.0');
    assert.equal(place.page, 'https://commons.wikimedia.org/wiki/File:Solar wide.jpg');
    assert.ok(existsSync(store.file(String(place.src))!));
    assert.ok(calls.every(c => /^DesignerExtention\/.*runba7776\.github\.io/.test(c.agent ?? '')));
    assert.ok(
      calls.every(c => !c.url.includes('@')),
      'nothing about the user is sent',
    );
    // The same words again (a revision sent the page back with a changed credit): no search, the stored credit.
    const again = { ...place, credit: 'AIが書き換えた' };
    const count = calls.length;
    assert.equal(await createImageStore(dir, fetcher).place([again]), 0);
    assert.equal(calls.length, count);
    assert.equal(again.credit, 'Example & Co, CC BY-SA 4.0');
    assert.equal(store.file('../index.json'), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  const offline = createImageStore(path.join(dir, 'x'), (async () => {
    throw new Error('offline');
  }) as typeof fetch);
  const place = { t: 'image', x: 0, y: 0, w: 200, h: 200, q: 'harbor', src: '0123456789abcdef.jpg' };
  assert.equal(await offline.place([place]), 1, 'left as a frame');
  assert.equal(place.src, undefined);
});

test('words that find nothing together are searched again without the last ones; a person, or a file named for none of the words, is passed over; an unknown author is named so', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'de-images-'));
  try {
    const person = result(1, 'Evacuation drill 2019.jpg', 'CC BY 2.0', 1280, 720),
      named = result(2, 'Professional woman working at desk.jpg', 'CC0', 1280, 720),
      listed = result(3, 'Drill at the commission.jpg', 'CC BY 2.0', 1280, 720),
      unknown = result(4, 'Evacuation route.jpg', 'Public domain', 1280, 720);
    Object.assign(person.imageinfo[0].extmetadata, { Restrictions: { value: 'personality' } });
    Object.assign(listed.imageinfo[0].extmetadata, {
      Categories: { value: 'Files uploaded by Example|People of the Nuclear Regulatory Commission' },
    });
    Object.assign(unknown.imageinfo[0].extmetadata, {
      ImageDescription: { value: '<p>Signs along a man-made route</p>' },
    });
    unknown.imageinfo[0].extmetadata.Artist.value =
      'Unknown author<span style="display: none;">Unknown author</span> or not provided';
    const searched: string[] = [];
    const { fetcher } = commons([person, named, listed, unknown]);
    const store = createImageStore(dir, (async (input: string | URL, init?: RequestInit) => {
      const words = new URL(String(input)).searchParams.get('gsrsearch');
      if (words === null) return fetcher(input, init);
      searched.push(words);
      return /^(evacuation drill|laptop desk) filetype/.test(words) ? fetcher(input, init) : new Response('{}');
    }) as typeof fetch);
    const place = { t: 'image', x: 0, y: 0, w: 480, h: 270, q: 'evacuation drill indoor outdoor' } as Record<
        string,
        unknown
      >,
      desk = { ...place, q: 'office worker laptop desk' };
    assert.equal(await store.place([place, desk]), 1);
    assert.deepEqual(searched, [
      'evacuation drill indoor outdoor filetype:bitmap|drawing',
      'evacuation drill indoor filetype:bitmap|drawing',
      'evacuation drill filetype:bitmap|drawing',
      'office worker laptop desk filetype:bitmap|drawing',
      'office worker laptop filetype:bitmap|drawing',
      'office worker filetype:bitmap|drawing',
      'laptop desk filetype:bitmap|drawing',
    ]);
    assert.equal(
      place.page,
      'https://commons.wikimedia.org/wiki/File:Evacuation route.jpg',
      'personality rights, a person in the categories: passed over',
    );
    assert.ok(!('src' in desk), 'the only file named for a laptop or a desk shows a person: left a frame');
    assert.equal(place.credit, '作者不明, Public domain');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a deck uses each picture once: the same words find the next one, a page keeps what it has, and nothing else found leaves a frame', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'de-images-'));
  try {
    const { fetcher, calls } = commons([
      result(1, 'Harbor morning.jpg', 'CC0', 1280, 720),
      result(2, 'Harbor evening.jpg', 'CC BY 2.0', 1280, 720),
    ]);
    const at = (q: string) => ({ t: 'image', x: 0, y: 0, w: 480, h: 270, q }) as Record<string, unknown>;
    const deck = (...places: unknown[]) => ({ slides: places.map(place => ({ design: { elements: [place] } })) });
    const page = (place: Record<string, unknown>) => String(place.page).split('File:')[1];
    const cover = at('harbor'),
      second = at('harbor'),
      sameFiles = at('harbor boats'),
      otherDeck = at('harbor'),
      earlierVersion = at('harbor');
    const session = { variants: [{ deck: deck(cover, second, sameFiles) }, { deck: deck(otherDeck) }], earlierVersion };
    assert.equal(await createImageStore(dir, fetcher).place(session), 1);
    assert.deepEqual([page(cover), page(second)], ['Harbor morning.jpg', 'Harbor evening.jpg']);
    assert.equal(second.credit, 'Example & Co, CC BY 2.0');
    assert.ok(!('src' in sameFiles), 'other words finding the same files: a frame, not a picture used twice');
    assert.equal(page(otherDeck), 'Harbor morning.jpg', 'another deck may use it');
    assert.equal(page(earlierVersion), 'Harbor morning.jpg', 'the earlier version of a page is not a page of the deck');
    // The next time (the store read from its file): the same pictures, without looking for another.
    const again = createImageStore(dir, fetcher),
      searches = () => calls.filter(c => c.url.includes('/w/api.php')).length,
      count = searches();
    assert.equal(await again.place(deck(cover, second)), 0);
    assert.deepEqual([page(cover), page(second)], ['Harbor morning.jpg', 'Harbor evening.jpg']);
    assert.equal(searches(), count);
    // A new page before them, with the same words: the pages keep theirs, and it has none left.
    const added = at('harbor');
    assert.equal(await again.place(deck(added, cover, second)), 1);
    assert.deepEqual([page(cover), page(second)], ['Harbor morning.jpg', 'Harbor evening.jpg']);
    assert.ok(!('src' in added));
    // The cover gone: the page that had the second picture keeps it, and the first is free again.
    const replaced = at('harbor');
    assert.equal(await again.place(deck(replaced, second)), 0);
    assert.deepEqual([page(replaced), page(second)], ['Harbor morning.jpg', 'Harbor evening.jpg']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a picture the look passed over is not used again by any deck, also after a restart; the next one takes its place', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'de-images-'));
  try {
    const { fetcher } = commons([
      result(1, 'Harbor morning.jpg', 'CC0', 1280, 720),
      result(2, 'Harbor evening.jpg', 'CC BY 2.0', 1280, 720),
    ]);
    const at = () => ({ t: 'image', x: 0, y: 0, w: 480, h: 270, q: 'harbor' }) as Record<string, unknown>;
    const page = (place: Record<string, unknown>) => String(place.page).split('File:')[1];
    const store = createImageStore(dir, fetcher),
      place = at();
    assert.equal(await store.place([place]), 0);
    assert.equal(page(place), 'Harbor morning.jpg');
    await store.passOver({ design: { elements: [place] } });
    assert.equal(await store.place([place]), 0);
    assert.equal(page(place), 'Harbor evening.jpg', 'the same page, written the same way, takes the next');
    const restarted = createImageStore(dir, fetcher),
      other = at();
    assert.equal(await restarted.place([other]), 0);
    assert.equal(page(other), 'Harbor evening.jpg');
    await restarted.passOver([other]);
    assert.equal(await restarted.place([other]), 1, 'nothing else found: a frame');
    assert.ok(!('src' in other));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a file from a criminal case is passed over, whatever else it shows; nothing else is taken for one', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'de-images-'));
  try {
    const byBureau = result(1, 'Harbor EFTA01.jpg', 'Public domain', 1280, 720),
      inCategory = result(2, 'Harbor island.jpg', 'CC0', 1280, 720),
      clean = result(3, 'Harbor view.jpg', 'CC BY 2.0', 1280, 720);
    byBureau.imageinfo[0].extmetadata.Artist.value = '<b>Federal Bureau of Investigation</b>';
    Object.assign(inCategory.imageinfo[0].extmetadata, { Categories: { value: '2019 FBI raid|Islands' } });
    Object.assign(clean.imageinfo[0].extmetadata, { ImageDescription: { value: 'The bureau of harbors, in spring' } });
    const place = { t: 'image', x: 0, y: 0, w: 480, h: 270, q: 'harbor' } as Record<string, unknown>;
    const { fetcher } = commons([byBureau, inCategory, clean]);
    assert.equal(await createImageStore(dir, fetcher).place([place]), 0);
    assert.equal(place.page, 'https://commons.wikimedia.org/wiki/File:Harbor view.jpg');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a big number keeps the size the browser placed it at, so that its unit stays beside it; a slip is still held', () => {
  const size = (n: number) =>
    (
      validateDesign({ elements: [title, { t: 'text', x: 60, y: 120, w: 198, h: 140, text: '4.8', size: n }] }, 0)
        .elements[1] as Extract<FreeElement, { t: 'text' }>
    ).size;
  assert.equal(size(130), 130);
  assert.equal(size(900), 300);
});

test('a found photo fills its box cut at the middle, keeps the colour of the text on it, and is credited in the footer and the notes; a place without one is a plain frame', () => {
  assert.deepEqual(coverCrop(1600, 900, 400, 400), [0.2188, 0, 0.2188, 0]);
  assert.deepEqual(coverCrop(900, 1600, 400, 200), [0, 0.3594, 0, 0.3594]);
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
  const photo = {
    t: 'image',
    x: 0,
    y: 0,
    w: 400,
    h: 400,
    q: 'harbor',
    src: '0123456789abcdef.jpg',
    iw: 1600,
    ih: 900,
    credit: 'Example, CC BY-SA 4.0',
    page: 'https://commons.wikimedia.org/wiki/File:Harbor.jpg',
  } as const;
  const scene = compileDeck(deck([photo, { ...title, color: '#FFFFFF', x: 40, y: 300, w: 300, text: '港の朝' }, title]))
    .slides[1];
  const image = scene.elements.find((e): e is ImageElement => e.kind === 'image')!;
  assert.deepEqual([image.src, image.crop], ['0123456789abcdef.jpg', [0.2188, 0, 0.2188, 0]]);
  const on = scene.elements.find((e): e is TextElement => e.kind === 'text' && e.text.startsWith('港の朝'))!;
  assert.equal(on.color, '#FFFFFF', 'white text on a photo is not turned dark for the white page under it');
  assert.ok(scene.elements.some(e => e.kind === 'text' && e.text === '画像 Example, CC BY-SA 4.0'));
  assert.match(
    scene.notes,
    /画像（Wikimedia Commons）:\nExample, CC BY-SA 4\.0 https:\/\/commons\.wikimedia\.org\/wiki\/File:Harbor\.jpg/,
  );
  const frame = compileDeck(deck([{ t: 'image', x: 0, y: 0, w: 400, h: 300, q: 'harbor' }, title])).slides[1];
  assert.ok(!frame.elements.some(e => e.kind === 'image'));
  assert.ok(frame.elements.filter(e => e.kind === 'shape').length >= 2, 'a frame with a picture mark');
});

test('photos, shadows, gradients and letter spacing are checked like the other parts', () => {
  const design = validateDesign(
    {
      elements: [
        {
          t: 'box',
          x: 0,
          y: 0,
          w: 300,
          h: 200,
          fill: 'accent',
          shadow: { x: 0, y: 4, blur: 12, op: 0.2 },
          grad: {
            angle: 90,
            stops: [
              { color: 'accent', at: 0 },
              { color: '#000000', at: 1, op: 0.5 },
            ],
          },
        },
        // A photo bleeding off the slide is cut at the edge; an id that is not the store's is dropped.
        { t: 'image', x: 600, y: -40, w: 400, h: 300, q: 'harbor', alt: '港', src: '../../secret.jpg', credit: 'x' },
        { ...title, exact: true, sp: 2 },
        { t: 'text', x: 56, y: 200, w: 300, h: 40, text: '本文', size: 18, sp: 2 },
      ],
    },
    0,
  );
  const [box, image, exact, plain] = design.elements as any[];
  assert.deepEqual(box.shadow, { x: 0, y: 4, blur: 12, color: '#000000', op: 0.2 });
  assert.equal(box.grad.stops[1].op, 0.5);
  assert.deepEqual(
    [image.x, image.y, image.w, image.h, image.src, image.credit],
    [600, 0, 360, 260, undefined, undefined],
  );
  assert.equal(exact.sp, 2);
  assert.equal(plain.sp, undefined, 'only text measured by the browser keeps its spacing');
  assert.throws(
    () =>
      validateDesign(
        { elements: [{ ...title }, { t: 'box', x: 0, y: 0, w: 9, h: 9, grad: { stops: [{ color: 'ink', at: 0 }] } }] },
        0,
      ),
    /グラデーションは2〜4色/,
  );
  assert.throws(
    () => validateDesign({ elements: [title, { t: 'image', x: 0, y: 0, w: 300, h: 200 }] }, 0),
    /画像の検索語/,
  );
});

test('the instructions ask for one visual that carries each page, offer photos only where the app finds them, and no longer drop shadows, gradients or letter spacing', () => {
  const html = freeSystemPrompt('generate', { format: 'html', editorial: true, images: true }),
    plain = freeSystemPrompt('generate', { format: 'html', editorial: true }),
    json = freeSystemPrompt('generate', { format: 'json', images: true });
  assert.match(html, /<div data-image="英語の検索語"[^\n]*Wikimedia Commons/);
  assert.match(json, /\{"t":"image"[^\n]*"q":"英語の検索語"/);
  assert.match(json, /shadow\?:\{x:number/);
  assert.doesNotMatch(plain, /data-image|Wikimedia/);
  // Photos are offered without a hedge, from the outline on; bars drawn with divs are not charts.
  assert.match(html, /資料全体で2〜4枚を目安に使います/);
  assert.match(freeSystemPrompt('plan', { images: true }), /何の写真を置くかもintentに書きます/);
  assert.doesNotMatch(freeSystemPrompt('plan', {}), /何の写真/);
  assert.match(html, /グラフはdivやSVGで描かず、data-chartで置きます/);
  assert.match(html, /box-shadow（外側の影1つ）、linear-gradient（直線のグラデーション4色まで）、letter-spacing/);
  assert.doesNotMatch(html, /表示しないもの：[^\n]*(box-shadow|letter-spacing)|。グラデーションは最初の色/);
  assert.match(
    EDITORIAL_GUIDE,
    /文字だけのページにしません。各ページに、そのページの結論を目で伝える主役の視覚要素を1つ置きます/,
  );
  assert.match(EDITORIAL_GUIDE_SHORT, /文字だけのページにせず/);
  const local = freeSystemPrompt('generate', { format: 'html', local: true });
  assert.match(local, /各ページに結論を目で伝える主役を1つ置きます/);
  assert.doesNotMatch(local, /影・二重の枠/);
  assert.match(designOnlyPrompt('structure'), /"shadow":\{"x"/);
});

/** A page with one photo place, read back as it would be from the browser. */
const photoLayout: HtmlLayout = async pages =>
  pages.map(p => ({
    elements: [
      ...(p.id === 'slide-2' ? [{ t: 'image', x: 500, y: 100, w: 400, h: 300, q: 'harbor at dawn', alt: '港' }] : []),
      { ...title, exact: true, role: p.id === 'slide-1' ? 'body' : 'title' },
    ],
    problems: [],
  }));
const outline: Outline = {
  title: '写真の試験',
  mode: 'presentation',
  assumptions: [],
  slides: [
    { id: 'slide-1', title: '表紙', intent: '表紙', layoutId: 'cover', keyPoints: [] },
    { id: 'slide-2', title: '題名', intent: '本文', layoutId: 'free', keyPoints: [] },
  ],
} as Outline;

async function fixture(provider: 'subscription' | 'local', patch: Record<string, unknown> = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'de-photo-'));
  const settings = await new SettingsStore(dir, '').load();
  await settings.update({
    provider,
    ...(provider === 'subscription' ? { subscriptionService: 'claude' as const } : { model: 'mock' }),
    slideCount: 2,
    mode: 'presentation',
    ...patch,
  });
  const systems: string[] = [],
    asked: string[] = [];
  const images: ImageStore = {
    file: () => undefined,
    passOver: async () => {},
    async place(value) {
      const places: any[] = [];
      const walk = (v: any) =>
        Array.isArray(v)
          ? v.forEach(walk)
          : v && typeof v === 'object' && (v.t === 'image' ? places.push(v) : Object.values(v).forEach(walk));
      walk(value);
      for (const p of places) {
        asked.push(p.q);
        Object.assign(p, { src: '0123456789abcdef.jpg', iw: 1280, ih: 720, credit: 'Example, CC0' });
      }
      return 0;
    },
  };
  const engine = new SessionEngine({
    settings,
    dataDir: dir,
    htmlLayout: photoLayout,
    images,
    subscriptionBinding: () => 'account',
    render: async () => ({ artifactId: 'x', pptxUrl: 'x', thumbnails: [], warnings: [], native: false }),
    providerFactory: () => ({
      complete: async (r: CompletionRequest) => {
        const req = JSON.parse(r.content).request;
        systems.push(r.system);
        if (!req.targetSlides) return { text: JSON.stringify({ kind: 'outline', outline }), usage };
        const slides = req.targetSlides.map((s: any) => ({
          id: s.id,
          title: s.title,
          layoutId: s.id === 'slide-1' ? 'cover' : 'free',
          notes: '話す内容',
          sources: [],
          html: `<section class="slide"><h1>${s.title}</h1></section>`,
        }));
        return { text: JSON.stringify({ mode: 'presentation', id: 'd', title: outline.title, slides }), usage };
      },
    }),
  });
  return { engine, systems, asked, dispose: () => rm(dir, { recursive: true, force: true }) };
}

test('a cloud AI that receives the content is offered photos and its places are filled before the deck is shown; a local model and the setting turned off are not', async () => {
  const f = await fixture('subscription');
  try {
    const session = await f.engine.create({ prompt: '2枚', cloudConsent: true }, []);
    await f.engine.generate(session.id);
    assert.equal(session.phase, 'ready', JSON.stringify(session.recovery));
    assert.match(f.systems[1], /data-image/);
    assert.deepEqual(f.asked, ['harbor at dawn']);
    const photo = session.variants[0].deck.slides[1].design!.elements[0] as Extract<FreeElement, { t: 'image' }>;
    assert.equal(photo.src, '0123456789abcdef.jpg');
  } finally {
    await f.dispose();
  }
  for (const [provider, patch] of [
    ['local', {}],
    ['subscription', { imageSearch: false }],
  ] as const) {
    const g = await fixture(provider, patch);
    try {
      const session = await g.engine.create({ prompt: '2枚', cloudConsent: true }, []);
      await g.engine.generate(session.id);
      assert.doesNotMatch(g.systems[1], /data-image/, provider);
      assert.deepEqual(g.asked, [], 'the search words never leave this PC');
    } finally {
      await g.dispose();
    }
  }
});

test(
  'the browser reading keeps a shadow, a straight gradient, letter spacing and a photo place, and the review picture marks the place',
  { skip: !findBrowser() },
  async () => {
    const theme = paletteTheme({
      name: 't',
      background: '#FFFFFF',
      text: '#1F2A44',
      muted: '#6B7280',
      accent: '#C8902E',
      accent2: '#2F6F8F',
    });
    const [page] = await layoutHtmlSlides(
      [
        {
          id: 'slide-2',
          html: `<section class="slide"><h1 style="position:absolute;left:56px;top:30px;margin:0;font-size:30px;letter-spacing:2px">見出し</h1>
<div style="position:absolute;left:56px;top:120px;width:300px;height:200px;background:linear-gradient(90deg,#112233,rgba(68,85,102,.5));box-shadow:0 4px 12px rgba(0,0,0,.2)"></div>
<div data-image="harbor at dawn" data-alt="港の朝" style="position:absolute;left:500px;top:100px;width:400px;height:300px"><p>無視される</p></div></section>`,
        },
      ],
      theme,
      { screenshot: true },
    );
    assert.ok(!('error' in page), JSON.stringify(page));
    if ('error' in page) return;
    assert.deepEqual(page.problems, []);
    const box = page.elements.find(e => e.t === 'box') as any,
      text = page.elements.find(e => e.t === 'text') as any,
      image = page.elements.find(e => e.t === 'image') as any;
    assert.deepEqual(box.shadow, { x: 0, y: 4, blur: 12, color: '#000000', op: 0.2 });
    assert.deepEqual(box.grad, {
      angle: 90,
      stops: [
        { color: '#112233', at: 0 },
        { color: '#445566', at: 1, op: 0.5 },
      ],
    });
    assert.equal(text.sp, 2);
    assert.deepEqual(
      [image.x, image.y, image.w, image.h, image.q, image.alt],
      [500, 100, 400, 300, 'harbor at dawn', '港の朝'],
    );
    assert.ok(!page.elements.some(e => e.t === 'text' && String(e.text).includes('無視')));
    assert.ok(page.shot);
    const design = validateDesign({ elements: page.elements }, 0);
    const scene = compileDeck({
      id: 'd',
      title: 'd',
      mode: 'presentation',
      themeId: 'paper',
      slides: [
        { id: 'slide-1', title: '表紙', layoutId: 'cover', items: [], notes: '', sources: [] },
        { id: 'slide-2', title: '見出し', layoutId: 'free', items: [], notes: '', sources: [], design },
      ],
    }).slides[1];
    const shape = scene.elements.find((e): e is ShapeElement => e.kind === 'shape' && !!e.gradient)!;
    assert.equal(shape.shadow!.opacity, 0.2);
    assert.equal(scene.elements.find((e): e is TextElement => e.kind === 'text' && e.text === '見出し')!.spacing, 2);
  },
);
