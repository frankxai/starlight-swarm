/**
 * eval-harness.test.ts — tests for the thing that tests the spine.
 *
 * Run:  node --test --import tsx src/swarm/eval-harness.test.ts
 *
 * A harness that always passes is worse than no harness: it converts an unknown
 * into a false assurance. So the first job here is to prove the harness FAILS
 * when it should — on a wrong expectation, and on a property that a deliberately
 * broken decision path would violate. Only then does the shipped suite passing
 * mean anything.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { actionMatrix, evaluateGovernance, formatReport, observe, runInvariants, runScenario } from './eval-harness';
import type { GovernanceScenario } from './eval-harness';
import { GOVERNANCE_SCENARIOS } from './eval-scenarios';
import type { Action } from './escalation';

test('the shipped scenario suite passes and every invariant holds', () => {
  const report = evaluateGovernance(GOVERNANCE_SCENARIOS);

  assert.equal(report.scenarios.failed, 0, formatReport(report));
  assert.equal(report.invariants.failed, 0, formatReport(report));
  assert.equal(report.ok, true);
});

test('the suite is worth running: it covers the whole ladder and every clause disposition', () => {
  const report = evaluateGovernance(GOVERNANCE_SCENARIOS);
  const tiers = new Set(report.scenarios.results.map((r) => r.observed.effective));
  const verdicts = new Set(report.scenarios.results.map((r) => r.observed.verdict));

  for (const tier of ['autonomous', 'queen-gate', 'founder-board', 'human-gate']) {
    assert.ok(tiers.has(tier as never), `no scenario exercises the ${tier} tier`);
  }
  for (const verdict of ['act', 'escalate', 'human', 'refuse']) {
    assert.ok(verdicts.has(verdict as never), `no scenario exercises the ${verdict} verdict`);
  }
});

test('a wrong expectation fails, and says which field disagreed', () => {
  const wrong: GovernanceScenario = {
    id: 'deliberately-wrong',
    description: 'Claims that moving funds is autonomous. It is not.',
    action: { kind: 'move-funds', stream: 'payments', irreversible: true, movesMoney: true, crossStream: false },
    expect: { effective: 'autonomous', verdict: 'act' },
  };

  const result = runScenario(wrong);
  assert.equal(result.passed, false);
  assert.ok(result.mismatches.some((m) => /^effective: expected autonomous, observed human-gate$/.test(m)));
  assert.ok(result.mismatches.some((m) => /^verdict: expected act, observed human$/.test(m)));
});

test('a missing clause breach fails even when the tier is right', () => {
  const result = runScenario({
    id: 'tier-right-clause-missing',
    description: 'An in-cap payment does not breach the attribution clause.',
    action: { kind: 'payment', stream: 'payments', irreversible: false, movesMoney: true, crossStream: false, amount: 40, cap: 100 },
    expect: { effective: 'queen-gate', verdict: 'act', clauses: ['attribution'] },
  });

  assert.equal(result.passed, false);
  assert.ok(result.mismatches.some((m) => /clause attribution: expected among breaches/.test(m)));
});

test('the invariant sweep would catch a spine that lowered a gate', () => {
  // Rather than mutate the real modules, hand the sweep an action set built to
  // trip the property if the ordering in raiseTo() ever inverted. The point of
  // the assertion is that the property is EVALUATED at these points, not that
  // it happens to hold — a sweep over an empty matrix passes vacuously.
  const hardCases: Action[] = [
    { kind: 'move-funds', stream: 'payments', irreversible: true, movesMoney: true, crossStream: false },
    { kind: 'payment', stream: 'payments', irreversible: false, movesMoney: true, crossStream: false },
    { kind: 'delete', stream: 'content', irreversible: false, movesMoney: false, crossStream: true },
  ];
  const results = runInvariants(hardCases);

  assert.ok(results.length >= 9, 'every property runs on every sweep');
  for (const result of results) {
    assert.equal(result.checked, hardCases.length, `${result.id} did not evaluate the matrix it was given`);
    assert.equal(result.passed, true, `${result.id}: ${result.violations.join(' | ')}`);
  }
});

test('the action matrix spans every kind, stream, and safety-flag combination', () => {
  const matrix = actionMatrix();
  assert.ok(matrix.length > 2000, `matrix collapsed to ${matrix.length} actions`);

  const kinds = new Set(matrix.map((a) => a.kind));
  const streams = new Set(matrix.map((a) => a.stream));
  assert.equal(kinds.size, 14);
  assert.equal(streams.size, 4);
  assert.ok(matrix.some((a) => Number.isNaN(a.amount)), 'the NaN charge must stay in the sweep');
  assert.ok(matrix.some((a) => a.amount === undefined), 'the unquantified charge must stay in the sweep');
});

test('the report digest is stable across runs and moves when a verdict moves', () => {
  const first = evaluateGovernance(GOVERNANCE_SCENARIOS);
  const second = evaluateGovernance(GOVERNANCE_SCENARIOS);
  assert.equal(first.digest, second.digest, 'governance is not sampled — the same suite digests the same');

  const shortened = evaluateGovernance(GOVERNANCE_SCENARIOS.slice(0, 5));
  assert.notEqual(first.digest, shortened.digest);
});

test('observe() reports the real decision path, including the null proposal', () => {
  const nothing = observe(null);
  assert.equal(nothing.effective, 'human-gate');
  assert.equal(nothing.verdict, 'human');
  assert.ok(nothing.clauses.includes('fail-closed'));
});

test('formatReport leads with failures and never claims a pass on a red spine', () => {
  const failing = evaluateGovernance([
    {
      id: 'deliberately-wrong',
      description: 'Claims a deletion is autonomous.',
      action: { kind: 'delete', stream: 'products', irreversible: false, movesMoney: false, crossStream: false },
      expect: { effective: 'autonomous', verdict: 'act' },
    },
  ]);

  const text = formatReport(failing);
  assert.equal(failing.ok, false);
  assert.match(text, /✗ SCENARIO deliberately-wrong/);
  assert.match(text, /RESULT: FAIL/);
  assert.doesNotMatch(text, /RESULT: PASS/);
});
