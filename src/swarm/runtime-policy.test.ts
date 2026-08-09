import test from 'node:test';
import assert from 'node:assert/strict';

import { parseRuntimePlanningPolicy } from './runtime-policy';

const policy = () => ({
  schema_version: 'starlight.runtime_planning_policy.v1',
  policy_id: 'queen-runtime-policy-v1',
  budget_policy_id: 'pilot-budget-v1',
  max_daily_cost_usd: 25,
  team_profile_source: {
    repository: 'frankxai/starlight-agent-config',
    commit_sha: 'b878eca0eb1367debfa6e52ead75c4f1213259a2',
    path: 'core/teams/starlight-platform-team.team-profile.json',
  },
  eve_allowlisted_workload_ids: ['operator-intelligence'],
  allowed_runtimes: ['railway-temporal', 'vercel-eve', 'hermes-local', 'n8n-integration'],
  deferred_runtimes: ['cloudflare-agents'],
  activation_mode: 'dry-run-only',
  review_date: '2026-08-13',
});

test('parses and digest-binds Queen-owned runtime planning policy', () => {
  const first = parseRuntimePlanningPolicy(policy());
  const second = parseRuntimePlanningPolicy(structuredClone(policy()));

  assert.equal(first.source_digest_sha256, second.source_digest_sha256);
  assert.match(first.source_digest_sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(first.routing_policy.eve_allowlisted_workload_ids, ['operator-intelligence']);
  assert.equal(first.routing_policy.policy_digest_sha256, first.source_digest_sha256);
  assert.deepEqual(first.source.team_profile_source, policy().team_profile_source);
});

test('rejects unknown keys, duplicate grants, and activation-capable policy', () => {
  assert.throws(() => parseRuntimePlanningPolicy({ ...policy(), unknown: true }), /unrecognized|invalid/i);
  assert.throws(
    () =>
      parseRuntimePlanningPolicy({
        ...policy(),
        eve_allowlisted_workload_ids: ['operator-intelligence', 'operator-intelligence'],
      }),
    /unique/i,
  );
  assert.throws(
    () => parseRuntimePlanningPolicy({ ...policy(), activation_mode: 'activate' }),
    /invalid/i,
  );
  const missingProfileSource = policy() as Record<string, unknown>;
  delete missingProfileSource.team_profile_source;
  assert.throws(() => parseRuntimePlanningPolicy(missingProfileSource), /team_profile_source/i);
  assert.throws(
    () =>
      parseRuntimePlanningPolicy({
        ...policy(),
        allowed_runtimes: [...policy().allowed_runtimes, 'cloudflare-agents'],
      }),
    /cloudflare|deferred/i,
  );
});
