/**
 * experiments.test.ts — verdicts and the promotion ladder.
 *
 * Run:  node --test --import tsx src/managed-runtime/experiments.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { applyVerdict, canPromote, evaluateExperiment, experimentSchema } from './experiments';
import type { Experiment } from './experiments';

const base: Experiment = experimentSchema.parse({
  id: 'exp-r5-cadence',
  streamId: 'R5',
  hypothesis: 'Weekly output with receipts holds for twelve weeks.',
  metric: 'weeks_with_receipt_in_last_12',
  direction: 'higher-is-better',
  baseline: 0,
  threshold: 12,
  killBelow: 8,
  killBy: '2027-01-15T00:00:00Z',
});

test('no evidence or a non-finite value is inconclusive', () => {
  assert.equal(evaluateExperiment(base, { value: 12, observedAt: '2026-12-01T00:00:00Z', evidence: [] }), 'inconclusive');
  assert.equal(
    evaluateExperiment(base, { value: Number.NaN, observedAt: '2026-12-01T00:00:00Z', evidence: ['run-1'] }),
    'inconclusive',
  );
});

test('beating the threshold passes; missing it fails before the kill date', () => {
  assert.equal(evaluateExperiment(base, { value: 12, observedAt: '2026-12-01T00:00:00Z', evidence: ['e'] }), 'pass');
  assert.equal(evaluateExperiment(base, { value: 5, observedAt: '2026-12-01T00:00:00Z', evidence: ['e'] }), 'fail');
});

test('on or after the kill date, below the kill line kills', () => {
  assert.equal(evaluateExperiment(base, { value: 7, observedAt: '2027-01-15T00:00:00Z', evidence: ['e'] }), 'kill');
  assert.equal(evaluateExperiment(base, { value: 8, observedAt: '2027-01-15T00:00:00Z', evidence: ['e'] }), 'fail');
  assert.equal(evaluateExperiment(base, { value: 12, observedAt: '2027-02-01T00:00:00Z', evidence: ['e'] }), 'pass');
});

test('lower-is-better flips the comparisons', () => {
  const cost = experimentSchema.parse({
    ...base,
    id: 'exp-cost',
    direction: 'lower-is-better',
    baseline: 100,
    threshold: 50,
    killBelow: 150,
  });
  assert.equal(evaluateExperiment(cost, { value: 40, observedAt: '2026-12-01T00:00:00Z', evidence: ['e'] }), 'pass');
  assert.equal(evaluateExperiment(cost, { value: 160, observedAt: '2027-01-15T00:00:00Z', evidence: ['e'] }), 'kill');
});

test('applyVerdict updates status and appends evidence without duplicates', () => {
  const passed = applyVerdict(base, 'pass', ['run-1', 'run-1']);
  assert.equal(passed.status, 'passed');
  assert.deepEqual(passed.evidence, ['run-1']);
  const unchanged = applyVerdict(base, 'inconclusive', []);
  assert.equal(unchanged.status, 'proposed');
});

test('dry-run promotes to shadow with no experiment', () => {
  const decision = canPromote('dry-run', []);
  assert.equal(decision.ok, true);
  if (decision.ok) assert.equal(decision.to, 'shadow');
});

test('shadow needs a passed experiment to reach pilot', () => {
  assert.equal(canPromote('shadow', []).ok, false);
  assert.equal(canPromote('shadow', [base]).ok, false);
  const decision = canPromote('shadow', [applyVerdict(base, 'pass', ['e'])]);
  assert.equal(decision.ok, true);
  if (decision.ok) assert.equal(decision.to, 'pilot');
});

test('a killed experiment blocks promotion even beside a passed one', () => {
  const decision = canPromote('pilot', [applyVerdict(base, 'pass', ['e']), applyVerdict(base, 'kill', ['k'])]);
  assert.equal(decision.ok, false);
  if (!decision.ok) assert.match(decision.because, /killed experiment/);
});

test('standing and killed do not promote', () => {
  assert.equal(canPromote('standing', [applyVerdict(base, 'pass', ['e'])]).ok, false);
  assert.equal(canPromote('killed', [applyVerdict(base, 'pass', ['e'])]).ok, false);
});
