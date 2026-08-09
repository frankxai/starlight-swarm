import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  testRuntimePlan,
  testRuntimePlanningPolicySource,
  testTeamProfile,
  testWorkloads,
} from './runtime-test-fixtures';
import { planTeamRuntime } from './runtime-planner';
import { compileTeamPack } from './team-pack';

const team = testTeamProfile;
const plan = testRuntimePlan();
const policy = testRuntimePlanningPolicySource;

test('compiles a deterministic batteries-included team pack from a governed profile and plan', () => {
  const pack = compileTeamPack(team, plan, policy);

  assert.equal(pack.manifest.schema_version, 'starlight.team_pack.v1');
  assert.equal(pack.manifest.compiler_version, 'starlight.team_pack.compiler.v2');
  assert.equal(pack.manifest.team_id, 'starlight-platform-team');
  assert.equal(pack.manifest.source_profile_repository, policy.team_profile_source.repository);
  assert.equal(pack.manifest.source_profile_commit_sha, policy.team_profile_source.commit_sha);
  assert.equal(pack.manifest.source_profile_path, policy.team_profile_source.path);
  assert.match(pack.manifest.plan_digest_sha256, /^[a-f0-9]{64}$/);
  assert.equal(pack.manifest.files.length, Object.keys(pack.files).length);

  for (const required of [
    'README.md',
    'SYSTEM.md',
    'WORKFLOWS.md',
    'QUALITY.md',
    'GUARDRAILS.md',
    'TASTE.md',
    'MODEL-ROUTING.md',
    'RUNTIME-POLICY.json',
    'roles/coordinator.md',
    'roles/backend-data-engineer.md',
    'roles/qa-release-sre-verifier.md',
  ]) {
    assert.ok(pack.files[required], `missing ${required}`);
  }

  assert.match(
    pack.files['SYSTEM.md'],
    /Queen[\s\S]*admission[\s\S]*schedule[\s\S]*human gates/i,
  );
  assert.match(pack.files['SYSTEM.md'], /Temporal[\s\S]*durable mission/i);
  assert.match(
    pack.files['WORKFLOWS.md'],
    /compile[\s\S]*admit[\s\S]*lease[\s\S]*execute[\s\S]*verify[\s\S]*close/i,
  );
  assert.match(pack.files['QUALITY.md'], /independent verifier/i);
  assert.match(pack.files['GUARDRAILS.md'], /external_send/);
  assert.match(pack.files['MODEL-ROUTING.md'], /vercel-ai-gateway/);
  assert.match(pack.files['roles/coordinator.md'], /Bounded Queen contract/);
  assert.match(
    pack.files['roles/qa-release-sre-verifier.md'],
    /cannot certify (?:your|its) own work/i,
  );

  for (const file of pack.manifest.files) {
    assert.equal(file.sha256, pack.file_digests[file.path]);
    assert.match(file.sha256, /^[a-f0-9]{64}$/);
  }
});

test('rejects a plan that is not bound to the exact team profile', () => {
  const forged = structuredClone(plan) as unknown as Record<string, unknown>;
  const source = forged.source_profile as Record<string, unknown>;
  source.sha256 = '0'.repeat(64);

  assert.throws(() => compileTeamPack(team, forged, policy), /source profile digest/i);
});

test('rejects runtime policy provenance that does not bind the exact plan profile source', () => {
  const forgedPolicy = structuredClone(policy);
  forgedPolicy.team_profile_source.commit_sha = 'a'.repeat(40);
  assert.throws(() => compileTeamPack(team, plan, forgedPolicy), /profile source provenance/i);
});

test('role prompts include bounded tools, scopes, stop conditions, outputs, and verifier independence', () => {
  const pack = compileTeamPack(team, plan, policy);
  const maker = pack.files['roles/backend-data-engineer.md'];
  const verifier = pack.files['roles/qa-release-sre-verifier.md'];

  assert.match(maker, /Requested tools/i);
  assert.match(maker, /Write scopes/i);
  assert.match(maker, /Stop conditions/i);
  assert.match(maker, /Expected outputs/i);
  assert.match(maker, /Idempotency and recovery evidence/i);
  assert.match(verifier, /read-only by default/i);
  assert.match(verifier, /independent/i);
});

test('verifier prompts withhold mutation-capable profile tool requests', () => {
  const governedTeam = structuredClone(team);
  const verifierRole = governedTeam.roles.find(
    (role) => role.id === governedTeam.team.verifier_role_id,
  );
  assert.ok(verifierRole);
  verifierRole.tools = ['read', 'search', 'git', 'playwright', 'sentry', 'vercel'];
  const governedPlan = planTeamRuntime(
    governedTeam,
    testWorkloads,
    plan.generated_at,
    {
      max_daily_cost_usd: policy.max_daily_cost_usd,
      policy_id: policy.budget_policy_id,
      routing_policy: plan.routing_policy,
      source_profile: policy.team_profile_source,
    },
  );

  const pack = compileTeamPack(governedTeam, governedPlan, policy);
  const verifier = pack.files['roles/qa-release-sre-verifier.md'];
  assert.match(verifier, /## Requested tools[\s\S]*- "read"[\s\S]*- "search"[\s\S]*## Write scopes/i);
  for (const withheld of ['git', 'playwright', 'sentry', 'vercel']) {
    assert.match(verifier, new RegExp(`withheld verifier tool requests[\\s\\S]*"${withheld}"`, 'i'));
    assert.doesNotMatch(
      verifier,
      new RegExp(`## Requested tools[\\s\\S]*- "${withheld}"[\\s\\S]*## Write scopes`, 'i'),
    );
  }
});

test('Eve role prompts attenuate profile tools and write scopes to no grants', () => {
  const pack = compileTeamPack(team, plan, policy);
  const coordinator = pack.files['roles/coordinator.md'];
  assert.match(
    coordinator,
    /Vercel Eve[\s\S]*no tool or write grants|no tool or write grants[\s\S]*Vercel Eve/i,
  );
  assert.doesNotMatch(coordinator, /## Requested tools\s+\n- read/i);
  assert.doesNotMatch(coordinator, /## Write scopes\s+\n- drafts/i);
});
