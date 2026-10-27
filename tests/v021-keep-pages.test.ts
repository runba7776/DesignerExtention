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
const page = (id: string, broken = false) =>
  id === 'slide-1'
    ? {
        id,
        title: '表紙',
        layoutId: 'cover',
        notes: '',
        sources: [],
        design: { elements: [t(64, 160, 832, 100, '表紙', 40)] },
      }
    : {
        id,
        title: `${id}の題名`,
        layoutId: 'free',
        notes: '',
        sources: [],
        design: {
          elements: [
            t(56, 28, 848, 52, `${id}の題名`, 28, 'title'),
            ...(broken
              ? [t(56, 120, 400, 60, '重なるA', 18), t(60, 124, 400, 60, '重なるB', 18)]
              : [t(56, 120, 400, 60, '本文', 18)]),
          ],
        },
      };

test('a rejected page is asked again alone; the valid pages after it in the same reply are kept', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'de-keep-'));
  try {
    const settings = await new SettingsStore(dir, '').load();
    await settings.update({ provider: 'local', model: 'mock', slideCount: 5, mode: 'presentation' });
    const outline: Outline = {
      title: '5枚',
      mode: 'presentation',
      assumptions: [],
      slides: Array.from({ length: 5 }, (_, i) => ({
        id: `slide-${i + 1}`,
        title: i ? `slide-${i + 1}の題名` : '表紙',
        intent: '説明',
        layoutId: i ? 'free' : 'cover',
        keyPoints: [],
      })),
    } as Outline;
    const batches: string[][] = [];
    const engine = new SessionEngine({
      settings,
      dataDir: dir,
      render: async () => ({ artifactId: 'x', pptxUrl: 'x', thumbnails: [], warnings: [], native: false }),
      providerFactory: () => ({
        complete: async (r: CompletionRequest) => {
          const req = JSON.parse(r.content).request;
          if (!req.targetSlides) return { text: JSON.stringify({ kind: 'outline', outline }), usage };
          const ids = req.targetSlides.map((s: any) => s.id);
          batches.push(ids);
          return {
            text: JSON.stringify({
              mode: 'presentation',
              id: 'd',
              title: '5枚',
              slides: ids.map((id: string) => page(id, batches.length === 2 && id === 'slide-3')),
            }),
            usage,
          };
        },
      }),
    });
    const session = await engine.create({ prompt: '5枚' }, []);
    await engine.generate(session.id);
    assert.equal(session.phase, 'ready', JSON.stringify(session.recovery));
    assert.deepEqual(
      batches,
      [['slide-1', 'slide-2'], ['slide-3', 'slide-4'], ['slide-3'], ['slide-5']],
      'slide-4 from the second reply is kept',
    );
    assert.deepEqual(
      session.variants[0].deck.slides.map(s => s.id),
      ['slide-1', 'slide-2', 'slide-3', 'slide-4', 'slide-5'],
    );
    assert.equal(session.usage.calls, 5);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the chart limits the app checks are stated in both methods, and the HTML page is told to keep room above the footer', () => {
  assert.match(freeSystemPrompt('generate'), /項目は1〜8個、系列は1〜3個/);
  const html = freeSystemPrompt('generate', { format: 'html' });
  assert.match(html, /項目は1〜8個・系列は1〜3個/);
  assert.match(html, /上から470px程度までに収めて余裕を残し/);
});
