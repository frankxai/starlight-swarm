import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  assessRemoteStopAcknowledgementConformance,
  type RemoteStopAcknowledgement,
  type RemoteStopConformanceDependencies,
  type RemoteStopRequest,
} from './remote-stop-conformance';
import { sha256Digest } from './runtime-digest';

const request = (overrides: Partial<RemoteStopRequest> = {}): RemoteStopRequest => ({
  schema_version: 'starlight.remote_stop_request.v1',
  stop_request_id: '00000000-0000-4000-8000-000000001001',
  stop_sequence: 1,
  stop_request_audit_seq: 41,
  stop_request_audit_sha256: '0'.repeat(64),
  reservation_id: '00000000-0000-4000-8000-000000001002',
  claim_id: '00000000-0000-4000-8000-000000001003',
  operation_id: 'operation-remote-stop-001',
  effect_id: 'effect-remote-stop-001',
  binding_digest_sha256: '1'.repeat(64),
  runner_id: 'runner-001',
  runner_instance_id: 'runner-instance-001',
  runtime_id: 'runtime-001',
  host_id: 'host-001',
  channel_binding_sha256: '2'.repeat(64),
  launch_attempt_id: 'launch-attempt-001',
  process_instance_sha256: '3'.repeat(64),
  execution_generation: 7,
  stop_fence_generation: 8,
  requested_at: '2026-09-18T07:00:00.000Z',
  acknowledgement_deadline: '2026-09-18T07:01:00.000Z',
  reason: 'operator-cancel',
  ...overrides,
});

const normalizedRequest = (value: RemoteStopRequest): RemoteStopRequest => ({
  ...value,
  requested_at: new Date(value.requested_at).toISOString(),
  acknowledgement_deadline: new Date(value.acknowledgement_deadline).toISOString(),
});

const acknowledgement = (
  boundRequest = request(),
  overrides: Partial<RemoteStopAcknowledgement> = {},
): RemoteStopAcknowledgement => {
  const normalized = normalizedRequest(boundRequest);
  return {
    schema_version: 'starlight.remote_stop_acknowledgement.v1',
    acknowledgement_id: '00000000-0000-4000-8000-000000001004',
    stop_request_id: normalized.stop_request_id,
    stop_sequence: normalized.stop_sequence,
    stop_request_audit_seq: normalized.stop_request_audit_seq,
    stop_request_audit_sha256: normalized.stop_request_audit_sha256,
    request_sha256: sha256Digest(normalized),
    reservation_id: normalized.reservation_id,
    claim_id: normalized.claim_id,
    operation_id: normalized.operation_id,
    effect_id: normalized.effect_id,
    binding_digest_sha256: normalized.binding_digest_sha256,
    runner_id: normalized.runner_id,
    runner_instance_id: normalized.runner_instance_id,
    runtime_id: normalized.runtime_id,
    host_id: normalized.host_id,
    channel_binding_sha256: normalized.channel_binding_sha256,
    launch_attempt_id: normalized.launch_attempt_id,
    process_instance_sha256: normalized.process_instance_sha256,
    execution_generation: normalized.execution_generation,
    observed_stop_fence_generation: normalized.stop_fence_generation,
    supervisor_id: 'supervisor-001',
    supervisor_instance_id: 'supervisor-instance-001',
    supervisor_epoch: 12,
    acknowledgement_state: 'received',
    acknowledged_at: '2026-09-18T07:00:05.000Z',
    observed_at: '2026-09-18T07:00:06.000Z',
    access_review_expires_at: '2026-09-18T07:02:00.000Z',
    evidence_ref: 'supervisor-stop-ack-001',
    evidence_sha256: '4'.repeat(64),
    replay_state: 'fresh',
    transport_authenticated: true,
    ...overrides,
  };
};

const dependencies = (
  value = acknowledgement(),
  counters = { attestations: 0 },
): RemoteStopConformanceDependencies => ({
  attestAcknowledgement: async ({ request: received, request_sha256 }) => {
    counters.attestations += 1;
    assert.equal(request_sha256, sha256Digest(received));
    return { valid: true, acknowledgement: value, blockers: [] };
  },
});

test('authenticated acknowledgement binds the requested fence but grants no terminal or recovery authority', async () => {
  const result = await assessRemoteStopAcknowledgementConformance(request(), dependencies());
  assert.equal(result.valid_fixture, true);
  assert.equal(result.request_bound, true);
  assert.equal(result.supervisor_origin_authenticated, true);
  assert.equal(result.replay_safe, true);
  assert.equal(result.stop_fence_bound, true);
  assert.equal(result.remote_stop_request_acknowledged, true);
  assert.equal(result.remote_stop_confirmed, false);
  assert.equal(result.remote_stop_effect_observed, false);
  assert.equal(result.process_terminal_observed, false);
  assert.equal(result.descendants_quiesced, false);
  assert.equal(result.outcome_settlement_eligible, false);
  assert.equal(result.dispatch_authority_granted, false);
  assert.equal(result.execution_authority_granted, false);
  assert.equal(result.host_capacity_released, false);
  assert.equal(result.released_host_slots, 0);
  assert.equal(result.budget_commitment_released, false);
  assert.equal(result.released_cost_usd, '0.000000');
  assert.match(result.blockers.join(' '), /signal delivery/i);
  assert.match(result.acknowledgement_bundle_sha256 ?? '', /^[a-f0-9]{64}$/);
});

test('default-deny or throwing supervisor dependencies fail closed without leaking secrets', async () => {
  const denied: RemoteStopConformanceDependencies = {
    attestAcknowledgement: async () => ({
      valid: false,
      acknowledgement: null,
      blockers: ['supervisor-token=secret'],
    }),
  };
  const refused = await assessRemoteStopAcknowledgementConformance(request(), denied);
  assert.deepEqual(refused.blockers, ['Remote-stop supervisor attestation failed.']);
  assert.doesNotMatch(JSON.stringify(refused), /supervisor-token|secret/i);

  const throwing: RemoteStopConformanceDependencies = {
    attestAcknowledgement: async () => { throw new Error('supervisor-token=secret'); },
  };
  const errored = await assessRemoteStopAcknowledgementConformance(request(), throwing);
  assert.deepEqual(errored.blockers, ['Remote-stop supervisor attestation failed.']);
  assert.doesNotMatch(JSON.stringify(errored), /supervisor-token|secret/i);
});

test('malformed request refuses before the supervisor is consulted', async () => {
  const counters = { attestations: 0 };
  const malformed = await assessRemoteStopAcknowledgementConformance(
    { ...request(), stop_fence_generation: 9 },
    dependencies(acknowledgement(), counters),
  );
  assert.equal(malformed.valid_fixture, false);
  assert.deepEqual(malformed.blockers, ['Remote-stop request is malformed.']);
  assert.equal(counters.attestations, 0);
});

test('every execution binding field and the request digest are enforced', async () => {
  const cases: Array<[Partial<RemoteStopAcknowledgement>, RegExp]> = [
    [{ stop_request_id: '00000000-0000-4000-8000-000000001099' }, /another request or execution/i],
    [{ stop_sequence: 2 }, /another request or execution/i],
    [{ stop_request_audit_seq: 42 }, /another request or execution/i],
    [{ stop_request_audit_sha256: '6'.repeat(64) }, /another request or execution/i],
    [{ request_sha256: '9'.repeat(64) }, /another request or execution/i],
    [{ reservation_id: '00000000-0000-4000-8000-000000001098' }, /another request or execution/i],
    [{ claim_id: '00000000-0000-4000-8000-000000001097' }, /another request or execution/i],
    [{ operation_id: 'operation-other' }, /another request or execution/i],
    [{ effect_id: 'effect-other' }, /another request or execution/i],
    [{ binding_digest_sha256: '5'.repeat(64) }, /another request or execution/i],
    [{ runner_id: 'runner-other' }, /another request or execution/i],
    [{ runner_instance_id: 'runner-instance-other' }, /another request or execution/i],
    [{ runtime_id: 'runtime-other' }, /another request or execution/i],
    [{ host_id: 'host-other' }, /another request or execution/i],
    [{ channel_binding_sha256: '8'.repeat(64) }, /another request or execution/i],
    [{ launch_attempt_id: 'launch-attempt-other' }, /another request or execution/i],
    [{ process_instance_sha256: '7'.repeat(64) }, /another request or execution/i],
    [{ execution_generation: 6 }, /another request or execution/i],
  ];
  for (const [drift, expected] of cases) {
    const result = await assessRemoteStopAcknowledgementConformance(
      request(), dependencies(acknowledgement(request(), drift)),
    );
    assert.equal(result.valid_fixture, false);
    assert.equal(result.remote_stop_request_acknowledged, false);
    assert.match(result.blockers.join(' '), expected);
  }
});

test('replay conflict and non-advancing or over-advancing fences are refused', async () => {
  const replay = await assessRemoteStopAcknowledgementConformance(
    request(), dependencies(acknowledgement(request(), { replay_state: 'conflict' })),
  );
  assert.equal(replay.replay_safe, false);
  assert.match(replay.blockers.join(' '), /replayed with drifted evidence/i);

  for (const activeFence of [7, 9]) {
    const result = await assessRemoteStopAcknowledgementConformance(
      request(), dependencies(acknowledgement(request(), { observed_stop_fence_generation: activeFence })),
    );
    assert.equal(result.stop_fence_bound, false);
    assert.match(result.blockers.join(' '), /exact requested stop fence/i);
  }
});

test('acknowledgements must be ordered after request and before the deadline', async () => {
  for (const acknowledgedAt of ['2026-09-18T06:59:59.999Z', '2026-09-18T07:01:00.001Z']) {
    const result = await assessRemoteStopAcknowledgementConformance(
      request(), dependencies(acknowledgement(request(), {
        acknowledged_at: acknowledgedAt,
        observed_at: acknowledgedAt,
        access_review_expires_at: '2026-09-18T07:02:00.000Z',
      })),
    );
    assert.equal(result.valid_fixture, false);
    assert.match(result.blockers.join(' '), /ordering window/i);
  }
});

test('negative supervisor states are retained but cannot become acknowledgements', async () => {
  for (const acknowledgementState of ['already-terminal', 'not-found', 'rejected'] as const) {
    const result = await assessRemoteStopAcknowledgementConformance(
      request(), dependencies(acknowledgement(request(), { acknowledgement_state: acknowledgementState })),
    );
    assert.equal(result.acknowledgement_state, acknowledgementState);
    assert.equal(result.remote_stop_request_acknowledged, false);
    assert.equal(result.remote_stop_confirmed, false);
    assert.equal(result.host_capacity_released, false);
    assert.match(result.blockers.join(' '), /did not acknowledge receipt/i);
  }
});

test('caller-declared transport or terminal facts cannot enter the acknowledgement contract', async () => {
  const unauthenticated = {
    ...acknowledgement(),
    transport_authenticated: false,
  } as unknown as RemoteStopAcknowledgement;
  const denied = await assessRemoteStopAcknowledgementConformance(
    request(), dependencies(unauthenticated),
  );
  assert.equal(denied.valid_fixture, false);
  assert.deepEqual(denied.blockers, ['Remote-stop acknowledgement is malformed.']);

  const overstated = {
    ...acknowledgement(),
    restart_fenced: true,
    launch_queue_closed: true,
    descendants_quiesced: true,
  } as unknown as RemoteStopAcknowledgement;
  const strict = await assessRemoteStopAcknowledgementConformance(
    request(), dependencies(overstated),
  );
  assert.equal(strict.valid_fixture, false);
  assert.deepEqual(strict.blockers, ['Remote-stop acknowledgement is malformed.']);
});

test('exact retry and equivalent timestamp offsets produce one canonical acknowledgement digest', async () => {
  const fresh = await assessRemoteStopAcknowledgementConformance(request(), dependencies());
  const exactRetry = acknowledgement(request(), { replay_state: 'exact-retry' });
  const first = await assessRemoteStopAcknowledgementConformance(request(), dependencies(exactRetry));
  const second = await assessRemoteStopAcknowledgementConformance(request(), dependencies(exactRetry));
  assert.equal(first.acknowledgement_bundle_sha256, fresh.acknowledgement_bundle_sha256);
  assert.equal(first.acknowledgement_bundle_sha256, second.acknowledgement_bundle_sha256);

  const offsetRequest = request({
    requested_at: '2026-09-18T09:00:00.000+02:00',
    acknowledgement_deadline: '2026-09-18T09:01:00.000+02:00',
  });
  const offsetAcknowledgement = acknowledgement(offsetRequest, {
    acknowledged_at: '2026-09-18T09:00:05.000+02:00',
    observed_at: '2026-09-18T09:00:06.000+02:00',
    access_review_expires_at: '2026-09-18T09:02:00.000+02:00',
  });
  const offset = await assessRemoteStopAcknowledgementConformance(
    offsetRequest,
    dependencies(offsetAcknowledgement),
  );
  const utc = await assessRemoteStopAcknowledgementConformance(request(), dependencies());
  assert.equal(offset.acknowledgement_bundle_sha256, utc.acknowledgement_bundle_sha256);
});
