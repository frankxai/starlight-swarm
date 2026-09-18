import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import {
  assessOpenAIProviderEvidenceConformance,
  type AuthenticatedOpenAICostsObservation,
  type OpenAIProviderEvidenceDependencies,
  type VerifiedOpenAIWebhookEvent,
} from './openai-provider-evidence-conformance';

const RAW_BODY = '{"id":"evt_abc123","type":"response.completed","data":{"id":"resp_abc123"}}';
const SIGNATURE = 'test-signature-sensitive';

const binding = {
  schema_version: 'starlight.openai_provider_operation_binding.v1' as const,
  operation_id: 'operation-001',
  binding_digest_sha256: '1'.repeat(64),
  provider_account_ref: 'organization-001',
  project_id: 'project-001',
  api_key_id: 'key-001',
  line_item: 'responses',
  expected_response_id: 'resp_abc123',
  webhook_endpoint_binding_ref: 'webhook-endpoint-project-001',
};

const verifiedEvent = (overrides: Partial<VerifiedOpenAIWebhookEvent> = {}): VerifiedOpenAIWebhookEvent => ({
  schema_version: 'starlight.openai_verified_webhook_event.v1',
  webhook_id: 'webhook-id-001',
  event_id: 'evt_abc123',
  event_type: 'response.completed',
  response_id: 'resp_abc123',
  occurred_at: '2026-09-18T04:00:00.000Z',
  raw_body_sha256: createHash('sha256').update(RAW_BODY).digest('hex'),
  endpoint_binding_ref: 'webhook-endpoint-project-001',
  verification_evidence_ref: 'verified-webhook-evt-abc123',
  replay_state: 'fresh',
  test_event: false,
  ...overrides,
});

const costsObservation = (
  overrides: Partial<AuthenticatedOpenAICostsObservation> = {},
): AuthenticatedOpenAICostsObservation => ({
  schema_version: 'starlight.openai_authenticated_costs_observation.v1',
  provider_account_ref: 'organization-001',
  admin_client_evidence_ref: 'openai-admin-client-001',
  observed_at: '2026-09-19T00:00:01.000Z',
  start_time: 1_789_689_600,
  end_time: 1_789_776_000,
  bucket_width: '1d',
  group_by: ['project_id', 'line_item', 'api_key_id'],
  pages: [{
    request_cursor: null,
    has_more: false,
    next_page: null,
    raw_body_sha256: '3'.repeat(64),
    buckets: [{
      start_time: 1_789_689_600,
      end_time: 1_789_776_000,
      results: [{
        project_id: 'project-001',
        api_key_id: 'key-001',
        line_item: 'responses',
        currency: 'usd',
        amount_json_lexeme: '0.06',
      }],
    }],
  }],
  ...overrides,
});

const dependencies = (
  event = verifiedEvent(),
  costs = costsObservation(),
  counters = { verifies: 0, reads: 0 },
): OpenAIProviderEvidenceDependencies => ({
  verifyWebhook: async (rawBody, headers) => {
    counters.verifies += 1;
    if (rawBody !== RAW_BODY || headers['webhook-signature'] !== SIGNATURE) {
      return { valid: false, event: null, blockers: ['OpenAI webhook signature is invalid.'] };
    }
    return { valid: true, event, blockers: [] };
  },
  readCosts: async () => {
    counters.reads += 1;
    return { valid: true, observation: costs, blockers: [] };
  },
});

const input = () => ({
  binding,
  webhook: { raw_body: RAW_BODY, headers: { 'webhook-signature': SIGNATURE } },
  costs_range: { start_time: 1_789_689_600, end_time: 1_789_776_000 },
});

test('verified response plus complete Costs bucket still grants no per-operation authority', async () => {
  const result = await assessOpenAIProviderEvidenceConformance(input(), dependencies());
  assert.equal(result.valid_fixture, true);
  assert.equal(result.event_origin_authenticated, true);
  assert.equal(result.response_id_bound, true);
  assert.equal(result.aggregate_cost_observed, true);
  assert.equal(result.per_operation_cost_authenticated, false);
  assert.equal(result.runner_usage_evidence_eligible, false);
  assert.equal(result.settlement_eligible, false);
  assert.equal(result.actual_usage_reconciled, false);
  assert.equal(result.budget_commitment_released, false);
  assert.equal(result.released_cost_usd, '0.000000');
  assert.match(result.blockers.join(' '), /no response subject/i);
  assert.match(result.observation_bundle_sha256 ?? '', /^[a-f0-9]{64}$/);
});

test('raw-body or signature drift refuses before the Costs API client is called', async () => {
  for (const webhook of [
    { raw_body: `${RAW_BODY} `, headers: { 'webhook-signature': SIGNATURE } },
    { raw_body: RAW_BODY, headers: { 'webhook-signature': 'wrong' } },
  ]) {
    const counters = { verifies: 0, reads: 0 };
    const result = await assessOpenAIProviderEvidenceConformance(
      { ...input(), webhook }, dependencies(verifiedEvent(), costsObservation(), counters),
    );
    assert.equal(result.event_origin_authenticated, false);
    assert.equal(result.observation_bundle_sha256, null);
    assert.equal(counters.verifies, 1);
    assert.equal(counters.reads, 0);
  }
});

test('dependency errors are sanitized and malformed runtime input fails closed', async () => {
  const secretVerifier: OpenAIProviderEvidenceDependencies = {
    verifyWebhook: async () => ({
      valid: false, event: null, blockers: ['whsec-secret and webhook-signature=secret'],
    }),
    readCosts: async () => ({
      valid: false, observation: null, blockers: ['admin-key-secret'],
    }),
  };
  const verifierDenied = await assessOpenAIProviderEvidenceConformance(input(), secretVerifier);
  assert.deepEqual(verifierDenied.blockers, ['OpenAI webhook verification failed.']);
  assert.doesNotMatch(JSON.stringify(verifierDenied), /whsec|signature=secret|admin-key-secret/i);

  const malformed = await assessOpenAIProviderEvidenceConformance(null, dependencies());
  assert.equal(malformed.valid_fixture, false);
  assert.deepEqual(malformed.blockers, ['OpenAI provider conformance input is malformed.']);

  const secretCosts: OpenAIProviderEvidenceDependencies = {
    verifyWebhook: dependencies().verifyWebhook,
    readCosts: async () => ({ valid: false, observation: null, blockers: ['admin-key-secret'] }),
  };
  const costsDenied = await assessOpenAIProviderEvidenceConformance(input(), secretCosts);
  assert.deepEqual(costsDenied.blockers, ['OpenAI Costs API read failed.']);
  assert.doesNotMatch(JSON.stringify(costsDenied), /admin-key-secret/i);
});

test('event subject, type, endpoint, replay drift, and dashboard tests fail closed', async () => {
  const cases: Array<[Partial<VerifiedOpenAIWebhookEvent>, RegExp]> = [
    [{ raw_body_sha256: '9'.repeat(64) }, /does not match the untouched raw body/i],
    [{ response_id: 'resp_other' }, /another operation/i],
    [{ event_type: 'response.failed' }, /not response.completed/i],
    [{ endpoint_binding_ref: 'webhook-endpoint-project-002' }, /another endpoint binding/i],
    [{ replay_state: 'conflict' }, /replayed with drifted evidence/i],
    [{ test_event: true }, /test events are not execution or billing evidence/i],
  ];
  for (const [drift, expected] of cases) {
    const counters = { verifies: 0, reads: 0 };
    const result = await assessOpenAIProviderEvidenceConformance(
      input(), dependencies(verifiedEvent(drift), costsObservation(), counters),
    );
    assert.equal(result.event_origin_authenticated, drift.raw_body_sha256 === undefined);
    assert.equal(result.response_id_bound, drift.response_id === undefined);
    assert.equal(result.runner_usage_evidence_eligible, false);
    assert.equal(counters.reads, 0);
    assert.match(result.blockers.join(' '), expected);
  }
});

test('pagination, account, grouping, and bucket defects cannot produce aggregate observation', async () => {
  const malformedPage = costsObservation({
    pages: [{ ...costsObservation().pages[0], has_more: true, next_page: 'cursor-002' }],
  });
  const malformed = await assessOpenAIProviderEvidenceConformance(input(), dependencies(verifiedEvent(), malformedPage));
  assert.equal(malformed.valid_fixture, false);
  assert.equal(malformed.aggregate_cost_observed, false);

  const bucketGap = costsObservation({
    end_time: 1_789_862_400,
    observed_at: '2026-09-20T00:00:01.000Z',
    pages: [{
      ...costsObservation().pages[0],
      buckets: [
        costsObservation().pages[0]!.buckets[0]!,
        {
          start_time: 1_789_776_001,
          end_time: 1_789_862_401,
          results: costsObservation().pages[0]!.buckets[0]!.results,
        },
      ],
    }],
  });
  const gapped = await assessOpenAIProviderEvidenceConformance(
    { ...input(), costs_range: { start_time: 1_789_689_600, end_time: 1_789_862_400 } },
    dependencies(verifiedEvent(), bucketGap),
  );
  assert.equal(gapped.valid_fixture, false);
  assert.equal(gapped.aggregate_cost_observed, false);

  const accountDrift = await assessOpenAIProviderEvidenceConformance(
    input(), dependencies(verifiedEvent(), costsObservation({ provider_account_ref: 'organization-002' })),
  );
  assert.equal(accountDrift.valid_fixture, true);
  assert.equal(accountDrift.aggregate_cost_observed, false);
  assert.match(accountDrift.blockers.join(' '), /another account or query range/i);

  const noUniqueGroup = costsObservation({
    pages: [{
      ...costsObservation().pages[0],
      buckets: [{
        ...costsObservation().pages[0]!.buckets[0]!,
        results: [{
          project_id: 'project-002', api_key_id: 'key-001', line_item: 'responses',
          currency: 'usd', amount_json_lexeme: '0.06',
        }],
      }],
    }],
  });
  const grouped = await assessOpenAIProviderEvidenceConformance(
    input(), dependencies(verifiedEvent(), noUniqueGroup),
  );
  assert.equal(grouped.aggregate_cost_observed, false);
  assert.match(grouped.blockers.join(' '), /no unique grouped aggregate cost result/i);
});

test('one aggregate result and exact retry remain advisory; secrets never enter the receipt', async () => {
  const exactRetry = verifiedEvent({ replay_state: 'exact-retry' });
  const first = await assessOpenAIProviderEvidenceConformance(input(), dependencies(exactRetry));
  const second = await assessOpenAIProviderEvidenceConformance(input(), dependencies(exactRetry));
  assert.equal(first.observation_bundle_sha256, second.observation_bundle_sha256);
  assert.equal(first.runner_usage_evidence_eligible, false);
  assert.equal(second.settlement_eligible, false);
  const serialized = JSON.stringify(first);
  assert.doesNotMatch(serialized, /test-signature-sensitive|webhook-signature|whsec|admin[_-]?key/i);
});

test('canonical bundle digest normalizes equivalent timestamp offsets', async () => {
  const utc = await assessOpenAIProviderEvidenceConformance(input(), dependencies());
  const offsetEvent = verifiedEvent({ occurred_at: '2026-09-18T06:00:00.000+02:00' });
  const offsetCosts = costsObservation({ observed_at: '2026-09-19T02:00:01.000+02:00' });
  const offset = await assessOpenAIProviderEvidenceConformance(
    input(), dependencies(offsetEvent, offsetCosts),
  );
  assert.equal(offset.observation_bundle_sha256, utc.observation_bundle_sha256);

  const subMillisecond = await assessOpenAIProviderEvidenceConformance(
    input(), dependencies(verifiedEvent({ occurred_at: '2026-09-18T04:00:00.000001Z' })),
  );
  assert.equal(subMillisecond.valid_fixture, false);
  assert.equal(subMillisecond.observation_bundle_sha256, null);
});

test('amount lexeme is hash-bound without Number coercion and cannot override hard denials', async () => {
  const original = await assessOpenAIProviderEvidenceConformance(input(), dependencies());
  const changedCosts = costsObservation({
    pages: [{
      ...costsObservation().pages[0],
      raw_body_sha256: '4'.repeat(64),
      buckets: [{
        ...costsObservation().pages[0]!.buckets[0]!,
        results: [{
          project_id: 'project-001', api_key_id: 'key-001', line_item: 'responses',
          currency: 'usd', amount_json_lexeme: '0.060000000000000001',
        }],
      }],
    }],
  });
  const changed = await assessOpenAIProviderEvidenceConformance(input(), dependencies(verifiedEvent(), changedCosts));
  assert.notEqual(changed.observation_bundle_sha256, original.observation_bundle_sha256);
  assert.equal(changed.runner_usage_evidence_eligible, false);
  assert.equal(changed.settlement_eligible, false);
  assert.equal(changed.budget_commitment_released, false);
});
