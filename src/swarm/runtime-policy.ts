import { z } from 'zod';

import { sha256Digest } from './runtime-digest';
import {
  runtimeIds,
  teamProfileSourceSchema,
  type RuntimeId,
  type RuntimeRoutingPolicy,
  type TeamProfileSource,
} from './runtime-planner';

const idSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]*$/);
const runtimePlanningPolicySchema = z
  .object({
    schema_version: z.literal('starlight.runtime_planning_policy.v1'),
    policy_id: idSchema,
    budget_policy_id: idSchema,
    max_daily_cost_usd: z.number().positive(),
    team_profile_source: teamProfileSourceSchema,
    eve_allowlisted_workload_ids: z.array(idSchema),
    allowed_runtimes: z.array(z.enum(runtimeIds)).min(1),
    deferred_runtimes: z.array(z.enum(runtimeIds)),
    activation_mode: z.literal('dry-run-only'),
    review_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  })
  .strict()
  .superRefine((policy, context) => {
    for (const key of ['eve_allowlisted_workload_ids', 'allowed_runtimes', 'deferred_runtimes'] as const) {
      if (new Set(policy[key]).size !== policy[key].length) {
        context.addIssue({ code: 'custom', message: `${key} entries must be unique.`, path: [key] });
      }
    }
    const overlap = policy.allowed_runtimes.filter((runtime) => policy.deferred_runtimes.includes(runtime));
    if (overlap.length) {
      context.addIssue({
        code: 'custom',
        message: `A runtime cannot be both allowed and deferred: ${overlap.join(', ')}`,
        path: ['allowed_runtimes'],
      });
    }
    if (policy.allowed_runtimes.includes('cloudflare-agents')) {
      context.addIssue({
        code: 'custom',
        message: 'Cloudflare Agents are deferred in runtime planning policy v1.',
        path: ['allowed_runtimes'],
      });
    }
  });

export interface RuntimePlanningPolicySource {
  schema_version: 'starlight.runtime_planning_policy.v1';
  policy_id: string;
  budget_policy_id: string;
  max_daily_cost_usd: number;
  team_profile_source: TeamProfileSource;
  eve_allowlisted_workload_ids: string[];
  allowed_runtimes: RuntimeId[];
  deferred_runtimes: RuntimeId[];
  activation_mode: 'dry-run-only';
  review_date: string;
}

export interface ResolvedRuntimePlanningPolicy {
  source: RuntimePlanningPolicySource;
  source_digest_sha256: string;
  routing_policy: RuntimeRoutingPolicy;
}

export function parseRuntimePlanningPolicy(input: unknown): ResolvedRuntimePlanningPolicy {
  const result = runtimePlanningPolicySchema.safeParse(input);
  if (!result.success) {
    const details = result.error.issues
      .slice(0, 6)
      .map((issue) => `${issue.path.join('.') || 'root'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid runtime planning policy: ${details}`);
  }
  const source = result.data as RuntimePlanningPolicySource;
  const sourceDigest = sha256Digest(source);
  return {
    source,
    source_digest_sha256: sourceDigest,
    routing_policy: {
      policy_id: source.policy_id,
      policy_digest_sha256: sourceDigest,
      eve_allowlisted_workload_ids: [...source.eve_allowlisted_workload_ids],
      allowed_runtimes: [...source.allowed_runtimes],
    },
  };
}
