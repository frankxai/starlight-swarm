import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseTeamProfile,
  planTeamRuntime,
  recommendRuntime,
  type TeamProfileInput,
  type WorkloadRequirement,
} from './runtime-planner';

const profileSource = {
  repository: 'frankxai/starlight-agent-config',
  commit_sha: '12b8733f1af061578d979e93e7bb6c1763f8f9e3',
  path: 'core/teams/starlight-platform-team.team-profile.json',
};

function platformTeam(): TeamProfileInput {
  return {
    schema_version: 'starlight.team_profile.v2',
    team: {
      id: 'starlight-platform-team',
      display_name: 'Starlight Platform and Tooling',
      operating_unit: 'starlight-platform',
      coordinator_role_id: 'coordinator',
      verifier_role_id: 'qa-release-sre-verifier',
      default_team_size: 3,
    },
    roles: [
      {
        id: 'coordinator',
        profile_ref: 'chief-product-operator',
        capabilities: ['intake', 'routing', 'integration'],
        write_scopes: ['coordination/**'],
        tools: ['queen', 'work-ledger'],
        stop_conditions: ['Stop at a human gate.'],
        expected_outputs: ['Bounded mission contract'],
      },
      {
        id: 'backend-data-engineer',
        profile_ref: 'backend-data-engineer',
        capabilities: ['api', 'data', 'webhooks', 'observability'],
        write_scopes: ['server/**'],
        tools: ['node', 'python'],
        stop_conditions: ['Stop before a migration or secret change.'],
        expected_outputs: ['Idempotency and recovery evidence'],
      },
      {
        id: 'qa-release-sre-verifier',
        profile_ref: 'qa-release-sre',
        capabilities: ['qa', 'release', 'rollback', 'evidence'],
        write_scopes: ['reports/verification/**'],
        tools: ['git', 'playwright'],
        stop_conditions: ['Stop when any required gate fails.'],
        expected_outputs: ['Independent verdict'],
      },
    ],
    routing: {
      required_roles: ['coordinator', 'backend-data-engineer', 'qa-release-sre-verifier'],
      optional_roles: [],
      handoff_rules: ['The maker cannot verify its own release.'],
    },
    permissions: {
      allowed_actions: ['read', 'edit-owned-paths', 'test', 'draft-pr'],
      human_gate_actions: [
        'production_high_risk',
        'dns_change',
        'secret_change',
        'billing_change',
        'spend',
        'data_migration',
        'destructive',
        'external_send',
        'legal_ip',
        'brand_identity',
        'permission_change',
      ],
      default_write_scope: ['assigned-repo/**'],
    },
    bindings: {
      skills: ['starlight-work-ledger'],
      plugins: ['starlight-control-plane'],
      tools: ['git', 'github'],
    },
    eval_suite: ['repo-contract-integrity'],
    ownership: {
      owner: 'starlight-substrate-ops',
      version: '2.0.0',
      review_date: '2026-08-10',
    },
  };
}

function workload(overrides: Partial<WorkloadRequirement> = {}): WorkloadRequirement {
  return {
    id: 'mission-worker',
    role_id: 'backend-data-engineer',
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
    daily_token_cap: 250_000,
    daily_cost_cap_usd: 12,
    ...overrides,
  };
}

test('parses a governed v2 team and fails closed when coordinator and verifier are not independent', () => {
  const parsed = parseTeamProfile(platformTeam());
  assert.equal(parsed.team.id, 'starlight-platform-team');

  const invalid = platformTeam();
  invalid.team.verifier_role_id = 'coordinator';
  assert.throws(() => parseTeamProfile(invalid), /coordinator.*verifier.*different/i);
});

test('recommends Railway Temporal for durable missions that can wait for approval', () => {
  const decision = recommendRuntime(workload());

  assert.equal(decision.runtime, 'railway-temporal');
  assert.equal(decision.mission_authority, 'railway-temporal');
  assert.ok(decision.reason_codes.includes('durable-approval-wait'));
});

test('recommends Vercel Eve for an interactive low-risk specialist while keeping Temporal authoritative', () => {
  const decision = recommendRuntime(
    workload({
      workload_class: 'interactive-specialist',
      interaction: 'realtime',
      durability: 'session',
      approval_waits: false,
      third_party_connections: true,
      risk: 'low',
      quality_tier: 'balanced',
    }),
    {
      policy_id: 'queen-runtime-policy-v1',
      policy_digest_sha256: 'f'.repeat(64),
      eve_allowlisted_workload_ids: ['mission-worker'],
      allowed_runtimes: ['railway-temporal', 'vercel-eve', 'hermes-local', 'n8n-integration'],
    },
  );

  assert.equal(decision.runtime, 'vercel-eve');
  assert.equal(decision.mission_authority, 'railway-temporal');
  assert.ok(decision.warnings.some((warning) => /beta/i.test(warning)));
});

test('recommends local Hermes only for bounded private scheduled work and marks host availability', () => {
  const decision = recommendRuntime(
    workload({
      workload_class: 'scheduled-intelligence',
      interaction: 'scheduled',
      durability: 'run-receipt',
      approval_waits: false,
      local_private_data: true,
      always_available: false,
      risk: 'low',
      quality_tier: 'economy',
    }),
  );

  assert.equal(decision.runtime, 'hermes-local');
  assert.ok(decision.warnings.some((warning) => /sleep|offline|capacity/i.test(warning)));
});

test('compiles a three-lane pilot with stable authority, model, budget, and human-gate boundaries', () => {
  const plan = planTeamRuntime(
    platformTeam(),
    [
      workload({
        id: 'operator-lane',
        role_id: 'coordinator',
        workload_class: 'interactive-specialist',
        interaction: 'realtime',
        durability: 'session',
        approval_waits: false,
        third_party_connections: true,
        risk: 'low',
        quality_tier: 'balanced',
        daily_token_cap: 120_000,
        daily_cost_cap_usd: 4,
      }),
      workload(),
      workload({
        id: 'verifier-lane',
        role_id: 'qa-release-sre-verifier',
        workload_class: 'scheduled-intelligence',
        interaction: 'scheduled',
        durability: 'run-receipt',
        approval_waits: false,
        local_private_data: true,
        always_available: false,
        risk: 'medium',
        quality_tier: 'checker-independent',
        daily_token_cap: 80_000,
        daily_cost_cap_usd: 3,
      }),
    ],
    '2026-08-06T02:30:00.000Z',
    {
      max_daily_cost_usd: 25,
      source_profile: profileSource,
      routing_policy: {
        policy_id: 'queen-runtime-policy-v1',
        policy_digest_sha256: 'f'.repeat(64),
        eve_allowlisted_workload_ids: ['operator-lane'],
        allowed_runtimes: ['railway-temporal', 'vercel-eve', 'hermes-local', 'n8n-integration'],
      },
    },
  );

  assert.equal(plan.schema_version, 'starlight.team_runtime_plan.v1');
  assert.equal(plan.team_id, 'starlight-platform-team');
  assert.deepEqual(
    {
      repository: plan.source_profile.repository,
      commit_sha: plan.source_profile.commit_sha,
      path: plan.source_profile.path,
    },
    profileSource,
  );
  assert.equal(plan.authority.mission, 'railway-temporal');
  assert.equal(plan.authority.model_policy, 'queen-model-policy');
  assert.equal(plan.authority.observability, 'langfuse');
  assert.equal(plan.lanes.length, 3);
  assert.deepEqual(
    plan.lanes.map((lane) => lane.runtime),
    ['vercel-eve', 'railway-temporal', 'hermes-local'],
  );
  assert.deepEqual(
    plan.lanes.map((lane) => lane.provider_route),
    ['vercel-ai-gateway', 'direct-provider', 'hermes-profile'],
  );
  assert.equal(plan.lanes[1].model_route, 'frontier');
  assert.equal(plan.lanes[2].model_route, 'checker-independent');
  assert.equal(plan.lanes[1].budget.daily_cost_cap_usd, 12);
  assert.deepEqual(plan.human_gate_actions, platformTeam().permissions.human_gate_actions);
  assert.equal(plan.activation_status, 'planned-human-approval-required');
});

test('rejects plans that omit a required team role or exceed its daily budget', () => {
  assert.throws(
    () => planTeamRuntime(platformTeam(), [workload()], '2026-08-06T02:30:00.000Z'),
    /three to five|missing required workload roles.*coordinator/i,
  );

  assert.throws(
    () =>
      planTeamRuntime(
        platformTeam(),
        [
          workload({ id: 'a', role_id: 'coordinator', daily_cost_cap_usd: 50 }),
          workload({ id: 'b', role_id: 'backend-data-engineer', daily_cost_cap_usd: 50 }),
          workload({ id: 'c', role_id: 'qa-release-sre-verifier', daily_cost_cap_usd: 50 }),
        ],
        '2026-08-06T02:30:00.000Z',
        { max_daily_cost_usd: 100 },
      ),
    /daily cost cap.*150.*team limit.*100/i,
  );
});
