import { z } from 'zod';

import type { WorkloadRequirement } from './runtime-planner';

const workloadRequirementSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/),
    role_id: z.string().min(1),
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
    always_available: z.boolean(),
    risk: z.enum(['low', 'medium', 'high']),
    quality_tier: z.enum(['economy', 'balanced', 'frontier', 'checker-independent']),
    daily_token_cap: z.number().int().positive('daily_token_cap must be greater than 0'),
    daily_cost_cap_usd: z.number().positive('daily_cost_cap_usd must be greater than 0'),
  })
  .strict();

export function parseWorkloadRequirements(input: unknown): WorkloadRequirement[] {
  const parsed = z.array(workloadRequirementSchema).min(1).max(5).parse(input);
  const ids = parsed.map((workload) => workload.id);
  if (new Set(ids).size !== ids.length) {
    throw new Error('Workload ids must be unique.');
  }
  return parsed;
}
