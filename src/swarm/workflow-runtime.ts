import { z } from 'zod';

import { sha256Digest } from './runtime-digest';
import { parseWorkloadRequirements } from './runtime-input';
import { parseTeamRuntimePlan } from './runtime-plan-contract';
import { parseTeamProfile, teamProfileSourceSchema, type TeamRuntimePlan, type WorkloadRequirement } from './runtime-planner';
import { parseRuntimePlanningPolicy } from './runtime-policy';

export const workflowRuntimeIds = ['cloudflare-workflows', 'vercel-workflow', 'railway-worker', 'hermes-local', 'n8n-integration'] as const;
export const durableEngines = ['cloudflare-workflows', 'vercel-workflow'] as const;
const id = z.string().regex(/^[a-z0-9][a-z0-9._-]*$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const unique = <T extends z.ZodType>(schema: T, minimum = 0) => z.array(schema).min(minimum).refine((values) => new Set(values).size === values.length, 'Entries must be unique.');

const ownershipEntry = z.object({
  workflow_id: id,
  workload_scope: z.enum(['agent-centric', 'cross-service', 'app-local']),
  identity_state_owner: z.enum(['cloudflare', 'vercel']),
  durable_engine: z.enum(durableEngines),
}).strict().superRefine((entry, context) => {
  const app = entry.workload_scope === 'app-local';
  if (entry.identity_state_owner !== (app ? 'vercel' : 'cloudflare') || entry.durable_engine !== (app ? 'vercel-workflow' : 'cloudflare-workflows')) {
    context.addIssue({ code: 'custom', message: 'Durable engine must match the accepted workload scope and identity/state owner.' });
  }
});
export const workflowOwnershipSchema = z.array(ownershipEntry).min(1).max(5).refine((entries) => new Set(entries.map((entry) => entry.workflow_id)).size === entries.length, 'A workflow must have one unique durable owner.');

export const workflowPlanningPolicySchema = z.object({
  schema_version: z.literal('starlight.runtime_planning_policy.v2'),
  policy_id: id, budget_policy_id: id, max_daily_cost_usd: z.number().positive().finite(),
  team_profile_source: teamProfileSourceSchema,
  eve_allowlisted_workload_ids: z.tuple([]),
  allowed_runtimes: unique(z.enum(workflowRuntimeIds), 1),
  deferred_runtimes: unique(z.enum(workflowRuntimeIds)),
  activation_mode: z.literal('dry-run-only'), review_date: z.iso.date(),
  workflow_ownership: workflowOwnershipSchema,
}).strict().superRefine((policy, context) => {
  if (policy.allowed_runtimes.some((runtime) => policy.deferred_runtimes.includes(runtime))) context.addIssue({ code: 'custom', message: 'A runtime cannot be both allowed and deferred.' });
  for (const workflow of policy.workflow_ownership) {
    if (!policy.allowed_runtimes.includes(workflow.durable_engine)) context.addIssue({ code: 'custom', message: 'Every durable engine must be allowed by the exact policy.' });
  }
});
export type WorkflowPlanningPolicySource = z.infer<typeof workflowPlanningPolicySchema>;
export type WorkflowOwnership = WorkflowPlanningPolicySource['workflow_ownership'][number];
export type WorkflowRuntimeId = typeof workflowRuntimeIds[number];
export interface ResolvedWorkflowPlanningPolicy {
  source: WorkflowPlanningPolicySource;
  source_digest_sha256: string;
  routing_policy: {
    policy_id: string; policy_digest_sha256: string; eve_allowlisted_workload_ids: [];
    allowed_runtimes: WorkflowRuntimeId[];
  };
}
export function parseWorkflowPlanningPolicy(input: unknown): ResolvedWorkflowPlanningPolicy {
  const source = workflowPlanningPolicySchema.parse(input);
  const sourceDigest = sha256Digest(source);
  return { source, source_digest_sha256: sourceDigest, routing_policy: { policy_id: source.policy_id, policy_digest_sha256: sourceDigest, eve_allowlisted_workload_ids: [], allowed_runtimes: [...source.allowed_runtimes] } };
}

export type WorkflowWorkload = WorkloadRequirement & { workflow_id: string };
export function parseWorkflowWorkloads(input: unknown): WorkflowWorkload[] {
  const entries = z.array(z.record(z.string(), z.unknown())).min(3).max(5).parse(input);
  return parseWorkloadRequirements(entries.map(({ workflow_id: _workflowId, ...entry }) => entry)).map((workload, index) => ({ ...workload, workflow_id: id.parse(entries[index].workflow_id) }));
}

const workloadContract = z.object({
  workload_class: z.enum(['durable-mission', 'interactive-specialist', 'scheduled-intelligence', 'integration-automation', 'edge-session']),
  interaction: z.enum(['async', 'realtime', 'scheduled', 'event-driven']),
  durability: z.enum(['ephemeral', 'session', 'run-receipt', 'checkpointed']),
  approval_waits: z.boolean(), code_execution: z.boolean(), third_party_connections: z.boolean(),
  local_private_data: z.boolean(), always_available: z.boolean(), risk: z.enum(['low', 'medium', 'high']),
}).strict();
const laneSchema = z.object({
  id, role_id: id, workflow_id: id, workload_contract: workloadContract,
  runtime: z.enum(workflowRuntimeIds), mission_authority: z.enum(durableEngines),
  provider_route: z.enum(['direct-provider', 'vercel-ai-gateway', 'hermes-profile', 'none']),
  model_route: z.enum(['economy', 'balanced', 'frontier', 'checker-independent']),
  budget: z.object({ daily_token_cap: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), daily_cost_cap_usd: z.number().positive().finite() }).strict(),
  mode: z.literal('dry-run'), independent_verifier: z.boolean(),
  reason_codes: unique(z.string().min(1), 1), warnings: unique(z.string().min(1)),
}).strict();

function executorFor(contract: z.infer<typeof workloadContract>, owner: WorkflowOwnership): WorkflowRuntimeId {
  if (contract.local_private_data) {
    if (contract.always_available) throw new Error('Private local workloads cannot demand an always-available cloud executor.');
    return 'hermes-local';
  }
  if (contract.code_execution) return 'railway-worker';
  if (contract.workload_class === 'integration-automation') return 'n8n-integration';
  return owner.durable_engine;
}
function providerFor(runtime: WorkflowRuntimeId) {
  if (runtime === 'vercel-workflow') return 'vercel-ai-gateway' as const;
  if (runtime === 'hermes-local') return 'hermes-profile' as const;
  if (runtime === 'n8n-integration') return 'none' as const;
  return 'vercel-ai-gateway' as const;
}

export const workflowRuntimePlanSchema = z.object({
  schema_version: z.literal('starlight.team_runtime_plan.v2'), team_id: id,
  source_profile: teamProfileSourceSchema.extend({ schema_version: z.literal('starlight.team_profile.v2'), version: z.string().min(1), review_date: z.string().min(1), sha256: digest }).strict(),
  generated_at: z.iso.datetime({ offset: true }), activation_status: z.literal('planned-human-approval-required'),
  authority: z.object({ mission: z.literal('per-workflow'), model_policy: z.literal('queen-model-policy'), observability: z.literal('langfuse'), integration: z.literal('n8n'), operator: z.literal('hermes') }).strict(),
  routing_policy: z.object({ policy_id: id, policy_digest_sha256: digest, eve_allowlisted_workload_ids: z.tuple([]), allowed_runtimes: unique(z.enum(workflowRuntimeIds), 1) }).strict(),
  workflow_ownership: workflowOwnershipSchema, human_gate_actions: unique(z.string().min(1), 1),
  budget: z.object({ policy_id: id, max_daily_cost_usd: z.number().positive().finite(), planned_daily_cost_usd: z.number().positive().finite() }).strict(),
  lanes: z.array(laneSchema).min(3).max(5),
}).strict().superRefine((plan, context) => {
  for (const field of ['id', 'role_id'] as const) if (new Set(plan.lanes.map((lane) => lane[field])).size !== plan.lanes.length) context.addIssue({ code: 'custom', message: `Lane ${field} assignments must be unique.` });
  if (plan.lanes.filter((lane) => lane.independent_verifier).length !== 1) context.addIssue({ code: 'custom', message: 'Exactly one independent verifier is required.' });
  const used = new Set(plan.lanes.map((lane) => lane.workflow_id));
  if (plan.workflow_ownership.some((entry) => !used.has(entry.workflow_id))) context.addIssue({ code: 'custom', message: 'Unused workflow ownership is not permitted in the exact plan.' });
  for (const lane of plan.lanes) {
    const owner = plan.workflow_ownership.find((entry) => entry.workflow_id === lane.workflow_id);
    if (!owner || lane.mission_authority !== owner.durable_engine) {
      context.addIssue({ code: 'custom', message: `Lane ${lane.id} must bind its exact workflow owner and engine.` }); continue;
    }
    if (!plan.routing_policy.allowed_runtimes.includes(owner.durable_engine)) context.addIssue({ code: 'custom', message: 'Durable engine is not allowed by the bound policy.' });
    try {
      if (lane.runtime !== executorFor(lane.workload_contract, owner)) context.addIssue({ code: 'custom', message: `Lane ${lane.id} executor does not satisfy its code/private workload contract.` });
    } catch (error) { context.addIssue({ code: 'custom', message: error instanceof Error ? error.message : 'Invalid executor.' }); }
    if (!plan.routing_policy.allowed_runtimes.includes(lane.runtime) || lane.provider_route !== providerFor(lane.runtime)) context.addIssue({ code: 'custom', message: `Lane ${lane.id} runtime/provider does not match its policy.` });
    if (lane.independent_verifier !== (lane.model_route === 'checker-independent')) context.addIssue({ code: 'custom', message: 'Only the independent verifier can use checker-independent routing.' });
  }
  const cost = plan.lanes.reduce((total, lane) => total + lane.budget.daily_cost_cap_usd, 0);
  if (!Number.isFinite(cost) || Math.abs(cost - plan.budget.planned_daily_cost_usd) > 1e-9 || cost > plan.budget.max_daily_cost_usd) context.addIssue({ code: 'custom', message: 'Lane cost caps must sum to the exact planned cost within the team budget.' });
});
export type WorkflowRuntimePlan = z.infer<typeof workflowRuntimePlanSchema>;
export type GovernedRuntimePlan = TeamRuntimePlan | WorkflowRuntimePlan;
export function parseWorkflowRuntimePlan(input: unknown): WorkflowRuntimePlan { return workflowRuntimePlanSchema.parse(input); }

export function planWorkflowRuntime(teamInput: unknown, workloadInput: unknown, generatedAt: string, resolvedInput: ResolvedWorkflowPlanningPolicy): WorkflowRuntimePlan {
  // Reparse the source: a caller-modified resolved object is never a trusted routing policy.
  const resolved = parseWorkflowPlanningPolicy(resolvedInput.source);
  const team = parseTeamProfile(teamInput);
  const workloads = parseWorkflowWorkloads(workloadInput);
  const roleIds = new Set(workloads.map((workload) => workload.role_id));
  if (roleIds.size !== workloads.length || team.routing.required_roles.some((role) => !roleIds.has(role)) || !roleIds.has(team.team.coordinator_role_id) || !roleIds.has(team.team.verifier_role_id) || workloads.some((workload) => !team.roles.some((role) => role.id === workload.role_id))) throw new Error('All required team roles must have unique, known workload lanes.');
  const result: WorkflowRuntimePlan = {
    schema_version: 'starlight.team_runtime_plan.v2', team_id: team.team.id,
    source_profile: { schema_version: team.schema_version, version: team.ownership.version, review_date: team.ownership.review_date, sha256: sha256Digest(team), ...resolved.source.team_profile_source },
    generated_at: generatedAt, activation_status: 'planned-human-approval-required',
    authority: { mission: 'per-workflow', model_policy: 'queen-model-policy', observability: 'langfuse', integration: 'n8n', operator: 'hermes' },
    routing_policy: resolved.routing_policy, workflow_ownership: resolved.source.workflow_ownership,
    human_gate_actions: [...team.permissions.human_gate_actions],
    budget: { policy_id: resolved.source.budget_policy_id, max_daily_cost_usd: resolved.source.max_daily_cost_usd, planned_daily_cost_usd: workloads.reduce((total, workload) => total + workload.daily_cost_cap_usd, 0) },
    lanes: workloads.map((workload) => {
      const owner = resolved.source.workflow_ownership.find((entry) => entry.workflow_id === workload.workflow_id);
      if (!owner) throw new Error(`No exact workflow owner for ${workload.id}.`);
      const { id: laneId, role_id, workflow_id, quality_tier, daily_token_cap, daily_cost_cap_usd, ...contract } = workload;
      const runtime = executorFor(contract, owner);
      return { id: laneId, role_id, workflow_id, workload_contract: contract, runtime, mission_authority: owner.durable_engine, provider_route: providerFor(runtime), model_route: quality_tier, budget: { daily_token_cap, daily_cost_cap_usd }, mode: 'dry-run', independent_verifier: role_id === team.team.verifier_role_id, reason_codes: ['exact-workflow-owner', runtime === 'railway-worker' ? 'replaceable-code-executor' : 'bound-workload-executor'], warnings: ['Plans and compiler receipts do not authorize workflow start or executor grants.'] };
    }),
  };
  return parseWorkflowRuntimePlan(result);
}

function versionOf(input: unknown): unknown { return input && typeof input === 'object' ? (input as Record<string, unknown>).schema_version : undefined; }
export function parseGovernedRuntimePlan(input: unknown): GovernedRuntimePlan {
  return versionOf(input) === 'starlight.team_runtime_plan.v2' ? parseWorkflowRuntimePlan(input) : parseTeamRuntimePlan(input);
}
export function parseGovernedRuntimePlanningPolicy(input: unknown) {
  return versionOf(input) === 'starlight.runtime_planning_policy.v2' ? parseWorkflowPlanningPolicy(input) : parseRuntimePlanningPolicy(input);
}
