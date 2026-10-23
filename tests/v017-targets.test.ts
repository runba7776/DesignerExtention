import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Outline, Settings } from '../shared/contracts.js';
import { SessionEngine } from '../server/engine.js';
import { SettingsStore } from '../server/settings.js';
import { emptyUsage, type CompletionRequest } from '../server/providers.js';
import type { ParsedDocument } from '../server/document-model.js';

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
const usage = { ...emptyUsage(), calls: 1 };
const document: ParsedDocument = {
  id: '11111111-1111-4111-8111-111111111111',
  name: '業績メモ.txt',
  kind: 'txt',
  units: 1,
  characters: 40,
  warnings: [],
  sources: [{ id: 'd:1', locator: '行 1', text: '営業利益は4,812億円で、前年同期比12.5%増えた。' }],
};
const outline: Outline = {
  title: '業績の報告',
  mode: 'presentation',
  themeId: 'business',
  assumptions: [],
  slides: [
    { id: 'slide-1', title: '業績の報告', intent: '表紙', layoutId: 'cover', keyPoints: [] },
    { id: 'slide-2', title: '営業利益は4,812億円', intent: '本文', layoutId: 'free', keyPoints: [] },
  ],
};
const pages = (ai: string) => [
  {
    id: 'slide-1',
    title: '業績の報告',
    layoutId: 'cover',
    notes: '',
    sources: [],
    design: { elements: [t(64, 160, 832, 100, '業績の報告', 40)] },
  },
  {
    id: 'slide-2',
    title: '営業利益は4,812億円',
    layoutId: 'free',
    notes: '',
    sources: [{ documentId: document.id, locator: '行 1' }],
    design: {
      elements: [
        t(56, 28, 848, 52, '営業利益は4,812億円', 28, 'title'),
        t(56, 120, 848, 40, `前年同期比12.5%増（${ai}）`, 18, 'body'),
        {
          t: 'chart',
          x: 56,
          y: 200,
          w: 400,
          h: 220,
          chart: { type: 'column', categories: ['当期'], series: [{ name: '営業利益', values: [4812] }], unit: '億円' },
        },
      ],
    },
  },
];
/** A design AI that places every slot it is given, one under another. */
const designer = (request: any) => ({
  slides: request.slides.map((s: any) => ({
    id: s.id,
    design: {
      background: 'surface',
      elements: [
        ...s.slots.map((slot: any, i: number) => ({
          t: 'text',
          slot: slot.id,
          x: 56,
          y: 28 + i * 80,
          w: 848,
          h: slot.id === 't' ? 56 : 48,
          size: slot.id === 't' ? 28 : 18,
          ...(slot.id === 't' ? { role: 'title' } : {}),
        })),
        ...s.charts.map((c: any) => ({ t: 'chart', slot: c.id, x: 500, y: 200, w: 400, h: 250 })),
      ],
    },
  })),
});

async function fixture(update: Partial<Settings>, connected: string[]) {
  const dir = await mkdtemp(path.join(tmpdir(), 'de-targets-'));
  const settings = await new SettingsStore(dir, '').load();
  await settings.update({
    provider: 'subscription',
    subscriptionService: 'claude',
    model: 'auto',
    slideCount: 2,
    mode: 'presentation',
    themeId: 'business',
    ...update,
  });
  const calls: { ai: string; request: CompletionRequest }[] = [];
  let designReplies: string[] = [];
  const engine = new SessionEngine({
    settings,
    dataDir: dir,
    render: async () => ({ artifactId: 'x', pptxUrl: 'x', thumbnails: [], warnings: [], native: false }),
    subscriptionBinding: service => (connected.includes(service) ? `${service}:account` : undefined),
    providerFactory: current => ({
      complete: async (request: CompletionRequest) => {
        const ai = current.provider === 'local' ? 'local' : current.subscriptionService!;
        calls.push({ ai, request });
        const input = JSON.parse(request.content);
        if (input.request?.task === 'design')
          return { text: designReplies.shift() ?? JSON.stringify(designer(input.request)), usage };
        if (!input.request.targetSlides) return { text: JSON.stringify({ kind: 'outline', outline }), usage };
        return {
          text: JSON.stringify({
            mode: 'presentation',
            themeId: 'business',
            id: 'd',
            title: '業績の報告',
            slides: pages(ai),
          }),
          usage,
        };
      },
    }),
  });
  return {
    dir,
    engine,
    calls,
    setDesignReplies: (replies: string[]) => {
      designReplies = replies;
    },
    dispose: () => rm(dir, { recursive: true, force: true }),
  };
}

test('several AIs chosen at creation write drafts of the same outline at once, each with its own call budget', async () => {
  const f = await fixture({}, ['claude', 'chatgpt']);
  try {
    await assert.rejects(
      f.engine.create({ prompt: '2枚', targets: ['claude', 'chatgpt'] }, [document]),
      /Claude・ChatGPTへ指示・資料・会話を送ることを確認/,
    );
    await assert.rejects(
      f.engine.create({ prompt: '2枚', targets: ['claude', 'gemini'], cloudConsent: true }, [document]),
      /作成するAIを1〜3つ/,
    );
    const session = await f.engine.create({ prompt: '2枚', targets: ['chatgpt', 'claude'], cloudConsent: true }, [
      document,
    ]);
    assert.equal(session.provider, 'subscription');
    assert.equal(session.subscriptionService, 'chatgpt');
    assert.deepEqual(session.targets, ['chatgpt', 'claude']);
    assert.equal(f.calls[0].ai, 'chatgpt', 'the first AI plans the outline');
    await f.engine.generate(session.id);
    assert.equal(session.phase, 'ready');
    assert.deepEqual(
      session.variants.map(v => v.label),
      ['ChatGPT', 'Claude'],
    );
    assert.match((session.variants[1].deck.slides[1].design!.elements[1] as any).text, /claude/);
    assert.deepEqual(f.calls.map(c => c.ai).sort(), ['chatgpt', 'chatgpt', 'claude']);
    assert.match(session.messages.at(-1)!.text, /Claudeの案も同じ構成で作りました/);
  } finally {
    await f.dispose();
  }
});

test('an AI that is not connected cannot be chosen; the local LLM needs its model', async () => {
  const f = await fixture({}, ['claude']);
  try {
    await assert.rejects(
      f.engine.create({ prompt: '2枚', targets: ['claude', 'chatgpt'], cloudConsent: true }, [document]),
      /ChatGPTのアカウントに接続/,
    );
    await assert.rejects(
      f.engine.create({ prompt: '2枚', targets: ['local', 'claude'], sendScope: 'design' }, [document]),
      /ローカルLLMの接続先とモデル名/,
    );
  } finally {
    await f.dispose();
  }
});

test('nothing of the content leaves this PC: the local LLM writes it, the chosen cloud AI designs from the skeleton only', async () => {
  const f = await fixture({ localModel: 'qwen3:14b' }, ['claude']);
  try {
    await assert.rejects(
      f.engine.create({ prompt: '2枚', targets: ['claude'], sendScope: 'design' }, [document]),
      /ローカルLLMと、デザインを頼むAI/,
    );
    const session = await f.engine.create(
      { prompt: '業績を2枚で', targets: ['claude', 'local'], sendScope: 'design' },
      [document],
    );
    assert.equal(session.provider, 'local');
    assert.deepEqual(session.targets, ['local', 'claude']);
    assert.equal(f.calls[0].ai, 'local');
    await f.engine.generate(session.id);
    assert.equal(session.phase, 'ready');
    assert.deepEqual(
      session.variants.map(v => v.label),
      ['内容（ローカルLLM）', 'デザイン：Claude'],
    );
    const sent = f.calls
      .filter(c => c.ai === 'claude')
      .map(c => c.request.system + c.request.content)
      .join('\n');
    assert.ok(sent.length > 0);
    for (const secret of ['営業利益', '4,812', '4812', '12.5', '業績', '業績メモ'])
      assert.ok(!sent.includes(secret), `${secret} must not be sent`);
    // The designed draft holds the real content, filled in on this PC.
    const designed = session.variants[1].deck.slides[1];
    assert.equal(designed.design!.background, 'surface');
    assert.ok(designed.design!.elements.some(e => e.t === 'text' && e.text.startsWith('前年同期比12.5%増')));
    assert.deepEqual((designed.design!.elements.find(e => e.t === 'chart') as any).chart.series[0].values, [4812]);
    const log = (await readFile(path.join(f.dir, 'send-log.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line));
    assert.ok(log.every(r => r.task === 'design' && r.service === 'claude' && r.hits === 0));
  } finally {
    await f.dispose();
  }
});

test('a design-only request goes straight to a connected AI; a broken reply is retried there, with no copying', async () => {
  const f = await fixture({}, ['claude', 'chatgpt']);
  try {
    const session = await f.engine.create({ prompt: '2枚', targets: ['claude'], cloudConsent: true }, [document]);
    await f.engine.generate(session.id);
    f.setDesignReplies(['こちらです。{"slides":[{"id":"slide-1","design":{"elements":[']);
    const before = f.calls.length;
    await f.engine.requestDesign(session.id, { service: 'chatgpt', level: 'structure', direct: true });
    assert.equal(session.chatHandoff, undefined);
    assert.deepEqual(
      session.variants.map(v => v.label),
      ['Claude', 'デザイン：ChatGPT'],
    );
    // The broken batch is retried in smaller parts: slide-1, then slide-2.
    const design = f.calls.slice(before);
    assert.deepEqual(
      design.map(c => c.ai),
      ['chatgpt', 'chatgpt', 'chatgpt'],
    );
    assert.deepEqual(
      design.map(c =>
        JSON.parse(c.request.content)
          .request.slides.map((s: any) => s.id)
          .join(),
      ),
      ['slide-1,slide-2', 'slide-1', 'slide-2'],
    );
    assert.match(JSON.parse(design[1].request.content).issues[0], /JSONとして読めません/);
    assert.ok(!design.some(c => c.request.content.includes('営業利益')));
    assert.ok(session.variants[1].origin!.notes!.some(n => n.includes('返答の形式に不備')));
    // A second draft by another connected AI, written directly from the same outline.
    await f.engine.removeVariant(session.id, session.variants[1].id);
    await assert.rejects(
      f.engine.alternate(session.id, { service: 'chatgpt', direct: true }),
      /ChatGPTへ指示・資料・会話を送ることを確認/,
    );
    await f.engine.alternate(session.id, { service: 'chatgpt', direct: true, cloudConsent: true });
    assert.deepEqual(
      session.variants.map(v => v.label),
      ['Claude', 'ChatGPT'],
    );
  } finally {
    await f.dispose();
  }
});
