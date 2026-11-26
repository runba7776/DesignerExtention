import assert from 'node:assert/strict';
import test from 'node:test';
import { makingMethod, routeOf, writerName } from '../core/shared/route.js';

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
  const traits = (provider: Parameters<typeof routeOf>[0]) => {
    const { designRetries, localGuide, keepsSmallText, remakesInLook, refusesTitleOnlyPages, photos } =
      routeOf(provider);
    return { designRetries, localGuide, keepsSmallText, remakesInLook, refusesTitleOnlyPages, photos };
  };
  assert.deepEqual(traits('subscription'), traits('chat'));
  assert.deepEqual(traits('local'), {
    designRetries: 4,
    localGuide: true,
    keepsSmallText: true,
    remakesInLook: true,
    refusesTitleOnlyPages: true,
    photos: false,
  });
  assert.equal(routeOf('subscription').designRetries, 2);
  assert.equal(routeOf('demo').photos, false);
});

test('the route says how a session reaches its AI, in place of comparing provider names', () => {
  const pick = (provider: Parameters<typeof routeOf>[0], oneShot?: boolean) => {
    const r = routeOf(provider, { oneShot });
    return [
      r.drive,
      r.cloud,
      r.onThisPc,
      r.installedOnly,
      r.choosesTargets,
      r.choosesChatScope,
      r.offersDirections,
      r.fitsText,
    ];
  };
  assert.deepEqual(pick('subscription'), ['automatic', true, false, true, true, false, true, true]);
  assert.deepEqual(pick('local'), ['automatic', false, true, false, true, false, false, true]);
  assert.deepEqual(pick('chat'), ['handoff', false, false, false, false, true, true, true]);
  assert.deepEqual(pick('chat', true), ['handoff', false, false, false, false, true, false, true]);
  assert.deepEqual(pick('demo'), ['sample', false, false, false, false, false, false, false]);
  assert.equal(writerName(routeOf('subscription'), 'claude'), 'Claude');
  assert.equal(writerName(routeOf('subscription')), 'ChatGPT');
  assert.equal(writerName(routeOf('local')), 'ローカルLLM');
  assert.equal(writerName(routeOf('demo')), 'サンプル');
  assert.equal(writerName(routeOf('chat')), 'AI');
});
