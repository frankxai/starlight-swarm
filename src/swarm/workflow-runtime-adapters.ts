import { z } from 'zod';

import { sha256Digest } from './runtime-digest';
import { isIssuedTeamPackVerificationResult, type TeamPackVerificationResult } from './team-pack-verifier';
import { durableEngines, parseWorkflowRuntimePlan, workflowOwnershipSchema, workflowRuntimeIds, type WorkflowRuntimePlan } from './workflow-runtime';

const id = z.string().regex(/^[a-z0-9][a-z0-9._-]*$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const config = z.discriminatedUnion('kind', [
  z.object({ kind: z.enum(durableEngines), deployment_target: z.literal('bound-workflow-engine'), workflow_deployment_id: id }).strict(),
  z.object({ kind: z.literal('railway-worker'), deployment_target: z.literal('existing-railway-service'), queue: id, workflow_deployment_id: id }).strict(),
  z.object({ kind: z.literal('hermes-local'), deployment_target: z.literal('isolated-hermes-profile'), profile: z.literal('starlight-team-worker'), workflow_deployment_id: id }).strict(),
  z.object({ kind: z.literal('n8n-integration'), deployment_target: z.literal('existing-n8n-service'), workflow_tag: id, workflow_deployment_id: id }).strict(),
]);
const workflowDescriptor = workflowOwnershipSchema.element.safeExtend({
  deployment_id: id,
  instance_id_prefix: id,
  binding: z.enum(['STARLIGHT_WORKFLOW', 'starlight-mission']),
}).superRefine((workflow, context) => {
  if (workflow.binding !== (workflow.durable_engine === 'cloudflare-workflows' ? 'STARLIGHT_WORKFLOW' : 'starlight-mission')) context.addIssue({ code: 'custom', message: 'Engine binding does not match its exact durable owner.' });
});
const lane = z.object({
  schema_version: z.literal('starlight.prepared_runtime_lane.v2'), deployment_id: id,
  team_id: id, lane_id: id, role_id: id, workflow_id: id,
  mission_authority: z.enum(durableEngines), runtime: z.enum(workflowRuntimeIds),
  status: z.literal('prepared-human-approval-required'),
  plan_digest_sha256: digest, pack_digest_sha256: digest, runtime_policy_digest_sha256: digest,
  max_concurrency: z.literal(1), lease_ttl_seconds: z.literal(900), heartbeat_timeout_seconds: z.literal(120),
  kill_switch: z.string().regex(/^STARLIGHT_KILL_[A-F0-9]{32}$/),
  activation_authority: z.literal('trusted-workflow-engine-authority-not-implemented'),
  required_secret_names: z.array(z.string().regex(/^[A-Z][A-Z0-9_]+$/)), runtime_config: config,
}).strict();
export const preparedWorkflowBundleSchema = z.object({
  schema_version: z.literal('starlight.prepared_runtime_bundle.v2'),
  compiler_version: z.literal('starlight.team_pack.compiler.v3'), team_id: id,
  generated_at: z.iso.datetime({ offset: true }), status: z.literal('prepared-human-approval-required'),
  plan_digest_sha256: digest, source_profile_digest_sha256: digest,
  source_runtime_policy_digest_sha256: digest, pack_digest_sha256: digest,
  workflows: z.array(workflowDescriptor).min(1).max(5), lanes: z.array(lane).min(3).max(5),
  blockers: z.tuple([
    z.literal('Workflow-engine operation-time authority and authenticated executor transport are not implemented.'),
    z.literal('Fresh owner binding, access, health, capacity, cumulative budget and named human approval are required.'),
  ]),
}).strict().superRefine((bundle, context) => {
  for (const field of ['workflow_id', 'deployment_id', 'instance_id_prefix'] as const) if (new Set(bundle.workflows.map((entry) => entry[field])).size !== bundle.workflows.length) context.addIssue({ code: 'custom', message: `Workflow ${field} must be unique.` });
  for (const field of ['lane_id', 'role_id', 'deployment_id', 'kill_switch'] as const) if (new Set(bundle.lanes.map((entry) => entry[field])).size !== bundle.lanes.length) context.addIssue({ code: 'custom', message: `Prepared lane ${field} must be unique.` });
  for (const item of bundle.lanes) {
    const owner = bundle.workflows.find((workflow) => workflow.workflow_id === item.workflow_id);
    if (!owner || owner.durable_engine !== item.mission_authority || item.runtime_config.workflow_deployment_id !== owner.deployment_id || item.runtime !== item.runtime_config.kind || item.team_id !== bundle.team_id || item.plan_digest_sha256 !== bundle.plan_digest_sha256 || item.pack_digest_sha256 !== bundle.pack_digest_sha256 || item.runtime_policy_digest_sha256 !== bundle.source_runtime_policy_digest_sha256) context.addIssue({ code: 'custom', message: 'Prepared lane owner, runtime and exact authority bindings must match the bundle.' });
  }
  if (bundle.workflows.some((owner) => !bundle.lanes.some((item) => item.workflow_id === owner.workflow_id))) context.addIssue({ code: 'custom', message: 'Prepared workflows must correspond to exactly the used lane workflows.' });
});
export type PreparedWorkflowBundle = z.infer<typeof preparedWorkflowBundleSchema>;
export function parsePreparedWorkflowBundle(input: unknown): PreparedWorkflowBundle {
  return preparedWorkflowBundleSchema.parse(input);
}

export function prepareWorkflowBundle(input: WorkflowRuntimePlan, verification: TeamPackVerificationResult): PreparedWorkflowBundle {
  if (!isIssuedTeamPackVerificationResult(verification)) throw new Error('Pack verification receipt was not issued by the team-pack verifier.');
  const plan = parseWorkflowRuntimePlan(input);
  const planDigest = sha256Digest(plan);
  if (verification.compiler_version !== 'starlight.team_pack.compiler.v3' || verification.team_id !== plan.team_id || verification.plan_digest_sha256 !== planDigest || verification.source_profile_digest_sha256 !== plan.source_profile.sha256 || verification.source_runtime_policy_digest_sha256 !== plan.routing_policy.policy_digest_sha256) throw new Error('Verified pack receipt does not bind the exact v2 plan, profile, policy and compiler.');
  const identity = (kind: string, value: string) => `starlight-${kind}-${sha256Digest({ team_id: plan.team_id, plan_digest: planDigest, value }).slice(0, 32)}`;
  const workflows = plan.workflow_ownership.map((owner) => ({ ...owner, deployment_id: identity('workflow', owner.workflow_id), instance_id_prefix: identity('instance', owner.workflow_id), binding: owner.durable_engine === 'cloudflare-workflows' ? 'STARLIGHT_WORKFLOW' as const : 'starlight-mission' as const }));
  const lanes = plan.lanes.map((item) => {
    const owner = workflows.find((entry) => entry.workflow_id === item.workflow_id)!;
    const workflowDeployment = owner.deployment_id;
    let runtimeConfig: z.infer<typeof config>;
    switch (item.runtime) {
      case 'cloudflare-workflows': case 'vercel-workflow':
        runtimeConfig = { kind: item.runtime, deployment_target: 'bound-workflow-engine', workflow_deployment_id: workflowDeployment }; break;
      case 'railway-worker':
        runtimeConfig = { kind: item.runtime, deployment_target: 'existing-railway-service', queue: identity('executor', item.id), workflow_deployment_id: workflowDeployment }; break;
      case 'hermes-local':
        runtimeConfig = { kind: item.runtime, deployment_target: 'isolated-hermes-profile', profile: 'starlight-team-worker', workflow_deployment_id: workflowDeployment }; break;
      case 'n8n-integration':
        runtimeConfig = { kind: item.runtime, deployment_target: 'existing-n8n-service', workflow_tag: identity('connector', item.id), workflow_deployment_id: workflowDeployment }; break;
    }
    return {
      schema_version: 'starlight.prepared_runtime_lane.v2' as const, deployment_id: identity('lane', item.id),
      team_id: plan.team_id, lane_id: item.id, role_id: item.role_id, workflow_id: item.workflow_id,
      mission_authority: item.mission_authority, runtime: item.runtime,
      status: 'prepared-human-approval-required' as const, plan_digest_sha256: planDigest,
      pack_digest_sha256: verification.pack_digest_sha256, runtime_policy_digest_sha256: plan.routing_policy.policy_digest_sha256,
      max_concurrency: 1 as const, lease_ttl_seconds: 900 as const, heartbeat_timeout_seconds: 120 as const,
      kill_switch: `STARLIGHT_KILL_${sha256Digest({ team_id: plan.team_id, lane_id: item.id, planDigest }).slice(0, 32).toUpperCase()}`,
      activation_authority: 'trusted-workflow-engine-authority-not-implemented' as const,
      required_secret_names: ['STARLIGHT_AUTHORITY_URL', 'STARLIGHT_EXECUTOR_TOKEN'], runtime_config: runtimeConfig,
    };
  });
  return parsePreparedWorkflowBundle({ schema_version: 'starlight.prepared_runtime_bundle.v2', compiler_version: 'starlight.team_pack.compiler.v3', team_id: plan.team_id, generated_at: plan.generated_at, status: 'prepared-human-approval-required', plan_digest_sha256: planDigest, source_profile_digest_sha256: plan.source_profile.sha256, source_runtime_policy_digest_sha256: plan.routing_policy.policy_digest_sha256, pack_digest_sha256: verification.pack_digest_sha256, workflows, lanes, blockers: ['Workflow-engine operation-time authority and authenticated executor transport are not implemented.', 'Fresh owner binding, access, health, capacity, cumulative budget and named human approval are required.'] });
}
