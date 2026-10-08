/**
 * contract.ts — the provider-neutral managed-agent runtime port.
 *
 * One contract above three managed-agent surfaces (Anthropic Managed Agents,
 * the OpenAI Agents SDK over the Responses API, Gemini managed agents through
 * the Interactions API). Nothing above this port knows which provider ran.
 *
 * Sibling of GenCreator's `AgentRuntime` contract (gencreator.ai ADR-008):
 * same budget-reservation discipline (integer minor units, no floats), same
 * sealed receipt. GenCreator is tenant one of this port, not a fork of it.
 *
 * This module is types and schemas only. No network. No side effects.
 *
 * Proposal: Starlight-Intelligence-System
 * docs/strategic/2026-10-08-agentic-estate-production-architecture.md §4.
 */

import { z } from 'zod';

export const MANAGED_RUNTIME_SCHEMA_VERSION = 'starlight.managed_runtime.v0' as const;
export const RUN_REQUEST_SCHEMA_VERSION = 'starlight.run_request.v0' as const;
export const RUN_RECEIPT_SCHEMA_VERSION = 'starlight.run_receipt.v0' as const;

/** Which surface executes a run. `dry-run` is the in-process fake used by tests and the demo. */
export const providerSchema = z.enum(['anthropic', 'openai', 'gemini', 'self-hosted', 'dry-run']);
export type Provider = z.infer<typeof providerSchema>;

/**
 * Workload classes. The router maps each to a provider and a model class.
 * Names follow the routing table in the proposal (§4.2).
 */
export const workloadClassSchema = z.enum([
  'architecture',
  'canon',
  'protocol-reasoning',
  'board-review',
  'long-horizon-build',
  'repo-steward',
  'scheduled-deliverable',
  'tool-orchestration',
  'multi-agent-handoff',
  'customer-chat',
  'bulk-extraction',
  'classification',
  'research-scan',
  'sandbox-research',
  'volume-creator-work',
  'offline-sovereign',
]);
export type WorkloadClass = z.infer<typeof workloadClassSchema>;

/** Model class, resolved to a concrete model id per provider by the router's policy. */
export const modelClassSchema = z.enum(['top', 'operational', 'small', 'flash', 'local']);
export type ModelClass = z.infer<typeof modelClassSchema>;

/** Identifiers are plain ASCII tokens so they survive every provider's metadata limits. */
export const identifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, 'identifier must be an ASCII token');

export const isoDateTimeSchema = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), 'must be an RFC 3339 timestamp');

export const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, 'must be a lowercase sha256 hex digest');

/** A client-executed tool the agent may call. The runtime owns the execution, never the provider. */
export const customToolSchema = z
  .object({
    name: identifierSchema,
    description: z.string().trim().min(1).max(1024),
    inputSchema: z.record(z.string(), z.unknown()),
  })
  .strict();
export type CustomTool = z.infer<typeof customToolSchema>;

/**
 * Provider-neutral agent definition. Provisioned once per provider, referenced
 * by id on every run (the "agent first, then session" rule).
 */
export const agentSpecSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    instructions: z.string().min(1),
    workloadClass: workloadClassSchema,
    tools: z.array(customToolSchema).default([]),
    /** Web search and fetch stay off unless the job needs them. */
    web: z.boolean().default(false),
    /** When set, the run is kicked off as a graded outcome rather than a plain message. */
    outcomeRubric: z.string().min(1).optional(),
    metadata: z.record(z.string(), z.string()).default({}),
  })
  .strict();
export type AgentSpec = z.output<typeof agentSpecSchema>;
export type AgentSpecInput = z.input<typeof agentSpecSchema>;

/**
 * A budget reservation in integer micro-USD. Reserved before a run starts;
 * settled against the receipt afterwards. The same discipline GenCreator uses
 * in cents, at the finer unit the swarm's runtime policies already use.
 */
export const budgetReservationSchema = z
  .object({
    reservationId: identifierSchema,
    runId: identifierSchema,
    workspaceId: identifierSchema,
    currency: z.literal('USD'),
    limitMicroUsd: z.number().int().nonnegative(),
    spentMicroUsdBefore: z.number().int().nonnegative(),
    reservedMicroUsd: z.number().int().positive(),
    status: z.literal('reserved'),
    reservedAt: isoDateTimeSchema,
  })
  .strict();
export type BudgetReservation = z.infer<typeof budgetReservationSchema>;

/** A stored, versioned agent on a provider. */
export const agentRefSchema = z
  .object({
    provider: providerSchema,
    agentId: identifierSchema,
    version: z.number().int().nonnegative().nullable(),
  })
  .strict();
export type AgentRef = z.infer<typeof agentRefSchema>;

export const runRequestSchema = z
  .object({
    schemaVersion: z.literal(RUN_REQUEST_SCHEMA_VERSION),
    runId: identifierSchema,
    workspaceId: identifierSchema,
    actorId: identifierSchema,
    agent: agentRefSchema,
    /** Concrete model id, resolved by the router from the workload class. */
    model: z.string().trim().min(1),
    input: z.string().min(1),
    budget: budgetReservationSchema,
    /** Hard ceiling on provider-side loop iterations where the provider exposes one. */
    maxTurns: z.number().int().positive().max(64).default(8),
    metadata: z.record(z.string(), z.string()).default({}),
  })
  .strict()
  .refine((request) => request.budget.runId === request.runId, {
    message: 'budget reservation must belong to this run',
    path: ['budget', 'runId'],
  });
export type RunRequest = z.output<typeof runRequestSchema>;
export type RunRequestInput = z.input<typeof runRequestSchema>;

export const runStatusSchema = z.enum([
  'completed',
  'requires_action',
  'budget_reached',
  'refused',
  'error',
  'dry-run',
]);
export type RunStatus = z.infer<typeof runStatusSchema>;

export const usageSchema = z
  .object({
    requests: z.number().int().nonnegative(),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    cacheReadTokens: z.number().int().nonnegative(),
  })
  .strict();
export type Usage = z.infer<typeof usageSchema>;

/**
 * The attestation carried by every receipt. A declared label, not a signed
 * proof — the proposed SIP graph extension (`protocol/sign.mjs`) is where a
 * verifiable claim would come from. `composed` names what the run actually
 * composed; an empty list is a bug, never a decoration.
 */
export const attestationSchema = z
  .object({
    builtOnSip: z.literal(true),
    substrate: z.literal('SIP'),
    composed: z.array(z.string().min(1)).min(1),
  })
  .strict();
export type Attestation = z.infer<typeof attestationSchema>;

export const runReceiptSchema = z
  .object({
    schemaVersion: z.literal(RUN_RECEIPT_SCHEMA_VERSION),
    runId: identifierSchema,
    provider: providerSchema,
    model: z.string().min(1),
    agentId: identifierSchema,
    /** Provider-side session, response, or interaction id. */
    externalId: z.string().min(1),
    status: runStatusSchema,
    usage: usageSchema,
    /** Measured or provider-reported cost. Zero when the provider reports nothing; never estimated silently. */
    costMicroUsd: z.number().int().nonnegative(),
    /** True only when the provider says the work finished — never inferred from status alone. */
    completed: z.boolean(),
    outputText: z.string(),
    startedAt: isoDateTimeSchema,
    finishedAt: isoDateTimeSchema,
    attestation: attestationSchema,
    digest: sha256Schema,
  })
  .strict();
export type RunReceipt = z.infer<typeof runReceiptSchema>;

/** Steering events a caller can send into a live run. Deny is the unattended default. */
export type SteerEvent =
  | { type: 'message'; text: string }
  | { type: 'tool_result'; toolUseId: string; text: string; isError?: boolean }
  | { type: 'tool_confirmation'; toolUseId: string; result: 'allow' | 'deny' };

export interface ProvisionedAgent {
  provider: Provider;
  agentId: string;
  version: number | null;
}

/**
 * The port. Adapters implement it against one provider's documented SDK and
 * take an injected client, so the suite runs with no network and no keys.
 *
 *   provision — create the stored, versioned agent. Once. Not in the hot path.
 *   run       — start a session or run against a stored agent id under a budget
 *               reservation and return a sealed receipt.
 */
export interface ManagedAgentRuntime {
  readonly provider: Provider;
  provision(spec: AgentSpec, model: string): Promise<ProvisionedAgent>;
  run(request: RunRequest, spec: AgentSpec): Promise<RunReceipt>;
}

/** Parse helpers that throw with the schema's message. */
export function parseAgentSpec(input: unknown): AgentSpec {
  return agentSpecSchema.parse(input);
}

export function parseRunRequest(input: unknown): RunRequest {
  return runRequestSchema.parse(input);
}
