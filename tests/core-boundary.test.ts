import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../core', import.meta.url));
async function sources(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(e => (e.isDirectory() ? sources(path.join(dir, e.name)) : [path.join(dir, e.name)])),
  );
  return nested.flat().filter(f => f.endsWith('.ts'));
}

test('the engine in core/ depends on no host: not on server/ or web/, and not on a file system of its own', async () => {
  const files = await sources(root);
  assert.ok(files.length > 60);
  for (const file of files) {
    const text = await readFile(file, 'utf8'),
      name = path.relative(root, file);
    for (const [, spec] of text.matchAll(/from\s+'([^']+)'/g)) {
      if (!spec.startsWith('.')) continue;
      const target = path.relative(root, path.resolve(path.dirname(file), spec));
      assert.ok(!target.startsWith('..'), `${name} imports ${spec} from outside core/`);
    }
    // Files go through core/storage.ts, which the host chooses.
    if (name !== 'storage.ts')
      assert.doesNotMatch(text, /from 'node:fs(\/promises)?'|from 'node:child_process'/, `${name} uses a file system`);
  }
});
