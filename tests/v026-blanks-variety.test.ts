import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DeckSpec, Outline, Settings, SlideSpec } from '../shared/contracts.js';
import { SessionEngine } from '../server/engine.js';
import { SettingsStore } from '../server/settings.js';
import { emptyUsage, type CompletionRequest } from '../server/providers.js';
import { freeSystemPrompt, reviewPrompt } from '../server/free-prompts.js';
import { findBrowser, layoutHtmlSlides, type HtmlLayout } from '../server/html-layout.js';
import { deckBlanks, draftMarks, fillBlanks } from '../shared/blanks.js';
import { compositionOf, repeatedPages } from '../shared/composition.js';
import { compileDeck } from '../shared/layouts.js';
import { iconCatalog, iconSvg } from '../shared/icons.js';
import { paletteTheme } from '../shared/ai-theme.js';
import { SHOWCASE_WARNING } from '../server/showcase.js';

const usage = { ...emptyUsage(), calls: 1 };
const text = (x: number, y: number, value = '本文', extra: Record<string, unknown> = {}) => ({
  t: 'text' as const,
  x,
  y,
  w: 150,
  h: 24,
  text: value,
  size: 16,
  ...extra,
});
const slideOf = (id: string, elements: any[], extra: Partial<SlideSpec> = {}): SlideSpec => ({
  id,
  title: id,
  layoutId: id === 'slide-1' ? 'cover' : 'free',
  items: [],
  notes: '',
  sources: [],
  design: { elements },
  ...extra,
});

test('blanks are listed with their pages and filled everywhere; a measured line that no longer fits is wrapped by the app', () => {
  const deck: DeckSpec = {
    id: 'd',
    title: '防災訓練',
    mode: 'presentation',
    themeId: 'paper',
    slides: [
      slideOf(
        'slide-1',
        [
          {
            t: 'text',
            x: 56,
            y: 40,
            w: 400,
            h: 60,
            text: '実施日：［実施日］',
            size: 24,
            exact: true,
            runs: [
              { s: 0, l: 4, bold: true },
              { s: 4, l: 5, color: 'negative' },
            ],
          },
        ],
        { notes: '確認事項：［実施日］の時刻' },
      ),
      slideOf('slide-2', [
        { t: 'text', x: 56, y: 30, w: 500, h: 44, text: '当日の流れ', size: 28, role: 'title', exact: true },
        {
          t: 'table',
          x: 56,
          y: 100,
          w: 600,
          h: 200,
          headers: ['項目', '内容'],
          rows: [['集合場所', '［集合\n場所］']],
        },
        { t: 'text', x: 56, y: 320, w: 120, h: 30, text: '場所：［集合場所］', size: 16, exact: true },
      ]),
    ],
  };
  assert.deepEqual(
    deckBlanks(deck),
    [
      { label: '実施日', pages: [1] },
      { label: '集合場所', pages: [2] },
    ],
    'a line break inside a blank does not count',
  );
  const { deck: filled, changed } = fillBlanks(deck, {
    実施日: '11月9日（日）9時',
    集合場所: '第二公園の北側広場（雨天時は公民館）',
    未使用: 'x',
  });
  assert.deepEqual(changed, ['slide-1', 'slide-2']);
  const cover = filled.slides[0].design!.elements[0] as any;
  assert.equal(cover.text, '実施日：11月9日（日）9時');
  assert.equal(cover.exact, true, 'the filled line still fits: the browser lines are kept');
  assert.deepEqual(
    cover.runs,
    [{ s: 0, l: 4, bold: true }],
    'the colour the AI gave the blank goes with it; the bold label stays',
  );
  assert.equal(filled.slides[0].notes, '確認事項：11月9日（日）9時の時刻');
  assert.equal((filled.slides[1].design!.elements[1] as any).rows[0][1], '第二公園の北側広場（雨天時は公民館）');
  const narrow = filled.slides[1].design!.elements[2] as any;
  assert.equal(narrow.exact, undefined, 'too long for its measured line: the app wraps and fits it');
  assert.equal(narrow.text, '場所：第二公園の北側広場（雨天時は公民館）');
  assert.deepEqual(deckBlanks(filled), []);
  assert.deepEqual(fillBlanks(deck, { 実施日: '  ' }).changed, [], 'an empty answer leaves the blank');
});

test('the blanks still to fill are drawn in one colour that stands out, in the scene and its parts', () => {
  const deck: DeckSpec = {
    id: 'd',
    title: 't',
    mode: 'presentation',
    themeId: 'paper',
    slides: [
      slideOf('slide-2', [
        { t: 'text', x: 56, y: 30, w: 500, h: 44, text: '題名', size: 28, role: 'title', exact: true },
        { t: 'text', x: 56, y: 120, w: 400, h: 30, text: '集合：［集合場所］', size: 18, exact: true },
        text(56, 200, '締切は［締切日］です'),
      ]),
    ],
  };
  const scene = compileDeck(deck).slides[0];
  const exact = scene.elements.find(e => e.kind === 'text' && e.text.includes('［集合場所］')) as any,
    wrapped = scene.elements.find(e => e.kind === 'text' && e.text.includes('［締切日］')) as any;
  for (const el of [exact, wrapped]) {
    assert.ok(el.blankColor, el.text);
    const at = el.text.indexOf('［');
    assert.ok(
      el.runs.some((r: any) => r.start === at && r.color === el.blankColor),
      el.text,
    );
  }
  assert.equal((scene.elements.find(e => e.kind === 'text' && e.text === '題名') as any).blankColor, undefined);
});

test('notes to the maker and empty dates left on a slide are found; real dates, words and the notes are not', () => {
  const slide = (value: string) => slideOf('slide-2', [text(0, 0, value)], { notes: '総務部に確認してから記載する' });
  assert.ok(draftMarks(slide('実施日：年 月 日( )')).every(m => m.kind === 'blank'));
  assert.ok(draftMarks(slide('月 日( ) 時 分から')).length > 0);
  assert.ok(draftMarks(slide('○月○日に開始')).some(m => m.kind === 'blank'));
  assert.ok(draftMarks(slide('二択以外の操作の有無は、総務部に確認してから記載する。')).some(m => m.kind === 'memo'));
  assert.ok(draftMarks(slide('画面名は仮置き。総務部の確認後に差し替える。')).some(m => m.kind === 'memo'));
  for (const fine of [
    '5月 3日（土）に実施',
    '毎月 日曜日に点検',
    '［実施日］に集合',
    '（雨天時は中止）',
    '集合場所',
    '12時 30分から',
  ])
    assert.deepEqual(draftMarks(slide(fine)), [], fine);
});

test('the kind of a page is read from its elements, and the second of three alike in a row is picked to be made again', () => {
  const title = { t: 'text', x: 56, y: 30, w: 600, h: 40, text: '題', size: 28, role: 'title' };
  const table = (id: string) => slideOf(id, [title, ...[100, 150, 200, 250].flatMap(y => [text(56, y), text(300, y)])]);
  const cards = (id: string) =>
    slideOf(id, [
      title,
      ...[56, 360, 664].flatMap(x => [
        { t: 'box', x, y: 120, w: 240, h: 200, fill: 'surface' },
        text(x + 12, 132, '見出し'),
        text(x + 12, 170),
      ]),
    ]);
  const plain = (id: string) => slideOf(id, [title, text(56, 120)]);
  assert.equal(compositionOf(table('slide-2')), 'table');
  assert.equal(compositionOf(cards('slide-2')), 'cards');
  assert.equal(compositionOf(plain('slide-2')), 'text');
  const slides = [
    slideOf('slide-1', []),
    table('slide-2'),
    table('slide-3'),
    table('slide-4'),
    table('slide-5'),
    plain('slide-6'),
    cards('slide-7'),
    cards('slide-8'),
  ];
  assert.deepEqual(repeatedPages(slides), [{ slideId: 'slide-3', kind: 'table' }]);
  assert.deepEqual(repeatedPages([slideOf('slide-1', []), cards('slide-2'), cards('slide-3'), cards('slide-4')]), [
    { slideId: 'slide-3', kind: 'cards' },
  ]);
});

test('the instructions ask for one kind of blank, keep notes off the slides, list open facts, vary pages and directions', () => {
  const plan = freeSystemPrompt('plan', { proposals: 3 }),
    html = freeSystemPrompt('generate', { format: 'html', outputMode: 'presentation' }),
    json = freeSystemPrompt('generate', { outputMode: 'presentation' });
  for (const prompt of [plan, html, json]) {
    assert.match(prompt, /項目名を全角の角かっこで囲んだ記入欄（例：［実施日］［集合場所］）だけを置きます/);
    assert.match(
      prompt,
      /作り手向けのメモは、スライドの文字に書きません。確認が必要なことは、notesの最後に「確認事項：」/,
    );
  }
  assert.match(plan, /outline\.openFactsには、依頼と資料にない事実のうち、この資料に必要なもの/);
  assert.match(plan, /openFactsは、どの案にも同じものを書きます/);
  assert.match(plan, /背景の明るさ・主な色・文字と図の割合のうち、少なくとも2つを案ごとに変えます/);
  for (const prompt of [html, json])
    assert.match(prompt, /同じ構図（表、同じ形の囲みの並びなど）を3ページ以上続けません/);
  assert.match(reviewPrompt(), /［実施日］のような全角の角かっこの文字は、利用者が後で記入する欄です。問題にしません/);
});

test('the new icons are drawn as editable strokes and as the same picture for browser pages', () => {
  for (const id of ['person', 'family', 'child', 'elder', 'warning', 'exit', 'star', 'bicycle'] as const) {
    assert.ok(Object.hasOwn(iconCatalog, id));
    const svg = iconSvg(id);
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 24 24"[^>]*stroke="currentColor"/);
    assert.match(svg, /<(line|ellipse|rect)\b/);
  }
});

test(
  'an app icon in the HTML becomes one editable icon in the colour of its text; an unknown one is left out',
  { skip: !findBrowser() },
  async () => {
    const theme = paletteTheme({
      name: '検査',
      background: '#FFFFFF',
      text: '#1F2937',
      muted: '#6B7280',
      accent: '#225588',
      accent2: '#AA5522',
    });
    const [r] = await layoutHtmlSlides(
      [
        {
          id: 'slide-2',
          html: '<section class="slide"><h1 style="position:absolute;left:56px;top:20px;margin:0;font-size:28px">題名</h1><i data-icon="family" style="position:absolute;left:100px;top:120px;width:48px;height:48px;color:#225588"></i><i data-icon="unicorn" style="position:absolute;left:200px;top:120px;width:48px;height:48px"></i></section>',
        },
      ],
      theme,
    );
    if ('error' in r) assert.fail(r.error);
    assert.deepEqual(
      r.elements.filter(e => e.t === 'icon'),
      [{ t: 'icon', icon: 'family', x: 100, y: 120, size: 48, color: 'accent' }],
    );
    assert.ok(!r.elements.some(e => e.t === 'svg'), 'the icon is not also kept as a picture');
    assert.deepEqual(r.problems, []);
  },
);

const outline3 = (extra: Partial<Outline> = {}): Outline =>
  ({
    title: '訓練',
    mode: 'presentation',
    assumptions: [],
    slides: [
      { id: 'slide-1', title: '表紙', intent: '表紙', layoutId: 'cover', keyPoints: [] },
      { id: 'slide-2', title: '集合', intent: '集合', layoutId: 'free', keyPoints: [] },
      { id: 'slide-3', title: '注意', intent: '注意', layoutId: 'free', keyPoints: [] },
    ],
    ...extra,
  }) as Outline;
const designPage = (id: string, body: string) => ({
  id,
  title: id,
  layoutId: id === 'slide-1' ? 'cover' : 'free',
  items: [],
  notes: '',
  sources: [],
  design: {
    elements: [
      { t: 'text', x: 56, y: 28, w: 700, h: 52, text: id, size: 28, ...(id === 'slide-1' ? {} : { role: 'title' }) },
      { t: 'text', x: 56, y: 120, w: 700, h: 30, text: body, size: 18 },
    ],
  },
});

async function engineWith(
  patch: Partial<Settings>,
  reply: (req: any, r: CompletionRequest) => unknown,
  extra: { htmlLayout?: HtmlLayout; showcase?: () => Promise<unknown> } = {},
) {
  const dir = await mkdtemp(path.join(tmpdir(), 'de-blanks-'));
  const settings = await new SettingsStore(dir, '').load();
  await settings.update({
    provider: 'subscription',
    subscriptionService: 'claude',
    slideCount: 3,
    mode: 'presentation',
    designMode: 'free',
    outlineProposals: false,
    ...patch,
  });
  const requests: any[] = [];
  const engine = new SessionEngine({
    settings,
    dataDir: dir,
    subscriptionBinding: () => 'account',
    ...extra,
    render: async () => ({ artifactId: 'x', pptxUrl: 'x', thumbnails: [], warnings: [], native: false }),
    providerFactory: () => ({
      images: true,
      complete: async (r: CompletionRequest) => {
        const req = JSON.parse(r.content).request;
        requests.push(req);
        return { text: JSON.stringify(reply(req, r)), usage };
      },
    }),
  });
  return { dir, engine, settings, requests, dispose: () => rm(dir, { recursive: true, force: true }) };
}

test('open facts: answers go with the outline, blanks left are filled across the deck without the AI, notes to the maker become hints', async () => {
  const f = await engineWith({}, req =>
    req.targetSlides
      ? {
          mode: 'presentation',
          id: 'd',
          title: '訓練',
          slides: req.targetSlides.map((s: any) =>
            designPage(
              s.id,
              s.id === 'slide-2'
                ? '集合：［集合場所］'
                : s.id === 'slide-3'
                  ? '持ち物は総務部に確認してから記載する'
                  : '［実施日］',
            ),
          ),
        }
      : {
          kind: 'outline',
          outline: outline3({ openFacts: [{ label: '実施日', hint: '日付と時刻' }, { label: '［集合場所］' }] }),
        },
  );
  try {
    const s = await f.engine.create({ prompt: '3枚', cloudConsent: true }, []);
    assert.deepEqual(
      s.outline!.openFacts,
      [{ label: '実施日', hint: '日付と時刻' }, { label: '集合場所' }],
      'names are kept without the brackets',
    );
    const ready = await f.engine.generate(s.id, undefined, false, { 実施日: '11月9日', 集合場所: '  ' });
    assert.deepEqual(f.requests.find(r => r.targetSlides).outline.openFacts, [
      { label: '実施日', hint: '日付と時刻', value: '11月9日' },
      { label: '集合場所' },
    ]);
    const texts = (i: number) => ready.variants[0].deck.slides[i].design!.elements.map((e: any) => e.text);
    assert.ok(texts(0).includes('11月9日'), 'a blank the AI still wrote for an answered fact is filled');
    assert.ok(
      ready.reviewHints!.some(
        h =>
          h.slideId === 'slide-3' && h.severity === 'medium' && /作り手向けのメモ（「.*確認してから記載/.test(h.what),
      ),
      JSON.stringify(ready.reviewHints),
    );
    assert.match(ready.messages.at(-1)!.text, /［　］の記入欄にしています（1項目）/);
    await assert.rejects(f.engine.generate(s.id, undefined, false, { 実施日: 'x'.repeat(81) }), /80文字以内/);
    const calls = ready.usage.calls;
    const filled = await f.engine.fillBlanks(s.id, { 集合場所: '第二公園' });
    assert.ok(filled.variants[0].deck.slides[1].design!.elements.some((e: any) => e.text === '集合：第二公園'));
    assert.equal(filled.outline!.openFacts![1].value, '第二公園');
    assert.equal(filled.usage.calls, calls, 'no AI');
    await assert.rejects(f.engine.fillBlanks(s.id, { 集合場所: '' }), /入力してください/);
  } finally {
    await f.dispose();
  }
});

test('the look after the deck is shown also remakes a page with a note to the maker, even when the AI saw nothing', async () => {
  const layout: HtmlLayout = async (pages, _t, opts) =>
    pages.map(p => {
      const title = /<h1>(.*?)<\/h1>/.exec(p.html)?.[1] ?? '',
        body = /<p>(.*?)<\/p>/.exec(p.html)?.[1];
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
          ...(body
            ? [{ t: 'text', x: 56, y: 120, w: 700, h: 30, text: body, size: 18, color: 'ink', exact: true }]
            : []),
        ],
        problems: [],
        ...(opts?.screenshot ? { shot: `SHOT-${p.id}` } : {}),
      };
    });
  const remakes: any[] = [];
  const f = await engineWith(
    { designMode: 'html' },
    (req, r) => {
      if (r.images) return { pages: req.pages.map((p: any) => ({ id: p.id, problems: [] })) };
      if (!req.targetSlides) return { kind: 'outline', outline: outline3() };
      if (req.repair?.reason === 'VISUAL_REVIEW') {
        remakes.push(req);
        return {
          mode: 'presentation',
          id: 'd',
          title: 'x',
          slides: req.targetSlides.map((s: any) => ({
            id: s.id,
            title: s.title,
            layoutId: 'free',
            notes: '確認事項：持ち物',
            sources: [],
            html: `<section class="slide"><h1>${s.title}</h1><p>持ち物は［持ち物］</p></section>`,
          })),
        };
      }
      return {
        mode: 'presentation',
        id: 'd',
        title: 'x',
        slides: req.targetSlides.map((s: any) => ({
          id: s.id,
          title: s.title,
          layoutId: s.layoutId,
          notes: '',
          sources: [],
          html: `<section class="slide"><h1>${s.title}</h1>${s.id === 'slide-3' ? '<p>持ち物は仮置き。確定後に差し替える</p>' : ''}</section>`,
        })),
      };
    },
    { htmlLayout: layout },
  );
  try {
    const s = await f.engine.create({ prompt: '3枚', cloudConsent: true }, []);
    const shown = await f.engine.generate(s.id);
    assert.equal(shown.polish!.state, 'pending');
    assert.equal(shown.reviewHints, undefined, 'the finding waits for the look');
    const done = await f.engine.polish(s.id);
    assert.deepEqual(
      remakes.map(r => r.targetSlides.map((x: any) => x.id)),
      [['slide-3']],
    );
    assert.match(remakes[0].repair.detail, /作り手向けのメモ/);
    assert.deepEqual(done.reviewReport!.fixed, ['slide-3']);
    assert.ok(done.variants[0].deck.slides[2].design!.elements.some((e: any) => e.text === '持ち物は［持ち物］'));
  } finally {
    await f.dispose();
  }
});

const offer = {
  kind: 'proposals',
  candidates: [{ direction: '定番', typicality: 0.6 }],
  proposals: [0.6, 0.15, 0.08].map((t, i) => ({
    direction: `方向${i + 1}`,
    difference: '違い',
    typicality: t,
    suitedFor: '場面',
    previewSlide: 'slide-2',
    outline: outline3({ title: `案${i + 1}` }),
  })),
  recommended: 1,
  reason: '理由',
};

test('manual chat offers the three directions too; the cards wait for no samples', async () => {
  const f = await engineWith({ provider: 'chat', model: 'manual-chat', outlineProposals: true }, () => ({}));
  try {
    const s = await f.engine.create({ prompt: '3枚' }, []);
    assert.match(s.chatHandoff!.instruction, /request\.proposals=3です。構成案を1つに絞らず、方向の違う3案を出し/);
    const offered = await f.engine.chatResponse(s.id, {
      requestId: s.chatHandoff!.requestId,
      response: JSON.stringify(offer),
    });
    assert.equal(offered.phase, 'clarifying');
    assert.equal(offered.proposals!.items.length, 3);
    assert.equal(offered.chatHandoff, undefined);
    const chosen = await f.engine.chooseProposal(s.id, 2);
    assert.equal(chosen.phase, 'outline');
    assert.equal(chosen.outline!.title, '案3');
    await assert.rejects(f.engine.previewProposal(s.id, 0), /月額版/);
  } finally {
    await f.dispose();
  }
});

test('the sample experience replays a recording: directions with samples, the picked deck with blanks, the look at its pages — no AI, nothing remembered', async () => {
  const deck = (name: string): DeckSpec => ({
    id: name,
    title: name,
    mode: 'presentation',
    themeId: 'paper',
    slides: [
      designPage('slide-1', '［実施日］'),
      designPage('slide-2', '集合は［集合場所］'),
      designPage('slide-3', '注意'),
    ] as unknown as SlideSpec[],
  });
  const facts = [{ label: '実施日' }, { label: '集合場所' }];
  const showcase = {
    version: 1,
    prompt: '防災訓練のお知らせ',
    mode: 'presentation',
    ai: 'Claude',
    proposals: {
      items: offer.proposals.map((p, i) => ({
        ...p,
        outline: { ...p.outline, openFacts: facts },
        preview: { ...deck(`見本${i}`), slides: deck('x').slides.slice(0, 2) },
      })),
      candidates: offer.candidates,
      recommended: 1,
      reason: '理由',
      chosen: 1,
    },
    decks: [0, 1, 2].map(i => ({
      deck: deck(`記録${i}`),
      seconds: 100,
      ...(i === 1
        ? {
            polish: {
              replaced: { 'slide-3': designPage('slide-3', '直した注意') },
              hints: [
                { slideId: 'slide-3', title: '注意', severity: 'high', what: '図が空', fix: '描く', fixed: true },
                { slideId: 'slide-2', title: '集合', severity: 'low', what: '余白', fix: '詰める' },
              ],
              report: { checked: 3, fixed: ['slide-3'], unresolved: [], calls: 2 },
              seconds: 21,
            },
          }
        : {}),
    })),
  };
  const f = await engineWith(
    { provider: 'demo', slideCount: 5 },
    () => {
      throw new Error('no AI in the sample');
    },
    { showcase: async () => showcase },
  );
  try {
    const s = await f.engine.create({ prompt: 'サンプルを体験する' }, []);
    assert.equal(s.warnings[0], SHOWCASE_WARNING);
    assert.equal(s.messages[0].text, '防災訓練のお知らせ');
    assert.equal(s.proposals!.items.length, 3);
    assert.equal(s.proposals!.chosen, undefined);
    assert.ok(s.proposals!.items.every(i => i.preview));
    await f.engine.chooseProposal(s.id, 1);
    const shown = await f.engine.generate(s.id, undefined, false, { 実施日: '11月9日' });
    assert.equal(shown.phase, 'ready');
    assert.equal(shown.polish!.state, 'pending');
    assert.ok(shown.variants[0].deck.slides[0].design!.elements.some((e: any) => e.text === '11月9日'));
    assert.deepEqual(
      deckBlanks(shown.variants[0].deck).map(b => b.label),
      ['集合場所'],
    );
    const done = await f.engine.polish(s.id);
    assert.equal(done.polish!.state, 'done');
    assert.ok(done.polish!.versions!['slide-3']);
    assert.equal(done.reviewHints!.length, 2);
    assert.deepEqual(done.reviewReport!.fixed, ['slide-3']);
    assert.ok(done.variants[0].deck.slides[2].design!.elements.some((e: any) => e.text === '直した注意'));
    await f.engine.feedback({ sessionId: s.id, variantId: done.variants[0].id, rating: 5 });
    await assert.rejects(
      readFile(path.join(f.dir, 'proposal-choices.jsonl'), 'utf8'),
      'picks in the sample are not remembered',
    );
    assert.equal(done.usage.calls, 0);
    assert.equal(f.requests.length, 0);
  } finally {
    await f.dispose();
  }
});
