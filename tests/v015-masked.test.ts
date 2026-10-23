import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Session } from '../shared/contracts.js';
import { Masker } from '../shared/confidential.js';
import { SettingsStore } from '../server/settings.js';
import { SessionEngine } from '../server/engine.js';
import { demoOutline } from '../server/demo.js';
import type { ParsedDocument } from '../server/document-model.js';

const text =
  '上場会社名 ミライ精機株式会社。第3四半期の営業利益は4,812億円、前年同期比+12.5%。ロボット事業「アトラス計画」が牽引。問合せ ir@mirai.example.jp';
const document: ParsedDocument = {
  id: 'doc-1',
  name: 'ミライ精機_決算.pdf',
  kind: 'pdf',
  units: 1,
  characters: text.length,
  warnings: [],
  sources: [{ id: 'doc-1:1', locator: 'p.1', text }],
};
const originals = ['ミライ精機', '4,812億円', '+12.5%', 'アトラス計画', 'ir@mirai.example.jp'];

test('masker: names, terms, contacts and numbers become stable tokens and come back exactly', () => {
  const masker = new Masker(['アトラス計画']).learn([text]);
  const masked = masker.mask(text);
  for (const original of originals) assert.ok(!masked.includes(original), original);
  assert.equal(masker.mask('ミライ精機の4,812億円'), masker.mask('ミライ精機の4,812億円'), 'same original, same token');
  assert.equal(masker.unmaskDeep(masked).value, text.normalize('NFKC'));
  assert.deepEqual(masker.residual(JSON.stringify({ masked })), []);
  const restored = masker.unmaskDeep({ chart: { series: [{ name: '利益', values: [masker.mask('4812')] }] } });
  assert.deepEqual(restored.value.chart.series[0].values, [4812], 'a chart value given as a token becomes a number');
  assert.deepEqual(masker.unmaskDeep('【数値99】').unknown, ['【数値99】']);
});

test('a masked project sends tokens instead of names and numbers; replies are restored before validation', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'de-masked-'));
  try {
    const settings = await new SettingsStore(dir, '').load();
    await settings.update({ provider: 'chat', chatService: 'claude', mode: 'presentation', slideCount: 2 });
    const engine = new SessionEngine({
      settings,
      dataDir: dir,
      render: async () => ({ artifactId: 'x', pptxUrl: '/x.pptx', thumbnails: [], warnings: [], native: false }),
      providerFactory: () => {
        throw new Error('no provider');
      },
    });
    await assert.rejects(
      engine.updateProject(settings.get().activeProjectId!, { privacy: { mode: 'secret', terms: [] } }),
      /送る内容/,
    );
    await assert.rejects(
      engine.updateProject(settings.get().activeProjectId!, { privacy: { mode: 'masked', terms: ['x'.repeat(61)] } }),
      /60文字/,
    );
    await engine.updateProject(settings.get().activeProjectId!, {
      guidance: 'ミライ精機の社内向け',
      privacy: { mode: 'masked', terms: ['アトラス計画'] },
    });
    const session = await engine.create({ prompt: 'ミライ精機の決算を4,812億円を中心に説明' }, [document]);
    const instruction = session.chatHandoff!.instruction;
    for (const original of [...originals, 'ミライ'])
      assert.ok(!instruction.includes(original), `instruction must not contain ${original}`);
    assert.match(instruction, /【社名1】/);
    assert.match(instruction, /伏せ字について/);
    const privacy = session.chatHandoff!.privacy!;
    assert.equal(privacy.level, 'masked');
    assert.ok(privacy.masked! >= 5);
    assert.equal(privacy.hits, 0);
    assert.ok(privacy.items!.some(i => i.original === 'アトラス計画' && i.token.startsWith('【語')));
    const token = (original: string) => privacy.items!.find(i => i.original === original)!.token;
    const company = token('ミライ精機'),
      profit = token('4,812億円');
    const outline = demoOutline(`${company}の決算`, 'presentation', [], 2);
    outline.slides = outline.slides.map((s, i) => ({
      ...s,
      title: i ? `営業利益は${profit}` : `${company}の決算`,
      layoutId: i ? 'free' : 'cover',
    }));
    await engine.chatResponse(session.id, {
      requestId: session.chatHandoff!.requestId,
      response: JSON.stringify({ kind: 'outline', outline }),
    });
    assert.equal(session.outline!.title, 'ミライ精機の決算');
    assert.equal(session.outline!.slides[1].title, '営業利益は4,812億円');
    await engine.generate(session.id);
    const generateInstruction = session.chatHandoff!.instruction;
    assert.ok(!generateInstruction.includes('ミライ精機'));
    assert.ok(!generateInstruction.includes('4,812'));
    const reply = (slides: unknown[]) =>
      engine.chatResponse(session.id, {
        requestId: session.chatHandoff!.requestId,
        response: JSON.stringify({ mode: 'presentation', themeId: 'business', id: 'd', title: 'x', slides }),
      });
    const cover = {
      id: 'slide-1',
      title: `${company}の決算`,
      layoutId: 'cover',
      notes: '',
      sources: [],
      design: { elements: [{ t: 'text', x: 64, y: 160, w: 800, h: 120, text: `${company}の決算`, size: 40 }] },
    };
    const body = (value: string) => ({
      id: 'slide-2',
      title: `営業利益は${profit}`,
      layoutId: 'free',
      notes: `${token('アトラス計画')}が牽引`,
      sources: [{ documentId: 'doc-1', locator: 'p.1' }],
      design: {
        elements: [
          { t: 'text', x: 56, y: 28, w: 848, h: 52, text: `営業利益は${profit}`, size: 28, role: 'title' },
          {
            t: 'chart',
            x: 56,
            y: 120,
            w: 500,
            h: 300,
            chart: {
              type: 'column',
              categories: ['当期'],
              series: [{ name: '営業利益', values: [value] }],
              unit: '億円',
            },
          },
        ],
      },
    });
    await reply([cover, body('【数値99】')]);
    assert.match(session.chatHandoff!.validationIssues!.join(), /渡していない伏せ字/);
    await reply([cover, body(profit)]);
    assert.match(
      session.chatHandoff!.validationIssues!.join(),
      /グラフ|数値/,
      'a value with units cannot become a chart number',
    );
    await reply([
      cover,
      {
        ...body('0'),
        design: {
          elements: [{ t: 'text', x: 56, y: 28, w: 848, h: 52, text: `営業利益は${profit}`, size: 28, role: 'title' }],
        },
      },
    ]);
    assert.equal(session.phase, 'ready');
    const deck = session.variants[0].deck;
    assert.equal(deck.slides[0].title, 'ミライ精機の決算');
    assert.equal(deck.slides[1].notes.split('\n')[0], 'アトラス計画が牽引');
    assert.equal((deck.slides[1].design!.elements[0] as any).text, '営業利益は4,812億円');
    const log = (await readFile(path.join(dir, 'send-log.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line));
    assert.ok(log.every(r => r.level === 'masked' && r.hits === 0));
    assert.ok(!JSON.stringify(log).includes('ミライ'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
