import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { test } from 'node:test';

import { assessTeamRuntimeAdmission, parseRuntimeAdmissionEvidence } from './runtime-admission';
import { prepareRuntimeBundle, verifyPreparedRuntimeBundle } from './runtime-adapters';
import { sha256Digest } from './runtime-digest';
import { parseTeamRuntimePlan } from './runtime-plan-contract';
import type { TeamProfileInput } from './runtime-planner';
import { compileTeamPack } from './team-pack';
import { verifyTeamPackDirectory } from './team-pack-verifier';
import { writeTeamPackAtomically } from './team-pack-writer';
import {
  parseWorkflowPlanningPolicy,
  planWorkflowRuntime,
  parseWorkflowRuntimePlan,
  type WorkflowPlanningPolicySource,
} from './workflow-runtime';

function profile(): TeamProfileInput {
  return {
    schema_version: 'starlight.team_profile.v2',
    team: { id: 'creator-team', display_name: 'Creator engineering team', operating_unit: 'creator', coordinator_role_id: 'coordinator', verifier_role_id: 'verifier', default_team_size: 3, description: 'Produce a recoverable creator artifact.' },
    roles: ['coordinator', 'maker', 'verifier'].map((id) => ({ id, profile_ref: id, capabilities: ['read'], write_scopes: id === 'verifier' ? ['reports/**'] : ['assigned/**'], tools: ['read'], stop_conditions: ['Stop at a human gate.'], expected_outputs: ['Artifact and evidence'] })),
    routing: { required_roles: ['coordinator', 'maker', 'verifier'], optional_roles: [], handoff_rules: ['Return exact artifact evidence.'] },
    permissions: { allowed_actions: ['read', 'edit-owned'], human_gate_actions: ['external-send'], default_write_scope: ['assigned/**'] },
    bindings: { skills: [], plugins: [], tools: [] }, eval_suite: ['recovery'],
    ownership: { owner: 'creator', version: '2.0.0', review_date: '2026-10-04' },
  };
}
function policy(): WorkflowPlanningPolicySource {
  return {
    schema_version: 'starlight.runtime_planning_policy.v2', policy_id: 'creator-workflow-v2', budget_policy_id: 'creator-budget', max_daily_cost_usd: 20,
    team_profile_source: { repository: 'frankxai/starlight-swarm', commit_sha: '1a6ff89eacd2c8365fa923c798cca1f5155b46b6', path: 'synthetic/creator-profile.json' },
    eve_allowlisted_workload_ids: [], allowed_runtimes: ['cloudflare-workflows', 'vercel-workflow', 'railway-worker', 'hermes-local', 'n8n-integration'], deferred_runtimes: [], activation_mode: 'dry-run-only', review_date: '2026-10-04',
    workflow_ownership: [{ workflow_id: 'creation', workload_scope: 'agent-centric', identity_state_owner: 'cloudflare', durable_engine: 'cloudflare-workflows' }],
  };
}
function workloads() {
  return ['coordinator', 'maker', 'verifier'].map((role_id) => ({ id: role_id, role_id, workflow_id: 'creation', workload_class: 'durable-mission', interaction: 'async', durability: 'checkpointed', approval_waits: true, code_execution: role_id === 'maker', third_party_connections: false, local_private_data: false, always_available: true, risk: 'medium', quality_tier: role_id === 'verifier' ? 'checker-independent' : 'frontier', daily_token_cap: 1000, daily_cost_cap_usd: 3 }));
}
function plan(source = policy(), inputs = workloads()) {
  return planWorkflowRuntime(profile(), inputs, '2026-10-04T03:00:00Z', parseWorkflowPlanningPolicy(source));
}

test('v2 binds three team roles to Cloudflare while Railway remains a code executor', () => {
  const result = plan();
  assert.equal(result.schema_version, 'starlight.team_runtime_plan.v2');
  assert.equal(result.authority.mission, 'per-workflow');
  assert.deepEqual(result.lanes.map((lane) => lane.mission_authority), Array(3).fill('cloudflare-workflows'));
  assert.equal(result.lanes[1].runtime, 'railway-worker');
  assert.deepEqual(parseWorkflowRuntimePlan(JSON.parse(JSON.stringify(result))), result);
});
test('app-local workflows bind Vercel independently of their executors', () => {
  const source = policy();
  source.workflow_ownership = [{ workflow_id: 'creation', workload_scope: 'app-local', identity_state_owner: 'vercel', durable_engine: 'vercel-workflow' }];
  const result = plan(source);
  assert.equal(result.lanes[1].runtime, 'railway-worker');
  assert.equal(result.lanes[1].mission_authority, 'vercel-workflow');
});
test('distinct workflows may use different engines, with one owner per workflow', () => {
  const source = policy();
  source.workflow_ownership.push({ workflow_id: 'app', workload_scope: 'app-local', identity_state_owner: 'vercel', durable_engine: 'vercel-workflow' });
  const inputs = workloads(); inputs[1].workflow_id = 'app';
  const result = plan(source, inputs);
  assert.deepEqual(result.lanes.map((lane) => lane.mission_authority), ['cloudflare-workflows', 'vercel-workflow', 'cloudflare-workflows']);
});
test('a second engine cannot claim the same workflow', () => {
  const source = policy(); source.workflow_ownership.push({ workflow_id: 'creation', workload_scope: 'app-local', identity_state_owner: 'vercel', durable_engine: 'vercel-workflow' });
  assert.throws(() => plan(source), /unique|one.*owner/i);
});
test('state owner and workload scope cannot disagree with the accepted engine', () => {
  const source = policy(); source.workflow_ownership[0].durable_engine = 'vercel-workflow';
  assert.throws(() => plan(source), /owner|engine/i);
});
test('Temporal and connector names cannot become v2 durable engines', () => {
  for (const engine of ['railway-temporal', 'n8n-integration', 'trigger.dev']) {
    const source = policy(); (source.workflow_ownership[0] as Record<string, unknown>).durable_engine = engine;
    assert.throws(() => plan(source));
  }
});
test('unbound and unused workflow ownership entries are rejected', () => {
  const inputs = workloads(); inputs[0].workflow_id = 'unbound';
  assert.throws(() => plan(policy(), inputs), /workflow/i);
  const source = policy(); source.workflow_ownership.push({ ...source.workflow_ownership[0], workflow_id: 'unused' });
  assert.throws(() => plan(source), /unused|exact/i);
});
test('a private local job is never silently moved into an always-on cloud executor', () => {
  const inputs = workloads(); inputs[2].local_private_data = true;
  assert.throws(() => plan(policy(), inputs), /private|local/i);
  inputs[2].always_available = false;
  assert.equal(plan(policy(), inputs).lanes[2].runtime, 'hermes-local');
});
test('budgets and required role independence remain enforced', () => {
  const source = policy(); source.max_daily_cost_usd = 8;
  assert.throws(() => plan(source), /budget|cost/i);
  const inputs = workloads(); inputs[2].role_id = 'maker';
  assert.throws(() => plan(policy(), inputs), /unique|role/i);
  const nonfinite = policy(); nonfinite.max_daily_cost_usd = Infinity;
  assert.throws(() => plan(nonfinite));
});
test('the bound policy cannot remove the required executor', () => {
  const source = policy(); source.allowed_runtimes = ['cloudflare-workflows'];
  assert.throws(() => plan(source), /runtime|executor/i);
});
test('fractional USD ceilings sum exactly, without float tolerances', () => {
  const source = policy(); source.max_daily_cost_usd = 0.3;
  const inputs = workloads(); inputs.forEach((item) => { item.daily_cost_cap_usd = 0.1; });
  assert.equal(plan(source, inputs).budget.planned_daily_cost_usd, 0.3);
  inputs[2].daily_cost_cap_usd = 0.100001;
  assert.throws(() => plan(source, inputs), /budget|cost/i);
});
test('sub-microdollar and unsafe ceilings cannot be rounded into accepted budgets', () => {
  const source = policy(); source.max_daily_cost_usd = 0.3000000001;
  assert.throws(() => plan(source), /decimal|microdollar|USD/i);
  const second = policy(); second.max_daily_cost_usd = Number.MAX_SAFE_INTEGER;
  assert.throws(() => plan(second), /microdollar|USD/i);
});
test('imported plans cannot move a lane to another engine or bypass code placement', () => {
  const imported = plan(); imported.lanes[1].mission_authority = 'vercel-workflow';
  assert.throws(() => parseWorkflowRuntimePlan(imported), /owner|engine|authority/i);
  const second = plan(); second.lanes[1].runtime = 'cloudflare-workflows';
  assert.throws(() => parseWorkflowRuntimePlan(second), /executor|code|runtime/i);
});
test('compiler v3 binds the exact policy, owner map, profile and plan', () => {
  const source = policy(); const result = plan(source);
  const pack = compileTeamPack(profile(), result, source);
  assert.equal(pack.manifest.schema_version, 'starlight.team_pack.v2');
  assert.equal(pack.manifest.compiler_version, 'starlight.team_pack.compiler.v3');
  assert.match(pack.files['SYSTEM.md'], /cloudflare-workflows/);
  assert.doesNotMatch(pack.files['SYSTEM.md'], /Railway Temporal/);
  const swapped = policy(); swapped.workflow_ownership[0].workload_scope = 'app-local'; swapped.workflow_ownership[0].identity_state_owner = 'vercel'; swapped.workflow_ownership[0].durable_engine = 'vercel-workflow';
  assert.throws(() => compileTeamPack(profile(), result, swapped), /policy|ownership/i);
  const changed = plan(source); changed.workflow_ownership = swapped.workflow_ownership;
  changed.lanes.forEach((lane) => { lane.mission_authority = 'vercel-workflow'; if (lane.runtime === 'cloudflare-workflows') { lane.runtime = 'vercel-workflow'; lane.provider_route = 'vercel-ai-gateway'; } });
  assert.throws(() => compileTeamPack(profile(), changed, source), /ownership|policy/i);
});
test('an actual written and verified pack prepares a bound v2 bundle, not activation', () => {
  const root = mkdtempSync(join(tmpdir(), 'starlight-workflow-v2-'));
  assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
  try {
    const source = policy(); const result = plan(source);
    const pack = compileTeamPack(profile(), result, source);
    const written = writeTeamPackAtomically(root, 'runtime/generated/packs/creator-v2', pack);
    const directory = join(root, 'runtime/generated/packs/creator-v2');
    assert.ok(written);
    const receipt = verifyTeamPackDirectory(directory, result, profile(), source);
    const bundle = prepareRuntimeBundle(result, receipt);
    assert.equal(bundle.schema_version, 'starlight.prepared_runtime_bundle.v2');
    assert.equal(bundle.status, 'prepared-human-approval-required');
    assert.deepEqual(verifyPreparedRuntimeBundle(bundle, result, receipt), bundle);
    assert.throws(() => prepareRuntimeBundle(result, { ...receipt }), /issued/);
    const changed = JSON.parse(JSON.stringify(bundle)); changed.lanes[1].mission_authority = 'vercel-workflow';
    assert.throws(() => verifyPreparedRuntimeBundle(changed, result, receipt));
    const rolePath = join(directory, 'roles/maker.md');
    writeFileSync(rolePath, readFileSync(rolePath, 'utf8') + '\nSelf-approved execution.\n');
    assert.throws(() => verifyTeamPackDirectory(directory, result, profile(), source), /digest/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('v1 activation authority cannot admit a v2 plan or its copied receipts', () => {
  assert.equal(assessTeamRuntimeAdmission(plan(), {}).admitted, false);
  assert.throws(() => parseTeamRuntimePlan(plan()));
});
test('legacy admission refuses the new compiler and workflow health keys with otherwise valid evidence', () => {
  const binding = {
    plan_digest_sha256: 'a'.repeat(64), source_profile_digest_sha256: 'b'.repeat(64),
    source_runtime_policy_digest_sha256: 'c'.repeat(64), pack_digest_sha256: 'd'.repeat(64),
    compiler_version: 'starlight.team_pack.compiler.v2',
  };
  const receipt = { ...binding, receipt_id: 'synthetic-receipt', issuer: 'synthetic-untrusted', expires_at: '2026-10-04T04:00:00.000Z' };
  const evidence = {
    observed_at: '2026-10-04T03:00:00.000Z', duplicate_lane_ids: [], available_memory_gib: 16,
    runtime_health: { 'hermes-local': 'ready' },
    verified_pack: { ...binding, status: 'verified-human-approval-required', team_id: 'creator-team' },
    approval_receipt: { ...receipt, scope: 'activate-team-runtime' },
    budget_receipt: { ...receipt, budget_policy_id: 'synthetic-budget', hard_daily_limit_usd: 20 },
  };
  assert.equal(parseRuntimeAdmissionEvidence(evidence).verified_pack.compiler_version, binding.compiler_version);
  assert.throws(() => parseRuntimeAdmissionEvidence({ ...evidence, verified_pack: { ...evidence.verified_pack, compiler_version: 'starlight.team_pack.compiler.v3' } }), /compiler_version/);
  for (const runtime of ['cloudflare-workflows', 'vercel-workflow']) {
    assert.throws(() => parseRuntimeAdmissionEvidence({ ...evidence, runtime_health: { [runtime]: 'ready' } }), /runtime_health/);
  }
});
test('legacy v1 JSON remains readable and compiler bytes stay unchanged', () => {
  const legacy = JSON.parse(readFileSync('runtime/generated/starlight-platform-pilot.plan.json', 'utf8'));
  assert.equal(parseTeamRuntimePlan(legacy).schema_version, 'starlight.team_runtime_plan.v1');
  assert.equal(sha256Digest(legacy), sha256Digest(parseTeamRuntimePlan(legacy)));
  const legacyProfile = JSON.parse(readFileSync('runtime/examples/starlight-platform-team.b12e904.profile.json', 'utf8'));
  const legacyPolicy = JSON.parse(readFileSync('runtime/policies/starlight-platform-pilot.runtime-policy.json', 'utf8'));
  const compiled = compileTeamPack(legacyProfile, legacy, legacyPolicy);
  const original = JSON.parse(readFileSync('runtime/generated/packs/starlight-platform-team-a962e63e0bbc-9e6a7ba46b63/manifest.json', 'utf8'));
  assert.equal(compiled.manifest.compiler_version, 'starlight.team_pack.compiler.v2');
  assert.equal(sha256Digest({ manifest: compiled.manifest, file_digests: compiled.file_digests }), original.pack_digest_sha256);
});
