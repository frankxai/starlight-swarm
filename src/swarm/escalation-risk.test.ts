import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decisionFromRiskTier, riskTierOf } from './escalation';
import type { Decision } from './escalation';

test('Decision → risk tier is monotone and founder-board is already high', () => {
  assert.equal(riskTierOf('autonomous'), 'low_autonomous');
  assert.equal(riskTierOf('queen-gate'), 'medium_review');
  assert.equal(riskTierOf('founder-board'), 'high_irreversible_gate');
  assert.equal(riskTierOf('human-gate'), 'high_irreversible_gate');
  assert.equal(riskTierOf('nonsense' as Decision), 'high_irreversible_gate');
});

test('risk tier → Decision round trip can only tighten, never loosen', () => {
  const order: Decision[] = ['autonomous', 'queen-gate', 'founder-board', 'human-gate'];
  for (const d of order) {
    const back = decisionFromRiskTier(riskTierOf(d));
    assert.ok(order.indexOf(back) >= order.indexOf(d), `${d} → ${back}`);
  }
  assert.equal(decisionFromRiskTier('high_irreversible_gate'), 'human-gate');
});
