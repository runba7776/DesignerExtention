import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { updateRenderer } from '../server/render-bridge.js';

const SOURCES = ['Renderer.rsp', 'Renderer.cs', 'ChartIntegrity.cs'],
  BINARY = path.join('bin', 'DesignerExtension.Renderer.exe'),
  native = fileURLToPath(new URL('../native', import.meta.url)),
  HOUR = 3_600_000;

/** A native folder whose renderer was built at a known time, with its sources written an hour earlier. */
async function folder(copy = false) {
  const root = await mkdtemp(path.join(tmpdir(), 'de-renderer-')),
    built = new Date(Date.now() - 2 * HOUR),
    before = new Date(built.getTime() - HOUR);
  await mkdir(path.join(root, 'bin'));
  for (const file of SOURCES) {
    if (copy) await cp(path.join(native, file), path.join(root, file));
    else await writeFile(path.join(root, file), '');
    await utimes(path.join(root, file), before, before);
  }
  await writeFile(path.join(root, BINARY), '');
  await utimes(path.join(root, BINARY), built, built);
  return root;
}
const touch = (root: string, file: string) => utimes(path.join(root, file), new Date(), new Date());

test('a renderer newer than its sources is left as it is', async () => {
  const root = await folder();
  try {
    let builds = 0;
    assert.equal(await updateRenderer(root, async () => void builds++), undefined);
    assert.equal(builds, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('any source newer than the renderer builds it again', async () => {
  for (const file of SOURCES) {
    const root = await folder();
    try {
      await touch(root, file);
      const built: string[] = [];
      assert.equal(await updateRenderer(root, async at => void built.push(at)), undefined);
      assert.deepEqual(built, [root]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test('a renderer that could not be built is reported, and drawing goes on with the old one', async () => {
  const root = await folder();
  try {
    await touch(root, 'Renderer.cs');
    const warning = await updateRenderer(root, async () => {
      throw new Error('in use');
    });
    assert.match(warning ?? '', /更新前の描画部分.*Setup-DesignerExtension\.cmd/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test(
  'the real sources build a working renderer, and a running copy holds it until it ends',
  { skip: process.platform !== 'win32' },
  async () => {
    const root = await folder(true),
      binary = path.join(root, BINARY);
    try {
      await touch(root, 'Renderer.cs');
      assert.equal(await updateRenderer(root), undefined);
      const built = (await stat(binary)).mtimeMs;
      assert.ok(built > Date.now() - HOUR);
      // Not asked to build again.
      assert.equal(await updateRenderer(root), undefined);
      assert.equal((await stat(binary)).mtimeMs, built);
      // The new file runs (it waits for bytes to protect, in base64, and returns them protected).
      const protect = promisify(execFile)(binary, ['--protect'], { windowsHide: true });
      protect.child.stdin?.end('eA==');
      assert.ok((await protect).stdout.trim().length > 0);

      const running = spawn(binary, ['--protect'], { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
      await new Promise((resolve, reject) => running.once('spawn', resolve).once('error', reject));
      try {
        await touch(root, 'Renderer.cs');
        assert.match((await updateRenderer(root)) ?? '', /更新前の描画部分/);
      } finally {
        const ended = new Promise(resolve => running.once('exit', resolve));
        running.stdin.end();
        await ended;
      }
      assert.equal(await updateRenderer(root), undefined);
      assert.ok((await stat(binary)).mtimeMs > built);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
