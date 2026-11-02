/**
 * budget.test.ts — reservations are fail-closed and settle honestly.
 *
 * Run:  node --test --import tsx src/managed-runtime/budget.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { reserveBudget, settleBudget, microUsdToCentsString, centsStringToMicroUsd } from './budget';

const ids = { reservationId: 'res-1', runId: 'run-1', workspaceId: 'ws' };
const policy = { stream: 'content' as const, limitMicroUsd: 10_000_000, perRunCapMicroUsd: 3_000_000 };
const at = new Date('2026-10-08T12:00:00Z');

test('under both caps the reservation is autonomous', () => {
  const result = reserveBudget(policy, 1_000_000, 2_000_000, ids, at);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.classification.decision, 'autonomous');
    assert.equal(result.reservation.reservedMicroUsd, 2_000_000);
    assert.equal(result.reservation.spentMicroUsdBefore, 1_000_000);
    assert.equal(result.reservation.reservedAt, at.toISOString());
  }
});

test('over the per-run cap escalates to founder-board', () => {
  const result = reserveBudget(policy, 0, 3_000_001, ids, at);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.classification.decision, 'founder-board');
    assert.match(result.reason, /exceeds effective cap 3000000/);
  }
});

test('over the remaining period budget escalates even when under the per-run cap', () => {
  const result = reserveBudget(policy, 9_000_000, 2_000_000, ids, at);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /remaining 1000000/);
});

test('exactly at the cap is allowed', () => {
  const result = reserveBudget(policy, 7_000_000, 3_000_000, ids, at);
  assert.equal(result.ok, true);
});

test('non-finite inputs fail closed', () => {
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
    const result = reserveBudget(policy, 0, bad, ids, at);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /not finite/);
  }
  const badLimit = reserveBudget({ ...policy, limitMicroUsd: Number.NaN }, 0, 100, ids, at);
  assert.equal(badLimit.ok, false);
});

test('zero and fractional reservation amounts are rejected', () => {
  assert.equal(reserveBudget(policy, 0, 0, ids, at).ok, false);
  assert.equal(reserveBudget(policy, 0, 1.5, ids, at).ok, false);
});

test('settlement reports overrun instead of absorbing it', () => {
  const reserved = reserveBudget(policy, 500, 1_000, ids, at);
  assert.equal(reserved.ok, true);
  if (!reserved.ok) return;
  const settlement = settleBudget(reserved.reservation, 1_250);
  assert.equal(settlement.overrunMicroUsd, 250);
  assert.equal(settlement.spentMicroUsdAfter, 1_750);
  const under = settleBudget(reserved.reservation, 300);
  assert.equal(under.overrunMicroUsd, 0);
});

test('settlement rejects negative or fractional actuals', () => {
  const reserved = reserveBudget(policy, 0, 1_000, ids, at);
  if (!reserved.ok) throw new Error('setup');
  assert.throws(() => settleBudget(reserved.reservation, -1), /non-negative integer/);
  assert.throws(() => settleBudget(reserved.reservation, 1.1), /non-negative integer/);
});

test('micro-USD and cents strings convert both ways, rounding up to the next cent', () => {
  assert.equal(microUsdToCentsString(2_000_000), '200');
  assert.equal(microUsdToCentsString(1), '1');
  assert.equal(microUsdToCentsString(0), '0');
  assert.equal(centsStringToMicroUsd('200'), 2_000_000);
  assert.throws(() => centsStringToMicroUsd('01'), /integer decimal string/);
  assert.throws(() => centsStringToMicroUsd('1.5'), /integer decimal string/);
  assert.throws(() => microUsdToCentsString(-5), /non-negative/);
});
