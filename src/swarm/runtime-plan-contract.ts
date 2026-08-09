import { z } from 'zod';

import { runtimeIds, type TeamRuntimePlan } from './runtime-planner';

const boundedIdSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]*$/);
const uniqueStrings = (minimum = 0) =>
  z
    .array(z.string().min(1))
    .min(minimum)
    .refine((values) => new Set(values).size === values.length, {
      message: 'Entries must be unique.',
    });

const workloadContractSchema = z
  .object({
    workload_class: z.enum([
      'durable-mission',
      'interactive-specialist',
      'scheduled-intelligence',
      'integration-automation',
      'edge-session',
    ]),
    interaction: z.enum(['async', 'realtime', 'scheduled', 'event-driven']),
    durability: z.enum(['ephemeral', 'session', 'run-receipt', 'checkpointed']),
    approval_waits: z.boolean(),
    code_execution: z.boolean(),
    third_party_connections: z.boolean(),
    local_private_data: z.boolean(),
    risk: z.enum(['low', 'medium', 'high']),
  })
  .strict();

const laneSchema = z
  .object({
    id: boundedIdSchema,
    role_id: boundedIdSchema,
    workload_contract: workloadContractSchema,
    runtime: z.enum(runtimeIds),
    mission_authority: z.literal('railway-temporal'),
    provider_route: z.enum(['direct-provider', 'vercel-ai-gateway', 'hermes-profile', 'none']),
    model_route: z.enum(['economy', 'balanced', 'frontier', 'checker-independent']),
    budget: z
      .object({
        daily_token_cap: z.number().int().positive(),
        daily_cost_cap_usd: z.number().positive(),
      })
      .strict(),
    mode: z.literal('dry-run'),
    independent_verifier: z.boolean(),
    reason_codes: uniqueStrings(1),
    warnings: uniqueStrings(),
  })
  .strict();

const teamRuntimePlanSchema = z
  .object({
    schema_version: z.literal('starlight.team_runtime_plan.v1'),
    team_id: boundedIdSchema,
    source_profile: z
      .object({
        schema_version: z.literal('starlight.team_profile.v2'),
        version: z.string().min(1),
        review_date: z.string().min(1),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
        commit_sha: z.string().regex(/^[a-f0-9]{40}$/).refine((value) => !/^0+$/.test(value)),
        path: z.string().regex(/^(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/),
      })
      .strict(),
    generated_at: z.iso.datetime({ offset: true }),
    activation_status: z.literal('planned-human-approval-required'),
    authority: z
      .object({
        mission: z.literal('railway-temporal'),
        model_policy: z.literal('queen-model-policy'),
        observability: z.literal('langfuse'),
        integration: z.literal('n8n'),
        operator: z.literal('hermes'),
      })
      .strict(),
    routing_policy: z
      .object({
        policy_id: boundedIdSchema,
        policy_digest_sha256: z.string().regex(/^[a-f0-9]{64}$/),
        eve_allowlisted_workload_ids: z
          .array(boundedIdSchema)
          .refine((values) => new Set(values).size === values.length, {
            message: 'Eve allowlist entries must be unique.',
          }),
        allowed_runtimes: z
          .array(z.enum(runtimeIds))
          .min(1)
          .refine((values) => new Set(values).size === values.length, {
            message: 'Allowed runtimes must be unique.',
          }),
      })
      .strict(),
    human_gate_actions: uniqueStrings(1),
    budget: z
      .object({
        policy_id: boundedIdSchema,
        max_daily_cost_usd: z.number().positive(),
        planned_daily_cost_usd: z.number().positive(),
      })
      .strict(),
    lanes: z.array(laneSchema).min(3).max(5),
  })
  .strict()
  .superRefine((plan, context) => {
    const laneIds = plan.lanes.map((lane) => lane.id);
    if (new Set(laneIds).size !== laneIds.length) {
      context.addIssue({ code: 'custom', message: 'Lane ids must be unique.', path: ['lanes'] });
    }

    const roleIds = plan.lanes.map((lane) => lane.role_id);
    if (new Set(roleIds).size !== roleIds.length) {
      context.addIssue({
        code: 'custom',
        message: 'Lane role assignments must be unique.',
        path: ['lanes'],
      });
    }

    const verifierCount = plan.lanes.filter((lane) => lane.independent_verifier).length;
    if (verifierCount !== 1) {
      context.addIssue({
        code: 'custom',
        message: 'Exactly one independent verifier lane is required.',
        path: ['lanes'],
      });
    }

    const laneIdSet = new Set(laneIds);
    for (const workloadId of plan.routing_policy.eve_allowlisted_workload_ids) {
      if (!laneIdSet.has(workloadId)) {
        context.addIssue({
          code: 'custom',
          message: 'Eve allowlist entries must reference lanes in this exact plan.',
          path: ['routing_policy', 'eve_allowlisted_workload_ids'],
        });
      }
    }

    const expectedProvider = {
      'railway-temporal': 'direct-provider',
      'vercel-eve': 'vercel-ai-gateway',
      'hermes-local': 'hermes-profile',
      'n8n-integration': 'none',
      'cloudflare-agents': 'direct-provider',
    } as const;

    plan.lanes.forEach((lane, index) => {
      if (!plan.routing_policy.allowed_runtimes.includes(lane.runtime)) {
        context.addIssue({
          code: 'custom',
          message: `Runtime ${lane.runtime} is not allowed by the bound routing policy.`,
          path: ['lanes', index, 'runtime'],
        });
      }
      if (lane.provider_route !== expectedProvider[lane.runtime]) {
        context.addIssue({
          code: 'custom',
          message: `Provider route ${lane.provider_route} is invalid for runtime ${lane.runtime}.`,
          path: ['lanes', index, 'provider_route'],
        });
      }

      if (lane.runtime === 'cloudflare-agents') {
        context.addIssue({
          code: 'custom',
          message: 'Cloudflare Agents are deferred and cannot be selected by runtime-plan v1.',
          path: ['lanes', index, 'runtime'],
        });
      }

      if (lane.runtime === 'n8n-integration' && lane.workload_contract.workload_class !== 'integration-automation') {
        context.addIssue({
          code: 'custom',
          message: 'n8n is confined to integration-automation workloads.',
          path: ['lanes', index, 'workload_contract', 'workload_class'],
        });
      }

      if (lane.independent_verifier) {
        if (lane.model_route !== 'checker-independent' || lane.runtime === 'vercel-eve') {
          context.addIssue({
            code: 'custom',
            message: 'The independent verifier must use checker-independent routing outside Eve.',
            path: ['lanes', index],
          });
        }
      } else if (lane.model_route === 'checker-independent') {
        context.addIssue({
          code: 'custom',
          message: 'Only the independent verifier may use checker-independent routing.',
          path: ['lanes', index, 'model_route'],
        });
      }

      if (lane.runtime === 'vercel-eve') {
        const contract = lane.workload_contract;
        if (!plan.routing_policy.eve_allowlisted_workload_ids.includes(lane.id)) {
          context.addIssue({
            code: 'custom',
            message: 'Every Eve lane must be bound to the authority-owned routing allowlist.',
            path: ['lanes', index, 'runtime'],
          });
        }
        if (
          contract.risk !== 'low' ||
          contract.code_execution ||
          contract.local_private_data ||
          contract.approval_waits ||
          !['ephemeral', 'session', 'run-receipt'].includes(contract.durability)
        ) {
          context.addIssue({
            code: 'custom',
            message: 'Eve lanes must remain low-risk, non-code, non-private, non-waiting bounded sessions.',
            path: ['lanes', index, 'workload_contract'],
          });
        }
      }
    });

    const plannedCost = plan.lanes.reduce(
      (total, lane) => total + lane.budget.daily_cost_cap_usd,
      0,
    );
    if (Math.abs(plannedCost - plan.budget.planned_daily_cost_usd) > 1e-9) {
      context.addIssue({
        code: 'custom',
        message: 'Planned daily cost must equal the sum of lane cost caps.',
        path: ['budget', 'planned_daily_cost_usd'],
      });
    }
    if (plannedCost > plan.budget.max_daily_cost_usd) {
      context.addIssue({
        code: 'custom',
        message: 'Planned daily cost exceeds the team hard limit.',
        path: ['budget'],
      });
    }
  });

export function parseTeamRuntimePlan(input: unknown): TeamRuntimePlan {
  const result = teamRuntimePlanSchema.safeParse(input);
  if (!result.success) {
    const details = result.error.issues
      .slice(0, 6)
      .map((issue) => `${issue.path.join('.') || 'root'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid team runtime plan: ${details}`);
  }
  return result.data as TeamRuntimePlan;
}
