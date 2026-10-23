import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, readdir, rm, symlink, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HistoryStore } from '../server/history.js';
import { demoOutline, demoDeck } from '../server/demo.js';
import { emptyUsage } from '../server/providers.js';
import type { Session } from '../shared/contracts.js';

function ready(): Session {
  const outline = demoOutline('以前の資料', 'presentation', []);
  return {
    id: randomUUID(),
    phase: 'ready',
    provider: 'chat',
    messages: [{ role: 'user', text: '条件を保持' }],
    outline,
    variants: [{ id: 'a', label: '案 A', deck: demoDeck(outline) }],
    usage: emptyUsage(),
    warnings: [],
  };
}
const temporary = () => mkdtemp(path.join(tmpdir(), 'designer-history-versions-'));

test('content changes preserve previous revisions and loading an old revision does not overwrite current history', async () => {
  const dir = await temporary();
  try {
    const store = new HistoryStore(dir),
      session = ready(),
      original = await store.save(session, []);
    session.variants[0].deck.slides[1].title = '変更後の見出し';
    const revised = await store.save(session, [], original.id, original.revision);
    const versions = await store.versions(original.id);
    assert.deepEqual(
      versions.map(v => v.revision),
      [2, 1],
    );
    assert.equal(versions[0].slides, 6);
    assert.equal(versions[1].title, '以前の資料');
    const restored = await new HistoryStore(dir).loadVersion(original.id, 1);
    assert.equal(restored.session.variants[0].deck.slides[1].title, original.session.variants[0].deck.slides[1].title);
    assert.equal((await store.load(original.id)).session.variants[0].deck.slides[1].title, '変更後の見出し');
    assert.deepEqual(await store.loadVersion(original.id, 2), revised);
    await assert.rejects(store.save(session, [], original.id, original.revision), /別の画面/);
    await assert.rejects(store.loadVersion(original.id, 3), /見つかりません/);
    await assert.rejects(store.loadVersion(original.id, 0), /版番号/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('render, usage and reopen-only saves retain optimistic revision checks without empty content snapshots', async () => {
  const dir = await temporary();
  try {
    const store = new HistoryStore(dir),
      session = ready(),
      first = await store.save(session, []);
    session.id = randomUUID();
    session.usage.calls = 3;
    session.provider = 'local';
    session.variants[0].render = {
      artifactId: 'local-history',
      pptxUrl: '/api/artifacts/local-history/presentation.pptx',
      thumbnails: session.variants[0].deck.slides.map(
        (_, index) => `/api/artifacts/local-history/slide-${index + 1}.png`,
      ),
      warnings: [],
      native: true,
    };
    const rendered = await store.save(session, [], first.id, 1);
    assert.equal(rendered.revision, 2);
    assert.deepEqual(
      (await store.versions(first.id)).map(v => v.revision),
      [2],
    );
    session.variants[0].deck.themeId = 'midnight';
    const themed = await store.save(session, [], first.id, 2);
    assert.equal(themed.revision, 3);
    assert.deepEqual(
      (await store.versions(first.id)).map(v => v.revision),
      [3, 2],
    );
    assert.equal((await store.loadVersion(first.id, 2)).session.variants[0].deck.themeId, 'paper');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('versions retain at most 20 previous content states and deleting history keeps PowerPoint artifacts untouched', async () => {
  const dir = await temporary();
  try {
    const store = new HistoryStore(dir),
      session = ready();
    let saved = await store.save(session, []);
    for (let index = 0; index < 25; index++) {
      session.variants[0].deck.slides[1].title = '更新 ' + index;
      saved = await store.save(session, [], saved.id, saved.revision);
    }
    const versions = await store.versions(saved.id);
    assert.equal(versions.length, 21);
    assert.deepEqual(
      versions.map(v => v.revision),
      Array.from({ length: 21 }, (_, i) => 26 - i),
    );
    await assert.rejects(store.loadVersion(saved.id, 1), /見つかりません/);
    assert.equal((await readdir(path.join(dir, 'presentations', 'versions', saved.id))).length, 20);
    const artifact = path.join(dir, 'artifacts', 'keep.pptx');
    await mkdir(path.dirname(artifact), { recursive: true });
    await writeFile(artifact, 'original presentation');
    await store.remove(saved.id);
    assert.equal((await store.list()).entries.length, 0);
    assert.equal(await readFile(artifact, 'utf8'), 'original presentation');
    await assert.rejects(store.versions(saved.id), /見つかりません/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('history snapshots sanitize credentials and unfinished handoff metadata, and corrupt snapshots cannot replace current', async () => {
  const dir = await temporary();
  try {
    const store = new HistoryStore(dir),
      session = ready();
    (session as any).apiKey = 'never-store-key';
    session.chatHandoff = {
      requestId: 'transient-request',
      task: 'revise',
      service: 'chatgpt',
      instruction: '未完成のプロンプト',
    };
    const first = await store.save(session, []);
    session.variants[0].deck.slides[1].title = '新しい資料';
    await store.save(session, [], first.id, 1);
    const snapshot = path.join(dir, 'presentations', 'versions', first.id, '1.json'),
      text = await readFile(snapshot, 'utf8');
    assert.doesNotMatch(text, /never-store-key|apiKey|chatHandoff|未完成|transient-request/);
    assert.equal(JSON.parse(text).session.provider, 'chat');
    await writeFile(snapshot, 'invalid');
    assert.deepEqual(
      (await store.versions(first.id)).map(v => v.revision),
      [2],
    );
    await assert.rejects(store.loadVersion(first.id, 1), /破損/);
    assert.equal((await store.load(first.id)).revision, 2);
    await assert.rejects(store.loadVersion('../artifacts', 1), /ID/);
    await assert.rejects(store.save(session, [], first.id, Number.MAX_SAFE_INTEGER), /版番号/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('history refuses redirected version directories before reading, overwriting or deleting external files', async () => {
  const dir = await temporary(),
    outside = await temporary();
  try {
    const store = new HistoryStore(dir),
      session = ready(),
      first = await store.save(session, []),
      external = path.join(outside, '1.json');
    await writeFile(external, JSON.stringify(first));
    await mkdir(path.join(dir, 'presentations', 'versions'), { recursive: true });
    try {
      await symlink(
        outside,
        path.join(dir, 'presentations', 'versions', first.id),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    } catch (error: any) {
      if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) return;
      throw error;
    }
    session.variants[0].deck.slides[1].title = '書き込まない';
    await assert.rejects(store.save(session, [], first.id, 1), /保存先/);
    assert.equal((await store.load(first.id)).revision, 1);
    await assert.rejects(store.versions(first.id), /保存先/);
    await assert.rejects(store.remove(first.id), /保存先/);
    assert.deepEqual(JSON.parse(await readFile(external, 'utf8')), JSON.parse(JSON.stringify(first)));
    assert.equal((await store.load(first.id)).revision, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
