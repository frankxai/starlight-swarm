/**
 * capabilities.test.ts — the IAM boundary, tested as enforcement rather than doctrine.
 *
 * Run:  node --test --import tsx src/swarm/capabilities.test.ts
 *
 * The load-bearing claims:
 *   1. a grant narrows and never widens (charter §13.2),
 *   2. a brokered handle refuses an ungranted tool loudly, never with a
 *      safe-looking placeholder a caller could mistake for a result,
 *   3. no seat outside Payments can reach the money surface, handle or not,
 *   4. every refusal lands in the ledger with a remedy attached.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ALL_CAPABILITIES,
  CapabilityRefusal,
  PAYMENTS_QUEEN_CAPABILITIES,
  QUEEN_CAPABILITIES,
  WORKER_CAPABILITIES,
  brokerPayments,
  brokerVault,
  ledgerAudit,
  makeGrant,
  queenGrant,
  workerGrant,
} from './capabilities';
import type { Capability } from './capabilities';
import { makeDryRunPayments, makeDryRunVault } from './integrations';
import { SwarmLedger } from './ledger';
import type { VaultEntry } from './integrations';

const silent = () => {};
const entry: VaultEntry = { agent: 'w', stream: 'content', task: 't', note: 'n', timestamp: '2026-01-01T00:00:00.000Z' };

test('no capability in the union settles or transfers funds', () => {
  // The runtime's standing hard stop, expressed where it can be enforced: if a
  // transfer tool is ever added, it has to be added to this union first, and
  // this test is the argument it has to win.
  for (const capability of ALL_CAPABILITIES) {
    assert.doesNotMatch(capability, /transfer|settle|send_funds|payout/, `${capability} must not be a money-moving capability`);
  }
});

test('a grant answers only for what it holds, and lists deterministically', () => {
  const grant = makeGrant('probe', ['vault.read', 'vault.append']);
  assert.equal(grant.has('vault.append'), true);
  assert.equal(grant.has('vault.confirm'), false);
  assert.deepEqual(grant.list(), ['vault.append', 'vault.read']);
  assert.deepEqual(makeGrant('other', ['vault.read', 'vault.append']).list(), grant.list());
});

test('restrict() narrows, and refuses to widen (charter §13.2)', () => {
  const queen = queenGrant('content', 'Content Queen');

  const worker = queen.restrict('writer', ['vault.append']);
  assert.deepEqual(worker.list(), ['vault.append']);
  assert.equal(worker.has('vault.read'), false);

  assert.throws(
    () => worker.restrict('sub-writer', ['vault.read']),
    (error: unknown) => error instanceof CapabilityRefusal && /never relaxed downward/.test(error.message),
    'a holder may not grant a capability it does not itself hold',
  );
});

test('a non-payments queen cannot even name a payments capability in a grant it issues', () => {
  const contentQueen = queenGrant('content', 'Content Queen');
  assert.deepEqual(contentQueen.list(), QUEEN_CAPABILITIES.slice().sort());
  assert.throws(() => contentQueen.restrict('distributor', ['payments.verify_mandate']), CapabilityRefusal);
});

test('only the Payments seat carries the money surface', () => {
  assert.deepEqual(queenGrant('payments', 'Payments Queen').list(), PAYMENTS_QUEEN_CAPABILITIES.slice().sort());
  for (const stream of ['affiliate', 'products', 'content'] as const) {
    const grant = queenGrant(stream, `${stream} queen`);
    for (const capability of ALL_CAPABILITIES.filter((c) => c.startsWith('payments.'))) {
      assert.equal(grant.has(capability), false, `${stream} must not hold ${capability}`);
    }
  }
});

test('a worker grant is append-only on every stream, including Payments', () => {
  assert.deepEqual(workerGrant('mandate-verifier').list(), WORKER_CAPABILITIES.slice().sort());
  const denied: Capability[] = ['vault.read', 'vault.confirm', 'payments.verify_mandate', 'payments.check_spend_cap'];
  for (const capability of denied) assert.equal(workerGrant('mandate-verifier').has(capability), false);
});

test('a brokered vault forwards a granted call and refuses an ungranted one', async () => {
  const vault = brokerVault(makeDryRunVault(silent), workerGrant('writer'));

  assert.deepEqual(await vault.sis_append_entry(entry), { ok: true, id: 'dry-run-entry' });
  await assert.rejects(() => vault.sis_vault_search('prior context'), CapabilityRefusal);
  await assert.rejects(() => vault.sis_confirm('id'), CapabilityRefusal);
});

test('a refusal throws rather than returning a placeholder a caller could misread', async () => {
  const vault = brokerVault(makeDryRunVault(silent), workerGrant('writer'));
  await assert.rejects(
    () => vault.sis_vault_search('anything'),
    (error: unknown) =>
      error instanceof CapabilityRefusal &&
      error.capability === 'vault.read' &&
      error.holder === 'writer' &&
      error.remedy.length > 0,
    'a denial carries the capability, the holder, and the move that clears it',
  );
});

test('holding a payments handle is not holding the payments grant', async () => {
  // The exact hole the previous version could not close: a handle passed to the
  // wrong seat was indistinguishable from a handle passed to the right one.
  const payments = brokerPayments(makeDryRunPayments(silent), queenGrant('content', 'Content Queen'));

  await assert.rejects(() => payments.verify_mandate({ signature: 'x', amount: 1, purpose: 'p' }), CapabilityRefusal);
  await assert.rejects(() => payments.check_spend_cap('content', 1), CapabilityRefusal);
  await assert.rejects(() => payments.record_audit_entry(entry), CapabilityRefusal);
  await assert.rejects(() => payments.require_human_approval('reason'), CapabilityRefusal);
});

test('the Payments Queen reaches all four verify-only tools', async () => {
  const payments = brokerPayments(makeDryRunPayments(silent), queenGrant('payments', 'Payments Queen'));

  assert.equal((await payments.verify_mandate({ signature: 'dry-run', amount: 40, purpose: 'p' })).valid, false);
  assert.equal((await payments.check_spend_cap('payments', 40)).withinCap, false);
  assert.equal((await payments.record_audit_entry(entry)).ok, true);
  assert.deepEqual(await payments.require_human_approval('over cap'), { pending: true });
});

test('every denial lands in the ledger with the remedy attached', async () => {
  const ledger = new SwarmLedger({ clock: () => '2026-01-01T00:00:00.000Z' });
  const vault = brokerVault(makeDryRunVault(silent), workerGrant('writer'), ledgerAudit(ledger, 'content'));

  await vault.sis_append_entry(entry);
  await assert.rejects(() => vault.sis_vault_search('prior context'));

  const denials = ledger.entriesOfKind('capability-denied');
  assert.equal(denials.length, 1, 'the allowed call is not a denial; the refused one is');
  assert.equal(denials[0].actor, 'writer');
  assert.equal(denials[0].subject, 'vault.read');
  assert.equal(denials[0].stream, 'content');
  assert.ok(String(denials[0].detail?.remedy).length > 0);
  assert.equal(ledger.verify().intact, true);
});
