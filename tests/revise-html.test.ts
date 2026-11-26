import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Outline } from '../core/shared/contracts.js';
import { SessionEngine } from '../core/engine.js';
import { SettingsStore } from '../core/settings.js';
import { parseDocument } from '../core/documents.js';
import { emptyUsage, type CompletionRequest } from '../core/providers.js';
import type { HtmlLayout } from '../server/html-layout.js';

const usage = { ...emptyUsage(), calls: 1 };
const outline = {
  title: '修正の試験',
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
    { id: 'slide-2', title: '本文', intent: '本文', layoutId: 'free', keyPoints: [] },
  ],
} as unknown as Outline;

/** Stands in for the browser: the title becomes a text part; text marked FOOTER is reported in the footer. */
const fakeLayout: HtmlLayout = async pages =>
  pages.map(p => ({
    background: 'bg',
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
        ...(p.html.includes('data-ref') ? { refs: [1, 2] } : {}),
      },
    ],
    problems: p.html.includes('FOOTER') ? ['文字が下端の出典欄に入っています。'] : [],
  }));

/** An engine whose AI answers with what `revised` and `sources` say for the call at hand. */
async function fixture(options: {
  designMode?: 'free';
  autoRepair?: boolean;
  revised?: (call: number) => object;
  sources?: (call: number) => object[];
}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'de-revise-'));
  const settings = await new SettingsStore(dir).load();
  await settings.update({
    provider: 'subscription',
    subscriptionService: 'claude',
    slideCount: 2,
    visualReview: false,
    ...(options.designMode ? { designMode: options.designMode } : {}),
    ...(options.autoRepair === false ? { autoRepair: false } : {}),
  });
  const seen: { system: string; request: any }[] = [];
  let revisions = 0,
    generations = 0;
  const engine = new SessionEngine({
    settings,
    dataDir: dir,
    htmlLayout: fakeLayout,
    subscriptionBinding: () => 'account',
    render: async () => ({ artifactId: 'x', pptxUrl: 'x', thumbnails: [], warnings: [], native: false }),
    providerFactory: () => ({
      complete: async (r: CompletionRequest) => {
        const request = JSON.parse(r.content).request;
        seen.push({ system: r.system, request });
        if (request.targetSlide) return { text: JSON.stringify(options.revised!(++revisions)), usage };
        if (!request.targetSlides) return { text: JSON.stringify({ kind: 'outline', outline }), usage };
        const sources = options.sources?.(++generations) ?? [];
        const slides = request.targetSlides.map((s: any) => ({
          id: s.id,
          title: s.title,
          layoutId: s.layoutId,
          notes: '話す内容',
          sources: s.id === 'slide-2' ? sources : [],
          ...(options.designMode
            ? {
                design: {
                  elements: [
                    {
                      t: 'text',
                      x: 56,
                      y: 30,
                      w: 600,
                      h: 44,
                      text: s.title,
                      size: 30,
                      ...(s.id === 'slide-1' ? {} : { role: 'title' }),
                    },
                  ],
                },
              }
            : { html: `<section class="slide"><h1${sources.length > 1 ? ' data-ref' : ''}>${s.title}</h1></section>` }),
        }));
        return { text: JSON.stringify({ mode: 'presentation', id: 'd', title: outline.title, slides }), usage };
      },
    }),
  });
  return { engine, seen, dispose: () => rm(dir, { recursive: true, force: true }) };
}

test('a page of a deck written as HTML is changed as HTML: the browser reads the new page, and a problem it finds is sent back', async () => {
  const f = await fixture({
    revised: call => ({
      id: 'slide-2',
      title: '直した本文',
      layoutId: 'free',
      notes: '話す内容',
      sources: [],
      html: `<section class="slide"><h1>直した本文</h1>${call === 1 ? '<p>FOOTER</p>' : ''}</section>`,
    }),
  });
  try {
    const session = await f.engine.create({ prompt: '2枚', cloudConsent: true }, []);
    await f.engine.generate(session.id);
    assert.equal(session.phase, 'ready', JSON.stringify(session.recovery));
    await f.engine.revise(session.id, { slideId: 'slide-2', instruction: '題名を直す' });
    const [first, second] = f.seen.filter(s => s.request.targetSlide);
    assert.match(first.system, /修正後のページをHTMLで書きます/);
    assert.match(first.system, /今のページの部品の読み方/, 'the page arrives as parts, so their fields are explained');
    assert.doesNotMatch(first.system, /JSONのSlideSpec（designを含む）だけを返します/);
    assert.equal(first.request.targetSlide.design.elements[0].text, '本文', 'the page as it is now');
    assert.match(second.request.repair.detail, /文字が下端の出典欄/);
    const slide = session.variants[0].deck.slides[1];
    assert.equal((slide.design!.elements[0] as any).text, '直した本文');
    assert.equal(slide.title, '直した本文');
    assert.ok(
      session.messages.some(m => /配置と文字/.test(m.text)),
      'a change of the page itself is named',
    );
    assert.equal(session.recovery, undefined);
  } finally {
    await f.dispose();
  }
});

test('a page of a deck written as coordinates is still changed as coordinates', async () => {
  const f = await fixture({
    designMode: 'free',
    revised: () => ({
      id: 'slide-2',
      title: '直した本文',
      layoutId: 'free',
      notes: '話す内容',
      sources: [],
      design: { elements: [{ t: 'text', x: 56, y: 30, w: 600, h: 44, text: '直した本文', size: 30, role: 'title' }] },
    }),
  });
  try {
    const session = await f.engine.create({ prompt: '2枚', cloudConsent: true }, []);
    await f.engine.generate(session.id);
    assert.equal(session.phase, 'ready', JSON.stringify(session.recovery));
    await f.engine.revise(session.id, { slideId: 'slide-2', instruction: '題名を直す' });
    const revise = f.seen.find(s => s.request.targetSlide)!;
    assert.match(revise.system, /JSONのSlideSpec（designを含む）だけを返します/);
    assert.doesNotMatch(revise.system, /修正後のページをHTMLで書きます/);
    assert.equal((session.variants[0].deck.slides[1].design!.elements[0] as any).text, '直した本文');
  } finally {
    await f.dispose();
  }
});

test('a citation the documents do not hold is asked for once more (an empty line with the lines around it), then left out with a notice', async () => {
  const document = await parseDocument('facts.txt', Buffer.from('一行目の事実。\n\n三行目の事実。\n'));
  const at = (locator: string) => ({ documentId: document.id, locator });
  // The AI names the empty line twice: asked again once, then the deck is finished without that citation.
  const slip = await fixture({ sources: () => [at('行 2'), at('行 3')] });
  try {
    const session = await slip.engine.create({ prompt: '2枚', cloudConsent: true }, [document]);
    await slip.engine.generate(session.id);
    assert.equal(session.phase, 'ready', JSON.stringify(session.recovery));
    const asked = slip.seen.filter(s => s.request.targetSlides);
    assert.equal(asked.length, 2, 'one retry, not a stop');
    assert.match(
      asked[1].request.repair.detail,
      /行 2は資料にない位置です（空行など）。近くにある位置は行 1と行 3です。/,
    );
    const slide = session.variants[0].deck.slides[1];
    assert.deepEqual(
      slide.sources.map(s => s.locator),
      ['行 3'],
    );
    assert.deepEqual(
      (slide.design!.elements[0] as any).refs,
      [1],
      'the mark of the citation left out goes, the other moves up',
    );
    assert.ok(session.warnings.some(w => /空行などを指していた1件（行 2）を外しました/.test(w)));
  } finally {
    await slip.dispose();
  }
  // Asked again, the AI names a line that exists: nothing is left out.
  const fixed = await fixture({ sources: call => [at(call === 1 ? '行 2' : '行 1')] });
  try {
    const session = await fixed.engine.create({ prompt: '2枚', cloudConsent: true }, [document]);
    await fixed.engine.generate(session.id);
    assert.deepEqual(
      session.variants[0].deck.slides[1].sources.map(s => s.locator),
      ['行 1'],
    );
    assert.ok(!session.warnings.some(w => /外しました/.test(w)));
  } finally {
    await fixed.dispose();
  }
  // A line past the end of the document is asked for again without lines around it, then left out.
  const invented = await fixture({ sources: () => [at('行 9'), at('行 3')] });
  try {
    const session = await invented.engine.create({ prompt: '2枚', cloudConsent: true }, [document]);
    await invented.engine.generate(session.id);
    assert.equal(session.phase, 'ready', JSON.stringify(session.recovery));
    const asked = invented.seen.filter(s => s.request.targetSlides);
    assert.equal(asked.length, 2);
    assert.match(
      asked[1].request.repair.detail,
      /出典位置が資料に存在しません。documentsにあるunitのdocumentIdとlocatorを、そのままの文字で使ってください。/,
    );
    assert.deepEqual(
      session.variants[0].deck.slides[1].sources.map(s => s.locator),
      ['行 3'],
    );
    assert.ok(session.warnings.some(w => /資料にない位置を指していたものを外しました/.test(w)));
  } finally {
    await invented.dispose();
  }
  // With automatic repair turned off, the user decides: such a citation is refused as before.
  const refused = await fixture({ autoRepair: false, sources: () => [at('行 9')] });
  try {
    const session = await refused.engine.create({ prompt: '2枚', cloudConsent: true }, [document]);
    await assert.rejects(refused.engine.generate(session.id), /出典位置が資料に存在しません。/);
    assert.equal(session.variants.length, 0);
  } finally {
    await refused.dispose();
  }
});
