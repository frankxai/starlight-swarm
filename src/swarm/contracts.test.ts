import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify } from './escalation';
import {
  BENEVOLENCE_CHARTER,
  KERNEL_PIN,
  SUCCESS_CRITERIA,
  checkCharter,
  classify as classifyFromContracts,
  observatorySnapshot,
  parseHandContract,
} from './contracts';

test('contracts barrel re-exports the load-bearing surface', () => {
  const draft = classifyFromContracts({
    stream: 'content',
    kind: 'draft',
    irreversible: false,
    movesMoney: false,
    crossStream: false,
  });
  assert.equal(draft.decision, classify({
    stream: 'content',
    kind: 'draft',
    irreversible: false,
    movesMoney: false,
    crossStream: false,
  }).decision);
  assert.equal(BENEVOLENCE_CHARTER.clauses.length, 6);
  assert.equal(KERNEL_PIN.policy.live_funds, 'never');
  assert.ok(SUCCESS_CRITERIA.length >= 10);
  const nullVerdict = checkCharter(null);
  assert.equal(nullVerdict.floor, 'human-gate');
  assert.ok(nullVerdict.breaches.length > 0);
});

test('hand contract parser remains on the public surface', () => {
  assert.throws(() => parseHandContract({}), /schema_version|Required|invalid/i);
});

test('observatory snapshot is available from the contract kit', () => {
  const snap = observatorySnapshot();
  assert.equal(snap.admitted, false);
});
