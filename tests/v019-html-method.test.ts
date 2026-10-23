import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Outline, TextElement } from '../shared/contracts.js';
import { SessionEngine } from '../server/engine.js';
import { SettingsStore } from '../server/settings.js';
import { emptyUsage, type CompletionRequest } from '../server/providers.js';
import { findBrowser, layoutHtmlSlides, type HtmlLayout } from '../server/html-layout.js';
import { freeSystemPrompt } from '../server/free-prompts.js';
import { paletteTheme } from '../shared/ai-theme.js';
import { compileDeck } from '../shared/layouts.js';
import { validateSlide } from '../server/validation.js';

const usage = { ...emptyUsage(), calls: 1 };
const palette = {
  name: '紺と金',
  background: '#F8F6F0',
  text: '#1F2A44',
  muted: '#6B7280',
  accent: '#C8902E',
  accent2: '#2F6F8F',
  headingFont: 'Yu Gothic UI',
  bodyFont: 'Yu Gothic',
};
const outline: Outline = {
  title: 'HTMLの試験',
  mode: 'presentation',
  assumptions: [],
  palette,
  slides: [
    { id: 'slide-1', title: '表紙', intent: '表紙', layoutId: 'cover', keyPoints: [] },
    { id: 'slide-2', title: '本文', intent: '本文', layoutId: 'free', keyPoints: [] },
  ],
} as Outline;
const page = (id: string, title: string, extra = '') => ({
  id,
  title,
  layoutId: id === 'slide-1' ? 'cover' : 'free',
  notes: '話す内容',
  sources: [],
  html: `<section class="slide"><h1>${title}</h1>${extra}</section>`,
});

/** Stands in for the browser: the title becomes exact text; text marked FOOTER is reported in the footer. */
const fakeLayout: HtmlLayout = async pages =>
  pages.map(p => {
    const title = /<h1>(.*?)<\/h1>/.exec(p.html)?.[1] ?? '';
    return {
      background: 'bg',
      elements: [
        { t: 'box', x: 40, y: 20, w: 880, h: 80, shape: 'roundRect', fill: 'surface', r: 0.1 },
        {
          t: 'text',
          x: 56,
          y: 30,
          w: 600,
          h: 44,
          text: title,
          size: 30,
          color: 'ink',
          bold: true,
          exact: true,
          role: p.id === 'slide-1' ? 'body' : 'title',
          runs: [{ s: 0, l: 1, color: 'accent' }],
        },
      ],
      problems: p.html.includes('FOOTER')
        ? ['文字が下端の出典欄（下から44px、y=496以降）に入っています。下から44pxには文字を置かないでください。']
        : [],
    };
  });

async function fixture(provider: 'subscription' | 'local') {
  const dir = await mkdtemp(path.join(tmpdir(), 'de-html-'));
  const settings = await new SettingsStore(dir, '').load();
  await settings.update({
    provider,
    ...(provider === 'subscription' ? { subscriptionService: 'claude' as const } : { model: 'mock' }),
    slideCount: 2,
    mode: 'presentation',
    designMode: 'html',
  });
  const systems: string[] = [],
    repairs: any[] = [];
  let pages = 0;
  const engine = new SessionEngine({
    settings,
    dataDir: dir,
    htmlLayout: fakeLayout,
    subscriptionBinding: () => 'account',
    render: async () => ({ artifactId: 'x', pptxUrl: 'x', thumbnails: [], warnings: [], native: false }),
    providerFactory: () => ({
      complete: async (r: CompletionRequest) => {
        const req = JSON.parse(r.content).request;
        systems.push(r.system);
        if (!req.targetSlides) return { text: JSON.stringify({ kind: 'outline', outline }), usage };
        repairs.push(req.repair);
        pages++;
        const slides = req.targetSlides.map((s: any) =>
          page(s.id, s.title, s.id === 'slide-2' && pages === 1 ? '<p>FOOTER</p>' : ''),
        );
        return { text: JSON.stringify({ mode: 'presentation', id: 'd', title: outline.title, slides }), usage };
      },
    }),
  });
  return { engine, systems, repairs, dispose: () => rm(dir, { recursive: true, force: true }) };
}

test('HTML method: pages written as HTML become the deck; a page with text in the footer is asked again with the finding', async () => {
  const f = await fixture('subscription');
  try {
    const session = await f.engine.create({ prompt: '2枚', cloudConsent: true }, []);
    await f.engine.generate(session.id);
    assert.equal(session.phase, 'ready', JSON.stringify(session.recovery));
    const generate = f.systems[1];
    assert.match(generate, /<section class="slide">/);
    assert.match(generate, /var\(--accent\)=?|--accent=#/);
    assert.doesNotMatch(generate, /Element = Text\|Box|"t":"icon"/);
    assert.match(f.repairs[1].detail, /^slide-2：文字が下端の出典欄/);
    const slide = session.variants[0].deck.slides[1],
      title = slide.design!.elements[1] as any;
    assert.equal(title.exact, true);
    assert.equal(title.text, '本文');
    assert.deepEqual(title.runs, [{ s: 0, l: 1, color: 'accent' }]);
    const scene = compileDeck(session.variants[0].deck).slides[1],
      text = scene.elements.find((e): e is TextElement => e.kind === 'text' && e.text === '本文')!;
    assert.equal(text.font, 'Yu Gothic UI', 'the title uses the heading font the browser used');
    assert.equal(text.runs![0].color, '#B48229');
    assert.equal(session.usage.calls, 3, 'one plan, one generation, one retry');
  } finally {
    await f.dispose();
  }
});

test('HTML method falls back to the JSON method where it is not available (local LLM), with a notice', async () => {
  const f = await fixture('local');
  try {
    const session = await f.engine.create({ prompt: '2枚' }, []);
    await f.engine.generate(session.id).catch(() => undefined);
    assert.doesNotMatch(f.systems[1] ?? '', /<section class="slide">/);
    assert.ok(session.warnings.some(w => w.startsWith('HTML方式')));
  } finally {
    await f.dispose();
  }
});

test('the HTML instructions carry no design preference either', () => {
  const prompt = freeSystemPrompt('generate', { format: 'html', theme: paletteTheme(palette) });
  assert.match(prompt, /デザイン（構図・図形・色・文字の大きさ・配置）はすべてあなたに任せます/);
  assert.doesNotMatch(prompt, /テーマ候補|書体候補|項目名が長い場合にも向く/);
  // The app's icons are parts the AI may use, like charts; which to use and where is still the AI's choice.
  assert.match(prompt, /<i data-icon="ID"[^>]*><\/i>で、アプリのアイコン（IDは一覧）を置けます/);
  assert.match(prompt, /"family":"家族・世帯"/);
});

test(
  'a real browser reads the layout: title, a run in another colour, a chart, and text in the footer reported',
  { skip: !findBrowser() },
  async () => {
    const theme = paletteTheme(palette);
    const [result] = await layoutHtmlSlides(
      [
        {
          id: 'slide-2',
          html: `<section class="slide"><h1 style="position:absolute;left:56px;top:30px;margin:0;font-size:32px">ガウスの和</h1>
<p style="position:absolute;left:56px;top:120px;width:380px;margin:0;font-size:18px">順に足すのではなく、<strong style="color:var(--accent)">組にして</strong>考えます。</p>
<div data-chart='{"type":"column","categories":["A","B"],"series":[{"name":"s","values":[1,2]}]}' style="position:absolute;left:500px;top:120px;width:300px;height:200px"></div>
<script>document.body.innerHTML='x'</script><p style="position:absolute;left:56px;top:480px;margin:0">下端</p></section>`,
        },
      ],
      theme,
    );
    assert.ok(!('error' in result));
    if ('error' in result) return;
    const texts = result.elements.filter(e => e.t === 'text') as any[];
    assert.equal(texts[0].role, 'title');
    assert.equal(texts[0].text, 'ガウスの和');
    const body = texts.find(t => t.text.startsWith('順に'));
    assert.deepEqual(body.runs, [{ s: 10, l: 4, color: 'accent', bold: true }]);
    assert.ok(result.elements.some(e => e.t === 'chart'));
    assert.equal(result.background, 'bg');
    assert.ok(result.problems.some(p => p.includes('下端の出典欄')));
  },
);

test(
  'small corner radii survive (a 12px corner on a 324px card), and Japanese lines break between phrases',
  { skip: !findBrowser() },
  async () => {
    const [result] = await layoutHtmlSlides(
      [
        {
          id: 'slide-2',
          html: `<section class="slide"><h1>題名</h1><div style="position:absolute;left:50px;top:140px;width:410px;height:320px;border:2px solid var(--accent);border-radius:12px;background:var(--surface)"><p style="margin:20px;width:330px;font-size:18px">問いは分かるのに、まだ誰も答えを出せていない</p></div></section>`,
        },
      ],
      paletteTheme(palette),
    );
    if ('error' in result) assert.fail(result.error);
    const card = result.elements.find(e => e.t === 'box') as any;
    assert.ok(card.r > 0.03 && card.r < 0.05, String(card.r));
    const slide = validateSlide(
      { id: 'slide-2', title: '題名', layoutId: 'free', notes: '', sources: [], design: { elements: result.elements } },
      'slide-2',
    );
    assert.equal((slide.design!.elements.find(e => e.t === 'box') as any).r, card.r, 'validation keeps three decimals');
    assert.equal(
      (result.elements.find(e => e.t === 'text' && String(e.text).startsWith('問い')) as any).text,
      '問いは分かるのに、まだ誰も答えを\n出せていない',
    );
  },
);

test(
  "fonts are the AI's choice: the font the browser drew each text with is what PowerPoint uses",
  { skip: !findBrowser() },
  async () => {
    const [result] = await layoutHtmlSlides(
      [
        {
          id: 'slide-2',
          html: `<section class="slide"><h1 style="font-family:'BIZ UDPMincho'">題名</h1><p style="font-family:Meiryo;position:absolute;top:120px;left:50px">メイリオの本文</p><p style="font-family:'Segoe UI','Yu Gothic';position:absolute;top:200px;left:50px">Segoe UIと游ゴシック 45%</p></section>`,
        },
      ],
      paletteTheme(palette),
    );
    if ('error' in result) assert.fail(result.error);
    const texts = result.elements.filter(e => e.t === 'text') as any[];
    assert.match(texts[0].fontFarEast, /^BIZ UDPMincho/);
    assert.equal(texts[1].font, 'Meiryo');
    assert.equal(texts[2].font, 'Segoe UI');
    assert.equal(texts[2].fontFarEast, 'Yu Gothic');
  },
);

test('JSON method: a text may name its own font; Japanese names become the Windows names', () => {
  const deck = {
    id: 'd',
    title: 'x',
    mode: 'presentation',
    themeId: 'business',
    slides: [
      {
        id: 'slide-1',
        title: '表紙',
        layoutId: 'cover',
        items: [],
        notes: '',
        sources: [],
        design: { elements: [{ t: 'text', x: 64, y: 160, w: 832, h: 100, text: '表紙', size: 40, font: '游明朝' }] },
      },
      {
        id: 'slide-2',
        title: '本文',
        layoutId: 'free',
        items: [],
        notes: '',
        sources: [],
        design: {
          elements: [
            { t: 'text', x: 56, y: 28, w: 848, h: 52, text: '本文', size: 28, role: 'title', font: 'メイリオ' },
          ],
        },
      },
    ],
  } as any;
  const scene = compileDeck(deck);
  assert.equal((scene.slides[0].elements.find(e => e.kind === 'text') as TextElement).font, 'Yu Mincho');
  assert.equal(
    (scene.slides[1].elements.find(e => e.kind === 'text' && (e as TextElement).text === '本文') as TextElement).font,
    'Meiryo',
  );
});

test(
  'the browser reports text drawn over text, but not a number beside its unit, stacked lines, or a backdrop numeral',
  { skip: !findBrowser() },
  async () => {
    const read = async (body: string) => {
      const [r] = await layoutHtmlSlides(
        [
          {
            id: 'slide-2',
            html: `<section class="slide"><h1 style="position:absolute;left:56px;top:20px;margin:0;font-size:28px">題名</h1>${body}</section>`,
          },
        ],
        paletteTheme(palette),
      );
      if ('error' in r) assert.fail(r.error);
      return r;
    };
    const over = await read(
      `<p style="position:absolute;left:56px;top:300px;margin:0;font-size:18px">顧客満足度 4.3</p><p style="position:absolute;left:56px;top:304px;margin:0;font-size:13px">顧客満足度の尺度は資料に記載がない</p>`,
    );
    assert.ok(
      over.problems.some(p => p.includes('文字どうしが重なっています')),
      JSON.stringify(over.problems),
    );
    const fine = await read(
      `<div style="position:absolute;left:56px;top:120px"><div><span style="font-size:48px;font-weight:700">11.8</span><span style="font-size:20px">%</span></div><div style="font-size:32px;font-weight:700;line-height:1">1,284<span style="font-size:16px">億円</span></div><div style="font-size:14px;line-height:1.2">前年同期比 +6.4%</div></div><div style="position:absolute;left:400px;top:120px;font-size:160px;color:var(--surface)">01</div><p style="position:absolute;left:420px;top:200px;margin:0;font-size:18px">前面の説明</p>`,
    );
    assert.ok(!fine.problems.some(p => p.includes('重なって')), JSON.stringify(fine.problems));
  },
);

test(
  'a number whose line box reaches the footer but whose characters do not is accepted',
  { skip: !findBrowser() },
  async () => {
    const [r] = await layoutHtmlSlides(
      [
        {
          id: 'slide-2',
          html: `<section class="slide"><h1 style="position:absolute;left:56px;top:20px;margin:0;font-size:28px">題名</h1><div style="position:absolute;left:560px;top:452px;font-size:32px;font-weight:700">2,310<span style="font-size:16px">億円</span></div></section>`,
        },
      ],
      paletteTheme(palette),
    );
    if ('error' in r) assert.fail(r.error);
    assert.ok(!r.problems.some(p => p.includes('下端の出典欄')), JSON.stringify(r.problems));
    assert.doesNotThrow(() =>
      validateSlide(
        { id: 'slide-2', title: '題名', layoutId: 'free', notes: '', sources: [], design: { elements: r.elements } },
        'slide-2',
      ),
    );
  },
);
