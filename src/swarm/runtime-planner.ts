import { z } from 'zod';

import { sha256Digest } from './runtime-digest';

export const runtimeIds = [
  'railway-temporal',
  'vercel-eve',
  'hermes-local',
  'n8n-integration',
  'cloudflare-agents',
] as const;

export const teamProfileSourceSchema = z
  .object({
    repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    commit_sha: z
      .string()
      .regex(/^[a-f0-9]{40}$/)
      .refine((value) => !/^0+$/.test(value), 'Profile source commit cannot be the zero object id.'),
    path: z
      .string()
      .regex(/^(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/),
  })
  .strict();

export type TeamProfileSource = z.infer<typeof teamProfileSourceSchema>;

export type RuntimeId = (typeof runtimeIds)[number];

export type WorkloadClass =
  | 'durable-mission'
  | 'interactive-specialist'
  | 'scheduled-intelligence'
  | 'integration-automation'
  | 'edge-session';

export type QualityTier = 'economy' | 'balanced' | 'frontier' | 'checker-independent';

export type ProviderRoute =
  | 'direct-provider'
  | 'vercel-ai-gateway'
  | 'hermes-profile'
  | 'none';

export interface WorkloadRequirement {
  id: string;
  role_id: string;
  workload_class: WorkloadClass;
  interaction: 'async' | 'realtime' | 'scheduled' | 'event-driven';
  durability: 'ephemeral' | 'session' | 'run-receipt' | 'checkpointed';
  approval_waits: boolean;
  code_execution: boolean;
  third_party_connections: boolean;
  local_private_data: boolean;
  always_available: boolean;
  risk: 'low' | 'medium' | 'high';
  quality_tier: QualityTier;
  daily_token_cap: number;
  daily_cost_cap_usd: number;
}

export interface RuntimeRoutingPolicy {
  policy_id: string;
  policy_digest_sha256: string;
  eve_allowlisted_workload_ids: string[];
  allowed_runtimes: RuntimeId[];
}

const embeddedRoutingPolicySource = {
  policy_id: 'queen-runtime-policy-embedded-v1',
  eve_allowlisted_workload_ids: [] as string[],
  allowed_runtimes: ['railway-temporal', 'hermes-local', 'n8n-integration'] as RuntimeId[],
};

const embeddedRoutingPolicy: RuntimeRoutingPolicy = {
  ...embeddedRoutingPolicySource,
  policy_digest_sha256: sha256Digest(embeddedRoutingPolicySource),
};

export interface TeamRoleInput {
  id: string;
  profile_ref: string;
  capabilities: string[];
  write_scopes: string[];
  tools: string[];
  stop_conditions: string[];
  expected_outputs: string[];
}

export interface TeamProfileInput {
  schema_version: 'starlight.team_profile.v2';
  team: {
    id: string;
    display_name: string;
    operating_unit: string;
    coordinator_role_id: string;
    verifier_role_id: string;
    default_team_size: number;
    description?: string;
  };
  roles: TeamRoleInput[];
  routing: {
    required_roles: string[];
    optional_roles: string[];
    handoff_rules: string[];
  };
  permissions: {
    allowed_actions: string[];
    human_gate_actions: string[];
    default_write_scope: string[];
  };
  bindings: {
    skills: string[];
    plugins: string[];
    tools: string[];
  };
  eval_suite: string[];
  ownership: {
    owner: string;
    version: string;
    review_date: string;
  };
  extensions?: Record<string, unknown>;
}

export interface RuntimeDecision {
  runtime: RuntimeId;
  mission_authority: 'railway-temporal';
  reason_codes: string[];
  warnings: string[];
}

export interface TeamRuntimePlan {
  schema_version: 'starlight.team_runtime_plan.v1';
  team_id: string;
  source_profile: {
    schema_version: 'starlight.team_profile.v2';
    version: string;
    review_date: string;
    sha256: string;
    repository: string;
    commit_sha: string;
    path: string;
  };
  generated_at: string;
  activation_status: 'planned-human-approval-required';
  authority: {
    mission: 'railway-temporal';
    model_policy: 'queen-model-policy';
    observability: 'langfuse';
    integration: 'n8n';
    operator: 'hermes';
  };
  routing_policy: RuntimeRoutingPolicy;
  human_gate_actions: string[];
  budget: {
    policy_id: string;
    max_daily_cost_usd: number;
    planned_daily_cost_usd: number;
  };
  lanes: Array<{
    id: string;
    role_id: string;
    workload_contract: {
      workload_class: WorkloadClass;
      interaction: WorkloadRequirement['interaction'];
      durability: WorkloadRequirement['durability'];
      approval_waits: boolean;
      code_execution: boolean;
      third_party_connections: boolean;
      local_private_data: boolean;
      risk: WorkloadRequirement['risk'];
    };
    runtime: RuntimeId;
    mission_authority: 'railway-temporal';
    provider_route: ProviderRoute;
    model_route: QualityTier;
    budget: {
      daily_token_cap: number;
      daily_cost_cap_usd: number;
    };
    mode: 'dry-run';
    independent_verifier: boolean;
    reason_codes: string[];
    warnings: string[];
  }>;
}

const idSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/:*-]*$/);
const scopeSchema = z.string().regex(/^[A-Za-z0-9.][A-Za-z0-9._\/*:-]*$/);
const generatedAtSchema = z.iso.datetime({ offset: true });
const profileTextSchema = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .refine(
    (value) =>
      !/[\r\n\x00-\x08\x0B\x0C\x0E-\x1F]|```|<\/?system\b/i.test(value) &&
      !/(?:ignore|disregard|override).{0,32}(?:previous|above|system|guardrail|instruction)/i.test(value),
    'Unsafe profile text is not allowed in generated prompts.',
  );
const displayNameSchema = profileTextSchema.regex(
  /^[A-Za-z0-9][A-Za-z0-9 &+.,'()\/-]{0,119}$/,
  'Team display name contains unsafe prompt or Markdown syntax.',
);
const verifierWriteScopeSchema = /^(?:reports|receipts)(?:\/[A-Za-z0-9._*:-]+)*$/;
const prohibitedVerifierToolRequests = new Set([
  'deploy',
  'exec',
  'payments',
  'railway',
  'shell',
  'terminal',
  'terraform',
]);

const roleSchema = z
  .object({
    id: idSchema,
    profile_ref: idSchema,
    capabilities: z.array(idSchema),
    write_scopes: z.array(scopeSchema),
    tools: z.array(idSchema),
    stop_conditions: z.array(profileTextSchema).min(1),
    expected_outputs: z.array(profileTextSchema).min(1),
  })
  .strict();

const teamProfileSchema = z.object({
  schema_version: z.literal('starlight.team_profile.v2'),
  team: z.object({
    id: idSchema,
    display_name: displayNameSchema,
    operating_unit: idSchema,
    coordinator_role_id: idSchema,
    verifier_role_id: idSchema,
    default_team_size: z.number().int().min(3).max(5),
    description: profileTextSchema.optional(),
  }).strict(),
  roles: z.array(roleSchema).min(3),
  routing: z.object({
    required_roles: z
      .array(idSchema)
      .min(3, 'Required roles must include coordinator and verifier plus a maker.'),
    optional_roles: z.array(idSchema),
    handoff_rules: z.array(profileTextSchema).min(1),
  }).strict(),
  permissions: z.object({
    allowed_actions: z.array(idSchema),
    human_gate_actions: z
      .array(idSchema)
      .min(1, 'Team must define at least one human gate action.'),
    default_write_scope: z.array(scopeSchema),
  }).strict(),
  bindings: z.object({
    skills: z.array(idSchema),
    plugins: z.array(idSchema),
    tools: z.array(idSchema),
  }).strict(),
  eval_suite: z.array(idSchema).min(1),
  ownership: z.object({
    owner: idSchema,
    version: idSchema,
    review_date: z.string().min(1),
  }).strict(),
  extensions: z.record(z.string(), z.unknown()).optional(),
}).strict();

export function parseTeamProfile(input: unknown): TeamProfileInput {
  const parsed = teamProfileSchema.parse(input) as TeamProfileInput;
  const { coordinator_role_id: coordinator, verifier_role_id: verifier } = parsed.team;

  if (coordinator === verifier) {
    throw new Error('Team coordinator and verifier must be different roles.');
  }

  const roleIds = parsed.roles.map((role) => role.id);
  if (new Set(roleIds).size !== roleIds.length) {
    throw new Error('Team role ids must be unique.');
  }

  const requiredRoles = new Set(parsed.routing.required_roles);
  if (!requiredRoles.has(coordinator) || !requiredRoles.has(verifier)) {
    throw new Error('Team required roles must include independent coordinator and verifier roles.');
  }

  if (parsed.permissions.human_gate_actions.length === 0) {
    throw new Error('Team must define at least one human gate action.');
  }

  for (const roleId of [coordinator, verifier, ...parsed.routing.required_roles]) {
    if (!roleIds.includes(roleId)) {
      throw new Error(`Team references missing role: ${roleId}`);
    }
  }

  const verifierRole = parsed.roles.find((role) => role.id === verifier);
  if (!verifierRole) {
    throw new Error('Team references a missing verifier role.');
  }
  if (verifierRole.write_scopes.some((scope) => !verifierWriteScopeSchema.test(scope))) {
    throw new Error('Independent verifier write scopes must be audit-only reports or receipts paths.');
  }
  if (verifierRole.tools.some((tool) => prohibitedVerifierToolRequests.has(tool))) {
    throw new Error('Independent verifier tool requests cannot include explicit mutation capabilities.');
  }

  return parsed;
}

export function recommendRuntime(
  workload: WorkloadRequirement,
  policy: RuntimeRoutingPolicy | { eve_allowlisted_workload_ids: string[] } = embeddedRoutingPolicy,
): RuntimeDecision {
  const eveAllowlisted = policy.eve_allowlisted_workload_ids.includes(workload.id);
  const base = {
    mission_authority: 'railway-temporal' as const,
    warnings: [] as string[],
  };

  if (
    workload.risk === 'high' ||
    workload.code_execution ||
    (workload.third_party_connections && workload.workload_class !== 'integration-automation')
  ) {
    return {
      ...base,
      runtime: 'railway-temporal',
      reason_codes: [
        'sensitive-capability-requires-durable-gated-runtime',
        ...(workload.approval_waits ? ['durable-approval-wait'] : []),
      ],
      warnings: ['Sensitive capabilities require explicit Queen and human-gated grants.'],
    };
  }

  if (
    workload.workload_class === 'durable-mission' ||
    workload.durability === 'checkpointed' ||
    workload.approval_waits
  ) {
    return {
      ...base,
      runtime: 'railway-temporal',
      reason_codes: [workload.approval_waits ? 'durable-approval-wait' : 'durable-checkpointed-mission'],
    };
  }

  if (workload.workload_class === 'integration-automation') {
    return {
      ...base,
      runtime: 'n8n-integration',
      reason_codes: ['event-and-connector-automation'],
      warnings: ['n8n execution state is not canonical mission or approval authority.'],
    };
  }

  if (workload.workload_class === 'edge-session') {
    return {
      ...base,
      runtime: 'cloudflare-agents',
      reason_codes: ['edge-stateful-session'],
      warnings: ['Cloudflare is deferred until a measured edge or realtime requirement exists.'],
    };
  }

  if (
    (workload.workload_class === 'interactive-specialist' || workload.interaction === 'realtime') &&
    workload.risk === 'low' &&
    !workload.third_party_connections &&
    !workload.local_private_data &&
    eveAllowlisted
  ) {
    return {
      ...base,
      runtime: 'vercel-eve',
      reason_codes: ['interactive-agent-surface'],
      warnings: ['Vercel Eve is beta; consequential state and approvals remain in Railway Temporal.'],
    };
  }

  if (
    workload.workload_class === 'scheduled-intelligence' &&
    workload.interaction === 'scheduled' &&
    workload.local_private_data &&
    !workload.always_available
  ) {
    return {
      ...base,
      runtime: 'hermes-local',
      reason_codes: ['private-bounded-local-run'],
      warnings: ['Local Hermes pauses when the Windows host sleeps, is offline, or fails its capacity gate.'],
    };
  }

  return {
    ...base,
    runtime: 'railway-temporal',
    reason_codes: ['safe-durable-default'],
  };
}

function providerRouteFor(runtime: RuntimeId): ProviderRoute {
  if (runtime === 'vercel-eve') return 'vercel-ai-gateway';
  if (runtime === 'hermes-local') return 'hermes-profile';
  if (runtime === 'n8n-integration') return 'none';
  return 'direct-provider';
}

export function planTeamRuntime(
  input: unknown,
  workloads: WorkloadRequirement[],
  generatedAt: string,
  limits: {
    max_daily_cost_usd: number;
    policy_id?: string;
    routing_policy?: RuntimeRoutingPolicy;
    source_profile?: TeamProfileSource;
  } = { max_daily_cost_usd: 25 },
): TeamRuntimePlan {
  const team = parseTeamProfile(input);
  const routingPolicy = limits.routing_policy ?? embeddedRoutingPolicy;
  const generatedAtResult = generatedAtSchema.safeParse(generatedAt);
  if (!generatedAtResult.success) {
    throw new Error('Generated timestamp must be a valid ISO datetime with an explicit timezone.');
  }

  if (workloads.length < 3 || workloads.length > 5) {
    throw new Error('A team runtime plan requires three to five workload lanes.');
  }

  const workloadIds = workloads.map((workload) => workload.id);
  if (new Set(workloadIds).size !== workloadIds.length) {
    throw new Error('Workload lane ids must be unique.');
  }

  const workloadRoleIds = workloads.map((workload) => workload.role_id);
  if (new Set(workloadRoleIds).size !== workloadRoleIds.length) {
    throw new Error('Every workload lane must have a unique role assignment.');
  }

  const workloadRoles = new Set(workloads.map((workload) => workload.role_id));
  const missingRoles = team.routing.required_roles.filter((roleId) => !workloadRoles.has(roleId));

  if (missingRoles.length > 0) {
    throw new Error(`Missing required workload roles: ${missingRoles.join(', ')}`);
  }

  if (!workloadRoles.has(team.team.coordinator_role_id)) {
    throw new Error('The runtime plan must include its coordinator role.');
  }

  const verifierCount = workloads.filter(
    (workload) => workload.role_id === team.team.verifier_role_id,
  ).length;
  if (verifierCount !== 1) {
    throw new Error('The runtime plan requires exactly one independent verifier lane.');
  }

  const knownRoles = new Set(team.roles.map((role) => role.id));
  for (const workload of workloads) {
    if (!knownRoles.has(workload.role_id)) {
      throw new Error(`Workload ${workload.id} references unknown role ${workload.role_id}.`);
    }
  }

  const totalDailyCost = workloads.reduce((total, workload) => total + workload.daily_cost_cap_usd, 0);
  if (totalDailyCost > limits.max_daily_cost_usd) {
    throw new Error(
      `Daily cost cap ${totalDailyCost} exceeds team limit ${limits.max_daily_cost_usd}.`,
    );
  }
  if (!limits.source_profile) {
    throw new Error('Runtime planning requires an immutable team profile source reference.');
  }
  const profileSource = teamProfileSourceSchema.parse(limits.source_profile);

  return {
    schema_version: 'starlight.team_runtime_plan.v1',
    team_id: team.team.id,
    source_profile: {
      schema_version: team.schema_version,
      version: team.ownership.version,
      review_date: team.ownership.review_date,
      sha256: sha256Digest(team),
      repository: profileSource.repository,
      commit_sha: profileSource.commit_sha,
      path: profileSource.path,
    },
    generated_at: generatedAtResult.data,
    activation_status: 'planned-human-approval-required',
    authority: {
      mission: 'railway-temporal',
      model_policy: 'queen-model-policy',
      observability: 'langfuse',
      integration: 'n8n',
      operator: 'hermes',
    },
    routing_policy: routingPolicy,
    human_gate_actions: [...team.permissions.human_gate_actions],
    budget: {
      policy_id: limits.policy_id ?? 'starlight-team-daily-v1',
      max_daily_cost_usd: limits.max_daily_cost_usd,
      planned_daily_cost_usd: totalDailyCost,
    },
    lanes: workloads.map((workload) => {
      const decision = recommendRuntime(workload, routingPolicy);
      if (!routingPolicy.allowed_runtimes.includes(decision.runtime)) {
        throw new Error(
          `Runtime policy ${routingPolicy.policy_id} does not allow ${decision.runtime} for ${workload.id}.`,
        );
      }
      return {
        id: workload.id,
        role_id: workload.role_id,
        workload_contract: {
          workload_class: workload.workload_class,
          interaction: workload.interaction,
          durability: workload.durability,
          approval_waits: workload.approval_waits,
          code_execution: workload.code_execution,
          third_party_connections: workload.third_party_connections,
          local_private_data: workload.local_private_data,
          risk: workload.risk,
        },
        runtime: decision.runtime,
        mission_authority: decision.mission_authority,
        provider_route: providerRouteFor(decision.runtime),
        model_route: workload.quality_tier,
        budget: {
          daily_token_cap: workload.daily_token_cap,
          daily_cost_cap_usd: workload.daily_cost_cap_usd,
        },
        mode: 'dry-run',
        independent_verifier: workload.role_id === team.team.verifier_role_id,
        reason_codes: decision.reason_codes,
        warnings: decision.warnings,
      };
    }),
  };
}
