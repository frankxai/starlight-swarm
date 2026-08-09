import {
  planTeamRuntime,
  type TeamProfileInput,
  type WorkloadRequirement,
} from './runtime-planner';
import { parseRuntimePlanningPolicy, type RuntimePlanningPolicySource } from './runtime-policy';

export const testRuntimePlanningPolicySource: RuntimePlanningPolicySource = {
  schema_version: 'starlight.runtime_planning_policy.v1',
  policy_id: 'queen-runtime-policy-v1',
  budget_policy_id: 'test-budget-v1',
  max_daily_cost_usd: 5,
  team_profile_source: {
    repository: 'frankxai/starlight-agent-config',
    commit_sha: '12b8733f1af061578d979e93e7bb6c1763f8f9e3',
    path: 'core/teams/starlight-platform-team.team-profile.json',
  },
  eve_allowlisted_workload_ids: ['operator-intelligence'],
  allowed_runtimes: ['railway-temporal', 'vercel-eve', 'hermes-local', 'n8n-integration'],
  deferred_runtimes: ['cloudflare-agents'],
  activation_mode: 'dry-run-only',
  review_date: '2026-08-13',
};

export const testTeamProfile: TeamProfileInput = {
  schema_version: 'starlight.team_profile.v2',
  team: {
    id: 'starlight-platform-team',
    display_name: 'Starlight Platform Team Test Fixture',
    operating_unit: 'starlight',
    coordinator_role_id: 'coordinator',
    verifier_role_id: 'qa-release-sre-verifier',
    default_team_size: 3,
    description: 'Hermetic fixture for runtime and team-pack contract tests.',
  },
  roles: [
    {
      id: 'coordinator',
      profile_ref: 'coordinator',
      capabilities: ['coordinate'],
      write_scopes: ['drafts'],
      tools: ['read'],
      stop_conditions: ['Stop before consequential action.'],
      expected_outputs: ['Bounded Queen contract'],
    },
    {
      id: 'backend-data-engineer',
      profile_ref: 'backend-data-engineer',
      capabilities: ['build'],
      write_scopes: ['drafts'],
      tools: ['read', 'test'],
      stop_conditions: ['Stop when verification fails.'],
      expected_outputs: ['Idempotency and recovery evidence'],
    },
    {
      id: 'qa-release-sre-verifier',
      profile_ref: 'qa-release-sre-verifier',
      capabilities: ['verify'],
      write_scopes: ['receipts'],
      tools: ['read'],
      stop_conditions: ['Stop on maker-verifier conflict.'],
      expected_outputs: ['Independent verification receipt'],
    },
  ],
  routing: {
    required_roles: ['coordinator', 'backend-data-engineer', 'qa-release-sre-verifier'],
    optional_roles: [],
    handoff_rules: ['maker-to-verifier'],
  },
  permissions: {
    allowed_actions: ['draft'],
    human_gate_actions: ['deploy', 'publish', 'external_send', 'spend'],
    default_write_scope: ['drafts'],
  },
  bindings: { skills: [], plugins: [], tools: [] },
  eval_suite: ['independent-verification'],
  ownership: { owner: 'starlight', version: '1.0.0', review_date: '2026-08-06' },
};

export const testWorkloads: WorkloadRequirement[] = [
  {
    id: 'operator-intelligence',
    role_id: 'coordinator',
    workload_class: 'interactive-specialist',
    interaction: 'realtime',
    durability: 'run-receipt',
    approval_waits: false,
    code_execution: false,
    third_party_connections: false,
    local_private_data: false,
    always_available: true,
    risk: 'low',
    quality_tier: 'balanced',
    daily_token_cap: 10_000,
    daily_cost_cap_usd: 1,
  },
  {
    id: 'durable-builder',
    role_id: 'backend-data-engineer',
    workload_class: 'durable-mission',
    interaction: 'async',
    durability: 'checkpointed',
    approval_waits: true,
    code_execution: true,
    third_party_connections: true,
    local_private_data: false,
    always_available: true,
    risk: 'medium',
    quality_tier: 'frontier',
    daily_token_cap: 20_000,
    daily_cost_cap_usd: 2,
  },
  {
    id: 'independent-verifier',
    role_id: 'qa-release-sre-verifier',
    workload_class: 'scheduled-intelligence',
    interaction: 'scheduled',
    durability: 'run-receipt',
    approval_waits: false,
    code_execution: false,
    third_party_connections: false,
    local_private_data: true,
    always_available: false,
    risk: 'low',
    quality_tier: 'checker-independent',
    daily_token_cap: 10_000,
    daily_cost_cap_usd: 1,
  },
];

export function testRuntimePlan() {
  const policy = parseRuntimePlanningPolicy(testRuntimePlanningPolicySource);
  return planTeamRuntime(
    testTeamProfile,
    testWorkloads,
    '2026-08-06T03:00:00.000Z',
    {
      max_daily_cost_usd: policy.source.max_daily_cost_usd,
      policy_id: policy.source.budget_policy_id,
      routing_policy: policy.routing_policy,
      source_profile: policy.source.team_profile_source,
    },
  );
}
