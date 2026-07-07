/**
 * queen.test.ts — unit tests for the Queen tier (gate-ready-vs-escalate gate + loop).
 *
 * Run:  node --test --import tsx src/swarm/queen.test.ts
 *
 * Two load-bearing properties:
 *   1. the worker-guard throws when no worker is available (never silently no-op),
 *   2. stepLoop routes an over-cap payment to ESCALATION (verdict 'escalate'),
 *      never to execution — and the over-cap path NEVER returns a 'gate-ready' verdict.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Queen } from './queen';
import type { StreamSpec } from './streams';
import type { Task } from './worker';
import type { Action, StreamId } from './escalation';
import type { PaymentsMcp, SisVaultMcp } from './integrations';

/** A vault double that records appends without any real side effect. */
function fakeVault(appends: string[] = []): SisVaultMcp {
  return {
    async sis_append_entry(entry) {
      appends.push(`${entry.agent}:${entry.task}`);
      return { ok: true, id: 'test-entry' };
    },
    async sis_vault_search() {
      return [];
    },
    async sis_confirm() {
      return { ok: true };
    },
  };
}

function fakePayments(overrides: Partial<PaymentsMcp> = {}, calls: string[] = []): PaymentsMcp {
  return {
    async verify_mandate() {
      calls.push('verify_mandate');
      return { valid: true, reason: 'test mandate valid' };
    },
    async check_spend_cap() {
      calls.push('check_spend_cap');
      return { withinCap: true, cap: 100 };
    },
    async record_audit_entry() {
      calls.push('record_audit_entry');
      return { ok: true };
    },
    async require_human_approval(reason) {
      calls.push(`require_human_approval:${reason}`);
      return { pending: true };
    },
    ...overrides,
  };
}

/** Minimal payments stream spec with a worker mesh. */
function paymentsSpec(): StreamSpec {
  return {
    id: 'payments',
    label: 'Payments',
    purpose: 'test',
    queen: {
      name: 'Payments Queen',
      harness: ['queen-coordinator'],
      selfImprovingLoop: ['propose-charge', 'verify mandate', 'check cap'],
    },
    workers: [
      { name: 'mandate-verifier', skill: 'agentic-payments', does: 'verify mandate' },
      { name: 'spend-cap-enforcer', skill: 'agentic-payments', does: 'enforce caps' },
    ],
    mcp: [],
  };
}

/** A spec with an EMPTY worker mesh — for the worker-guard test. */
function emptySpec(): StreamSpec {
  return {
    id: 'content',
    label: 'Content',
    purpose: 'test',
    queen: { name: 'Content Queen', harness: [], selfImprovingLoop: ['draft'] },
    workers: [],
    mcp: [],
  };
}

/** Minimal products spec for cross-stream governance guard tests. */
function productsSpec(): StreamSpec {
  return {
    id: 'products',
    label: 'Products',
    purpose: 'test',
    queen: { name: 'Products Queen', harness: ['queen-coordinator'], selfImprovingLoop: ['package'] },
    workers: [{ name: 'packager', skill: 'agentic-products', does: 'package product' }],
    mcp: [],
  };
}

function action(stream: StreamId, partial: Partial<Action> & Pick<Action, 'kind'>): Action {
  return { stream, irreversible: false, movesMoney: false, crossStream: false, ...partial };
}

test('worker-guard throws when no worker is available', async () => {
  const queen = new Queen(emptySpec());
  const task: Task = { id: 'con-1', description: 'draft', proposes: action('content', { kind: 'draft' }) };
  await assert.rejects(
    () => queen.stepLoop([task], { vault: fakeVault() }),
    /No worker available to execute task: con-1/,
  );
});

test('stepLoop routes an over-cap payment to escalation, not execution', async () => {
  const queen = new Queen(paymentsSpec());
  const calls: string[] = [];
  const overCapTask: Task = {
    id: 'pay-over',
    worker: 'spend-cap-enforcer',
    description: 'settle OVER cap',
    proposes: action('payments', { kind: 'payment', movesMoney: true, amount: 500, cap: 100 }),
  };

  const payments = fakePayments(
    {
      async check_spend_cap() {
        calls.push('check_spend_cap');
        return { withinCap: false, cap: 100 };
      },
    },
    calls,
  );
  const result = await queen.stepLoop([overCapTask], { vault: fakeVault(), payments });

  assert.equal(result.decisions.length, 1);
  const decision = result.decisions[0];
  assert.equal(decision.verdict, 'escalate', 'over-cap must escalate, never become gate-ready');
  assert.notEqual(decision.verdict, 'gate-ready');
  assert.equal(decision.classification.decision, 'founder-board');
  assert.equal(calls.includes('record_audit_entry'), false, 'over-cap payment must not audit as gate-ready');
});

test('stepLoop keeps an in-cap payment at the queen only after verify, cap, and audit pass', async () => {
  const queen = new Queen(paymentsSpec());
  const calls: string[] = [];
  const inCapTask: Task = {
    id: 'pay-in',
    worker: 'mandate-verifier',
    description: 'settle within cap',
    proposes: action('payments', { kind: 'payment', movesMoney: true, amount: 40, cap: 100 }),
  };

  const result = await queen.stepLoop([inCapTask], { vault: fakeVault(), payments: fakePayments({}, calls) });
  const decision = result.decisions[0];
  assert.equal(decision.verdict, 'gate-ready');
  assert.equal(decision.classification.decision, 'queen-gate');
  assert.deepEqual(calls, ['verify_mandate', 'check_spend_cap', 'record_audit_entry']);
});

test('stepLoop enforces payment governance even when payment kind is mislabeled as not moving money', async () => {
  const queen = new Queen(paymentsSpec());
  const calls: string[] = [];
  const mislabeledTask: Task = {
    id: 'pay-kind-no-money-flag',
    worker: 'mandate-verifier',
    description: 'settle within cap but movesMoney flag is false',
    proposes: action('payments', { kind: 'payment', movesMoney: false, amount: 40, cap: 100 }),
  };

  const result = await queen.stepLoop([mislabeledTask], { vault: fakeVault(), payments: fakePayments({}, calls) });
  const decision = result.decisions[0];
  assert.equal(decision.verdict, 'gate-ready');
  assert.equal(decision.classification.decision, 'queen-gate');
  assert.deepEqual(calls, ['verify_mandate', 'check_spend_cap', 'record_audit_entry']);
});

test('stepLoop enforces payment governance for capital spend even when movesMoney is false', async () => {
  const queen = new Queen(paymentsSpec());
  const calls: string[] = [];
  const spendTask: Task = {
    id: 'pay-spend-no-money-flag',
    worker: 'spend-cap-enforcer',
    description: 'approve in-cap capital spend',
    proposes: action('payments', { kind: 'spend', movesMoney: false, amount: 10, cap: 100 }),
  };

  const result = await queen.stepLoop([spendTask], { vault: fakeVault(), payments: fakePayments({}, calls) });
  const decision = result.decisions[0];
  assert.equal(decision.verdict, 'gate-ready');
  assert.equal(decision.classification.decision, 'queen-gate');
  assert.deepEqual(calls, ['verify_mandate', 'check_spend_cap', 'record_audit_entry']);
});

test('stepLoop blocks capital spend from a non-payments queen when Payments MCP is unavailable', async () => {
  const queen = new Queen(productsSpec());
  const spendTask: Task = {
    id: 'prod-spend-no-mcp',
    worker: 'packager',
    description: 'buy product asset pack within cap',
    proposes: action('products', { kind: 'spend', movesMoney: false, amount: 10, cap: 100 }),
  };

  const result = await queen.stepLoop([spendTask], { vault: fakeVault() });
  const decision = result.decisions[0];
  assert.equal(decision.verdict, 'human');
  assert.equal(decision.classification.decision, 'human-gate');
  assert.match(decision.classification.reason, /Payments MCP unavailable/);
});

test('stepLoop blocks an in-cap payment when Payments MCP is missing', async () => {
  const queen = new Queen(paymentsSpec());
  const task: Task = {
    id: 'pay-no-mcp',
    worker: 'mandate-verifier',
    description: 'settle within cap without payments MCP',
    proposes: action('payments', { kind: 'payment', movesMoney: true, amount: 40, cap: 100 }),
  };

  const result = await queen.stepLoop([task], { vault: fakeVault() });
  const decision = result.decisions[0];
  assert.equal(decision.verdict, 'human');
  assert.equal(decision.classification.decision, 'human-gate');
  assert.match(decision.classification.reason, /Payments MCP unavailable/);
});

test('stepLoop blocks an in-cap payment when mandate verification fails', async () => {
  const queen = new Queen(paymentsSpec());
  const calls: string[] = [];
  const task: Task = {
    id: 'pay-invalid-mandate',
    worker: 'mandate-verifier',
    description: 'settle with invalid mandate',
    proposes: action('payments', { kind: 'payment', movesMoney: true, amount: 40, cap: 100 }),
  };

  const payments = fakePayments(
    {
      async verify_mandate() {
        calls.push('verify_mandate');
        return { valid: false, reason: 'signature mismatch' };
      },
    },
    calls,
  );
  const result = await queen.stepLoop([task], { vault: fakeVault(), payments });
  const decision = result.decisions[0];
  assert.equal(decision.verdict, 'human');
  assert.equal(decision.classification.decision, 'human-gate');
  assert.match(decision.classification.reason, /signature mismatch/);
  assert.equal(calls.includes('record_audit_entry'), false);
});

test('stepLoop blocks an in-cap payment when the audit write fails', async () => {
  const queen = new Queen(paymentsSpec());
  const calls: string[] = [];
  const task: Task = {
    id: 'pay-audit-fails',
    worker: 'mandate-verifier',
    description: 'settle but audit fails',
    proposes: action('payments', { kind: 'payment', movesMoney: true, amount: 40, cap: 100 }),
  };

  const payments = fakePayments(
    {
      async record_audit_entry() {
        calls.push('record_audit_entry');
        return { ok: false };
      },
    },
    calls,
  );
  const result = await queen.stepLoop([task], { vault: fakeVault(), payments });
  const decision = result.decisions[0];
  assert.equal(decision.verdict, 'human');
  assert.equal(decision.classification.decision, 'human-gate');
  assert.match(decision.classification.reason, /audit entry failed/);
  assert.equal(calls.some((call) => call.startsWith('require_human_approval')), true);
});

test('stepLoop blocks an in-cap payment when Payments MCP throws', async () => {
  const queen = new Queen(paymentsSpec());
  const task: Task = {
    id: 'pay-mcp-throws',
    worker: 'mandate-verifier',
    description: 'settle but payments MCP throws',
    proposes: action('payments', { kind: 'payment', movesMoney: true, amount: 40, cap: 100 }),
  };

  const payments = fakePayments({
    async verify_mandate() {
      throw new Error('transport down');
    },
  });
  const result = await queen.stepLoop([task], { vault: fakeVault(), payments });
  const decision = result.decisions[0];
  assert.equal(decision.verdict, 'human');
  assert.equal(decision.classification.decision, 'human-gate');
  assert.match(decision.classification.reason, /transport down/);
});

test('move-funds proposal routes to the human gate (verdict human)', async () => {
  const queen = new Queen(paymentsSpec());
  const task: Task = {
    id: 'pay-move',
    worker: 'mandate-verifier',
    description: 'move funds',
    proposes: action('payments', { kind: 'move-funds', movesMoney: true, irreversible: true }),
  };
  const result = await queen.stepLoop([task], { vault: fakeVault() });
  assert.equal(result.decisions[0].verdict, 'human');
});

test('decide() maps every classification tier to the right verdict', () => {
  const queen = new Queen(paymentsSpec());
  const mk = (a: Action) => queen.decide({ worker: 'w', stream: 'payments', taskId: 't', proposed: a, note: '' }).verdict;
  assert.equal(mk(action('content', { kind: 'draft' })), 'gate-ready'); // autonomous
  assert.equal(mk(action('affiliate', { kind: 'bind-link' })), 'gate-ready'); // queen-gate
  assert.equal(mk(action('payments', { kind: 'payment', movesMoney: true, amount: 500, cap: 100 })), 'escalate');
  assert.equal(mk(action('payments', { kind: 'move-funds' })), 'human');
});

test('task with an unknown worker hint falls back to the first worker (no throw)', async () => {
  const queen = new Queen(paymentsSpec());
  const task: Task = {
    id: 'pay-unknown',
    worker: 'does-not-exist',
    description: 'draft',
    proposes: action('payments', { kind: 'draft' }),
  };
  const result = await queen.stepLoop([task], { vault: fakeVault() });
  assert.equal(result.decisions[0].worker, 'mandate-verifier'); // first worker
});
