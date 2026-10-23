import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm, symlink, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DesignLibraryStore } from '../server/design-library.js';
import { demoOutline, demoDeck } from '../server/demo.js';
import type { DeckSpec } from '../shared/contracts.js';

const example = () => demoDeck(demoOutline('秘密の売上報告', 'presentation', []));
const temporary = () => mkdtemp(path.join(tmpdir(), 'designer-style-library-'));

test('favorite designs retain only ordered visual metadata and survive restart without storing slide content', async () => {
  const dir = await temporary();
  try {
    const deck = example();
    deck.typographyId = 'accessible';
    deck.slides[1].notes = '秘密の説明';
    (deck as any).apiKey = 'secret-api-key';
    const store = new DesignLibraryStore(dir),
      saved = await store.save(deck, { thumbnail: '/api/artifacts/local-preview/slide-2.png' });
    assert.equal(saved.name, 'ペーパー · 6枚');
    assert.deepEqual(
      saved.layoutIds,
      deck.slides.map(slide => slide.layoutId),
    );
    assert.equal(saved.votes, 1);
    assert.equal(saved.typographyId, 'accessible');
    const raw = await readFile(path.join(dir, 'designs', saved.id + '.json'), 'utf8');
    assert.doesNotMatch(raw, /秘密|売上|apiKey|secret-api-key|sources|notes|items|documents|messages/);
    assert.deepEqual(await new DesignLibraryStore(dir).load(saved.id), saved);
    assert.deepEqual((await store.list()).entries, [saved]);
    assert.equal((await readdir(path.join(dir, 'designs'))).filter(name => name.endsWith('.tmp')).length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('repeated saving votes for an exact style while different sequence and single-slide styles remain distinct', async () => {
  const dir = await temporary();
  try {
    const store = new DesignLibraryStore(dir),
      deck = example(),
      first = await store.save(deck, { name: '好きな配置' });
    const same = structuredClone(deck);
    same.title = '別の内容';
    same.slides[1].title = '変更した文章';
    same.slides[1].notes = '保存しない内容';
    const repeat = await store.save(same);
    assert.equal(repeat.id, first.id);
    assert.equal(repeat.votes, 2);
    assert.equal(repeat.name, first.name);
    const reordered = structuredClone(deck);
    [reordered.slides[1], reordered.slides[2]] = [reordered.slides[2], reordered.slides[1]];
    const another = await store.save(reordered);
    assert.notEqual(another.id, first.id);
    const single = await store.save(deck, { slideId: deck.slides[1].id });
    assert.deepEqual(single.layoutIds, [deck.slides[1].layoutId]);
    assert.notEqual(single.id, first.id);
    assert.equal((await store.list()).entries.length, 3);
    assert.equal((await store.list()).entries[0].id, first.id);
    await assert.rejects(store.save(deck, { slideId: 'missing' }), /スライド/);
    await store.remove(single.id);
    assert.equal((await store.list()).entries.length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('votes serialize updates, clamp to supported bounds, and reject invalid changes without modifying storage', async () => {
  const dir = await temporary();
  try {
    const store = new DesignLibraryStore(dir),
      saved = await store.save(example());
    await Promise.all(Array.from({ length: 10 }, () => store.vote(saved.id)));
    assert.equal((await store.load(saved.id)).votes, 11);
    await assert.rejects(store.vote(saved.id, 500), /1回/);
    assert.equal((await store.load(saved.id)).votes, 11);
    await writeFile(path.join(dir, 'designs', saved.id + '.json'), JSON.stringify({ ...saved, votes: 10_000 }));
    assert.equal((await store.vote(saved.id)).votes, 10_000);
    await writeFile(path.join(dir, 'designs', saved.id + '.json'), JSON.stringify({ ...saved, votes: 0 }));
    assert.equal((await store.vote(saved.id, -1)).votes, 0);
    await store.remove(saved.id);
    await store.remove(saved.id);
    assert.equal((await store.list()).entries.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('style validation rejects unknown ids, external or traversal previews, oversized data and corrupted records', async () => {
  const dir = await temporary();
  try {
    const store = new DesignLibraryStore(dir),
      deck = example();
    for (const unsafe of [
      'https://outside.example/slide.png',
      '/api/artifacts/../slide-1.png',
      '/api/artifacts/a/slide-1.png?key=secret',
      '/api/artifacts/a/%2e%2e.png',
    ])
      await assert.rejects(store.save(deck, { thumbnail: unsafe }), /プレビュー/);
    await assert.rejects(store.save({ ...deck, themeId: '__proto__' }), /形式/);
    await assert.rejects(store.save({ ...deck, typographyId: 'unknown' }), /書体/);
    await assert.rejects(store.save({ ...deck, slides: [{ ...deck.slides[0], layoutId: 'unknown' }] }), /構図/);
    await assert.rejects(store.save(deck, { name: '名'.repeat(101) }), /100/);
    await assert.rejects(store.load('../settings'), /ID/);
    await assert.rejects(store.remove('-'.repeat(36)), /ID/);
    const saved = await store.save(deck),
      file = path.join(dir, 'designs', saved.id + '.json');
    await writeFile(file, JSON.stringify({ ...saved, mode: 'unknown' }));
    assert.equal((await store.list()).entries.length, 0);
    assert.equal((await store.list()).warnings.length, 1);
    await writeFile(file, 'x'.repeat(32 * 1024 + 1));
    await assert.rejects(store.load(saved.id), /読み取れません/);
    await writeFile(file, JSON.stringify({ ...saved, id: '00000000-0000-0000-0000-000000000000' }));
    await assert.rejects(store.load(saved.id), /破損/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('favorite store refuses a redirected managed directory and leaves external files intact', async () => {
  const dir = await temporary(),
    outside = await temporary();
  try {
    const outsideFile = path.join(outside, 'keep.txt');
    await writeFile(outsideFile, 'preserve');
    try {
      await symlink(outside, path.join(dir, 'designs'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error: any) {
      if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) return;
      throw error;
    }
    const store = new DesignLibraryStore(dir);
    await assert.rejects(store.save(example()), /保存先/);
    await assert.rejects(store.list(), /保存先/);
    await assert.rejects(store.remove('00000000-0000-0000-0000-000000000000'), /保存先/);
    assert.equal(await readFile(outsideFile, 'utf8'), 'preserve');
    assert.deepEqual(await readdir(outside), ['keep.txt']);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
