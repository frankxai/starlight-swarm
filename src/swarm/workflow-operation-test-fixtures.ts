import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

import { compileTeamPack } from './team-pack';
import { verifyTeamPackDirectory } from './team-pack-verifier';
import { writeTeamPackAtomically } from './team-pack-writer';
import { parseTeamProfile } from './runtime-planner';
import { sha256Digest } from './runtime-digest';
import { parseWorkflowPlanningPolicy, planWorkflowRuntime } from './workflow-runtime';
import { prepareWorkflowBundle } from './workflow-runtime-adapters';
import type { OperationBinding } from './operation-authority';

/** Real compiler/writer/verifier receipts over the committed historical profile; no network. */
export function workflowOperationFixture() {
  const json = (path: string) => JSON.parse(readFileSync(join(process.cwd(), path), 'utf8'));
  const profile = parseTeamProfile(json('runtime/examples/starlight-platform-team.b12e904.profile.json'));
  const source = json('runtime/policies/starlight-platform-workflow-v2.runtime-policy.json');
  source.team_profile_source.commit_sha = 'b12e904a89747434d77b7ddc29e17de3c29f708d';
  const plan = planWorkflowRuntime(profile, json('runtime/examples/starlight-platform-workflow-v2.workloads.json'), '2026-10-04T03:00:00Z', parseWorkflowPlanningPolicy(source));
  const root = mkdtempSync(join(tmpdir(), 'starlight-operation-test-'));
  if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error('Fixture escaped the temporary root.');
  const cleanup = () => rmSync(root, { recursive: true, force: true });
  try {
    writeTeamPackAtomically(root, 'runtime/generated/packs/operation-test', compileTeamPack(profile, plan, source));
    const verification = verifyTeamPackDirectory(join(root, 'runtime/generated/packs/operation-test'), plan, profile, source);
    const prepared = prepareWorkflowBundle(plan, verification);
    const lane = plan.lanes[0];
    const role = profile.roles.find((entry) => entry.id === lane.role_id)!;
    const binding: OperationBinding = {
      schema_version: 'starlight.operation_binding.v1', operation_id: 'operation-one', effect_id: 'effect-one',
      mission_id: 'mission-one', call_id: 'call-one', role: 'maker', actor_id: 'queen-one',
      execution_identity: 'executor-one', identity_evidence_ref: 'identity-one',
      context_digest_sha256: '1'.repeat(64), prompt_sha256: '2'.repeat(64), timeout_ms: 30_000,
      requested_operation: 'read-context', effect: { kind: 'read-context', resource: 'assigned/context', parameters_digest_sha256: '3'.repeat(64) },
      source_profile: { repository: plan.source_profile.repository, commit_sha: plan.source_profile.commit_sha, path: plan.source_profile.path, digest_sha256: plan.source_profile.sha256 },
      policy_digest_sha256: plan.routing_policy.policy_digest_sha256, plan_digest_sha256: sha256Digest(plan), pack_digest_sha256: verification.pack_digest_sha256,
      compiler_version: 'starlight.team_pack.compiler.v3', lane_id: lane.id, workload_id: lane.id,
      runtime_id: lane.runtime, host_id: 'host-one', capabilities: [role.capabilities[0]],
      budget_policy_id: plan.budget.policy_id, requested_cost_usd: 1,
    };
    const target = {
      schema_version: 'starlight.cloudflare_workflow_target.v1' as const,
      workflow_id: lane.workflow_id, prepared_deployment_id: prepared.workflows[0].deployment_id,
      account_id: 'a'.repeat(32), workflow_name: 'creator-mission',
      workflow_uuid: '11111111-1111-4111-8111-111111111111',
      version_id: '22222222-2222-4222-8222-222222222222', instance_id: 'mission-instance-one',
    };
    return { profile, source, plan, verification, binding, target, cleanup };
  } catch (error) { cleanup(); throw error; }
}
