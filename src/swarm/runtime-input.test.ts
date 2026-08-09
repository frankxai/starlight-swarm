import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseWorkloadRequirements } from './runtime-input';

function workload(id = 'worker-a') {
  return {
    id,
    role_id: 'maker',
    workload_class: 'durable-mission',
    interaction: 'async',
    durability: 'checkpointed',
    approval_waits: true,
    code_execution: false,
    third_party_connections: false,
    local_private_data: false,
    always_available: true,
    risk: 'high',
    quality_tier: 'frontier',
    daily_token_cap: 100_000,
    daily_cost_cap_usd: 5,
  };
}

test('parses typed workload requirements with positive token and cost limits', () => {
  const parsed = parseWorkloadRequirements([workload()]);
  assert.equal(parsed[0].id, 'worker-a');
  assert.equal(parsed[0].daily_cost_cap_usd, 5);
});

test('rejects duplicate lane ids and non-positive budgets', () => {
  assert.throws(
    () => parseWorkloadRequirements([workload('duplicate'), workload('duplicate')]),
    /workload ids must be unique/i,
  );
  assert.throws(
    () => parseWorkloadRequirements([{ ...workload(), daily_cost_cap_usd: 0 }]),
    /greater than 0/i,
  );
  assert.throws(
    () => parseWorkloadRequirements([{ ...workload(), daily_token_cap: -1 }]),
    /greater than 0/i,
  );
});

test('workloads cannot self-authorize Vercel Eve routing', () => {
  assert.throws(
    () => parseWorkloadRequirements([{ ...workload(), eve_allowlisted: true }]),
    /unrecognized|invalid/i,
  );
});
