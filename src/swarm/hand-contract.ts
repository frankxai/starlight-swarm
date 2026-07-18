import { z } from 'zod';

const REQUIRED_READ_ONLY_DENIES = [
  'shell_exec',
  'file_write',
  'external_send',
  'publish',
  'spend',
  'secrets',
] as const;

const REQUIRED_PHASES = [
  'recover',
  'plan',
  'collect',
  'cross-check',
  'graph',
  'verify',
  'receipt',
] as const;

const handContractSchema = z
  .object({
    schema_version: z.literal('starlight.hand.v1'),
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{2,63}$/),
    owner: z.literal('starlight-queen'),
    runtime: z.enum(['hermes-cron', 'openfang-sidecar']),
    mode: z.literal('read-only'),
    enabled: z.boolean(),
    mission: z.object({
      outcome: z.string().min(10),
      done_when: z.array(z.string().min(3)).min(1),
    }),
    schedule: z.object({
      kind: z.literal('interval'),
      every_minutes: z.number().int().positive(),
      timezone: z.string().min(1),
      max_runs: z.number().int().positive().max(30),
    }),
    capabilities: z.object({
      tools: z.array(z.string().min(1)),
      deny: z.array(z.string().min(1)),
    }),
    memory: z.object({
      canonical_authority: z.literal('SIS'),
      write_mode: z.literal('projection-only'),
      read_namespaces: z.array(z.string().min(1)),
      knowledge_graph: z.object({
        source_required: z.boolean(),
        confidence_required: z.boolean(),
      }),
    }),
    execution: z.object({
      max_minutes: z.number().int().positive().max(60),
      max_model_cost_usd: z.number().nonnegative().max(5),
      max_tool_calls: z.number().int().positive().max(100),
      workdir: z.string().min(1),
    }),
    phases: z.array(z.string().min(1)),
    human_gates: z.array(z.string().min(1)),
    receipt: z.object({
      required_artifacts: z.array(z.string().min(1)).min(1),
      verifier: z.literal('independent'),
    }),
  })
  .strict()
  .superRefine((hand, context) => {
    if (hand.schedule.every_minutes < 60) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['schedule', 'every_minutes'],
        message: 'every_minutes must be at least 60 for autonomous hands',
      });
    }

    if (hand.capabilities.tools.includes('shell_exec')) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['capabilities', 'tools'],
        message: 'read-only hands cannot include shell_exec',
      });
    }

    const missingDenies = REQUIRED_READ_ONLY_DENIES.filter(
      (capability) => !hand.capabilities.deny.includes(capability),
    );
    if (missingDenies.length > 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['capabilities', 'deny'],
        message: `missing deny capabilities: ${missingDenies.join(', ')}`,
      });
    }

    if (
      !hand.memory.knowledge_graph.source_required ||
      !hand.memory.knowledge_graph.confidence_required
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['memory', 'knowledge_graph'],
        message: 'knowledge graph projections require source and confidence evidence',
      });
    }

    const missingPhases = REQUIRED_PHASES.filter((phase) => !hand.phases.includes(phase));
    if (missingPhases.length > 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['phases'],
        message: `missing phases: ${missingPhases.join(', ')}`,
      });
    }
  });

export type HandContract = z.infer<typeof handContractSchema>;

export function parseHandContract(input: unknown): HandContract {
  return handContractSchema.parse(input);
}
