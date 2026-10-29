import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HistoryStore, type HistoryCipher } from '../server/history.js';
import { protectedHistoryCipher } from '../server/history-cipher.js';
import { SessionEngine } from '../server/engine.js';
import { SettingsStore } from '../server/settings.js';
import { demoOutline, demoDeck } from '../server/demo.js';
import { emptyUsage } from '../server/providers.js';
import type { Session } from '../shared/contracts.js';

function ready(): Session {
  const outline = demoOutline('暗号化の確認', 'presentation', []);
  return {
    id: randomUUID(),
    phase: 'ready',
    provider: 'chat',
    messages: [{ role: 'user', text: '社外秘の売上見込み' }],
    outline,
    variants: [{ id: 'a', label: '案 A', deck: demoDeck(outline) }],
    usage: emptyUsage(),
    warnings: [],
  };
}
/** The same AES-256-GCM sealing as history-cipher.ts, with a key held in memory instead of DPAPI. */
function memoryCipher(key = randomBytes(32)): HistoryCipher {
  return {
    async seal(plain) {
      const iv = randomBytes(12),
        cipher = createCipheriv('aes-256-gcm', key, iv);
      const body = Buffer.concat([cipher.update(plain), cipher.final()]);
      return Buffer.concat([Buffer.from('TEST'), iv, cipher.getAuthTag(), body]);
    },
    async open(stored) {
      const decipher = createDecipheriv('aes-256-gcm', key, stored.subarray(4, 16));
      decipher.setAuthTag(stored.subarray(16, 32));
      return Buffer.concat([decipher.update(stored.subarray(32)), decipher.final()]);
    },
  };
}

test('history is encrypted on disk; history saved before is read, then encrypted once; without the key nothing is read', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'de-history-sealed-'));
  try {
    // Saved by a version without encryption: the current deck and one past version, as plain JSON.
    const plain = new HistoryStore(dir),
      session = ready(),
      first = await plain.save(session, []);
    session.variants[0].deck.slides[1].title = '変更後の見出し';
    await plain.save(session, [], first.id, 1);
    const current = path.join(dir, 'presentations', first.id + '.json'),
      past = path.join(dir, 'presentations', 'versions', first.id, '1.json');

    const engine = new SessionEngine({
      settings: await new SettingsStore(dir, '').load(),
      dataDir: dir,
      render: async () => ({ artifactId: 'x', pptxUrl: 'x', thumbnails: [], warnings: [], native: false }),
      historyCipher: memoryCipher(),
    });
    const sealed = engine.history;
    assert.equal((await sealed.load(first.id)).revision, 2, 'plain history is still read');
    assert.equal(await sealed.sealExisting(), 2);
    assert.equal(await sealed.sealExisting(), 0, 'already encrypted files are left alone');
    for (const file of [current, past]) {
      const stored = await readFile(file);
      assert.notEqual(stored[0], 0x7b);
      assert.ok(!stored.includes(Buffer.from('社外秘の売上見込み')), `${path.basename(file)} holds no plain text`);
    }
    assert.equal((await sealed.load(first.id)).session.variants[0].deck.slides[1].title, '変更後の見出し');
    assert.deepEqual(
      (await sealed.versions(first.id)).map(v => v.revision),
      [2, 1],
    );
    assert.equal((await sealed.loadVersion(first.id, 1)).session.messages[0].text, '社外秘の売上見込み');
    session.variants[0].deck.slides[1].title = '3版目';
    await sealed.save(session, [], first.id, 2);
    assert.notEqual((await readFile(current))[0], 0x7b, 'new saves are encrypted');

    // Without the key (another store, another key) or after tampering, the history cannot be read.
    await assert.rejects(new HistoryStore(dir).load(first.id), /破損/);
    await assert.rejects(new HistoryStore(dir, memoryCipher()).load(first.id), /破損/);
    assert.deepEqual((await new HistoryStore(dir).list()).entries, []);
    const stored = await readFile(current);
    stored[stored.length - 1] ^= 1;
    await writeFile(current, stored);
    await assert.rejects(sealed.load(first.id), /破損/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

const helper = fileURLToPath(new URL('../native/bin/DesignerExtension.Renderer.exe', import.meta.url));
test(
  'on Windows the history key is kept only as a DPAPI blob and is read back by a later start',
  { skip: process.platform !== 'win32' || !existsSync(helper) },
  async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'de-history-key-'));
    try {
      const sealed = await protectedHistoryCipher(dir).seal(Buffer.from('資料の本文'));
      const blob = await readFile(path.join(dir, 'history.key'));
      assert.ok(blob.length > 100, 'a DPAPI blob, not the 32-byte key');
      assert.equal((await protectedHistoryCipher(dir).open(sealed)).toString('utf8'), '資料の本文');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
