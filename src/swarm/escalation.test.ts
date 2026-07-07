/**
 * escalation.test.ts — unit tests for the safety spine (classify + overCap).
 *
 * Run:  node --test --import tsx src/swarm/escalation.test.ts
 *
 * classify() is the single source of truth for "who decides". These tests cover
 * every branch and lock the fail-closed posture: a missing action, a missing
 * amount, or a missing cap must NEVER downgrade the decision tier.
 *
 * This is the load-bearing safety code. A regression here is a regression in the
 * whole money-and-irreversibility contract.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classify, requiresHuman, requiresPaymentGovernance } from './escalation';
import type { Action, ActionKind, StreamId } from './escalation';

/** Build an action with reversible / no-money defaults (mirrors index.ts helper). */
function action(stream: StreamId, partial: Partial<Action> & Pick<Action, 'kind'>): Action {
  return {
    stream,
    irreversible: false,
    movesMoney: false,
    crossStream: false,
    ...partial,
  };
}

test('normal worker task (draft) → autonomous', () => {
  const c = classify(action('content', { kind: 'draft' }));
  assert.equal(c.decision, 'autonomous');
  assert.deepEqual(c.gates, ['queen.review']);
});

test('read-only research → autonomous', () => {
  const c = classify(action('affiliate', { kind: 'research' }));
  assert.equal(c.decision, 'autonomous');
});

test('bind-link (binding, in-stream) → queen-gate', () => {
  const c = classify(action('affiliate', { kind: 'bind-link' }));
  assert.equal(c.decision, 'queen-gate');
  assert.deepEqual(c.gates, ['integrity-guard', 'claims-guard']);
});

test('schedule-post → queen-gate', () => {
  assert.equal(classify(action('content', { kind: 'schedule-post' })).decision, 'queen-gate');
});

test('build-page (in-stream) → queen-gate', () => {
  assert.equal(classify(action('products', { kind: 'build-page' })).decision, 'queen-gate');
});

test('in-cap payment → queen-gate (verify + cap + audit gates)', () => {
  const c = classify(action('payments', { kind: 'payment', movesMoney: true, amount: 40, cap: 100 }));
  assert.equal(c.decision, 'queen-gate');
  assert.deepEqual(c.gates, [
    'payments-mcp.verify_mandate',
    'payments-mcp.check_spend_cap',
    'payments-mcp.record_audit_entry',
  ]);
});

test('payment kind routes through payment gates even if movesMoney is false', () => {
  const c = classify(action('payments', { kind: 'payment', movesMoney: false, amount: 40, cap: 100 }));
  assert.equal(c.decision, 'queen-gate');
  assert.ok(c.gates.includes('payments-mcp.verify_mandate'));
  assert.equal(requiresPaymentGovernance(action('payments', { kind: 'payment', movesMoney: false })), true);
});

test('over-cap payment → founder-board (never auto-approve)', () => {
  const c = classify(action('payments', { kind: 'payment', movesMoney: true, amount: 500, cap: 100 }));
  assert.equal(c.decision, 'founder-board');
  assert.ok(c.gates.includes('founder.review'));
  assert.ok(c.gates.includes('human.approval'));
});

test('movesMoney without explicit payment kind still routes through payment gates', () => {
  // A `spend` that moves money in-cap is caught by the payment branch first.
  const c = classify(action('payments', { kind: 'spend', movesMoney: true, amount: 10, cap: 100 }));
  assert.equal(c.decision, 'queen-gate');
  assert.ok(c.gates.includes('payments-mcp.verify_mandate'));
});

test('move-funds → human-gate (irreversible money movement, always)', () => {
  const c = classify(action('payments', { kind: 'move-funds', movesMoney: true, irreversible: true }));
  assert.equal(c.decision, 'human-gate');
  assert.ok(c.gates.includes('payments-mcp.verify_mandate'));
  assert.ok(c.gates.includes('payments-mcp.check_spend_cap'));
  assert.ok(c.gates.includes('human.approval'));
});

test('move-funds is human-gate even without the explicit flags (kind alone is enough)', () => {
  // move-funds is in ALWAYS_IRREVERSIBLE — the kind alone forces the highest tier.
  const c = classify(action('payments', { kind: 'move-funds' }));
  assert.equal(c.decision, 'human-gate');
  assert.ok(c.gates.includes('payments-mcp.verify_mandate'));
  assert.equal(requiresPaymentGovernance(action('payments', { kind: 'move-funds' })), true);
});

test('each ALWAYS_IRREVERSIBLE kind → human-gate', () => {
  const kinds: ActionKind[] = ['delete', 'rename-url', 'rotate-key', 'send-blast', 'move-funds'];
  for (const kind of kinds) {
    const c = classify(action('content', { kind }));
    assert.equal(c.decision, 'human-gate', `${kind} must be human-gate`);
  }
});

test('explicit irreversible flag forces human-gate regardless of kind', () => {
  const c = classify(action('products', { kind: 'build-page', irreversible: true }));
  assert.equal(c.decision, 'human-gate');
});

test('new-rail → founder-board', () => {
  assert.equal(classify(action('payments', { kind: 'new-rail' })).decision, 'founder-board');
});

test('new-vendor → founder-board', () => {
  assert.equal(classify(action('products', { kind: 'new-vendor' })).decision, 'founder-board');
});

test('generic spend above cap → founder-board', () => {
  const c = classify(action('products', { kind: 'spend', amount: 9000, cap: 100 }));
  assert.equal(c.decision, 'founder-board');
  assert.ok(c.gates.includes('payments-mcp.check_spend_cap'));
});

test('generic spend within cap → queen-gate behind Payments MCP', () => {
  const c = classify(action('products', { kind: 'spend', amount: 10, cap: 100 }));
  assert.equal(c.decision, 'queen-gate');
  assert.deepEqual(c.gates, [
    'payments-mcp.verify_mandate',
    'payments-mcp.check_spend_cap',
    'payments-mcp.record_audit_entry',
  ]);
  assert.equal(requiresPaymentGovernance(action('products', { kind: 'spend', movesMoney: false })), true);
});

test('cross-stream action → founder-board (queens never command across streams)', () => {
  const c = classify(action('content', { kind: 'build-page', crossStream: true }));
  assert.equal(c.decision, 'founder-board');
  assert.deepEqual(c.gates, ['founder.review']);
});

/* ---------------------------------------------------------------- *
 * FAIL-CLOSED — the load-bearing invariants.
 * ---------------------------------------------------------------- */

test('FAIL-CLOSED: classify(null) → human-gate', () => {
  // @ts-expect-error — deliberately passing null to test the defensive guard.
  const c = classify(null);
  assert.equal(c.decision, 'human-gate');
});

test('FAIL-CLOSED: classify(undefined) → human-gate', () => {
  // @ts-expect-error — deliberately passing undefined to test the defensive guard.
  const c = classify(undefined);
  assert.equal(c.decision, 'human-gate');
});

test('FAIL-CLOSED: payment with MISSING amount → over-cap → founder-board', () => {
  const c = classify(action('payments', { kind: 'payment', movesMoney: true, cap: 100 }));
  assert.equal(c.decision, 'founder-board', 'a missing amount must be treated as over-cap');
});

test('FAIL-CLOSED: payment with MISSING cap → over-cap → founder-board', () => {
  const c = classify(action('payments', { kind: 'payment', movesMoney: true, amount: 40 }));
  assert.equal(c.decision, 'founder-board', 'a missing cap must be treated as over-cap');
});

test('FAIL-CLOSED: payment with NaN amount → over-cap → founder-board', () => {
  // NaN is typeof "number" yet NaN > cap is always false — a naive comparison
  // would wrongly read it as in-cap. overCap uses Number.isFinite to close that.
  const c = classify(action('payments', { kind: 'payment', movesMoney: true, amount: NaN, cap: 100 }));
  assert.equal(c.decision, 'founder-board', 'a NaN amount must be treated as over-cap');
});

test('FAIL-CLOSED: payment with NaN cap → over-cap → founder-board', () => {
  const c = classify(action('payments', { kind: 'payment', movesMoney: true, amount: 40, cap: NaN }));
  assert.equal(c.decision, 'founder-board', 'a NaN cap must be treated as over-cap');
});

test('requiresHuman follows the human.approval gate, including founder-board approvals', () => {
  assert.equal(requiresHuman(action('payments', { kind: 'move-funds' })), true);
  assert.equal(requiresHuman(action('content', { kind: 'draft' })), false);
  assert.equal(requiresHuman(action('payments', { kind: 'payment', movesMoney: true, amount: 500, cap: 100 })), true);
});
