/**
 * queen.test.ts — unit tests for the Queen tier (act-vs-escalate gate + loop).
 *
 * Run:  node --test --import tsx src/swarm/queen.test.ts
 *
 * Two load-bearing properties:
 *   1. the worker-guard throws when no worker is available (never silently no-op),
 *   2. stepLoop routes an over-cap payment to ESCALATION (verdict 'escalate'),
 *      never to execution — and the over-cap path NEVER returns an 'act' verdict.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Queen } from './queen';
import type { StreamSpec } from './streams';
import type { Task } from './worker';
import type { Action, StreamId } from './escalation';
import type { SisVaultMcp } from './integrations';

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
  const overCapTask: Task = {
    id: 'pay-over',
    worker: 'spend-cap-enforcer',
    description: 'settle OVER cap',
    proposes: action('payments', { kind: 'payment', movesMoney: true, amount: 500, cap: 100 }),
  };

  const result = await queen.stepLoop([overCapTask], { vault: fakeVault() });

  assert.equal(result.decisions.length, 1);
  const decision = result.decisions[0];
  assert.equal(decision.verdict, 'escalate', 'over-cap must escalate, never act');
  assert.notEqual(decision.verdict, 'act');
  assert.equal(decision.classification.decision, 'founder-board');
});

test('stepLoop keeps an in-cap payment at the queen (verdict act, queen-gate)', async () => {
  const queen = new Queen(paymentsSpec());
  const inCapTask: Task = {
    id: 'pay-in',
    worker: 'mandate-verifier',
    description: 'settle within cap',
    proposes: action('payments', { kind: 'payment', movesMoney: true, amount: 40, cap: 100 }),
  };

  const result = await queen.stepLoop([inCapTask], { vault: fakeVault() });
  const decision = result.decisions[0];
  assert.equal(decision.verdict, 'act');
  assert.equal(decision.classification.decision, 'queen-gate');
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
  assert.equal(mk(action('content', { kind: 'draft' })), 'act'); // autonomous
  assert.equal(mk(action('affiliate', { kind: 'bind-link' })), 'act'); // queen-gate
  assert.equal(mk(action('payments', { kind: 'payment', movesMoney: true, amount: 500, cap: 100 })), 'escalate');
  assert.equal(mk(action('payments', { kind: 'move-funds' })), 'human');
});

test('decide() fails closed: only autonomous/queen-gate ever earn the act verdict', () => {
  // Guards the last step of the pipeline. raiseTo() ranks an unrecognised tier as
  // maximally severe; a permissive `default` in the verdict switch would discard
  // that and hand back 'act'. Every tier except the two safe ones must not.
  const queen = new Queen(paymentsSpec());
  const decide = (a: Action) => queen.decide({ worker: 'w', stream: 'content', taskId: 't', proposed: a, note: '' });

  // The safe tiers still act.
  assert.equal(decide(action('content', { kind: 'draft' })).verdict, 'act');
  assert.equal(decide(action('affiliate', { kind: 'bind-link' })).verdict, 'act');

  // Nothing above queen-gate does, by any route into the switch.
  const escalating: Action[] = [
    action('payments', { kind: 'payment', movesMoney: true, amount: 500, cap: 100 }), // founder-board
    action('payments', { kind: 'payment', movesMoney: true }), // unquantified → charter floors to human
    action('content', { kind: 'delete' }), // commit-class
    action('content', { kind: 'build-page', crossStream: true }), // cross-stream
  ];
  for (const a of escalating) {
    const v = decide(a);
    assert.notEqual(v.verdict, 'act', `${a.kind} must not resolve to 'act' (effective: ${v.effective})`);
  }
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
