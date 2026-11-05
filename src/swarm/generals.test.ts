import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DOMAIN_GENERALS, DOMAIN_GENERAL_IDS, GENERALS_SOURCE, GOVERNANCE_MODES, ROLE_CONTRACTS, SWARM_MODEL_MATRIX,
  budgetSplitProblems, canDispatch, DEFAULT_BUDGET_SPLIT, isDomainGeneralId,
} from './generals';

test('five Domain Generals, vendored with their source commit recorded', () => {
  assert.deepEqual([...DOMAIN_GENERAL_IDS].sort(), [
    'starlight-architect', 'starlight-hermes', 'starlight-sage', 'starlight-sentinel', 'starlight-weaver',
  ]);
  assert.match(GENERALS_SOURCE.commit, /^[0-9a-f]{40}$/);
  for (const id of DOMAIN_GENERAL_IDS) {
    assert.equal(DOMAIN_GENERALS[id].id, id);
    assert.ok(DOMAIN_GENERALS[id].invariants.length >= 1);
    assert.ok(['scout', 'build', 'council'].includes(DOMAIN_GENERALS[id].defaultTier));
  }
  assert.equal(DOMAIN_GENERALS['starlight-sentinel'].defaultTier, 'council');
  assert.equal(SWARM_MODEL_MATRIX.council.primaryModel, 'claude-opus-4-6');
  assert.ok(isDomainGeneralId('starlight-sage'));
  assert.ok(!isDomainGeneralId('queen-coordinator'));
});

test('dispatch flows down only; no tier dispatches to itself or upward', () => {
  assert.ok(canDispatch('queen', 'general'));
  assert.ok(canDispatch('general', 'worker'));
  assert.ok(canDispatch('specialist', 'worker'));
  assert.ok(!canDispatch('worker', 'worker'));
  assert.ok(!canDispatch('worker', 'queen'));
  assert.ok(!canDispatch('general', 'general'));
  assert.ok(!canDispatch('general', 'queen'));
  assert.equal(ROLE_CONTRACTS.worker.holdsBudget, false);
  for (const tier of Object.keys(ROLE_CONTRACTS) as Array<keyof typeof ROLE_CONTRACTS>) {
    assert.ok(!ROLE_CONTRACTS[tier].mayDispatch.includes(tier), `${tier} must not dispatch to itself`);
  }
});

test('emergency governance is entered only through the human gate', () => {
  assert.equal(GOVERNANCE_MODES.emergency.entryDecision, 'human-gate');
  assert.equal(GOVERNANCE_MODES.hierarchical.entryDecision, 'autonomous');
  assert.equal(GOVERNANCE_MODES.democratic.entryDecision, 'queen-gate');
});

test('the default budget split sums to 100 and bad splits are named', () => {
  assert.deepEqual(budgetSplitProblems(DEFAULT_BUDGET_SPLIT), []);
  assert.ok(budgetSplitProblems({ collective: 50, workers: 50, scouts: 10, memory: 0 }).some((p) => /sum to 100/.test(p)));
  assert.ok(budgetSplitProblems({ collective: -1, workers: 101, scouts: 0, memory: 0 }).length >= 1);
  assert.ok(budgetSplitProblems(null).length === 1);
});
