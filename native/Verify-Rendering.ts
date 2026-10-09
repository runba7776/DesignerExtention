/** Opt-in Windows integration check. Uses real PowerPoint and no model/API. */
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import { demoDeck, demoOutline } from '../server/demo';
import { createRenderBridge } from '../server/render-bridge';

const root = fileURLToPath(new URL('..', import.meta.url));
const bridge = createRenderBridge(root);
assert.ok(await bridge.nativeAvailable(), 'Build the Windows renderer first.');
const count=process.argv.includes('--expanded')?30:6;
const deck = demoDeck(demoOutline('図形文法とテーマのサンプル', 'presentation', [],count));
for (const theme of ['business', 'warm']) {
  const result = await bridge.render({ ...deck, themeId: theme }, theme);
  assert.equal(result.native, true);
  assert.equal(result.thumbnails.length, count);
  assert.deepEqual(result.warnings, []);
  const directory = path.join(bridge.artifactRoot, result.artifactId);
  assert.ok((await fs.stat(path.join(directory, 'presentation.pptx'))).size > 10000);
  for (let slide = 1; slide <= count; slide++) {
    const png = await fs.readFile(path.join(directory, `slide-${slide}.png`));
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
    assert.equal(png.readUInt32BE(16), 1600);
    assert.equal(png.readUInt32BE(20), 900);
  }
  console.log(JSON.stringify({ theme, directory, slides: count, warnings: result.warnings }));
}
