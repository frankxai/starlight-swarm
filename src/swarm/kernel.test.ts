import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  KERNEL_PIN,
  canonicalL6,
  deprecatedMembers,
  kernelMembers,
  kernelOverview,
  kernelRing,
  memberById,
} from './kernel';

test('policy rejects a monorepo merge and live funds', () => {
  assert.equal(KERNEL_PIN.policy.monorepo, 'rejected');
  assert.equal(KERNEL_PIN.policy.live_funds, 'never');
  assert.equal(KERNEL_PIN.policy.activation, 'report-only');
});

test('exactly one canonical L6 — this repository', () => {
  const l6 = canonicalL6();
  assert.equal(l6.repo, 'frankxai/starlight-swarm');
  assert.equal(l6.id, 'swarm');
  assert.equal(l6.inKernel, true);
});

test('kernel members keep distinct repos — no silent merge', () => {
  const repos = kernelMembers().map((m) => m.repo);
  assert.equal(new Set(repos).size, repos.length);
  for (const m of kernelMembers()) {
    assert.match(m.url, /^https:\/\/github.com\//);
    assert.ok(m.role.length > 8);
    assert.ok(m.wiring.length > 12);
    assert.ok(m.next.length > 8);
  }
});

test('payments stays verify-only and names no transfer tool', () => {
  const payments = memberById('payments');
  assert.ok(payments);
  assert.equal(payments.posture, 'mcp-stdio');
  assert.match(payments.wiring, /No transfer tool/);
  assert.doesNotMatch(payments.wiring, /\b(pay|settle|move_funds)\b/i);
});

test('SIS remains a stub until the gateway lands', () => {
  const sis = memberById('sis');
  assert.ok(sis);
  assert.equal(sis.posture, 'stub');
  assert.match(sis.next, /#10/);
});

test('deprecated swarm-bus is not in the kernel ring', () => {
  const dead = deprecatedMembers();
  assert.equal(dead.length, 1);
  assert.equal(dead[0].id, 'swarm-bus-deprecated');
  assert.ok(!kernelRing().some((m) => m.id === 'swarm-bus-deprecated'));
});

test('kernel overview is JSON-serializable and omits inKernel flags as authority', () => {
  const view = kernelOverview();
  assert.equal(view.policy.monorepo, 'rejected');
  assert.ok(view.kernel.length >= 6);
  assert.ok(view.satellites.length >= 2);
  JSON.stringify(view);
});
