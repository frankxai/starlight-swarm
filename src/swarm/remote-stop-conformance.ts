import { z } from 'zod';

import { sha256Digest } from './runtime-digest';

const controlId = z.string().min(3).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const instant = z.iso.datetime({ offset: true, precision: 3 });
const generation = z.number().int().min(1).max(1_000_000_000);

export const remoteStopRequestSchema = z.object({
  schema_version: z.literal('starlight.remote_stop_request.v1'),
  stop_request_id: z.uuid(),
  stop_sequence: z.number().int().min(1).max(1_000_000_000),
  stop_request_audit_seq: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  stop_request_audit_sha256: digest,
  reservation_id: z.uuid(),
  claim_id: z.uuid(),
  operation_id: controlId,
  effect_id: controlId,
  binding_digest_sha256: digest,
  runner_id: controlId,
  runner_instance_id: controlId,
  runtime_id: controlId,
  host_id: controlId,
  channel_binding_sha256: digest,
  launch_attempt_id: controlId,
  process_instance_sha256: digest.nullable(),
  execution_generation: generation,
  stop_fence_generation: generation,
  requested_at: instant,
  acknowledgement_deadline: instant,
  reason: z.enum([
    'operator-cancel',
    'policy-revoked',
    'heartbeat-expired',
    'principal-disabled',
    'budget-breach',
    'supervisor-recovery',
  ]),
}).strict().superRefine((value, context) => {
  if (value.execution_generation === 1_000_000_000
    || value.stop_fence_generation !== value.execution_generation + 1) {
    context.addIssue({
      code: 'custom',
      path: ['stop_fence_generation'],
      message: 'Remote stop must advance the execution fence exactly once.',
    });
  }
  const requestedAt = Date.parse(value.requested_at);
  const deadline = Date.parse(value.acknowledgement_deadline);
  if (deadline <= requestedAt || deadline - requestedAt > 5 * 60_000) {
    context.addIssue({
      code: 'custom',
      path: ['acknowledgement_deadline'],
      message: 'Remote-stop acknowledgement deadline must be positive and no longer than five minutes.',
    });
  }
});

export type RemoteStopRequest = z.infer<typeof remoteStopRequestSchema>;

export const remoteStopPrincipalEvidenceSchema = z.object({
  schema_version: z.literal('starlight.remote_stop_principal_evidence.v1'),
  database_role: controlId,
  database_name: controlId,
  role_contract_digest_sha256: digest,
  supervisor_id: controlId,
  supervisor_instance_id: controlId,
  supervisor_epoch: generation,
  observed_at: instant,
  access_review_expires_at: instant,
  state: z.enum(['ready', 'disabled']),
}).strict().superRefine((value, context) => {
  if (Date.parse(value.observed_at) >= Date.parse(value.access_review_expires_at)) {
    context.addIssue({
      code: 'custom',
      path: ['access_review_expires_at'],
      message: 'Remote-stop principal access review must expire after observation.',
    });
  }
});

export type RemoteStopPrincipalEvidence = z.infer<typeof remoteStopPrincipalEvidenceSchema>;

export const remoteStopAcknowledgementSchema = z.object({
  schema_version: z.literal('starlight.remote_stop_acknowledgement.v1'),
  acknowledgement_id: z.uuid(),
  stop_request_id: z.uuid(),
  stop_sequence: z.number().int().min(1).max(1_000_000_000),
  stop_request_audit_seq: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  stop_request_audit_sha256: digest,
  request_sha256: digest,
  reservation_id: z.uuid(),
  claim_id: z.uuid(),
  operation_id: controlId,
  effect_id: controlId,
  binding_digest_sha256: digest,
  runner_id: controlId,
  runner_instance_id: controlId,
  runtime_id: controlId,
  host_id: controlId,
  channel_binding_sha256: digest,
  launch_attempt_id: controlId,
  process_instance_sha256: digest.nullable(),
  execution_generation: generation,
  observed_stop_fence_generation: generation,
  supervisor_id: controlId,
  supervisor_instance_id: controlId,
  supervisor_epoch: generation,
  acknowledgement_state: z.enum(['received', 'already-terminal', 'not-found', 'rejected']),
  acknowledged_at: instant,
  observed_at: instant,
  access_review_expires_at: instant,
  evidence_ref: controlId,
  evidence_sha256: digest,
  replay_state: z.enum(['fresh', 'exact-retry', 'conflict']),
  transport_authenticated: z.literal(true),
}).strict().superRefine((value, context) => {
  if (Date.parse(value.acknowledged_at) > Date.parse(value.observed_at)) {
    context.addIssue({
      code: 'custom',
      path: ['acknowledged_at'],
      message: 'Remote-stop acknowledgement cannot follow its observation.',
    });
  }
  if (Date.parse(value.observed_at) >= Date.parse(value.access_review_expires_at)) {
    context.addIssue({
      code: 'custom',
      path: ['access_review_expires_at'],
      message: 'Supervisor access review must remain live after acknowledgement observation.',
    });
  }
});

export type RemoteStopAcknowledgement = z.infer<typeof remoteStopAcknowledgementSchema>;

export type RemoteStopAcknowledgementAttestation =
  | { valid: true; acknowledgement: RemoteStopAcknowledgement; blockers: [] }
  | { valid: false; acknowledgement: null; blockers: string[] };

export interface RemoteStopConformanceDependencies {
  /**
   * A server-owned supervisor adapter must authenticate the transport, enforce replay state,
   * verify the exact durable stop-request audit, and attest the already-observed receipt. This
   * evaluator sends no stop request or command.
   */
  attestAcknowledgement(input: {
    request: RemoteStopRequest;
    request_sha256: string;
  }): Promise<RemoteStopAcknowledgementAttestation>;
}

export interface RemoteStopConformanceResult {
  schema_version: 'starlight.remote_stop_conformance.v1';
  valid_fixture: boolean;
  request_bound: boolean;
  supervisor_origin_authenticated: boolean;
  replay_safe: boolean;
  stop_fence_bound: boolean;
  remote_stop_request_acknowledged: boolean;
  acknowledgement_state: RemoteStopAcknowledgement['acknowledgement_state'] | null;
  acknowledgement_bundle_sha256: string | null;
  remote_stop_confirmed: false;
  remote_stop_effect_observed: false;
  process_terminal_observed: false;
  descendants_quiesced: false;
  outcome_settlement_eligible: false;
  dispatch_authority_granted: false;
  execution_authority_granted: false;
  host_capacity_released: false;
  released_host_slots: 0;
  budget_commitment_released: false;
  released_cost_usd: '0.000000';
  blockers: string[];
}

export interface RemoteStopAcknowledgementReceipt {
  schema_version: 'starlight.remote_stop_acknowledgement_receipt.v1';
  acknowledgement_id: string;
  stop_request_id: string;
  stop_request_audit_seq: number;
  reservation_id: string;
  claim_id: string;
  operation_id: string;
  binding_digest_sha256: string;
  supervisor_id: string;
  supervisor_instance_id: string;
  supervisor_epoch: number;
  observed_stop_fence_generation: number;
  acknowledgement_bundle_sha256: string;
  accepted_at: string;
  verifier_database_role: string;
  verifier_database_name: string;
  verifier_role_contract_sha256: string;
  transport_state: 'attested-not-deployed';
  dispatch_state: 'not-dispatched';
  remote_stop_request_acknowledged: true;
  remote_stop_confirmed: false;
  remote_stop_effect_observed: false;
  process_terminal_observed: false;
  descendants_quiesced: false;
  host_capacity_released: false;
  released_host_slots: 0;
  budget_commitment_released: false;
  released_cost_usd: '0.000000';
  state: 'stop-requested';
}

export type RemoteStopAcknowledgementPersistenceResult =
  | { recorded: true; receipt: RemoteStopAcknowledgementReceipt; blockers: [] }
  | { recorded: false; receipt: null; blockers: string[] };

const refused = (blockers: string[]): RemoteStopConformanceResult => ({
  schema_version: 'starlight.remote_stop_conformance.v1',
  valid_fixture: false,
  request_bound: false,
  supervisor_origin_authenticated: false,
  replay_safe: false,
  stop_fence_bound: false,
  remote_stop_request_acknowledged: false,
  acknowledgement_state: null,
  acknowledgement_bundle_sha256: null,
  remote_stop_confirmed: false,
  remote_stop_effect_observed: false,
  process_terminal_observed: false,
  descendants_quiesced: false,
  outcome_settlement_eligible: false,
  dispatch_authority_granted: false,
  execution_authority_granted: false,
  host_capacity_released: false,
  released_host_slots: 0,
  budget_commitment_released: false,
  released_cost_usd: '0.000000',
  blockers,
});

const normalizedRequest = (request: RemoteStopRequest): RemoteStopRequest => ({
  ...request,
  requested_at: new Date(request.requested_at).toISOString(),
  acknowledgement_deadline: new Date(request.acknowledgement_deadline).toISOString(),
});

const requestBindingMatches = (
  request: RemoteStopRequest,
  acknowledgement: RemoteStopAcknowledgement,
  requestSha256: string,
): boolean => acknowledgement.stop_request_id === request.stop_request_id
  && acknowledgement.stop_sequence === request.stop_sequence
  && acknowledgement.stop_request_audit_seq === request.stop_request_audit_seq
  && acknowledgement.stop_request_audit_sha256 === request.stop_request_audit_sha256
  && acknowledgement.request_sha256 === requestSha256
  && acknowledgement.reservation_id === request.reservation_id
  && acknowledgement.claim_id === request.claim_id
  && acknowledgement.operation_id === request.operation_id
  && acknowledgement.effect_id === request.effect_id
  && acknowledgement.binding_digest_sha256 === request.binding_digest_sha256
  && acknowledgement.runner_id === request.runner_id
  && acknowledgement.runner_instance_id === request.runner_instance_id
  && acknowledgement.runtime_id === request.runtime_id
  && acknowledgement.host_id === request.host_id
  && acknowledgement.channel_binding_sha256 === request.channel_binding_sha256
  && acknowledgement.launch_attempt_id === request.launch_attempt_id
  && acknowledgement.process_instance_sha256 === request.process_instance_sha256
  && acknowledgement.execution_generation === request.execution_generation;

/**
 * Unwired acknowledgement evaluator. It proves, at most, that an authenticated supervisor
 * received a bound stop request that names the next execution fence. An acknowledgement never
 * proves signal delivery, fence enforcement, target terminality, descendant quiescence,
 * workload rollback, or safe recovery.
 */
export async function assessRemoteStopAcknowledgementConformance(
  candidate: unknown,
  dependencies: RemoteStopConformanceDependencies,
): Promise<RemoteStopConformanceResult> {
  const parsed = remoteStopRequestSchema.safeParse(candidate);
  if (!parsed.success) return refused(['Remote-stop request is malformed.']);

  const request = normalizedRequest(parsed.data);
  const requestSha256 = sha256Digest(request);
  let attestation: RemoteStopAcknowledgementAttestation;
  try {
    attestation = await dependencies.attestAcknowledgement({ request, request_sha256: requestSha256 });
  } catch {
    return refused(['Remote-stop supervisor attestation failed.']);
  }
  if (!attestation.valid) return refused(['Remote-stop supervisor attestation failed.']);

  const acknowledged = remoteStopAcknowledgementSchema.safeParse(attestation.acknowledgement);
  if (!acknowledged.success) return refused(['Remote-stop acknowledgement is malformed.']);
  const acknowledgement = acknowledged.data;

  const bindingMatches = requestBindingMatches(request, acknowledgement, requestSha256);
  const replaySafe = acknowledgement.replay_state !== 'conflict';
  const acknowledgedAt = Date.parse(acknowledgement.acknowledged_at);
  const chronologyValid = acknowledgedAt >= Date.parse(request.requested_at)
    && acknowledgedAt <= Date.parse(request.acknowledgement_deadline);
  const fenceBound = acknowledgement.observed_stop_fence_generation === request.stop_fence_generation;

  const blockers: string[] = [];
  if (!bindingMatches) blockers.push('Remote-stop acknowledgement is bound to another request or execution.');
  if (!replaySafe) blockers.push('Remote-stop acknowledgement was replayed with drifted evidence.');
  if (!chronologyValid) blockers.push('Remote-stop acknowledgement is outside the request ordering window.');
  if (!fenceBound) blockers.push('Remote-stop acknowledgement does not bind the exact requested stop fence.');
  if (acknowledgement.acknowledgement_state !== 'received') {
    blockers.push(`Supervisor did not acknowledge receipt of the stop request: ${acknowledgement.acknowledgement_state}.`);
  }
  if (blockers.length) {
    return {
      ...refused(blockers),
      request_bound: bindingMatches,
      supervisor_origin_authenticated: true,
      replay_safe: replaySafe,
      stop_fence_bound: fenceBound,
      acknowledgement_state: acknowledgement.acknowledgement_state,
    };
  }

  const normalizedAcknowledgement: RemoteStopAcknowledgement = {
    ...acknowledgement,
    replay_state: 'fresh',
    acknowledged_at: new Date(acknowledgement.acknowledged_at).toISOString(),
    observed_at: new Date(acknowledgement.observed_at).toISOString(),
    access_review_expires_at: new Date(acknowledgement.access_review_expires_at).toISOString(),
  };
  return {
    schema_version: 'starlight.remote_stop_conformance.v1',
    valid_fixture: true,
    request_bound: true,
    supervisor_origin_authenticated: true,
    replay_safe: true,
    stop_fence_bound: true,
    remote_stop_request_acknowledged: true,
    acknowledgement_state: 'received',
    acknowledgement_bundle_sha256: sha256Digest({
      schema_version: 'starlight.remote_stop_acknowledgement_bundle.v1',
      request,
      acknowledgement: normalizedAcknowledgement,
    }),
    remote_stop_confirmed: false,
    remote_stop_effect_observed: false,
    process_terminal_observed: false,
    descendants_quiesced: false,
    outcome_settlement_eligible: false,
    dispatch_authority_granted: false,
    execution_authority_granted: false,
    host_capacity_released: false,
    released_host_slots: 0,
    budget_commitment_released: false,
    released_cost_usd: '0.000000',
    blockers: [
      'A stop acknowledgement proves only authenticated receipt and binding to the requested fence generation.',
      'Signal delivery, fence enforcement, terminal process evidence and descendant quiescence remain independently required.',
    ],
  };
}
