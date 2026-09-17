import { createHash, randomUUID } from 'node:crypto';

import {
  cancellationInputSchema,
  consumptionInputSchema,
  operationBindingSchema,
  runnerClaimInputSchema,
  runnerHeartbeatExpiryInputSchema,
  runnerHeartbeatInputSchema,
  runnerOutcomeInputSchema,
  runnerUsageEvidenceInputSchema,
  runnerStartObservationInputSchema,
  startLeaseInputSchema,
  startRedemptionInputSchema,
} from './operation-authority';
import { sha256Digest } from './runtime-digest';
import { USAGE_AUTHORITY_ROUTINE_SQL } from './usage-authority-routines';
import {
  attestBrokerDatabaseSession,
  attestUsageEvidenceDatabaseSession,
  BROKER_DATABASE_ROLE_CONTRACT_SHA256,
  type BrokerDatabaseSessionAttestor,
  type UsageEvidenceDatabaseSessionAttestor,
} from './authority-role-contract';
import type {
  AdmissionReservation,
  AdmissionResult,
  AtomicAdmissionRequest,
  BudgetWindowEvidence,
  CancellationInput,
  CancellationResult,
  ConsumptionInput,
  ConsumptionReceipt,
  ConsumptionResult,
  OperationAuthorityStore,
  RunnerClaimInput,
  RunnerClaimReceipt,
  RunnerClaimResult,
  RunnerHeartbeatInput,
  RunnerHeartbeatExpiryInput,
  RunnerHeartbeatExpiryResult,
  RunnerHeartbeatReceipt,
  RunnerHeartbeatResult,
  RunnerOutcomeInput,
  RunnerOutcomeReceipt,
  RunnerOutcomeResult,
  RunnerUsageEvidenceInput,
  RunnerUsageEvidenceReceipt,
  RunnerUsageEvidenceResult,
  RunnerStartObservationInput,
  RunnerStartObservationReceipt,
  RunnerStartObservationResult,
  StartLeaseInput,
  StartLeaseReceipt,
  StartLeaseResult,
  StartRedemptionInput,
  StartRedemptionReceipt,
  StartRedemptionResult,
  TrustedHostEvidence,
} from './operation-authority';
import { z } from 'zod';

const controlId = z.string().min(3).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const controlTime = z.iso.datetime({ offset: true });
const budgetWindowSchema = z.object({
  window_id: controlId,
  policy_id: controlId,
  kind: z.enum(['policy', 'daily']),
  starts_at: controlTime,
  ends_at: controlTime,
  currency: z.literal('USD'),
  hard_limit_usd: z.number().finite().nonnegative().max(10_000_000),
}).strict().refine((value) => Date.parse(value.starts_at) < Date.parse(value.ends_at), {
  message: 'Budget window must end after it starts.', path: ['ends_at'],
});
export type BudgetWindowRegistrationResult =
  | { registered: true; already_registered: boolean; blockers: [] }
  | { registered: false; already_registered: false; blockers: string[] };
const revocationRefsSchema = z.array(z.string().min(5).max(500)).min(1).max(12);
const hostEvidenceSchema = z.object({
  host_id: controlId,
  observed_at: controlTime,
  status: z.enum(['ready', 'degraded', 'offline']),
  capacity_slots: z.number().int().nonnegative().max(10_000),
  secret_readiness: z.boolean(),
  access_review_expires_at: controlTime,
  allowed_capabilities: z.array(z.string().min(3).max(160).regex(/^[a-z0-9][a-z0-9._:-]*$/)).max(64),
}).strict().superRefine((value, context) => {
  if (new Set(value.allowed_capabilities).size !== value.allowed_capabilities.length) {
    context.addIssue({ code: 'custom', path: ['allowed_capabilities'], message: 'Host capabilities must be unique.' });
  }
});

const databaseRole = z.string().min(3).max(63).regex(/^[a-z][a-z0-9_]*$/);
const databaseName = z.string().min(1).max(63).regex(/^[A-Za-z0-9_.-]+$/);
export const brokerPrincipalEvidenceSchema = z.object({
  schema_version: z.literal('starlight.broker_principal_evidence.v1'),
  database_role: databaseRole,
  database_name: databaseName,
  broker_execution_identity: controlId,
  broker_identity_evidence_ref: controlId,
  authn_kind: z.literal('postgres-session-role'),
  role_contract_digest_sha256: z.literal(BROKER_DATABASE_ROLE_CONTRACT_SHA256),
  observed_at: controlTime,
  access_review_expires_at: controlTime,
  state: z.enum(['ready', 'disabled']),
}).strict().refine((value) => Date.parse(value.observed_at) < Date.parse(value.access_review_expires_at), {
  message: 'Broker access review must expire after evidence observation.', path: ['access_review_expires_at'],
});
export type TrustedBrokerPrincipalEvidence = z.infer<typeof brokerPrincipalEvidenceSchema>;

export interface AttestedRunnerSession {
  runner_id: string;
  runner_identity_evidence_ref: string;
  runner_instance_id: string;
  runtime_id: string;
  host_id: string;
  channel_binding_sha256: string;
  launch_attempt_id: string;
  fencing_generation: number;
  observed_at: string;
  access_review_expires_at: string;
}

const runnerSessionSchema = z.object({
  runner_id: controlId,
  runner_identity_evidence_ref: controlId,
  runner_instance_id: controlId,
  runtime_id: controlId,
  host_id: controlId,
  channel_binding_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  launch_attempt_id: controlId,
  fencing_generation: z.number().int().min(1).max(1_000_000_000),
  observed_at: controlTime,
  access_review_expires_at: controlTime,
}).strict().refine((value) => Date.parse(value.observed_at) < Date.parse(value.access_review_expires_at), {
  message: 'Runner access review must expire after evidence observation.', path: ['access_review_expires_at'],
});

export type RunnerSessionAttestation =
  | { valid: true; session: AttestedRunnerSession; blockers: [] }
  | { valid: false; session: null; blockers: string[] };

export type RunnerSessionAttestor = (client: AuthoritySqlClient) => Promise<RunnerSessionAttestation>;

const denyUnconfiguredRunnerSession: RunnerSessionAttestor = async () => ({
  valid: false,
  session: null,
  blockers: ['Runner transport attestor is not configured.'],
});

export const runnerStartEvidenceSchema = z.object({
  schema_version: z.literal('starlight.runner_start_evidence.v1'),
  reservation_id: z.uuid(),
  claim_id: z.uuid(),
  operation_id: controlId,
  effect_id: controlId,
  binding_digest_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  runner_id: controlId,
  runner_identity_evidence_ref: controlId,
  runner_instance_id: controlId,
  runtime_id: controlId,
  host_id: controlId,
  channel_binding_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  launch_attempt_id: controlId,
  fencing_generation: z.number().int().min(1).max(1_000_000_000),
  process_instance_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  evidence_ref: controlId,
  evidence_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  process_started_at: controlTime,
  observed_at: controlTime,
  access_review_expires_at: controlTime,
  state: z.literal('start-observed'),
}).strict().superRefine((value, context) => {
  if (Date.parse(value.process_started_at) > Date.parse(value.observed_at)) {
    context.addIssue({ code: 'custom', path: ['process_started_at'], message: 'Process start cannot follow its observation.' });
  }
  if (Date.parse(value.observed_at) >= Date.parse(value.access_review_expires_at)) {
    context.addIssue({ code: 'custom', path: ['access_review_expires_at'], message: 'Start-evidence access review must remain live after observation.' });
  }
});

export type RunnerStartEvidence = z.infer<typeof runnerStartEvidenceSchema>;
export type RunnerStartEvidenceAttestation =
  | { valid: true; evidence: RunnerStartEvidence; blockers: [] }
  | { valid: false; evidence: null; blockers: string[] };
export type RunnerStartEvidenceAttestor = (client: AuthoritySqlClient) => Promise<RunnerStartEvidenceAttestation>;

const denyUnconfiguredRunnerStartEvidence: RunnerStartEvidenceAttestor = async () => ({
  valid: false,
  evidence: null,
  blockers: ['Runner start-evidence attestor is not configured.'],
});

const runnerOutcomeCommon = {
  schema_version: z.literal('starlight.runner_outcome_evidence.v1'),
  outcome_event_id: z.uuid(),
  reservation_id: z.uuid(),
  claim_id: z.uuid(),
  operation_id: controlId,
  effect_id: controlId,
  binding_digest_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  runner_id: controlId,
  runner_identity_evidence_ref: controlId,
  runner_instance_id: controlId,
  runtime_id: controlId,
  host_id: controlId,
  channel_binding_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  launch_attempt_id: controlId,
  fencing_generation: z.number().int().min(1).max(1_000_000_000),
  evidence_ref: controlId,
  evidence_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  outcome_at: controlTime,
  observed_at: controlTime,
  access_review_expires_at: controlTime,
  restart_fenced: z.literal(true),
  launch_queue_closed: z.literal(true),
  descendants_quiesced: z.literal(true),
  remote_stop_confirmed: z.boolean(),
};

export const runnerOutcomeEvidenceSchema = z.discriminatedUnion('outcome_kind', [
  z.object({
    ...runnerOutcomeCommon,
    outcome_kind: z.literal('never-started'),
    process_instance_sha256: z.null(),
    start_observation_id: z.null(),
    start_evidence_ref: z.null(),
    start_evidence_sha256: z.null(),
    process_started_at: z.null(),
    exit_disposition: z.null(),
  }).strict(),
  z.object({
    ...runnerOutcomeCommon,
    outcome_kind: z.literal('process-terminal'),
    process_instance_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    start_observation_id: z.uuid(),
    start_evidence_ref: controlId,
    start_evidence_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    process_started_at: controlTime,
    exit_disposition: z.enum(['exited-zero', 'exited-nonzero', 'signal', 'supervisor-killed', 'unknown']),
  }).strict(),
]).superRefine((value, context) => {
  if (Date.parse(value.outcome_at) > Date.parse(value.observed_at)) {
    context.addIssue({ code: 'custom', path: ['outcome_at'], message: 'Runner outcome cannot follow its observation.' });
  }
  if (Date.parse(value.observed_at) >= Date.parse(value.access_review_expires_at)) {
    context.addIssue({ code: 'custom', path: ['access_review_expires_at'], message: 'Outcome-evidence access review must remain live after observation.' });
  }
});

export type RunnerOutcomeEvidence = z.infer<typeof runnerOutcomeEvidenceSchema>;
export type RunnerOutcomeEvidenceAttestation =
  | { valid: true; evidence: RunnerOutcomeEvidence; blockers: [] }
  | { valid: false; evidence: null; blockers: string[] };
export type RunnerOutcomeEvidenceAttestor = (client: AuthoritySqlClient) => Promise<RunnerOutcomeEvidenceAttestation>;

const denyUnconfiguredRunnerOutcomeEvidence: RunnerOutcomeEvidenceAttestor = async () => ({
  valid: false,
  evidence: null,
  blockers: ['Runner outcome-evidence attestor is not configured.'],
});

const exactUsd = z.string().regex(/^(0|[1-9][0-9]{0,7})\.[0-9]{6}$/);
export const runnerUsageEvidenceSchema = z.object({
  schema_version: z.literal('starlight.runner_usage_provider_evidence.v1'),
  provider_event_id: z.uuid(),
  reservation_id: z.uuid(),
  claim_id: z.uuid(),
  outcome_id: z.uuid(),
  operation_id: controlId,
  effect_id: controlId,
  binding_digest_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  runner_id: controlId,
  runner_identity_evidence_ref: controlId,
  runner_instance_id: controlId,
  runtime_id: controlId,
  host_id: controlId,
  channel_binding_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  launch_attempt_id: controlId,
  fencing_generation: z.number().int().min(1).max(1_000_000_000),
  process_instance_sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  provider_id: controlId,
  provider_account_ref: controlId,
  provider_usage_correlation_id: controlId,
  meter_id: controlId,
  evidence_ref: controlId,
  evidence_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  usage_started_at: controlTime,
  usage_ended_at: controlTime,
  statement_status: z.enum(['provisional', 'final']),
  statement_finalized_at: controlTime.nullable(),
  observed_at: controlTime,
  access_review_expires_at: controlTime,
  currency: z.literal('USD'),
  cumulative_cost_usd: exactUsd,
  authn_kind: z.literal('provider-signed-statement'),
  issuer: controlId,
  key_id: controlId,
}).strict().superRefine((value, context) => {
  const started = Date.parse(value.usage_started_at);
  const ended = Date.parse(value.usage_ended_at);
  const observed = Date.parse(value.observed_at);
  if (started > ended) {
    context.addIssue({ code: 'custom', path: ['usage_started_at'], message: 'Usage start cannot follow usage end.' });
  }
  if (ended > observed) {
    context.addIssue({ code: 'custom', path: ['usage_ended_at'], message: 'Usage end cannot follow evidence observation.' });
  }
  if (observed >= Date.parse(value.access_review_expires_at)) {
    context.addIssue({ code: 'custom', path: ['access_review_expires_at'], message: 'Usage-evidence access review must remain live.' });
  }
  if (value.statement_status === 'final') {
    if (value.statement_finalized_at === null
      || Date.parse(value.statement_finalized_at) < ended
      || Date.parse(value.statement_finalized_at) > observed) {
      context.addIssue({ code: 'custom', path: ['statement_finalized_at'], message: 'Final statement time must follow usage and precede observation.' });
    }
  } else if (value.statement_finalized_at !== null) {
    context.addIssue({ code: 'custom', path: ['statement_finalized_at'], message: 'Provisional evidence cannot claim finalization.' });
  }
});

export type RunnerUsageEvidence = z.infer<typeof runnerUsageEvidenceSchema>;
export type RunnerUsageEvidenceAttestation =
  | { valid: true; evidence: RunnerUsageEvidence; blockers: [] }
  | { valid: false; evidence: null; blockers: string[] };
export type RunnerUsageEvidenceAttestor = (client: AuthoritySqlClient) => Promise<RunnerUsageEvidenceAttestation>;

const denyUnconfiguredRunnerUsageEvidence: RunnerUsageEvidenceAttestor = async () => ({
  valid: false,
  evidence: null,
  blockers: ['Runner usage-evidence attestor is not configured.'],
});

export const OPERATION_AUTHORITY_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS swarm_authority_revocations (
  ref TEXT PRIMARY KEY, revoked_at TIMESTAMPTZ NOT NULL, reason TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS swarm_authority_control (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO swarm_authority_control (singleton) VALUES (TRUE) ON CONFLICT (singleton) DO NOTHING;
CREATE OR REPLACE FUNCTION starlight_authority_lock() RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $authority_lock$
DECLARE locked BOOLEAN;
BEGIN
  SELECT singleton INTO locked FROM public.swarm_authority_control WHERE singleton=TRUE FOR UPDATE;
  RETURN COALESCE(locked,FALSE);
END
$authority_lock$;
REVOKE ALL ON FUNCTION starlight_authority_lock() FROM PUBLIC;
CREATE TABLE IF NOT EXISTS swarm_authority_hosts (
  host_id TEXT PRIMARY KEY, evidence JSONB NOT NULL, observed_at TIMESTAMPTZ NOT NULL,
  capacity_slots INTEGER NOT NULL CHECK (capacity_slots >= 0),
  reserved_slots INTEGER NOT NULL DEFAULT 0 CHECK (reserved_slots >= 0),
  authorized_slots INTEGER NOT NULL DEFAULT 0 CHECK (authorized_slots >= 0),
  CHECK (reserved_slots + authorized_slots <= capacity_slots)
);
CREATE TABLE IF NOT EXISTS swarm_authority_budgets (
  receipt_id TEXT PRIMARY KEY, hard_limit_usd NUMERIC NOT NULL CHECK (hard_limit_usd >= 0),
  reserved_usd NUMERIC NOT NULL DEFAULT 0 CHECK (reserved_usd >= 0),
  committed_usd NUMERIC NOT NULL DEFAULT 0 CHECK (committed_usd >= 0),
  CHECK (reserved_usd + committed_usd <= hard_limit_usd)
);
CREATE TABLE IF NOT EXISTS swarm_authority_budget_windows (
  window_id TEXT PRIMARY KEY, policy_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('policy','daily')),
  starts_at TIMESTAMPTZ NOT NULL, ends_at TIMESTAMPTZ NOT NULL,
  currency CHAR(3) NOT NULL CHECK (currency='USD'),
  hard_limit_usd NUMERIC NOT NULL CHECK (hard_limit_usd >= 0),
  reserved_usd NUMERIC NOT NULL DEFAULT 0 CHECK (reserved_usd >= 0),
  committed_usd NUMERIC NOT NULL DEFAULT 0 CHECK (committed_usd >= 0),
  CHECK (reserved_usd + committed_usd <= hard_limit_usd),
  CHECK (ends_at > starts_at)
);
CREATE TABLE IF NOT EXISTS swarm_authority_prepared_operations (
  operation_id TEXT PRIMARY KEY, binding_digest_sha256 CHAR(64) NOT NULL,
  registered_at TIMESTAMPTZ NOT NULL, state TEXT NOT NULL CHECK (state IN ('ready','cancelled'))
);
CREATE TABLE IF NOT EXISTS swarm_authority_broker_principals (
  database_role TEXT NOT NULL, database_name TEXT NOT NULL,
  broker_execution_identity TEXT NOT NULL UNIQUE, broker_identity_evidence_ref TEXT NOT NULL UNIQUE,
  authn_kind TEXT NOT NULL CHECK (authn_kind='postgres-session-role'),
  role_contract_digest_sha256 CHAR(64) NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL, access_review_expires_at TIMESTAMPTZ NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('ready','disabled')), evidence JSONB NOT NULL,
  PRIMARY KEY (database_role,database_name), CHECK (access_review_expires_at > observed_at)
);
CREATE TABLE IF NOT EXISTS swarm_authority_reservations (
  reservation_id UUID PRIMARY KEY, operation_id TEXT NOT NULL UNIQUE, effect_id TEXT NOT NULL UNIQUE,
  binding_digest_sha256 CHAR(64) NOT NULL, binding JSONB NOT NULL,
  binding_database_sha256 CHAR(64) NOT NULL,
  revocation_refs JSONB NOT NULL,
  consume_token_sha256 CHAR(64) NOT NULL, cancel_token_sha256 CHAR(64) NOT NULL,
  approval_receipt_id TEXT NOT NULL,
  budget_receipt_id TEXT NOT NULL, host_id TEXT NOT NULL, reserved_cost_usd NUMERIC NOT NULL,
  reserved_at TIMESTAMPTZ NOT NULL, reservation_expires_at TIMESTAMPTZ NOT NULL,
  max_host_evidence_age_ms INTEGER NOT NULL CHECK (max_host_evidence_age_ms BETWEEN 1000 AND 3600000),
  consumption_id UUID UNIQUE, consumed_at TIMESTAMPTZ, lease_claim_token_sha256 CHAR(64),
  lease_id UUID, start_request_id UUID, lease_issued_at TIMESTAMPTZ,
  lease_expires_at TIMESTAMPTZ, lease_duration_ms INTEGER,
  redemption_token_sha256 CHAR(64), control_token_sha256 CHAR(64),
  broker_execution_identity TEXT, broker_identity_evidence_ref TEXT,
  broker_database_role TEXT, broker_database_name TEXT, broker_role_contract_sha256 CHAR(64),
  redemption_id UUID, redemption_request_id UUID, start_authorized_at TIMESTAMPTZ,
  committed_cost_usd NUMERIC,
  runner_claim_id UUID, runner_claim_request_id UUID, runner_claim_accepted_at TIMESTAMPTZ,
  runner_claim_expires_at TIMESTAMPTZ, runner_evidence_observed_at TIMESTAMPTZ,
  runner_access_review_expires_at TIMESTAMPTZ, runner_id TEXT, runner_identity_evidence_ref TEXT,
  runner_instance_id TEXT, runner_runtime_id TEXT, runner_host_id TEXT,
  runner_channel_binding_sha256 CHAR(64), heartbeat_token_sha256 CHAR(64),
  start_observation_token_sha256 CHAR(64), outcome_token_sha256 CHAR(64),
  usage_reconciliation_token_sha256 CHAR(64), provider_usage_correlation_id TEXT,
  runner_launch_attempt_id TEXT, runner_fencing_generation INTEGER,
  runner_revocation_refs JSONB,
  runner_heartbeat_id UUID, runner_heartbeat_request_id UUID UNIQUE,
  runner_heartbeat_sequence INTEGER, runner_heartbeat_accepted_at TIMESTAMPTZ,
  runner_heartbeat_presented_token_sha256 CHAR(64),
  runner_start_observation_id UUID, runner_start_observation_request_id UUID UNIQUE,
  runner_start_observation_accepted_at TIMESTAMPTZ,
  runner_start_evidence_observed_at TIMESTAMPTZ, runner_process_started_at TIMESTAMPTZ,
  runner_process_instance_sha256 CHAR(64) UNIQUE, runner_start_evidence_ref TEXT UNIQUE,
  runner_start_evidence_sha256 CHAR(64) UNIQUE,
  runner_start_presented_token_sha256 CHAR(64),
  runner_outcome_id UUID, runner_outcome_request_id UUID UNIQUE, runner_outcome_event_id UUID UNIQUE,
  runner_outcome_kind TEXT, runner_outcome_accepted_at TIMESTAMPTZ,
  runner_outcome_at TIMESTAMPTZ, runner_outcome_evidence_observed_at TIMESTAMPTZ,
  runner_outcome_evidence_ref TEXT UNIQUE, runner_outcome_evidence_sha256 CHAR(64) UNIQUE,
  runner_outcome_presented_token_sha256 CHAR(64), runner_exit_disposition TEXT,
  runner_remote_stop_confirmed BOOLEAN,
  state TEXT NOT NULL CHECK (state IN ('reserved-not-started','consumed-not-started','leased-not-started','start-authorized-not-observed','runner-claimed-not-started','runner-start-observed','stop-requested','runner-never-started-observed','runner-terminal-observed','cancelled','expired'))
);
CREATE TABLE IF NOT EXISTS swarm_authority_heartbeat_tokens (
  token_sha256 CHAR(64) PRIMARY KEY, reservation_id UUID NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence >= 0),
  issued_by_request_id UUID NOT NULL, issued_at TIMESTAMPTZ NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('claim','heartbeat')),
  UNIQUE (reservation_id,sequence)
);
CREATE TABLE IF NOT EXISTS swarm_authority_usage_tokens (
  token_sha256 CHAR(64) PRIMARY KEY, reservation_id UUID NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence >= 0),
  issued_by_request_id UUID NOT NULL, issued_at TIMESTAMPTZ NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('claim','usage-evidence')),
  UNIQUE (reservation_id,sequence)
);
CREATE TABLE IF NOT EXISTS swarm_authority_usage_evidence (
  usage_evidence_id UUID PRIMARY KEY, usage_request_id UUID NOT NULL UNIQUE,
  usage_sequence INTEGER NOT NULL CHECK (usage_sequence >= 1),
  provider_event_id UUID NOT NULL UNIQUE, reservation_id UUID NOT NULL,
  claim_id UUID NOT NULL, outcome_id UUID NOT NULL,
  operation_id TEXT NOT NULL, effect_id TEXT NOT NULL, binding_digest_sha256 CHAR(64) NOT NULL,
  verifier_database_role TEXT NOT NULL, verifier_database_name TEXT NOT NULL,
  verifier_role_contract_sha256 CHAR(64) NOT NULL,
  provider_id TEXT NOT NULL, provider_account_ref TEXT NOT NULL,
  provider_usage_correlation_id TEXT NOT NULL, meter_id TEXT NOT NULL,
  evidence_ref TEXT NOT NULL UNIQUE, evidence_sha256 CHAR(64) NOT NULL UNIQUE,
  usage_started_at TIMESTAMPTZ NOT NULL, usage_ended_at TIMESTAMPTZ NOT NULL,
  statement_status TEXT NOT NULL CHECK (statement_status IN ('provisional','final')),
  statement_finalized_at TIMESTAMPTZ,
  evidence_observed_at TIMESTAMPTZ NOT NULL, accepted_at TIMESTAMPTZ NOT NULL,
  currency CHAR(3) NOT NULL CHECK (currency='USD'),
  cumulative_cost_usd NUMERIC(20,6) NOT NULL CHECK (cumulative_cost_usd >= 0),
  authorized_cost_usd NUMERIC(20,6) NOT NULL CHECK (authorized_cost_usd >= 0),
  budget_breach_observed BOOLEAN NOT NULL,
  presented_token_sha256 CHAR(64) NOT NULL,
  next_token_sha256 CHAR(64) NOT NULL,
  issuer TEXT NOT NULL, key_id TEXT NOT NULL,
  authn_kind TEXT NOT NULL CHECK (authn_kind='provider-signed-statement'),
  UNIQUE (reservation_id,usage_sequence),
  CHECK (usage_started_at <= usage_ended_at),
  CHECK (usage_ended_at <= evidence_observed_at),
  CHECK ((statement_status='final' AND statement_finalized_at IS NOT NULL
      AND usage_ended_at <= statement_finalized_at AND statement_finalized_at <= evidence_observed_at)
    OR (statement_status='provisional' AND statement_finalized_at IS NULL))
);
CREATE TABLE IF NOT EXISTS swarm_authority_budget_holds (
  reservation_id UUID NOT NULL, window_id TEXT NOT NULL, reserved_cost_usd NUMERIC NOT NULL CHECK (reserved_cost_usd >= 0),
  PRIMARY KEY (reservation_id,window_id)
);
ALTER TABLE swarm_authority_usage_evidence ADD COLUMN IF NOT EXISTS verifier_database_role TEXT
  NOT NULL DEFAULT 'legacy-unattested';
ALTER TABLE swarm_authority_usage_evidence ADD COLUMN IF NOT EXISTS verifier_database_name TEXT
  NOT NULL DEFAULT 'legacy-unattested';
ALTER TABLE swarm_authority_usage_evidence ADD COLUMN IF NOT EXISTS verifier_role_contract_sha256 CHAR(64)
  NOT NULL DEFAULT '${'0'.repeat(64)}';
ALTER TABLE swarm_authority_usage_evidence ALTER COLUMN verifier_database_role DROP DEFAULT;
ALTER TABLE swarm_authority_usage_evidence ALTER COLUMN verifier_database_name DROP DEFAULT;
ALTER TABLE swarm_authority_usage_evidence ALTER COLUMN verifier_role_contract_sha256 DROP DEFAULT;
CREATE TABLE IF NOT EXISTS swarm_authority_audit (
  seq BIGSERIAL PRIMARY KEY, event TEXT NOT NULL CHECK (event IN ('admitted','reserved','denied','revoked','cancelled','consumed','consume-denied','start-lease-issued','start-lease-denied','start-authority-redeemed','start-redemption-denied','runner-claim-accepted','runner-claim-denied','runner-heartbeat-accepted','runner-heartbeat-denied','runner-start-observed','runner-start-denied','runner-outcome-observed','runner-outcome-denied','runner-usage-evidence-observed','runner-usage-evidence-denied','runner-usage-budget-breach','host-capacity-released','stop-requested','reservation-cancelled','expired','budget-window-registered','budget-window-denied','broker-principal-registered','broker-principal-disabled')),
  operation_id TEXT NOT NULL, binding_digest_sha256 CHAR(64) NOT NULL,
  at TIMESTAMPTZ NOT NULL, detail JSONB NOT NULL
);

-- Upgrade the earlier, never-deployed PR #24 reservation-only schema. Its rows
-- cannot be safely consumed because no bearer digest or durable binding exists,
-- so they are cancelled as replay tombstones and their per-receipt holds released.
ALTER TABLE swarm_authority_hosts ADD COLUMN IF NOT EXISTS capacity_slots INTEGER;
ALTER TABLE swarm_authority_hosts ADD COLUMN IF NOT EXISTS reserved_slots INTEGER;
ALTER TABLE swarm_authority_hosts ADD COLUMN IF NOT EXISTS authorized_slots INTEGER NOT NULL DEFAULT 0;
ALTER TABLE swarm_authority_budgets ADD COLUMN IF NOT EXISTS committed_usd NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE swarm_authority_budget_windows ADD COLUMN IF NOT EXISTS committed_usd NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE swarm_authority_reservations ADD COLUMN IF NOT EXISTS binding JSONB;
ALTER TABLE swarm_authority_reservations ADD COLUMN IF NOT EXISTS binding_database_sha256 CHAR(64);
ALTER TABLE swarm_authority_reservations ADD COLUMN IF NOT EXISTS revocation_refs JSONB;
ALTER TABLE swarm_authority_reservations ADD COLUMN IF NOT EXISTS consume_token_sha256 CHAR(64);
ALTER TABLE swarm_authority_reservations ADD COLUMN IF NOT EXISTS cancel_token_sha256 CHAR(64);
ALTER TABLE swarm_authority_reservations ADD COLUMN IF NOT EXISTS max_host_evidence_age_ms INTEGER;
ALTER TABLE swarm_authority_reservations ADD COLUMN IF NOT EXISTS consumption_id UUID;
ALTER TABLE swarm_authority_reservations ADD COLUMN IF NOT EXISTS consumed_at TIMESTAMPTZ;
ALTER TABLE swarm_authority_reservations ADD COLUMN IF NOT EXISTS lease_claim_token_sha256 CHAR(64);
ALTER TABLE swarm_authority_reservations ADD COLUMN IF NOT EXISTS lease_id UUID;
ALTER TABLE swarm_authority_reservations ADD COLUMN IF NOT EXISTS start_request_id UUID;
ALTER TABLE swarm_authority_reservations ADD COLUMN IF NOT EXISTS lease_issued_at TIMESTAMPTZ;
ALTER TABLE swarm_authority_reservations ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ;
ALTER TABLE swarm_authority_reservations ADD COLUMN IF NOT EXISTS lease_duration_ms INTEGER;
ALTER TABLE swarm_authority_reservations ADD COLUMN IF NOT EXISTS redemption_token_sha256 CHAR(64);
ALTER TABLE swarm_authority_reservations ADD COLUMN IF NOT EXISTS control_token_sha256 CHAR(64);
ALTER TABLE swarm_authority_reservations ADD COLUMN IF NOT EXISTS broker_execution_identity TEXT;
ALTER TABLE swarm_authority_reservations ADD COLUMN IF NOT EXISTS broker_identity_evidence_ref TEXT;
ALTER TABLE swarm_authority_reservations ADD COLUMN IF NOT EXISTS broker_database_role TEXT;
ALTER TABLE swarm_authority_reservations ADD COLUMN IF NOT EXISTS broker_database_name TEXT;
ALTER TABLE swarm_authority_reservations ADD COLUMN IF NOT EXISTS broker_role_contract_sha256 CHAR(64);
ALTER TABLE swarm_authority_reservations ADD COLUMN IF NOT EXISTS redemption_id UUID;
ALTER TABLE swarm_authority_reservations ADD COLUMN IF NOT EXISTS redemption_request_id UUID;
ALTER TABLE swarm_authority_reservations ADD COLUMN IF NOT EXISTS start_authorized_at TIMESTAMPTZ;
ALTER TABLE swarm_authority_reservations ADD COLUMN IF NOT EXISTS committed_cost_usd NUMERIC;
ALTER TABLE swarm_authority_reservations ADD COLUMN IF NOT EXISTS runner_claim_id UUID;
ALTER TABLE swarm_authority_reservations ADD COLUMN IF NOT EXISTS runner_claim_request_id UUID;
ALTER TABLE swarm_authority_reservations ADD COLUMN IF NOT EXISTS runner_claim_accepted_at TIMESTAMPTZ;
ALTER TABLE swarm_authority_reservations ADD COLUMN IF NOT EXISTS runner_claim_expires_at TIMESTAMPTZ;
ALTER TABLE swarm_authority_reservations ADD COLUMN IF NOT EXISTS runner_evidence_observed_at TIMESTAMPTZ;
ALTER TABLE swarm_authority_reservations ADD COLUMN IF NOT EXISTS runner_access_review_expires_at TIMESTAMPTZ;
ALTER TABLE swarm_authority_reservations ADD COLUMN IF NOT EXISTS runner_id TEXT;
ALTER TABLE swarm_authority_reservations ADD COLUMN IF NOT EXISTS runner_identity_evidence_ref TEXT;
ALTER TABLE swarm_authority_reservations ADD COLUMN IF NOT EXISTS runner_instance_id TEXT;
ALTER TABLE swarm_authority_reservations ADD COLUMN IF NOT EXISTS runner_runtime_id TEXT;
ALTER TABLE swarm_authority_reservations ADD COLUMN IF NOT EXISTS runner_host_id TEXT;
ALTER TABLE swarm_authority_reservations ADD COLUMN IF NOT EXISTS runner_channel_binding_sha256 CHAR(64);
ALTER TABLE swarm_authority_reservations ADD COLUMN IF NOT EXISTS heartbeat_token_sha256 CHAR(64);
ALTER TABLE swarm_authority_reservations ADD COLUMN IF NOT EXISTS start_observation_token_sha256 CHAR(64);
ALTER TABLE swarm_authority_reservations ADD COLUMN IF NOT EXISTS outcome_token_sha256 CHAR(64);
ALTER TABLE swarm_authority_reservations ADD COLUMN IF NOT EXISTS usage_reconciliation_token_sha256 CHAR(64);
ALTER TABLE swarm_authority_reservations ADD COLUMN IF NOT EXISTS provider_usage_correlation_id TEXT;
ALTER TABLE swarm_authority_reservations ADD COLUMN IF NOT EXISTS runner_launch_attempt_id TEXT;
ALTER TABLE swarm_authority_reservations ADD COLUMN IF NOT EXISTS runner_fencing_generation INTEGER;
ALTER TABLE swarm_authority_reservations ADD COLUMN IF NOT EXISTS runner_revocation_refs JSONB;
ALTER TABLE swarm_authority_reservations ADD COLUMN IF NOT EXISTS runner_heartbeat_id UUID;
ALTER TABLE swarm_authority_reservations ADD COLUMN IF NOT EXISTS runner_heartbeat_request_id UUID;
ALTER TABLE swarm_authority_reservations ADD COLUMN IF NOT EXISTS runner_heartbeat_sequence INTEGER;
ALTER TABLE swarm_authority_reservations ADD COLUMN IF NOT EXISTS runner_heartbeat_accepted_at TIMESTAMPTZ;
ALTER TABLE swarm_authority_reservations ADD COLUMN IF NOT EXISTS runner_heartbeat_presented_token_sha256 CHAR(64);
ALTER TABLE swarm_authority_reservations ADD COLUMN IF NOT EXISTS runner_start_observation_id UUID;
ALTER TABLE swarm_authority_reservations ADD COLUMN IF NOT EXISTS runner_start_observation_request_id UUID;
ALTER TABLE swarm_authority_reservations ADD COLUMN IF NOT EXISTS runner_start_observation_accepted_at TIMESTAMPTZ;
ALTER TABLE swarm_authority_reservations ADD COLUMN IF NOT EXISTS runner_start_evidence_observed_at TIMESTAMPTZ;
ALTER TABLE swarm_authority_reservations ADD COLUMN IF NOT EXISTS runner_process_started_at TIMESTAMPTZ;
ALTER TABLE swarm_authority_reservations ADD COLUMN IF NOT EXISTS runner_process_instance_sha256 CHAR(64);
ALTER TABLE swarm_authority_reservations ADD COLUMN IF NOT EXISTS runner_start_evidence_ref TEXT;
ALTER TABLE swarm_authority_reservations ADD COLUMN IF NOT EXISTS runner_start_evidence_sha256 CHAR(64);
ALTER TABLE swarm_authority_reservations ADD COLUMN IF NOT EXISTS runner_start_presented_token_sha256 CHAR(64);
ALTER TABLE swarm_authority_reservations ADD COLUMN IF NOT EXISTS runner_outcome_id UUID;
ALTER TABLE swarm_authority_reservations ADD COLUMN IF NOT EXISTS runner_outcome_request_id UUID;
ALTER TABLE swarm_authority_reservations ADD COLUMN IF NOT EXISTS runner_outcome_event_id UUID;
ALTER TABLE swarm_authority_reservations ADD COLUMN IF NOT EXISTS runner_outcome_kind TEXT;
ALTER TABLE swarm_authority_reservations ADD COLUMN IF NOT EXISTS runner_outcome_accepted_at TIMESTAMPTZ;
ALTER TABLE swarm_authority_reservations ADD COLUMN IF NOT EXISTS runner_outcome_at TIMESTAMPTZ;
ALTER TABLE swarm_authority_reservations ADD COLUMN IF NOT EXISTS runner_outcome_evidence_observed_at TIMESTAMPTZ;
ALTER TABLE swarm_authority_reservations ADD COLUMN IF NOT EXISTS runner_outcome_evidence_ref TEXT;
ALTER TABLE swarm_authority_reservations ADD COLUMN IF NOT EXISTS runner_outcome_evidence_sha256 CHAR(64);
ALTER TABLE swarm_authority_reservations ADD COLUMN IF NOT EXISTS runner_outcome_presented_token_sha256 CHAR(64);
ALTER TABLE swarm_authority_reservations ADD COLUMN IF NOT EXISTS runner_exit_disposition TEXT;
ALTER TABLE swarm_authority_reservations ADD COLUMN IF NOT EXISTS runner_remote_stop_confirmed BOOLEAN;
CREATE UNIQUE INDEX IF NOT EXISTS swarm_authority_runner_outcome_request_unique
  ON swarm_authority_reservations (runner_outcome_request_id) WHERE runner_outcome_request_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS swarm_authority_runner_outcome_event_unique
  ON swarm_authority_reservations (runner_outcome_event_id) WHERE runner_outcome_event_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS swarm_authority_runner_outcome_evidence_ref_unique
  ON swarm_authority_reservations (runner_outcome_evidence_ref) WHERE runner_outcome_evidence_ref IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS swarm_authority_runner_outcome_evidence_sha_unique
  ON swarm_authority_reservations (runner_outcome_evidence_sha256) WHERE runner_outcome_evidence_sha256 IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS swarm_authority_runner_outcome_token_unique
  ON swarm_authority_reservations (outcome_token_sha256) WHERE outcome_token_sha256 IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS swarm_authority_runner_usage_token_unique
  ON swarm_authority_reservations (usage_reconciliation_token_sha256)
  WHERE usage_reconciliation_token_sha256 IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS swarm_authority_provider_usage_correlation_unique
  ON swarm_authority_reservations (provider_usage_correlation_id)
  WHERE provider_usage_correlation_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS swarm_authority_runner_launch_attempt_unique
  ON swarm_authority_reservations (runner_launch_attempt_id) WHERE runner_launch_attempt_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS swarm_authority_runner_outcome_id_unique
  ON swarm_authority_reservations (runner_outcome_id) WHERE runner_outcome_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS swarm_authority_runner_heartbeat_request_unique
  ON swarm_authority_reservations (runner_heartbeat_request_id)
  WHERE runner_heartbeat_request_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS swarm_authority_runner_start_request_unique
  ON swarm_authority_reservations (runner_start_observation_request_id)
  WHERE runner_start_observation_request_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS swarm_authority_runner_process_unique
  ON swarm_authority_reservations (runner_process_instance_sha256)
  WHERE runner_process_instance_sha256 IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS swarm_authority_runner_start_evidence_ref_unique
  ON swarm_authority_reservations (runner_start_evidence_ref)
  WHERE runner_start_evidence_ref IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS swarm_authority_runner_start_evidence_unique
  ON swarm_authority_reservations (runner_start_evidence_sha256)
  WHERE runner_start_evidence_sha256 IS NOT NULL;

-- A grant-contract digest change cannot silently inherit an already-authorized
-- runner. Quarantine existing positive authority and retain committed ledgers
-- until a separately reviewed recovery path exists.
WITH quarantined AS (
  UPDATE swarm_authority_reservations SET state='stop-requested'
  WHERE state IN ('start-authorized-not-observed','runner-claimed-not-started','runner-start-observed')
    AND broker_role_contract_sha256 IS DISTINCT FROM '${BROKER_DATABASE_ROLE_CONTRACT_SHA256}'
  RETURNING reservation_id,operation_id,binding_digest_sha256
)
INSERT INTO swarm_authority_audit (event,operation_id,binding_digest_sha256,at,detail)
SELECT 'stop-requested',operation_id,binding_digest_sha256,clock_timestamp(),
  jsonb_build_object('reservation_id',reservation_id,'reason','broker role contract changed during migration',
    'execution_state','unknown','released_cost_usd',0)
FROM quarantined;

INSERT INTO swarm_authority_heartbeat_tokens
  (token_sha256,reservation_id,sequence,issued_by_request_id,issued_at,kind)
SELECT heartbeat_token_sha256,reservation_id,COALESCE(runner_heartbeat_sequence,0),
  COALESCE(runner_heartbeat_request_id,runner_claim_request_id),
  COALESCE(runner_heartbeat_accepted_at,runner_claim_accepted_at),
  CASE WHEN runner_heartbeat_sequence IS NULL THEN 'claim' ELSE 'heartbeat' END
FROM swarm_authority_reservations r
WHERE heartbeat_token_sha256 IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM swarm_authority_heartbeat_tokens t
    WHERE t.token_sha256=r.heartbeat_token_sha256
  );

DO $heartbeat_token_integrity$
BEGIN
  IF EXISTS (
    SELECT 1 FROM swarm_authority_reservations r
    LEFT JOIN swarm_authority_heartbeat_tokens t
      ON t.token_sha256=r.heartbeat_token_sha256
    WHERE r.heartbeat_token_sha256 IS NOT NULL AND (
      t.token_sha256 IS NULL OR t.reservation_id<>r.reservation_id
      OR t.sequence<>COALESCE(r.runner_heartbeat_sequence,0)
    )
  ) THEN
    RAISE EXCEPTION 'current heartbeat credential history is missing or inconsistent';
  END IF;
END
$heartbeat_token_integrity$;

INSERT INTO swarm_authority_usage_tokens
  (token_sha256,reservation_id,sequence,issued_by_request_id,issued_at,kind)
SELECT r.usage_reconciliation_token_sha256,r.reservation_id,
  COALESCE((SELECT MAX(e.usage_sequence) FROM swarm_authority_usage_evidence e
    WHERE e.reservation_id=r.reservation_id),0),
  COALESCE((SELECT e.usage_request_id FROM swarm_authority_usage_evidence e
    WHERE e.reservation_id=r.reservation_id ORDER BY e.usage_sequence DESC LIMIT 1),r.runner_claim_request_id),
  COALESCE((SELECT e.accepted_at FROM swarm_authority_usage_evidence e
    WHERE e.reservation_id=r.reservation_id ORDER BY e.usage_sequence DESC LIMIT 1),r.runner_claim_accepted_at),
  CASE WHEN EXISTS (SELECT 1 FROM swarm_authority_usage_evidence e
    WHERE e.reservation_id=r.reservation_id) THEN 'usage-evidence' ELSE 'claim' END
FROM swarm_authority_reservations r
WHERE r.usage_reconciliation_token_sha256 IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM swarm_authority_usage_tokens t
    WHERE t.token_sha256=r.usage_reconciliation_token_sha256);

DO $usage_token_integrity$
BEGIN
  IF EXISTS (
    SELECT 1 FROM swarm_authority_reservations r
    LEFT JOIN swarm_authority_usage_tokens t
      ON t.token_sha256=r.usage_reconciliation_token_sha256
    WHERE r.usage_reconciliation_token_sha256 IS NOT NULL AND (
      t.token_sha256 IS NULL OR t.reservation_id<>r.reservation_id
      OR t.sequence<>COALESCE((SELECT MAX(e.usage_sequence)
        FROM swarm_authority_usage_evidence e WHERE e.reservation_id=r.reservation_id),0)
    )
  ) THEN
    RAISE EXCEPTION 'current usage credential history is missing or inconsistent';
  END IF;
END
$usage_token_integrity$;

DO $usage_evidence_integrity$
BEGIN
  IF EXISTS (
    SELECT 1 FROM swarm_authority_usage_evidence e
    LEFT JOIN swarm_authority_reservations r ON r.reservation_id=e.reservation_id
    WHERE r.reservation_id IS NULL
      OR r.state NOT IN ('runner-never-started-observed','runner-terminal-observed')
      OR e.claim_id IS DISTINCT FROM r.runner_claim_id
      OR e.outcome_id IS DISTINCT FROM r.runner_outcome_id
      OR e.operation_id IS DISTINCT FROM r.operation_id
      OR e.effect_id IS DISTINCT FROM r.effect_id
      OR e.binding_digest_sha256 IS DISTINCT FROM r.binding_digest_sha256
      OR e.provider_usage_correlation_id IS DISTINCT FROM r.provider_usage_correlation_id
      OR e.authorized_cost_usd IS DISTINCT FROM r.committed_cost_usd
      OR e.usage_started_at < date_trunc('milliseconds',r.runner_claim_accepted_at)
      OR e.usage_ended_at > date_trunc('milliseconds',r.runner_outcome_at)
      OR e.budget_breach_observed IS DISTINCT FROM (
        e.cumulative_cost_usd > e.authorized_cost_usd
        OR (r.runner_outcome_kind='never-started' AND e.cumulative_cost_usd<>0::numeric)
      )
  ) THEN
    RAISE EXCEPTION 'provider usage evidence binding or breach attribution is inconsistent';
  END IF;
  IF EXISTS (
    SELECT 1 FROM swarm_authority_usage_evidence
    GROUP BY reservation_id
    HAVING MIN(usage_sequence)<>1 OR MAX(usage_sequence)<>COUNT(*)
      OR COUNT(*) FILTER (WHERE statement_status='final')>1
  ) THEN
    RAISE EXCEPTION 'provider usage evidence sequence or finality is inconsistent';
  END IF;
  IF EXISTS (
    WITH ordered AS (
      SELECT e.*,
        LAG(provider_id) OVER chain AS prior_provider_id,
        LAG(provider_account_ref) OVER chain AS prior_provider_account_ref,
        LAG(provider_usage_correlation_id) OVER chain AS prior_correlation,
        LAG(meter_id) OVER chain AS prior_meter_id,
        LAG(currency) OVER chain AS prior_currency,
        LAG(authn_kind) OVER chain AS prior_authn_kind,
        LAG(issuer) OVER chain AS prior_issuer,
        LAG(key_id) OVER chain AS prior_key_id,
        LAG(usage_started_at) OVER chain AS prior_usage_started_at,
        LAG(usage_ended_at) OVER chain AS prior_usage_ended_at,
        LAG(cumulative_cost_usd) OVER chain AS prior_cumulative_cost_usd,
        LAG(statement_status) OVER chain AS prior_statement_status
      FROM swarm_authority_usage_evidence e
      WINDOW chain AS (PARTITION BY reservation_id ORDER BY usage_sequence)
    )
    SELECT 1 FROM ordered WHERE usage_sequence>1 AND (
      provider_id IS DISTINCT FROM prior_provider_id
      OR provider_account_ref IS DISTINCT FROM prior_provider_account_ref
      OR provider_usage_correlation_id IS DISTINCT FROM prior_correlation
      OR meter_id IS DISTINCT FROM prior_meter_id
      OR currency IS DISTINCT FROM prior_currency
      OR authn_kind IS DISTINCT FROM prior_authn_kind
      OR issuer IS DISTINCT FROM prior_issuer
      OR key_id IS DISTINCT FROM prior_key_id
      OR usage_started_at IS DISTINCT FROM prior_usage_started_at
      OR usage_ended_at < prior_usage_ended_at
      OR cumulative_cost_usd < prior_cumulative_cost_usd
      OR prior_statement_status='final'
    )
  ) THEN
    RAISE EXCEPTION 'provider usage evidence stream drifted or regressed';
  END IF;
  IF EXISTS (
    SELECT 1 FROM swarm_authority_usage_evidence e
    LEFT JOIN swarm_authority_usage_tokens presented
      ON presented.reservation_id=e.reservation_id
      AND presented.sequence=e.usage_sequence-1
      AND presented.token_sha256=e.presented_token_sha256
    LEFT JOIN swarm_authority_usage_tokens next_token
      ON next_token.reservation_id=e.reservation_id
      AND next_token.sequence=e.usage_sequence
      AND next_token.token_sha256=e.next_token_sha256
      AND next_token.issued_by_request_id=e.usage_request_id
    WHERE presented.token_sha256 IS NULL OR next_token.token_sha256 IS NULL
  ) THEN
    RAISE EXCEPTION 'provider usage evidence token chain is missing or inconsistent';
  END IF;
  IF EXISTS (
    SELECT 1 FROM swarm_authority_usage_tokens t
    LEFT JOIN (
      SELECT reservation_id,COALESCE(MAX(usage_sequence),0)+1 AS expected_tokens
      FROM swarm_authority_usage_evidence GROUP BY reservation_id
    ) evidence ON evidence.reservation_id=t.reservation_id
    GROUP BY t.reservation_id,evidence.expected_tokens
    HAVING COUNT(*)<>COALESCE(evidence.expected_tokens,1)
  ) THEN
    RAISE EXCEPTION 'provider usage token history has missing or excess entries';
  END IF;
END
$usage_evidence_integrity$;

DO $migration$
BEGIN
  IF EXISTS (
    SELECT 1 FROM (
      SELECT budget_receipt_id,SUM(reserved_cost_usd) AS cost
      FROM swarm_authority_reservations WHERE consume_token_sha256 IS NULL GROUP BY budget_receipt_id
    ) legacy LEFT JOIN swarm_authority_budgets b ON b.receipt_id=legacy.budget_receipt_id
    WHERE b.receipt_id IS NULL OR legacy.cost < 0 OR b.reserved_usd < legacy.cost
  ) THEN
    RAISE EXCEPTION 'legacy reservation budget ledger is inconsistent';
  END IF;
  IF EXISTS (
    SELECT 1 FROM swarm_authority_reservations r
    LEFT JOIN swarm_authority_hosts h ON h.host_id=r.host_id
    WHERE r.consume_token_sha256 IS NULL AND (
      h.host_id IS NULL OR jsonb_typeof(h.evidence->'available_slots') <> 'number'
      OR (h.evidence->>'available_slots')::INTEGER < 0
    )
  ) THEN
    RAISE EXCEPTION 'legacy reservation host ledger is inconsistent';
  END IF;
END
$migration$;

UPDATE swarm_authority_budgets b SET reserved_usd=b.reserved_usd-legacy.cost
FROM (
  SELECT budget_receipt_id,SUM(reserved_cost_usd) AS cost
  FROM swarm_authority_reservations WHERE consume_token_sha256 IS NULL GROUP BY budget_receipt_id
) legacy WHERE b.receipt_id=legacy.budget_receipt_id;
UPDATE swarm_authority_hosts h SET
  capacity_slots=COALESCE((h.evidence->>'available_slots')::INTEGER,0)+legacy.slots,
  reserved_slots=0,
  evidence=(h.evidence-'available_slots') || jsonb_build_object(
    'capacity_slots',COALESCE((h.evidence->>'available_slots')::INTEGER,0)+legacy.slots
  )
FROM (
  SELECT host_id,COUNT(*)::INTEGER AS slots
  FROM swarm_authority_reservations WHERE consume_token_sha256 IS NULL GROUP BY host_id
) legacy WHERE h.host_id=legacy.host_id AND h.capacity_slots IS NULL;
UPDATE swarm_authority_hosts SET
  capacity_slots=COALESCE(capacity_slots,(evidence->>'capacity_slots')::INTEGER,(evidence->>'available_slots')::INTEGER,0),
  reserved_slots=COALESCE(reserved_slots,0),
  evidence=(evidence-'available_slots') || jsonb_build_object(
    'capacity_slots',COALESCE(capacity_slots,(evidence->>'capacity_slots')::INTEGER,(evidence->>'available_slots')::INTEGER,0)
  );

ALTER TABLE swarm_authority_reservations DROP CONSTRAINT IF EXISTS swarm_authority_reservations_state_check;
INSERT INTO swarm_authority_audit (event,operation_id,binding_digest_sha256,at,detail)
SELECT 'cancelled',operation_id,binding_digest_sha256,clock_timestamp(),
  jsonb_build_object('reservation_id',reservation_id,'reason','legacy reservation lacked lifecycle credentials')
FROM swarm_authority_reservations WHERE consume_token_sha256 IS NULL;
UPDATE swarm_authority_reservations SET state='cancelled',binding='{}'::jsonb,revocation_refs='[]'::jsonb,
  consume_token_sha256=repeat('0',64),cancel_token_sha256=repeat('0',64),max_host_evidence_age_ms=300000
WHERE consume_token_sha256 IS NULL;

-- Legacy reservation rows have now been tombstoned with a concrete binding,
-- so the database can enforce its own checksum for every current and future row.
UPDATE swarm_authority_reservations
   SET binding_database_sha256=encode(sha256(convert_to(binding::text,'UTF8')),'hex')
 WHERE binding IS NOT NULL AND binding_database_sha256 IS NULL;
ALTER TABLE swarm_authority_reservations ALTER COLUMN binding_database_sha256 SET NOT NULL;
DO $binding_database_digest_constraint$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
     WHERE conrelid='public.swarm_authority_reservations'::pg_catalog.regclass
       AND conname='swarm_authority_reservations_binding_database_digest_check'
  ) THEN
    ALTER TABLE public.swarm_authority_reservations
      ADD CONSTRAINT swarm_authority_reservations_binding_database_digest_check
      CHECK (binding_database_sha256=encode(sha256(convert_to(binding::text,'UTF8')),'hex'));
  END IF;
END
$binding_database_digest_constraint$;

-- A lifecycle reservation created before aggregate-window binding cannot be
-- grandfathered safely. Cancel the non-started hold and reconcile it exactly.
DO $aggregate_migration$
BEGIN
  IF EXISTS (
    SELECT 1 FROM (
      SELECT r.budget_receipt_id,SUM(r.reserved_cost_usd) AS cost
      FROM swarm_authority_reservations r
      WHERE r.state IN ('reserved-not-started','consumed-not-started','leased-not-started')
        AND NOT EXISTS (SELECT 1 FROM swarm_authority_budget_holds h WHERE h.reservation_id=r.reservation_id)
      GROUP BY budget_receipt_id
    ) pending LEFT JOIN swarm_authority_budgets b ON b.receipt_id=pending.budget_receipt_id
    WHERE b.receipt_id IS NULL OR pending.cost < 0 OR b.reserved_usd < pending.cost
  ) THEN
    RAISE EXCEPTION 'pre-aggregate reservation budget ledger is inconsistent';
  END IF;
  IF EXISTS (
    SELECT 1 FROM (
      SELECT r.host_id,COUNT(*)::INTEGER AS slots
      FROM swarm_authority_reservations r
      WHERE r.state IN ('reserved-not-started','consumed-not-started','leased-not-started')
        AND NOT EXISTS (SELECT 1 FROM swarm_authority_budget_holds b WHERE b.reservation_id=r.reservation_id)
      GROUP BY host_id
    ) pending LEFT JOIN swarm_authority_hosts h ON h.host_id=pending.host_id
    WHERE h.host_id IS NULL OR h.reserved_slots < pending.slots
  ) THEN
    RAISE EXCEPTION 'pre-aggregate reservation host ledger is inconsistent';
  END IF;
END
$aggregate_migration$;
UPDATE swarm_authority_budgets b SET reserved_usd=b.reserved_usd-pending.cost
FROM (
  SELECT r.budget_receipt_id,SUM(r.reserved_cost_usd) AS cost
  FROM swarm_authority_reservations r
  WHERE r.state IN ('reserved-not-started','consumed-not-started','leased-not-started')
    AND NOT EXISTS (SELECT 1 FROM swarm_authority_budget_holds h WHERE h.reservation_id=r.reservation_id)
  GROUP BY budget_receipt_id
) pending WHERE b.receipt_id=pending.budget_receipt_id;
UPDATE swarm_authority_hosts h SET reserved_slots=reserved_slots-pending.slots
FROM (
  SELECT r.host_id,COUNT(*)::INTEGER AS slots
  FROM swarm_authority_reservations r
  WHERE r.state IN ('reserved-not-started','consumed-not-started','leased-not-started')
    AND NOT EXISTS (SELECT 1 FROM swarm_authority_budget_holds b WHERE b.reservation_id=r.reservation_id)
  GROUP BY host_id
) pending WHERE h.host_id=pending.host_id;
INSERT INTO swarm_authority_audit (event,operation_id,binding_digest_sha256,at,detail)
SELECT 'reservation-cancelled',operation_id,binding_digest_sha256,clock_timestamp(),
  jsonb_build_object('reservation_id',reservation_id,'reason','reservation predated aggregate budget binding','released_cost_usd',reserved_cost_usd)
FROM swarm_authority_reservations r
WHERE r.state IN ('reserved-not-started','consumed-not-started','leased-not-started')
  AND NOT EXISTS (SELECT 1 FROM swarm_authority_budget_holds h WHERE h.reservation_id=r.reservation_id);
UPDATE swarm_authority_reservations r SET state='cancelled'
WHERE r.state IN ('reserved-not-started','consumed-not-started','leased-not-started')
  AND NOT EXISTS (SELECT 1 FROM swarm_authority_budget_holds h WHERE h.reservation_id=r.reservation_id);

-- Leases issued before redemption and control credentials existed cannot be
-- credential-grafted safely. They never authorized a runner, so cancel them as
-- replay tombstones and release their still-reserved resources exactly once.
DO $legacy_lease_migration$
BEGIN
  IF EXISTS (
    SELECT 1 FROM (
      SELECT budget_receipt_id,SUM(reserved_cost_usd) AS cost
      FROM swarm_authority_reservations
      WHERE state='leased-not-started'
        AND (redemption_token_sha256 IS NULL OR control_token_sha256 IS NULL
          OR broker_execution_identity IS NULL OR broker_identity_evidence_ref IS NULL)
      GROUP BY budget_receipt_id
    ) legacy LEFT JOIN swarm_authority_budgets b ON b.receipt_id=legacy.budget_receipt_id
    WHERE b.receipt_id IS NULL OR legacy.cost < 0 OR b.reserved_usd < legacy.cost
  ) THEN
    RAISE EXCEPTION 'legacy start lease budget ledger is inconsistent';
  END IF;
  IF EXISTS (
    SELECT 1 FROM (
      SELECT host_id,COUNT(*)::INTEGER AS slots
      FROM swarm_authority_reservations
      WHERE state='leased-not-started'
        AND (redemption_token_sha256 IS NULL OR control_token_sha256 IS NULL
          OR broker_execution_identity IS NULL OR broker_identity_evidence_ref IS NULL)
      GROUP BY host_id
    ) legacy LEFT JOIN swarm_authority_hosts h ON h.host_id=legacy.host_id
    WHERE h.host_id IS NULL OR h.reserved_slots < legacy.slots
  ) THEN
    RAISE EXCEPTION 'legacy start lease host ledger is inconsistent';
  END IF;
END
$legacy_lease_migration$;
UPDATE swarm_authority_budgets b SET reserved_usd=reserved_usd-legacy.cost
FROM (
  SELECT budget_receipt_id,SUM(reserved_cost_usd) AS cost
  FROM swarm_authority_reservations
  WHERE state='leased-not-started'
    AND (redemption_token_sha256 IS NULL OR control_token_sha256 IS NULL
      OR broker_execution_identity IS NULL OR broker_identity_evidence_ref IS NULL)
  GROUP BY budget_receipt_id
) legacy WHERE b.receipt_id=legacy.budget_receipt_id;
UPDATE swarm_authority_budget_windows w SET reserved_usd=reserved_usd-legacy.cost
FROM (
  SELECT h.window_id,SUM(h.reserved_cost_usd) AS cost
  FROM swarm_authority_budget_holds h
  JOIN swarm_authority_reservations r ON r.reservation_id=h.reservation_id
  WHERE r.state='leased-not-started'
    AND (r.redemption_token_sha256 IS NULL OR r.control_token_sha256 IS NULL
      OR r.broker_execution_identity IS NULL OR r.broker_identity_evidence_ref IS NULL)
  GROUP BY h.window_id
) legacy WHERE w.window_id=legacy.window_id AND w.reserved_usd >= legacy.cost;
UPDATE swarm_authority_hosts h SET reserved_slots=reserved_slots-legacy.slots
FROM (
  SELECT host_id,COUNT(*)::INTEGER AS slots
  FROM swarm_authority_reservations
  WHERE state='leased-not-started'
    AND (redemption_token_sha256 IS NULL OR control_token_sha256 IS NULL
      OR broker_execution_identity IS NULL OR broker_identity_evidence_ref IS NULL)
  GROUP BY host_id
) legacy WHERE h.host_id=legacy.host_id AND h.reserved_slots >= legacy.slots;
INSERT INTO swarm_authority_audit (event,operation_id,binding_digest_sha256,at,detail)
SELECT 'reservation-cancelled',operation_id,binding_digest_sha256,clock_timestamp(),
  jsonb_build_object('reservation_id',reservation_id,'lease_id',lease_id,
    'reason','lease predated redemption and control credentials','released_cost_usd',reserved_cost_usd)
FROM swarm_authority_reservations
WHERE state='leased-not-started'
  AND (redemption_token_sha256 IS NULL OR control_token_sha256 IS NULL
    OR broker_execution_identity IS NULL OR broker_identity_evidence_ref IS NULL);
UPDATE swarm_authority_reservations SET state='cancelled'
WHERE state='leased-not-started'
  AND (redemption_token_sha256 IS NULL OR control_token_sha256 IS NULL
    OR broker_execution_identity IS NULL OR broker_identity_evidence_ref IS NULL);

-- Earlier start-authorized rows did not bind the authenticated database
-- principal. Preserve their conservative committed ledgers, but quarantine
-- them so they can never be returned as current positive authority.
INSERT INTO swarm_authority_audit (event,operation_id,binding_digest_sha256,at,detail)
SELECT 'stop-requested',operation_id,binding_digest_sha256,clock_timestamp(),
  jsonb_build_object('reservation_id',reservation_id,
    'reason','start authorization predated authenticated broker database principal',
    'execution_state','unknown','released_cost_usd',0)
FROM swarm_authority_reservations
WHERE state IN ('start-authorized-not-observed','runner-claimed-not-started','runner-start-observed')
  AND (num_nonnulls(broker_database_role,broker_database_name,broker_role_contract_sha256) <> 3
    OR broker_role_contract_sha256 <> '${BROKER_DATABASE_ROLE_CONTRACT_SHA256}');
UPDATE swarm_authority_reservations SET state='stop-requested'
WHERE state IN ('start-authorized-not-observed','runner-claimed-not-started','runner-start-observed')
  AND (num_nonnulls(broker_database_role,broker_database_name,broker_role_contract_sha256) <> 3
    OR broker_role_contract_sha256 <> '${BROKER_DATABASE_ROLE_CONTRACT_SHA256}');

-- Any attributed active reservation must be bound to exactly one policy and one
-- daily window for its signed policy, and every aggregate ledger must reconcile
-- exactly to the active holds. Partial or fabricated attribution fails migration.
DO $aggregate_integrity$
BEGIN
  IF EXISTS (
    SELECT 1 FROM swarm_authority_reservations r
    LEFT JOIN swarm_authority_budget_holds h ON h.reservation_id=r.reservation_id
    LEFT JOIN swarm_authority_budget_windows w ON w.window_id=h.window_id
    WHERE r.state IN ('reserved-not-started','consumed-not-started','leased-not-started')
    GROUP BY r.reservation_id,r.binding,r.reserved_cost_usd
    HAVING COUNT(h.window_id) <> 2
      OR r.reserved_cost_usd IS DISTINCT FROM (r.binding->>'requested_cost_usd')::numeric
      OR COUNT(DISTINCT w.kind) <> 2
      OR COUNT(*) FILTER (WHERE w.kind='policy') <> 1
      OR COUNT(*) FILTER (WHERE w.kind='daily') <> 1
      OR COUNT(*) FILTER (WHERE w.policy_id IS DISTINCT FROM r.binding->>'budget_policy_id'
        OR w.currency IS DISTINCT FROM 'USD' OR h.reserved_cost_usd IS DISTINCT FROM r.reserved_cost_usd) > 0
  ) THEN
    RAISE EXCEPTION 'active aggregate budget attribution is inconsistent';
  END IF;
  IF EXISTS (
    SELECT 1 FROM swarm_authority_budget_windows w
    LEFT JOIN (
      SELECT h.window_id,SUM(h.reserved_cost_usd) AS held
      FROM swarm_authority_budget_holds h
      JOIN swarm_authority_reservations r ON r.reservation_id=h.reservation_id
      WHERE r.state IN ('reserved-not-started','consumed-not-started','leased-not-started')
      GROUP BY h.window_id
    ) active ON active.window_id=w.window_id
    WHERE w.reserved_usd IS DISTINCT FROM COALESCE(active.held,0)
  ) THEN
    RAISE EXCEPTION 'aggregate budget window ledger does not reconcile to active holds';
  END IF;
END
$aggregate_integrity$;

DO $start_authority_integrity$
BEGIN
  IF EXISTS (
    SELECT 1 FROM swarm_authority_reservations r
    LEFT JOIN swarm_authority_budgets b ON b.receipt_id=r.budget_receipt_id
    LEFT JOIN swarm_authority_hosts host ON host.host_id=r.host_id
    LEFT JOIN swarm_authority_budget_holds h ON h.reservation_id=r.reservation_id
    LEFT JOIN swarm_authority_budget_windows w ON w.window_id=h.window_id
    WHERE r.state IN ('start-authorized-not-observed','runner-claimed-not-started','runner-start-observed','stop-requested','runner-never-started-observed','runner-terminal-observed')
    GROUP BY r.reservation_id,r.binding,r.reserved_cost_usd,r.committed_cost_usd,
      b.receipt_id,host.host_id
    HAVING b.receipt_id IS NULL OR host.host_id IS NULL
      OR r.host_id IS DISTINCT FROM r.binding->>'host_id'
      OR r.reserved_cost_usd IS DISTINCT FROM (r.binding->>'requested_cost_usd')::numeric
      OR r.committed_cost_usd IS DISTINCT FROM r.reserved_cost_usd
      OR COUNT(h.window_id) <> 2 OR COUNT(DISTINCT w.kind) <> 2
      OR COUNT(*) FILTER (WHERE w.kind='policy') <> 1
      OR COUNT(*) FILTER (WHERE w.kind='daily') <> 1
      OR COUNT(*) FILTER (WHERE w.policy_id IS DISTINCT FROM r.binding->>'budget_policy_id'
        OR w.currency IS DISTINCT FROM 'USD'
        OR h.reserved_cost_usd IS DISTINCT FROM r.reserved_cost_usd) > 0
  ) THEN
    RAISE EXCEPTION 'authorized operation attribution is missing, ambiguous, or inconsistent';
  END IF;
  IF EXISTS (
    SELECT 1 FROM swarm_authority_budgets b
    LEFT JOIN (
      SELECT budget_receipt_id,SUM(reserved_cost_usd) AS cost
      FROM swarm_authority_reservations
      WHERE state IN ('start-authorized-not-observed','runner-claimed-not-started','runner-start-observed','stop-requested','runner-never-started-observed','runner-terminal-observed')
      GROUP BY budget_receipt_id
    ) committed ON committed.budget_receipt_id=b.receipt_id
    WHERE b.committed_usd IS DISTINCT FROM COALESCE(committed.cost,0)
  ) THEN
    RAISE EXCEPTION 'committed receipt budget ledger does not reconcile';
  END IF;
  IF EXISTS (
    SELECT 1 FROM swarm_authority_budget_windows w
    LEFT JOIN (
      SELECT h.window_id,SUM(h.reserved_cost_usd) AS cost
      FROM swarm_authority_budget_holds h
      JOIN swarm_authority_reservations r ON r.reservation_id=h.reservation_id
      WHERE r.state IN ('start-authorized-not-observed','runner-claimed-not-started','runner-start-observed','stop-requested','runner-never-started-observed','runner-terminal-observed')
      GROUP BY h.window_id
    ) committed ON committed.window_id=w.window_id
    WHERE w.committed_usd IS DISTINCT FROM COALESCE(committed.cost,0)
  ) THEN
    RAISE EXCEPTION 'committed aggregate budget ledger does not reconcile';
  END IF;
  IF EXISTS (
    SELECT 1 FROM swarm_authority_hosts h
    LEFT JOIN (
      SELECT host_id,COUNT(*)::INTEGER AS slots
      FROM swarm_authority_reservations
      WHERE state IN ('start-authorized-not-observed','runner-claimed-not-started','runner-start-observed','stop-requested','runner-never-started-observed')
      GROUP BY host_id
    ) authorized ON authorized.host_id=h.host_id
    WHERE h.authorized_slots IS DISTINCT FROM COALESCE(authorized.slots,0)
      OR h.reserved_slots + h.authorized_slots > h.capacity_slots
  ) THEN
    RAISE EXCEPTION 'authorized host ledger does not reconcile';
  END IF;
END
$start_authority_integrity$;

DO $aggregate_constraints$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='swarm_authority_budget_holds_reservation_fk') THEN
    ALTER TABLE swarm_authority_budget_holds ADD CONSTRAINT swarm_authority_budget_holds_reservation_fk
      FOREIGN KEY (reservation_id) REFERENCES swarm_authority_reservations(reservation_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='swarm_authority_budget_holds_window_fk') THEN
    ALTER TABLE swarm_authority_budget_holds ADD CONSTRAINT swarm_authority_budget_holds_window_fk
      FOREIGN KEY (window_id) REFERENCES swarm_authority_budget_windows(window_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='swarm_authority_usage_tokens_reservation_fk') THEN
    ALTER TABLE swarm_authority_usage_tokens ADD CONSTRAINT swarm_authority_usage_tokens_reservation_fk
      FOREIGN KEY (reservation_id) REFERENCES swarm_authority_reservations(reservation_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='swarm_authority_usage_evidence_reservation_fk') THEN
    ALTER TABLE swarm_authority_usage_evidence ADD CONSTRAINT swarm_authority_usage_evidence_reservation_fk
      FOREIGN KEY (reservation_id) REFERENCES swarm_authority_reservations(reservation_id);
  END IF;
END
$aggregate_constraints$;

ALTER TABLE swarm_authority_hosts ALTER COLUMN capacity_slots SET NOT NULL;
ALTER TABLE swarm_authority_hosts ALTER COLUMN reserved_slots SET DEFAULT 0;
ALTER TABLE swarm_authority_hosts ALTER COLUMN reserved_slots SET NOT NULL;
ALTER TABLE swarm_authority_hosts ALTER COLUMN authorized_slots SET DEFAULT 0;
ALTER TABLE swarm_authority_hosts ALTER COLUMN authorized_slots SET NOT NULL;
ALTER TABLE swarm_authority_hosts DROP CONSTRAINT IF EXISTS swarm_authority_hosts_capacity_slots_check;
ALTER TABLE swarm_authority_hosts ADD CONSTRAINT swarm_authority_hosts_capacity_slots_check CHECK (capacity_slots >= 0);
ALTER TABLE swarm_authority_hosts DROP CONSTRAINT IF EXISTS swarm_authority_hosts_reserved_slots_check;
ALTER TABLE swarm_authority_hosts ADD CONSTRAINT swarm_authority_hosts_reserved_slots_check CHECK (reserved_slots >= 0);
ALTER TABLE swarm_authority_hosts DROP CONSTRAINT IF EXISTS swarm_authority_hosts_authorized_slots_check;
ALTER TABLE swarm_authority_hosts ADD CONSTRAINT swarm_authority_hosts_authorized_slots_check CHECK (authorized_slots >= 0);
ALTER TABLE swarm_authority_hosts DROP CONSTRAINT IF EXISTS swarm_authority_hosts_total_slots_check;
ALTER TABLE swarm_authority_hosts ADD CONSTRAINT swarm_authority_hosts_total_slots_check CHECK (reserved_slots + authorized_slots <= capacity_slots);
ALTER TABLE swarm_authority_budgets DROP CONSTRAINT IF EXISTS swarm_authority_budgets_total_usd_check;
ALTER TABLE swarm_authority_budgets ADD CONSTRAINT swarm_authority_budgets_total_usd_check CHECK (reserved_usd + committed_usd <= hard_limit_usd);
ALTER TABLE swarm_authority_budget_windows DROP CONSTRAINT IF EXISTS swarm_authority_budget_windows_total_usd_check;
ALTER TABLE swarm_authority_budget_windows ADD CONSTRAINT swarm_authority_budget_windows_total_usd_check CHECK (reserved_usd + committed_usd <= hard_limit_usd);
ALTER TABLE swarm_authority_reservations ALTER COLUMN binding SET NOT NULL;
ALTER TABLE swarm_authority_reservations ALTER COLUMN revocation_refs SET NOT NULL;
ALTER TABLE swarm_authority_reservations ALTER COLUMN consume_token_sha256 SET NOT NULL;
ALTER TABLE swarm_authority_reservations ALTER COLUMN cancel_token_sha256 SET NOT NULL;
ALTER TABLE swarm_authority_reservations ALTER COLUMN max_host_evidence_age_ms SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS swarm_authority_reservations_lease_id_uq
  ON swarm_authority_reservations(lease_id) WHERE lease_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS swarm_authority_reservations_start_request_id_uq
  ON swarm_authority_reservations(start_request_id) WHERE start_request_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS swarm_authority_reservations_redemption_id_uq
  ON swarm_authority_reservations(redemption_id) WHERE redemption_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS swarm_authority_reservations_redemption_request_id_uq
  ON swarm_authority_reservations(redemption_request_id) WHERE redemption_request_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS swarm_authority_reservations_runner_claim_id_uq
  ON swarm_authority_reservations(runner_claim_id) WHERE runner_claim_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS swarm_authority_reservations_runner_claim_request_id_uq
  ON swarm_authority_reservations(runner_claim_request_id) WHERE runner_claim_request_id IS NOT NULL;
ALTER TABLE swarm_authority_reservations DROP CONSTRAINT IF EXISTS swarm_authority_reservations_lease_fields_check;
ALTER TABLE swarm_authority_reservations ADD CONSTRAINT swarm_authority_reservations_lease_fields_check CHECK (
  num_nonnulls(lease_id,start_request_id,lease_issued_at,lease_expires_at,lease_duration_ms) IN (0,5)
  AND (lease_id IS NULL OR (
    lease_duration_ms BETWEEN 1000 AND 900000
    AND lease_expires_at=lease_issued_at+(lease_duration_ms*INTERVAL '1 millisecond')
  ))
  AND (state <> 'reserved-not-started' OR (lease_id IS NULL AND lease_claim_token_sha256 IS NULL))
  AND (state IN ('cancelled','expired') OR consume_token_sha256 <> cancel_token_sha256)
  AND (state <> 'consumed-not-started' OR (
    lease_id IS NULL
    AND (lease_claim_token_sha256 IS NULL OR (
      consume_token_sha256 <> lease_claim_token_sha256
      AND cancel_token_sha256 <> lease_claim_token_sha256
    ))
  ))
  AND (state <> 'leased-not-started' OR (
    lease_id IS NOT NULL AND lease_claim_token_sha256 IS NOT NULL
    AND num_nonnulls(redemption_token_sha256,control_token_sha256,broker_execution_identity,broker_identity_evidence_ref)=4
    AND cancel_token_sha256 <> lease_claim_token_sha256
    AND cancel_token_sha256 <> redemption_token_sha256
    AND cancel_token_sha256 <> control_token_sha256
    AND consume_token_sha256 <> lease_claim_token_sha256
    AND consume_token_sha256 <> redemption_token_sha256
    AND consume_token_sha256 <> control_token_sha256
    AND lease_claim_token_sha256 <> redemption_token_sha256
    AND lease_claim_token_sha256 <> control_token_sha256
    AND redemption_token_sha256 <> control_token_sha256
  ))
  AND (state NOT IN ('start-authorized-not-observed','runner-claimed-not-started','runner-start-observed','stop-requested','runner-never-started-observed','runner-terminal-observed') OR (
    lease_id IS NOT NULL AND lease_claim_token_sha256 IS NOT NULL
    AND num_nonnulls(redemption_token_sha256,control_token_sha256,broker_execution_identity,broker_identity_evidence_ref)=4
    AND cancel_token_sha256 <> lease_claim_token_sha256
    AND cancel_token_sha256 <> redemption_token_sha256
    AND cancel_token_sha256 <> control_token_sha256
    AND consume_token_sha256 <> lease_claim_token_sha256
    AND consume_token_sha256 <> redemption_token_sha256
    AND consume_token_sha256 <> control_token_sha256
    AND lease_claim_token_sha256 <> redemption_token_sha256
    AND lease_claim_token_sha256 <> control_token_sha256
    AND redemption_token_sha256 <> control_token_sha256
    AND num_nonnulls(redemption_id,redemption_request_id,start_authorized_at,committed_cost_usd)=4
    AND committed_cost_usd=reserved_cost_usd
  ))
  AND (state NOT IN ('start-authorized-not-observed','runner-claimed-not-started','runner-start-observed') OR (
    num_nonnulls(broker_database_role,broker_database_name,broker_role_contract_sha256)=3
    AND broker_role_contract_sha256='${BROKER_DATABASE_ROLE_CONTRACT_SHA256}'
  ))
  AND (state NOT IN ('runner-claimed-not-started','runner-start-observed','runner-never-started-observed','runner-terminal-observed') OR (
    num_nonnulls(runner_claim_id,runner_claim_request_id,runner_claim_accepted_at,runner_claim_expires_at,
      runner_evidence_observed_at,runner_access_review_expires_at,
      runner_id,runner_identity_evidence_ref,runner_instance_id,runner_runtime_id,runner_host_id,
      runner_channel_binding_sha256,heartbeat_token_sha256,start_observation_token_sha256,outcome_token_sha256,
      runner_launch_attempt_id,runner_fencing_generation,runner_revocation_refs)=18
    AND num_nonnulls(usage_reconciliation_token_sha256,provider_usage_correlation_id) IN (0,2)
    AND runner_claim_expires_at > runner_claim_accepted_at
    AND runner_access_review_expires_at > runner_evidence_observed_at
    AND runner_claim_expires_at <= runner_access_review_expires_at
    AND runner_runtime_id=binding->>'runtime_id'
    AND runner_host_id=host_id
    AND runner_id=binding->>'execution_identity'
    AND runner_identity_evidence_ref=binding->>'identity_evidence_ref'
    AND heartbeat_token_sha256 <> consume_token_sha256
    AND heartbeat_token_sha256 <> cancel_token_sha256
    AND heartbeat_token_sha256 <> lease_claim_token_sha256
    AND heartbeat_token_sha256 <> redemption_token_sha256
    AND heartbeat_token_sha256 <> control_token_sha256
    AND start_observation_token_sha256 <> consume_token_sha256
    AND start_observation_token_sha256 <> cancel_token_sha256
    AND start_observation_token_sha256 <> lease_claim_token_sha256
    AND start_observation_token_sha256 <> redemption_token_sha256
    AND start_observation_token_sha256 <> control_token_sha256
    AND start_observation_token_sha256 <> heartbeat_token_sha256
    AND outcome_token_sha256 <> consume_token_sha256
    AND outcome_token_sha256 <> cancel_token_sha256
    AND outcome_token_sha256 <> lease_claim_token_sha256
    AND outcome_token_sha256 <> redemption_token_sha256
    AND outcome_token_sha256 <> control_token_sha256
    AND outcome_token_sha256 <> heartbeat_token_sha256
    AND outcome_token_sha256 <> start_observation_token_sha256
    AND usage_reconciliation_token_sha256 <> consume_token_sha256
    AND usage_reconciliation_token_sha256 <> cancel_token_sha256
    AND usage_reconciliation_token_sha256 <> lease_claim_token_sha256
    AND usage_reconciliation_token_sha256 <> redemption_token_sha256
    AND usage_reconciliation_token_sha256 <> control_token_sha256
    AND usage_reconciliation_token_sha256 <> heartbeat_token_sha256
    AND usage_reconciliation_token_sha256 <> start_observation_token_sha256
    AND usage_reconciliation_token_sha256 <> outcome_token_sha256
    AND runner_fencing_generation >= 1
    AND jsonb_typeof(runner_revocation_refs) = 'array'
    AND (num_nonnulls(runner_heartbeat_id,runner_heartbeat_request_id,
      runner_heartbeat_sequence,runner_heartbeat_accepted_at,
      runner_heartbeat_presented_token_sha256)=0 OR (
      num_nonnulls(runner_heartbeat_id,runner_heartbeat_request_id,
        runner_heartbeat_sequence,runner_heartbeat_accepted_at,
        runner_heartbeat_presented_token_sha256)=5
      AND runner_heartbeat_sequence >= 1
      AND runner_heartbeat_accepted_at >= runner_claim_accepted_at
      AND runner_claim_expires_at > runner_heartbeat_accepted_at
      AND runner_heartbeat_presented_token_sha256 <> heartbeat_token_sha256
      AND runner_heartbeat_presented_token_sha256 <> consume_token_sha256
      AND runner_heartbeat_presented_token_sha256 <> cancel_token_sha256
      AND runner_heartbeat_presented_token_sha256 <> lease_claim_token_sha256
      AND runner_heartbeat_presented_token_sha256 <> redemption_token_sha256
      AND runner_heartbeat_presented_token_sha256 <> control_token_sha256
      AND runner_heartbeat_presented_token_sha256 <> start_observation_token_sha256
      AND runner_heartbeat_presented_token_sha256 <> outcome_token_sha256
      AND runner_heartbeat_presented_token_sha256 <> usage_reconciliation_token_sha256
    ))
  ))
  AND (state NOT IN ('runner-start-observed','runner-terminal-observed') OR (
    num_nonnulls(runner_start_observation_id,runner_start_observation_request_id,
      runner_start_observation_accepted_at,runner_start_evidence_observed_at,
      runner_process_started_at,runner_process_instance_sha256,runner_start_evidence_ref,
      runner_start_evidence_sha256,runner_start_presented_token_sha256)=9
    AND runner_process_started_at >= runner_claim_accepted_at
    AND runner_process_started_at <= runner_start_evidence_observed_at
    AND runner_start_evidence_observed_at <= runner_start_observation_accepted_at
    AND runner_start_observation_accepted_at < runner_claim_expires_at
    AND runner_start_presented_token_sha256=start_observation_token_sha256
  ))
  AND (state NOT IN ('reserved-not-started','consumed-not-started','leased-not-started','start-authorized-not-observed','cancelled','expired') OR
    num_nonnulls(runner_claim_id,runner_claim_request_id,runner_claim_accepted_at,runner_claim_expires_at,
      runner_evidence_observed_at,runner_access_review_expires_at,
      runner_id,runner_identity_evidence_ref,runner_instance_id,runner_runtime_id,runner_host_id,
      runner_channel_binding_sha256,heartbeat_token_sha256,start_observation_token_sha256,outcome_token_sha256,
      runner_launch_attempt_id,runner_fencing_generation,runner_revocation_refs,
      usage_reconciliation_token_sha256,provider_usage_correlation_id)=0)
  AND (state IN ('runner-claimed-not-started','runner-start-observed','stop-requested','runner-never-started-observed','runner-terminal-observed') OR
    num_nonnulls(runner_heartbeat_id,runner_heartbeat_request_id,
      runner_heartbeat_sequence,runner_heartbeat_accepted_at,
      runner_heartbeat_presented_token_sha256)=0)
  AND (state IN ('runner-start-observed','runner-terminal-observed','stop-requested') OR
    num_nonnulls(runner_start_observation_id,runner_start_observation_request_id,
      runner_start_observation_accepted_at,runner_start_evidence_observed_at,
      runner_process_started_at,runner_process_instance_sha256,runner_start_evidence_ref,
      runner_start_evidence_sha256,runner_start_presented_token_sha256)=0)
  AND (state NOT IN ('runner-never-started-observed','runner-terminal-observed') OR (
    num_nonnulls(runner_outcome_id,runner_outcome_request_id,runner_outcome_event_id,
      runner_outcome_kind,runner_outcome_accepted_at,runner_outcome_at,
      runner_outcome_evidence_observed_at,runner_outcome_evidence_ref,
      runner_outcome_evidence_sha256,runner_outcome_presented_token_sha256,
      runner_remote_stop_confirmed)=11
    AND runner_outcome_at >= runner_claim_accepted_at
    AND runner_outcome_at <= runner_outcome_evidence_observed_at
    AND runner_outcome_evidence_observed_at <= runner_outcome_accepted_at
    AND runner_outcome_presented_token_sha256=outcome_token_sha256
    AND ((state='runner-never-started-observed' AND runner_outcome_kind='never-started'
      AND runner_process_instance_sha256 IS NULL AND runner_exit_disposition IS NULL)
      OR (state='runner-terminal-observed' AND runner_outcome_kind='process-terminal'
        AND runner_process_instance_sha256 IS NOT NULL AND runner_exit_disposition IS NOT NULL))
  ))
  AND (state IN ('runner-never-started-observed','runner-terminal-observed','stop-requested') OR
    num_nonnulls(runner_outcome_id,runner_outcome_request_id,runner_outcome_event_id,
      runner_outcome_kind,runner_outcome_accepted_at,runner_outcome_at,
      runner_outcome_evidence_observed_at,runner_outcome_evidence_ref,
      runner_outcome_evidence_sha256,runner_outcome_presented_token_sha256,
      runner_exit_disposition,runner_remote_stop_confirmed)=0)
  AND (state <> 'stop-requested' OR
    num_nonnulls(runner_outcome_id,runner_outcome_request_id,runner_outcome_event_id,
      runner_outcome_kind,runner_outcome_accepted_at,runner_outcome_at,
      runner_outcome_evidence_observed_at,runner_outcome_evidence_ref,
      runner_outcome_evidence_sha256,runner_outcome_presented_token_sha256,
      runner_remote_stop_confirmed) IN (0,11))
  AND (state <> 'stop-requested' OR runner_outcome_id IS NULL
    OR (runner_outcome_kind='never-started' AND runner_exit_disposition IS NULL))
);
ALTER TABLE swarm_authority_reservations DROP CONSTRAINT IF EXISTS swarm_authority_reservations_outcome_values_check;
ALTER TABLE swarm_authority_reservations ADD CONSTRAINT swarm_authority_reservations_outcome_values_check CHECK (
  (runner_fencing_generation IS NULL OR runner_fencing_generation >= 1)
  AND (runner_outcome_kind IS NULL OR runner_outcome_kind IN ('never-started','process-terminal'))
  AND (runner_exit_disposition IS NULL OR runner_exit_disposition IN
    ('exited-zero','exited-nonzero','signal','supervisor-killed','unknown'))
);
ALTER TABLE swarm_authority_reservations ADD CONSTRAINT swarm_authority_reservations_state_check
  CHECK (state IN ('reserved-not-started','consumed-not-started','leased-not-started','start-authorized-not-observed','runner-claimed-not-started','runner-start-observed','stop-requested','runner-never-started-observed','runner-terminal-observed','cancelled','expired'));
ALTER TABLE swarm_authority_audit DROP CONSTRAINT IF EXISTS swarm_authority_audit_event_check;
ALTER TABLE swarm_authority_audit ADD CONSTRAINT swarm_authority_audit_event_check
  CHECK (event IN ('admitted','reserved','denied','revoked','cancelled','consumed','consume-denied','start-lease-issued','start-lease-denied','start-authority-redeemed','start-redemption-denied','runner-claim-accepted','runner-claim-denied','runner-heartbeat-accepted','runner-heartbeat-denied','runner-start-observed','runner-start-denied','runner-outcome-observed','runner-outcome-denied','runner-usage-evidence-observed','runner-usage-evidence-denied','runner-usage-budget-breach','host-capacity-released','stop-requested','reservation-cancelled','expired','budget-window-registered','budget-window-denied','broker-principal-registered','broker-principal-disabled'));
${USAGE_AUTHORITY_ROUTINE_SQL}
`;

interface SqlResult { rows: Record<string, unknown>[]; rowCount?: number | null }
export interface AuthoritySqlClient {
  query(sql: string, values?: unknown[]): Promise<SqlResult>;
  release?(): void;
}
export interface AuthoritySqlPool { connect(): Promise<AuthoritySqlClient> }

export interface PostgresOperationAuthorityOptions {
  maxBrokerEvidenceAgeMs?: number;
  brokerSessionAttestor?: BrokerDatabaseSessionAttestor;
  maxRunnerEvidenceAgeMs?: number;
  minRunnerHeartbeatIntervalMs?: number;
  runnerSessionAttestor?: RunnerSessionAttestor;
  runnerStartEvidenceAttestor?: RunnerStartEvidenceAttestor;
  runnerOutcomeEvidenceAttestor?: RunnerOutcomeEvidenceAttestor;
  runnerUsageEvidenceAttestor?: RunnerUsageEvidenceAttestor;
  usageEvidencePool?: AuthoritySqlPool;
  usageEvidenceSessionAttestor?: UsageEvidenceDatabaseSessionAttestor;
}

// These ceilings are also enforced inside the function-only usage authority.
// Allowing a looser database routine than the configured store would let a
// direct routine caller bypass the public API's freshness policy.
export const BROKER_EVIDENCE_MAX_AGE_MS = 5 * 60_000;
export const RUNNER_EVIDENCE_MAX_AGE_MS = 60_000;

function denial(blocker: string): AdmissionResult {
  return { admitted: false, reservation: null, blockers: [blocker] };
}

function consumptionDenied(blocker: string): ConsumptionResult {
  return { consumed: false, receipt: null, blockers: [blocker] };
}

function startLeaseDenied(blocker: string): StartLeaseResult {
  return { leased: false, receipt: null, blockers: [blocker] };
}

function startRedemptionDenied(blocker: string): StartRedemptionResult {
  return { redeemed: false, receipt: null, blockers: [blocker] };
}

function runnerClaimDenied(blocker: string): RunnerClaimResult {
  return { claimed: false, receipt: null, blockers: [blocker] };
}

function runnerHeartbeatDenied(blocker: string): RunnerHeartbeatResult {
  return { accepted: false, receipt: null, blockers: [blocker] };
}

function runnerStartObservationDenied(blocker: string): RunnerStartObservationResult {
  return { observed: false, receipt: null, blockers: [blocker] };
}

function runnerOutcomeDenied(blocker: string): RunnerOutcomeResult {
  return { settled: false, receipt: null, blockers: [blocker] };
}

function runnerUsageEvidenceDenied(blocker: string): RunnerUsageEvidenceResult {
  return { recorded: false, receipt: null, blockers: [blocker] };
}

function cancellationDenied(
  reservationId: string,
  blocker: string,
  state: null | 'expired' | 'stop-requested' = null,
  alreadyTerminal = false,
): CancellationResult {
  return {
    cancelled: false,
    reservation_id: reservationId,
    state,
    already_terminal: alreadyTerminal,
    released_cost_usd: 0,
    blockers: [blocker],
  };
}

function sqlInstant(value: unknown): string {
  const parsed = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(parsed.getTime())) throw new Error('Database returned an invalid transaction timestamp.');
  return parsed.toISOString();
}

function canonicalUsd(value: unknown): string {
  const raw = String(value);
  const match = /^(0|[1-9][0-9]{0,7})(?:\.([0-9]{1,6}))?$/.exec(raw);
  if (!match) throw new Error('Database returned a non-canonical USD amount.');
  return `${match[1]}.${(match[2] ?? '').padEnd(6, '0')}`;
}

function hostEvidence(row: Record<string, unknown> | undefined): TrustedHostEvidence | null {
  const parsed = hostEvidenceSchema.safeParse(row?.evidence);
  return parsed.success ? parsed.data : null;
}

async function lockAuthority(client: AuthoritySqlClient): Promise<boolean> {
  const control = await client.query('SELECT starlight_authority_lock() AS locked');
  return control.rows.length === 1 && control.rows[0]?.locked === true;
}

async function wallClock(client: AuthoritySqlClient): Promise<string> {
  // Unlike transaction_timestamp()/NOW(), this advances while a transaction waits for a lock.
  const result = await client.query('SELECT clock_timestamp() AS now');
  return sqlInstant(result.rows[0]?.now);
}

/** PostgreSQL is the concurrency boundary; every mutable admission check runs in one transaction. */
export class PostgresOperationAuthorityStore implements OperationAuthorityStore {
  readonly durable = true;
  private readonly maxBrokerEvidenceAgeMs: number;
  private readonly brokerSessionAttestor: BrokerDatabaseSessionAttestor;
  private readonly maxRunnerEvidenceAgeMs: number;
  private readonly minRunnerHeartbeatIntervalMs: number;
  private readonly runnerSessionAttestor: RunnerSessionAttestor;
  private readonly runnerStartEvidenceAttestor: RunnerStartEvidenceAttestor;
  private readonly runnerOutcomeEvidenceAttestor: RunnerOutcomeEvidenceAttestor;
  private readonly runnerUsageEvidenceAttestor: RunnerUsageEvidenceAttestor;
  private readonly usageEvidencePool?: AuthoritySqlPool;
  private readonly usageEvidenceSessionAttestor: UsageEvidenceDatabaseSessionAttestor;

  constructor(
    private readonly pool: AuthoritySqlPool,
    options: PostgresOperationAuthorityOptions = {},
  ) {
    this.maxBrokerEvidenceAgeMs = options.maxBrokerEvidenceAgeMs ?? BROKER_EVIDENCE_MAX_AGE_MS;
    if (this.maxBrokerEvidenceAgeMs !== BROKER_EVIDENCE_MAX_AGE_MS) {
      throw new Error('Broker evidence age ceiling is fixed at five minutes by database authority policy.');
    }
    this.brokerSessionAttestor = options.brokerSessionAttestor ?? attestBrokerDatabaseSession;
    this.maxRunnerEvidenceAgeMs = options.maxRunnerEvidenceAgeMs ?? RUNNER_EVIDENCE_MAX_AGE_MS;
    if (this.maxRunnerEvidenceAgeMs !== RUNNER_EVIDENCE_MAX_AGE_MS) {
      throw new Error('Runner evidence age ceiling is fixed at one minute by database authority policy.');
    }
    this.minRunnerHeartbeatIntervalMs = options.minRunnerHeartbeatIntervalMs ?? 1_000;
    if (!Number.isInteger(this.minRunnerHeartbeatIntervalMs)
      || this.minRunnerHeartbeatIntervalMs < 1_000 || this.minRunnerHeartbeatIntervalMs > 60_000) {
      throw new Error('Runner heartbeat interval must be between 1 second and 1 minute.');
    }
    this.runnerSessionAttestor = options.runnerSessionAttestor ?? denyUnconfiguredRunnerSession;
    this.runnerStartEvidenceAttestor = options.runnerStartEvidenceAttestor ?? denyUnconfiguredRunnerStartEvidence;
    this.runnerOutcomeEvidenceAttestor = options.runnerOutcomeEvidenceAttestor ?? denyUnconfiguredRunnerOutcomeEvidence;
    this.runnerUsageEvidenceAttestor = options.runnerUsageEvidenceAttestor ?? denyUnconfiguredRunnerUsageEvidence;
    this.usageEvidencePool = options.usageEvidencePool;
    this.usageEvidenceSessionAttestor = options.usageEvidenceSessionAttestor ?? attestUsageEvidenceDatabaseSession;
  }

  async initialize(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(OPERATION_AUTHORITY_MIGRATION_SQL);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      await this.recordIntegrityRefusal(client, 'control-plane', '0'.repeat(64), {
        action: 'initialize', error: error instanceof Error ? error.message : 'unknown initialization failure',
      });
      throw error;
    } finally { client.release?.(); }
  }

  private async recordIntegrityRefusal(
    client: AuthoritySqlClient,
    operationId: string,
    bindingDigestSha256: string,
    detail: Record<string, unknown>,
  ): Promise<void> {
    try {
      await client.query('BEGIN');
      if (!await lockAuthority(client)) {
        await client.query('ROLLBACK');
        return;
      }
      await client.query(
        `INSERT INTO swarm_authority_audit (event,operation_id,binding_digest_sha256,at,detail)
         VALUES ('denied',$1,$2,$3::timestamptz,$4::jsonb)`,
        [operationId, bindingDigestSha256, await wallClock(client), JSON.stringify({ integrity_refusal: detail })],
      );
      await client.query('COMMIT');
    } catch {
      try { await client.query('ROLLBACK'); } catch { /* primary failure remains authoritative */ }
    }
  }

  /**
   * The broker transaction is deliberately released before the isolated
   * verifier runs. Refusals after that handoff still need a durable audit row,
   * written through a fresh broker transaction without exposing audit-table
   * authority to the verifier role.
   */
  private async recordRunnerUsageEvidenceRefusal(
    request: RunnerUsageEvidenceInput,
    blocker: string,
  ): Promise<void> {
    const auditClient = await this.pool.connect();
    try {
      await auditClient.query('BEGIN');
      await auditClient.query('SET LOCAL search_path = pg_catalog, public, pg_temp');
      if (!await lockAuthority(auditClient)) {
        await auditClient.query('ROLLBACK');
        return;
      }
      await auditClient.query(
        `INSERT INTO swarm_authority_audit (event,operation_id,binding_digest_sha256,at,detail)
         VALUES ('runner-usage-evidence-denied',$1,$2,$3::timestamptz,$4::jsonb)`,
        [request.operation_id, request.binding_digest_sha256, await wallClock(auditClient), JSON.stringify({
          reservation_id: request.reservation_id, claim_id: request.claim_id,
          outcome_id: request.outcome_id, usage_request_id: request.usage_request_id,
          usage_sequence: request.usage_sequence, blockers: [blocker], released_cost_usd: '0.000000',
          verifier_handoff_completed: true,
        })],
      );
      await auditClient.query('COMMIT');
    } catch {
      try { await auditClient.query('ROLLBACK'); } catch { /* the primary refusal remains authoritative */ }
    } finally { auditClient.release?.(); }
  }

  async putHostEvidence(evidence: TrustedHostEvidence): Promise<void> {
    const trusted = hostEvidenceSchema.parse(evidence);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (!await lockAuthority(client)) throw new Error('Authority serialization control row is missing or ambiguous.');
      const transactionAt = await wallClock(client);
      await client.query(
        `INSERT INTO swarm_authority_hosts (host_id,evidence,observed_at,capacity_slots,reserved_slots,authorized_slots)
         VALUES ($1,$2::jsonb,$3::timestamptz,$4,0,0)
         ON CONFLICT (host_id) DO UPDATE SET evidence=EXCLUDED.evidence,
         observed_at=EXCLUDED.observed_at, capacity_slots=EXCLUDED.capacity_slots`,
        [trusted.host_id, JSON.stringify(trusted), trusted.observed_at, trusted.capacity_slots],
      );
      const quarantined = await client.query(
        `UPDATE swarm_authority_reservations SET state='stop-requested'
         WHERE host_id=$1 AND state IN ('start-authorized-not-observed','runner-claimed-not-started','runner-start-observed')
           AND ($2 <> 'ready' OR $3::boolean=FALSE OR $4::timestamptz <= $5::timestamptz
             OR $4::timestamptz > $5::timestamptz+INTERVAL '1 minute'
             OR $5::timestamptz-$4::timestamptz > max_host_evidence_age_ms*INTERVAL '1 millisecond'
             OR NOT (binding->'capabilities' <@ $6::jsonb))
         RETURNING reservation_id,operation_id,binding_digest_sha256`,
        [trusted.host_id, trusted.status, trusted.secret_readiness, trusted.observed_at,
          transactionAt, JSON.stringify(trusted.allowed_capabilities)],
      );
      for (const row of quarantined.rows) {
        await client.query(
          `INSERT INTO swarm_authority_audit (event,operation_id,binding_digest_sha256,at,detail)
           VALUES ('stop-requested',$1,$2,$3::timestamptz,$4::jsonb)`,
          [row.operation_id, row.binding_digest_sha256, transactionAt, JSON.stringify({
            reservation_id: row.reservation_id, reason: 'host evidence became unavailable or drifted',
            host_id: trusted.host_id, execution_state: 'unknown', released_cost_usd: 0,
          })],
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release?.(); }
  }

  async putBrokerPrincipalEvidence(evidence: TrustedBrokerPrincipalEvidence): Promise<void> {
    const trusted = brokerPrincipalEvidenceSchema.parse(evidence);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (!await lockAuthority(client)) throw new Error('Authority serialization control row is missing or ambiguous.');
      const transactionAt = await wallClock(client);
      await client.query(
        `INSERT INTO swarm_authority_broker_principals
         (database_role,database_name,broker_execution_identity,broker_identity_evidence_ref,
          authn_kind,role_contract_digest_sha256,observed_at,access_review_expires_at,state,evidence)
         VALUES ($1,$2,$3,$4,$5,$6,$7::timestamptz,$8::timestamptz,$9,$10::jsonb)
         ON CONFLICT (database_role,database_name) DO UPDATE SET
           broker_execution_identity=EXCLUDED.broker_execution_identity,
           broker_identity_evidence_ref=EXCLUDED.broker_identity_evidence_ref,
           authn_kind=EXCLUDED.authn_kind,
           role_contract_digest_sha256=EXCLUDED.role_contract_digest_sha256,
           observed_at=EXCLUDED.observed_at,
           access_review_expires_at=EXCLUDED.access_review_expires_at,
           state=EXCLUDED.state,evidence=EXCLUDED.evidence`,
        [trusted.database_role, trusted.database_name, trusted.broker_execution_identity,
          trusted.broker_identity_evidence_ref, trusted.authn_kind, trusted.role_contract_digest_sha256,
          trusted.observed_at, trusted.access_review_expires_at, trusted.state, JSON.stringify(trusted)],
      );
      const quarantined = await client.query(
        `UPDATE swarm_authority_reservations SET state='stop-requested'
         WHERE broker_database_role=$1 AND broker_database_name=$2
           AND state IN ('start-authorized-not-observed','runner-claimed-not-started','runner-start-observed')
           AND ($3 <> 'ready' OR broker_execution_identity <> $4 OR broker_identity_evidence_ref <> $5
             OR broker_role_contract_sha256 <> $6)
         RETURNING reservation_id,operation_id,binding_digest_sha256`,
        [trusted.database_role, trusted.database_name, trusted.state, trusted.broker_execution_identity,
          trusted.broker_identity_evidence_ref, trusted.role_contract_digest_sha256],
      );
      for (const row of quarantined.rows) {
        await client.query(
          `INSERT INTO swarm_authority_audit (event,operation_id,binding_digest_sha256,at,detail)
           VALUES ('stop-requested',$1,$2,$3::timestamptz,$4::jsonb)`,
          [row.operation_id, row.binding_digest_sha256, transactionAt, JSON.stringify({
            reservation_id: row.reservation_id, reason: 'authenticated broker principal disabled or changed',
            database_role: trusted.database_role, execution_state: 'unknown', released_cost_usd: 0,
          })],
        );
      }
      await client.query(
        `INSERT INTO swarm_authority_audit (event,operation_id,binding_digest_sha256,at,detail)
         VALUES ($1,$2,$3,$4::timestamptz,$5::jsonb)`,
        [trusted.state === 'ready' ? 'broker-principal-registered' : 'broker-principal-disabled',
          `broker-principal:${trusted.database_role}`, sha256Digest(trusted), transactionAt,
          JSON.stringify({ ...trusted, registered_at: transactionAt })],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release?.(); }
  }

  async registerBudget(receiptId: string, hardLimitUsd: number): Promise<void> {
    controlId.parse(receiptId);
    z.number().finite().nonnegative().max(10_000).parse(hardLimitUsd);
    const client = await this.pool.connect();
    try {
      await client.query(
        `INSERT INTO swarm_authority_budgets (receipt_id,hard_limit_usd) VALUES ($1,$2)
         ON CONFLICT (receipt_id) DO NOTHING`,
        [receiptId, hardLimitUsd],
      );
    } finally { client.release?.(); }
  }

  async registerBudgetWindow(input: {
    window_id: string;
    policy_id: string;
    kind: 'policy' | 'daily';
    starts_at: string;
    ends_at: string;
    currency: 'USD';
    hard_limit_usd: number;
  }): Promise<BudgetWindowRegistrationResult> {
    const window = budgetWindowSchema.parse(input);
    const client = await this.pool.connect();
    const deny = async (registeredAt: string, blocker: string): Promise<BudgetWindowRegistrationResult> => {
      await client.query(
        `INSERT INTO swarm_authority_audit (event,operation_id,binding_digest_sha256,at,detail)
         VALUES ('budget-window-denied','control-plane',$1,$2::timestamptz,$3::jsonb)`,
        ['0'.repeat(64), registeredAt, JSON.stringify({
          window_id: window.window_id, policy_id: window.policy_id, kind: window.kind, blockers: [blocker],
        })],
      );
      await client.query('COMMIT');
      return { registered: false, already_registered: false, blockers: [blocker] };
    };
    try {
      await client.query('BEGIN');
      if (!await lockAuthority(client)) throw new Error('Authority serialization control row is missing or ambiguous.');
      const registeredAt = await wallClock(client);
      const sameId = await client.query(
        `SELECT window_id,policy_id,kind,starts_at,ends_at,currency,hard_limit_usd
         FROM swarm_authority_budget_windows WHERE window_id=$1 FOR UPDATE`,
        [window.window_id],
      );
      if (sameId.rows.length > 1) return await deny(registeredAt, 'Budget window identity is ambiguous.');
      if (sameId.rows.length === 1) {
        const existing = sameId.rows[0];
        if (existing.policy_id !== window.policy_id || existing.kind !== window.kind
          || sqlInstant(existing.starts_at) !== new Date(window.starts_at).toISOString()
          || sqlInstant(existing.ends_at) !== new Date(window.ends_at).toISOString()
          || existing.currency !== window.currency
          || Number(existing.hard_limit_usd) !== window.hard_limit_usd) {
          return await deny(registeredAt, 'Budget window identity is immutable once registered.');
        }
        await client.query('COMMIT');
        return { registered: true, already_registered: true, blockers: [] };
      }
      const overlap = await client.query(
        `SELECT window_id,policy_id,kind,starts_at,ends_at,currency,hard_limit_usd
         FROM swarm_authority_budget_windows
         WHERE policy_id=$1 AND kind=$2
           AND NOT (ends_at <= $3::timestamptz OR starts_at >= $4::timestamptz)
         FOR UPDATE`,
        [window.policy_id, window.kind, window.starts_at, window.ends_at],
      );
      if (overlap.rows.length > 0) {
        return await deny(registeredAt, 'Budget policy window overlaps an immutable registered window.');
      }
      await client.query(
        `INSERT INTO swarm_authority_budget_windows
         (window_id,policy_id,kind,starts_at,ends_at,currency,hard_limit_usd)
         VALUES ($1,$2,$3,$4::timestamptz,$5::timestamptz,$6,$7)`,
        [window.window_id, window.policy_id, window.kind, window.starts_at, window.ends_at,
          window.currency, window.hard_limit_usd],
      );
      await client.query(
        `INSERT INTO swarm_authority_audit (event,operation_id,binding_digest_sha256,at,detail)
         VALUES ('budget-window-registered','control-plane',$1,$2::timestamptz,$3::jsonb)`,
        ['0'.repeat(64), registeredAt, JSON.stringify(window)],
      );
      await client.query('COMMIT');
      return { registered: true, already_registered: false, blockers: [] };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release?.(); }
  }

  async putPreparedOperation(operationId: string, bindingDigestSha256: string, registeredAt: string): Promise<void> {
    controlId.parse(operationId);
    z.string().regex(/^[a-f0-9]{64}$/).parse(bindingDigestSha256);
    controlTime.parse(registeredAt);
    const client = await this.pool.connect();
    try {
      await client.query(
        `INSERT INTO swarm_authority_prepared_operations
         (operation_id,binding_digest_sha256,registered_at,state) VALUES ($1,$2,$3::timestamptz,'ready')
         ON CONFLICT (operation_id) DO NOTHING`,
        [operationId, bindingDigestSha256, registeredAt],
      );
    } finally { client.release?.(); }
  }

  async cancelPreparedOperation(operationId: string): Promise<void> {
    controlId.parse(operationId);
    const client = await this.pool.connect();
    let bindingDigest = '0'.repeat(64);
    try {
      await client.query('BEGIN');
      if (!await lockAuthority(client)) throw new Error('Authority serialization control row is missing or ambiguous.');
      const transactionAt = await wallClock(client);
      const prepared = await client.query(
        'SELECT binding_digest_sha256 FROM swarm_authority_prepared_operations WHERE operation_id=$1 FOR UPDATE',
        [operationId],
      );
      if (!prepared.rows[0]) throw new Error('Prepared operation does not exist.');
      bindingDigest = String(prepared.rows[0].binding_digest_sha256);
      await client.query(
        `UPDATE swarm_authority_prepared_operations SET state='cancelled' WHERE operation_id=$1`,
        [operationId],
      );
      const affected = await client.query(
        `SELECT reservation_id,operation_id,binding_digest_sha256,binding,budget_receipt_id,host_id,reserved_cost_usd,state,lease_id,
                (reserved_cost_usd IS NOT DISTINCT FROM (binding->>'requested_cost_usd')::numeric) AS cost_matches_binding
         FROM swarm_authority_reservations
         WHERE operation_id=$1 AND state IN ('reserved-not-started','consumed-not-started','leased-not-started')
         FOR UPDATE`,
        [operationId],
      );
      for (const row of affected.rows) {
        const transitioned = await client.query(
          `UPDATE swarm_authority_reservations SET state='cancelled'
           WHERE reservation_id=$1::uuid AND state IN ('reserved-not-started','consumed-not-started','leased-not-started')
           RETURNING reservation_id`,
          [row.reservation_id],
        );
        if (transitioned.rows.length !== 1) throw new Error('Prepared-operation cancellation lost its authority race.');
        const released = await this.releaseResources(client, row);
        await client.query(
          `INSERT INTO swarm_authority_audit (event,operation_id,binding_digest_sha256,at,detail)
           VALUES ('reservation-cancelled',$1,$2,$3::timestamptz,$4::jsonb)`,
          [operationId, row.binding_digest_sha256, transactionAt, JSON.stringify({
            reservation_id: row.reservation_id, lease_id: row.lease_id ?? null,
            reason: 'prepared operation cancelled before runner connection', released_cost_usd: released,
          })],
        );
      }
      const authorized = await client.query(
        `UPDATE swarm_authority_reservations SET state='stop-requested'
         WHERE operation_id=$1 AND state IN ('start-authorized-not-observed','runner-claimed-not-started','runner-start-observed')
         RETURNING reservation_id,binding_digest_sha256`,
        [operationId],
      );
      for (const row of authorized.rows) {
        await client.query(
          `INSERT INTO swarm_authority_audit (event,operation_id,binding_digest_sha256,at,detail)
           VALUES ('stop-requested',$1,$2,$3::timestamptz,$4::jsonb)`,
          [operationId, row.binding_digest_sha256, transactionAt, JSON.stringify({
            reservation_id: row.reservation_id, reason: 'prepared operation cancelled after start authorization',
            execution_state: 'unknown', released_cost_usd: 0,
          })],
        );
      }
      await client.query(
        `INSERT INTO swarm_authority_audit (event,operation_id,binding_digest_sha256,at,detail)
         VALUES ('cancelled',$1,$2,$3::timestamptz,$4::jsonb)`,
        [operationId, bindingDigest, transactionAt, JSON.stringify({ reason: 'control-plane cancellation' })],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      await this.recordIntegrityRefusal(client, operationId, bindingDigest, {
        action: 'cancel-prepared-operation', error: error instanceof Error ? error.message : 'unknown preparation cancellation failure',
      });
      throw error;
    } finally { client.release?.(); }
  }

  async revoke(ref: string, at: string, reason: string): Promise<void> {
    z.string().min(5).max(500).parse(ref);
    controlTime.parse(at);
    z.string().min(1).max(1_000).parse(reason);
    const client = await this.pool.connect();
    let affectedOperation = 'control-plane';
    let affectedDigest = '0'.repeat(64);
    try {
      await client.query('BEGIN');
      if (!await lockAuthority(client)) throw new Error('Authority serialization control row is missing or ambiguous.');
      const transactionAt = await wallClock(client);
      await client.query(
        `INSERT INTO swarm_authority_revocations (ref,revoked_at,reason) VALUES ($1,$2::timestamptz,$3)
         ON CONFLICT (ref) DO NOTHING`, [ref, transactionAt, reason],
      );
      const affected = await client.query(
        `SELECT reservation_id,operation_id,binding_digest_sha256,binding,budget_receipt_id,host_id,reserved_cost_usd,state,
                (reserved_cost_usd IS NOT DISTINCT FROM (binding->>'requested_cost_usd')::numeric) AS cost_matches_binding
         FROM swarm_authority_reservations
         WHERE state IN ('reserved-not-started','consumed-not-started','leased-not-started')
           AND revocation_refs @> jsonb_build_array($1::text)
         FOR UPDATE`,
        [ref],
      );
      for (const row of affected.rows) {
        affectedOperation = String(row.operation_id);
        affectedDigest = String(row.binding_digest_sha256);
        const transitioned = await client.query(
          `UPDATE swarm_authority_reservations SET state='cancelled'
           WHERE reservation_id=$1::uuid AND state IN ('reserved-not-started','consumed-not-started','leased-not-started')
           RETURNING reservation_id`,
          [row.reservation_id],
        );
        if (transitioned.rows.length !== 1) throw new Error('Revocation cancellation lost its authority race.');
        const released = await this.releaseResources(client, row);
        await client.query(
          `INSERT INTO swarm_authority_audit (event,operation_id,binding_digest_sha256,at,detail)
           VALUES ('reservation-cancelled',$1,$2,$3::timestamptz,$4::jsonb)`,
          [row.operation_id, row.binding_digest_sha256, transactionAt, JSON.stringify({ reservation_id: row.reservation_id, reason: 'authority revoked', revocation_ref: ref, released_cost_usd: released })],
        );
      }
      const authorized = await client.query(
        `UPDATE swarm_authority_reservations SET state='stop-requested'
         WHERE state IN ('start-authorized-not-observed','runner-claimed-not-started','runner-start-observed')
           AND (revocation_refs @> jsonb_build_array($1::text)
             OR runner_revocation_refs @> jsonb_build_array($1::text)
             OR $1='runner:'||runner_id
             OR $1='runner-instance:'||runner_instance_id
             OR $1='identity:'||runner_identity_evidence_ref
             OR $1='channel:'||runner_channel_binding_sha256)
         RETURNING reservation_id,operation_id,binding_digest_sha256`,
        [ref],
      );
      for (const row of authorized.rows) {
        await client.query(
          `INSERT INTO swarm_authority_audit (event,operation_id,binding_digest_sha256,at,detail)
           VALUES ('stop-requested',$1,$2,$3::timestamptz,$4::jsonb)`,
          [row.operation_id, row.binding_digest_sha256, transactionAt, JSON.stringify({
            reservation_id: row.reservation_id, reason: 'authority revoked after start authorization',
            revocation_ref: ref, execution_state: 'unknown', released_cost_usd: 0,
          })],
        );
      }
      await client.query(
        `INSERT INTO swarm_authority_audit (event,operation_id,binding_digest_sha256,at,detail)
         VALUES ('revoked','control-plane',$1,$2::timestamptz,$3::jsonb)`,
        ['0'.repeat(64), transactionAt, JSON.stringify({ ref, requested_at: at, reason })],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      await this.recordIntegrityRefusal(client, affectedOperation, affectedDigest, {
        action: 'revoke', ref, error: error instanceof Error ? error.message : 'unknown revocation failure',
      });
      throw error;
    } finally { client.release?.(); }
  }

  async recordDenial(bindingDigest: string, operationId: string, at: string, blockers: string[]): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(
        `INSERT INTO swarm_authority_audit (event,operation_id,binding_digest_sha256,at,detail)
         VALUES ('denied',$1,$2,$3::timestamptz,$4::jsonb)`,
        [operationId, bindingDigest, at, JSON.stringify({ blockers })],
      );
    } finally { client.release?.(); }
  }

  private async readBudgetWindows(
    client: AuthoritySqlClient,
    reservationId: string,
    expectedPolicyId: string,
    expectedCost: number,
  ): Promise<BudgetWindowEvidence[] | null> {
    const result = await client.query(
      `SELECT w.window_id,w.policy_id,w.kind,w.starts_at,w.ends_at,w.currency,
              (h.reserved_cost_usd IS NOT DISTINCT FROM $2::numeric) AS hold_cost_matches,
              (w.reserved_usd IS NOT DISTINCT FROM (SELECT COALESCE(SUM(h2.reserved_cost_usd),0)
               FROM swarm_authority_budget_holds h2
               JOIN swarm_authority_reservations r2 ON r2.reservation_id=h2.reservation_id
               WHERE h2.window_id=w.window_id
                 AND r2.state IN ('reserved-not-started','consumed-not-started','leased-not-started'))) AS ledger_reconciles,
              (w.committed_usd IS NOT DISTINCT FROM (SELECT COALESCE(SUM(h3.reserved_cost_usd),0)
               FROM swarm_authority_budget_holds h3
               JOIN swarm_authority_reservations r3 ON r3.reservation_id=h3.reservation_id
               WHERE h3.window_id=w.window_id
                 AND r3.state IN ('start-authorized-not-observed','runner-claimed-not-started','runner-start-observed','stop-requested','runner-never-started-observed','runner-terminal-observed'))) AS committed_reconciles
       FROM swarm_authority_budget_holds h JOIN swarm_authority_budget_windows w ON w.window_id=h.window_id
       WHERE h.reservation_id=$1::uuid ORDER BY w.kind`,
      [reservationId, expectedCost],
    );
    const kinds = new Set(result.rows.map((row) => row.kind));
    if (result.rows.length !== 2
      || kinds.size !== 2 || !kinds.has('policy') || !kinds.has('daily')
      || result.rows.some((row) => row.policy_id !== expectedPolicyId
        || row.currency !== 'USD' || row.hold_cost_matches !== true
        || row.ledger_reconciles !== true || row.committed_reconciles !== true)) return null;
    try {
      return result.rows.map((row) => ({
        window_id: String(row.window_id),
        kind: row.kind as 'policy' | 'daily',
        starts_at: sqlInstant(row.starts_at),
        ends_at: sqlInstant(row.ends_at),
        currency: 'USD',
      }));
    } catch { return null; }
  }

  private async releaseResources(
    client: AuthoritySqlClient,
    row: Record<string, unknown>,
  ): Promise<number> {
    const binding = operationBindingSchema.safeParse(row.binding);
    if (!binding.success || sha256Digest(binding.data) !== row.binding_digest_sha256
      || row.cost_matches_binding !== true) {
      throw new Error('Reservation binding is invalid or digest-drifted during resource release.');
    }
    const cost = binding.data.requested_cost_usd;
    const durableCost = row.reserved_cost_usd;
    const budget = await client.query(
      `UPDATE swarm_authority_budgets SET reserved_usd=reserved_usd-$2::numeric
       WHERE receipt_id=$1 AND reserved_usd >= $2::numeric RETURNING reserved_usd`,
      [row.budget_receipt_id, durableCost],
    );
    if (budget.rows.length !== 1) throw new Error('Budget release would underflow or references a missing receipt.');
    const holds = await client.query(
      `SELECT h.window_id,w.policy_id,w.kind,w.currency,
              (h.reserved_cost_usd IS NOT DISTINCT FROM $2::numeric) AS hold_cost_matches,
              (w.reserved_usd IS NOT DISTINCT FROM ((SELECT COALESCE(SUM(h2.reserved_cost_usd),0)
               FROM swarm_authority_budget_holds h2
               JOIN swarm_authority_reservations r2 ON r2.reservation_id=h2.reservation_id
               WHERE h2.window_id=w.window_id
                 AND r2.state IN ('reserved-not-started','consumed-not-started','leased-not-started')) + $2::numeric)) AS ledger_reconciles
       FROM swarm_authority_budget_holds h
       JOIN swarm_authority_budget_windows w ON w.window_id=h.window_id
       WHERE h.reservation_id=$1::uuid ORDER BY w.kind FOR UPDATE`,
      [row.reservation_id, durableCost],
    );
    const kinds = new Set(holds.rows.map((hold) => hold.kind));
    if (holds.rows.length !== 2 || kinds.size !== 2 || !kinds.has('policy') || !kinds.has('daily')
      || holds.rows.some((hold) => hold.hold_cost_matches !== true
        || hold.policy_id !== binding.data.budget_policy_id || hold.currency !== 'USD'
        || hold.ledger_reconciles !== true)) {
      throw new Error('Aggregate budget holds are missing, ambiguous, or inconsistent.');
    }
    for (const hold of holds.rows) {
      const aggregate = await client.query(
        `UPDATE swarm_authority_budget_windows SET reserved_usd=reserved_usd-$2::numeric
         WHERE window_id=$1 AND reserved_usd >= $2::numeric RETURNING reserved_usd`,
        [hold.window_id, durableCost],
      );
      if (aggregate.rows.length !== 1) throw new Error('Aggregate budget release would underflow or references a missing window.');
    }
    const host = await client.query(
      `UPDATE swarm_authority_hosts SET reserved_slots=reserved_slots-1
       WHERE host_id=$1 AND reserved_slots >= 1 RETURNING reserved_slots`,
      [row.host_id],
    );
    if (host.rows.length !== 1) throw new Error('Host capacity release would underflow or references a missing host.');
    return cost;
  }

  async consume(input: ConsumptionInput): Promise<ConsumptionResult> {
    const parsed = consumptionInputSchema.safeParse(input);
    if (!parsed.success) return consumptionDenied('Consumption request is invalid.');
    const request = parsed.data;
    const client = await this.pool.connect();
    let at = new Date().toISOString();
    const deny = async (blocker: string) => {
      await client.query(
        `INSERT INTO swarm_authority_audit (event,operation_id,binding_digest_sha256,at,detail)
         VALUES ('consume-denied',$1,$2,$3::timestamptz,$4::jsonb)`,
        [request.operation_id, request.binding_digest_sha256, at, JSON.stringify({ reservation_id: request.reservation_id, blockers: [blocker] })],
      );
      await client.query('COMMIT');
      return consumptionDenied(blocker);
    };
    try {
      await client.query('BEGIN');
      // Explicit pg_temp placement prevents PostgreSQL's implicit temp-first
      // lookup from shadowing unqualified authority relations in this transaction.
      await client.query('SET LOCAL search_path = pg_catalog, public, pg_temp');
      if (!await lockAuthority(client)) return await deny('Authority serialization control row is missing or ambiguous.');
      at = await wallClock(client);
      const nowMs = Date.parse(at);
      const found = await client.query(
        `SELECT reservation_id,operation_id,effect_id,binding_digest_sha256,binding,revocation_refs,
                approval_receipt_id,budget_receipt_id,host_id,reserved_cost_usd,
                (reserved_cost_usd IS NOT DISTINCT FROM (binding->>'requested_cost_usd')::numeric) AS cost_matches_binding,
                reservation_expires_at,max_host_evidence_age_ms,state,consumption_id,consumed_at,
                consume_token_sha256,cancel_token_sha256,lease_claim_token_sha256
         FROM swarm_authority_reservations
         WHERE reservation_id=$1::uuid AND consume_token_sha256=$2 FOR UPDATE`,
        [request.reservation_id, createHash('sha256').update(request.consume_token, 'utf8').digest('hex')],
      );
      const row = found.rows[0];
      if (!row) return await deny('Reservation does not exist.');
      if (row.operation_id !== request.operation_id || row.effect_id !== request.effect_id || row.binding_digest_sha256 !== request.binding_digest_sha256) {
        return await deny('Consumption request does not match the reserved operation and effect.');
      }
      const leaseClaimDigest = createHash('sha256').update(request.lease_claim_token, 'utf8').digest('hex');
      if (leaseClaimDigest === row.consume_token_sha256 || leaseClaimDigest === row.cancel_token_sha256) {
        return await deny('Consume, cancel, and lease-claim credentials must be distinct.');
      }
      const binding = operationBindingSchema.safeParse(row.binding);
      if (!binding.success || sha256Digest(binding.data) !== row.binding_digest_sha256
        || row.cost_matches_binding !== true) {
        return await deny('Stored reservation binding or signed cost is invalid.');
      }
      if (binding.data.execution_identity !== request.execution_identity || binding.data.identity_evidence_ref !== request.identity_evidence_ref) {
        return await deny('Consumption identity does not match the reserved binding.');
      }
      if (row.state === 'cancelled' || row.state === 'expired') return await deny(`Reservation is ${row.state}.`);
      if (row.state !== 'reserved-not-started' && row.state !== 'consumed-not-started') return await deny('Reservation state is invalid.');
      const heldWindows = await this.readBudgetWindows(
        client, request.reservation_id, binding.data.budget_policy_id, binding.data.requested_cost_usd,
      );
      if (!heldWindows) return await deny('Aggregate budget holds are missing, ambiguous, or inconsistent.');

      if (Date.parse(String(row.reservation_expires_at)) <= nowMs) {
        const expired = await client.query(
          "UPDATE swarm_authority_reservations SET state='expired' WHERE reservation_id=$1::uuid AND state IN ('reserved-not-started','consumed-not-started') RETURNING reservation_id",
          [request.reservation_id],
        );
        if (expired.rows.length !== 1) return await deny('Reservation expiry transition lost its authority race.');
        const released = await this.releaseResources(client, row);
        await client.query(
          `INSERT INTO swarm_authority_audit (event,operation_id,binding_digest_sha256,at,detail)
           VALUES ('expired',$1,$2,$3::timestamptz,$4::jsonb)`,
          [request.operation_id, request.binding_digest_sha256, at, JSON.stringify({ reservation_id: request.reservation_id, reason: 'expired before consumption', released_cost_usd: released })],
        );
        await client.query('COMMIT');
        return consumptionDenied('Reservation expired before consumption.');
      }

      const refs = revocationRefsSchema.safeParse(row.revocation_refs);
      if (!refs.success) return await deny('Stored revocation binding is invalid.');
      const revoked = await client.query(
        'SELECT ref FROM swarm_authority_revocations WHERE ref = ANY($1::text[]) LIMIT 1',
        [refs.data],
      );
      if (revoked.rows.length) {
        const cancelled = await client.query(
          "UPDATE swarm_authority_reservations SET state='cancelled' WHERE reservation_id=$1::uuid AND state IN ('reserved-not-started','consumed-not-started') RETURNING reservation_id",
          [request.reservation_id],
        );
        if (cancelled.rows.length !== 1) return await deny('Revocation cancellation lost its authority race.');
        const released = await this.releaseResources(client, row);
        await client.query(
          `INSERT INTO swarm_authority_audit (event,operation_id,binding_digest_sha256,at,detail)
           VALUES ('reservation-cancelled',$1,$2,$3::timestamptz,$4::jsonb)`,
          [request.operation_id, request.binding_digest_sha256, at, JSON.stringify({ reservation_id: request.reservation_id, reason: 'authority revoked', released_cost_usd: released })],
        );
        await client.query('COMMIT');
        return consumptionDenied('Reservation authority was revoked before consumption.');
      }

      const prepared = await client.query(
        'SELECT binding_digest_sha256,state FROM swarm_authority_prepared_operations WHERE operation_id=$1 FOR UPDATE',
        [request.operation_id],
      );
      if (prepared.rows[0]?.state === 'cancelled' && prepared.rows[0]?.binding_digest_sha256 === request.binding_digest_sha256) {
        const cancelled = await client.query(
          "UPDATE swarm_authority_reservations SET state='cancelled' WHERE reservation_id=$1::uuid AND state IN ('reserved-not-started','consumed-not-started') RETURNING reservation_id",
          [request.reservation_id],
        );
        if (cancelled.rows.length !== 1) return await deny('Prepared-operation cancellation lost its authority race.');
        const released = await this.releaseResources(client, row);
        await client.query(
          `INSERT INTO swarm_authority_audit (event,operation_id,binding_digest_sha256,at,detail)
           VALUES ('reservation-cancelled',$1,$2,$3::timestamptz,$4::jsonb)`,
          [request.operation_id, request.binding_digest_sha256, at, JSON.stringify({ reservation_id: request.reservation_id, reason: 'prepared operation cancelled', released_cost_usd: released })],
        );
        await client.query('COMMIT');
        return consumptionDenied('Prepared operation was cancelled before worker start.');
      }
      if (prepared.rows[0]?.state !== 'ready' || prepared.rows[0]?.binding_digest_sha256 !== request.binding_digest_sha256) {
        return await deny('Prepared operation is unavailable or drifted.');
      }

      if (row.state === 'consumed-not-started') {
        if (typeof row.consumption_id !== 'string' || !row.consumption_id || !row.consumed_at) {
          return await deny('Stored consumption receipt is incomplete.');
        }
        if (!row.lease_claim_token_sha256) {
          return await deny('Stored consumption is not bound to a lease-claim credential.');
        }
        if (row.lease_claim_token_sha256 !== leaseClaimDigest) {
          return await deny('Consumption retry changed the lease-claim credential.');
        }
        const receipt: ConsumptionReceipt = {
          schema_version: 'starlight.operation_consumption.v1',
          consumption_id: row.consumption_id,
          reservation_id: request.reservation_id,
          operation_id: request.operation_id,
          effect_id: request.effect_id,
          binding_digest_sha256: request.binding_digest_sha256,
          execution_identity: request.execution_identity,
          identity_evidence_ref: request.identity_evidence_ref,
          budget_policy_id: binding.data.budget_policy_id,
          budget_windows: heldWindows,
          lease_claim_token_sha256: leaseClaimDigest,
          consumed_at: sqlInstant(row.consumed_at),
          consumption_expires_at: sqlInstant(row.reservation_expires_at),
          state: 'consumed-not-started',
        };
        await client.query('COMMIT');
        return { consumed: true, receipt, blockers: [] };
      }

      const hostRow = await client.query(
        'SELECT evidence,capacity_slots,reserved_slots,authorized_slots FROM swarm_authority_hosts WHERE host_id=$1 FOR UPDATE',
        [row.host_id],
      );
      const host = hostEvidence(hostRow.rows[0]);
      const capacity = Number(hostRow.rows[0]?.capacity_slots);
      const reserved = Number(hostRow.rows[0]?.reserved_slots);
      const authorized = Number(hostRow.rows[0]?.authorized_slots);
      const maxAge = Number(row.max_host_evidence_age_ms);
      if (!host || host.host_id !== row.host_id || host.status !== 'ready' || !host.secret_readiness) {
        return await deny('Trusted host is unavailable at consumption time.');
      }
      if (host.capacity_slots !== capacity) return await deny('Trusted host capacity evidence and ledger differ.');
      if (nowMs - Date.parse(host.observed_at) > maxAge || Date.parse(host.observed_at) > nowMs + 60_000) {
        return await deny('Trusted host evidence is stale or from the future at consumption time.');
      }
      if (Date.parse(host.access_review_expires_at) <= nowMs) return await deny('Trusted host access review is expired at consumption time.');
      if (!Number.isSafeInteger(capacity) || !Number.isSafeInteger(reserved) || !Number.isSafeInteger(authorized)
        || reserved < 1 || authorized < 0 || capacity < reserved + authorized) {
        return await deny('Trusted host capacity ledger cannot honor the reservation.');
      }
      const hostCaps = new Set(host.allowed_capabilities);
      if (binding.data.capabilities.some((item) => !hostCaps.has(item))) return await deny('Trusted host no longer allows every reserved capability.');

      const receipt: ConsumptionReceipt = {
        schema_version: 'starlight.operation_consumption.v1',
        consumption_id: randomUUID(),
        reservation_id: request.reservation_id,
        operation_id: request.operation_id,
        effect_id: request.effect_id,
        binding_digest_sha256: request.binding_digest_sha256,
        execution_identity: request.execution_identity,
        identity_evidence_ref: request.identity_evidence_ref,
        budget_policy_id: binding.data.budget_policy_id,
        budget_windows: heldWindows,
          lease_claim_token_sha256: leaseClaimDigest,
        consumed_at: at,
        consumption_expires_at: sqlInstant(row.reservation_expires_at),
        state: 'consumed-not-started',
      };
      const consumed = await client.query(
        `UPDATE swarm_authority_reservations
         SET state='consumed-not-started',consumption_id=$2::uuid,consumed_at=$3::timestamptz,
             lease_claim_token_sha256=$4
         WHERE reservation_id=$1::uuid AND state='reserved-not-started' RETURNING reservation_id`,
        [request.reservation_id, receipt.consumption_id, at, receipt.lease_claim_token_sha256],
      );
      if (consumed.rows.length !== 1) return await deny('Reservation could not be consumed exactly once.');
      await client.query(
        `INSERT INTO swarm_authority_audit (event,operation_id,binding_digest_sha256,at,detail)
         VALUES ('consumed',$1,$2,$3::timestamptz,$4::jsonb)`,
        [request.operation_id, request.binding_digest_sha256, at, JSON.stringify(receipt)],
      );
      await client.query('COMMIT');
      return { consumed: true, receipt, blockers: [] };
    } catch (error) {
      await client.query('ROLLBACK');
      await this.recordIntegrityRefusal(client, request.operation_id, request.binding_digest_sha256, {
        action: 'consume', reservation_id: request.reservation_id,
        error: error instanceof Error ? error.message : 'unknown consumption failure',
      });
      throw error;
    } finally { client.release?.(); }
  }

  async leaseStart(input: StartLeaseInput): Promise<StartLeaseResult> {
    const parsed = startLeaseInputSchema.safeParse(input);
    if (!parsed.success) return startLeaseDenied('Start-lease request is invalid.');
    const request = parsed.data;
    const client = await this.pool.connect();
    let at = new Date().toISOString();
    const deny = async (blocker: string) => {
      await client.query(
        `INSERT INTO swarm_authority_audit (event,operation_id,binding_digest_sha256,at,detail)
         VALUES ('start-lease-denied',$1,$2,$3::timestamptz,$4::jsonb)`,
        [request.operation_id, request.binding_digest_sha256, at, JSON.stringify({
          reservation_id: request.reservation_id, consumption_id: request.consumption_id,
          start_request_id: request.start_request_id, blockers: [blocker],
        })],
      );
      await client.query('COMMIT');
      return startLeaseDenied(blocker);
    };
    const receiptFrom = (row: Record<string, unknown>): StartLeaseReceipt => ({
      schema_version: 'starlight.worker_start_lease.v1',
      lease_id: String(row.lease_id),
      start_request_id: String(row.start_request_id),
      consumption_id: String(row.consumption_id),
      reservation_id: request.reservation_id,
      operation_id: request.operation_id,
      effect_id: request.effect_id,
      binding_digest_sha256: request.binding_digest_sha256,
      execution_identity: request.execution_identity,
      identity_evidence_ref: request.identity_evidence_ref,
      lease_claim_token_sha256: String(row.lease_claim_token_sha256),
      redemption_token_sha256: String(row.redemption_token_sha256),
      control_token_sha256: String(row.control_token_sha256),
      broker_execution_identity: String(row.broker_execution_identity),
      broker_identity_evidence_ref: String(row.broker_identity_evidence_ref),
      lease_issued_at: sqlInstant(row.lease_issued_at),
      lease_expires_at: sqlInstant(row.lease_expires_at),
      lease_duration_ms: Number(row.lease_duration_ms),
      dispatch_state: 'not-dispatched',
      runner_activation_authorized: false,
      state: 'leased-not-started',
    });
    try {
      await client.query('BEGIN');
      if (!await lockAuthority(client)) return await deny('Authority serialization control row is missing or ambiguous.');
      at = await wallClock(client);
      const nowMs = Date.parse(at);
      const found = await client.query(
        `SELECT reservation_id,operation_id,effect_id,binding_digest_sha256,binding,revocation_refs,
                budget_receipt_id,host_id,reserved_cost_usd,reservation_expires_at,max_host_evidence_age_ms,
                state,consumption_id,consumed_at,lease_id,start_request_id,lease_issued_at,lease_expires_at,lease_duration_ms,
                consume_token_sha256,cancel_token_sha256,lease_claim_token_sha256,redemption_token_sha256,control_token_sha256,
                broker_execution_identity,broker_identity_evidence_ref,
                (reserved_cost_usd IS NOT DISTINCT FROM (binding->>'requested_cost_usd')::numeric) AS cost_matches_binding
         FROM swarm_authority_reservations
         WHERE reservation_id=$1::uuid AND lease_claim_token_sha256=$2 FOR UPDATE`,
        [request.reservation_id, createHash('sha256').update(request.lease_claim_token, 'utf8').digest('hex')],
      );
      const row = found.rows[0];
      if (!row) return await deny('Reservation does not exist.');
      const redemptionDigest = createHash('sha256').update(request.redemption_token, 'utf8').digest('hex');
      const controlDigest = createHash('sha256').update(request.control_token, 'utf8').digest('hex');
      const leaseClaimDigest = createHash('sha256').update(request.lease_claim_token, 'utf8').digest('hex');
      if (new Set([
        String(row.consume_token_sha256), String(row.cancel_token_sha256),
        leaseClaimDigest, redemptionDigest, controlDigest,
      ]).size !== 5) {
        return await deny('Consume, cancel, lease-claim, redemption, and control credentials must be pairwise distinct.');
      }
      if (row.operation_id !== request.operation_id || row.effect_id !== request.effect_id
        || row.binding_digest_sha256 !== request.binding_digest_sha256 || row.consumption_id !== request.consumption_id) {
        return await deny('Start-lease request does not match the consumed operation.');
      }
      const binding = operationBindingSchema.safeParse(row.binding);
      if (!binding.success || sha256Digest(binding.data) !== row.binding_digest_sha256
        || row.cost_matches_binding !== true) {
        return await deny('Stored reservation binding or signed cost is invalid.');
      }
      if (binding.data.execution_identity !== request.execution_identity
        || binding.data.identity_evidence_ref !== request.identity_evidence_ref) {
        return await deny('Start-lease identity does not match the consumed binding.');
      }
      if (row.state === 'cancelled' || row.state === 'expired') return await deny(`Reservation is ${row.state}.`);
      if (row.state !== 'consumed-not-started' && row.state !== 'leased-not-started') {
        return await deny('A consumed-not-started reservation is required before a start lease.');
      }
      const heldWindows = await this.readBudgetWindows(
        client, request.reservation_id, binding.data.budget_policy_id, binding.data.requested_cost_usd,
      );
      if (!heldWindows) return await deny('Aggregate budget holds are missing, ambiguous, or inconsistent.');

      const reservationExpired = Date.parse(String(row.reservation_expires_at)) <= nowMs;
      const leaseExpired = row.state === 'leased-not-started' && Date.parse(String(row.lease_expires_at)) <= nowMs;
      if (reservationExpired || leaseExpired) {
        const expired = await client.query(
          `UPDATE swarm_authority_reservations SET state='expired'
           WHERE reservation_id=$1::uuid AND state IN ('consumed-not-started','leased-not-started') RETURNING reservation_id`,
          [request.reservation_id],
        );
        if (expired.rows.length !== 1) return await deny('Start-lease expiry transition lost its authority race.');
        const released = await this.releaseResources(client, row);
        await client.query(
          `INSERT INTO swarm_authority_audit (event,operation_id,binding_digest_sha256,at,detail)
           VALUES ('expired',$1,$2,$3::timestamptz,$4::jsonb)`,
          [request.operation_id, request.binding_digest_sha256, at, JSON.stringify({
            reservation_id: request.reservation_id,
            lease_id: row.lease_id ?? null,
            reason: leaseExpired ? 'start lease expired before runner connection' : 'reservation expired before start lease',
            released_cost_usd: released,
          })],
        );
        await client.query('COMMIT');
        return startLeaseDenied(leaseExpired ? 'Start lease expired before runner connection.' : 'Reservation expired before start lease.');
      }

      const refs = revocationRefsSchema.safeParse(row.revocation_refs);
      if (!refs.success) return await deny('Stored revocation binding is invalid.');
      const revoked = await client.query('SELECT ref FROM swarm_authority_revocations WHERE ref = ANY($1::text[]) LIMIT 1', [refs.data]);
      if (revoked.rows.length) {
        const cancelled = await client.query(
          `UPDATE swarm_authority_reservations SET state='cancelled'
           WHERE reservation_id=$1::uuid AND state IN ('consumed-not-started','leased-not-started') RETURNING reservation_id`,
          [request.reservation_id],
        );
        if (cancelled.rows.length !== 1) return await deny('Start-lease revocation race was lost.');
        const released = await this.releaseResources(client, row);
        await client.query(
          `INSERT INTO swarm_authority_audit (event,operation_id,binding_digest_sha256,at,detail)
           VALUES ('reservation-cancelled',$1,$2,$3::timestamptz,$4::jsonb)`,
          [request.operation_id, request.binding_digest_sha256, at, JSON.stringify({
            reservation_id: request.reservation_id, reason: 'authority revoked before runner connection',
            revocation_ref: revoked.rows[0].ref, released_cost_usd: released,
          })],
        );
        await client.query('COMMIT');
        return startLeaseDenied('Reservation authority was revoked before runner connection.');
      }

      const prepared = await client.query(
        'SELECT binding_digest_sha256,state FROM swarm_authority_prepared_operations WHERE operation_id=$1 FOR UPDATE',
        [request.operation_id],
      );
      if (prepared.rows[0]?.state !== 'ready' || prepared.rows[0]?.binding_digest_sha256 !== request.binding_digest_sha256) {
        const cancelled = await client.query(
          `UPDATE swarm_authority_reservations SET state='cancelled'
           WHERE reservation_id=$1::uuid AND state IN ('consumed-not-started','leased-not-started') RETURNING reservation_id`,
          [request.reservation_id],
        );
        if (cancelled.rows.length !== 1) return await deny('Prepared-operation cancellation race was lost.');
        const released = await this.releaseResources(client, row);
        await client.query(
          `INSERT INTO swarm_authority_audit (event,operation_id,binding_digest_sha256,at,detail)
           VALUES ('reservation-cancelled',$1,$2,$3::timestamptz,$4::jsonb)`,
          [request.operation_id, request.binding_digest_sha256, at, JSON.stringify({
            reservation_id: request.reservation_id, reason: 'prepared operation unavailable before runner connection',
            released_cost_usd: released,
          })],
        );
        await client.query('COMMIT');
        return startLeaseDenied('Prepared operation is unavailable before runner connection.');
      }

      const hostRow = await client.query(
        'SELECT evidence,capacity_slots,reserved_slots,authorized_slots FROM swarm_authority_hosts WHERE host_id=$1 FOR UPDATE',
        [row.host_id],
      );
      const host = hostEvidence(hostRow.rows[0]);
      const capacity = Number(hostRow.rows[0]?.capacity_slots);
      const reserved = Number(hostRow.rows[0]?.reserved_slots);
      const authorized = Number(hostRow.rows[0]?.authorized_slots);
      const maxAge = Number(row.max_host_evidence_age_ms);
      if (!host || host.host_id !== row.host_id || host.status !== 'ready' || !host.secret_readiness) {
        return await deny('Trusted host is unavailable at start-lease time.');
      }
      if (host.capacity_slots !== capacity) return await deny('Trusted host capacity evidence and ledger differ.');
      if (nowMs - Date.parse(host.observed_at) > maxAge || Date.parse(host.observed_at) > nowMs + 60_000) {
        return await deny('Trusted host evidence is stale or from the future at start-lease time.');
      }
      if (Date.parse(host.access_review_expires_at) <= nowMs) return await deny('Trusted host access review is expired at start-lease time.');
      if (!Number.isSafeInteger(capacity) || !Number.isSafeInteger(reserved) || !Number.isSafeInteger(authorized)
        || reserved < 1 || authorized < 0 || capacity < reserved + authorized) {
        return await deny('Trusted host capacity ledger cannot honor the start lease.');
      }
      const hostCaps = new Set(host.allowed_capabilities);
      if (binding.data.capabilities.some((item) => !hostCaps.has(item))) {
        return await deny('Trusted host no longer allows every leased capability.');
      }

      if (request.lease_duration_ms > binding.data.timeout_ms) {
        return await deny('Start lease duration exceeds the bound operation timeout.');
      }
      const leaseExpiresAt = new Date(nowMs + request.lease_duration_ms).toISOString();
      if (Date.parse(leaseExpiresAt) > Date.parse(String(row.reservation_expires_at))) {
        return await deny('Start lease would outlive its reservation.');
      }

      if (row.state === 'leased-not-started') {
        if (row.start_request_id !== request.start_request_id
          || Number(row.lease_duration_ms) !== request.lease_duration_ms
          || !row.lease_id || !row.lease_issued_at || !row.lease_expires_at
          || row.redemption_token_sha256 !== redemptionDigest
          || row.control_token_sha256 !== controlDigest
          || row.broker_execution_identity !== request.broker_execution_identity
          || row.broker_identity_evidence_ref !== request.broker_identity_evidence_ref) {
          return await deny('A different start lease was already issued for this reservation.');
        }
        const receipt = receiptFrom(row);
        await client.query('COMMIT');
        return { leased: true, receipt, blockers: [] };
      }

      const duplicateRequest = await client.query(
        'SELECT reservation_id FROM swarm_authority_reservations WHERE start_request_id=$1::uuid LIMIT 1',
        [request.start_request_id],
      );
      if (duplicateRequest.rows.length) return await deny('Start request id is already bound to another reservation.');
      const leaseId = randomUUID();
      const transitioned = await client.query(
        `UPDATE swarm_authority_reservations
         SET state='leased-not-started',lease_id=$2::uuid,start_request_id=$3::uuid,
             lease_issued_at=$4::timestamptz,lease_expires_at=$5::timestamptz,lease_duration_ms=$6,
             redemption_token_sha256=$7,control_token_sha256=$8,
             broker_execution_identity=$9,broker_identity_evidence_ref=$10
         WHERE reservation_id=$1::uuid AND state='consumed-not-started'
         RETURNING lease_id,start_request_id,consumption_id,lease_claim_token_sha256,
                   redemption_token_sha256,control_token_sha256,broker_execution_identity,broker_identity_evidence_ref,
                   lease_issued_at,lease_expires_at,lease_duration_ms`,
        [request.reservation_id, leaseId, request.start_request_id, at, leaseExpiresAt, request.lease_duration_ms,
          redemptionDigest, controlDigest, request.broker_execution_identity, request.broker_identity_evidence_ref],
      );
      if (transitioned.rows.length !== 1) return await deny('Start lease could not be issued exactly once.');
      const receipt = receiptFrom(transitioned.rows[0]);
      await client.query(
        `INSERT INTO swarm_authority_audit (event,operation_id,binding_digest_sha256,at,detail)
         VALUES ('start-lease-issued',$1,$2,$3::timestamptz,$4::jsonb)`,
        [request.operation_id, request.binding_digest_sha256, at, JSON.stringify(receipt)],
      );
      await client.query('COMMIT');
      return { leased: true, receipt, blockers: [] };
    } catch (error) {
      await client.query('ROLLBACK');
      await this.recordIntegrityRefusal(client, request.operation_id, request.binding_digest_sha256, {
        action: 'lease-start', reservation_id: request.reservation_id,
        error: error instanceof Error ? error.message : 'unknown start-lease failure',
      });
      throw error;
    } finally { client.release?.(); }
  }

  async redeemStartAuthorization(input: StartRedemptionInput): Promise<StartRedemptionResult> {
    const parsed = startRedemptionInputSchema.safeParse(input);
    if (!parsed.success) return startRedemptionDenied('Start-redemption request is invalid.');
    const request = parsed.data;
    const client = await this.pool.connect();
    let at = new Date().toISOString();
    const deny = async (blocker: string) => {
      await client.query(
        `INSERT INTO swarm_authority_audit (event,operation_id,binding_digest_sha256,at,detail)
         VALUES ('start-redemption-denied',$1,$2,$3::timestamptz,$4::jsonb)`,
        [request.operation_id, request.binding_digest_sha256, at, JSON.stringify({
          reservation_id: request.reservation_id, lease_id: request.lease_id,
          redemption_request_id: request.redemption_request_id, blockers: [blocker],
        })],
      );
      await client.query('COMMIT');
      return startRedemptionDenied(blocker);
    };
    const receiptFrom = (row: Record<string, unknown>): StartRedemptionReceipt => ({
      schema_version: 'starlight.worker_start_redemption.v1',
      redemption_id: String(row.redemption_id),
      redemption_request_id: String(row.redemption_request_id),
      lease_id: String(row.lease_id),
      consumption_id: String(row.consumption_id),
      reservation_id: request.reservation_id,
      operation_id: request.operation_id,
      effect_id: request.effect_id,
      binding_digest_sha256: request.binding_digest_sha256,
      execution_identity: request.execution_identity,
      identity_evidence_ref: request.identity_evidence_ref,
      broker_execution_identity: String(row.broker_execution_identity),
      broker_identity_evidence_ref: String(row.broker_identity_evidence_ref),
      broker_database_role: String(row.broker_database_role),
      broker_database_name: String(row.broker_database_name),
      broker_role_contract_sha256: String(row.broker_role_contract_sha256),
      redemption_token_sha256: String(row.redemption_token_sha256),
      control_token_sha256: String(row.control_token_sha256),
      start_authorized_at: sqlInstant(row.start_authorized_at),
      committed_cost_usd: Number(row.committed_cost_usd),
      authorization_state: 'start-authorized',
      execution_observed: false,
      state: 'start-authorized-not-observed',
    });
    try {
      await client.query('BEGIN');
      // Explicit pg_temp placement prevents PostgreSQL's implicit temp-first
      // lookup from shadowing unqualified authority relations in this transaction.
      await client.query('SET LOCAL search_path = pg_catalog, public, pg_temp');
      if (!await lockAuthority(client)) return await deny('Authority serialization control row is missing or ambiguous.');
      at = await wallClock(client);
      const nowMs = Date.parse(at);
      const sessionAttestation = await this.brokerSessionAttestor(client);
      if (!sessionAttestation.valid) {
        return await deny(`Broker database session is not authorized: ${sessionAttestation.blockers.join(' ')}`);
      }
      const brokerSession = sessionAttestation.session;
      const principalResult = await client.query(
        `SELECT database_role,database_name,broker_execution_identity,broker_identity_evidence_ref,
                authn_kind,role_contract_digest_sha256,observed_at,access_review_expires_at,state,evidence
         FROM swarm_authority_broker_principals
         WHERE database_role=$1 AND database_name=$2`,
        [brokerSession.database_role, brokerSession.database_name],
      );
      const principalRow = principalResult.rows[0];
      const parsedPrincipal = brokerPrincipalEvidenceSchema.safeParse(principalRow?.evidence);
      const redemptionDigest = createHash('sha256').update(request.redemption_token, 'utf8').digest('hex');
      const found = await client.query(
        `SELECT reservation_id,operation_id,effect_id,binding_digest_sha256,binding,revocation_refs,
                budget_receipt_id,host_id,reserved_cost_usd,reservation_expires_at,max_host_evidence_age_ms,
                state,consumption_id,lease_id,start_request_id,lease_expires_at,
                lease_claim_token_sha256,redemption_token_sha256,control_token_sha256,
                broker_execution_identity,broker_identity_evidence_ref,
                broker_database_role,broker_database_name,broker_role_contract_sha256,
                redemption_id,redemption_request_id,start_authorized_at,committed_cost_usd,
                (reserved_cost_usd IS NOT DISTINCT FROM (binding->>'requested_cost_usd')::numeric) AS cost_matches_binding
         FROM swarm_authority_reservations
         WHERE reservation_id=$1::uuid AND lease_id=$2::uuid AND redemption_token_sha256=$3 FOR UPDATE`,
        [request.reservation_id, request.lease_id, redemptionDigest],
      );
      const row = found.rows[0];
      if (!row) return await deny('Start lease does not exist or the redemption credential is invalid.');
      if (row.operation_id !== request.operation_id || row.effect_id !== request.effect_id
        || row.binding_digest_sha256 !== request.binding_digest_sha256) {
        return await deny('Start-redemption request does not match the leased operation.');
      }
      const authorizedState = row.state === 'start-authorized-not-observed' || row.state === 'runner-claimed-not-started' || row.state === 'runner-start-observed';
      const exactRequest = authorizedState && row.redemption_request_id === request.redemption_request_id;
      const quarantineRetry = async (reason: string, blocker: string): Promise<StartRedemptionResult> => {
        const stopped = await client.query(
          `UPDATE swarm_authority_reservations SET state='stop-requested'
           WHERE reservation_id=$1::uuid AND state IN ('start-authorized-not-observed','runner-claimed-not-started','runner-start-observed') RETURNING reservation_id`,
          [request.reservation_id],
        );
        if (stopped.rows.length !== 1) return await deny('Start-authorization quarantine lost its authority race.');
        await client.query(
          `INSERT INTO swarm_authority_audit (event,operation_id,binding_digest_sha256,at,detail)
           VALUES ('stop-requested',$1,$2,$3::timestamptz,$4::jsonb)`,
          [request.operation_id, request.binding_digest_sha256, at, JSON.stringify({
            reservation_id: request.reservation_id, lease_id: request.lease_id, reason,
            execution_state: 'unknown', released_cost_usd: 0,
          })],
        );
        await client.query('COMMIT');
        return startRedemptionDenied(blocker);
      };
      if (authorizedState && !exactRequest) {
        return await deny('A different redemption request already authorized this start lease.');
      }
      const principal = parsedPrincipal.success ? parsedPrincipal.data : null;
      const principalCurrent = principalResult.rows.length === 1 && principal !== null
        && principal.database_role === principalRow.database_role
        && principal.database_name === principalRow.database_name
        && principal.broker_execution_identity === principalRow.broker_execution_identity
        && principal.broker_identity_evidence_ref === principalRow.broker_identity_evidence_ref
        && principal.authn_kind === principalRow.authn_kind
        && principal.role_contract_digest_sha256 === principalRow.role_contract_digest_sha256
        && principal.role_contract_digest_sha256 === brokerSession.contract_digest_sha256
        && principal.state === principalRow.state && principal.state === 'ready'
        && sqlInstant(principal.observed_at) === sqlInstant(principalRow.observed_at)
        && sqlInstant(principal.access_review_expires_at) === sqlInstant(principalRow.access_review_expires_at)
        && Date.parse(principal.observed_at) <= nowMs + 60_000
        && nowMs - Date.parse(principal.observed_at) <= this.maxBrokerEvidenceAgeMs
        && Date.parse(principal.access_review_expires_at) > nowMs;
      if (!principalCurrent || !principal) {
        if (exactRequest) return await quarantineRetry(
          'authenticated broker principal unavailable or stale on authorization retry',
          'Authenticated broker principal is unavailable or stale on the authorization retry.',
        );
        return await deny('Authenticated broker principal is unavailable, stale, disabled, or drifted.');
      }
      const binding = operationBindingSchema.safeParse(row.binding);
      if (!binding.success || sha256Digest(binding.data) !== row.binding_digest_sha256 || row.cost_matches_binding !== true) {
        if (exactRequest) return await quarantineRetry(
          'stored binding or signed cost invalid on start-authorization retry',
          'Stored binding or signed cost is invalid on the authorization retry.',
        );
        return await deny('Stored reservation binding or signed cost is invalid.');
      }
      if (binding.data.execution_identity !== request.execution_identity
        || binding.data.identity_evidence_ref !== request.identity_evidence_ref) {
        return await deny('Start-redemption worker identity does not match the operation binding.');
      }
      if (row.broker_execution_identity !== principal.broker_execution_identity
        || row.broker_identity_evidence_ref !== principal.broker_identity_evidence_ref) {
        if (exactRequest) return await quarantineRetry(
          'authenticated broker identity drifted from the lease on authorization retry',
          'Authenticated broker identity drifted from the start lease on the authorization retry.',
        );
        return await deny('Authenticated broker identity does not match the start lease.');
      }
      if (exactRequest && (row.broker_database_role !== brokerSession.database_role
        || row.broker_database_name !== brokerSession.database_name
        || row.broker_role_contract_sha256 !== brokerSession.contract_digest_sha256)) {
        return await quarantineRetry(
          'stored broker database principal drifted on authorization retry',
          'Stored broker database principal drifted on the authorization retry.',
        );
      }
      if (row.host_id !== binding.data.host_id) {
        if (exactRequest) return await quarantineRetry(
          'stored host attribution drifted from signed binding on authorization retry',
          'Stored host attribution drifted from the signed binding on the authorization retry.',
        );
        return await deny('Stored host attribution does not match the signed operation binding.');
      }
      if (exactRequest) {
        if (!row.redemption_id || !row.start_authorized_at
          || Number(row.committed_cost_usd) !== binding.data.requested_cost_usd) {
          return await quarantineRetry(
            'stored redemption receipt invalid on start-authorization retry',
            'Stored redemption receipt is invalid on the authorization retry.',
          );
        }
      }
      if (!exactRequest && row.state !== 'leased-not-started') {
        return await deny(`Start lease cannot be redeemed from state ${String(row.state)}.`);
      }

      const heldWindows = await this.readBudgetWindows(
        client, request.reservation_id, binding.data.budget_policy_id, binding.data.requested_cost_usd,
      );
      if (!heldWindows) {
        if (exactRequest) return await quarantineRetry(
          'aggregate budget attribution invalid on authorization retry',
          'Start authorization is no longer current because aggregate budget attribution is invalid.',
        );
        return await deny('Aggregate budget holds are missing, ambiguous, or inconsistent.');
      }
      if (Date.parse(String(row.reservation_expires_at)) <= nowMs || Date.parse(String(row.lease_expires_at)) <= nowMs) {
        if (exactRequest) return await quarantineRetry(
          'lease or reservation expired after start authorization',
          'Start authorization expired before the retry.',
        );
        const expired = await client.query(
          `UPDATE swarm_authority_reservations SET state='expired'
           WHERE reservation_id=$1::uuid AND state='leased-not-started' RETURNING reservation_id`,
          [request.reservation_id],
        );
        if (expired.rows.length !== 1) return await deny('Start-redemption expiry transition lost its authority race.');
        const released = await this.releaseResources(client, row);
        await client.query(
          `INSERT INTO swarm_authority_audit (event,operation_id,binding_digest_sha256,at,detail)
           VALUES ('expired',$1,$2,$3::timestamptz,$4::jsonb)`,
          [request.operation_id, request.binding_digest_sha256, at, JSON.stringify({
            reservation_id: request.reservation_id, lease_id: request.lease_id,
            reason: 'lease or reservation expired before start authorization', released_cost_usd: released,
          })],
        );
        await client.query('COMMIT');
        return startRedemptionDenied('Start lease expired before authorization.');
      }
      const refs = revocationRefsSchema.safeParse(row.revocation_refs);
      if (!refs.success) {
        if (exactRequest) return await quarantineRetry(
          'stored revocation binding invalid on start-authorization retry',
          'Stored revocation binding is invalid on the authorization retry.',
        );
        return await deny('Stored revocation binding is invalid.');
      }
      const revoked = await client.query('SELECT ref FROM swarm_authority_revocations WHERE ref = ANY($1::text[]) LIMIT 1', [refs.data]);
      if (revoked.rows.length) {
        if (exactRequest) return await quarantineRetry(
          'authority revoked after start authorization',
          'Start authorization was revoked before the retry.',
        );
        const cancelled = await client.query(
          `UPDATE swarm_authority_reservations SET state='cancelled'
           WHERE reservation_id=$1::uuid AND state='leased-not-started' RETURNING reservation_id`,
          [request.reservation_id],
        );
        if (cancelled.rows.length !== 1) return await deny('Start-redemption revocation race was lost.');
        const released = await this.releaseResources(client, row);
        await client.query(
          `INSERT INTO swarm_authority_audit (event,operation_id,binding_digest_sha256,at,detail)
           VALUES ('reservation-cancelled',$1,$2,$3::timestamptz,$4::jsonb)`,
          [request.operation_id, request.binding_digest_sha256, at, JSON.stringify({
            reservation_id: request.reservation_id, lease_id: request.lease_id,
            reason: 'authority revoked before start authorization', revocation_ref: revoked.rows[0].ref,
            released_cost_usd: released,
          })],
        );
        await client.query('COMMIT');
        return startRedemptionDenied('Reservation authority was revoked before start authorization.');
      }
      const prepared = await client.query(
        'SELECT binding_digest_sha256,state FROM swarm_authority_prepared_operations WHERE operation_id=$1',
        [request.operation_id],
      );
      if (prepared.rows[0]?.state !== 'ready' || prepared.rows[0]?.binding_digest_sha256 !== request.binding_digest_sha256) {
        if (exactRequest) return await quarantineRetry(
          'prepared operation unavailable after start authorization',
          'Prepared operation is unavailable or drifted on the authorization retry.',
        );
        const cancelled = await client.query(
          `UPDATE swarm_authority_reservations SET state='cancelled'
           WHERE reservation_id=$1::uuid AND state='leased-not-started' RETURNING reservation_id`,
          [request.reservation_id],
        );
        if (cancelled.rows.length !== 1) return await deny('Prepared-operation cancellation race was lost.');
        const released = await this.releaseResources(client, row);
        await client.query(
          `INSERT INTO swarm_authority_audit (event,operation_id,binding_digest_sha256,at,detail)
           VALUES ('reservation-cancelled',$1,$2,$3::timestamptz,$4::jsonb)`,
          [request.operation_id, request.binding_digest_sha256, at, JSON.stringify({
            reservation_id: request.reservation_id, lease_id: request.lease_id,
            reason: 'prepared operation unavailable before start authorization', released_cost_usd: released,
          })],
        );
        await client.query('COMMIT');
        return startRedemptionDenied('Prepared operation is unavailable or drifted at start authorization.');
      }
      const hostRow = await client.query(
        `SELECT evidence,capacity_slots,reserved_slots,authorized_slots,
                (reserved_slots IS NOT DISTINCT FROM (SELECT COUNT(*)::integer FROM swarm_authority_reservations
                  WHERE host_id=$1 AND state IN ('reserved-not-started','consumed-not-started','leased-not-started'))) AS reserved_reconciles,
                (authorized_slots IS NOT DISTINCT FROM (SELECT COUNT(*)::integer FROM swarm_authority_reservations
                  WHERE host_id=$1 AND state IN ('start-authorized-not-observed','runner-claimed-not-started','runner-start-observed','stop-requested','runner-never-started-observed'))) AS authorized_reconciles
         FROM swarm_authority_hosts WHERE host_id=$1 FOR UPDATE`,
        [row.host_id],
      );
      const host = hostEvidence(hostRow.rows[0]);
      const capacity = Number(hostRow.rows[0]?.capacity_slots);
      const reserved = Number(hostRow.rows[0]?.reserved_slots);
      const authorized = Number(hostRow.rows[0]?.authorized_slots);
      const maxAge = Number(row.max_host_evidence_age_ms);
      if (!host || host.host_id !== row.host_id || host.status !== 'ready' || !host.secret_readiness) {
        if (exactRequest) return await quarantineRetry(
          'trusted host unavailable on start-authorization retry',
          'Trusted host is unavailable on the authorization retry.',
        );
        return await deny('Trusted host is unavailable at start-authorization time.');
      }
      if (host.capacity_slots !== capacity) {
        if (exactRequest) return await quarantineRetry(
          'trusted host capacity evidence drifted on start-authorization retry',
          'Trusted host capacity evidence and ledger differ on the authorization retry.',
        );
        return await deny('Trusted host capacity evidence and ledger differ.');
      }
      if (nowMs - Date.parse(host.observed_at) > maxAge || Date.parse(host.observed_at) > nowMs + 60_000) {
        if (exactRequest) return await quarantineRetry(
          'trusted host evidence stale on start-authorization retry',
          'Trusted host evidence is stale or from the future on the authorization retry.',
        );
        return await deny('Trusted host evidence is stale or from the future at start-authorization time.');
      }
      if (Date.parse(host.access_review_expires_at) <= nowMs) {
        if (exactRequest) return await quarantineRetry(
          'trusted host access review expired on start-authorization retry',
          'Trusted host access review expired before the authorization retry.',
        );
        return await deny('Trusted host access review is expired at start-authorization time.');
      }
      if (!Number.isSafeInteger(capacity) || !Number.isSafeInteger(reserved) || !Number.isSafeInteger(authorized)
        || reserved < 0 || authorized < 0 || reserved + authorized > capacity
        || hostRow.rows[0]?.reserved_reconciles !== true || hostRow.rows[0]?.authorized_reconciles !== true
        || (exactRequest ? authorized < 1 : reserved < 1)) {
        if (exactRequest) return await quarantineRetry(
          'trusted host authorization ledger invalid on retry',
          'Trusted host capacity ledger cannot honor the authorization retry.',
        );
        return await deny('Trusted host capacity ledger cannot honor start authorization.');
      }
      const hostCaps = new Set(host.allowed_capabilities);
      if (binding.data.capabilities.some((item) => !hostCaps.has(item))) {
        if (exactRequest) return await quarantineRetry(
          'trusted host capability grant changed on start-authorization retry',
          'Trusted host no longer allows every capability on the authorization retry.',
        );
        return await deny('Trusted host no longer allows every authorized capability.');
      }
      const budget = await client.query(
        `SELECT hard_limit_usd,reserved_usd,committed_usd,
                (reserved_usd >= $2::numeric) AS funds_reservation,
                (reserved_usd+committed_usd <= hard_limit_usd) AS within_ceiling,
                (reserved_usd IS NOT DISTINCT FROM (SELECT COALESCE(SUM(reserved_cost_usd),0)
                  FROM swarm_authority_reservations WHERE budget_receipt_id=$1
                    AND state IN ('reserved-not-started','consumed-not-started','leased-not-started'))) AS reserved_reconciles,
                (committed_usd IS NOT DISTINCT FROM (SELECT COALESCE(SUM(reserved_cost_usd),0)
                  FROM swarm_authority_reservations WHERE budget_receipt_id=$1
                    AND state IN ('start-authorized-not-observed','runner-claimed-not-started','runner-start-observed','stop-requested','runner-never-started-observed','runner-terminal-observed'))) AS committed_reconciles
         FROM swarm_authority_budgets WHERE receipt_id=$1 FOR UPDATE`,
        [row.budget_receipt_id, binding.data.requested_cost_usd],
      );
      if (budget.rows.length !== 1 || budget.rows[0].reserved_reconciles !== true
        || budget.rows[0].committed_reconciles !== true
        || (!exactRequest && budget.rows[0].funds_reservation !== true)
        || budget.rows[0].within_ceiling !== true) {
        if (exactRequest) return await quarantineRetry(
          'receipt budget ledger invalid on start-authorization retry',
          'Receipt budget ledger is invalid on the authorization retry.',
        );
        return await deny('Receipt budget ledgers are missing, exhausted, or inconsistent.');
      }
      if (exactRequest) {
        const receipt = receiptFrom(row);
        await client.query('COMMIT');
        return { redeemed: true, receipt, blockers: [] };
      }
      const duplicateRequest = await client.query(
        'SELECT reservation_id FROM swarm_authority_reservations WHERE redemption_request_id=$1::uuid LIMIT 1',
        [request.redemption_request_id],
      );
      if (duplicateRequest.rows.length) return await deny('Redemption request id is already bound to another reservation.');

      const redemptionId = randomUUID();
      const transitioned = await client.query(
        `UPDATE swarm_authority_reservations
         SET state='start-authorized-not-observed',redemption_id=$2::uuid,redemption_request_id=$3::uuid,
             start_authorized_at=$4::timestamptz,committed_cost_usd=reserved_cost_usd,
             broker_database_role=$5,broker_database_name=$6,broker_role_contract_sha256=$7
         WHERE reservation_id=$1::uuid AND state='leased-not-started'
         RETURNING *`,
        [request.reservation_id, redemptionId, request.redemption_request_id, at,
          brokerSession.database_role, brokerSession.database_name, brokerSession.contract_digest_sha256],
      );
      if (transitioned.rows.length !== 1) return await deny('Start lease could not be authorized exactly once.');
      const cost = binding.data.requested_cost_usd;
      const receiptBudget = await client.query(
        `UPDATE swarm_authority_budgets
         SET reserved_usd=reserved_usd-$2::numeric,committed_usd=committed_usd+$2::numeric
         WHERE receipt_id=$1 AND reserved_usd >= $2::numeric
           AND reserved_usd+committed_usd <= hard_limit_usd RETURNING receipt_id`,
        [row.budget_receipt_id, cost],
      );
      if (receiptBudget.rows.length !== 1) throw new Error('Receipt budget authorization move would underflow or exceed its ceiling.');
      for (const window of heldWindows) {
        const aggregate = await client.query(
          `UPDATE swarm_authority_budget_windows
           SET reserved_usd=reserved_usd-$2::numeric,committed_usd=committed_usd+$2::numeric
           WHERE window_id=$1 AND reserved_usd >= $2::numeric
             AND reserved_usd+committed_usd <= hard_limit_usd RETURNING window_id`,
          [window.window_id, cost],
        );
        if (aggregate.rows.length !== 1) throw new Error('Aggregate budget authorization move would underflow or exceed its ceiling.');
      }
      const hostMoved = await client.query(
        `UPDATE swarm_authority_hosts
         SET reserved_slots=reserved_slots-1,authorized_slots=authorized_slots+1
         WHERE host_id=$1 AND reserved_slots >= 1
           AND reserved_slots+authorized_slots <= capacity_slots RETURNING host_id`,
        [row.host_id],
      );
      if (hostMoved.rows.length !== 1) throw new Error('Host authorization move would underflow or exceed capacity.');
      const receipt = receiptFrom(transitioned.rows[0]);
      await client.query(
        `INSERT INTO swarm_authority_audit (event,operation_id,binding_digest_sha256,at,detail)
         VALUES ('start-authority-redeemed',$1,$2,$3::timestamptz,$4::jsonb)`,
        [request.operation_id, request.binding_digest_sha256, at, JSON.stringify(receipt)],
      );
      await client.query('COMMIT');
      return { redeemed: true, receipt, blockers: [] };
    } catch (error) {
      await client.query('ROLLBACK');
      await this.recordIntegrityRefusal(client, request.operation_id, request.binding_digest_sha256, {
        action: 'redeem-start-authorization', reservation_id: request.reservation_id, lease_id: request.lease_id,
        error: error instanceof Error ? error.message : 'unknown start-redemption failure',
      });
      throw error;
    } finally { client.release?.(); }
  }

  async claimRunnerStart(input: RunnerClaimInput): Promise<RunnerClaimResult> {
    const parsed = runnerClaimInputSchema.safeParse(input);
    if (!parsed.success) return runnerClaimDenied('Runner claim is invalid.');
    const request = parsed.data;
    const client = await this.pool.connect();
    let at = new Date().toISOString();
    const deny = async (blocker: string): Promise<RunnerClaimResult> => {
      await client.query(
        `INSERT INTO swarm_authority_audit (event,operation_id,binding_digest_sha256,at,detail)
         VALUES ('runner-claim-denied',$1,$2,$3::timestamptz,$4::jsonb)`,
        [request.operation_id, request.binding_digest_sha256, at, JSON.stringify({
          reservation_id: request.reservation_id, redemption_id: request.redemption_id,
          claim_request_id: request.claim_request_id, blockers: [blocker],
        })],
      );
      await client.query('COMMIT');
      return runnerClaimDenied(blocker);
    };
    const receiptFrom = (row: Record<string, unknown>): RunnerClaimReceipt => ({
      schema_version: 'starlight.runner_claim_acceptance.v1',
      claim_id: String(row.runner_claim_id),
      claim_request_id: String(row.runner_claim_request_id),
      reservation_id: request.reservation_id,
      redemption_id: request.redemption_id,
      operation_id: request.operation_id,
      effect_id: request.effect_id,
      binding_digest_sha256: request.binding_digest_sha256,
      runner_id: String(row.runner_id),
      runner_identity_evidence_ref: String(row.runner_identity_evidence_ref),
      runner_instance_id: String(row.runner_instance_id),
      runtime_id: String(row.runner_runtime_id),
      host_id: String(row.runner_host_id),
      channel_binding_sha256: String(row.runner_channel_binding_sha256),
      accepted_at: sqlInstant(row.runner_claim_accepted_at),
      claim_expires_at: sqlInstant(row.runner_claim_expires_at),
      heartbeat_token_sha256: String(row.heartbeat_token_sha256),
      start_observation_token_sha256: String(row.start_observation_token_sha256),
      outcome_token_sha256: String(row.outcome_token_sha256),
      usage_reconciliation_token_sha256: String(row.usage_reconciliation_token_sha256),
      provider_usage_correlation_id: String(row.provider_usage_correlation_id),
      launch_attempt_id: String(row.runner_launch_attempt_id),
      fencing_generation: Number(row.runner_fencing_generation),
      transport_state: 'attested-not-deployed',
      dispatch_state: 'not-dispatched',
      execution_observed: false,
      state: 'runner-claimed-not-started',
    });
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL search_path = pg_catalog, public, pg_temp');
      if (!await lockAuthority(client)) return await deny('Authority serialization control row is missing or ambiguous.');
      at = await wallClock(client);
      const nowMs = Date.parse(at);

      const brokerAttestation = await this.brokerSessionAttestor(client);
      if (!brokerAttestation.valid) {
        return await deny(`Broker database session is not authorized: ${brokerAttestation.blockers.join(' ')}`);
      }
      const runnerAttestation = await this.runnerSessionAttestor(client);
      if (!runnerAttestation.valid) {
        return await deny(`Runner transport session is not authorized: ${runnerAttestation.blockers.join(' ')}`);
      }
      const parsedRunner = runnerSessionSchema.safeParse(runnerAttestation.session);
      if (!parsedRunner.success) return await deny('Runner transport attestation is malformed.');
      const runner = parsedRunner.data;
      const runnerObservedMs = Date.parse(runner.observed_at);
      if (runnerObservedMs > nowMs + 60_000 || nowMs - runnerObservedMs > this.maxRunnerEvidenceAgeMs) {
        return await deny('Runner transport attestation is stale or from the future.');
      }
      if (Date.parse(runner.access_review_expires_at) <= nowMs) {
        return await deny('Runner transport access review is expired.');
      }

      const controlDigest = createHash('sha256').update(request.control_token, 'utf8').digest('hex');
      const heartbeatDigest = createHash('sha256').update(request.heartbeat_token, 'utf8').digest('hex');
      const startObservationDigest = createHash('sha256').update(request.start_observation_token, 'utf8').digest('hex');
      const outcomeDigest = createHash('sha256').update(request.outcome_token, 'utf8').digest('hex');
      const usageDigest = createHash('sha256').update(request.usage_reconciliation_token, 'utf8').digest('hex');
      const found = await client.query(
        `SELECT *,
                (reserved_cost_usd IS NOT DISTINCT FROM (binding->>'requested_cost_usd')::numeric) AS cost_matches_binding
         FROM swarm_authority_reservations
         WHERE reservation_id=$1::uuid AND redemption_id=$2::uuid AND control_token_sha256=$3 FOR UPDATE`,
        [request.reservation_id, request.redemption_id, controlDigest],
      );
      const row = found.rows[0];
      if (!row) return await deny('Start authorization does not exist or the control credential is invalid.');
      if (row.operation_id !== request.operation_id || row.effect_id !== request.effect_id
        || row.binding_digest_sha256 !== request.binding_digest_sha256) {
        return await deny('Runner claim does not match the authorized operation.');
      }
      const exactRequest = row.state === 'runner-claimed-not-started'
        && row.runner_claim_request_id === request.claim_request_id;
      const quarantine = async (reason: string, blocker: string): Promise<RunnerClaimResult> => {
        const stopped = await client.query(
          `UPDATE swarm_authority_reservations SET state='stop-requested'
           WHERE reservation_id=$1::uuid
             AND state IN ('start-authorized-not-observed','runner-claimed-not-started','runner-start-observed') RETURNING reservation_id`,
          [request.reservation_id],
        );
        if (stopped.rows.length !== 1) return await deny('Runner-claim quarantine lost its authority race.');
        await client.query(
          `INSERT INTO swarm_authority_audit (event,operation_id,binding_digest_sha256,at,detail)
           VALUES ('stop-requested',$1,$2,$3::timestamptz,$4::jsonb)`,
          [request.operation_id, request.binding_digest_sha256, at, JSON.stringify({
            reservation_id: request.reservation_id, reason, execution_state: 'unknown', released_cost_usd: 0,
          })],
        );
        await client.query('COMMIT');
        return runnerClaimDenied(blocker);
      };
      if (row.state === 'runner-claimed-not-started' && !exactRequest) {
        return await deny('A different runner claim already owns this start authorization.');
      }
      if (row.state !== 'start-authorized-not-observed' && !exactRequest) {
        return await deny(`Runner claim cannot be accepted from state ${String(row.state)}.`);
      }

      const binding = operationBindingSchema.safeParse(row.binding);
      if (!binding.success || sha256Digest(binding.data) !== row.binding_digest_sha256 || row.cost_matches_binding !== true) {
        return await quarantine(
          exactRequest ? 'stored binding invalid on runner-claim retry' : 'stored binding invalid before runner claim',
          exactRequest ? 'Stored binding is invalid on the runner-claim retry.' : 'Stored reservation binding or signed cost is invalid.',
        );
      }
      if (Date.parse(String(row.reservation_expires_at)) <= nowMs
        || Date.parse(String(row.lease_expires_at)) <= nowMs
        || Date.parse(String(row.start_authorized_at)) + binding.data.timeout_ms <= nowMs) {
        return await quarantine(
          exactRequest ? 'stored runner authority expired on claim retry' : 'stored runner authority expired before runner claim',
          exactRequest ? 'Runner authority expired before the claim retry.' : 'Runner authority expired before the claim.',
        );
      }
      if (runner.runner_id !== binding.data.execution_identity
        || runner.runner_identity_evidence_ref !== binding.data.identity_evidence_ref
        || runner.runtime_id !== binding.data.runtime_id || runner.host_id !== row.host_id) {
        return exactRequest
          ? await quarantine('runner identity or placement drifted on claim retry', 'Runner identity or placement drifted on the claim retry.')
          : await deny('Attested runner identity or placement does not match the signed operation binding.');
      }
      if (row.broker_database_role !== brokerAttestation.session.database_role
        || row.broker_database_name !== brokerAttestation.session.database_name
        || row.broker_role_contract_sha256 !== brokerAttestation.session.contract_digest_sha256
        || row.broker_role_contract_sha256 !== BROKER_DATABASE_ROLE_CONTRACT_SHA256) {
        return exactRequest
          ? await quarantine('authenticated broker principal drifted on claim retry', 'Authenticated broker principal drifted on the claim retry.')
          : await deny('Authenticated broker principal does not match the start authorization.');
      }
      const principal = await client.query(
        `SELECT database_role,database_name,broker_execution_identity,broker_identity_evidence_ref,
                authn_kind,role_contract_digest_sha256,observed_at,access_review_expires_at,state,evidence
         FROM swarm_authority_broker_principals
         WHERE database_role=$1 AND database_name=$2`,
        [brokerAttestation.session.database_role, brokerAttestation.session.database_name],
      );
      const principalEvidence = brokerPrincipalEvidenceSchema.safeParse(principal.rows[0]?.evidence);
      const principalRow = principal.rows[0];
      const principalCurrent = principal.rows.length === 1 && principalEvidence.success
        && principalEvidence.data.database_role === principalRow.database_role
        && principalEvidence.data.database_name === principalRow.database_name
        && principalEvidence.data.broker_execution_identity === principalRow.broker_execution_identity
        && principalEvidence.data.broker_identity_evidence_ref === principalRow.broker_identity_evidence_ref
        && principalEvidence.data.authn_kind === principalRow.authn_kind
        && principalEvidence.data.role_contract_digest_sha256 === principalRow.role_contract_digest_sha256
        && principalEvidence.data.state === principalRow.state
        && sqlInstant(principalEvidence.data.observed_at) === sqlInstant(principalRow.observed_at)
        && sqlInstant(principalEvidence.data.access_review_expires_at) === sqlInstant(principalRow.access_review_expires_at)
        && principalEvidence.data.state === 'ready'
        && principalEvidence.data.database_role === brokerAttestation.session.database_role
        && principalEvidence.data.database_name === brokerAttestation.session.database_name
        && principalEvidence.data.broker_execution_identity === row.broker_execution_identity
        && principalEvidence.data.broker_identity_evidence_ref === row.broker_identity_evidence_ref
        && principalEvidence.data.role_contract_digest_sha256 === BROKER_DATABASE_ROLE_CONTRACT_SHA256
        && principalEvidence.data.role_contract_digest_sha256 === brokerAttestation.session.contract_digest_sha256
        && Date.parse(principalEvidence.data.observed_at) <= nowMs + 60_000
        && nowMs - Date.parse(principalEvidence.data.observed_at) <= this.maxBrokerEvidenceAgeMs
        && Date.parse(principalEvidence.data.access_review_expires_at) > nowMs;
      if (!principalCurrent) {
        return await quarantine(
          exactRequest ? 'broker principal unavailable on runner-claim retry' : 'broker principal unavailable before runner claim',
          exactRequest ? 'Broker principal is unavailable on the runner-claim retry.' : 'Broker principal is unavailable, stale, disabled, or drifted.',
        );
      }

      const storedRefs = revocationRefsSchema.safeParse(row.revocation_refs);
      if (!storedRefs.success) return exactRequest
        ? await quarantine('stored operation revocation binding invalid on claim retry', 'Stored operation revocation binding is invalid on the claim retry.')
        : await quarantine('stored operation revocation binding invalid before runner claim', 'Stored operation revocation binding is invalid.');
      const runnerRefs = [
        `runner:${runner.runner_id}`, `runner-instance:${runner.runner_instance_id}`,
        `identity:${runner.runner_identity_evidence_ref}`, `channel:${runner.channel_binding_sha256}`,
      ];
      const refs = revocationRefsSchema.safeParse([...storedRefs.data, ...runnerRefs]);
      if (!refs.success) return exactRequest
        ? await quarantine('runner revocation binding invalid on claim retry', 'Runner revocation binding is invalid on the claim retry.')
        : await deny('Runner revocation binding is invalid.');
      if (exactRequest) {
        const storedRunnerRefs = revocationRefsSchema.safeParse(row.runner_revocation_refs);
        if (!storedRunnerRefs.success || JSON.stringify(storedRunnerRefs.data) !== JSON.stringify(refs.data)) {
          return await quarantine('runner revocation binding drifted on claim retry', 'Runner revocation binding drifted on the claim retry.');
        }
        const tokenHistory = await client.query(
          `SELECT reservation_id,sequence,issued_by_request_id,kind
           FROM swarm_authority_heartbeat_tokens WHERE token_sha256=$1`,
          [heartbeatDigest],
        );
        if (tokenHistory.rows.length !== 1
          || tokenHistory.rows[0].reservation_id !== request.reservation_id
          || Number(tokenHistory.rows[0].sequence) !== 0
          || tokenHistory.rows[0].issued_by_request_id !== request.claim_request_id
          || tokenHistory.rows[0].kind !== 'claim') {
          return await quarantine('initial heartbeat credential history drifted on claim retry', 'Initial heartbeat credential history drifted on the claim retry.');
        }
        const usageTokenHistory = await client.query(
          `SELECT reservation_id,sequence,issued_by_request_id,kind
           FROM swarm_authority_usage_tokens WHERE token_sha256=$1`,
          [usageDigest],
        );
        if (usageTokenHistory.rows.length !== 1
          || usageTokenHistory.rows[0].reservation_id !== request.reservation_id
          || Number(usageTokenHistory.rows[0].sequence) !== 0
          || usageTokenHistory.rows[0].issued_by_request_id !== request.claim_request_id
          || usageTokenHistory.rows[0].kind !== 'claim') {
          return await quarantine('initial usage credential history drifted on claim retry', 'Initial usage credential history drifted on the claim retry.');
        }
      }
      const revoked = await client.query('SELECT ref FROM swarm_authority_revocations WHERE ref = ANY($1::text[]) LIMIT 1', [refs.data]);
      if (revoked.rows.length) return await quarantine(
        exactRequest ? 'runner or operation authority revoked on claim retry' : 'runner or operation authority revoked before runner claim',
        exactRequest ? 'Runner or operation authority is revoked on the claim retry.' : 'Runner or operation authority is revoked.',
      );
      const prepared = await client.query(
        'SELECT binding_digest_sha256,state FROM swarm_authority_prepared_operations WHERE operation_id=$1',
        [request.operation_id],
      );
      if (prepared.rows[0]?.state !== 'ready' || prepared.rows[0]?.binding_digest_sha256 !== request.binding_digest_sha256) {
        return await quarantine(
          exactRequest ? 'prepared operation unavailable on runner-claim retry' : 'prepared operation unavailable before runner claim',
          exactRequest ? 'Prepared operation is unavailable on the runner-claim retry.' : 'Prepared operation is unavailable or drifted.',
        );
      }

      const hostResult = await client.query(
        `SELECT evidence,capacity_slots,reserved_slots,authorized_slots,
                (authorized_slots IS NOT DISTINCT FROM (SELECT COUNT(*)::integer FROM swarm_authority_reservations
                  WHERE host_id=$1 AND state IN ('start-authorized-not-observed','runner-claimed-not-started','runner-start-observed','stop-requested','runner-never-started-observed'))) AS reconciles
         FROM swarm_authority_hosts WHERE host_id=$1 FOR UPDATE`, [row.host_id],
      );
      const host = hostEvidence(hostResult.rows[0]);
      if (!host || host.status !== 'ready' || !host.secret_readiness || host.host_id !== runner.host_id
        || host.capacity_slots !== Number(hostResult.rows[0]?.capacity_slots)
        || hostResult.rows[0]?.reconciles !== true
        || Date.parse(host.observed_at) > nowMs + 60_000
        || nowMs - Date.parse(host.observed_at) > Number(row.max_host_evidence_age_ms)
        || Date.parse(host.access_review_expires_at) <= nowMs
        || binding.data.capabilities.some((capability) => !host.allowed_capabilities.includes(capability))) {
        return await quarantine(
          exactRequest ? 'host authority unavailable on runner-claim retry' : 'host authority unavailable before runner claim',
          exactRequest ? 'Host authority is unavailable on the runner-claim retry.' : 'Host authority is unavailable, stale, or inconsistent.',
        );
      }
      if (!await this.readBudgetWindows(client, request.reservation_id, binding.data.budget_policy_id, binding.data.requested_cost_usd)) {
        return await quarantine(
          exactRequest ? 'aggregate budget invalid on runner-claim retry' : 'aggregate budget invalid before runner claim',
          exactRequest ? 'Aggregate budget is invalid on the runner-claim retry.' : 'Aggregate budget authority is missing or inconsistent.',
        );
      }
      const budget = await client.query(
        `SELECT (committed_usd IS NOT DISTINCT FROM (SELECT COALESCE(SUM(reserved_cost_usd),0)
                  FROM swarm_authority_reservations WHERE budget_receipt_id=$1
                    AND state IN ('start-authorized-not-observed','runner-claimed-not-started','runner-start-observed','stop-requested','runner-never-started-observed','runner-terminal-observed'))) AS reconciles,
                (reserved_usd+committed_usd <= hard_limit_usd) AS within_ceiling
         FROM swarm_authority_budgets WHERE receipt_id=$1 FOR UPDATE`, [row.budget_receipt_id],
      );
      if (budget.rows.length !== 1 || budget.rows[0].reconciles !== true || budget.rows[0].within_ceiling !== true) {
        return await quarantine(
          exactRequest ? 'receipt budget invalid on runner-claim retry' : 'receipt budget invalid before runner claim',
          exactRequest ? 'Receipt budget is invalid on the runner-claim retry.' : 'Receipt budget authority is missing or inconsistent.',
        );
      }

      const claimExpiryMs = Math.min(
        Date.parse(runner.access_review_expires_at),
        runnerObservedMs + this.maxRunnerEvidenceAgeMs,
        Date.parse(String(row.reservation_expires_at)),
        Date.parse(String(row.lease_expires_at)),
        Date.parse(String(row.start_authorized_at)) + binding.data.timeout_ms,
      );
      if (!Number.isFinite(claimExpiryMs) || claimExpiryMs <= nowMs) {
        return await quarantine(
          exactRequest ? 'runner claim expired before retry' : 'runner claim had no valid authority interval',
          exactRequest ? 'Runner claim expired before the retry.' : 'Runner claim would have no valid authority interval.',
        );
      }
      if (exactRequest) {
        const storedEvidenceObservedMs = Date.parse(String(row.runner_evidence_observed_at));
        const storedAccessReviewExpiresMs = Date.parse(String(row.runner_access_review_expires_at));
        const storedClaimExpiryMs = Date.parse(String(row.runner_claim_expires_at));
        const storedAuthorityCapMs = Math.min(
          storedAccessReviewExpiresMs,
          storedEvidenceObservedMs + this.maxRunnerEvidenceAgeMs,
          Date.parse(String(row.reservation_expires_at)),
          Date.parse(String(row.lease_expires_at)),
          Date.parse(String(row.start_authorized_at)) + binding.data.timeout_ms,
        );
        if (row.heartbeat_token_sha256 !== heartbeatDigest
          || row.start_observation_token_sha256 !== startObservationDigest
          || row.outcome_token_sha256 !== outcomeDigest
          || row.usage_reconciliation_token_sha256 !== usageDigest
          || row.provider_usage_correlation_id !== request.provider_usage_correlation_id
          || row.runner_id !== runner.runner_id
          || row.runner_identity_evidence_ref !== runner.runner_identity_evidence_ref
          || row.runner_instance_id !== runner.runner_instance_id
          || row.runner_runtime_id !== runner.runtime_id || row.runner_host_id !== runner.host_id
          || row.runner_channel_binding_sha256 !== runner.channel_binding_sha256
          || row.runner_launch_attempt_id !== runner.launch_attempt_id
          || Number(row.runner_fencing_generation) !== runner.fencing_generation
          || !Number.isFinite(storedAuthorityCapMs)
          || storedClaimExpiryMs !== storedAuthorityCapMs
          || storedClaimExpiryMs > claimExpiryMs
          || storedClaimExpiryMs <= nowMs) {
          return await quarantine('runner claim replay evidence drifted', 'Runner claim replay evidence drifted.');
        }
        const receipt = receiptFrom(row);
        await client.query('COMMIT');
        return { claimed: true, receipt, blockers: [] };
      }
      const duplicate = await client.query(
        'SELECT reservation_id FROM swarm_authority_reservations WHERE runner_claim_request_id=$1::uuid LIMIT 1',
        [request.claim_request_id],
      );
      if (duplicate.rows.length) return await deny('Runner claim request id is already bound to another reservation.');
      const duplicateCorrelation = await client.query(
        'SELECT reservation_id FROM swarm_authority_reservations WHERE provider_usage_correlation_id=$1 LIMIT 1',
        [request.provider_usage_correlation_id],
      );
      if (duplicateCorrelation.rows.length) {
        return await deny('Provider usage correlation is already bound to another reservation.');
      }
      const newCredentialDigests = [heartbeatDigest, startObservationDigest, outcomeDigest, usageDigest];
      if (new Set(newCredentialDigests).size !== newCredentialDigests.length) {
        return await deny('Runner claim credentials alias each other.');
      }
      const findIssuedCredential = async (digest: string) => client.query(
        `SELECT reservation_id FROM swarm_authority_reservations
         WHERE consume_token_sha256=$1 OR cancel_token_sha256=$1 OR lease_claim_token_sha256=$1
           OR redemption_token_sha256=$1 OR control_token_sha256=$1 OR heartbeat_token_sha256=$1
           OR start_observation_token_sha256=$1 OR outcome_token_sha256=$1
           OR usage_reconciliation_token_sha256=$1
           OR runner_heartbeat_presented_token_sha256=$1 OR runner_start_presented_token_sha256=$1
           OR runner_outcome_presented_token_sha256=$1
         UNION ALL
         SELECT reservation_id FROM swarm_authority_heartbeat_tokens WHERE token_sha256=$1
         UNION ALL
         SELECT reservation_id FROM swarm_authority_usage_tokens WHERE token_sha256=$1
         LIMIT 1`,
        [digest],
      );
      for (const [label, digest] of [
        ['Heartbeat', heartbeatDigest],
        ['Start-observation', startObservationDigest],
        ['Outcome', outcomeDigest],
        ['Usage-reconciliation', usageDigest],
      ] as const) {
        if ((await findIssuedCredential(digest)).rows.length) {
          return await deny(`${label} credential aliases an issued lifecycle credential.`);
        }
      }
      const claimId = randomUUID();
      const transitioned = await client.query(
        `UPDATE swarm_authority_reservations SET state='runner-claimed-not-started',
           runner_claim_id=$2::uuid,runner_claim_request_id=$3::uuid,runner_claim_accepted_at=$4::timestamptz,
           runner_claim_expires_at=$5::timestamptz,runner_evidence_observed_at=$6::timestamptz,
           runner_access_review_expires_at=$7::timestamptz,runner_id=$8,runner_identity_evidence_ref=$9,
           runner_instance_id=$10,runner_runtime_id=$11,runner_host_id=$12,runner_channel_binding_sha256=$13,
           heartbeat_token_sha256=$14,start_observation_token_sha256=$15,outcome_token_sha256=$16,
           runner_launch_attempt_id=$17,runner_fencing_generation=$18,runner_revocation_refs=$19::jsonb
         WHERE reservation_id=$1::uuid AND state='start-authorized-not-observed' RETURNING *`,
        [request.reservation_id, claimId, request.claim_request_id, at, new Date(claimExpiryMs).toISOString(),
          runner.observed_at, runner.access_review_expires_at, runner.runner_id, runner.runner_identity_evidence_ref,
          runner.runner_instance_id, runner.runtime_id, runner.host_id, runner.channel_binding_sha256,
          heartbeatDigest, startObservationDigest, outcomeDigest, runner.launch_attempt_id,
          runner.fencing_generation, JSON.stringify(refs.data)],
      );
      if (transitioned.rows.length !== 1) return await deny('Runner claim could not be accepted exactly once.');
      await client.query(
        `INSERT INTO swarm_authority_heartbeat_tokens
         (token_sha256,reservation_id,sequence,issued_by_request_id,issued_at,kind)
         VALUES ($1,$2::uuid,0,$3::uuid,$4::timestamptz,'claim')`,
        [heartbeatDigest, request.reservation_id, request.claim_request_id, at],
      );
      const initialized = await client.query(
        `SELECT public.starlight_initialize_runner_usage_stream($1::jsonb) AS result`,
        [JSON.stringify({
          reservation_id: request.reservation_id, claim_id: claimId,
          claim_request_id: request.claim_request_id, operation_id: request.operation_id,
          binding_digest_sha256: request.binding_digest_sha256,
          usage_reconciliation_token: request.usage_reconciliation_token,
          provider_usage_correlation_id: request.provider_usage_correlation_id,
        })],
      );
      const initialization = initialized.rows[0]?.result as { ok?: boolean; blocker?: string } | undefined;
      if (initialization?.ok !== true) {
        return await deny(initialization?.blocker ?? 'Runner usage stream could not be initialized.');
      }
      const claimed = await client.query(
        `SELECT * FROM swarm_authority_reservations WHERE reservation_id=$1::uuid FOR UPDATE`,
        [request.reservation_id],
      );
      if (claimed.rows.length !== 1) throw new Error('Initialized runner claim disappeared.');
      const receipt = receiptFrom(claimed.rows[0]);
      await client.query(
        `INSERT INTO swarm_authority_audit (event,operation_id,binding_digest_sha256,at,detail)
         VALUES ('runner-claim-accepted',$1,$2,$3::timestamptz,$4::jsonb)`,
        [request.operation_id, request.binding_digest_sha256, at, JSON.stringify(receipt)],
      );
      await client.query('COMMIT');
      return { claimed: true, receipt, blockers: [] };
    } catch (error) {
      await client.query('ROLLBACK');
      await this.recordIntegrityRefusal(client, request.operation_id, request.binding_digest_sha256, {
        action: 'claim-runner-start', reservation_id: request.reservation_id,
        error: error instanceof Error ? error.message : 'unknown runner-claim failure',
      });
      throw error;
    } finally { client.release?.(); }
  }

  async acceptRunnerHeartbeat(input: RunnerHeartbeatInput): Promise<RunnerHeartbeatResult> {
    const parsed = runnerHeartbeatInputSchema.safeParse(input);
    if (!parsed.success) return runnerHeartbeatDenied('Runner heartbeat is invalid.');
    const request = parsed.data;
    const client = await this.pool.connect();
    let at = new Date().toISOString();
    const deny = async (blocker: string): Promise<RunnerHeartbeatResult> => {
      await client.query(
        `INSERT INTO swarm_authority_audit (event,operation_id,binding_digest_sha256,at,detail)
         VALUES ('runner-heartbeat-denied',$1,$2,$3::timestamptz,$4::jsonb)`,
        [request.operation_id, request.binding_digest_sha256, at, JSON.stringify({
          reservation_id: request.reservation_id, claim_id: request.claim_id,
          heartbeat_request_id: request.heartbeat_request_id,
          heartbeat_sequence: request.heartbeat_sequence, blockers: [blocker],
        })],
      );
      await client.query('COMMIT');
      return runnerHeartbeatDenied(blocker);
    };
    const receiptFrom = (row: Record<string, unknown>): RunnerHeartbeatReceipt => ({
      schema_version: 'starlight.runner_heartbeat_acceptance.v1',
      heartbeat_id: String(row.runner_heartbeat_id),
      heartbeat_request_id: String(row.runner_heartbeat_request_id),
      heartbeat_sequence: Number(row.runner_heartbeat_sequence),
      claim_id: request.claim_id,
      reservation_id: request.reservation_id,
      operation_id: request.operation_id,
      effect_id: request.effect_id,
      binding_digest_sha256: request.binding_digest_sha256,
      runner_id: String(row.runner_id),
      runner_instance_id: String(row.runner_instance_id),
      runtime_id: String(row.runner_runtime_id),
      host_id: String(row.runner_host_id),
      channel_binding_sha256: String(row.runner_channel_binding_sha256),
      accepted_at: sqlInstant(row.runner_heartbeat_accepted_at),
      claim_expires_at: sqlInstant(row.runner_claim_expires_at),
      heartbeat_token_sha256: String(row.heartbeat_token_sha256),
      transport_state: 'attested-not-deployed',
      dispatch_state: 'not-dispatched',
      execution_observed: row.state === 'runner-start-observed',
      workload_effect_observed: false,
      state: row.state === 'runner-start-observed' ? 'runner-start-observed' : 'runner-claimed-not-started',
    });
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL search_path = pg_catalog, public, pg_temp');
      if (!await lockAuthority(client)) return await deny('Authority serialization control row is missing or ambiguous.');
      at = await wallClock(client);
      const nowMs = Date.parse(at);

      const brokerAttestation = await this.brokerSessionAttestor(client);
      if (!brokerAttestation.valid) {
        return await deny(`Broker database session is not authorized: ${brokerAttestation.blockers.join(' ')}`);
      }
      const runnerAttestation = await this.runnerSessionAttestor(client);
      if (!runnerAttestation.valid) {
        return await deny(`Runner transport session is not authorized: ${runnerAttestation.blockers.join(' ')}`);
      }
      const parsedRunner = runnerSessionSchema.safeParse(runnerAttestation.session);
      if (!parsedRunner.success) return await deny('Runner transport attestation is malformed.');
      const runner = parsedRunner.data;
      const runnerObservedMs = Date.parse(runner.observed_at);
      if (runnerObservedMs > nowMs + 60_000 || nowMs - runnerObservedMs > this.maxRunnerEvidenceAgeMs) {
        return await deny('Runner transport attestation is stale or from the future.');
      }
      if (Date.parse(runner.access_review_expires_at) <= nowMs) {
        return await deny('Runner transport access review is expired.');
      }

      const heartbeatDigest = createHash('sha256').update(request.heartbeat_token, 'utf8').digest('hex');
      const nextHeartbeatDigest = createHash('sha256').update(request.next_heartbeat_token, 'utf8').digest('hex');
      const found = await client.query(
        `SELECT *,
                (reserved_cost_usd IS NOT DISTINCT FROM (binding->>'requested_cost_usd')::numeric) AS cost_matches_binding
         FROM swarm_authority_reservations
         WHERE reservation_id=$1::uuid AND runner_claim_id=$2::uuid FOR UPDATE`,
        [request.reservation_id, request.claim_id],
      );
      const row = found.rows[0];
      if (!row) return await deny('Runner claim does not exist.');
      if (row.operation_id !== request.operation_id || row.effect_id !== request.effect_id
        || row.binding_digest_sha256 !== request.binding_digest_sha256) {
        return await deny('Runner heartbeat does not match the claimed operation.');
      }
      const exactRequest = (row.state === 'runner-claimed-not-started' || row.state === 'runner-start-observed')
        && row.runner_heartbeat_request_id === request.heartbeat_request_id
        && Number(row.runner_heartbeat_sequence) === request.heartbeat_sequence;
      const quarantine = async (reason: string, blocker: string): Promise<RunnerHeartbeatResult> => {
        const stopped = await client.query(
          `UPDATE swarm_authority_reservations SET state='stop-requested'
           WHERE reservation_id=$1::uuid AND state IN ('runner-claimed-not-started','runner-start-observed') RETURNING reservation_id`,
          [request.reservation_id],
        );
        if (stopped.rows.length !== 1) return await deny('Runner-heartbeat quarantine lost its authority race.');
        await client.query(
          `INSERT INTO swarm_authority_audit (event,operation_id,binding_digest_sha256,at,detail)
           VALUES ('stop-requested',$1,$2,$3::timestamptz,$4::jsonb)`,
          [request.operation_id, request.binding_digest_sha256, at, JSON.stringify({
            reservation_id: request.reservation_id, claim_id: request.claim_id, reason,
            execution_state: row.state === 'runner-start-observed' ? 'started-or-unknown' : 'unknown', released_cost_usd: 0,
          })],
        );
        await client.query('COMMIT');
        return runnerHeartbeatDenied(blocker);
      };
      if (row.state !== 'runner-claimed-not-started' && row.state !== 'runner-start-observed') {
        return await deny(`Runner heartbeat cannot be accepted from state ${String(row.state)}.`);
      }

      const binding = operationBindingSchema.safeParse(row.binding);
      if (!binding.success || sha256Digest(binding.data) !== row.binding_digest_sha256 || row.cost_matches_binding !== true) {
        return await quarantine('stored binding invalid before runner heartbeat', 'Stored reservation binding or signed cost is invalid.');
      }
      const fixedAuthorityCapMs = Math.min(
        Date.parse(String(row.reservation_expires_at)),
        Date.parse(String(row.lease_expires_at)),
        Date.parse(String(row.start_authorized_at)) + binding.data.timeout_ms,
      );
      const currentEvidenceObservedMs = Date.parse(String(row.runner_evidence_observed_at));
      const currentAccessReviewExpiresMs = Date.parse(String(row.runner_access_review_expires_at));
      const currentClaimExpiryMs = Date.parse(String(row.runner_claim_expires_at));
      const currentAuthorityCapMs = Math.min(
        currentAccessReviewExpiresMs,
        currentEvidenceObservedMs + this.maxRunnerEvidenceAgeMs,
        fixedAuthorityCapMs,
      );
      if (!Number.isFinite(currentAuthorityCapMs) || currentClaimExpiryMs !== currentAuthorityCapMs) {
        return await quarantine('stored runner heartbeat authority drifted', 'Stored runner heartbeat authority drifted.');
      }
      if (currentClaimExpiryMs <= nowMs) {
        return await quarantine('runner heartbeat authority expired', 'Runner heartbeat authority expired before renewal.');
      }
      const storedCredentialDigests = [
        row.consume_token_sha256, row.cancel_token_sha256, row.lease_claim_token_sha256,
        row.redemption_token_sha256, row.control_token_sha256, row.heartbeat_token_sha256,
        row.start_observation_token_sha256, row.outcome_token_sha256,
        row.usage_reconciliation_token_sha256,
      ];
      if (storedCredentialDigests.some((digest) => typeof digest !== 'string')
        || new Set(storedCredentialDigests).size !== storedCredentialDigests.length
        || (row.runner_heartbeat_presented_token_sha256 !== null
          && (typeof row.runner_heartbeat_presented_token_sha256 !== 'string'
            || storedCredentialDigests.includes(row.runner_heartbeat_presented_token_sha256)))) {
        return await quarantine('stored lifecycle credential separation drifted', 'Stored lifecycle credential separation drifted.');
      }
      const storedSequence = row.runner_heartbeat_sequence === null ? 0 : Number(row.runner_heartbeat_sequence);
      const currentTokenHistory = await client.query(
        `SELECT reservation_id,sequence,issued_by_request_id,kind
         FROM swarm_authority_heartbeat_tokens WHERE token_sha256=$1`,
        [row.heartbeat_token_sha256],
      );
      if (!Number.isSafeInteger(storedSequence) || currentTokenHistory.rows.length !== 1
        || currentTokenHistory.rows[0].reservation_id !== request.reservation_id
        || Number(currentTokenHistory.rows[0].sequence) !== storedSequence) {
        return await quarantine('current heartbeat credential history drifted', 'Current heartbeat credential history drifted.');
      }
      if (runner.runner_id !== binding.data.execution_identity
        || runner.runner_identity_evidence_ref !== binding.data.identity_evidence_ref
        || runner.runtime_id !== binding.data.runtime_id || runner.host_id !== row.host_id
        || row.runner_id !== runner.runner_id
        || row.runner_identity_evidence_ref !== runner.runner_identity_evidence_ref
        || row.runner_instance_id !== runner.runner_instance_id
        || row.runner_runtime_id !== runner.runtime_id || row.runner_host_id !== runner.host_id
        || row.runner_channel_binding_sha256 !== runner.channel_binding_sha256
        || row.runner_launch_attempt_id !== runner.launch_attempt_id
        || Number(row.runner_fencing_generation) !== runner.fencing_generation) {
        return await quarantine('runner identity or channel drifted before heartbeat', 'Runner identity, placement, or channel drifted before heartbeat.');
      }
      if (row.broker_database_role !== brokerAttestation.session.database_role
        || row.broker_database_name !== brokerAttestation.session.database_name
        || row.broker_role_contract_sha256 !== brokerAttestation.session.contract_digest_sha256
        || row.broker_role_contract_sha256 !== BROKER_DATABASE_ROLE_CONTRACT_SHA256) {
        return await quarantine('authenticated broker principal drifted before heartbeat', 'Authenticated broker principal drifted before heartbeat.');
      }
      const principal = await client.query(
        `SELECT database_role,database_name,broker_execution_identity,broker_identity_evidence_ref,
                authn_kind,role_contract_digest_sha256,observed_at,access_review_expires_at,state,evidence
         FROM swarm_authority_broker_principals
         WHERE database_role=$1 AND database_name=$2`,
        [brokerAttestation.session.database_role, brokerAttestation.session.database_name],
      );
      const principalEvidence = brokerPrincipalEvidenceSchema.safeParse(principal.rows[0]?.evidence);
      const principalRow = principal.rows[0];
      const principalCurrent = principal.rows.length === 1 && principalEvidence.success
        && principalEvidence.data.database_role === principalRow.database_role
        && principalEvidence.data.database_name === principalRow.database_name
        && principalEvidence.data.broker_execution_identity === principalRow.broker_execution_identity
        && principalEvidence.data.broker_identity_evidence_ref === principalRow.broker_identity_evidence_ref
        && principalEvidence.data.authn_kind === principalRow.authn_kind
        && principalEvidence.data.role_contract_digest_sha256 === principalRow.role_contract_digest_sha256
        && principalEvidence.data.state === principalRow.state
        && sqlInstant(principalEvidence.data.observed_at) === sqlInstant(principalRow.observed_at)
        && sqlInstant(principalEvidence.data.access_review_expires_at) === sqlInstant(principalRow.access_review_expires_at)
        && principalEvidence.data.state === 'ready'
        && principalEvidence.data.database_role === brokerAttestation.session.database_role
        && principalEvidence.data.database_name === brokerAttestation.session.database_name
        && principalEvidence.data.broker_execution_identity === row.broker_execution_identity
        && principalEvidence.data.broker_identity_evidence_ref === row.broker_identity_evidence_ref
        && principalEvidence.data.role_contract_digest_sha256 === BROKER_DATABASE_ROLE_CONTRACT_SHA256
        && Date.parse(principalEvidence.data.observed_at) <= nowMs + 60_000
        && nowMs - Date.parse(principalEvidence.data.observed_at) <= this.maxBrokerEvidenceAgeMs
        && Date.parse(principalEvidence.data.access_review_expires_at) > nowMs;
      if (!principalCurrent) {
        return await quarantine('broker principal unavailable before heartbeat', 'Broker principal is unavailable, stale, disabled, or drifted.');
      }

      const storedOperationRefs = revocationRefsSchema.safeParse(row.revocation_refs);
      const storedRunnerRefs = revocationRefsSchema.safeParse(row.runner_revocation_refs);
      if (!storedOperationRefs.success || !storedRunnerRefs.success) {
        return await quarantine('stored revocation binding invalid before heartbeat', 'Stored revocation binding is invalid.');
      }
      const refs = revocationRefsSchema.safeParse([
        ...storedOperationRefs.data,
        `runner:${runner.runner_id}`, `runner-instance:${runner.runner_instance_id}`,
        `identity:${runner.runner_identity_evidence_ref}`, `channel:${runner.channel_binding_sha256}`,
      ]);
      if (!refs.success || JSON.stringify(refs.data) !== JSON.stringify(storedRunnerRefs.data)) {
        return await quarantine('runner revocation binding drifted before heartbeat', 'Runner revocation binding drifted before heartbeat.');
      }
      const revoked = await client.query('SELECT ref FROM swarm_authority_revocations WHERE ref = ANY($1::text[]) LIMIT 1', [refs.data]);
      if (revoked.rows.length) {
        return await quarantine('runner or operation authority revoked before heartbeat', 'Runner or operation authority is revoked.');
      }
      const prepared = await client.query(
        'SELECT binding_digest_sha256,state FROM swarm_authority_prepared_operations WHERE operation_id=$1',
        [request.operation_id],
      );
      if (prepared.rows[0]?.state !== 'ready' || prepared.rows[0]?.binding_digest_sha256 !== request.binding_digest_sha256) {
        return await quarantine('prepared operation unavailable before heartbeat', 'Prepared operation is unavailable or drifted.');
      }
      const hostResult = await client.query(
        `SELECT evidence,capacity_slots,reserved_slots,authorized_slots,
                (authorized_slots IS NOT DISTINCT FROM (SELECT COUNT(*)::integer FROM swarm_authority_reservations
                  WHERE host_id=$1 AND state IN ('start-authorized-not-observed','runner-claimed-not-started','runner-start-observed','stop-requested','runner-never-started-observed'))) AS reconciles
         FROM swarm_authority_hosts WHERE host_id=$1 FOR UPDATE`, [row.host_id],
      );
      const host = hostEvidence(hostResult.rows[0]);
      if (!host || host.status !== 'ready' || !host.secret_readiness || host.host_id !== runner.host_id
        || host.capacity_slots !== Number(hostResult.rows[0]?.capacity_slots)
        || hostResult.rows[0]?.reconciles !== true
        || Date.parse(host.observed_at) > nowMs + 60_000
        || nowMs - Date.parse(host.observed_at) > Number(row.max_host_evidence_age_ms)
        || Date.parse(host.access_review_expires_at) <= nowMs
        || binding.data.capabilities.some((capability) => !host.allowed_capabilities.includes(capability))) {
        return await quarantine('host authority unavailable before heartbeat', 'Host authority is unavailable, stale, or inconsistent.');
      }
      if (!await this.readBudgetWindows(client, request.reservation_id, binding.data.budget_policy_id, binding.data.requested_cost_usd)) {
        return await quarantine('aggregate budget invalid before heartbeat', 'Aggregate budget authority is missing or inconsistent.');
      }
      const budget = await client.query(
        `SELECT (committed_usd IS NOT DISTINCT FROM (SELECT COALESCE(SUM(reserved_cost_usd),0)
                  FROM swarm_authority_reservations WHERE budget_receipt_id=$1
                    AND state IN ('start-authorized-not-observed','runner-claimed-not-started','runner-start-observed','stop-requested','runner-never-started-observed','runner-terminal-observed'))) AS reconciles,
                (reserved_usd+committed_usd <= hard_limit_usd) AS within_ceiling
         FROM swarm_authority_budgets WHERE receipt_id=$1 FOR UPDATE`, [row.budget_receipt_id],
      );
      if (budget.rows.length !== 1 || budget.rows[0].reconciles !== true || budget.rows[0].within_ceiling !== true) {
        return await quarantine('receipt budget invalid before heartbeat', 'Receipt budget authority is missing or inconsistent.');
      }

      const freshClaimExpiryMs = Math.min(
        Date.parse(runner.access_review_expires_at),
        runnerObservedMs + this.maxRunnerEvidenceAgeMs,
        fixedAuthorityCapMs,
      );
      if (!Number.isFinite(freshClaimExpiryMs) || freshClaimExpiryMs <= nowMs) {
        return await quarantine('runner heartbeat had no valid authority interval', 'Runner heartbeat would have no valid authority interval.');
      }
      if (exactRequest) {
        const presentedTokenHistory = await client.query(
          `SELECT reservation_id,sequence FROM swarm_authority_heartbeat_tokens
           WHERE token_sha256=$1`,
          [heartbeatDigest],
        );
        if (row.runner_heartbeat_presented_token_sha256 !== heartbeatDigest
          || row.heartbeat_token_sha256 !== nextHeartbeatDigest
          || presentedTokenHistory.rows.length !== 1
          || presentedTokenHistory.rows[0].reservation_id !== request.reservation_id
          || Number(presentedTokenHistory.rows[0].sequence) !== request.heartbeat_sequence - 1
          || currentClaimExpiryMs > freshClaimExpiryMs) {
          return await quarantine('runner heartbeat replay evidence drifted', 'Runner heartbeat replay evidence drifted.');
        }
        const receipt = receiptFrom(row);
        await client.query('COMMIT');
        return { accepted: true, receipt, blockers: [] };
      }
      if (row.runner_heartbeat_request_id === request.heartbeat_request_id) {
        return await quarantine('runner heartbeat request replay drifted', 'Runner heartbeat request replay drifted.');
      }
      const priorSequence = storedSequence;
      if (!Number.isSafeInteger(priorSequence) || request.heartbeat_sequence !== priorSequence + 1) {
        return await deny('Runner heartbeat sequence is stale, skipped, or already consumed.');
      }
      if (row.heartbeat_token_sha256 !== heartbeatDigest) {
        return await deny('Runner heartbeat credential is invalid or already rotated.');
      }
      const lifecycleDigests = [row.consume_token_sha256, row.cancel_token_sha256, row.lease_claim_token_sha256,
        row.redemption_token_sha256, row.control_token_sha256, row.start_observation_token_sha256,
        row.outcome_token_sha256, row.usage_reconciliation_token_sha256, heartbeatDigest];
      if (lifecycleDigests.includes(nextHeartbeatDigest)) {
        return await deny('Next heartbeat credential aliases an existing lifecycle credential.');
      }
      if (freshClaimExpiryMs <= currentClaimExpiryMs) {
        return await deny('Fresh heartbeat evidence does not extend the live authority interval.');
      }
      const claimAcceptedMs = Date.parse(String(row.runner_claim_accepted_at));
      const maxHeartbeatSequence = Math.max(
        1,
        Math.ceil((fixedAuthorityCapMs - claimAcceptedMs) / this.minRunnerHeartbeatIntervalMs),
      );
      if (!Number.isFinite(claimAcceptedMs) || request.heartbeat_sequence > maxHeartbeatSequence) {
        return await deny('Runner heartbeat exceeds the fixed authority resource bound.');
      }
      const duplicateRequest = await client.query(
        'SELECT reservation_id FROM swarm_authority_reservations WHERE runner_heartbeat_request_id=$1::uuid LIMIT 1',
        [request.heartbeat_request_id],
      );
      if (duplicateRequest.rows.length) return await deny('Runner heartbeat request id is already bound to another reservation.');
      const duplicateToken = await client.query(
         `SELECT reservation_id FROM swarm_authority_heartbeat_tokens WHERE token_sha256=$1
         UNION ALL
         SELECT reservation_id FROM swarm_authority_usage_tokens WHERE token_sha256=$1
         UNION ALL
         SELECT reservation_id FROM swarm_authority_reservations
         WHERE consume_token_sha256=$1 OR cancel_token_sha256=$1 OR lease_claim_token_sha256=$1
           OR redemption_token_sha256=$1 OR control_token_sha256=$1 OR heartbeat_token_sha256=$1
           OR start_observation_token_sha256=$1 OR outcome_token_sha256=$1
           OR usage_reconciliation_token_sha256=$1
           OR runner_heartbeat_presented_token_sha256=$1 OR runner_start_presented_token_sha256=$1
           OR runner_outcome_presented_token_sha256=$1
         LIMIT 1`,
        [nextHeartbeatDigest],
      );
      if (duplicateToken.rows.length) return await deny('Next heartbeat credential was already issued.');
      if (priorSequence > 0) {
        const priorAcceptedMs = Date.parse(String(row.runner_heartbeat_accepted_at));
        if (!Number.isFinite(priorAcceptedMs)) {
          return await quarantine('stored runner heartbeat acceptance time drifted', 'Stored runner heartbeat acceptance time drifted.');
        }
        if (nowMs - priorAcceptedMs < this.minRunnerHeartbeatIntervalMs) {
          // A predictable throttle denial must not itself create an unbounded audit stream.
          await client.query('COMMIT');
          return runnerHeartbeatDenied('Runner heartbeat arrived before the server-owned minimum interval.');
        }
      }

      const heartbeatId = randomUUID();
      const transitioned = await client.query(
        `UPDATE swarm_authority_reservations SET
           runner_heartbeat_id=$2::uuid,runner_heartbeat_request_id=$3::uuid,
           runner_heartbeat_sequence=$4,runner_heartbeat_accepted_at=$5::timestamptz,
           runner_heartbeat_presented_token_sha256=$6,heartbeat_token_sha256=$7,
           runner_claim_expires_at=$8::timestamptz,runner_evidence_observed_at=$9::timestamptz,
           runner_access_review_expires_at=$10::timestamptz,runner_revocation_refs=$11::jsonb
         WHERE reservation_id=$1::uuid AND state IN ('runner-claimed-not-started','runner-start-observed')
           AND heartbeat_token_sha256=$6 RETURNING *`,
        [request.reservation_id, heartbeatId, request.heartbeat_request_id, request.heartbeat_sequence, at,
          heartbeatDigest, nextHeartbeatDigest, new Date(freshClaimExpiryMs).toISOString(),
          runner.observed_at, runner.access_review_expires_at, JSON.stringify(refs.data)],
      );
      if (transitioned.rows.length !== 1) return await deny('Runner heartbeat could not be accepted exactly once.');
      await client.query(
        `INSERT INTO swarm_authority_heartbeat_tokens
         (token_sha256,reservation_id,sequence,issued_by_request_id,issued_at,kind)
         VALUES ($1,$2::uuid,$3,$4::uuid,$5::timestamptz,'heartbeat')`,
        [nextHeartbeatDigest, request.reservation_id, request.heartbeat_sequence,
          request.heartbeat_request_id, at],
      );
      const receipt = receiptFrom(transitioned.rows[0]);
      await client.query(
        `INSERT INTO swarm_authority_audit (event,operation_id,binding_digest_sha256,at,detail)
         VALUES ('runner-heartbeat-accepted',$1,$2,$3::timestamptz,$4::jsonb)`,
        [request.operation_id, request.binding_digest_sha256, at, JSON.stringify(receipt)],
      );
      await client.query('COMMIT');
      return { accepted: true, receipt, blockers: [] };
    } catch (error) {
      await client.query('ROLLBACK');
      await this.recordIntegrityRefusal(client, request.operation_id, request.binding_digest_sha256, {
        action: 'accept-runner-heartbeat', reservation_id: request.reservation_id,
        error: error instanceof Error ? error.message : 'unknown runner-heartbeat failure',
      });
      throw error;
    } finally { client.release?.(); }
  }

  async observeRunnerStart(input: RunnerStartObservationInput): Promise<RunnerStartObservationResult> {
    const parsed = runnerStartObservationInputSchema.safeParse(input);
    if (!parsed.success) return runnerStartObservationDenied('Runner start observation is invalid.');
    const request = parsed.data;
    const client = await this.pool.connect();
    let at = new Date().toISOString();
    const deny = async (blocker: string): Promise<RunnerStartObservationResult> => {
      await client.query(
        `INSERT INTO swarm_authority_audit (event,operation_id,binding_digest_sha256,at,detail)
         VALUES ('runner-start-denied',$1,$2,$3::timestamptz,$4::jsonb)`,
        [request.operation_id, request.binding_digest_sha256, at, JSON.stringify({
          reservation_id: request.reservation_id, claim_id: request.claim_id,
          observation_request_id: request.observation_request_id, blockers: [blocker],
        })],
      );
      await client.query('COMMIT');
      return runnerStartObservationDenied(blocker);
    };
    const receiptFrom = (row: Record<string, unknown>): RunnerStartObservationReceipt => ({
      schema_version: 'starlight.runner_start_observation.v1',
      observation_id: String(row.runner_start_observation_id),
      observation_request_id: String(row.runner_start_observation_request_id),
      claim_id: request.claim_id,
      reservation_id: request.reservation_id,
      operation_id: request.operation_id,
      effect_id: request.effect_id,
      binding_digest_sha256: request.binding_digest_sha256,
      runner_id: String(row.runner_id),
      runner_instance_id: String(row.runner_instance_id),
      runtime_id: String(row.runner_runtime_id),
      host_id: String(row.runner_host_id),
      channel_binding_sha256: String(row.runner_channel_binding_sha256),
      process_instance_sha256: String(row.runner_process_instance_sha256),
      evidence_ref: String(row.runner_start_evidence_ref),
      evidence_sha256: String(row.runner_start_evidence_sha256),
      process_started_at: sqlInstant(row.runner_process_started_at),
      evidence_observed_at: sqlInstant(row.runner_start_evidence_observed_at),
      accepted_at: sqlInstant(row.runner_start_observation_accepted_at),
      transport_state: 'attested-not-deployed',
      dispatch_state: 'not-dispatched',
      execution_observed: true,
      workload_effect_observed: false,
      state: 'runner-start-observed',
    });
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL search_path = pg_catalog, public, pg_temp');
      if (!await lockAuthority(client)) return await deny('Authority serialization control row is missing or ambiguous.');
      at = await wallClock(client);
      const nowMs = Date.parse(at);

      const brokerAttestation = await this.brokerSessionAttestor(client);
      if (!brokerAttestation.valid) {
        return await deny(`Broker database session is not authorized: ${brokerAttestation.blockers.join(' ')}`);
      }
      const runnerAttestation = await this.runnerSessionAttestor(client);
      if (!runnerAttestation.valid) {
        return await deny(`Runner transport session is not authorized: ${runnerAttestation.blockers.join(' ')}`);
      }
      const parsedRunner = runnerSessionSchema.safeParse(runnerAttestation.session);
      if (!parsedRunner.success) return await deny('Runner transport attestation is malformed.');
      const runner = parsedRunner.data;
      const startAttestation = await this.runnerStartEvidenceAttestor(client);
      if (!startAttestation.valid) {
        return await deny(`Runner start evidence is not authorized: ${startAttestation.blockers.join(' ')}`);
      }
      const parsedEvidence = runnerStartEvidenceSchema.safeParse(startAttestation.evidence);
      if (!parsedEvidence.success) return await deny('Runner start evidence is malformed.');
      const evidence = parsedEvidence.data;
      const runnerObservedMs = Date.parse(runner.observed_at);
      const evidenceObservedMs = Date.parse(evidence.observed_at);
      if (runnerObservedMs > nowMs + 60_000 || nowMs - runnerObservedMs > this.maxRunnerEvidenceAgeMs
        || evidenceObservedMs > nowMs) {
        return await deny('Runner transport or start evidence is stale or from the future.');
      }
      if (Date.parse(runner.access_review_expires_at) <= nowMs
        || Date.parse(evidence.access_review_expires_at) <= nowMs) {
        return await deny('Runner transport or start-evidence access review is expired.');
      }
      if (evidence.reservation_id !== request.reservation_id || evidence.claim_id !== request.claim_id
        || evidence.operation_id !== request.operation_id || evidence.effect_id !== request.effect_id
        || evidence.binding_digest_sha256 !== request.binding_digest_sha256) {
        return await deny('Server-owned start evidence does not bind the requested operation and claim.');
      }
      if (evidence.runner_id !== runner.runner_id
        || evidence.runner_identity_evidence_ref !== runner.runner_identity_evidence_ref
        || evidence.runner_instance_id !== runner.runner_instance_id || evidence.runtime_id !== runner.runtime_id
        || evidence.host_id !== runner.host_id || evidence.channel_binding_sha256 !== runner.channel_binding_sha256
        || evidence.launch_attempt_id !== runner.launch_attempt_id
        || evidence.fencing_generation !== runner.fencing_generation) {
        return await deny('Server-owned start evidence does not match the authenticated runner session.');
      }

      const startTokenDigest = createHash('sha256').update(request.start_observation_token, 'utf8').digest('hex');
      const found = await client.query(
        `SELECT *,
                (reserved_cost_usd IS NOT DISTINCT FROM (binding->>'requested_cost_usd')::numeric) AS cost_matches_binding
         FROM swarm_authority_reservations
         WHERE reservation_id=$1::uuid AND runner_claim_id=$2::uuid FOR UPDATE`,
        [request.reservation_id, request.claim_id],
      );
      const row = found.rows[0];
      if (!row) return await deny('Runner claim does not exist.');
      if (row.operation_id !== request.operation_id || row.effect_id !== request.effect_id
        || row.binding_digest_sha256 !== request.binding_digest_sha256) {
        return await deny('Runner start observation does not match the claimed operation.');
      }
      if (row.state === 'runner-never-started-observed') {
        const generationMatches = row.start_observation_token_sha256 === startTokenDigest
          && row.runner_id === runner.runner_id
          && row.runner_identity_evidence_ref === runner.runner_identity_evidence_ref
          && row.runner_instance_id === runner.runner_instance_id
          && row.runner_runtime_id === runner.runtime_id
          && row.runner_host_id === runner.host_id
          && row.runner_channel_binding_sha256 === runner.channel_binding_sha256
          && row.runner_launch_attempt_id === runner.launch_attempt_id
          && Number(row.runner_fencing_generation) === runner.fencing_generation
          && Date.parse(evidence.process_started_at) >= Date.parse(String(row.runner_claim_accepted_at));
        if (!generationMatches) {
          return await deny('Contradictory start evidence does not match the settled execution generation.');
        }
        const duplicate = await client.query(
          `SELECT reservation_id FROM swarm_authority_reservations
           WHERE runner_start_observation_request_id=$1::uuid OR runner_process_instance_sha256=$2
             OR runner_start_evidence_ref=$3 OR runner_start_evidence_sha256=$4 LIMIT 1`,
          [request.observation_request_id, evidence.process_instance_sha256, evidence.evidence_ref, evidence.evidence_sha256],
        );
        if (duplicate.rows.length) return await deny('Contradictory start request or evidence is already bound.');
        const conflicted = await client.query(
          `UPDATE swarm_authority_reservations SET state='stop-requested',
             runner_start_observation_id=$2::uuid,runner_start_observation_request_id=$3::uuid,
             runner_start_observation_accepted_at=$4::timestamptz,
             runner_start_evidence_observed_at=$5::timestamptz,runner_process_started_at=$6::timestamptz,
             runner_process_instance_sha256=$7,runner_start_evidence_ref=$8,
             runner_start_evidence_sha256=$9,runner_start_presented_token_sha256=$10
           WHERE reservation_id=$1::uuid AND state='runner-never-started-observed'
             AND start_observation_token_sha256=$10 RETURNING reservation_id`,
          [request.reservation_id, randomUUID(), request.observation_request_id, at,
            evidence.observed_at, evidence.process_started_at, evidence.process_instance_sha256,
            evidence.evidence_ref, evidence.evidence_sha256, startTokenDigest],
        );
        if (conflicted.rows.length !== 1) return await deny('Contradictory start evidence lost its quarantine race.');
        await client.query(
          `INSERT INTO swarm_authority_audit (event,operation_id,binding_digest_sha256,at,detail)
           VALUES ('stop-requested',$1,$2,$3::timestamptz,$4::jsonb)`,
          [request.operation_id, request.binding_digest_sha256, at, JSON.stringify({
            reservation_id: request.reservation_id, claim_id: request.claim_id,
            reason: 'authenticated start evidence contradicted settled never-started evidence',
            execution_state: 'conflicted', released_cost_usd: 0, released_host_slots: 0,
          })],
        );
        await client.query('COMMIT');
        return runnerStartObservationDenied('Authenticated start evidence contradicted never-started evidence; authority is quarantined.');
      }
      const exactRequest = row.state === 'runner-start-observed'
        && row.runner_start_observation_request_id === request.observation_request_id;
      const quarantine = async (reason: string, blocker: string): Promise<RunnerStartObservationResult> => {
        const stopped = await client.query(
          `UPDATE swarm_authority_reservations SET state='stop-requested'
           WHERE reservation_id=$1::uuid AND state IN ('runner-claimed-not-started','runner-start-observed')
           RETURNING reservation_id`,
          [request.reservation_id],
        );
        if (stopped.rows.length !== 1) return await deny('Runner-start quarantine lost its authority race.');
        await client.query(
          `INSERT INTO swarm_authority_audit (event,operation_id,binding_digest_sha256,at,detail)
           VALUES ('stop-requested',$1,$2,$3::timestamptz,$4::jsonb)`,
          [request.operation_id, request.binding_digest_sha256, at, JSON.stringify({
            reservation_id: request.reservation_id, claim_id: request.claim_id, reason,
            execution_state: exactRequest ? 'started-or-unknown' : 'unknown', released_cost_usd: 0,
          })],
        );
        await client.query('COMMIT');
        return runnerStartObservationDenied(blocker);
      };
      if (row.state === 'runner-start-observed' && !exactRequest) {
        return await deny('A different start observation already owns this runner claim.');
      }
      if (row.state !== 'runner-claimed-not-started' && !exactRequest) {
        return await deny(`Runner start cannot be observed from state ${String(row.state)}.`);
      }
      if (!exactRequest && nowMs - evidenceObservedMs > this.maxRunnerEvidenceAgeMs) {
        return await deny('Runner start evidence is stale.');
      }

      const binding = operationBindingSchema.safeParse(row.binding);
      if (!binding.success || sha256Digest(binding.data) !== row.binding_digest_sha256 || row.cost_matches_binding !== true) {
        return await quarantine('stored binding invalid before runner start observation', 'Stored reservation binding or signed cost is invalid.');
      }
      const fixedAuthorityCapMs = Math.min(
        Date.parse(String(row.reservation_expires_at)),
        Date.parse(String(row.lease_expires_at)),
        Date.parse(String(row.start_authorized_at)) + binding.data.timeout_ms,
      );
      const currentEvidenceObservedMs = Date.parse(String(row.runner_evidence_observed_at));
      const currentAccessReviewExpiresMs = Date.parse(String(row.runner_access_review_expires_at));
      const currentClaimExpiryMs = Date.parse(String(row.runner_claim_expires_at));
      const currentAuthorityCapMs = Math.min(
        currentAccessReviewExpiresMs,
        currentEvidenceObservedMs + this.maxRunnerEvidenceAgeMs,
        fixedAuthorityCapMs,
      );
      if (!Number.isFinite(currentAuthorityCapMs) || currentClaimExpiryMs !== currentAuthorityCapMs
        || currentClaimExpiryMs <= nowMs) {
        return await quarantine('runner authority expired or drifted before start observation', 'Runner authority expired or drifted before start observation.');
      }
      const claimAcceptedMs = Date.parse(String(row.runner_claim_accepted_at));
      const latestLivenessAtMs = row.runner_heartbeat_accepted_at === null
        ? claimAcceptedMs : Date.parse(String(row.runner_heartbeat_accepted_at));
      const storedProcessStartedMs = Date.parse(String(row.runner_process_started_at));
      const storedStartEvidenceObservedMs = Date.parse(String(row.runner_start_evidence_observed_at));
      const storedStartAcceptedMs = Date.parse(String(row.runner_start_observation_accepted_at));
      const storedChronologyInvalid = exactRequest && (
        !Number.isFinite(storedProcessStartedMs) || !Number.isFinite(storedStartEvidenceObservedMs)
        || !Number.isFinite(storedStartAcceptedMs) || storedProcessStartedMs < claimAcceptedMs
        || storedProcessStartedMs > storedStartEvidenceObservedMs
        || storedStartEvidenceObservedMs > storedStartAcceptedMs
        || storedStartAcceptedMs >= currentClaimExpiryMs
      );
      if (Date.parse(evidence.process_started_at) < claimAcceptedMs
        || (!exactRequest && evidenceObservedMs < latestLivenessAtMs)
        || evidenceObservedMs > nowMs || storedChronologyInvalid) {
        return await quarantine('runner start chronology drifted', 'Runner start evidence chronology is invalid.');
      }
      const storedCredentialDigests = [
        row.consume_token_sha256, row.cancel_token_sha256, row.lease_claim_token_sha256,
        row.redemption_token_sha256, row.control_token_sha256, row.heartbeat_token_sha256,
        row.start_observation_token_sha256, row.outcome_token_sha256,
        row.usage_reconciliation_token_sha256,
      ];
      if (storedCredentialDigests.some((digest) => typeof digest !== 'string')
        || new Set(storedCredentialDigests).size !== storedCredentialDigests.length
        || row.start_observation_token_sha256 !== startTokenDigest) {
        return exactRequest
          ? await quarantine('start-observation credential drifted on retry', 'Start-observation credential drifted on retry.')
          : await deny('Start-observation credential is invalid or aliases another lifecycle credential.');
      }
      if (runner.runner_id !== binding.data.execution_identity
        || runner.runner_identity_evidence_ref !== binding.data.identity_evidence_ref
        || runner.runtime_id !== binding.data.runtime_id || runner.host_id !== row.host_id
        || row.runner_id !== runner.runner_id || row.runner_identity_evidence_ref !== runner.runner_identity_evidence_ref
        || row.runner_instance_id !== runner.runner_instance_id || row.runner_runtime_id !== runner.runtime_id
        || row.runner_host_id !== runner.host_id || row.runner_channel_binding_sha256 !== runner.channel_binding_sha256
        || row.runner_launch_attempt_id !== runner.launch_attempt_id
        || Number(row.runner_fencing_generation) !== runner.fencing_generation) {
        return await quarantine('runner identity or channel drifted before start observation', 'Runner identity, placement, or channel drifted before start observation.');
      }
      if (row.broker_database_role !== brokerAttestation.session.database_role
        || row.broker_database_name !== brokerAttestation.session.database_name
        || row.broker_role_contract_sha256 !== brokerAttestation.session.contract_digest_sha256
        || row.broker_role_contract_sha256 !== BROKER_DATABASE_ROLE_CONTRACT_SHA256) {
        return await quarantine('authenticated broker principal drifted before start observation', 'Authenticated broker principal drifted before start observation.');
      }
      const principal = await client.query(
        `SELECT database_role,database_name,broker_execution_identity,broker_identity_evidence_ref,
                authn_kind,role_contract_digest_sha256,observed_at,access_review_expires_at,state,evidence
         FROM swarm_authority_broker_principals
         WHERE database_role=$1 AND database_name=$2`,
        [brokerAttestation.session.database_role, brokerAttestation.session.database_name],
      );
      const principalEvidence = brokerPrincipalEvidenceSchema.safeParse(principal.rows[0]?.evidence);
      const principalRow = principal.rows[0];
      const principalCurrent = principal.rows.length === 1 && principalEvidence.success
        && principalEvidence.data.database_role === principalRow.database_role
        && principalEvidence.data.database_name === principalRow.database_name
        && principalEvidence.data.broker_execution_identity === principalRow.broker_execution_identity
        && principalEvidence.data.broker_identity_evidence_ref === principalRow.broker_identity_evidence_ref
        && principalEvidence.data.authn_kind === principalRow.authn_kind
        && principalEvidence.data.role_contract_digest_sha256 === principalRow.role_contract_digest_sha256
        && principalEvidence.data.state === principalRow.state
        && sqlInstant(principalEvidence.data.observed_at) === sqlInstant(principalRow.observed_at)
        && sqlInstant(principalEvidence.data.access_review_expires_at) === sqlInstant(principalRow.access_review_expires_at)
        && principalEvidence.data.state === 'ready'
        && principalEvidence.data.database_role === brokerAttestation.session.database_role
        && principalEvidence.data.database_name === brokerAttestation.session.database_name
        && principalEvidence.data.broker_execution_identity === row.broker_execution_identity
        && principalEvidence.data.broker_identity_evidence_ref === row.broker_identity_evidence_ref
        && principalEvidence.data.role_contract_digest_sha256 === BROKER_DATABASE_ROLE_CONTRACT_SHA256
        && Date.parse(principalEvidence.data.observed_at) <= nowMs + 60_000
        && nowMs - Date.parse(principalEvidence.data.observed_at) <= this.maxBrokerEvidenceAgeMs
        && Date.parse(principalEvidence.data.access_review_expires_at) > nowMs;
      if (!principalCurrent) {
        return await quarantine('broker principal unavailable before start observation', 'Broker principal is unavailable, stale, disabled, or drifted.');
      }

      const storedOperationRefs = revocationRefsSchema.safeParse(row.revocation_refs);
      const storedRunnerRefs = revocationRefsSchema.safeParse(row.runner_revocation_refs);
      if (!storedOperationRefs.success || !storedRunnerRefs.success) {
        return await quarantine('stored revocation binding invalid before start observation', 'Stored revocation binding is invalid.');
      }
      const refs = revocationRefsSchema.safeParse([
        ...storedOperationRefs.data,
        `runner:${runner.runner_id}`, `runner-instance:${runner.runner_instance_id}`,
        `identity:${runner.runner_identity_evidence_ref}`, `channel:${runner.channel_binding_sha256}`,
      ]);
      if (!refs.success || JSON.stringify(refs.data) !== JSON.stringify(storedRunnerRefs.data)) {
        return await quarantine('runner revocation binding drifted before start observation', 'Runner revocation binding drifted before start observation.');
      }
      const revoked = await client.query('SELECT ref FROM swarm_authority_revocations WHERE ref = ANY($1::text[]) LIMIT 1', [refs.data]);
      if (revoked.rows.length) {
        return await quarantine('runner or operation authority revoked before start observation', 'Runner or operation authority is revoked.');
      }
      const prepared = await client.query(
        'SELECT binding_digest_sha256,state FROM swarm_authority_prepared_operations WHERE operation_id=$1',
        [request.operation_id],
      );
      if (prepared.rows[0]?.state !== 'ready' || prepared.rows[0]?.binding_digest_sha256 !== request.binding_digest_sha256) {
        return await quarantine('prepared operation unavailable before start observation', 'Prepared operation is unavailable or drifted.');
      }
      const hostResult = await client.query(
        `SELECT evidence,capacity_slots,reserved_slots,authorized_slots,
                (authorized_slots IS NOT DISTINCT FROM (SELECT COUNT(*)::integer FROM swarm_authority_reservations
                  WHERE host_id=$1 AND state IN ('start-authorized-not-observed','runner-claimed-not-started','runner-start-observed','stop-requested','runner-never-started-observed'))) AS reconciles
         FROM swarm_authority_hosts WHERE host_id=$1 FOR UPDATE`, [row.host_id],
      );
      const host = hostEvidence(hostResult.rows[0]);
      if (!host || host.status !== 'ready' || !host.secret_readiness || host.host_id !== runner.host_id
        || host.capacity_slots !== Number(hostResult.rows[0]?.capacity_slots)
        || hostResult.rows[0]?.reconciles !== true
        || Date.parse(host.observed_at) > nowMs + 60_000
        || nowMs - Date.parse(host.observed_at) > Number(row.max_host_evidence_age_ms)
        || Date.parse(host.access_review_expires_at) <= nowMs
        || binding.data.capabilities.some((capability) => !host.allowed_capabilities.includes(capability))) {
        return await quarantine('host authority unavailable before start observation', 'Host authority is unavailable, stale, or inconsistent.');
      }
      if (!await this.readBudgetWindows(client, request.reservation_id, binding.data.budget_policy_id, binding.data.requested_cost_usd)) {
        return await quarantine('aggregate budget invalid before start observation', 'Aggregate budget authority is missing or inconsistent.');
      }
      const budget = await client.query(
        `SELECT (committed_usd IS NOT DISTINCT FROM (SELECT COALESCE(SUM(reserved_cost_usd),0)
                  FROM swarm_authority_reservations WHERE budget_receipt_id=$1
                    AND state IN ('start-authorized-not-observed','runner-claimed-not-started','runner-start-observed','stop-requested','runner-never-started-observed','runner-terminal-observed'))) AS reconciles,
                (reserved_usd+committed_usd <= hard_limit_usd) AS within_ceiling
         FROM swarm_authority_budgets WHERE receipt_id=$1 FOR UPDATE`, [row.budget_receipt_id],
      );
      if (budget.rows.length !== 1 || budget.rows[0].reconciles !== true || budget.rows[0].within_ceiling !== true) {
        return await quarantine('receipt budget invalid before start observation', 'Receipt budget authority is missing or inconsistent.');
      }

      if (exactRequest) {
        if (row.runner_start_presented_token_sha256 !== startTokenDigest
          || row.runner_process_instance_sha256 !== evidence.process_instance_sha256
          || row.runner_start_evidence_ref !== evidence.evidence_ref
          || row.runner_start_evidence_sha256 !== evidence.evidence_sha256
          || sqlInstant(row.runner_process_started_at) !== sqlInstant(evidence.process_started_at)
          || sqlInstant(row.runner_start_evidence_observed_at) !== sqlInstant(evidence.observed_at)) {
          return await quarantine('runner start replay evidence drifted', 'Runner start replay evidence drifted.');
        }
        const receipt = receiptFrom(row);
        await client.query('COMMIT');
        return { observed: true, receipt, blockers: [] };
      }
      const duplicates = await client.query(
        `SELECT reservation_id FROM swarm_authority_reservations
         WHERE runner_start_observation_request_id=$1::uuid OR runner_process_instance_sha256=$2
           OR runner_start_evidence_ref=$3 OR runner_start_evidence_sha256=$4 LIMIT 1`,
        [request.observation_request_id, evidence.process_instance_sha256, evidence.evidence_ref, evidence.evidence_sha256],
      );
      if (duplicates.rows.length) return await deny('Runner start request or evidence is already bound to another reservation.');

      const observationId = randomUUID();
      const transitioned = await client.query(
        `UPDATE swarm_authority_reservations SET state='runner-start-observed',
           runner_start_observation_id=$2::uuid,runner_start_observation_request_id=$3::uuid,
           runner_start_observation_accepted_at=$4::timestamptz,
           runner_start_evidence_observed_at=$5::timestamptz,runner_process_started_at=$6::timestamptz,
           runner_process_instance_sha256=$7,runner_start_evidence_ref=$8,
           runner_start_evidence_sha256=$9,runner_start_presented_token_sha256=$10
         WHERE reservation_id=$1::uuid AND state='runner-claimed-not-started'
           AND start_observation_token_sha256=$10 RETURNING *`,
        [request.reservation_id, observationId, request.observation_request_id, at,
          evidence.observed_at, evidence.process_started_at, evidence.process_instance_sha256,
          evidence.evidence_ref, evidence.evidence_sha256, startTokenDigest],
      );
      if (transitioned.rows.length !== 1) return await deny('Runner start observation could not be accepted exactly once.');
      const receipt = receiptFrom(transitioned.rows[0]);
      await client.query(
        `INSERT INTO swarm_authority_audit (event,operation_id,binding_digest_sha256,at,detail)
         VALUES ('runner-start-observed',$1,$2,$3::timestamptz,$4::jsonb)`,
        [request.operation_id, request.binding_digest_sha256, at, JSON.stringify(receipt)],
      );
      await client.query('COMMIT');
      return { observed: true, receipt, blockers: [] };
    } catch (error) {
      await client.query('ROLLBACK');
      await this.recordIntegrityRefusal(client, request.operation_id, request.binding_digest_sha256, {
        action: 'observe-runner-start', reservation_id: request.reservation_id,
        error: error instanceof Error ? error.message : 'unknown runner-start observation failure',
      });
      throw error;
    } finally { client.release?.(); }
  }

  async settleRunnerOutcome(input: RunnerOutcomeInput): Promise<RunnerOutcomeResult> {
    const parsed = runnerOutcomeInputSchema.safeParse(input);
    if (!parsed.success) return runnerOutcomeDenied('Runner outcome request is invalid.');
    const request = parsed.data;
    const client = await this.pool.connect();
    let at = new Date().toISOString();
    const deny = async (blocker: string): Promise<RunnerOutcomeResult> => {
      await client.query(
        `INSERT INTO swarm_authority_audit (event,operation_id,binding_digest_sha256,at,detail)
         VALUES ('runner-outcome-denied',$1,$2,$3::timestamptz,$4::jsonb)`,
        [request.operation_id, request.binding_digest_sha256, at, JSON.stringify({
          reservation_id: request.reservation_id, claim_id: request.claim_id,
          outcome_request_id: request.outcome_request_id, blockers: [blocker],
        })],
      );
      await client.query('COMMIT');
      return runnerOutcomeDenied(blocker);
    };
    const receiptFrom = (row: Record<string, unknown>): RunnerOutcomeReceipt => ({
      schema_version: 'starlight.runner_outcome.v1',
      outcome_id: String(row.runner_outcome_id),
      outcome_request_id: String(row.runner_outcome_request_id),
      outcome_event_id: String(row.runner_outcome_event_id),
      outcome_kind: row.runner_outcome_kind as 'never-started' | 'process-terminal',
      claim_id: String(row.runner_claim_id),
      reservation_id: String(row.reservation_id),
      operation_id: String(row.operation_id),
      effect_id: String(row.effect_id),
      binding_digest_sha256: String(row.binding_digest_sha256),
      runner_id: String(row.runner_id),
      runner_instance_id: String(row.runner_instance_id),
      runtime_id: String(row.runner_runtime_id),
      host_id: String(row.runner_host_id),
      channel_binding_sha256: String(row.runner_channel_binding_sha256),
      launch_attempt_id: String(row.runner_launch_attempt_id),
      fencing_generation: Number(row.runner_fencing_generation),
      process_instance_sha256: row.runner_process_instance_sha256 === null ? null : String(row.runner_process_instance_sha256),
      exit_disposition: row.runner_exit_disposition === null ? null
        : row.runner_exit_disposition as RunnerOutcomeReceipt['exit_disposition'],
      evidence_ref: String(row.runner_outcome_evidence_ref),
      evidence_sha256: String(row.runner_outcome_evidence_sha256),
      outcome_at: sqlInstant(row.runner_outcome_at),
      evidence_observed_at: sqlInstant(row.runner_outcome_evidence_observed_at),
      accepted_at: sqlInstant(row.runner_outcome_accepted_at),
      remote_stop_confirmed: row.runner_remote_stop_confirmed === true,
      restart_fenced: true,
      launch_queue_closed: true,
      descendants_quiesced: true,
      transport_state: 'attested-not-deployed',
      dispatch_state: 'not-dispatched',
      execution_observed: row.runner_outcome_kind === 'process-terminal',
      workload_effect_observed: false,
      actual_usage_reconciled: false,
      host_capacity_released: row.state === 'runner-terminal-observed',
      budget_commitment_released: false,
      released_host_slots: row.state === 'runner-terminal-observed' ? 1 : 0,
      released_cost_usd: 0,
      retained_committed_cost_usd: Number(row.committed_cost_usd),
      state: row.state as 'runner-never-started-observed' | 'runner-terminal-observed',
    });
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL search_path = pg_catalog, public, pg_temp');
      if (!await lockAuthority(client)) return await deny('Authority serialization control row is missing or ambiguous.');
      at = await wallClock(client);
      const nowMs = Date.parse(at);

      const brokerAttestation = await this.brokerSessionAttestor(client);
      if (!brokerAttestation.valid) {
        return await deny(`Broker database session is not authorized: ${brokerAttestation.blockers.join(' ')}`);
      }
      const outcomeAttestation = await this.runnerOutcomeEvidenceAttestor(client);
      if (!outcomeAttestation.valid) {
        return await deny(`Runner outcome evidence is unavailable: ${outcomeAttestation.blockers.join(' ')}`);
      }
      const parsedEvidence = runnerOutcomeEvidenceSchema.safeParse(outcomeAttestation.evidence);
      if (!parsedEvidence.success) return await deny('Runner outcome evidence is malformed.');
      const evidence = parsedEvidence.data;
      const outcomeDigest = createHash('sha256').update(request.outcome_token, 'utf8').digest('hex');
      const found = await client.query(
        `SELECT *,
                (reserved_cost_usd IS NOT DISTINCT FROM (binding->>'requested_cost_usd')::numeric) AS cost_matches_binding
         FROM swarm_authority_reservations
         WHERE reservation_id=$1::uuid AND runner_claim_id=$2::uuid AND outcome_token_sha256=$3 FOR UPDATE`,
        [request.reservation_id, request.claim_id, outcomeDigest],
      );
      const row = found.rows[0];
      if (!row) return await deny('Runner claim does not exist or the outcome credential is invalid.');
      if (row.operation_id !== request.operation_id || row.effect_id !== request.effect_id
        || row.binding_digest_sha256 !== request.binding_digest_sha256) {
        return await deny('Runner outcome request does not match the claimed operation.');
      }
      if (row.broker_database_role !== brokerAttestation.session.database_role
        || row.broker_database_name !== brokerAttestation.session.database_name
        || row.broker_role_contract_sha256 !== BROKER_DATABASE_ROLE_CONTRACT_SHA256
        || brokerAttestation.session.contract_digest_sha256 !== BROKER_DATABASE_ROLE_CONTRACT_SHA256) {
        return await deny('Authenticated broker database session does not match the claimed operation.');
      }
      const principal = await client.query(
        `SELECT database_role,database_name,broker_execution_identity,broker_identity_evidence_ref,
                authn_kind,role_contract_digest_sha256,observed_at,access_review_expires_at,state,evidence
         FROM swarm_authority_broker_principals
         WHERE database_role=$1 AND database_name=$2`,
        [brokerAttestation.session.database_role, brokerAttestation.session.database_name],
      );
      const principalRow = principal.rows[0];
      const principalEvidence = brokerPrincipalEvidenceSchema.safeParse(principalRow?.evidence);
      const principalCurrent = principal.rows.length === 1 && principalEvidence.success
        && principalEvidence.data.database_role === principalRow.database_role
        && principalEvidence.data.database_name === principalRow.database_name
        && principalEvidence.data.broker_execution_identity === principalRow.broker_execution_identity
        && principalEvidence.data.broker_identity_evidence_ref === principalRow.broker_identity_evidence_ref
        && principalEvidence.data.authn_kind === principalRow.authn_kind
        && principalEvidence.data.role_contract_digest_sha256 === principalRow.role_contract_digest_sha256
        && principalEvidence.data.state === principalRow.state
        && sqlInstant(principalEvidence.data.observed_at) === sqlInstant(principalRow.observed_at)
        && sqlInstant(principalEvidence.data.access_review_expires_at) === sqlInstant(principalRow.access_review_expires_at)
        && principalEvidence.data.state === 'ready'
        && principalEvidence.data.broker_execution_identity === row.broker_execution_identity
        && principalEvidence.data.broker_identity_evidence_ref === row.broker_identity_evidence_ref
        && principalEvidence.data.role_contract_digest_sha256 === BROKER_DATABASE_ROLE_CONTRACT_SHA256
        && Date.parse(principalEvidence.data.observed_at) <= nowMs
        && nowMs - Date.parse(principalEvidence.data.observed_at) <= this.maxBrokerEvidenceAgeMs
        && Date.parse(principalEvidence.data.access_review_expires_at) > nowMs;
      if (!principalCurrent) return await deny('Broker principal is unavailable, stale, disabled, or drifted.');

      const expectedState = evidence.outcome_kind === 'never-started'
        ? 'runner-never-started-observed' : 'runner-terminal-observed';
      const exactRetry = row.state === expectedState
        && row.runner_outcome_request_id === request.outcome_request_id;
      if (row.state === 'runner-never-started-observed' || row.state === 'runner-terminal-observed') {
        if (!exactRetry) return await deny('A different immutable runner outcome already settled this claim.');
      }

      const binding = operationBindingSchema.safeParse(row.binding);
      if (!binding.success || sha256Digest(binding.data) !== row.binding_digest_sha256
        || row.cost_matches_binding !== true || row.committed_cost_usd !== row.reserved_cost_usd) {
        return await deny('Stored operation or committed cost is invalid or drifted.');
      }
      const bindingsMatch = evidence.reservation_id === request.reservation_id
        && evidence.claim_id === request.claim_id
        && evidence.operation_id === request.operation_id
        && evidence.effect_id === request.effect_id
        && evidence.binding_digest_sha256 === request.binding_digest_sha256
        && evidence.runner_id === row.runner_id
        && evidence.runner_identity_evidence_ref === row.runner_identity_evidence_ref
        && evidence.runner_instance_id === row.runner_instance_id
        && evidence.runtime_id === row.runner_runtime_id
        && evidence.host_id === row.runner_host_id
        && evidence.channel_binding_sha256 === row.runner_channel_binding_sha256
        && evidence.launch_attempt_id === row.runner_launch_attempt_id
        && evidence.fencing_generation === Number(row.runner_fencing_generation);
      if (!bindingsMatch) return await deny('Runner outcome evidence is bound to another execution generation.');

      const outcomeMs = Date.parse(evidence.outcome_at);
      const observedMs = Date.parse(evidence.observed_at);
      if (outcomeMs < Date.parse(String(row.runner_claim_accepted_at))
        || observedMs > nowMs || nowMs - observedMs > this.maxRunnerEvidenceAgeMs
        || Date.parse(evidence.access_review_expires_at) <= nowMs) {
        return await deny('Runner outcome evidence chronology is invalid, stale, or expired.');
      }
      const hasStart = row.runner_start_observation_id !== null
        || row.runner_process_instance_sha256 !== null
        || row.runner_start_evidence_ref !== null
        || row.runner_start_evidence_sha256 !== null;
      if (exactRetry) {
        const retryDrifted = row.runner_outcome_event_id !== evidence.outcome_event_id
          || row.runner_outcome_kind !== evidence.outcome_kind
          || row.runner_outcome_evidence_ref !== evidence.evidence_ref
          || row.runner_outcome_evidence_sha256 !== evidence.evidence_sha256
          || row.runner_outcome_presented_token_sha256 !== outcomeDigest
          || row.runner_exit_disposition !== evidence.exit_disposition
          || sqlInstant(row.runner_outcome_at) !== sqlInstant(evidence.outcome_at)
          || sqlInstant(row.runner_outcome_evidence_observed_at) !== sqlInstant(evidence.observed_at)
          || row.runner_remote_stop_confirmed !== evidence.remote_stop_confirmed
          || (evidence.outcome_kind === 'never-started' && hasStart)
          || (evidence.outcome_kind === 'process-terminal' && (
            !hasStart
            || evidence.process_instance_sha256 !== row.runner_process_instance_sha256
            || evidence.start_observation_id !== row.runner_start_observation_id
            || evidence.start_evidence_ref !== row.runner_start_evidence_ref
            || evidence.start_evidence_sha256 !== row.runner_start_evidence_sha256
            || sqlInstant(evidence.process_started_at) !== sqlInstant(row.runner_process_started_at)
          ));
        if (retryDrifted) return await deny('Runner outcome retry evidence drifted.');
        const receipt = receiptFrom(row);
        await client.query('COMMIT');
        return { settled: true, receipt, blockers: [] };
      }
      if (!['runner-claimed-not-started', 'runner-start-observed', 'stop-requested'].includes(String(row.state))) {
        return await deny(`Runner outcome cannot be settled from state ${String(row.state)}.`);
      }
      if (evidence.outcome_kind === 'never-started') {
        if (row.state === 'runner-start-observed' || hasStart) {
          return await deny('Never-started evidence cannot settle an execution with start evidence.');
        }
      } else {
        if ((row.state !== 'runner-start-observed' && row.state !== 'stop-requested') || !hasStart
          || evidence.process_instance_sha256 !== row.runner_process_instance_sha256
          || evidence.start_observation_id !== row.runner_start_observation_id
          || evidence.start_evidence_ref !== row.runner_start_evidence_ref
          || evidence.start_evidence_sha256 !== row.runner_start_evidence_sha256
          || sqlInstant(evidence.process_started_at) !== sqlInstant(row.runner_process_started_at)
          || outcomeMs < Date.parse(String(row.runner_process_started_at))) {
          return await deny('Process-terminal evidence does not match the stored start observation.');
        }
      }

      const duplicate = await client.query(
        `SELECT reservation_id FROM swarm_authority_reservations
         WHERE runner_outcome_request_id=$1::uuid OR runner_outcome_event_id=$2::uuid
           OR runner_outcome_evidence_ref=$3 OR runner_outcome_evidence_sha256=$4 LIMIT 1`,
        [request.outcome_request_id, evidence.outcome_event_id, evidence.evidence_ref, evidence.evidence_sha256],
      );
      if (duplicate.rows.length) return await deny('Runner outcome request or evidence is already bound to another reservation.');

      if (!await this.readBudgetWindows(client, request.reservation_id, binding.data.budget_policy_id, binding.data.requested_cost_usd)) {
        return await deny('Committed aggregate budget authority is missing or inconsistent.');
      }
      const budget = await client.query(
        `SELECT (committed_usd IS NOT DISTINCT FROM (SELECT COALESCE(SUM(reserved_cost_usd),0)
                  FROM swarm_authority_reservations WHERE budget_receipt_id=$1
                    AND state IN ('start-authorized-not-observed','runner-claimed-not-started','runner-start-observed','stop-requested','runner-never-started-observed','runner-terminal-observed'))) AS reconciles
         FROM swarm_authority_budgets WHERE receipt_id=$1 FOR UPDATE`,
        [row.budget_receipt_id],
      );
      if (budget.rows.length !== 1 || budget.rows[0].reconciles !== true) {
        return await deny('Committed receipt budget authority is missing or inconsistent.');
      }
      const host = await client.query(
        `SELECT authorized_slots,
                (authorized_slots IS NOT DISTINCT FROM (SELECT COUNT(*)::integer FROM swarm_authority_reservations
                  WHERE host_id=$1 AND state IN ('start-authorized-not-observed','runner-claimed-not-started','runner-start-observed','stop-requested','runner-never-started-observed'))) AS reconciles
         FROM swarm_authority_hosts WHERE host_id=$1 FOR UPDATE`,
        [row.host_id],
      );
      if (host.rows.length !== 1 || host.rows[0].reconciles !== true || Number(host.rows[0].authorized_slots) < 1) {
        return await deny('Authorized host ledger is missing or inconsistent.');
      }

      const outcomeId = randomUUID();
      const transitioned = await client.query(
        `UPDATE swarm_authority_reservations SET state=$2,
           runner_outcome_id=$3::uuid,runner_outcome_request_id=$4::uuid,
           runner_outcome_event_id=$5::uuid,runner_outcome_kind=$6,
           runner_outcome_accepted_at=$7::timestamptz,runner_outcome_at=$8::timestamptz,
           runner_outcome_evidence_observed_at=$9::timestamptz,runner_outcome_evidence_ref=$10,
           runner_outcome_evidence_sha256=$11,runner_outcome_presented_token_sha256=$12,
           runner_exit_disposition=$13,runner_remote_stop_confirmed=$14
         WHERE reservation_id=$1::uuid
           AND state IN ('runner-claimed-not-started','runner-start-observed','stop-requested') RETURNING *`,
        [request.reservation_id, expectedState, outcomeId, request.outcome_request_id,
          evidence.outcome_event_id, evidence.outcome_kind, at, evidence.outcome_at,
          evidence.observed_at, evidence.evidence_ref, evidence.evidence_sha256, outcomeDigest,
          evidence.exit_disposition, evidence.remote_stop_confirmed],
      );
      if (transitioned.rows.length !== 1) return await deny('Runner outcome settlement lost its authority race.');
      if (evidence.outcome_kind === 'process-terminal') {
        const released = await client.query(
          `UPDATE swarm_authority_hosts SET authorized_slots=authorized_slots-1
           WHERE host_id=$1 AND authorized_slots >= 1 RETURNING authorized_slots`,
          [row.host_id],
        );
        if (released.rows.length !== 1) throw new Error('Authorized host-capacity release would underflow or references a missing host.');
      }
      const hostAfter = await client.query(
        `SELECT (authorized_slots IS NOT DISTINCT FROM (SELECT COUNT(*)::integer FROM swarm_authority_reservations
                  WHERE host_id=$1 AND state IN ('start-authorized-not-observed','runner-claimed-not-started','runner-start-observed','stop-requested','runner-never-started-observed'))) AS reconciles
         FROM swarm_authority_hosts WHERE host_id=$1`,
        [row.host_id],
      );
      if (hostAfter.rows.length !== 1 || hostAfter.rows[0].reconciles !== true) {
        throw new Error('Authorized host ledger failed to reconcile after outcome settlement.');
      }
      const receipt = receiptFrom(transitioned.rows[0]);
      await client.query(
        `INSERT INTO swarm_authority_audit (event,operation_id,binding_digest_sha256,at,detail)
         VALUES ('runner-outcome-observed',$1,$2,$3::timestamptz,$4::jsonb)`,
        [request.operation_id, request.binding_digest_sha256, at, JSON.stringify(receipt)],
      );
      if (evidence.outcome_kind === 'process-terminal') {
        await client.query(
          `INSERT INTO swarm_authority_audit (event,operation_id,binding_digest_sha256,at,detail)
           VALUES ('host-capacity-released',$1,$2,$3::timestamptz,$4::jsonb)`,
          [request.operation_id, request.binding_digest_sha256, at, JSON.stringify({
            reservation_id: request.reservation_id, claim_id: request.claim_id,
            outcome_id: outcomeId, released_host_slots: 1, released_cost_usd: 0,
            actual_usage_reconciled: false,
          })],
        );
      }
      await client.query('COMMIT');
      return { settled: true, receipt, blockers: [] };
    } catch (error) {
      await client.query('ROLLBACK');
      await this.recordIntegrityRefusal(client, request.operation_id, request.binding_digest_sha256, {
        action: 'settle-runner-outcome', reservation_id: request.reservation_id,
        error: error instanceof Error ? error.message : 'unknown runner-outcome settlement failure',
      });
      throw error;
    } finally { client.release?.(); }
  }

  async recordRunnerUsageEvidence(input: RunnerUsageEvidenceInput): Promise<RunnerUsageEvidenceResult> {
    const parsed = runnerUsageEvidenceInputSchema.safeParse(input);
    if (!parsed.success) return runnerUsageEvidenceDenied('Runner usage-evidence request is invalid.');
    if (!this.usageEvidencePool) {
      return runnerUsageEvidenceDenied('Dedicated usage-evidence database authority is not configured.');
    }
    const request = parsed.data;
    const client = await this.pool.connect();
    let brokerTransactionOpen = false;
    let brokerClientReleased = false;
    let usageClient: AuthoritySqlClient | undefined;
    let usageTransactionOpen = false;
    let at = new Date().toISOString();
    const deny = async (blocker: string): Promise<RunnerUsageEvidenceResult> => {
      await client.query(
        `INSERT INTO swarm_authority_audit (event,operation_id,binding_digest_sha256,at,detail)
         VALUES ('runner-usage-evidence-denied',$1,$2,$3::timestamptz,$4::jsonb)`,
        [request.operation_id, request.binding_digest_sha256, at, JSON.stringify({
          reservation_id: request.reservation_id, claim_id: request.claim_id,
          outcome_id: request.outcome_id, usage_request_id: request.usage_request_id,
          usage_sequence: request.usage_sequence, blockers: [blocker], released_cost_usd: '0.000000',
        })],
      );
      await client.query('COMMIT');
      return runnerUsageEvidenceDenied(blocker);
    };
    const receiptFrom = (row: Record<string, unknown>): RunnerUsageEvidenceReceipt => ({
      schema_version: 'starlight.runner_usage_evidence.v1',
      usage_evidence_id: String(row.usage_evidence_id),
      usage_request_id: String(row.usage_request_id),
      usage_sequence: Number(row.usage_sequence),
      provider_event_id: String(row.provider_event_id),
      reservation_id: String(row.reservation_id),
      claim_id: String(row.claim_id),
      outcome_id: String(row.outcome_id),
      operation_id: String(row.operation_id),
      effect_id: String(row.effect_id),
      binding_digest_sha256: String(row.binding_digest_sha256),
      provider_id: String(row.provider_id),
      provider_account_ref: String(row.provider_account_ref),
      provider_usage_correlation_id: String(row.provider_usage_correlation_id),
      meter_id: String(row.meter_id),
      evidence_ref: String(row.evidence_ref),
      evidence_sha256: String(row.evidence_sha256),
      usage_started_at: sqlInstant(row.usage_started_at),
      usage_ended_at: sqlInstant(row.usage_ended_at),
      statement_finalized_at: row.statement_finalized_at === null ? null : sqlInstant(row.statement_finalized_at),
      evidence_observed_at: sqlInstant(row.evidence_observed_at),
      accepted_at: sqlInstant(row.accepted_at),
      statement_status: row.statement_status as 'provisional' | 'final',
      currency: 'USD',
      cumulative_cost_usd: canonicalUsd(row.cumulative_cost_usd),
      authorized_cost_usd: canonicalUsd(row.authorized_cost_usd),
      budget_breach_observed: row.budget_breach_observed === true,
      actual_usage_reconciled: false,
      budget_commitment_released: false,
      released_cost_usd: '0.000000',
      transport_state: 'attested-not-deployed',
      dispatch_state: 'not-dispatched',
      workload_effect_observed: false,
    });
    try {
      await client.query('BEGIN');
      brokerTransactionOpen = true;
      await client.query('SET LOCAL search_path = pg_catalog, public, pg_temp');
      if (!await lockAuthority(client)) return await deny('Authority serialization control row is missing or ambiguous.');
      at = await wallClock(client);
      const nowMs = Date.parse(at);

      const brokerAttestation = await this.brokerSessionAttestor(client);
      if (!brokerAttestation.valid) {
        return await deny(`Broker database session is not authorized: ${brokerAttestation.blockers.join(' ')}`);
      }
      const usageAttestation = await this.runnerUsageEvidenceAttestor(client);
      if (!usageAttestation.valid) {
        return await deny(`Runner usage evidence is unavailable: ${usageAttestation.blockers.join(' ')}`);
      }
      const parsedEvidence = runnerUsageEvidenceSchema.safeParse(usageAttestation.evidence);
      if (!parsedEvidence.success) return await deny('Runner usage evidence is malformed.');
      const evidence = parsedEvidence.data;
      const evidenceObservedMs = Date.parse(evidence.observed_at);
      if (evidenceObservedMs > nowMs || nowMs - evidenceObservedMs > this.maxRunnerEvidenceAgeMs
        || Date.parse(evidence.access_review_expires_at) <= nowMs) {
        return await deny('Runner usage evidence is stale, future-dated, or access-expired.');
      }

      const usageDigest = createHash('sha256').update(request.usage_reconciliation_token, 'utf8').digest('hex');
      const nextUsageDigest = createHash('sha256').update(request.next_usage_reconciliation_token, 'utf8').digest('hex');
      const found = await client.query(
        `SELECT *,
                (reserved_cost_usd IS NOT DISTINCT FROM (binding->>'requested_cost_usd')::numeric) AS cost_matches_binding
         FROM swarm_authority_reservations
         WHERE reservation_id=$1::uuid AND runner_claim_id=$2::uuid AND runner_outcome_id=$3::uuid FOR UPDATE`,
        [request.reservation_id, request.claim_id, request.outcome_id],
      );
      const row = found.rows[0];
      if (!row) return await deny('Settled runner outcome does not exist.');
      if (row.operation_id !== request.operation_id || row.effect_id !== request.effect_id
        || row.binding_digest_sha256 !== request.binding_digest_sha256) {
        return await deny('Runner usage request does not match the settled operation.');
      }
      if (!['runner-never-started-observed', 'runner-terminal-observed'].includes(String(row.state))) {
        return await deny(`Runner usage evidence cannot be recorded from state ${String(row.state)}.`);
      }
      if (row.broker_database_role !== brokerAttestation.session.database_role
        || row.broker_database_name !== brokerAttestation.session.database_name
        || row.broker_role_contract_sha256 !== BROKER_DATABASE_ROLE_CONTRACT_SHA256
        || brokerAttestation.session.contract_digest_sha256 !== BROKER_DATABASE_ROLE_CONTRACT_SHA256) {
        return await deny('Authenticated broker database session does not match the settled operation.');
      }
      const principal = await client.query(
        `SELECT database_role,database_name,broker_execution_identity,broker_identity_evidence_ref,
                authn_kind,role_contract_digest_sha256,observed_at,access_review_expires_at,state,evidence
         FROM swarm_authority_broker_principals
         WHERE database_role=$1 AND database_name=$2`,
        [brokerAttestation.session.database_role, brokerAttestation.session.database_name],
      );
      const principalRow = principal.rows[0];
      const principalEvidence = brokerPrincipalEvidenceSchema.safeParse(principalRow?.evidence);
      const principalCurrent = principal.rows.length === 1 && principalEvidence.success
        && principalEvidence.data.database_role === principalRow.database_role
        && principalEvidence.data.database_name === principalRow.database_name
        && principalEvidence.data.broker_execution_identity === principalRow.broker_execution_identity
        && principalEvidence.data.broker_identity_evidence_ref === principalRow.broker_identity_evidence_ref
        && principalEvidence.data.authn_kind === principalRow.authn_kind
        && principalEvidence.data.role_contract_digest_sha256 === principalRow.role_contract_digest_sha256
        && principalEvidence.data.state === principalRow.state
        && sqlInstant(principalEvidence.data.observed_at) === sqlInstant(principalRow.observed_at)
        && sqlInstant(principalEvidence.data.access_review_expires_at) === sqlInstant(principalRow.access_review_expires_at)
        && principalEvidence.data.state === 'ready'
        && principalEvidence.data.broker_execution_identity === row.broker_execution_identity
        && principalEvidence.data.broker_identity_evidence_ref === row.broker_identity_evidence_ref
        && principalEvidence.data.role_contract_digest_sha256 === BROKER_DATABASE_ROLE_CONTRACT_SHA256
        && Date.parse(principalEvidence.data.observed_at) <= nowMs
        && nowMs - Date.parse(principalEvidence.data.observed_at) <= this.maxBrokerEvidenceAgeMs
        && Date.parse(principalEvidence.data.access_review_expires_at) > nowMs;
      if (!principalCurrent) return await deny('Broker principal is unavailable, stale, disabled, or drifted.');

      const binding = operationBindingSchema.safeParse(row.binding);
      if (!binding.success || sha256Digest(binding.data) !== row.binding_digest_sha256
        || row.cost_matches_binding !== true || row.committed_cost_usd !== row.reserved_cost_usd) {
        return await deny('Stored operation or committed cost is invalid or drifted.');
      }
      if (typeof row.usage_reconciliation_token_sha256 !== 'string'
        || typeof row.provider_usage_correlation_id !== 'string') {
        return await deny('Runner claim predates usage-evidence authority.');
      }
      const bindingsMatch = evidence.reservation_id === request.reservation_id
        && evidence.claim_id === request.claim_id
        && evidence.outcome_id === request.outcome_id
        && evidence.operation_id === request.operation_id
        && evidence.effect_id === request.effect_id
        && evidence.binding_digest_sha256 === request.binding_digest_sha256
        && evidence.runner_id === row.runner_id
        && evidence.runner_identity_evidence_ref === row.runner_identity_evidence_ref
        && evidence.runner_instance_id === row.runner_instance_id
        && evidence.runtime_id === row.runner_runtime_id
        && evidence.host_id === row.runner_host_id
        && evidence.channel_binding_sha256 === row.runner_channel_binding_sha256
        && evidence.launch_attempt_id === row.runner_launch_attempt_id
        && evidence.fencing_generation === Number(row.runner_fencing_generation)
        && evidence.process_instance_sha256 === row.runner_process_instance_sha256
        && evidence.provider_usage_correlation_id === row.provider_usage_correlation_id;
      if (!bindingsMatch) return await deny('Runner usage evidence is bound to another execution generation.');
      const usageStartedMs = Date.parse(evidence.usage_started_at);
      const usageEndedMs = Date.parse(evidence.usage_ended_at);
      if (usageStartedMs < Date.parse(sqlInstant(row.runner_claim_accepted_at))
        || usageEndedMs > Date.parse(sqlInstant(row.runner_outcome_at))) {
        return await deny('Runner usage interval falls outside the authenticated execution interval.');
      }

      const lifecycleDigests = [row.consume_token_sha256, row.cancel_token_sha256, row.lease_claim_token_sha256,
        row.redemption_token_sha256, row.control_token_sha256, row.heartbeat_token_sha256,
        row.start_observation_token_sha256, row.outcome_token_sha256, usageDigest,
        row.runner_heartbeat_presented_token_sha256, row.runner_start_presented_token_sha256,
        row.runner_outcome_presented_token_sha256].filter((digest): digest is string => typeof digest === 'string');
      if (lifecycleDigests.includes(nextUsageDigest)) {
        return await deny('Next usage-reconciliation credential aliases an existing lifecycle credential.');
      }
      if (!await this.readBudgetWindows(client, request.reservation_id, binding.data.budget_policy_id, binding.data.requested_cost_usd)) {
        return await deny('Committed aggregate budget authority is missing or inconsistent.');
      }
      const budget = await client.query(
        `SELECT (committed_usd IS NOT DISTINCT FROM (SELECT COALESCE(SUM(reserved_cost_usd),0)
                  FROM swarm_authority_reservations WHERE budget_receipt_id=$1
                    AND state IN ('start-authorized-not-observed','runner-claimed-not-started','runner-start-observed','stop-requested','runner-never-started-observed','runner-terminal-observed'))) AS reconciles
         FROM swarm_authority_budgets WHERE receipt_id=$1 FOR UPDATE`,
        [row.budget_receipt_id],
      );
      if (budget.rows.length !== 1 || budget.rows[0].reconciles !== true) {
        return await deny('Committed receipt budget authority is missing or inconsistent.');
      }
      await client.query('COMMIT');
      brokerTransactionOpen = false;
      client.release?.();
      brokerClientReleased = true;

      usageClient = await this.usageEvidencePool.connect();
      await usageClient.query('BEGIN');
      usageTransactionOpen = true;
      await usageClient.query('SET LOCAL search_path = pg_catalog, public');
      const verifierAttestation = await this.usageEvidenceSessionAttestor(usageClient);
      if (!verifierAttestation.valid) {
        await usageClient.query('ROLLBACK');
        usageTransactionOpen = false;
        usageClient.release?.();
        usageClient = undefined;
        const blocker = `Usage-evidence database session is not authorized: ${verifierAttestation.blockers.join(' ')}`;
        await this.recordRunnerUsageEvidenceRefusal(request, blocker);
        return runnerUsageEvidenceDenied(blocker);
      }
      const usageEvidenceId = randomUUID();
      const appended = await usageClient.query(
        `SELECT public.starlight_append_runner_usage_evidence($1::jsonb) AS result`,
        [JSON.stringify({
          usage_evidence_id: usageEvidenceId, usage_request_id: request.usage_request_id,
          usage_sequence: request.usage_sequence, provider_event_id: evidence.provider_event_id,
          reservation_id: request.reservation_id, claim_id: request.claim_id, outcome_id: request.outcome_id,
          operation_id: request.operation_id, effect_id: request.effect_id,
          binding_digest_sha256: request.binding_digest_sha256,
          role_contract_digest_sha256: BROKER_DATABASE_ROLE_CONTRACT_SHA256,
          verifier_database_role: verifierAttestation.session.database_role,
          verifier_database_name: verifierAttestation.session.database_name,
          verifier_role_contract_sha256: verifierAttestation.session.contract_digest_sha256,
          runner_id: evidence.runner_id, runner_identity_evidence_ref: evidence.runner_identity_evidence_ref,
          runner_instance_id: evidence.runner_instance_id, runtime_id: evidence.runtime_id,
          host_id: evidence.host_id, channel_binding_sha256: evidence.channel_binding_sha256,
          launch_attempt_id: evidence.launch_attempt_id, fencing_generation: evidence.fencing_generation,
          process_instance_sha256: evidence.process_instance_sha256,
          provider_id: evidence.provider_id, provider_account_ref: evidence.provider_account_ref,
          provider_usage_correlation_id: evidence.provider_usage_correlation_id, meter_id: evidence.meter_id,
          evidence_ref: evidence.evidence_ref, evidence_sha256: evidence.evidence_sha256,
          usage_started_at: evidence.usage_started_at, usage_ended_at: evidence.usage_ended_at,
          statement_status: evidence.statement_status, statement_finalized_at: evidence.statement_finalized_at,
          evidence_observed_at: evidence.observed_at, cumulative_cost_usd: evidence.cumulative_cost_usd,
          access_review_expires_at: evidence.access_review_expires_at,
          usage_reconciliation_token: request.usage_reconciliation_token,
          next_usage_reconciliation_token: request.next_usage_reconciliation_token,
          issuer: evidence.issuer, key_id: evidence.key_id, authn_kind: evidence.authn_kind,
        })],
      );
      const appendResult = appended.rows[0]?.result as {
        ok?: boolean; blocker?: string; audited?: boolean; row?: Record<string, unknown>;
      } | undefined;
      if (appendResult?.ok !== true || !appendResult.row) {
        // Preserve the routine's sanitized denial in the managed verifier path. PostgreSQL
        // cannot force a caller-controlled transaction to commit, so arbitrary direct SQL is
        // outside this audit guarantee. No authority mutation occurs before a false result.
        await usageClient.query(appendResult?.audited === true ? 'COMMIT' : 'ROLLBACK');
        usageTransactionOpen = false;
        usageClient.release?.();
        usageClient = undefined;
        const blocker = appendResult?.blocker ?? 'Runner usage evidence could not be appended.';
        if (appendResult?.audited !== true) {
          await this.recordRunnerUsageEvidenceRefusal(request, blocker);
        }
        return runnerUsageEvidenceDenied(blocker);
      }
      const receipt = receiptFrom(appendResult.row);
      await usageClient.query('COMMIT');
      usageTransactionOpen = false;
      return { recorded: true, receipt, blockers: [] };
    } catch (error) {
      if (usageClient) {
        if (usageTransactionOpen) await usageClient.query('ROLLBACK');
        usageClient.release?.();
        usageClient = undefined;
      }
      if (brokerTransactionOpen) await client.query('ROLLBACK');
      if (brokerClientReleased) {
        await this.recordRunnerUsageEvidenceRefusal(
          request,
          error instanceof Error ? error.message : 'unknown runner usage-evidence verifier failure',
        );
      } else {
        await this.recordIntegrityRefusal(client, request.operation_id, request.binding_digest_sha256, {
          action: 'record-runner-usage-evidence', reservation_id: request.reservation_id,
          error: error instanceof Error ? error.message : 'unknown runner usage-evidence failure',
        });
      }
      throw error;
    } finally {
      usageClient?.release?.();
      if (!brokerClientReleased) client.release?.();
    }
  }

  async reconcileRunnerHeartbeatExpiry(input: RunnerHeartbeatExpiryInput): Promise<RunnerHeartbeatExpiryResult> {
    const parsed = runnerHeartbeatExpiryInputSchema.safeParse(input);
    if (!parsed.success) {
      return { reconciled: false, reservation_id: String(input?.reservation_id ?? 'invalid-reservation'), state: null, expired: false, blockers: ['Runner heartbeat expiry request is invalid.'] };
    }
    const request = parsed.data;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL search_path = pg_catalog, public, pg_temp');
      if (!await lockAuthority(client)) throw new Error('Authority serialization control row is missing or ambiguous.');
      const at = await wallClock(client);
      const nowMs = Date.parse(at);
      const found = await client.query(
        `SELECT reservation_id,operation_id,binding_digest_sha256,state,runner_claim_expires_at,
                runner_evidence_observed_at,runner_access_review_expires_at,reservation_expires_at,
                lease_expires_at,start_authorized_at,binding
         FROM swarm_authority_reservations
         WHERE reservation_id=$1::uuid AND runner_claim_id=$2::uuid FOR UPDATE`,
        [request.reservation_id, request.claim_id],
      );
      const row = found.rows[0];
      if (!row || row.operation_id !== request.operation_id
        || row.binding_digest_sha256 !== request.binding_digest_sha256) {
        await client.query('COMMIT');
        return { reconciled: false, reservation_id: request.reservation_id, state: null, expired: false, blockers: ['Runner claim does not exist or does not match the expiry request.'] };
      }
      if (row.state === 'stop-requested') {
        await client.query('COMMIT');
        return { reconciled: true, reservation_id: request.reservation_id, state: 'stop-requested', expired: true, blockers: [] };
      }
      if (row.state !== 'runner-claimed-not-started' && row.state !== 'runner-start-observed') {
        await client.query('COMMIT');
        return { reconciled: false, reservation_id: request.reservation_id, state: null, expired: false, blockers: [`Runner heartbeat expiry cannot be reconciled from state ${String(row.state)}.`] };
      }
      const binding = operationBindingSchema.safeParse(row.binding);
      const expiryMs = Date.parse(String(row.runner_claim_expires_at));
      const authorityCapMs = binding.success ? Math.min(
        Date.parse(String(row.runner_access_review_expires_at)),
        Date.parse(String(row.runner_evidence_observed_at)) + this.maxRunnerEvidenceAgeMs,
        Date.parse(String(row.reservation_expires_at)),
        Date.parse(String(row.lease_expires_at)),
        Date.parse(String(row.start_authorized_at)) + binding.data.timeout_ms,
      ) : Number.NaN;
      const invalidOrExpired = !binding.success
        || sha256Digest(binding.data) !== row.binding_digest_sha256
        || !Number.isFinite(authorityCapMs)
        || expiryMs !== authorityCapMs
        || expiryMs <= nowMs;
      if (!invalidOrExpired) {
        await client.query('COMMIT');
        return { reconciled: true, reservation_id: request.reservation_id, state: row.state, expired: false, blockers: [] };
      }
      const stopped = await client.query(
        `UPDATE swarm_authority_reservations SET state='stop-requested'
         WHERE reservation_id=$1::uuid AND state IN ('runner-claimed-not-started','runner-start-observed') RETURNING reservation_id`,
        [request.reservation_id],
      );
      if (stopped.rows.length !== 1) throw new Error('Runner heartbeat expiry reconciliation lost its authority race.');
      await client.query(
        `INSERT INTO swarm_authority_audit (event,operation_id,binding_digest_sha256,at,detail)
         VALUES ('stop-requested',$1,$2,$3::timestamptz,$4::jsonb)`,
        [request.operation_id, request.binding_digest_sha256, at, JSON.stringify({
          reservation_id: request.reservation_id, claim_id: request.claim_id,
          reason: 'runner heartbeat authority expired or drifted',
          execution_state: row.state === 'runner-start-observed' ? 'started-or-unknown' : 'unknown', released_cost_usd: 0,
        })],
      );
      await client.query('COMMIT');
      return { reconciled: true, reservation_id: request.reservation_id, state: 'stop-requested', expired: true, blockers: [] };
    } catch (error) {
      await client.query('ROLLBACK');
      await this.recordIntegrityRefusal(client, request.operation_id, request.binding_digest_sha256, {
        action: 'reconcile-runner-heartbeat-expiry', reservation_id: request.reservation_id,
        error: error instanceof Error ? error.message : 'unknown runner-heartbeat expiry reconciliation failure',
      });
      throw error;
    } finally { client.release?.(); }
  }

  async cancel(input: CancellationInput): Promise<CancellationResult> {
    const parsed = cancellationInputSchema.safeParse(input);
    if (!parsed.success) return cancellationDenied(String(input?.reservation_id ?? 'invalid-reservation'), 'Cancellation request is invalid.');
    const request = parsed.data;
    const client = await this.pool.connect();
    let affectedOperation = 'invalid-operation';
    let affectedDigest = '0'.repeat(64);
    try {
      await client.query('BEGIN');
      if (!await lockAuthority(client)) throw new Error('Authority serialization control row is missing or ambiguous.');
      const at = await wallClock(client);
      const found = await client.query(
        `SELECT reservation_id,operation_id,binding_digest_sha256,binding,budget_receipt_id,host_id,reserved_cost_usd,state,
                (reserved_cost_usd IS NOT DISTINCT FROM (binding->>'requested_cost_usd')::numeric) AS cost_matches_binding
         FROM swarm_authority_reservations
         WHERE reservation_id=$1::uuid AND cancel_token_sha256=$2 FOR UPDATE`,
        [request.reservation_id, createHash('sha256').update(request.cancel_token, 'utf8').digest('hex')],
      );
      const row = found.rows[0];
      if (!row) {
        await client.query(
          `INSERT INTO swarm_authority_audit (event,operation_id,binding_digest_sha256,at,detail)
           VALUES ('denied','invalid-operation',$1,$2::timestamptz,$3::jsonb)`,
          ['0'.repeat(64), at, JSON.stringify({ reservation_id: request.reservation_id, blockers: ['Reservation does not exist.'] })],
        );
        await client.query('COMMIT');
        return cancellationDenied(request.reservation_id, 'Reservation does not exist.');
      }
      affectedOperation = String(row.operation_id);
      affectedDigest = String(row.binding_digest_sha256);
      if (row.state === 'cancelled') {
        await client.query('COMMIT');
        return { cancelled: true, reservation_id: request.reservation_id, state: 'cancelled', already_terminal: true, released_cost_usd: 0, blockers: [] };
      }
      if (row.state === 'expired') {
        await client.query('COMMIT');
        return cancellationDenied(request.reservation_id, 'Reservation is already expired.', 'expired', true);
      }
      if (row.state === 'stop-requested') {
        await client.query('COMMIT');
        return cancellationDenied(
          request.reservation_id,
          'Stop was already requested; authenticated terminal evidence is required before resource release.',
          'stop-requested',
          true,
        );
      }
      if (row.state === 'start-authorized-not-observed' || row.state === 'runner-claimed-not-started' || row.state === 'runner-start-observed') {
        const stopped = await client.query(
          `UPDATE swarm_authority_reservations SET state='stop-requested'
           WHERE reservation_id=$1::uuid AND state IN ('start-authorized-not-observed','runner-claimed-not-started','runner-start-observed') RETURNING reservation_id`,
          [request.reservation_id],
        );
        if (stopped.rows.length !== 1) throw new Error('Stop request lost its authority race.');
        await client.query(
          `INSERT INTO swarm_authority_audit (event,operation_id,binding_digest_sha256,at,detail)
           VALUES ('stop-requested',$1,$2,$3::timestamptz,$4::jsonb)`,
          [row.operation_id, row.binding_digest_sha256, at, JSON.stringify({
            reservation_id: request.reservation_id, reason: request.reason,
            execution_state: 'unknown', released_cost_usd: 0,
          })],
        );
        await client.query('COMMIT');
        return cancellationDenied(
          request.reservation_id,
          'Start authority was already redeemed; authenticated terminal evidence is required before resource release.',
          'stop-requested',
        );
      }
      if (row.state !== 'reserved-not-started' && row.state !== 'consumed-not-started' && row.state !== 'leased-not-started') {
        await client.query(
          `INSERT INTO swarm_authority_audit (event,operation_id,binding_digest_sha256,at,detail)
           VALUES ('denied',$1,$2,$3::timestamptz,$4::jsonb)`,
          [row.operation_id, row.binding_digest_sha256, at, JSON.stringify({ reservation_id: request.reservation_id, blockers: ['Reservation state is invalid.'] })],
        );
        await client.query('COMMIT');
        return cancellationDenied(request.reservation_id, 'Reservation state is invalid.');
      }
      const transitioned = await client.query(
        `UPDATE swarm_authority_reservations SET state='cancelled'
         WHERE reservation_id=$1::uuid AND state IN ('reserved-not-started','consumed-not-started','leased-not-started') RETURNING reservation_id`,
        [request.reservation_id],
      );
      if (transitioned.rows.length !== 1) throw new Error('Cancellation lost its authority race.');
      const released = await this.releaseResources(client, row);
      await client.query(
        `INSERT INTO swarm_authority_audit (event,operation_id,binding_digest_sha256,at,detail)
         VALUES ('reservation-cancelled',$1,$2,$3::timestamptz,$4::jsonb)`,
        [row.operation_id, row.binding_digest_sha256, at, JSON.stringify({ reservation_id: request.reservation_id, reason: request.reason, released_cost_usd: released })],
      );
      await client.query('COMMIT');
      return { cancelled: true, reservation_id: request.reservation_id, state: 'cancelled', already_terminal: false, released_cost_usd: released, blockers: [] };
    } catch (error) {
      await client.query('ROLLBACK');
      await this.recordIntegrityRefusal(client, affectedOperation, affectedDigest, {
        action: 'cancel', reservation_id: request.reservation_id,
        error: error instanceof Error ? error.message : 'unknown cancellation failure',
      });
      throw error;
    } finally { client.release?.(); }
  }

  async reserve(request: AtomicAdmissionRequest): Promise<AdmissionResult> {
    if (!Number.isInteger(request.max_host_evidence_age_ms) || request.max_host_evidence_age_ms < 1_000 || request.max_host_evidence_age_ms > 60 * 60_000) {
      throw new Error('Host evidence age ceiling must be between 1 second and 1 hour.');
    }
    const client = await this.pool.connect();
    let auditAt = request.now;
    const deny = async (blocker: string) => {
      await client.query(
        `INSERT INTO swarm_authority_audit (event,operation_id,binding_digest_sha256,at,detail)
         VALUES ('denied',$1,$2,$3::timestamptz,$4::jsonb)`,
        [request.binding.operation_id, request.binding_digest_sha256, auditAt, JSON.stringify({ blockers: [blocker] })],
      );
      await client.query('COMMIT');
      return denial(blocker);
    };
    try {
      await client.query('BEGIN');
      if (!await lockAuthority(client)) {
        return await deny('Authority serialization control row is missing or ambiguous.');
      }
      const transactionNow = await wallClock(client);
      auditAt = transactionNow;
      const transactionNowMs = Date.parse(transactionNow);
      const refs = [
        `receipt:${request.approval.receipt_id}`, `receipt:${request.budget.receipt_id}`,
        `key:${request.approval.issuer}:${request.approval.key_id}`, `key:${request.budget.issuer}:${request.budget.key_id}`,
        `issuer:${request.approval.issuer}`, `issuer:${request.budget.issuer}`,
        `operation:${request.binding.operation_id}`, `effect:${request.binding.effect_id}`,
      ];
      const revoked = await client.query('SELECT ref FROM swarm_authority_revocations WHERE ref = ANY($1::text[]) LIMIT 1', [refs]);
      if (revoked.rows.length) return await deny('An authority receipt, issuer or signing key is revoked.');
      if (Date.parse(request.approval.expires_at) <= transactionNowMs || Date.parse(request.budget.expires_at) <= transactionNowMs) {
        return await deny('An authority receipt expired before the reservation transaction.');
      }
      if (Date.parse(request.reservation_expires_at) <= transactionNowMs) return await deny('Reservation expiry elapsed before it could be issued.');

      const preparedRow = await client.query(
        'SELECT binding_digest_sha256,state FROM swarm_authority_prepared_operations WHERE operation_id=$1 FOR UPDATE',
        [request.binding.operation_id],
      );
      if (!preparedRow.rows[0]) return await deny('Server-owned prepared operation is missing.');
      if (preparedRow.rows[0].state !== 'ready') return await deny('Server-owned prepared operation is cancelled.');
      if (preparedRow.rows[0].binding_digest_sha256 !== request.binding_digest_sha256) {
        return await deny('Prepared operation digest does not match the signed operation binding.');
      }

      const hostRow = await client.query(
        'SELECT evidence,capacity_slots,reserved_slots,authorized_slots FROM swarm_authority_hosts WHERE host_id=$1 FOR UPDATE',
        [request.binding.host_id],
      );
      const host = hostEvidence(hostRow.rows[0]);
      if (!host) return await deny('Trusted host evidence is missing.');
      if (host.host_id !== request.binding.host_id) return await deny('Trusted host evidence identity does not match the requested host.');
      const nowMs = transactionNowMs;
      if (host.status !== 'ready') return await deny('Trusted host is not ready.');
      if (nowMs - Date.parse(host.observed_at) > request.max_host_evidence_age_ms || Date.parse(host.observed_at) > nowMs + 60_000) return await deny('Trusted host evidence is stale or from the future.');
      if (!host.secret_readiness) return await deny('Trusted host secrets are not ready.');
      if (Date.parse(host.access_review_expires_at) <= nowMs) return await deny('Trusted host access review is expired.');
      const capacitySlots = Number(hostRow.rows[0]?.capacity_slots);
      const reservedSlots = Number(hostRow.rows[0]?.reserved_slots);
      const authorizedSlots = Number(hostRow.rows[0]?.authorized_slots);
      if (!Number.isSafeInteger(capacitySlots) || !Number.isSafeInteger(reservedSlots)
        || !Number.isSafeInteger(authorizedSlots) || capacitySlots < 0 || reservedSlots < 0 || authorizedSlots < 0) {
        return await deny('Trusted host capacity ledger is invalid.');
      }
      if (host.capacity_slots !== capacitySlots) return await deny('Trusted host capacity evidence and ledger differ.');
      if (capacitySlots - reservedSlots - authorizedSlots < 1) return await deny('Trusted host has no available capacity.');
      const hostCaps = new Set(host.allowed_capabilities);
      if (request.binding.capabilities.some((item) => !hostCaps.has(item))) return await deny('Trusted host does not allow every requested capability.');

      const budgetRow = await client.query(
        `SELECT hard_limit_usd,reserved_usd,committed_usd,
                (reserved_usd+committed_usd+$2::numeric <= hard_limit_usd) AS can_reserve
         FROM swarm_authority_budgets WHERE receipt_id=$1 FOR UPDATE`,
        [request.budget.receipt_id, request.binding.requested_cost_usd],
      );
      if (!budgetRow.rows[0]) return await deny('Durable budget registry entry is missing.');
      const registeredLimit = Number(budgetRow.rows[0].hard_limit_usd);
      const reserved = Number(budgetRow.rows[0].reserved_usd);
      if (registeredLimit !== request.budget.hard_limit_usd) return await deny('Signed and durable budget ceilings differ.');
      if (!Number.isFinite(reserved) || budgetRow.rows[0].can_reserve !== true) return await deny('Durable budget is exhausted.');

      const aggregateRows = await client.query(
        `SELECT window_id,policy_id,kind,starts_at,ends_at,currency,hard_limit_usd,reserved_usd,committed_usd,
                (reserved_usd+committed_usd+$3::numeric <= hard_limit_usd) AS can_reserve
         FROM swarm_authority_budget_windows
         WHERE policy_id=$1 AND starts_at <= $2::timestamptz AND ends_at > $2::timestamptz
         ORDER BY kind FOR UPDATE`,
        [request.binding.budget_policy_id, transactionNow, request.binding.requested_cost_usd],
      );
      const kinds = new Set(aggregateRows.rows.map((row) => row.kind));
      if (aggregateRows.rows.length !== 2 || kinds.size !== 2 || !kinds.has('policy') || !kinds.has('daily')) {
        return await deny('Exactly one active policy and daily aggregate budget window are required.');
      }
      if (aggregateRows.rows.some((row) => row.currency !== 'USD')) return await deny('Aggregate budget currency must be USD.');
      if (aggregateRows.rows.some((row) => Date.parse(request.reservation_expires_at) > Date.parse(String(row.ends_at)))) {
        return await deny('Reservation expiry crosses an aggregate budget window boundary.');
      }
      if (aggregateRows.rows.some((row) => row.can_reserve !== true)) return await deny('Aggregate budget window is exhausted.');
      const selectedWindows: BudgetWindowEvidence[] = aggregateRows.rows.map((row) => ({
        window_id: String(row.window_id), kind: row.kind as 'policy' | 'daily',
        starts_at: sqlInstant(row.starts_at), ends_at: sqlInstant(row.ends_at), currency: 'USD',
      }));

      const inserted = await client.query(
        `INSERT INTO swarm_authority_reservations
         (reservation_id,operation_id,effect_id,binding_digest_sha256,binding,binding_database_sha256,revocation_refs,
          consume_token_sha256,cancel_token_sha256,approval_receipt_id,budget_receipt_id,host_id,reserved_cost_usd,reserved_at,
          reservation_expires_at,max_host_evidence_age_ms,state)
         VALUES ($1::uuid,$2,$3,$4,$5::jsonb,
          encode(sha256(convert_to($5::jsonb::text,'UTF8')),'hex'),
          $6::jsonb,$7,$8,$9,$10,$11,$12,$13::timestamptz,$14::timestamptz,$15,'reserved-not-started')
         ON CONFLICT DO NOTHING RETURNING *`,
        [request.reservation_id, request.binding.operation_id, request.binding.effect_id, request.binding_digest_sha256,
          JSON.stringify(request.binding), JSON.stringify(refs), request.consume_token_sha256, request.cancel_token_sha256,
          request.approval.receipt_id, request.budget.receipt_id, request.binding.host_id,
          request.binding.requested_cost_usd, transactionNow, request.reservation_expires_at,
          request.max_host_evidence_age_ms],
      );
      if (!inserted.rows[0]) return await deny('Operation or external effect was already reserved.');
      for (const window of selectedWindows) {
        await client.query(
          `INSERT INTO swarm_authority_budget_holds (reservation_id,window_id,reserved_cost_usd)
           VALUES ($1::uuid,$2,$3)`,
          [request.reservation_id, window.window_id, request.binding.requested_cost_usd],
        );
        const aggregateUpdate = await client.query(
          `UPDATE swarm_authority_budget_windows SET reserved_usd=reserved_usd+$2
           WHERE window_id=$1 AND reserved_usd+committed_usd+$2 <= hard_limit_usd RETURNING reserved_usd`,
          [window.window_id, request.binding.requested_cost_usd],
        );
        if (aggregateUpdate.rows.length !== 1) throw new Error('Aggregate budget reservation lost its authority race.');
      }
      await client.query('UPDATE swarm_authority_budgets SET reserved_usd=reserved_usd+$2 WHERE receipt_id=$1', [request.budget.receipt_id, request.binding.requested_cost_usd]);
      await client.query('UPDATE swarm_authority_hosts SET reserved_slots=reserved_slots+1 WHERE host_id=$1', [host.host_id]);
      const reservation: AdmissionReservation = {
        schema_version: 'starlight.operation_admission.v1', reservation_id: request.reservation_id,
        operation_id: request.binding.operation_id, effect_id: request.binding.effect_id,
        binding_digest_sha256: request.binding_digest_sha256, approval_receipt_id: request.approval.receipt_id,
        budget_receipt_id: request.budget.receipt_id, budget_policy_id: request.binding.budget_policy_id,
        budget_windows: selectedWindows,
        host_id: request.binding.host_id,
        reserved_cost_usd: request.binding.requested_cost_usd, reserved_at: transactionNow,
        reservation_expires_at: request.reservation_expires_at,
        consume_token: request.consume_token,
        cancel_token: request.cancel_token,
        state: 'reserved-not-started',
      };
      const { consume_token: _consumeToken, cancel_token: _cancelToken, ...reservationAudit } = reservation;
      await client.query(
        `INSERT INTO swarm_authority_audit (event,operation_id,binding_digest_sha256,at,detail)
         VALUES ('reserved',$1,$2,$3::timestamptz,$4::jsonb)`,
        [request.binding.operation_id, request.binding_digest_sha256, transactionNow, JSON.stringify(reservationAudit)],
      );
      await client.query('COMMIT');
      return { admitted: true, reservation, blockers: [] };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release?.(); }
  }
}
