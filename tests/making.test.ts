import assert from 'node:assert/strict';
import test from 'node:test';
import { makingMethod, writerTraits } from '../shared/making.js';

test('how a page is written follows where the app runs and how the material is sent, not which AI writes', () => {
  const installed = { canReadHtml: true },
    noInstall = { canReadHtml: false };
  // The table in docs/system-design.md (2 全体構成, スライドの作り方).
  assert.equal(makingMethod({ provider: 'subscription', ...installed }), 'html');
  assert.equal(makingMethod({ provider: 'local', ...installed }), 'html');
  assert.equal(makingMethod({ provider: 'local', ...noInstall }), 'template');
  assert.equal(makingMethod({ provider: 'chat', ...installed }), 'coordinates');
  assert.equal(makingMethod({ provider: 'chat', ...noInstall }), 'coordinates');
  assert.equal(makingMethod({ provider: 'demo', ...installed }), 'template');
  // Another AI of the same session: what it writes follows that AI.
  assert.equal(makingMethod({ provider: 'subscription', writer: 'local', ...installed }), 'html');
  // Content kept on this PC: the design alone is asked for in coordinates.
  assert.equal(makingMethod({ provider: 'subscription', sendScope: 'design', ...installed }), 'coordinates');
  // The setting chooses coordinates or the template for every use; the sample stays on the template.
  for (const provider of ['subscription', 'local', 'chat'] as const)
    for (const where of [installed, noInstall]) {
      assert.equal(makingMethod({ provider, designMode: 'free', ...where }), 'coordinates');
      assert.equal(makingMethod({ provider, designMode: 'template', ...where }), 'template');
    }
  assert.equal(makingMethod({ provider: 'demo', designMode: 'free', ...installed }), 'template');
});

test('only a model on this PC is handled differently from the others', () => {
  assert.deepEqual(writerTraits('subscription'), writerTraits('chat'));
  assert.deepEqual(writerTraits('local'), {
    designRetries: 4,
    localGuide: true,
    keepsSmallText: true,
    remakesInLook: true,
    photos: false,
  });
  assert.equal(writerTraits('subscription').designRetries, 2);
  assert.equal(writerTraits('demo').photos, false);
});
