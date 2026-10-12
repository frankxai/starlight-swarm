/**
 * revenue-streams.test.ts — the portfolio validates, enforces the pilot cap,
 * and refuses figures without sources.
 *
 * Run:  node --test --import tsx src/managed-runtime/revenue-streams.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { REVENUE_STREAMS, KNOWN_CONNECTORS, MAX_PILOTS, validatePortfolio } from './revenue-streams';
import type { RevenueStreamInput } from './revenue-streams';

test('the proposed portfolio is valid and has ten unique streams', () => {
  const report = validatePortfolio();
  assert.deepEqual(report.problems, []);
  assert.equal(report.ok, true);
  assert.equal(report.streams.length, 10);
  assert.equal(new Set(report.streams.map((stream) => stream.id)).size, 10);
});

test('no stream in the proposed portfolio is in pilot yet; the board moves them', () => {
  assert.deepEqual(validatePortfolio().pilots, []);
});

test('every stream names at least one known connector and one workload class', () => {
  for (const stream of validatePortfolio().streams) {
    assert.ok(stream.connectors.length >= 1, `${stream.id} has no connectors`);
    for (const connector of stream.connectors) assert.ok(KNOWN_CONNECTORS.includes(connector));
    assert.ok(stream.workloads.length >= 1, `${stream.id} has no workloads`);
  }
});

test('the money-adjacent streams only use verify-only payment connectors', () => {
  const report = validatePortfolio();
  for (const stream of report.streams.filter((candidate) => candidate.swarmStream === 'payments')) {
    for (const connector of stream.connectors) {
      assert.ok(!/stripe-transfer|custody|move-funds/.test(connector), `${stream.id} names a settlement connector`);
    }
  }
});

test('more than three pilots fails the portfolio rule', () => {
  const inputs: RevenueStreamInput[] = REVENUE_STREAMS.map((stream, index) =>
    index < MAX_PILOTS + 1 ? { ...stream, stage: 'pilot' } : stream,
  );
  const report = validatePortfolio(inputs);
  assert.equal(report.ok, false);
  assert.ok(report.problems.some((problem) => /in pilot/.test(problem)));
  assert.equal(report.pilots.length, MAX_PILOTS + 1);
});

test('exactly three pilots is allowed', () => {
  const inputs: RevenueStreamInput[] = REVENUE_STREAMS.map((stream, index) =>
    index < MAX_PILOTS ? { ...stream, stage: 'pilot' } : stream,
  );
  assert.equal(validatePortfolio(inputs).ok, true);
});

test('duplicate ids and unknown connectors are reported', () => {
  const [first, second] = REVENUE_STREAMS;
  const report = validatePortfolio([
    first,
    { ...second, id: first.id },
    { ...second, id: 'RX', connectors: ['not-a-connector' as never] },
  ]);
  assert.equal(report.ok, false);
  assert.ok(report.problems.some((problem) => /duplicate id/.test(problem)));
  assert.ok(report.problems.some((problem) => problem.startsWith('RX:')));
});

test('a target without a source or date fails validation', () => {
  const [first] = REVENUE_STREAMS;
  const report = validatePortfolio([
    { ...first, targets: [{ metric: 'mrr', value: 1, unit: 'EUR', source: '', setOn: '2026-10-08' }] },
  ]);
  assert.equal(report.ok, false);
  const good = validatePortfolio([
    { ...first, targets: [{ metric: 'mrr', value: 1, unit: 'EUR', source: 'owner-set placeholder', setOn: '2026-10-08' }] },
  ]);
  assert.equal(good.ok, true);
});
