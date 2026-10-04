import { z } from 'zod';

import { operationBindingSchema, type OperationBinding } from './operation-authority';
import { sha256Digest } from './runtime-digest';
import { parseTeamProfile } from './runtime-planner';
import { type TeamPackVerificationResult } from './team-pack-verifier';
import { parseWorkflowRuntimePlan } from './workflow-runtime';
import { prepareWorkflowBundle } from './workflow-runtime-adapters';

const id = z.string().min(1).max(100).regex(/^[a-z0-9][a-z0-9._-]*$/);
export const cloudflareWorkflowTargetSchema = z.object({
  schema_version: z.literal('starlight.cloudflare_workflow_target.v1'),
  workflow_id: id, prepared_deployment_id: id,
  account_id: z.string().regex(/^[a-f0-9]{32}$/),
  workflow_name: id.max(64), workflow_uuid: z.uuid(), version_id: z.uuid(),
  instance_id: id.refine((value) => !/^cf_[a-f0-9]{64}$/.test(value), 'Cloudflare reserves this instance ID.'),
}).strict();
export type CloudflareWorkflowTarget = z.infer<typeof cloudflareWorkflowTargetSchema>;

export interface BoundCloudflareWorkflowOperation {
  schema_version: 'starlight.bound_workflow_operation.v1';
  binding: OperationBinding;
  context: {
    schema_version: 'starlight.workflow_operation_context.v1';
    input_context_digest_sha256: string;
    identity_state_owner: 'cloudflare';
    durable_engine: 'cloudflare-workflows';
    target: CloudflareWorkflowTarget;
    team_id: string;
    role_id: string;
  };
  activation_authority_granted: false;
}

const issued = new WeakSet<object>();
function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(freezeDeep);
    Object.freeze(value);
  }
  return value;
}
export function isIssuedCloudflareWorkflowOperation(input: unknown): input is BoundCloudflareWorkflowOperation {
  return typeof input === 'object' && input !== null && issued.has(input);
}

/**
 * Derives request data for the existing signed/durable authority. Target configuration belongs
 * to server bootstrap. This receipt grants no admission, host access, lease or execution.
 */
export function bindCloudflareWorkflowOperation(
  untrustedPlan: unknown,
  untrustedProfile: unknown,
  verification: TeamPackVerificationResult,
  untrustedBinding: unknown,
  untrustedTarget: unknown,
): BoundCloudflareWorkflowOperation {
  const plan = parseWorkflowRuntimePlan(untrustedPlan);
  const profile = parseTeamProfile(untrustedProfile);
  const prepared = prepareWorkflowBundle(plan, verification);
  const binding = operationBindingSchema.parse(untrustedBinding);
  const target = cloudflareWorkflowTargetSchema.parse(untrustedTarget);
  const lane = plan.lanes.find((item) => item.id === binding.lane_id);
  const owner = prepared.workflows.find((item) => item.workflow_id === target.workflow_id);
  if (!lane || !owner || lane.workflow_id !== owner.workflow_id
    || owner.durable_engine !== 'cloudflare-workflows' || owner.identity_state_owner !== 'cloudflare'
    || owner.deployment_id !== target.prepared_deployment_id) {
    throw new Error('Operation does not bind the one canonical prepared Cloudflare owner.');
  }
  if (sha256Digest(profile) !== plan.source_profile.sha256 || profile.team.id !== plan.team_id) {
    throw new Error('Operation profile is not the exact verified plan profile.');
  }
  const role = profile.roles.find((item) => item.id === lane.role_id);
  if (!role || binding.capabilities.some((capability) => !role.capabilities.includes(capability))) {
    throw new Error('Operation capabilities exceed the exact profile role.');
  }
  const exactProfile = {
    repository: plan.source_profile.repository, commit_sha: plan.source_profile.commit_sha,
    path: plan.source_profile.path, digest_sha256: plan.source_profile.sha256,
  };
  if (sha256Digest(binding.source_profile) !== sha256Digest(exactProfile)
    || binding.plan_digest_sha256 !== prepared.plan_digest_sha256
    || binding.policy_digest_sha256 !== prepared.source_runtime_policy_digest_sha256
    || binding.pack_digest_sha256 !== prepared.pack_digest_sha256
    || binding.compiler_version !== prepared.compiler_version
    || binding.workload_id !== lane.id || binding.runtime_id !== lane.runtime
    || binding.budget_policy_id !== plan.budget.policy_id
    || binding.role !== (lane.independent_verifier ? 'checker' : 'maker')) {
    throw new Error('Operation profile, policy, plan, pack, compiler, lane, executor, role or budget binding differs.');
  }
  if (binding.requested_cost_usd > lane.budget.daily_cost_cap_usd
    || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,6})?$/.test(String(binding.requested_cost_usd))) {
    throw new Error('Operation cost exceeds the lane ceiling or exact micro-USD precision.');
  }
  const context: BoundCloudflareWorkflowOperation['context'] = {
    schema_version: 'starlight.workflow_operation_context.v1',
    input_context_digest_sha256: binding.context_digest_sha256,
    identity_state_owner: 'cloudflare', durable_engine: 'cloudflare-workflows',
    target, team_id: plan.team_id, role_id: lane.role_id,
  };
  const result: BoundCloudflareWorkflowOperation = freezeDeep({
    schema_version: 'starlight.bound_workflow_operation.v1',
    binding: { ...binding, context_digest_sha256: sha256Digest(context) }, context,
    activation_authority_granted: false,
  });
  issued.add(result);
  return result;
}

/** Digest-only correlation payload; private resource, prompt and actor data stays at the authority. */
export function cloudflareWorkflowOperationEnvelope(operation: BoundCloudflareWorkflowOperation) {
  if (!isIssuedCloudflareWorkflowOperation(operation)) throw new Error('Operation context receipt was not issued.');
  return {
    schema_version: 'starlight.workflow_operation_envelope.v1' as const,
    operation_binding_digest_sha256: sha256Digest(operation.binding),
    workflow_context_digest_sha256: sha256Digest(operation.context),
    workflow_target: operation.context.target,
  };
}
