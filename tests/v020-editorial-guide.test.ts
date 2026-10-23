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
import { EDITORIAL_GUIDE } from '../server/editorial-guide.js';

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
const outline: Outline = {
  title: '常設指示',
  mode: 'presentation',
  assumptions: [],
  slides: [
    { id: 'slide-1', title: '表紙', intent: '表紙', layoutId: 'cover', keyPoints: [] },
    { id: 'slide-2', title: '本文', intent: '本文', layoutId: 'free', keyPoints: [] },
  ],
} as Outline;

test('the standing instruction is about content and wording, never looks, and it is sent only when on', () => {
  assert.match(EDITORIAL_GUIDE, /構図・配色・書体などの見た目は指定しません/);
  assert.match(EDITORIAL_GUIDE, /アプリの指示を優先してください/);
  assert.match(EDITORIAL_GUIDE, /見直しの過程や結果は出力に含めず/);
  for (const task of ['plan', 'generate', 'revise'] as const) {
    assert.ok(freeSystemPrompt(task, { editorial: true }).includes(EDITORIAL_GUIDE), task);
    assert.ok(!freeSystemPrompt(task).includes('【常設指示】'), task);
  }
  assert.ok(
    freeSystemPrompt('generate', { editorial: true, format: 'html' }).includes(EDITORIAL_GUIDE),
    'the HTML method gets it too',
  );
});

test('the app sends the standing instruction by default and leaves it out when the setting is off', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'de-editorial-'));
  try {
    const settings = await new SettingsStore(dir, '').load();
    await settings.update({ provider: 'local', model: 'mock', slideCount: 2, mode: 'presentation' });
    assert.equal(settings.get().editorialGuide, true);
    await assert.rejects(settings.update({ editorialGuide: 'yes' }), /オン・オフ/);
    const systems: string[] = [];
    const engine = new SessionEngine({
      settings,
      dataDir: dir,
      render: async () => ({ artifactId: 'x', pptxUrl: 'x', thumbnails: [], warnings: [], native: false }),
      providerFactory: () => ({
        complete: async (r: CompletionRequest) => {
          systems.push(r.system);
          const req = JSON.parse(r.content).request;
          if (!req.targetSlides) return { text: JSON.stringify({ kind: 'outline', outline }), usage };
          return {
            text: JSON.stringify({
              mode: 'presentation',
              id: 'd',
              title: '常設指示',
              slides: [
                {
                  id: 'slide-1',
                  title: '表紙',
                  layoutId: 'cover',
                  notes: '',
                  sources: [],
                  design: { elements: [t(64, 160, 832, 100, '常設指示', 40)] },
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
            }),
            usage,
          };
        },
      }),
    });
    const on = await engine.create({ prompt: '2枚' }, []);
    await engine.generate(on.id);
    assert.ok(systems.length === 2 && systems.every(s => s.includes(EDITORIAL_GUIDE)), 'plan and generation');
    await settings.update({ editorialGuide: false });
    systems.length = 0;
    const off = await engine.create({ prompt: '2枚' }, []);
    await engine.generate(off.id);
    assert.ok(systems.length === 2 && systems.every(s => !s.includes('【常設指示】')));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
