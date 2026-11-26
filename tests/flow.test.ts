import test from 'node:test';
import assert from 'node:assert/strict';
import { ABORTED_NOTICE, flowPhase, flowReducer, initialFlow, type FlowEvent } from '../web/flow';
import type { Session } from '../core/shared/contracts';

const session = (id: string, variants: string[], phase: Session['phase'] = 'ready') =>
  ({
    id,
    phase,
    variants: variants.map(v => ({ id: v })),
    messages: [],
    usage: {},
    warnings: [],
  }) as unknown as Session;
const run = (...events: FlowEvent[]) => events.reduce(flowReducer, initialFlow);

test('an operation starts clean, shows its steps, and ends with its error or a notice', () => {
  const started = run({ type: 'error', message: '前の失敗' }, { type: 'started', label: '作成しています' });
  assert.deepEqual([started.busy, started.error, started.notice], ['作成しています', '', '']);
  assert.equal(flowPhase(started), 'working');
  const step = flowReducer(started, { type: 'working', label: 'PowerPointで描画しています' });
  assert.equal(step.busy, 'PowerPointで描画しています');
  const failed = [{ type: 'failed', message: '接続できません' } as const, { type: 'finished' } as const].reduce(
    flowReducer,
    step,
  );
  assert.deepEqual([failed.busy, failed.error], ['', '接続できません']);
  assert.equal(flowPhase(failed), 'empty');
  assert.equal(run({ type: 'started', label: 'x' }, { type: 'aborted' }).notice, ABORTED_NOTICE);
});

test('the draft shown follows the presentation: kept while it exists, else the first one', () => {
  const opened = run({ type: 'opened', session: session('a', ['v1', 'v2']) });
  assert.equal(opened.selectedVariant, 'v1');
  const chosen = flowReducer(opened, { type: 'variantSelected', variantId: 'v2' });
  assert.equal(
    flowReducer(chosen, { type: 'updated', session: session('a', ['v1', 'v2', 'v3']) }).selectedVariant,
    'v2',
  );
  assert.equal(flowReducer(chosen, { type: 'updated', session: session('a', ['v3']) }).selectedVariant, 'v3');
  assert.equal(flowPhase(chosen), 'ready');
});

test('a copy fetched in the background replaces only the same presentation; clearing closes everything', () => {
  const open = run({ type: 'opened', session: { ...session('a', ['v1']), historyId: 'h' } as Session });
  assert.equal(flowReducer(open, { type: 'refreshed', session: session('b', ['x']) }), open);
  assert.equal(
    flowReducer(open, { type: 'refreshed', session: session('a', ['v1'], 'outline') }).session?.phase,
    'outline',
  );
  assert.equal(flowReducer(open, { type: 'unsaved' }).session?.historyId, undefined);
  const busy = [
    { type: 'slideSelected', slide: { id: 's', index: 0, variantId: 'v1' } } as const,
    { type: 'compared', index: 1 } as const,
    { type: 'started', label: '保存しています' } as const,
    { type: 'notice', message: '保存しました' } as const,
    { type: 'cleared' } as const,
  ].reduce(flowReducer, open);
  assert.deepEqual(busy, { ...initialFlow, busy: '保存しています' });
});
