import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DeckSpec, Outline } from '../shared/contracts.js';
import { SessionEngine } from '../server/engine.js';
import { SettingsStore } from '../server/settings.js';
import { emptyUsage, parseJsonResponse, type CompletionRequest } from '../server/providers.js';
import { AppError } from '../server/errors.js';
import { improveTextFit } from '../shared/layout-selection.js';
import { fitProblems } from '../server/text-fit.js';
import { validateDeck } from '../server/validation.js';
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
const page = (id: string) =>
  id === 'slide-1'
    ? {
        id,
        title: '表紙',
        layoutId: 'cover',
        notes: '',
        sources: [],
        design: { elements: [t(64, 160, 832, 100, '表紙の題名', 40)] },
      }
    : {
        id,
        title: `${id}の題名`,
        layoutId: 'free',
        notes: '',
        sources: [],
        design: { elements: [t(56, 28, 848, 52, `${id}の題名`, 28, 'title'), t(56, 120, 848, 60, '本文', 18, 'body')] },
      };
const doc = (id: string, name: string): ParsedDocument => ({
  id,
  name,
  kind: 'txt',
  units: 1,
  characters: 10,
  warnings: [],
  sources: [{ id: `${id}:1`, locator: '行 1', text: `${name}の内容` }],
});
const usage = { ...emptyUsage(), calls: 1, inputTokens: 10, outputTokens: 10 };

test('the JSON inside a reply with a sentence around it is read; an unreadable reply keeps its text for recovery', () => {
  assert.deepEqual(parseJsonResponse('以下が結果です。\n{"kind":"outline","n":1}\n以上です。'), {
    kind: 'outline',
    n: 1,
  });
  assert.deepEqual(parseJsonResponse('結果：\n```json\n{"a":[1,2]}\n```\n確認してください'), { a: [1, 2] });
  assert.throws(
    () => parseJsonResponse('{"mode":"presentation","slides":[{"id":"slide-1"}'),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'INVALID_MODEL_JSON' &&
      (error as any).partialText.startsWith('{"mode"'),
  );
  assert.throws(() => parseJsonResponse('execute arbitrary code'), /形式/);
});

test('a designed text too long for its box gets room it can take, or smaller type when hemmed in, instead of asking an AI', () => {
  const words = '要点を三つの観点から整理し、次の四半期の判断材料にします。';
  const deck = validateDeck({
    id: 'd',
    title: 'x',
    mode: 'presentation',
    themeId: 'business',
    slides: [
      page('slide-1'),
      {
        ...page('slide-2'),
        design: {
          elements: [t(56, 28, 848, 52, 'slide-2の題名', 28, 'title'), t(56, 120, 300, 48, words, 20, 'body')],
        },
      },
    ],
  });
  assert.equal(fitProblems(deck).length, 1);
  // Free space beside it: the box grows (only as much as needed) and the size stays.
  const roomy = improveTextFit(deck).slides[1].design!.elements[1] as any;
  assert.equal(fitProblems(improveTextFit(deck)).length, 0);
  assert.equal(roomy.size, 20);
  assert.equal(roomy.text, words);
  assert.deepEqual([roomy.x, roomy.y], [56, 120]);
  assert.ok((roomy.w > 300 || roomy.h > 48) && roomy.w < 880 && roomy.y + roomy.h <= 496, JSON.stringify(roomy));
  // Hemmed in by a chart on the right and a text below: the type becomes smaller instead.
  const tight = validateDeck({
    ...deck,
    slides: [
      deck.slides[0],
      {
        ...page('slide-2'),
        design: {
          elements: [
            t(56, 28, 848, 52, 'slide-2の題名', 28, 'title'),
            t(56, 120, 300, 48, words, 20, 'body'),
            t(56, 172, 300, 40, '次の文', 16, 'body'),
            {
              t: 'chart',
              x: 360,
              y: 110,
              w: 500,
              h: 300,
              chart: { type: 'column', categories: ['A'], series: [{ name: 's', values: [1] }] },
            },
          ],
        },
      },
    ],
  });
  const small = improveTextFit(tight),
    text = small.slides[1].design!.elements[1] as any;
  assert.equal(fitProblems(small).length, 0);
  assert.ok(text.size < 20 && text.size >= 15, String(text.size));
  assert.equal(text.text, words);
  // Far too long for a box with no room around it: left for the AI, never shrunk below 75%.
  const long = validateDeck({
    ...deck,
    slides: [
      deck.slides[0],
      {
        ...page('slide-2'),
        design: {
          elements: [
            t(56, 28, 848, 52, 'slide-2の題名', 28, 'title'),
            t(56, 120, 200, 30, 'あ'.repeat(120), 20, 'body'),
            t(56, 160, 200, 30, '次の文', 16, 'body'),
            t(270, 120, 200, 30, '右の文', 16, 'body'),
          ],
        },
      },
    ],
  });
  assert.equal(fitProblems(improveTextFit(long)).length, 1);
});

test('an 11-page AI-designed deck: a broken reply keeps its finished pages, batches grow back, retries say exactly what to fix, and each batch gets only its documents', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'de-efficiency-'));
  try {
    const settings = await new SettingsStore(dir, '').load();
    await settings.update({ provider: 'local', model: 'mock', slideCount: 11, mode: 'presentation' });
    const a = doc('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '決算短信.txt'),
      b = doc('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'KPI.txt');
    const outline: Outline = {
      title: '11枚',
      mode: 'presentation',
      themeId: 'business',
      assumptions: [],
      visualStyle: '落ち着いた配色',
      slides: Array.from({ length: 11 }, (_, i) => ({
        id: `slide-${i + 1}`,
        title: `slide-${i + 1}の題名`,
        intent: '説明',
        layoutId: i ? 'free' : 'cover',
        keyPoints: [],
        ...(i ? { sourceIds: [i < 6 ? a.id : b.id] } : {}),
      })),
    };
    const targets: string[][] = [],
      documents: string[][] = [],
      repairs: any[] = [],
      budgets: number[] = [];
    const engine = new SessionEngine({
      settings,
      dataDir: dir,
      render: async () => ({ artifactId: 'x', pptxUrl: 'x', thumbnails: [], warnings: [], native: false }),
      providerFactory: () => ({
        complete: async (r: CompletionRequest) => {
          const input = JSON.parse(r.content),
            req = input.request;
          if (!req.targetSlides) return { text: JSON.stringify({ kind: 'outline', outline }), usage };
          const ids = req.targetSlides.map((s: any) => s.id);
          targets.push(ids);
          documents.push(input.documents.map((d: any) => d.name));
          repairs.push(req.repair);
          budgets.push(r.maxTokens);
          const reply = (slides: unknown[]) =>
            JSON.stringify({ mode: 'presentation', themeId: 'business', id: 'd', title: '11枚', slides });
          // The second batch breaks off inside its third page.
          if (targets.length === 2)
            return { text: reply(ids.slice(0, 2).map(page)).slice(0, -2) + ',{"id":"slide-6","title":"途', usage };
          // One page of a later batch has two text boxes on top of each other.
          if (ids[0] === 'slide-7' && ids.length === 2)
            return {
              text: reply([
                page('slide-7'),
                {
                  ...page('slide-8'),
                  design: {
                    elements: [
                      t(56, 28, 848, 52, 'slide-8の題名', 28, 'title'),
                      t(56, 120, 400, 60, '重なる本文A', 18),
                      t(60, 124, 400, 60, '重なる本文B', 18),
                    ],
                  },
                },
              ]),
              usage,
            };
          return { text: reply(ids.map(page)), usage };
        },
      }),
    });
    const session = await engine.create({ prompt: '11枚で' }, [a, b]);
    await engine.generate(session.id);
    assert.equal(session.phase, 'ready', JSON.stringify(session.recovery));
    assert.equal(session.variants[0].deck.slides.length, 11);
    assert.deepEqual(targets, [
      ['slide-1', 'slide-2', 'slide-3'],
      ['slide-4', 'slide-5', 'slide-6'],
      ['slide-6'],
      ['slide-7', 'slide-8'],
      ['slide-8'],
      ['slide-9', 'slide-10'],
      ['slide-11'],
    ]);
    assert.equal(session.usage.calls, 8, 'one plan and seven generation calls (the old path used eleven)');
    // Retries carry the app's finding with the page; the model's own words are not echoed back.
    assert.equal(repairs[2].reason, 'INVALID_MODEL_JSON');
    assert.equal(repairs[2].detail, undefined);
    assert.match(repairs[4].detail, /^slide-8：文字の枠が重なっています/);
    assert.ok(!repairs[4].detail.includes('重なる本文'));
    // Each batch receives the documents its pages name in the outline.
    assert.deepEqual(documents, [
      ['決算短信.txt'],
      ['決算短信.txt'],
      ['決算短信.txt'],
      ['KPI.txt'],
      ['KPI.txt'],
      ['KPI.txt'],
      ['KPI.txt'],
    ]);
    assert.ok(budgets.every(n => n <= 16_000));
    assert.equal(budgets[0], 15_000);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
