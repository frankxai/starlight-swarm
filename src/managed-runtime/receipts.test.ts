/**
 * receipts.test.ts — canonical hashing, sealing, verification, tamper detection.
 *
 * Run:  node --test --import tsx src/managed-runtime/receipts.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { canonicalJson, sealReceipt, verifyReceipt, BASE_COMPOSED } from './receipts';
import type { ReceiptDraft } from './receipts';

function draft(overrides: Partial<ReceiptDraft> = {}): ReceiptDraft {
  return {
    runId: 'run-1',
    provider: 'dry-run',
    model: 'dry-run',
    agentId: 'agent-1',
    externalId: 'ext-1',
    status: 'dry-run',
    usage: { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 },
    costMicroUsd: 0,
    completed: false,
    outputText: '',
    startedAt: '2026-10-08T12:00:00.000Z',
    finishedAt: '2026-10-08T12:00:01.000Z',
    ...overrides,
  };
}

test('canonical JSON sorts keys recursively and is independent of insertion order', () => {
  const a = canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: 2 } });
  const b = canonicalJson({ a: { c: 2, d: [3, { y: 2, z: 1 }] }, b: 1 });
  assert.equal(a, b);
  assert.equal(a, '{"a":{"c":2,"d":[3,{"y":2,"z":1}]},"b":1}');
});

test('sealing produces a verifiable, frozen receipt with the attestation block', () => {
  const receipt = sealReceipt(draft({ composed: ['extra element'] }));
  assert.equal(verifyReceipt(receipt), true);
  assert.equal(receipt.attestation.builtOnSip, true);
  assert.equal(receipt.attestation.substrate, 'SIP');
  for (const element of BASE_COMPOSED) assert.ok(receipt.attestation.composed.includes(element));
  assert.ok(receipt.attestation.composed.includes('extra element'));
  assert.ok(Object.isFrozen(receipt));
  assert.ok(Object.isFrozen(receipt.usage));
  assert.match(receipt.digest, /^[0-9a-f]{64}$/);
});

test('the same draft seals to the same digest', () => {
  assert.equal(sealReceipt(draft()).digest, sealReceipt(draft()).digest);
});

test('any field change changes the digest and a tampered copy fails verification', () => {
  const receipt = sealReceipt(draft());
  const other = sealReceipt(draft({ costMicroUsd: 1 }));
  assert.notEqual(receipt.digest, other.digest);

  const tampered = { ...receipt, completed: true };
  assert.equal(verifyReceipt(tampered), false);
});

test('verification rejects shapes that are not receipts', () => {
  assert.equal(verifyReceipt(null), false);
  assert.equal(verifyReceipt({ runId: 'x' }), false);
  const receipt = sealReceipt(draft());
  assert.equal(verifyReceipt({ ...receipt, digest: 'f'.repeat(64) }), false);
});

test('completed:true with status dry-run is still structurally valid but is the adapter contract to avoid', () => {
  // The schema cannot know provider semantics; the adapters guarantee completed only on provider say-so.
  const receipt = sealReceipt(draft({ completed: true, status: 'completed' }));
  assert.equal(receipt.completed, true);
});

test('sealing rejects an invalid draft', () => {
  assert.throws(() => sealReceipt(draft({ costMicroUsd: -1 })));
  assert.throws(() => sealReceipt(draft({ startedAt: 'not a date' })));
});
