import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ABSORPTION_LEDGER, absorbedByDisposition, absorptionOverview } from './absorption';

test('every absorbed pattern has attribution, a mapping, and a refuse line', () => {
  const ids = new Set<string>();
  for (const p of ABSORPTION_LEDGER) {
    assert.equal(ids.has(p.id), false, `duplicate absorption id ${p.id}`);
    ids.add(p.id);
    assert.ok(p.source.project.length > 2);
    assert.match(p.source.url, /^https:\/\//);
    assert.ok(p.source.license.length > 2);
    assert.ok(p.pattern.length > 20);
    assert.ok(p.refuse.length > 12);
    assert.ok(p.safetyNote.length > 8);
  }
  assert.ok(ABSORPTION_LEDGER.length >= 8);
});

test('ruflo and oh-my-openagent are absorbed as patterns, not as Queen authority', () => {
  const ruflo = ABSORPTION_LEDGER.find((p) => p.id === 'ruflo-topologies');
  const omo = ABSORPTION_LEDGER.find((p) => p.id === 'omo-team-mode');
  assert.ok(ruflo && omo);
  assert.equal(ruflo.disposition, 'absorb-pattern');
  assert.equal(omo.disposition, 'absorb-pattern');
  assert.match(ruflo.refuse, /not Queen authority/i);
  assert.match(omo.refuse, /classify/i);
});

test('Eve is rejected as authority; OpenFang and bless are already absorbed', () => {
  assert.equal(absorbedByDisposition('reject-as-authority').some((p) => p.id === 'vercel-eve'), true);
  assert.equal(absorbedByDisposition('already-absorbed').some((p) => p.id === 'openfang-sidecar'), true);
  assert.equal(absorbedByDisposition('already-absorbed').some((p) => p.id === 'bless-charter'), true);
});

test('absorption overview is serializable and names every source', () => {
  const view = absorptionOverview();
  assert.equal(view.count, ABSORPTION_LEDGER.length);
  for (const item of view.items) {
    assert.ok(item.source);
    assert.ok(item.url.startsWith('https://'));
  }
});
