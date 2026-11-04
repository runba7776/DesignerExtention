import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Outline, Settings } from '../shared/contracts.js';
import { SessionEngine } from '../server/engine.js';
import { SettingsStore } from '../server/settings.js';
import { emptyUsage, type CompletionRequest } from '../server/providers.js';
import {
  ClaudeSubscription,
  type ClaudeRun,
  type ClaudeRunResult,
  type ClaudeRunner,
} from '../server/claude-subscription.js';
import { findBrowser, layoutHtmlSlides, type HtmlLayout, type HtmlLayoutOptions } from '../server/html-layout.js';
import { validateReview } from '../server/validation.js';
import { reviewPrompt } from '../server/free-prompts.js';
import type { ImageStore } from '../server/images.js';
import { paletteTheme } from '../shared/ai-theme.js';

const help =
  '--safe-mode --setting-sources --tools --disallowedTools --no-session-persistence --permission-prompts --output-format --model --strict-mcp-config --mcp-config --input-format';
const auth = {
  loggedIn: true,
  authMethod: 'claude.ai',
  apiProvider: 'firstParty',
  subscriptionType: 'pro',
  email: 'student@example.test',
  orgId: 'personal',
};

test('Claude takes pictures through the stream-json input with the same isolation, and reads the result event', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'de-review-claude-')),
    calls: ClaudeRun[] = [];
  const runner: ClaudeRunner = async (run): Promise<ClaudeRunResult> => {
    calls.push(run);
    if (run.args.includes('--version')) return { stdout: '2.1.291 (Claude Code)', exitCode: 0 };
    if (run.args.includes('--help')) return { stdout: help, exitCode: 0 };
    if (run.args.includes('status')) return { stdout: JSON.stringify(auth), exitCode: 0 };
    if (run.args.includes('--input-format'))
      return {
        stdout: [
          { type: 'system', subtype: 'init' },
          { type: 'assistant', message: { content: [] } },
          {
            type: 'result',
            subtype: 'success',
            result: '{"pages":[]}',
            usage: { input_tokens: 2, cache_creation_input_tokens: 900, output_tokens: 30 },
          },
        ]
          .map(e => JSON.stringify(e))
          .join('\n'),
        exitCode: 0,
      };
    return {
      stdout: JSON.stringify({ result: '{"kind":"outline"}', usage: { input_tokens: 10, output_tokens: 5 } }),
      exitCode: 0,
    };
  };
  try {
    const client = new ClaudeSubscription({ cwd, command: { file: 'official-claude' }, runner });
    await client.status();
    const provider = client.provider('sonnet');
    assert.equal(provider.images, true);
    const seen = await provider.complete({
      system: '点検',
      content: '{"request":{"pages":[{"id":"slide-2"}]}}',
      maxTokens: 4000,
      images: [{ mediaType: 'image/png', data: 'iVBORw0KGgo=' }],
    });
    assert.equal(seen.text, '{"pages":[]}');
    assert.equal(seen.usage.cacheWriteTokens, 900);
    const run = calls.find(c => c.args.includes('--input-format'))!;
    for (const flag of ['stream-json', '--verbose', '--no-session-persistence', '--strict-mcp-config'])
      assert.ok(run.args.includes(flag), flag);
    assert.equal(run.args[run.args.indexOf('--tools') + 1], '');
    assert.equal(run.args[run.args.indexOf('--output-format') + 1], 'stream-json');
    const message = JSON.parse(run.stdin!);
    assert.equal(message.type, 'user');
    assert.match(message.message.content[0].text, /slide-2/);
    assert.deepEqual(message.message.content[1], {
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' },
    });
    await provider.complete({ system: '構成', content: '{}', maxTokens: 4000 });
    const plain = calls.filter(c => c.args.includes('-p')).pop()!;
    assert.ok(!plain.args.includes('--input-format'), 'text only stays as before');
    assert.equal(plain.args[plain.args.indexOf('--output-format') + 1], 'json');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('the look at drawn pages keeps only findings for pages it was shown, with a known grade, three per page', () => {
  const pages = validateReview(
    {
      pages: [
        {
          id: 'slide-2',
          problems: [
            { severity: 'high', what: '図が空', fix: '点を置く' },
            { severity: 'tiny', what: '?' },
            { severity: 'low', what: '' },
            { severity: 'medium', what: '詰め込み' },
            { severity: 'low', what: '余白' },
            { severity: 'low', what: '4つ目' },
          ],
        },
        { id: 'slide-9', problems: [{ severity: 'high', what: '見せていない' }] },
        null,
      ],
    },
    ['slide-2', 'slide-3'],
  );
  assert.deepEqual(pages, [
    {
      id: 'slide-2',
      problems: [
        { severity: 'high', what: '図が空', fix: '点を置く' },
        { severity: 'medium', what: '詰め込み', fix: '' },
        { severity: 'low', what: '余白', fix: '' },
      ],
    },
  ]);
});

const outline: Outline = {
  title: '点検',
  mode: 'presentation',
  assumptions: [],
  slides: [
    { id: 'slide-1', title: '表紙', intent: '表紙', layoutId: 'cover', keyPoints: [] },
    { id: 'slide-2', title: '問いの地図', intent: '図', layoutId: 'free', keyPoints: [] },
    { id: 'slide-3', title: 'まとめ', intent: 'まとめ', layoutId: 'free', keyPoints: [] },
  ],
} as Outline;
const page = (id: string, title: string, extra = '') => ({
  id,
  title,
  layoutId: id === 'slide-1' ? 'cover' : 'free',
  notes: '',
  sources: [],
  html: `<section class="slide"><h1>${title}</h1>${extra}</section>`,
});
async function fixture(
  patch: Partial<Settings> = {},
  options: {
    images?: boolean;
    fixFails?: boolean;
    masked?: boolean;
    remakeBroken?: boolean;
    bothHigh?: boolean;
    notBetter?: boolean;
    blank?: boolean;
    drawn?: boolean;
    photo?: boolean;
    crop?: boolean;
    store?: ImageStore;
  } = {},
) {
  const dir = await mkdtemp(path.join(tmpdir(), 'de-review-'));
  const settings = await new SettingsStore(dir, '').load();
  await settings.update({
    provider: 'subscription',
    subscriptionService: 'claude',
    slideCount: 3,
    mode: 'presentation',
    designMode: 'html',
    outlineProposals: false,
    ...patch,
  });
  const layouts: HtmlLayoutOptions[] = [],
    reviews: CompletionRequest[] = [],
    redos: any[] = [];
  const layout: HtmlLayout = async (pages, _theme, opts) => {
    layouts.push(opts ?? {});
    return pages.map(p => {
      const title = /<h1>(.*?)<\/h1>/.exec(p.html)?.[1] ?? '';
      return {
        elements: [
          {
            t: 'text',
            x: 56,
            y: 30,
            w: 700,
            h: 44,
            text: title,
            size: 30,
            color: 'ink',
            exact: true,
            role: p.id === 'slide-1' ? 'body' : 'title',
          },
          ...(options.crop && p.id !== 'slide-1'
            ? [{ t: 'image', x: 500, y: 120, w: 300, h: 300, q: 'leaf', src: '0123456789abcdef.jpg', iw: 800, ih: 400 }]
            : []),
        ],
        problems:
          options.fixFails && p.html.includes('直した')
            ? ['文字が下端の出典欄（下から44px、y=496以降）に入っています（「直した」）。']
            : [],
        ...(opts?.screenshot ? { shot: `SHOT-${p.id}` } : {}),
      };
    });
  };
  const usage = { ...emptyUsage(), calls: 1 };
  // drawn: PowerPoint draws the deck; each drawing's pictures read "PPT<drawing>-<page>".
  let drawings = 0,
    busy = false;
  const render = async (deck: { slides: { id: string }[] }) => {
    if (!options.drawn) return { artifactId: 'x', pptxUrl: 'x', thumbnails: [], warnings: [], native: false };
    const artifactId = `a${++drawings}`;
    await mkdir(path.join(dir, 'artifacts', artifactId), { recursive: true });
    for (const slide of deck.slides)
      await writeFile(path.join(dir, 'artifacts', artifactId, `${slide.id}.png`), `PPT${drawings}-${slide.id}`);
    return {
      artifactId,
      pptxUrl: 'x',
      thumbnails: deck.slides.map(s => `/artifacts/${artifactId}/${s.id}.png`),
      warnings: [],
      native: true,
    };
  };
  const engine = new SessionEngine({
    settings,
    dataDir: dir,
    htmlLayout: layout,
    ...(options.store ? { images: options.store } : {}),
    subscriptionBinding: () => 'account',
    render,
    artifactRoot: path.join(dir, 'artifacts'),
    providerFactory: () => ({
      ...(options.images === false ? {} : { images: true }),
      complete: async (r: CompletionRequest) => {
        // Like a subscription, one call at a time.
        if (busy) throw new Error('busy');
        busy = true;
        await new Promise(resolve => setImmediate(resolve));
        busy = false;
        const content = JSON.parse(r.content),
          req = content.request;
        if (req.pages) {
          reviews.push(r);
          // The second look compares the touched-up pages with how they were: better and clean, with a new high
          // problem (remakeBroken), or slide-3 not better (notBetter).
          if (redos.length && !req.focus)
            return {
              text: JSON.stringify({
                pages: req.pages.map((p: any) => ({
                  id: p.id,
                  ...(req.compare ? { better: !(options.notBetter && p.id === 'slide-3') } : {}),
                  problems: options.remakeBroken
                    ? [{ severity: 'high', what: '文字が丸に隠れる', fix: '丸をずらす' }]
                    : [
                        {
                          severity: 'low',
                          what: '行間が狭い',
                          fix: '少し広げる',
                          ...(options.photo && p.id === 'slide-3' ? { photo: true } : {}),
                        },
                      ],
                })),
              }),
              usage,
            };
          if (options.crop)
            return {
              text: JSON.stringify({
                pages: [
                  { id: 'slide-1', problems: [] },
                  {
                    id: 'slide-2',
                    problems: [{ severity: 'medium', what: '写真の主役が切れる', fix: '左を見せる', crop: 'left' }],
                  },
                  {
                    id: 'slide-3',
                    problems: [{ severity: 'medium', what: '写真の上が切れる', fix: '上を見せる', crop: 'top' }],
                  },
                ],
              }),
              usage,
            };
          return {
            text: JSON.stringify({
              pages: [
                { id: 'slide-1', problems: [] },
                {
                  id: 'slide-2',
                  problems: [
                    {
                      severity: 'high',
                      what: '図に中身がない',
                      fix: '問いの点を置く',
                      ...(options.photo ? { photo: true } : {}),
                    },
                    { severity: 'low', what: '余白が偏る', fix: '左右をそろえる' },
                  ],
                },
                {
                  id: 'slide-3',
                  problems: [
                    options.blank
                      ? { severity: 'medium', what: '［実施日］が未記入のまま', fix: '日付を入れる' }
                      : { severity: options.bothHigh ? 'high' : 'medium', what: '文章が多い', fix: '3つにまとめる' },
                  ],
                },
              ],
            }),
            usage,
          };
        }
        if (!req.targetSlides) return { text: JSON.stringify({ kind: 'outline', outline }), usage };
        if (req.repair?.reason === 'VISUAL_REVIEW') {
          redos.push({ ...req, shots: (r.images ?? []).map(i => i.data) });
          return {
            text: JSON.stringify({
              mode: 'presentation',
              id: 'd',
              title: '点検',
              slides: req.targetSlides.map((s: any) => ({ ...page(s.id, '直した' + s.title), notes: '書き換えた' })),
            }),
            usage,
          };
        }
        return {
          text: JSON.stringify({
            mode: 'presentation',
            id: 'd',
            title: '点検',
            slides: req.targetSlides.map((s: any) => page(s.id, s.title)),
          }),
          usage,
        };
      },
    }),
  });
  if (options.masked) {
    const project = await engine.createProject({ name: '伏せ字', privacy: { mode: 'masked', terms: ['カゲロウ'] } });
    await settings.update({ activeProjectId: project.id });
  }
  return { engine, layouts, reviews, redos, dispose: () => rm(dir, { recursive: true, force: true }) };
}

const textOf = (session: { variants: { deck: { slides: any[] } }[] }, index: number) =>
  session.variants[0].deck.slides[index].design.elements[0].text;

test('a photo the look says is not to be used is passed over: at the first look, at the second, and on request', async () => {
  const passed: string[] = [];
  const store: ImageStore = {
    file: () => undefined,
    place: async () => 0,
    passOver: async page => void passed.push((page as { id: string }).id),
  };
  const f = await fixture({}, { photo: true, store, drawn: true });
  try {
    const session = await f.engine.create({ prompt: '3枚', cloudConsent: true }, []);
    await f.engine.generate(session.id);
    const polished = await f.engine.polish(session.id);
    assert.deepEqual(passed, ['slide-2', 'slide-3'], 'what was looked at, and only what was flagged');
    assert.equal(polished.variants[0].render, undefined, 'drawn again with the next picture');
    passed.length = 0;
    await f.engine.refinePage(session.id, polished.variants[0].id, 'slide-2');
    assert.deepEqual(passed, ['slide-2']);
  } finally {
    await f.dispose();
  }
  assert.match(reviewPrompt(), /"photo":true/);
});

test('a photo cut in the wrong place is moved by the app with no call to the AI, when it is cut along that side', async () => {
  const f = await fixture({}, { crop: true, drawn: true });
  try {
    const session = await f.engine.create({ prompt: '3枚', cloudConsent: true }, []);
    await f.engine.generate(session.id);
    const polished = await f.engine.polish(session.id);
    const photo = (index: number) =>
      polished.variants[0].deck.slides[index].design!.elements.find(e => e.t === 'image') as { focus?: string };
    assert.equal(photo(1).focus, 'left');
    assert.deepEqual(
      f.redos.map(r => r.targetSlides[0].id),
      ['slide-3'],
      'a photo cut left and right cannot show more at the top: that one goes on as a finding',
    );
    assert.equal(photo(2).focus, undefined);
    assert.equal(polished.variants[0].render, undefined, 'drawn again');
    const hint = polished.reviewHints!.find(h => h.slideId === 'slide-2')!;
    assert.equal(hint.fixed, true);
  } finally {
    await f.dispose();
  }
  assert.match(reviewPrompt(), /"crop"/);
});

test('a local model only shows what it saw on a page: nothing is touched up or compared; a page made from a layout is still asked for as HTML', async () => {
  const f = await fixture({ provider: 'local', model: 'mock' });
  try {
    const session = await f.engine.create({ prompt: '3枚' }, []);
    await f.engine.generate(session.id);
    const polished = await f.engine.polish(session.id);
    assert.equal(f.reviews.length, 1, 'no comparison');
    assert.deepEqual(f.redos, []);
    assert.equal(textOf(polished, 1), '問いの地図');
    assert.deepEqual(
      polished.reviewHints!.map(h => [h.slideId, h.severity, !!h.fixed, !!h.unresolved]),
      [
        ['slide-2', 'high', false, false],
        ['slide-2', 'low', false, false],
        ['slide-3', 'medium', false, false],
      ],
    );
    assert.deepEqual(polished.reviewReport, { checked: 3, fixed: [], unresolved: [], calls: 1 });
    assert.equal(polished.polish?.versions, undefined);
    const told = polished.messages.at(-1)!.text;
    assert.match(told, /AIの気づき3件は「確認のヒント」にあります（自動では直していません）/);
    assert.doesNotMatch(told, /手直しが必要な問題はありませんでした/);
  } finally {
    await f.dispose();
  }
  const g = await fixture({ provider: 'local', model: 'mock' });
  try {
    const session = await g.engine.create({ prompt: '3枚' }, []);
    await g.engine.generate(session.id);
    delete g.engine.state(session.id).polish!.html['slide-2'];
    const polished = await g.engine.polish(session.id);
    assert.deepEqual(
      g.redos.map(r => r.targetSlides.map((s: any) => s.id)),
      [['slide-2']],
    );
    assert.equal(g.redos[0].repair.html, undefined);
    assert.equal(textOf(polished, 1), '直した問いの地図');
    assert.equal(textOf(polished, 2), 'まとめ', 'the page whose HTML is at hand only gets a hint');
  } finally {
    await g.dispose();
  }
});

test('the deck is ready before the look; polishing then touches up the pages with a high or medium problem and compares them with how they were', async () => {
  const f = await fixture();
  try {
    const session = await f.engine.create({ prompt: '3枚', cloudConsent: true }, []);
    const ready = await f.engine.generate(session.id);
    assert.equal(ready.phase, 'ready');
    assert.ok(f.layouts[0].screenshot);
    assert.equal(f.reviews.length, 0, 'nothing is looked at before the deck is shown');
    assert.deepEqual(ready.polish, { state: 'pending', pages: 3 });
    assert.equal(textOf(ready, 1), '問いの地図');
    assert.ok(
      ready.messages.some(m =>
        /続けて、描画したページを画像で見直して仕上げます。その間も資料を確認できます/.test(m.text),
      ),
    );
    const polished = await f.engine.polish(session.id);
    assert.equal(f.reviews.length, 2, 'three pages in one look, then the touched-up pages beside how they were');
    assert.deepEqual(
      f.reviews[0].images!.map(i => i.data),
      ['SHOT-slide-1', 'SHOT-slide-2', 'SHOT-slide-3'],
    );
    assert.equal(
      JSON.parse(f.reviews[0].content).request.final,
      undefined,
      'PowerPoint drew nothing: the browser drawing',
    );
    assert.match(f.reviews[0].system, /high（重い）/);
    assert.match(f.reviews[0].system, /簡易な見本/);
    assert.deepEqual(JSON.parse(f.reviews[0].content).documents, []);
    // One call per page, given the page's HTML and picture: only what was found is to change.
    assert.deepEqual(
      f.redos.map(r => r.targetSlides.map((s: any) => s.id)),
      [['slide-2'], ['slide-3']],
    );
    assert.match(f.redos[0].repair.detail, /slide-2：図に中身がない。問いの点を置く/);
    assert.equal(f.redos[0].repair.html, '<section class="slide"><h1>問いの地図</h1></section>');
    assert.match(f.redos[0].repair.instruction, /指摘された所だけを直して/);
    assert.deepEqual(f.redos[0].shots, ['SHOT-slide-2']);
    const second = JSON.parse(f.reviews[1].content).request;
    assert.equal(second.compare, true);
    assert.deepEqual(
      second.pages.map((p: any) => p.asked),
      [['図に中身がない'], ['文章が多い']],
    );
    assert.deepEqual(
      f.reviews[1].images!.map(i => i.data),
      ['SHOT-slide-2', 'SHOT-slide-2', 'SHOT-slide-3', 'SHOT-slide-3'],
      'each page before and after',
    );
    assert.equal(textOf(polished, 1), '直した問いの地図');
    assert.equal(textOf(polished, 2), '直したまとめ', 'a medium finding is touched up too');
    assert.equal(polished.variants[0].deck.slides[1].notes, '', 'a touched-up page keeps its notes');
    assert.deepEqual(
      polished.reviewHints!.map(h => [h.slideId, h.severity, h.what, !!h.unresolved, !!h.fixed]),
      [
        ['slide-2', 'high', '図に中身がない', false, true],
        ['slide-2', 'low', '行間が狭い', false, false],
        ['slide-3', 'medium', '文章が多い', false, true],
        ['slide-3', 'low', '行間が狭い', false, false],
      ],
      'what was touched up is listed too; a touched-up page has the findings of the second look',
    );
    assert.deepEqual(polished.reviewReport, { checked: 3, fixed: ['slide-2', 'slide-3'], unresolved: [], calls: 4 });
    assert.equal(polished.polish?.state, 'done');
    assert.equal(polished.polish?.versions?.['slide-2'].applied, 'after');
    assert.ok(
      polished.messages.some(m =>
        /描画した3枚を画像で見直しました。2枚を手直ししました。直す前と見比べて、良くなったページだけを使っています（「確認のヒント」から直す前に戻せます）。細かな気づき2件/.test(
          m.text,
        ),
      ),
    );
    await assert.rejects(f.engine.polish(session.id), /見直す資料がありません/, 'once only');
    // Going back to the page before the look, and to the remade one again; no AI call.
    const calls = polished.usage.calls;
    const back = await f.engine.reviewVersion(session.id, 'slide-2', 'before');
    assert.equal(textOf(back, 1), '問いの地図');
    assert.equal(back.polish?.versions?.['slide-2'].applied, 'before');
    const again = await f.engine.reviewVersion(session.id, 'slide-2', 'after');
    assert.equal(textOf(again, 1), '直した問いの地図');
    assert.equal(again.usage.calls, calls);
    await assert.rejects(f.engine.reviewVersion(session.id, 'slide-1', 'before'), /戻すページと版を選んでください/);
    again.variants[0].deck.slides[1].design!.elements[0] = {
      ...again.variants[0].deck.slides[1].design!.elements[0],
      text: 'あとで書き換えた',
    } as any;
    await assert.rejects(f.engine.reviewVersion(session.id, 'slide-2', 'before'), /見直しの後に変更されたため/);
  } finally {
    await f.dispose();
  }
});

test('a touch-up with a high problem of its own is not used: the page stays as it was and the touch-up can still be chosen', async () => {
  const f = await fixture({}, { remakeBroken: true });
  try {
    const session = await f.engine.create({ prompt: '3枚', cloudConsent: true }, []);
    await f.engine.generate(session.id);
    const polished = await f.engine.polish(session.id);
    assert.equal(f.redos.length, 2);
    assert.equal(textOf(polished, 1), '問いの地図', 'the earlier page stays');
    assert.equal(polished.polish?.versions?.['slide-2'].applied, 'before');
    assert.deepEqual(polished.reviewReport?.fixed, []);
    assert.deepEqual(polished.reviewReport?.unresolved, ['slide-2', 'slide-3']);
    assert.ok(
      polished.reviewHints!.some(
        h => h.slideId === 'slide-2' && h.unresolved && /手直しした版にも重い問題：文字が丸に隠れる/.test(h.what),
      ),
      JSON.stringify(polished.reviewHints),
    );
    const chosen = await f.engine.reviewVersion(session.id, 'slide-2', 'after');
    assert.equal(textOf(chosen, 1), '直した問いの地図', 'the user may still take the touch-up');
  } finally {
    await f.dispose();
  }
});

test('a touch-up that did not make its page better is not used; a finding about a place to fill in is only a hint', async () => {
  const f = await fixture({}, { notBetter: true });
  try {
    const session = await f.engine.create({ prompt: '3枚', cloudConsent: true }, []);
    await f.engine.generate(session.id);
    const polished = await f.engine.polish(session.id);
    assert.equal(textOf(polished, 1), '直した問いの地図');
    assert.equal(textOf(polished, 2), 'まとめ', 'not better: the page stays as it was');
    assert.equal(polished.polish?.versions?.['slide-3'].applied, 'before');
    assert.deepEqual(polished.reviewReport?.fixed, ['slide-2']);
    assert.deepEqual(polished.reviewReport?.unresolved, ['slide-3']);
    assert.ok(polished.messages.some(m => /1枚を手直ししました。.*1枚は自動で直せなかったため/.test(m.text)));
  } finally {
    await f.dispose();
  }
  const blank = await fixture({}, { blank: true });
  try {
    const session = await blank.engine.create({ prompt: '3枚', cloudConsent: true }, []);
    await blank.engine.generate(session.id);
    const polished = await blank.engine.polish(session.id);
    assert.deepEqual(
      blank.redos.map(r => r.targetSlides.map((s: any) => s.id)),
      [['slide-2']],
    );
    assert.equal(textOf(polished, 2), 'まとめ');
    assert.ok(
      polished.reviewHints!.some(
        h => h.slideId === 'slide-3' && h.what === '［実施日］が未記入のまま' && !h.unresolved,
      ),
    );
  } finally {
    await blank.dispose();
  }
});

test('the look sees the pages drawn in PowerPoint, and the touched-up pages are drawn there again to be compared', async () => {
  const f = await fixture({}, { drawn: true });
  const text = (data: string) => Buffer.from(data, 'base64').toString();
  try {
    const session = await f.engine.create({ prompt: '3枚', cloudConsent: true }, []);
    await f.engine.generate(session.id);
    await f.engine.polish(session.id);
    const [first, second] = f.reviews;
    assert.equal(JSON.parse(first.content).request.final, true);
    assert.deepEqual(
      first.images!.map(i => text(i.data)),
      ['PPT1-slide-1', 'PPT1-slide-2', 'PPT1-slide-3'],
    );
    assert.deepEqual(
      f.redos.map(r => r.shots.map(text)),
      [['PPT1-slide-2'], ['PPT1-slide-3']],
      'a touch-up gets the picture the look saw',
    );
    assert.equal(JSON.parse(second.content).request.final, true);
    assert.deepEqual(
      second.images!.map(i => text(i.data)),
      ['PPT1-slide-2', 'PPT2-slide-2', 'PPT1-slide-3', 'PPT2-slide-3'],
    );
  } finally {
    await f.dispose();
  }
});

test('pages are touched up one per call, so one long answer cannot lose them all', async () => {
  const f = await fixture({}, { bothHigh: true });
  try {
    const session = await f.engine.create({ prompt: '3枚', cloudConsent: true }, []);
    await f.engine.generate(session.id);
    const polished = await f.engine.polish(session.id);
    assert.deepEqual(
      f.redos.map(r => r.targetSlides.map((s: any) => s.id)),
      [['slide-2'], ['slide-3']],
    );
    assert.match(f.redos[1].repair.detail, /^slide-3：文章が多い。3つにまとめる$/);
    assert.deepEqual(polished.reviewReport?.fixed, ['slide-2', 'slide-3']);
  } finally {
    await f.dispose();
  }
});

test('a page whose new version fails the checks keeps its earlier version and is listed as not fixed', async () => {
  const f = await fixture({}, { fixFails: true });
  try {
    const session = await f.engine.create({ prompt: '3枚', cloudConsent: true }, []);
    await f.engine.generate(session.id);
    const polished = await f.engine.polish(session.id);
    assert.equal(textOf(polished, 1), '問いの地図');
    assert.deepEqual(polished.reviewReport?.unresolved, ['slide-2', 'slide-3']);
    assert.equal(polished.polish?.versions, undefined);
    assert.deepEqual(
      polished.reviewHints!.filter(h => h.unresolved).map(h => h.what),
      ['図に中身がない', '文章が多い'],
    );
  } finally {
    await f.dispose();
  }
});

test('the look belongs to the working session: a deck reopened from history carries no pending look or versions', async () => {
  const f = await fixture();
  try {
    const ready = await f.engine.generate((await f.engine.create({ prompt: '3枚', cloudConsent: true }, [])).id);
    assert.ok(ready.historyId);
    const { session } = await f.engine.restoreHistory(ready.historyId!);
    assert.equal(session.polish, undefined);
    assert.equal(session.reviewHints, undefined);
    await assert.rejects(f.engine.polish(session.id), /見直す資料がありません/);
  } finally {
    await f.dispose();
  }
});

test('no look at the pages when it is off, without image support, or when the project masks names; ChatGPT looks too', async () => {
  const gpt = await fixture({ subscriptionService: 'chatgpt' });
  try {
    const ready = await gpt.engine.generate((await gpt.engine.create({ prompt: '3枚', cloudConsent: true }, [])).id);
    assert.equal(ready.polish?.state, 'pending', 'ChatGPT takes pictures as well');
  } finally {
    await gpt.dispose();
  }
  for (const [patch, options, label] of [
    [{ visualReview: false }, {}, 'off'],
    [{}, { images: false }, 'no images'],
    [{}, { masked: true }, 'masked'],
  ] as const) {
    const f = await fixture(patch as Partial<Settings>, options);
    try {
      const ready = await f.engine.generate(
        (await f.engine.create({ prompt: '3枚', cloudConsent: true, ...(label === 'masked' ? {} : {}) }, [])).id,
      );
      assert.equal(ready.phase, 'ready', label);
      assert.equal(f.reviews.length, 0, label);
      assert.equal(ready.reviewReport, undefined, label);
      assert.equal(ready.polish, undefined, label);
      assert.ok(!f.layouts.some(o => o.screenshot), label);
    } finally {
      await f.dispose();
    }
  }
});

test('a real browser returns the drawn page as a PNG when asked', { skip: !findBrowser() }, async () => {
  const theme = paletteTheme({
    name: 'x',
    background: '#FFFFFF',
    text: '#1F2937',
    muted: '#6B7280',
    accent: '#225588',
    accent2: '#AA5522',
  });
  const [shown] = await layoutHtmlSlides(
    [{ id: 'slide-2', html: '<section class="slide"><h1>題名</h1></section>' }],
    theme,
    { screenshot: true },
  );
  const [plain] = await layoutHtmlSlides(
    [{ id: 'slide-2', html: '<section class="slide"><h1>題名</h1></section>' }],
    theme,
  );
  if ('error' in shown || 'error' in plain) assert.fail('layout failed');
  assert.ok(shown.shot && Buffer.from(shown.shot, 'base64').subarray(1, 4).toString() === 'PNG');
  assert.equal(plain.shot, undefined);
  // A chart place gets a sketch in the picture only; the page is read (and the chart kept) as before.
  const chart = `<section class="slide"><h1>売上</h1><div data-chart='{"type":"column","categories":["A","B"],"series":[{"name":"売上","values":[3,5]}]}' style="position:absolute;left:60px;top:120px;width:400px;height:260px"></div></section>`;
  const [sketched] = await layoutHtmlSlides([{ id: 'slide-2', html: chart }], theme, { screenshot: true });
  const [unsketched] = await layoutHtmlSlides([{ id: 'slide-2', html: chart }], theme);
  if ('error' in sketched || 'error' in unsketched) assert.fail('layout failed');
  assert.deepEqual(sketched.elements, unsketched.elements);
  assert.ok(sketched.elements.some(e => e.t === 'chart'));
  const [empty] = await layoutHtmlSlides([{ id: 'slide-2', html: chart.replace(/ data-chart='[^']*'/, '') }], theme, {
    screenshot: true,
  });
  if ('error' in empty) assert.fail('layout failed');
  assert.notEqual(sketched.shot, empty.shot, 'the sketch is drawn in the picture');
});
