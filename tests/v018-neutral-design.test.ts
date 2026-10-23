import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Outline } from '../shared/contracts.js';
import { SessionEngine } from '../server/engine.js';
import { SettingsStore } from '../server/settings.js';
import { emptyUsage, type CompletionRequest } from '../server/providers.js';
import { freeSystemPrompt } from '../server/free-prompts.js';
import { AI_THEME_ID, paletteTheme } from '../shared/ai-theme.js';
import { resolveFont } from '../shared/typography.js';
import { measureText, wrapText } from '../shared/layouts.js';
import { themeCatalog } from '../shared/themes.js';

const usage = { ...emptyUsage(), calls: 1 };
const t = (x: number, y: number, w: number, h: number, text: string, size: number, role?: string) => ({
  t: 'text',
  x,
  y,
  w,
  h,
  text,
  size,
  ...(role ? { role } : {}),
});
const palette = {
  name: '夜の数式',
  background: '#101820',
  text: '#F2F2F2',
  muted: '#A9B4BE',
  accent: '#F2B33D',
  accent2: '#4FB3BF',
  headingFont: 'Noto Serif JP',
  bodyFont: 'メイリオ',
};

test('free-design instructions carry no design preference: no themes, fonts, chart advice or spacing advice', () => {
  for (const prompt of [
    freeSystemPrompt('plan'),
    freeSystemPrompt('generate'),
    freeSystemPrompt('plan', { mode: 'project', kitFile: 'kit.md', kitVersion: '1' }),
  ]) {
    for (const theme of themeCatalog())
      assert.ok(!prompt.includes(theme.description), `no theme description: ${theme.id}`);
    assert.doesNotMatch(prompt, /テーマ候補|書体候補|"paper"|UD Digi|BIZ UDP|項目名が長い場合にも向く|少し余裕|予備/);
    // What remains is the format and the rules on facts.
    assert.match(prompt, /幅960×高さ540/);
    assert.match(prompt, /滝グラフは1系列/);
    assert.match(prompt, /無関係な項目を折れ線でつないで/);
  }
  assert.match(freeSystemPrompt('plan'), /outline\.paletteに必ず書きます.*headingFont・bodyFont/s);
});

async function fixture(reply: (req: any) => unknown, outline: Outline) {
  const dir = await mkdtemp(path.join(tmpdir(), 'de-neutral-'));
  const settings = await new SettingsStore(dir, '').load();
  await settings.update({ provider: 'local', model: 'mock', slideCount: 2, mode: 'presentation' });
  const requests: any[] = [];
  const engine = new SessionEngine({
    settings,
    dataDir: dir,
    render: async () => ({ artifactId: 'x', pptxUrl: 'x', thumbnails: [], warnings: [], native: false }),
    providerFactory: () => ({
      complete: async (r: CompletionRequest) => {
        const input = JSON.parse(r.content);
        requests.push(input);
        if (!input.request.targetSlides) return { text: JSON.stringify({ kind: 'outline', outline }), usage };
        return { text: JSON.stringify(reply(input.request)), usage };
      },
    }),
  });
  return { engine, settings, requests, dispose: () => rm(dir, { recursive: true, force: true }) };
}
const pages = (themeId?: string) => ({
  mode: 'presentation',
  ...(themeId ? { themeId } : {}),
  id: 'd',
  title: '数学',
  slides: [
    {
      id: 'slide-1',
      title: '表紙',
      layoutId: 'cover',
      notes: '',
      sources: [],
      design: { background: 'bg', elements: [t(64, 160, 832, 100, '数学の面白さ', 40)] },
    },
    {
      id: 'slide-2',
      title: '本文',
      layoutId: 'free',
      notes: '',
      sources: [],
      design: { elements: [t(56, 28, 848, 52, '本文', 28, 'title')] },
    },
  ],
});
const outline = (withPalette: boolean): Outline =>
  ({
    title: '数学',
    mode: 'presentation',
    assumptions: [],
    ...(withPalette ? { palette } : {}),
    slides: [
      { id: 'slide-1', title: '表紙', intent: '表紙', layoutId: 'cover', keyPoints: [] },
      { id: 'slide-2', title: '本文', intent: '本文', layoutId: 'free', keyPoints: [] },
    ],
  }) as Outline;

test("おまかせ: no preferred theme is sent, the AI's colours and fonts become the deck theme, and a made-up theme id is ignored", async () => {
  const f = await fixture(() => pages('ai'), outline(true));
  try {
    const session = await f.engine.create({ prompt: '2枚' }, []);
    await f.engine.generate(session.id);
    for (const input of f.requests) {
      assert.equal(input.preferences.preferredTheme, undefined);
      assert.equal(input.preferences.preferredDesign, undefined);
    }
    assert.equal(session.phase, 'ready', JSON.stringify(session.recovery));
    const deck = session.variants[0].deck;
    assert.equal(deck.themeId, AI_THEME_ID);
    assert.equal(
      deck.aiTheme!.headingFont,
      'Noto Serif JP',
      "the AI's font is kept; PowerPoint falls back to an installed 明朝 if missing",
    );
    assert.equal(deck.aiTheme!.font, 'Meiryo');
  } finally {
    await f.dispose();
  }
});

test('おまかせ without a palette from the AI: the deck is still made, with a notice', async () => {
  const f = await fixture(() => pages(), outline(false));
  try {
    const session = await f.engine.create({ prompt: '2枚' }, []);
    await f.engine.generate(session.id);
    assert.equal(session.phase, 'ready');
    assert.notEqual(session.variants[0].deck.themeId, AI_THEME_ID);
    assert.ok(
      session.warnings.some(w => w.includes('AIが配色を返さなかった')),
      JSON.stringify(session.warnings),
    );
  } finally {
    await f.dispose();
  }
});

test('fonts an AI names are kept (Japanese names of standard fonts become Windows names); a typography chosen by the user wins', () => {
  assert.equal(resolveFont('游ゴシック', 'x'), 'Yu Gothic');
  assert.equal(resolveFont('BIZ UDPゴシック', 'x'), 'BIZ UDPGothic');
  assert.equal(resolveFont('UDデジタル教科書体', 'x'), 'UD Digi Kyokasho NP');
  assert.equal(resolveFont('Georgia', 'x'), 'Georgia');
  assert.equal(resolveFont('Noto Sans JP', 'Yu Gothic'), 'Noto Sans JP');
  assert.equal(resolveFont('源ノ明朝', 'x'), '源ノ明朝');
  assert.equal(resolveFont(' ', 'Yu Gothic'), 'Yu Gothic');
  assert.equal(paletteTheme(palette, 'accessible').font, 'BIZ UDPGothic');
  assert.equal(paletteTheme({ ...palette, headingFont: undefined, bodyFont: undefined }).font, 'Yu Gothic Medium');
});

test('line breaks: short text breaks between phrases, a word keeps its okurigana/particle and a number its counter', () => {
  const wrap = (text: string, w: number, h: number, size: number) => measureText(text, { x: 0, y: 0, w, h }, size).text;
  assert.equal(
    wrap('例は大きな範囲まで確かめられているが、すべての偶数での証明はまだない', 294, 84, 18),
    '例は大きな範囲まで\n確かめられているが、すべての\n偶数での証明はまだない',
  );
  assert.equal(wrap('大きくなるほど素数はまばらになる', 248, 84, 18), '大きくなるほど\n素数はまばらになる');
  assert.equal(wrap('差が2の組は無限に続くのか。未解決', 248, 84, 18), '差が2の組は無限に\n続くのか。未解決');
  assert.equal(wrap('奇数本の点が0か2個なら一筆書きできる', 296, 56, 16), '奇数本の点が0か2個なら\n一筆書きできる');
  assert.equal(
    wrap('101の組が50個あるので、101×50で全体の和が求まる。', 230, 84, 15),
    '101の組が50個あるので、\n101×50で全体の和が求まる。',
    'a calculation stays on one line',
  );
  // Long running text still fills its lines, and never splits 確｜かめ or 2｜個.
  const long = wrapText(
    'この方法は大きな範囲まで確かめられていますが、すべての場合での証明はまだありません。2個の例外を除き、同じ条件で確認を続けています。'.repeat(
      2,
    ),
    280,
    16,
  );
  assert.ok(long.length >= 6);
  assert.ok(
    long.slice(0, -1).every(line => [...line].length >= 13),
    long.join('|'),
  );
  assert.ok(
    long.every((line, i) => !(/[\p{Script=Han}]$/u.test(line) && /^\p{Script=Hiragana}/u.test(long[i + 1] ?? ''))),
    long.join('|'),
  );
  assert.ok(
    long.every(line => !/\d$/.test(line)),
    long.join('|'),
  );
});
