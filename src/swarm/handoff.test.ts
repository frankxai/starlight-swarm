/**
 * handoff.test.ts — the artifact the human gate receives, and what invalidates it.
 *
 * Run:  node --test --import tsx src/swarm/handoff.test.ts
 *
 * The load-bearing claims:
 *   1. a refusal produces NO packet — you cannot escalate out of a refusal,
 *   2. a packet cannot launder a gate downward; the verifier re-derives it,
 *   3. an edited packet fails on its own digest,
 *   4. a packet that names no ledger entry is invalid however clean it looks.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { HANDOFF_SCHEMA_VERSION, formatHandoff, issueHandoff, verifyHandoff } from './handoff';
import type { HandoffPacket } from './handoff';
import { Queen } from './queen';
import { SwarmLedger } from './ledger';
import type { Action, StreamId } from './escalation';
import type { StreamSpec } from './streams';
import type { SisVaultMcp } from './integrations';
import type { Task } from './worker';

const clock = () => '2026-01-01T00:00:00.000Z';

function action(stream: StreamId, partial: Partial<Action> & Pick<Action, 'kind'>): Action {
  return { stream, irreversible: false, movesMoney: false, crossStream: false, ...partial };
}

function paymentsSpec(): StreamSpec {
  return {
    id: 'payments',
    label: 'Payments',
    purpose: 'test',
    queen: { name: 'Payments Queen', harness: [], selfImprovingLoop: ['propose-charge'] },
    workers: [{ name: 'mandate-verifier', skill: 'agentic-payments', does: 'verify mandate' }],
    mcp: [],
  };
}

function fakeVault(): SisVaultMcp {
  return {
    async sis_append_entry() {
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

async function stepWith(proposes: Action, charterContext = {}) {
  const ledger = new SwarmLedger({ clock });
  const queen = new Queen(paymentsSpec(), undefined, charterContext, { ledger, clock });
  const task: Task = { id: 'pay-1', worker: 'mandate-verifier', description: 'settle a charge', proposes };
  const result = await queen.stepLoop([task], { vault: fakeVault() });
  return { ledger, result };
}

test('an over-cap escalation issues a packet bound to its ledger entry', async () => {
  const { ledger, result } = await stepWith(action('payments', { kind: 'payment', movesMoney: true, amount: 500, cap: 100 }));

  assert.equal(result.handoffs.length, 1);
  const packet = result.handoffs[0];
  assert.equal(packet.schema_version, HANDOFF_SCHEMA_VERSION);
  assert.equal(packet.gate, 'founder-board');
  assert.equal(packet.origin.task_id, 'pay-1');
  assert.equal(packet.proposal.amount, 500);
  assert.ok(packet.outstanding_gates.includes('human.approval'));
  assert.equal(verifyHandoff(packet, ledger.entries()).valid, true);
});

test('a human-gate action issues a packet that asks a human to commit it', async () => {
  const { ledger, result } = await stepWith(action('payments', { kind: 'move-funds', movesMoney: true, irreversible: true }));

  const packet = result.handoffs[0];
  assert.equal(packet.gate, 'human-gate');
  assert.match(packet.requested_of_human, /commit it yourself/);
  assert.equal(verifyHandoff(packet, ledger.entries()).valid, true);
  assert.match(formatHandoff(packet), /HANDOFF handoff-[a-f0-9]{16} → HUMAN-GATE/);
});

test('an autonomous or queen-gated ruling issues nothing — nobody is being asked', async () => {
  const inCap = await stepWith(action('payments', { kind: 'payment', movesMoney: true, amount: 40, cap: 100 }));
  assert.deepEqual(inCap.result.handoffs, []);

  const draft = await stepWith(action('payments', { kind: 'draft' }));
  assert.deepEqual(draft.result.handoffs, []);
});

test('a refused proposal issues NO packet — a refusal is not escalatable', async () => {
  // The action would otherwise be the most escalation-worthy one there is.
  const { result } = await stepWith(action('payments', { kind: 'move-funds', movesMoney: true, irreversible: true }), {
    attributionOwed: ['unpaid-instrument'],
  });

  assert.equal(result.decisions[0].verdict, 'refuse');
  assert.deepEqual(result.handoffs, [], 'no approval request may be manufactured for a ledger defect');
});

test('editing a packet invalidates it on its own digest', async () => {
  const { ledger, result } = await stepWith(action('payments', { kind: 'payment', movesMoney: true, amount: 500, cap: 100 }));
  const tampered: HandoffPacket = { ...result.handoffs[0], requested_of_human: 'Just approve it.' };

  const verification = verifyHandoff(tampered, ledger.entries());
  assert.equal(verification.valid, false);
  assert.ok(verification.defects.some((d) => d.code === 'digest'));
});

test('a packet cannot launder a gate downward, even with a matching digest', async () => {
  // Re-bind the packet properly after downgrading the gate, so the ONLY thing
  // that catches it is the verifier re-deriving the tier from the proposal.
  const { ledger, result } = await stepWith(action('payments', { kind: 'move-funds', movesMoney: true, irreversible: true }));
  const original = result.handoffs[0];

  const downgraded = { ...original, gate: 'founder-board' as const };
  const { packet_id, content_digest_sha256, ...unbound } = downgraded;
  const { sha256Digest } = await import('./runtime-digest');
  const digest = sha256Digest(unbound);
  const rebound: HandoffPacket = { ...unbound, packet_id: `handoff-${digest.slice(0, 16)}`, content_digest_sha256: digest };

  const verification = verifyHandoff(rebound, ledger.entries());
  assert.equal(verification.valid, false);
  const downgrade = verification.defects.find((d) => d.code === 'gate-downgrade');
  assert.ok(downgrade, 'the verifier must re-derive the tier rather than trust the label');
  assert.match(downgrade.reason, /assesses at human-gate/);
});

test('a packet that binds to no ledger entry is invalid', async () => {
  const { result } = await stepWith(action('payments', { kind: 'payment', movesMoney: true, amount: 500, cap: 100 }));

  const verification = verifyHandoff(result.handoffs[0], []);
  assert.equal(verification.valid, false);
  const defect = verification.defects.find((d) => d.code === 'ledger-binding');
  assert.ok(defect);
  assert.match(defect.reason, /not on the record/);
});

test('a packet carrying a ledger defect is refused rather than approved', async () => {
  const { ledger, result } = await stepWith(action('payments', { kind: 'payment', movesMoney: true, amount: 500, cap: 100 }));

  // The same packet, verified in a context where a clause now refuses outright.
  const verification = verifyHandoff(result.handoffs[0], ledger.entries(), {
    claims: [{ statement: 'Fully autonomous revenue', backedBy: [] }],
  });
  assert.equal(verification.valid, false);
  assert.ok(verification.defects.some((d) => d.code === 'refusal-not-approvable'));
});

test('an unrecognised schema version is refused, not read', async () => {
  const { ledger, result } = await stepWith(action('payments', { kind: 'payment', movesMoney: true, amount: 500, cap: 100 }));
  const future = { ...result.handoffs[0], schema_version: 'starlight.swarm.handoff.v9' } as unknown as HandoffPacket;

  assert.ok(verifyHandoff(future, ledger.entries()).defects.some((d) => d.code === 'schema'));
});

test('every defect carries a remedy a human can act on (clause 5)', async () => {
  const { result } = await stepWith(action('payments', { kind: 'payment', movesMoney: true, amount: 500, cap: 100 }));
  const broken = { ...result.handoffs[0], outstanding_gates: [], schema_version: 'nope' } as unknown as HandoffPacket;

  const verification = verifyHandoff(broken, []);
  assert.ok(verification.defects.length >= 3);
  for (const defect of verification.defects) {
    assert.ok(defect.reason.trim().length > 0, `${defect.code} has no reason`);
    assert.ok(defect.remedy.trim().length > 0, `${defect.code} has no remedy`);
  }
});

test('the ledger records that a handoff was issued, bound to the decision entry', async () => {
  const { ledger, result } = await stepWith(action('payments', { kind: 'payment', movesMoney: true, amount: 500, cap: 100 }));

  const notes = ledger.entriesOfKind('note');
  assert.equal(notes.length, 1);
  assert.equal(notes[0].subject, result.handoffs[0].packet_id);
  assert.equal(notes[0].detail?.bound_to_ledger_seq, result.handoffs[0].ledger.seq);
  assert.equal(ledger.verify().intact, true);
});

test('issueHandoff is the only path, and it declines the two cases that must not produce one', () => {
  const ledger = new SwarmLedger({ clock });
  const queen = new Queen(paymentsSpec(), undefined, {}, { ledger, clock });
  const entry = ledger.append({ kind: 'decision', actor: 'Payments Queen', subject: 'pay-1', summary: 'test' });
  const origin = { queen: 'Payments Queen', worker: 'w', stream: 'payments', taskId: 'pay-1', task: 'test' };

  const acted = queen.decide({ worker: 'w', stream: 'payments', taskId: 'pay-1', proposed: action('payments', { kind: 'draft' }), note: '' });
  assert.equal(issueHandoff(acted, action('payments', { kind: 'draft' }), origin, entry, clock()), null);

  const refused = queen.decide(
    { worker: 'w', stream: 'payments', taskId: 'pay-1', proposed: action('payments', { kind: 'move-funds' }), note: '' },
    { exportable: false },
  );
  assert.equal(refused.verdict, 'refuse');
  assert.equal(issueHandoff(refused, action('payments', { kind: 'move-funds' }), origin, entry, clock()), null);
});
