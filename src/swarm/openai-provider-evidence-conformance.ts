import { createHash } from 'node:crypto';

import { z } from 'zod';

import { sha256Digest } from './runtime-digest';

const controlId = z.string().min(3).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const instant = z.iso.datetime({ offset: true, precision: 3 });
const amountLexeme = z.string().regex(/^(0|[1-9][0-9]{0,15})(\.[0-9]{1,18})?$/);

export const openAIProviderOperationBindingSchema = z.object({
  schema_version: z.literal('starlight.openai_provider_operation_binding.v1'),
  operation_id: controlId,
  binding_digest_sha256: digest,
  provider_account_ref: controlId,
  project_id: controlId,
  api_key_id: controlId,
  line_item: controlId,
  expected_response_id: controlId,
  webhook_endpoint_binding_ref: controlId,
}).strict();

const verifiedWebhookEventSchema = z.object({
  schema_version: z.literal('starlight.openai_verified_webhook_event.v1'),
  webhook_id: controlId,
  event_id: controlId,
  event_type: controlId,
  response_id: controlId,
  occurred_at: instant,
  raw_body_sha256: digest,
  endpoint_binding_ref: controlId,
  verification_evidence_ref: controlId,
  replay_state: z.enum(['fresh', 'exact-retry', 'conflict']),
  test_event: z.boolean(),
}).strict();

const costsResultSchema = z.object({
  project_id: controlId.nullable(),
  api_key_id: controlId.nullable(),
  line_item: controlId.nullable(),
  currency: z.literal('usd'),
  /** Exact JSON number lexeme preserved by the trusted client; never coerced through Number. */
  amount_json_lexeme: amountLexeme,
}).strict().superRefine((value, context) => {
  for (const grouping of ['project_id', 'line_item', 'api_key_id'] as const) {
    if (value[grouping] === null) {
      context.addIssue({
        code: 'custom',
        path: [grouping],
        message: `Maximally grouped OpenAI cost result must contain ${grouping}.`,
      });
    }
  }
});

const costsBucketSchema = z.object({
  start_time: z.number().int().nonnegative(),
  end_time: z.number().int().positive(),
  results: z.array(costsResultSchema),
}).strict().superRefine((value, context) => {
  if (value.end_time - value.start_time !== 86_400) {
    context.addIssue({
      code: 'custom',
      path: ['end_time'],
      message: 'OpenAI cost buckets must be exactly one day.',
    });
  }
});

const costsPageSchema = z.object({
  request_cursor: controlId.nullable(),
  has_more: z.boolean(),
  next_page: controlId.nullable(),
  raw_body_sha256: digest,
  buckets: z.array(costsBucketSchema),
}).strict().superRefine((value, context) => {
  if (value.has_more !== (value.next_page !== null)) {
    context.addIssue({
      code: 'custom',
      path: ['next_page'],
      message: 'Cost page continuation state is inconsistent.',
    });
  }
});

const authenticatedCostsObservationSchema = z.object({
  schema_version: z.literal('starlight.openai_authenticated_costs_observation.v1'),
  provider_account_ref: controlId,
  admin_client_evidence_ref: controlId,
  observed_at: instant,
  start_time: z.number().int().nonnegative(),
  end_time: z.number().int().positive(),
  bucket_width: z.literal('1d'),
  group_by: z.tuple([
    z.literal('project_id'),
    z.literal('line_item'),
    z.literal('api_key_id'),
  ]),
  pages: z.array(costsPageSchema).min(1),
}).strict().superRefine((value, context) => {
  if (value.start_time >= value.end_time) {
    context.addIssue({ code: 'custom', path: ['end_time'], message: 'Costs query range is empty.' });
  }
  if (Date.parse(value.observed_at) / 1_000 < value.end_time) {
    context.addIssue({ code: 'custom', path: ['observed_at'], message: 'Costs cannot be observed before the query range ends.' });
  }
  if (new Set(value.pages.map((page) => page.raw_body_sha256)).size !== value.pages.length) {
    context.addIssue({ code: 'custom', path: ['pages'], message: 'Costs pages must be unique.' });
  }
  const requestCursors = value.pages.flatMap((page) => page.request_cursor === null ? [] : [page.request_cursor]);
  const nextCursors = value.pages.flatMap((page) => page.next_page === null ? [] : [page.next_page]);
  if (new Set(requestCursors).size !== requestCursors.length
    || new Set(nextCursors).size !== nextCursors.length) {
    context.addIssue({ code: 'custom', path: ['pages'], message: 'Costs pagination cursors must not repeat.' });
  }
  if (value.pages[0]?.request_cursor !== null) {
    context.addIssue({ code: 'custom', path: ['pages', 0, 'request_cursor'], message: 'First costs page cannot have a cursor.' });
  }
  value.pages.forEach((page, index) => {
    if (index > 0 && page.request_cursor !== value.pages[index - 1]?.next_page) {
      context.addIssue({ code: 'custom', path: ['pages', index, 'request_cursor'], message: 'Costs pagination chain is incomplete.' });
    }
  });
  if (value.pages.at(-1)?.has_more !== false) {
    context.addIssue({ code: 'custom', path: ['pages'], message: 'Final costs page still has a continuation.' });
  }
  const buckets = value.pages.flatMap((page) => page.buckets);
  if (!buckets.length || buckets[0]?.start_time !== value.start_time
    || buckets.at(-1)?.end_time !== value.end_time) {
    context.addIssue({ code: 'custom', path: ['pages'], message: 'Costs buckets do not cover the complete query range.' });
  }
  buckets.forEach((bucket, index) => {
    if (index > 0 && bucket.start_time !== buckets[index - 1]?.end_time) {
      context.addIssue({ code: 'custom', path: ['pages'], message: 'Costs buckets contain a gap, overlap, or ordering drift.' });
    }
  });
});

export type OpenAIProviderOperationBinding = z.infer<typeof openAIProviderOperationBindingSchema>;
export type VerifiedOpenAIWebhookEvent = z.infer<typeof verifiedWebhookEventSchema>;
export type AuthenticatedOpenAICostsObservation = z.infer<typeof authenticatedCostsObservationSchema>;

export type OpenAIWebhookVerification =
  | { valid: true; event: VerifiedOpenAIWebhookEvent; blockers: [] }
  | { valid: false; event: null; blockers: string[] };

export type OpenAICostsRead =
  | { valid: true; observation: AuthenticatedOpenAICostsObservation; blockers: [] }
  | { valid: false; observation: null; blockers: string[] };

export interface OpenAIProviderEvidenceDependencies {
  /** Must verify the untouched raw body with the configured endpoint secret and enforce replay state. */
  verifyWebhook(rawBody: string, headers: Readonly<Record<string, string>>): Promise<OpenAIWebhookVerification>;
  /** Must use a server-owned Admin API client and preserve raw response digests and amount lexemes. */
  readCosts(input: {
    provider_account_ref: string;
    start_time: number;
    end_time: number;
    group_by: readonly ['project_id', 'line_item', 'api_key_id'];
  }): Promise<OpenAICostsRead>;
}

export interface OpenAIProviderEvidenceInput {
  binding: unknown;
  webhook: {
    raw_body: string;
    headers: Readonly<Record<string, string>>;
  };
  costs_range: {
    start_time: number;
    end_time: number;
  };
}

const openAIProviderEvidenceInputSchema = z.object({
  binding: z.unknown(),
  webhook: z.object({
    raw_body: z.string().min(1).max(10_000_000),
    headers: z.record(z.string(), z.string()),
  }).strict(),
  costs_range: z.object({
    start_time: z.number().int().nonnegative(),
    end_time: z.number().int().positive(),
  }).strict(),
}).strict();

export interface OpenAIProviderEvidenceConformanceResult {
  schema_version: 'starlight.openai_provider_evidence_conformance.v1';
  valid_fixture: boolean;
  event_origin_authenticated: boolean;
  response_id_bound: boolean;
  aggregate_cost_observed: boolean;
  per_operation_cost_authenticated: false;
  runner_usage_evidence_eligible: false;
  settlement_eligible: false;
  actual_usage_reconciled: false;
  budget_commitment_released: false;
  released_cost_usd: '0.000000';
  observation_bundle_sha256: string | null;
  blockers: string[];
}

const refused = (blockers: string[]): OpenAIProviderEvidenceConformanceResult => ({
  schema_version: 'starlight.openai_provider_evidence_conformance.v1',
  valid_fixture: false,
  event_origin_authenticated: false,
  response_id_bound: false,
  aggregate_cost_observed: false,
  per_operation_cost_authenticated: false,
  runner_usage_evidence_eligible: false,
  settlement_eligible: false,
  actual_usage_reconciled: false,
  budget_commitment_released: false,
  released_cost_usd: '0.000000',
  observation_bundle_sha256: null,
  blockers,
});

/**
 * Provider-specific conformance fixture. Trusted dependencies perform signature/replay and
 * Admin API transport checks; this evaluator binds their redacted attestations and refuses
 * to infer a response's cost from a daily aggregate. It has no authority-store dependency.
 */
export async function assessOpenAIProviderEvidenceConformance(
  candidate: unknown,
  dependencies: OpenAIProviderEvidenceDependencies,
): Promise<OpenAIProviderEvidenceConformanceResult> {
  const input = openAIProviderEvidenceInputSchema.safeParse(candidate);
  if (!input.success || !Number.isSafeInteger(input.data.costs_range.start_time)
    || !Number.isSafeInteger(input.data.costs_range.end_time)
    || input.data.costs_range.start_time >= input.data.costs_range.end_time) {
    return refused(['OpenAI provider conformance input is malformed.']);
  }
  const binding = openAIProviderOperationBindingSchema.safeParse(input.data.binding);
  if (!binding.success) return refused(['OpenAI provider conformance input is malformed.']);

  const verified = await dependencies.verifyWebhook(input.data.webhook.raw_body, input.data.webhook.headers);
  if (!verified.valid) return refused(['OpenAI webhook verification failed.']);
  const event = verifiedWebhookEventSchema.safeParse(verified.event);
  if (!event.success) return refused(['Verified OpenAI webhook attestation is malformed.']);

  const eventBlockers: string[] = [];
  const rawBodySha256 = createHash('sha256').update(input.data.webhook.raw_body, 'utf8').digest('hex');
  const rawBodyMatches = event.data.raw_body_sha256 === rawBodySha256;
  if (!rawBodyMatches) {
    eventBlockers.push('Verified OpenAI webhook digest does not match the untouched raw body.');
  }
  if (event.data.event_type !== 'response.completed') {
    eventBlockers.push('Verified OpenAI webhook is not response.completed.');
  }
  if (event.data.response_id !== binding.data.expected_response_id) {
    eventBlockers.push('Verified OpenAI response is bound to another operation.');
  }
  if (event.data.endpoint_binding_ref !== binding.data.webhook_endpoint_binding_ref) {
    eventBlockers.push('Verified OpenAI webhook used another endpoint binding.');
  }
  if (event.data.replay_state === 'conflict') {
    eventBlockers.push('OpenAI webhook ID was replayed with drifted evidence.');
  }
  if (event.data.test_event) {
    eventBlockers.push('OpenAI dashboard test events are not execution or billing evidence.');
  }
  if (eventBlockers.length) {
    return {
      ...refused(eventBlockers),
      event_origin_authenticated: rawBodyMatches,
      response_id_bound: event.data.response_id === binding.data.expected_response_id,
    };
  }

  const costs = await dependencies.readCosts({
    provider_account_ref: binding.data.provider_account_ref,
    start_time: input.data.costs_range.start_time,
    end_time: input.data.costs_range.end_time,
    group_by: ['project_id', 'line_item', 'api_key_id'],
  });
  if (!costs.valid) {
    return {
      ...refused(['OpenAI Costs API read failed.']),
      event_origin_authenticated: true,
      response_id_bound: true,
    };
  }
  const observation = authenticatedCostsObservationSchema.safeParse(costs.observation);
  if (!observation.success) {
    return {
      ...refused(['Authenticated OpenAI Costs API observation is incomplete or malformed.']),
      event_origin_authenticated: true,
      response_id_bound: true,
    };
  }

  const costsBlockers: string[] = [];
  if (observation.data.provider_account_ref !== binding.data.provider_account_ref
    || observation.data.start_time !== input.data.costs_range.start_time
    || observation.data.end_time !== input.data.costs_range.end_time) {
    costsBlockers.push('OpenAI Costs API observation is bound to another account or query range.');
  }
  const eventSecond = Math.floor(Date.parse(event.data.occurred_at) / 1_000);
  const matching = observation.data.pages.flatMap((page) => page.buckets)
    .filter((bucket) => bucket.start_time <= eventSecond && eventSecond < bucket.end_time)
    .flatMap((bucket) => bucket.results)
    .filter((result) => result.project_id === binding.data.project_id
      && result.api_key_id === binding.data.api_key_id
      && result.line_item === binding.data.line_item);
  if (matching.length !== 1) {
    costsBlockers.push('No unique grouped aggregate cost result covers the verified response event.');
  }

  const aggregateCostObserved = costsBlockers.length === 0;
  const blockers = [
    ...costsBlockers,
    'OpenAI Costs API evidence is aggregate-only and has no response subject.',
    'A signed response event does not authenticate its share of an aggregate cost bucket.',
  ];
  const observationBundle = {
    schema_version: 'starlight.openai_provider_evidence_bundle.v1',
    binding: binding.data,
    event: { ...event.data, occurred_at: new Date(event.data.occurred_at).toISOString() },
    costs: { ...observation.data, observed_at: new Date(observation.data.observed_at).toISOString() },
  };

  return {
    schema_version: 'starlight.openai_provider_evidence_conformance.v1',
    valid_fixture: true,
    event_origin_authenticated: true,
    response_id_bound: true,
    aggregate_cost_observed: aggregateCostObserved,
    per_operation_cost_authenticated: false,
    runner_usage_evidence_eligible: false,
    settlement_eligible: false,
    actual_usage_reconciled: false,
    budget_commitment_released: false,
    released_cost_usd: '0.000000',
    observation_bundle_sha256: sha256Digest(observationBundle),
    blockers,
  };
}

export const OPENAI_CURRENT_BILLING_SURFACE = Object.freeze({
  observed_on: '2026-09-18',
  webhook_docs: 'https://developers.openai.com/api/docs/guides/webhooks',
  costs_docs: 'https://developers.openai.com/api/reference/resources/admin/subresources/organization/subresources/usage/methods/costs',
  signed_event_type: 'response.completed',
  signed_event_subject: 'response_id',
  cost_bucket_width: '1d',
  cost_group_by: ['project_id', 'line_item', 'api_key_id'] as const,
  per_operation_cost_subject: null,
});
