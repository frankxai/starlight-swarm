import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import { PGlite } from '@electric-sql/pglite';

import {
  OperationAuthority,
  signApprovalReceipt,
  signBudgetReceipt,
  type OperationBinding,
} from './operation-authority';
import {
  PostgresOperationAuthorityStore,
  type AuthoritySqlClient,
  type AuthoritySqlPool,
  type RunnerSessionAttestor,
  type RunnerOutcomeEvidence,
  type RunnerOutcomeEvidenceAttestor,
  type RunnerStartEvidence,
  type RunnerStartEvidenceAttestor,
  type RunnerUsageEvidence,
  type RunnerUsageEvidenceAttestor,
  type TrustedBrokerPrincipalEvidence,
} from './postgres-operation-authority';
import { sha256Digest } from './runtime-digest';
import { USAGE_EVIDENCE_APPEND_BODY, USAGE_STREAM_INITIALIZE_BODY } from './usage-authority-routines';
import {
  brokerDatabaseRoleGrantSql,
  BROKER_DATABASE_ROLE_CONTRACT_SHA256,
  USAGE_EVIDENCE_DATABASE_ROLE_CONTRACT_SHA256,
  usageAuthorityRoutineOwnerGrantSql,
  type BrokerDatabaseSessionAttestor,
  type UsageEvidenceDatabaseSessionAttestor,
} from './authority-role-contract';

const NOW_MS = Date.now();
const NOW = new Date(NOW_MS).toISOString();
const EXPIRES = new Date(NOW_MS + 60 * 60_000).toISOString();
const APPROVAL_SECRET = 'approval-secret-at-least-32-bytes-long';
const BUDGET_SECRET = 'budget-secret-at-least-32-bytes-long';
const LEASE_CLAIM_TOKEN = 'L'.repeat(43);
const REDEMPTION_TOKEN = 'R'.repeat(43);
const CONTROL_TOKEN = 'C'.repeat(43);
const HEARTBEAT_TOKEN = 'H'.repeat(43);
const START_OBSERVATION_TOKEN = 'S'.repeat(43);
const OUTCOME_TOKEN = 'O'.repeat(43);
const USAGE_TOKEN = 'U'.repeat(43);
const NEXT_USAGE_TOKEN = 'V'.repeat(43);
const SECOND_NEXT_USAGE_TOKEN = 'W'.repeat(43);
const NEXT_HEARTBEAT_TOKEN = 'N'.repeat(43);
const SECOND_NEXT_HEARTBEAT_TOKEN = 'M'.repeat(43);
const BROKER_IDENTITY = 'broker-execution-001';
const BROKER_EVIDENCE = 'broker-attestation-001';
const BROKER_DATABASE_ROLE = 'starlight_test_broker';
const BROKER_DATABASE_NAME = 'starlight_test';
const brokerSessionAttestor: BrokerDatabaseSessionAttestor = async () => ({
  valid: true,
  session: {
    database_role: BROKER_DATABASE_ROLE,
    database_name: BROKER_DATABASE_NAME,
    contract_digest_sha256: BROKER_DATABASE_ROLE_CONTRACT_SHA256,
  },
  blockers: [],
});
const testUsageEvidenceSessionAttestor: UsageEvidenceDatabaseSessionAttestor = async () => ({
  valid: true,
  session: {
    database_role: 'starlight_test_usage_verifier',
    database_name: BROKER_DATABASE_NAME,
    contract_digest_sha256: USAGE_EVIDENCE_DATABASE_ROLE_CONTRACT_SHA256,
  },
  blockers: [],
});
const runnerSessionAttestor: RunnerSessionAttestor = async () => ({
  valid: true,
  session: {
    runner_id: 'openai-codex-worker',
    runner_identity_evidence_ref: 'identity-attestation-001',
    runner_instance_id: 'runner-instance-001',
    runtime_id: 'railway-temporal',
    host_id: 'trusted-host-001',
    channel_binding_sha256: '9'.repeat(64),
    launch_attempt_id: 'launch-attempt-001',
    fencing_generation: 1,
    observed_at: new Date().toISOString(),
    access_review_expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
  },
  blockers: [],
});

function brokerEvidence(
  overrides: Partial<TrustedBrokerPrincipalEvidence> = {},
): TrustedBrokerPrincipalEvidence {
  const observedAt = new Date().toISOString();
  return {
    schema_version: 'starlight.broker_principal_evidence.v1',
    database_role: BROKER_DATABASE_ROLE,
    database_name: BROKER_DATABASE_NAME,
    broker_execution_identity: BROKER_IDENTITY,
    broker_identity_evidence_ref: BROKER_EVIDENCE,
    authn_kind: 'postgres-session-role',
    role_contract_digest_sha256: BROKER_DATABASE_ROLE_CONTRACT_SHA256,
    observed_at: observedAt,
    access_review_expires_at: EXPIRES,
    state: 'ready',
    ...overrides,
  };
}

class PGlitePool implements AuthoritySqlPool {
  private readonly db = new PGlite();
  private tail: Promise<void> = Promise.resolve();

  async connect(): Promise<AuthoritySqlClient> {
    const previous = this.tail;
    let unlock!: () => void;
    this.tail = new Promise<void>((resolve) => { unlock = resolve; });
    await previous;
    let released = false;
    return {
      query: async (sql, values = []) => {
        if (!values.length && sql.trim().split(';').filter(Boolean).length > 1) {
          await this.db.exec(sql);
          return { rows: [] };
        }
        const result = await this.db.query(sql, values as Parameters<PGlite['query']>[1]);
        return { rows: result.rows as Record<string, unknown>[], rowCount: result.affectedRows };
      },
      release: () => {
        if (!released) { released = true; unlock(); }
      },
    };
  }

  async rows(sql: string): Promise<Record<string, unknown>[]> {
    const client = await this.connect();
    try { return (await client.query(sql)).rows; } finally { client.release?.(); }
  }

  async execute(sql: string): Promise<void> {
    const client = await this.connect();
    try { await client.query(sql); } finally { client.release?.(); }
  }

  async close(): Promise<void> { await this.db.close(); }
}

function binding(overrides: Partial<OperationBinding> = {}): OperationBinding {
  return {
    schema_version: 'starlight.operation_binding.v1',
    operation_id: 'operation-001',
    effect_id: 'effect-001',
    mission_id: 'mission-001',
    call_id: 'call-maker-001',
    role: 'maker',
    actor_id: 'worker-maker-001',
    execution_identity: 'openai-codex-worker',
    identity_evidence_ref: 'identity-attestation-001',
    context_digest_sha256: '1'.repeat(64),
    prompt_sha256: '2'.repeat(64),
    timeout_ms: 120_000,
    requested_operation: 'repository.write',
    effect: {
      kind: 'repository.write',
      resource: 'repo://frankxai/starlight-swarm/src/swarm/operation-authority.ts',
      parameters_digest_sha256: '7'.repeat(64),
    },
    source_profile: {
      repository: 'frankxai/starlight-swarm',
      commit_sha: '1efb525e046b7dacf508d0f174d2399a8412acf9',
      path: 'config/teams/starlight-core.team.yaml',
      digest_sha256: '3'.repeat(64),
    },
    policy_digest_sha256: '4'.repeat(64),
    plan_digest_sha256: '5'.repeat(64),
    pack_digest_sha256: '6'.repeat(64),
    compiler_version: 'starlight.team_pack.compiler.v2',
    lane_id: 'durable-builder',
    workload_id: 'bounded-maker-call',
    runtime_id: 'railway-temporal',
    host_id: 'trusted-host-001',
    capabilities: ['repository.read', 'repository.write'],
    budget_policy_id: 'budget-policy-001',
    requested_cost_usd: 0.25,
    ...overrides,
  };
}

async function harness(
  operation = binding(),
  windows: { policyLimit?: number; dailyLimit?: number; endsAt?: string } = {},
  runnerAttestor?: RunnerSessionAttestor,
  startEvidenceAttestor?: RunnerStartEvidenceAttestor,
  outcomeEvidenceAttestor?: RunnerOutcomeEvidenceAttestor,
  usageEvidenceAttestor?: RunnerUsageEvidenceAttestor,
  usageEvidenceSessionAttestor?: UsageEvidenceDatabaseSessionAttestor,
  usageEvidencePoolFactory?: (pool: PGlitePool) => AuthoritySqlPool,
) {
  const harnessNowMs = Date.now();
  const harnessNow = new Date(harnessNowMs).toISOString();
  const harnessExpires = new Date(harnessNowMs + 60 * 60_000).toISOString();
  const harnessWindowStart = new Date(harnessNowMs - 60_000).toISOString();
  const harnessWindowEnd = new Date(harnessNowMs + 65 * 60_000).toISOString();
  const pool = new PGlitePool();
  const store = new PostgresOperationAuthorityStore(pool, {
    brokerSessionAttestor,
    ...(runnerAttestor ? { runnerSessionAttestor: runnerAttestor } : {}),
    ...(startEvidenceAttestor ? { runnerStartEvidenceAttestor: startEvidenceAttestor } : {}),
    ...(outcomeEvidenceAttestor ? { runnerOutcomeEvidenceAttestor: outcomeEvidenceAttestor } : {}),
    ...(usageEvidenceAttestor ? {
      runnerUsageEvidenceAttestor: usageEvidenceAttestor,
      usageEvidencePool: usageEvidencePoolFactory?.(pool) ?? pool,
      usageEvidenceSessionAttestor: usageEvidenceSessionAttestor ?? testUsageEvidenceSessionAttestor,
    } : {}),
  });
  await store.initialize();
  await store.putBrokerPrincipalEvidence(brokerEvidence());
  const hostObservedAt = new Date().toISOString();
  await store.putHostEvidence({
    host_id: operation.host_id,
    observed_at: hostObservedAt,
    status: 'ready',
    capacity_slots: 4,
    secret_readiness: true,
    access_review_expires_at: harnessExpires,
    allowed_capabilities: ['repository.read', 'repository.write'],
  });
  await store.registerBudgetWindow({
    window_id: `${operation.budget_policy_id}:policy-window`,
    policy_id: operation.budget_policy_id,
    kind: 'policy',
    starts_at: harnessWindowStart,
    ends_at: windows.endsAt ?? harnessWindowEnd,
    currency: 'USD',
    hard_limit_usd: windows.policyLimit ?? 0.5,
  });
  await store.registerBudgetWindow({
    window_id: `${operation.budget_policy_id}:daily-window`,
    policy_id: operation.budget_policy_id,
    kind: 'daily',
    starts_at: harnessWindowStart,
    ends_at: windows.endsAt ?? harnessWindowEnd,
    currency: 'USD',
    hard_limit_usd: windows.dailyLimit ?? 0.5,
  });
  const digest = sha256Digest(operation);
  const approval = signApprovalReceipt({
    schema_version: 'starlight.operation_approval.v1',
    receipt_id: 'approval-001',
    issuer: 'starlight-approval',
    key_id: 'approval-key-001',
    issued_at: harnessNow,
    expires_at: harnessExpires,
    binding_digest_sha256: digest,
    scope: 'admit-bounded-operation',
    allowed_capabilities: ['repository.read', 'repository.write'],
  }, APPROVAL_SECRET);
  const budget = signBudgetReceipt({
    schema_version: 'starlight.operation_budget.v1',
    receipt_id: 'budget-001',
    issuer: 'starlight-budget',
    key_id: 'budget-key-001',
    issued_at: harnessNow,
    expires_at: harnessExpires,
    binding_digest_sha256: digest,
    budget_policy_id: operation.budget_policy_id,
    hard_limit_usd: 0.5,
  }, BUDGET_SECRET);
  await store.registerBudget(budget.receipt_id, budget.hard_limit_usd);
  await store.putPreparedOperation(operation.operation_id, digest, harnessNow);
  const authority = new OperationAuthority(store, {
    approvalIssuers: { [approval.issuer]: { [approval.key_id]: APPROVAL_SECRET } },
    budgetIssuers: { [budget.issuer]: { [budget.key_id]: BUDGET_SECRET } },
  }, 5 * 60_000, () => harnessNow);
  return {
    pool, store, authority, operation, approval, budget,
    windowStart: harnessWindowStart,
    windowEnd: windows.endsAt ?? harnessWindowEnd,
  };
}

type Harness = Awaited<ReturnType<typeof harness>>;

async function reserve(h: Harness, duration = 5 * 60_000) {
  const result = await h.authority.admit({
    binding: h.operation,
    approval_receipt: h.approval,
    budget_receipt: h.budget,
    reservation_duration_ms: duration,
  });
  if (!result.admitted) assert.fail(result.blockers.join(' '));
  return result.reservation;
}

function consumption(h: Harness, reservation: Awaited<ReturnType<typeof reserve>>) {
  return {
    reservation_id: reservation.reservation_id,
    operation_id: h.operation.operation_id,
    effect_id: h.operation.effect_id,
    binding_digest_sha256: reservation.binding_digest_sha256,
    execution_identity: h.operation.execution_identity,
    identity_evidence_ref: h.operation.identity_evidence_ref,
    consume_token: reservation.consume_token,
    lease_claim_token: LEASE_CLAIM_TOKEN,
  };
}

function startLease(
  h: Harness,
  reservation: Awaited<ReturnType<typeof reserve>>,
  consumptionId: string,
  overrides: Partial<{ start_request_id: string; lease_duration_ms: number }> = {},
) {
  return {
    reservation_id: reservation.reservation_id,
    consumption_id: consumptionId,
    start_request_id: '00000000-0000-4000-8000-000000000101',
    operation_id: h.operation.operation_id,
    effect_id: h.operation.effect_id,
    binding_digest_sha256: reservation.binding_digest_sha256,
    execution_identity: h.operation.execution_identity,
    identity_evidence_ref: h.operation.identity_evidence_ref,
    lease_claim_token: LEASE_CLAIM_TOKEN,
    redemption_token: REDEMPTION_TOKEN,
    control_token: CONTROL_TOKEN,
    broker_execution_identity: BROKER_IDENTITY,
    broker_identity_evidence_ref: BROKER_EVIDENCE,
    lease_duration_ms: 5_000,
    ...overrides,
  };
}

function startRedemption(
  h: Harness,
  reservation: Awaited<ReturnType<typeof reserve>>,
  leaseId: string,
  overrides: Partial<{ redemption_request_id: string; redemption_token: string }> = {},
) {
  return {
    reservation_id: reservation.reservation_id,
    lease_id: leaseId,
    redemption_request_id: '00000000-0000-4000-8000-000000000301',
    operation_id: h.operation.operation_id,
    effect_id: h.operation.effect_id,
    binding_digest_sha256: reservation.binding_digest_sha256,
    execution_identity: h.operation.execution_identity,
    identity_evidence_ref: h.operation.identity_evidence_ref,
    redemption_token: REDEMPTION_TOKEN,
    ...overrides,
  };
}

function runnerClaim(
  h: Harness,
  reservation: Awaited<ReturnType<typeof reserve>>,
  redemptionId: string,
  overrides: Partial<{ claim_request_id: string; control_token: string; heartbeat_token: string; start_observation_token: string; outcome_token: string; usage_reconciliation_token: string; provider_usage_correlation_id: string }> = {},
) {
  return {
    claim_request_id: '00000000-0000-4000-8000-000000000401',
    reservation_id: reservation.reservation_id,
    redemption_id: redemptionId,
    operation_id: h.operation.operation_id,
    effect_id: h.operation.effect_id,
    binding_digest_sha256: reservation.binding_digest_sha256,
    control_token: CONTROL_TOKEN,
    heartbeat_token: HEARTBEAT_TOKEN,
    start_observation_token: START_OBSERVATION_TOKEN,
    outcome_token: OUTCOME_TOKEN,
    usage_reconciliation_token: USAGE_TOKEN,
    provider_usage_correlation_id: 'provider-usage-correlation-001',
    ...overrides,
  };
}

function runnerHeartbeat(
  h: Harness,
  reservation: Awaited<ReturnType<typeof reserve>>,
  claimId: string,
  overrides: Partial<{
    heartbeat_request_id: string;
    heartbeat_sequence: number;
    heartbeat_token: string;
    next_heartbeat_token: string;
  }> = {},
) {
  return {
    heartbeat_request_id: '00000000-0000-4000-8000-000000000501',
    heartbeat_sequence: 1,
    reservation_id: reservation.reservation_id,
    claim_id: claimId,
    operation_id: h.operation.operation_id,
    effect_id: h.operation.effect_id,
    binding_digest_sha256: reservation.binding_digest_sha256,
    heartbeat_token: HEARTBEAT_TOKEN,
    next_heartbeat_token: NEXT_HEARTBEAT_TOKEN,
    ...overrides,
  };
}

function runnerStartObservation(
  h: Harness,
  reservation: Awaited<ReturnType<typeof reserve>>,
  claimId: string,
  overrides: Partial<{ observation_request_id: string; start_observation_token: string }> = {},
) {
  return {
    observation_request_id: '00000000-0000-4000-8000-000000000601',
    reservation_id: reservation.reservation_id,
    claim_id: claimId,
    operation_id: h.operation.operation_id,
    effect_id: h.operation.effect_id,
    binding_digest_sha256: reservation.binding_digest_sha256,
    start_observation_token: START_OBSERVATION_TOKEN,
    ...overrides,
  };
}

function runnerStartEvidence(
  h: Harness,
  reservation: Awaited<ReturnType<typeof reserve>>,
  claimId: string,
  overrides: Partial<RunnerStartEvidence> = {},
): RunnerStartEvidence {
  const observedAt = new Date().toISOString();
  return {
    schema_version: 'starlight.runner_start_evidence.v1',
    reservation_id: reservation.reservation_id,
    claim_id: claimId,
    operation_id: h.operation.operation_id,
    effect_id: h.operation.effect_id,
    binding_digest_sha256: reservation.binding_digest_sha256,
    runner_id: 'openai-codex-worker',
    runner_identity_evidence_ref: 'identity-attestation-001',
    runner_instance_id: 'runner-instance-001',
    runtime_id: 'railway-temporal',
    host_id: 'trusted-host-001',
    channel_binding_sha256: '9'.repeat(64),
    launch_attempt_id: 'launch-attempt-001',
    fencing_generation: 1,
    process_instance_sha256: 'b'.repeat(64),
    evidence_ref: 'runtime-start-evidence-001',
    evidence_sha256: 'c'.repeat(64),
    process_started_at: observedAt,
    observed_at: observedAt,
    access_review_expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
    state: 'start-observed',
    ...overrides,
  };
}

function runnerOutcomeEvidence(
  h: Harness,
  reservation: Awaited<ReturnType<typeof reserve>>,
  claimId: string,
  outcomeKind: 'never-started' | 'process-terminal',
  overrides: Partial<RunnerOutcomeEvidence> = {},
): RunnerOutcomeEvidence {
  const observedAt = new Date().toISOString();
  const common = {
    schema_version: 'starlight.runner_outcome_evidence.v1' as const,
    outcome_event_id: '00000000-0000-4000-8000-000000000701',
    reservation_id: reservation.reservation_id,
    claim_id: claimId,
    operation_id: h.operation.operation_id,
    effect_id: h.operation.effect_id,
    binding_digest_sha256: reservation.binding_digest_sha256,
    runner_id: 'openai-codex-worker',
    runner_identity_evidence_ref: 'identity-attestation-001',
    runner_instance_id: 'runner-instance-001',
    runtime_id: 'railway-temporal',
    host_id: 'trusted-host-001',
    channel_binding_sha256: '9'.repeat(64),
    launch_attempt_id: 'launch-attempt-001',
    fencing_generation: 1,
    evidence_ref: 'runtime-outcome-evidence-001',
    evidence_sha256: 'd'.repeat(64),
    outcome_at: observedAt,
    observed_at: observedAt,
    access_review_expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
    restart_fenced: true as const,
    launch_queue_closed: true as const,
    descendants_quiesced: true as const,
    remote_stop_confirmed: false,
  };
  return outcomeKind === 'never-started'
    ? {
      ...common,
      outcome_kind: 'never-started',
      process_instance_sha256: null,
      start_observation_id: null,
      start_evidence_ref: null,
      start_evidence_sha256: null,
      process_started_at: null,
      exit_disposition: null,
      ...overrides,
    } as RunnerOutcomeEvidence
    : {
      ...common,
      outcome_kind: 'process-terminal',
      process_instance_sha256: 'b'.repeat(64),
      start_observation_id: '00000000-0000-4000-8000-000000000601',
      start_evidence_ref: 'runtime-start-evidence-001',
      start_evidence_sha256: 'c'.repeat(64),
      process_started_at: observedAt,
      exit_disposition: 'unknown',
      ...overrides,
    } as RunnerOutcomeEvidence;
}

function runnerOutcome(
  h: Harness,
  reservation: Awaited<ReturnType<typeof reserve>>,
  claimId: string,
  overrides: Partial<{ outcome_request_id: string; outcome_token: string }> = {},
) {
  return {
    outcome_request_id: '00000000-0000-4000-8000-000000000801',
    reservation_id: reservation.reservation_id,
    claim_id: claimId,
    operation_id: h.operation.operation_id,
    effect_id: h.operation.effect_id,
    binding_digest_sha256: reservation.binding_digest_sha256,
    outcome_token: OUTCOME_TOKEN,
    ...overrides,
  };
}

function runnerUsageEvidence(
  h: Harness,
  reservation: Awaited<ReturnType<typeof reserve>>,
  claimId: string,
  outcomeId: string,
  intervalStart: string,
  intervalEnd: string,
  overrides: Partial<RunnerUsageEvidence> = {},
): RunnerUsageEvidence {
  const observedAt = new Date(Math.max(Date.now(), Date.parse(intervalEnd))).toISOString();
  const statementStatus = overrides.statement_status ?? 'provisional';
  return {
    schema_version: 'starlight.runner_usage_provider_evidence.v1',
    provider_event_id: '00000000-0000-4000-8000-000000000901',
    reservation_id: reservation.reservation_id,
    claim_id: claimId,
    outcome_id: outcomeId,
    operation_id: h.operation.operation_id,
    effect_id: h.operation.effect_id,
    binding_digest_sha256: reservation.binding_digest_sha256,
    runner_id: 'openai-codex-worker',
    runner_identity_evidence_ref: 'identity-attestation-001',
    runner_instance_id: 'runner-instance-001',
    runtime_id: 'railway-temporal',
    host_id: 'trusted-host-001',
    channel_binding_sha256: '9'.repeat(64),
    launch_attempt_id: 'launch-attempt-001',
    fencing_generation: 1,
    process_instance_sha256: null,
    provider_id: 'provider-test-001',
    provider_account_ref: 'provider-account-test-001',
    provider_usage_correlation_id: 'provider-usage-correlation-001',
    meter_id: 'provider-cost-usd',
    evidence_ref: 'provider-usage-evidence-001',
    evidence_sha256: 'e'.repeat(64),
    usage_started_at: intervalStart,
    usage_ended_at: intervalEnd,
    statement_status: statementStatus,
    statement_finalized_at: statementStatus === 'final' ? observedAt : null,
    observed_at: observedAt,
    access_review_expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
    currency: 'USD',
    cumulative_cost_usd: '0.000000',
    authn_kind: 'provider-signed-statement',
    issuer: 'provider-billing-test',
    key_id: 'provider-billing-key-001',
    ...overrides,
  };
}

function runnerUsageRequest(
  h: Harness,
  reservation: Awaited<ReturnType<typeof reserve>>,
  claimId: string,
  outcomeId: string,
  overrides: Partial<{
    usage_request_id: string;
    usage_sequence: number;
    usage_reconciliation_token: string;
    next_usage_reconciliation_token: string;
  }> = {},
) {
  return {
    usage_request_id: '00000000-0000-4000-8000-000000000a01',
    usage_sequence: 1,
    reservation_id: reservation.reservation_id,
    claim_id: claimId,
    outcome_id: outcomeId,
    operation_id: h.operation.operation_id,
    effect_id: h.operation.effect_id,
    binding_digest_sha256: reservation.binding_digest_sha256,
    usage_reconciliation_token: USAGE_TOKEN,
    next_usage_reconciliation_token: NEXT_USAGE_TOKEN,
    ...overrides,
  };
}

async function authorizeForRunnerClaim(h: Harness, leaseDurationMs = 5_000) {
  const reservation = await reserve(h);
  const consumed = await h.authority.consume(consumption(h, reservation));
  assert.equal(consumed.consumed, true);
  if (!consumed.consumed) throw new Error('consume failed');
  const leased = await h.authority.leaseStart(startLease(
    h, reservation, consumed.receipt.consumption_id, { lease_duration_ms: leaseDurationMs },
  ));
  assert.equal(leased.leased, true);
  if (!leased.leased) throw new Error('lease failed');
  const redeemed = await h.authority.redeemStartAuthorization(
    startRedemption(h, reservation, leased.receipt.lease_id),
  );
  assert.equal(redeemed.redeemed, true);
  if (!redeemed.redeemed) throw new Error('redemption failed');
  return { reservation, redeemed };
}

function cancellation(reservation: Awaited<ReturnType<typeof reserve>>, reason: string) {
  return {
    reservation_id: reservation.reservation_id,
    cancel_token: reservation.cancel_token,
    reason,
  };
}

test('store and function-only usage authority share fixed evidence freshness ceilings', async () => {
  const pool = new PGlitePool();
  try {
    assert.doesNotThrow(() => new PostgresOperationAuthorityStore(pool, {
      maxBrokerEvidenceAgeMs: 300_000,
      maxRunnerEvidenceAgeMs: 60_000,
    }));
    assert.throws(() => new PostgresOperationAuthorityStore(pool, { maxBrokerEvidenceAgeMs: 299_999 }),
      /fixed at five minutes/i);
    assert.throws(() => new PostgresOperationAuthorityStore(pool, { maxRunnerEvidenceAgeMs: 60_001 }),
      /fixed at one minute/i);
    assert.match(USAGE_STREAM_INITIALIZE_BODY, /make_interval\(secs => 300\)/);
    assert.match(USAGE_EVIDENCE_APPEND_BODY, /make_interval\(secs => 300\)/);
    assert.match(USAGE_EVIDENCE_APPEND_BODY, /make_interval\(secs => 60\)/);
  } finally { await pool.close(); }
});

async function admitRelated(h: Harness, operation: OperationBinding, suffix: string, duration = 5 * 60_000) {
  const bindingDigest = sha256Digest(operation);
  const approval = signApprovalReceipt({
    schema_version: 'starlight.operation_approval.v1', receipt_id: `approval-${suffix}`,
    issuer: h.approval.issuer, key_id: h.approval.key_id, issued_at: NOW, expires_at: EXPIRES,
    binding_digest_sha256: bindingDigest, scope: 'admit-bounded-operation',
    allowed_capabilities: h.approval.allowed_capabilities,
  }, APPROVAL_SECRET);
  const budget = signBudgetReceipt({
    schema_version: 'starlight.operation_budget.v1', receipt_id: `budget-${suffix}`,
    issuer: h.budget.issuer, key_id: h.budget.key_id, issued_at: NOW, expires_at: EXPIRES,
    binding_digest_sha256: bindingDigest, budget_policy_id: operation.budget_policy_id,
    hard_limit_usd: 0.5,
  }, BUDGET_SECRET);
  await h.store.registerBudget(budget.receipt_id, budget.hard_limit_usd);
  await h.store.putPreparedOperation(operation.operation_id, bindingDigest, NOW);
  return h.authority.admit({
    binding: operation, approval_receipt: approval, budget_receipt: budget,
    reservation_duration_ms: duration,
  });
}

async function authorizeRelatedForRunnerClaim(h: Harness, operation: OperationBinding, suffix: string) {
  const admitted = await admitRelated(h, operation, suffix);
  assert.equal(admitted.admitted, true, admitted.blockers.join(' '));
  if (!admitted.admitted) throw new Error('related admission failed');
  const reservation = admitted.reservation;
  const leaseClaimToken = `lease-${suffix}`.padEnd(43, 'l');
  const redemptionToken = `redeem-${suffix}`.padEnd(43, 'r');
  const controlToken = `control-${suffix}`.padEnd(43, 'c');
  const consumed = await h.authority.consume({
    reservation_id: reservation.reservation_id,
    operation_id: operation.operation_id,
    effect_id: operation.effect_id,
    binding_digest_sha256: reservation.binding_digest_sha256,
    execution_identity: operation.execution_identity,
    identity_evidence_ref: operation.identity_evidence_ref,
    consume_token: reservation.consume_token,
    lease_claim_token: leaseClaimToken,
  });
  assert.equal(consumed.consumed, true, consumed.blockers.join(' '));
  if (!consumed.consumed) throw new Error('related consume failed');
  const leased = await h.authority.leaseStart({
    reservation_id: reservation.reservation_id,
    consumption_id: consumed.receipt.consumption_id,
    start_request_id: `00000000-0000-4000-8000-${suffix.padStart(12, '0')}`,
    operation_id: operation.operation_id,
    effect_id: operation.effect_id,
    binding_digest_sha256: reservation.binding_digest_sha256,
    execution_identity: operation.execution_identity,
    identity_evidence_ref: operation.identity_evidence_ref,
    lease_claim_token: leaseClaimToken,
    redemption_token: redemptionToken,
    control_token: controlToken,
    broker_execution_identity: BROKER_IDENTITY,
    broker_identity_evidence_ref: BROKER_EVIDENCE,
    lease_duration_ms: 5_000,
  });
  assert.equal(leased.leased, true, leased.blockers.join(' '));
  if (!leased.leased) throw new Error('related lease failed');
  const redeemed = await h.authority.redeemStartAuthorization({
    reservation_id: reservation.reservation_id,
    lease_id: leased.receipt.lease_id,
    redemption_request_id: `00000000-0000-4000-8001-${suffix.padStart(12, '0')}`,
    operation_id: operation.operation_id,
    effect_id: operation.effect_id,
    binding_digest_sha256: reservation.binding_digest_sha256,
    execution_identity: operation.execution_identity,
    identity_evidence_ref: operation.identity_evidence_ref,
    redemption_token: redemptionToken,
  });
  assert.equal(redeemed.redeemed, true, redeemed.blockers.join(' '));
  if (!redeemed.redeemed) throw new Error('related redemption failed');
  return { reservation, redeemed, controlToken };
}

const LEGACY_RESERVATION_SCHEMA_SQL = `
CREATE TABLE swarm_authority_revocations (ref TEXT PRIMARY KEY, revoked_at TIMESTAMPTZ NOT NULL, reason TEXT NOT NULL);
CREATE TABLE swarm_authority_control (singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
INSERT INTO swarm_authority_control (singleton) VALUES (TRUE);
CREATE TABLE swarm_authority_hosts (host_id TEXT PRIMARY KEY, evidence JSONB NOT NULL, observed_at TIMESTAMPTZ NOT NULL);
CREATE TABLE swarm_authority_budgets (receipt_id TEXT PRIMARY KEY, hard_limit_usd NUMERIC NOT NULL CHECK (hard_limit_usd >= 0), reserved_usd NUMERIC NOT NULL DEFAULT 0 CHECK (reserved_usd >= 0));
CREATE TABLE swarm_authority_prepared_operations (operation_id TEXT PRIMARY KEY, binding_digest_sha256 CHAR(64) NOT NULL, registered_at TIMESTAMPTZ NOT NULL, state TEXT NOT NULL CHECK (state IN ('ready','cancelled')));
CREATE TABLE swarm_authority_reservations (
  reservation_id UUID PRIMARY KEY, operation_id TEXT NOT NULL UNIQUE, effect_id TEXT NOT NULL UNIQUE,
  binding_digest_sha256 CHAR(64) NOT NULL, approval_receipt_id TEXT NOT NULL,
  budget_receipt_id TEXT NOT NULL, host_id TEXT NOT NULL, reserved_cost_usd NUMERIC NOT NULL,
  reserved_at TIMESTAMPTZ NOT NULL, reservation_expires_at TIMESTAMPTZ NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('reserved-not-started'))
);
CREATE TABLE swarm_authority_audit (
  seq BIGSERIAL PRIMARY KEY, event TEXT NOT NULL CHECK (event IN ('admitted','denied','revoked','cancelled')),
  operation_id TEXT NOT NULL, binding_digest_sha256 CHAR(64) NOT NULL,
  at TIMESTAMPTZ NOT NULL, detail JSONB NOT NULL
);`;

const PRE_AGGREGATE_SCHEMA_SQL = `
CREATE TABLE swarm_authority_revocations (ref TEXT PRIMARY KEY, revoked_at TIMESTAMPTZ NOT NULL, reason TEXT NOT NULL);
CREATE TABLE swarm_authority_control (singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
INSERT INTO swarm_authority_control (singleton) VALUES (TRUE);
CREATE TABLE swarm_authority_hosts (
  host_id TEXT PRIMARY KEY,evidence JSONB NOT NULL,observed_at TIMESTAMPTZ NOT NULL,
  capacity_slots INTEGER NOT NULL CHECK (capacity_slots >= 0),reserved_slots INTEGER NOT NULL DEFAULT 0 CHECK (reserved_slots >= 0)
);
CREATE TABLE swarm_authority_budgets (
  receipt_id TEXT PRIMARY KEY,hard_limit_usd NUMERIC NOT NULL CHECK (hard_limit_usd >= 0),
  reserved_usd NUMERIC NOT NULL DEFAULT 0 CHECK (reserved_usd >= 0)
);
CREATE TABLE swarm_authority_prepared_operations (
  operation_id TEXT PRIMARY KEY,binding_digest_sha256 CHAR(64) NOT NULL,registered_at TIMESTAMPTZ NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('ready','cancelled'))
);
CREATE TABLE swarm_authority_reservations (
  reservation_id UUID PRIMARY KEY,operation_id TEXT NOT NULL UNIQUE,effect_id TEXT NOT NULL UNIQUE,
  binding_digest_sha256 CHAR(64) NOT NULL,binding JSONB NOT NULL,revocation_refs JSONB NOT NULL,
  consume_token_sha256 CHAR(64) NOT NULL,cancel_token_sha256 CHAR(64) NOT NULL,approval_receipt_id TEXT NOT NULL,
  budget_receipt_id TEXT NOT NULL,host_id TEXT NOT NULL,reserved_cost_usd NUMERIC NOT NULL,
  reserved_at TIMESTAMPTZ NOT NULL,reservation_expires_at TIMESTAMPTZ NOT NULL,
  max_host_evidence_age_ms INTEGER NOT NULL CHECK (max_host_evidence_age_ms BETWEEN 1000 AND 3600000),
  consumption_id UUID UNIQUE,consumed_at TIMESTAMPTZ,
  state TEXT NOT NULL CHECK (state IN ('reserved-not-started','consumed-not-started','cancelled','expired'))
);
CREATE TABLE swarm_authority_audit (
  seq BIGSERIAL PRIMARY KEY,event TEXT NOT NULL CHECK (event IN ('admitted','reserved','denied','revoked','cancelled','consumed','consume-denied','reservation-cancelled','expired')),
  operation_id TEXT NOT NULL,binding_digest_sha256 CHAR(64) NOT NULL,at TIMESTAMPTZ NOT NULL,detail JSONB NOT NULL
);`;

test('upgrades the reservation-only schema by cancelling unsafe legacy holds exactly once', async () => {
  const pool = new PGlitePool();
  try {
    await pool.execute(LEGACY_RESERVATION_SCHEMA_SQL);
    const legacyEvidence = {
      host_id: 'legacy-host', observed_at: NOW, status: 'ready', available_slots: 1,
      secret_readiness: true, access_review_expires_at: EXPIRES,
      allowed_capabilities: ['repository.read'],
    };
    await pool.execute(`
      INSERT INTO swarm_authority_hosts VALUES ('legacy-host','${JSON.stringify(legacyEvidence)}'::jsonb,'${NOW}');
      INSERT INTO swarm_authority_budgets VALUES ('legacy-budget',1,0.25);
      INSERT INTO swarm_authority_prepared_operations VALUES ('legacy-operation','${'a'.repeat(64)}','${NOW}','ready');
      INSERT INTO swarm_authority_reservations VALUES (
        '00000000-0000-4000-8000-000000000001','legacy-operation','legacy-effect','${'a'.repeat(64)}',
        'legacy-approval','legacy-budget','legacy-host',0.25,'${NOW}','${EXPIRES}','reserved-not-started'
      );
      INSERT INTO swarm_authority_audit (event,operation_id,binding_digest_sha256,at,detail)
      VALUES ('admitted','legacy-operation','${'a'.repeat(64)}','${NOW}','{}'::jsonb);
    `);
    const store = new PostgresOperationAuthorityStore(pool);
    await store.initialize();
    await store.initialize();
    const rows = await pool.rows(`SELECT r.state,r.consume_token_sha256,r.cancel_token_sha256,
      b.reserved_usd,h.capacity_slots,h.reserved_slots,h.evidence
      FROM swarm_authority_reservations r,swarm_authority_budgets b,swarm_authority_hosts h`);
    assert.equal(rows[0].state, 'cancelled');
    assert.equal(Number(rows[0].reserved_usd), 0);
    assert.equal(Number(rows[0].capacity_slots), 2);
    assert.equal(Number(rows[0].reserved_slots), 0);
    assert.equal((rows[0].evidence as Record<string, unknown>).capacity_slots, 2);
    assert.equal('available_slots' in (rows[0].evidence as Record<string, unknown>), false);
    assert.equal(rows[0].consume_token_sha256, '0'.repeat(64));
    assert.equal(rows[0].cancel_token_sha256, '0'.repeat(64));
    const migrationEvents = await pool.rows("SELECT event FROM swarm_authority_audit WHERE event='cancelled'");
    assert.equal(migrationEvents.length, 1);
  } finally { await pool.close(); }
});

test('legacy upgrade fails closed instead of clamping an inconsistent budget hold', async () => {
  const pool = new PGlitePool();
  try {
    await pool.execute(LEGACY_RESERVATION_SCHEMA_SQL);
    const legacyEvidence = {
      host_id: 'legacy-host', observed_at: NOW, status: 'ready', available_slots: 1,
      secret_readiness: true, access_review_expires_at: EXPIRES,
      allowed_capabilities: ['repository.read'],
    };
    await pool.execute(`
      INSERT INTO swarm_authority_hosts VALUES ('legacy-host','${JSON.stringify(legacyEvidence)}'::jsonb,'${NOW}');
      INSERT INTO swarm_authority_budgets VALUES ('legacy-budget',1,0.10);
      INSERT INTO swarm_authority_prepared_operations VALUES ('legacy-operation','${'a'.repeat(64)}','${NOW}','ready');
      INSERT INTO swarm_authority_reservations VALUES (
        '00000000-0000-4000-8000-000000000002','legacy-operation','legacy-effect','${'a'.repeat(64)}',
        'legacy-approval','legacy-budget','legacy-host',0.25,'${NOW}','${EXPIRES}','reserved-not-started'
      );
    `);
    const store = new PostgresOperationAuthorityStore(pool);
    await assert.rejects(() => store.initialize(), /budget ledger is inconsistent/i);
    const rows = await pool.rows(`SELECT r.state,b.reserved_usd,h.evidence
      FROM swarm_authority_reservations r,swarm_authority_budgets b,swarm_authority_hosts h`);
    assert.equal(rows[0].state, 'reserved-not-started');
    assert.equal(Number(rows[0].reserved_usd), 0.1);
    assert.equal((rows[0].evidence as Record<string, unknown>).available_slots, 1);
  } finally { await pool.close(); }
});

test('upgrade cancels lifecycle reservations that predate trusted aggregate-window attribution', async () => {
  const pool = new PGlitePool();
  try {
    await pool.execute(PRE_AGGREGATE_SCHEMA_SQL);
    const operation = binding();
    const digest = sha256Digest(operation);
    const evidence = {
      host_id: operation.host_id, observed_at: NOW, status: 'ready', capacity_slots: 4,
      secret_readiness: true, access_review_expires_at: EXPIRES,
      allowed_capabilities: operation.capabilities,
    };
    await pool.execute(`
      INSERT INTO swarm_authority_hosts VALUES ('${operation.host_id}','${JSON.stringify(evidence)}'::jsonb,'${NOW}',4,1);
      INSERT INTO swarm_authority_budgets VALUES ('budget-pre-aggregate',1,0.25);
      INSERT INTO swarm_authority_prepared_operations VALUES ('${operation.operation_id}','${digest}','${NOW}','ready');
      INSERT INTO swarm_authority_reservations (
        reservation_id,operation_id,effect_id,binding_digest_sha256,binding,revocation_refs,
        consume_token_sha256,cancel_token_sha256,approval_receipt_id,budget_receipt_id,host_id,
        reserved_cost_usd,reserved_at,reservation_expires_at,max_host_evidence_age_ms,state
      ) VALUES (
        '00000000-0000-4000-8000-000000000003','${operation.operation_id}','${operation.effect_id}','${digest}',
        '${JSON.stringify(operation)}'::jsonb,'["key:approval:key"]'::jsonb,'${'1'.repeat(64)}','${'2'.repeat(64)}',
        'approval-pre-aggregate','budget-pre-aggregate','${operation.host_id}',0.25,'${NOW}','${EXPIRES}',300000,'reserved-not-started'
      );
    `);
    const store = new PostgresOperationAuthorityStore(pool);
    await store.initialize();
    await store.initialize();
    const rows = await pool.rows(`SELECT r.state,b.reserved_usd,h.reserved_slots
      FROM swarm_authority_reservations r,swarm_authority_budgets b,swarm_authority_hosts h`);
    assert.equal(rows[0].state, 'cancelled');
    assert.equal(Number(rows[0].reserved_usd), 0);
    assert.equal(Number(rows[0].reserved_slots), 0);
    assert.equal((await pool.rows('SELECT * FROM swarm_authority_budget_holds')).length, 0);
    const events = await pool.rows("SELECT event,detail FROM swarm_authority_audit WHERE event='reservation-cancelled'");
    assert.equal(events.length, 1);
    assert.match(JSON.stringify(events[0].detail), /predated aggregate budget binding/i);
  } finally { await pool.close(); }
});

test('issues a durable reserved-not-started reservation and atomically denies replay', async () => {
  const h = await harness();
  try {
    const first = await h.authority.admit({
      binding: h.operation,
      approval_receipt: h.approval,
      budget_receipt: h.budget,
      reservation_duration_ms: 60_000,
    });
    assert.equal(first.admitted, true);
    if (!first.admitted) return;
    assert.equal(first.reservation.state, 'reserved-not-started');
    assert.equal(first.reservation.reserved_cost_usd, 0.25);

    const replay = await h.authority.admit({
      binding: h.operation,
      approval_receipt: h.approval,
      budget_receipt: h.budget,
      reservation_duration_ms: 60_000,
    });
    assert.equal(replay.admitted, false);
    assert.match(replay.blockers.join(' '), /already reserved/i);

    const sameEffect = binding({ operation_id: 'operation-002', effect_id: h.operation.effect_id });
    const sameEffectDigest = sha256Digest(sameEffect);
    const sameEffectApproval = signApprovalReceipt({
      schema_version: 'starlight.operation_approval.v1', receipt_id: 'approval-002',
      issuer: h.approval.issuer, key_id: h.approval.key_id, issued_at: NOW, expires_at: EXPIRES,
      binding_digest_sha256: sameEffectDigest, scope: 'admit-bounded-operation',
      allowed_capabilities: h.approval.allowed_capabilities,
    }, APPROVAL_SECRET);
    const sameEffectBudget = signBudgetReceipt({
      schema_version: 'starlight.operation_budget.v1', receipt_id: 'budget-002',
      issuer: h.budget.issuer, key_id: h.budget.key_id, issued_at: NOW, expires_at: EXPIRES,
      binding_digest_sha256: sameEffectDigest, budget_policy_id: sameEffect.budget_policy_id,
      hard_limit_usd: h.budget.hard_limit_usd,
    }, BUDGET_SECRET);
    await h.store.registerBudget(sameEffectBudget.receipt_id, sameEffectBudget.hard_limit_usd);
    await h.store.putPreparedOperation(sameEffect.operation_id, sameEffectDigest, NOW);
    const duplicateEffect = await h.authority.admit({
      binding: sameEffect,
      approval_receipt: sameEffectApproval,
      budget_receipt: sameEffectBudget,
      reservation_duration_ms: 60_000,
    });
    assert.equal(duplicateEffect.admitted, false);
    assert.match(duplicateEffect.blockers.join(' '), /external effect was already reserved/i);

    const budgets = await h.pool.rows('SELECT receipt_id,reserved_usd FROM swarm_authority_budgets ORDER BY receipt_id');
    assert.deepEqual(budgets.map((row) => [row.receipt_id, Number(row.reserved_usd)]), [
      ['budget-001', 0.25], ['budget-002', 0],
    ]);
    const audits = await h.pool.rows('SELECT event FROM swarm_authority_audit ORDER BY seq');
    assert.deepEqual(audits.map((row) => row.event), [
      'broker-principal-registered', 'budget-window-registered', 'budget-window-registered',
      'reserved', 'denied', 'denied',
    ]);
  } finally { await h.pool.close(); }
});

test('enforces immutable policy and daily windows across independent signed receipts', async () => {
  const h = await harness();
  try {
    const idempotent = await h.store.registerBudgetWindow({
      window_id: `${h.operation.budget_policy_id}:daily-window`,
      policy_id: h.operation.budget_policy_id,
      kind: 'daily',
      starts_at: h.windowStart,
      ends_at: h.windowEnd,
      currency: 'USD',
      hard_limit_usd: 0.5,
    });
    assert.deepEqual(idempotent, { registered: true, already_registered: true, blockers: [] });
    const changedIdentity = await h.store.registerBudgetWindow({
      window_id: `${h.operation.budget_policy_id}:daily-window`,
      policy_id: h.operation.budget_policy_id,
      kind: 'daily',
      starts_at: h.windowStart,
      ends_at: h.windowEnd,
      currency: 'USD',
      hard_limit_usd: 1,
    });
    assert.equal(changedIdentity.registered, false);
    assert.match(changedIdentity.blockers.join(' '), /identity is immutable/i);
    const overlap = await h.store.registerBudgetWindow({
      window_id: 'overlapping-daily-window',
      policy_id: h.operation.budget_policy_id,
      kind: 'daily',
      starts_at: new Date(Date.parse(h.windowStart) + 60_000).toISOString(),
      ends_at: new Date(Date.parse(h.windowStart) + 20 * 60_000).toISOString(),
      currency: 'USD',
      hard_limit_usd: 1,
    });
    assert.equal(overlap.registered, false);
    assert.match(overlap.blockers.join(' '), /overlaps an immutable/i);
    const windowAudits = await h.pool.rows("SELECT event FROM swarm_authority_audit WHERE event LIKE 'budget-window-%' ORDER BY seq");
    assert.deepEqual(windowAudits.map((row) => row.event), [
      'budget-window-registered', 'budget-window-registered', 'budget-window-denied', 'budget-window-denied',
    ]);

    const first = await reserve(h);
    assert.equal(first.budget_policy_id, h.operation.budget_policy_id);
    assert.deepEqual(first.budget_windows.map((window) => window.kind).sort(), ['daily', 'policy']);
    assert.ok(first.budget_windows.every((window) => window.starts_at === h.windowStart && window.ends_at === h.windowEnd));
    const secondOperation = binding({ operation_id: 'operation-aggregate-002', effect_id: 'effect-aggregate-002', call_id: 'call-aggregate-002' });
    const second = await admitRelated(h, secondOperation, 'aggregate-002');
    assert.equal(second.admitted, true);
    const thirdOperation = binding({
      operation_id: 'operation-aggregate-003', effect_id: 'effect-aggregate-003',
      call_id: 'call-aggregate-003', requested_cost_usd: 0.1,
    });
    const exhausted = await admitRelated(h, thirdOperation, 'aggregate-003');
    assert.equal(exhausted.admitted, false);
    assert.match(exhausted.blockers.join(' '), /aggregate budget window is exhausted/i);

    const beforeRelease = await h.pool.rows('SELECT kind,reserved_usd FROM swarm_authority_budget_windows ORDER BY kind');
    assert.deepEqual(beforeRelease.map((row) => [row.kind, Number(row.reserved_usd)]), [['daily', 0.5], ['policy', 0.5]]);
    const cancelled = await h.authority.cancel(cancellation(first, 'release aggregate hold'));
    assert.equal(cancelled.cancelled, true);
    const retry = await admitRelated(h, thirdOperation, 'aggregate-003');
    assert.equal(retry.admitted, true);
    const afterRelease = await h.pool.rows('SELECT kind,reserved_usd FROM swarm_authority_budget_windows ORDER BY kind');
    assert.deepEqual(afterRelease.map((row) => [row.kind, Number(row.reserved_usd)]), [['daily', 0.35], ['policy', 0.35]]);
  } finally { await h.pool.close(); }
});

test('the tighter daily window wins and a reservation cannot cross either window boundary', async (t) => {
  await t.test('daily ceiling', async () => {
    const operation = binding({ budget_policy_id: 'tight-daily-policy' });
    const h = await harness(operation, { policyLimit: 1, dailyLimit: 0.3 });
    try {
      await reserve(h);
      const second = await admitRelated(h, binding({
        budget_policy_id: operation.budget_policy_id, operation_id: 'tight-operation-002',
        effect_id: 'tight-effect-002', call_id: 'tight-call-002', requested_cost_usd: 0.1,
      }), 'tight-002');
      assert.equal(second.admitted, false);
      assert.match(second.blockers.join(' '), /aggregate budget window is exhausted/i);
      const rows = await h.pool.rows('SELECT kind,reserved_usd FROM swarm_authority_budget_windows ORDER BY kind');
      assert.deepEqual(rows.map((row) => [row.kind, Number(row.reserved_usd)]), [['daily', 0.25], ['policy', 0.25]]);
    } finally { await h.pool.close(); }
  });

  await t.test('half-open boundary', async () => {
    const operation = binding({ budget_policy_id: 'boundary-policy' });
    const h = await harness(operation, { endsAt: new Date(Date.now() + 30_000).toISOString() });
    try {
      const denied = await h.authority.admit({
        binding: h.operation, approval_receipt: h.approval, budget_receipt: h.budget,
        reservation_duration_ms: 60_000,
      });
      assert.equal(denied.admitted, false);
      assert.match(denied.blockers.join(' '), /crosses an aggregate budget window boundary/i);
    } finally { await h.pool.close(); }
  });
});

test('fails closed for forged, drifted, escalated, revoked and cancelled authority', async (t) => {
  await t.test('forged approval', async () => {
    const h = await harness();
    try {
      const result = await h.authority.admit({
        binding: h.operation,
        approval_receipt: { ...h.approval, signature: '0'.repeat(64) },
        budget_receipt: h.budget,
        reservation_duration_ms: 60_000,
      });
      assert.equal(result.admitted, false);
      assert.match(result.blockers.join(' '), /not trusted/i);
    } finally { await h.pool.close(); }
  });

  await t.test('call identity drift', async () => {
    const h = await harness();
    try {
      const result = await h.authority.admit({
        binding: { ...h.operation, prompt_sha256: '9'.repeat(64) },
        approval_receipt: h.approval,
        budget_receipt: h.budget,
        reservation_duration_ms: 60_000,
      });
      assert.equal(result.admitted, false);
      assert.match(result.blockers.join(' '), /another operation/i);
    } finally { await h.pool.close(); }
  });

  await t.test('capability escalation', async () => {
    const operation = binding({ capabilities: ['repository.read', 'repository.write', 'repository.delete'] });
    const h = await harness(operation);
    try {
      const result = await h.authority.admit({
        binding: operation,
        approval_receipt: { ...h.approval, allowed_capabilities: ['repository.read', 'repository.write'] },
        budget_receipt: h.budget,
        reservation_duration_ms: 60_000,
      });
      assert.equal(result.admitted, false);
      assert.match(result.blockers.join(' '), /signature|capabilities/i);
    } finally { await h.pool.close(); }
  });

  await t.test('revoked key', async () => {
    const h = await harness();
    try {
      await h.store.revoke('key:starlight-approval:approval-key-001', NOW, 'operator rotation');
      const result = await h.authority.admit({
        binding: h.operation,
        approval_receipt: h.approval,
        budget_receipt: h.budget,
        reservation_duration_ms: 60_000,
      });
      assert.equal(result.admitted, false);
      assert.match(result.blockers.join(' '), /revoked/i);
    } finally { await h.pool.close(); }
  });

  await t.test('cancelled prepared operation', async () => {
    const h = await harness();
    try {
      await h.store.cancelPreparedOperation(h.operation.operation_id);
      const result = await h.authority.admit({
        binding: h.operation,
        approval_receipt: h.approval,
        budget_receipt: h.budget,
        reservation_duration_ms: 60_000,
      });
      assert.equal(result.admitted, false);
      assert.match(result.blockers.join(' '), /cancelled/i);
    } finally { await h.pool.close(); }
  });
});

test('requires server-owned preparation and strictly valid, fresh host evidence', async (t) => {
  assert.throws(
    () => new OperationAuthority({
      durable: true,
      reserve: async () => ({ admitted: false, reservation: null, blockers: [] }),
      consume: async () => ({ consumed: false, receipt: null, blockers: [] }),
      leaseStart: async () => ({ leased: false, receipt: null, blockers: [] }),
      redeemStartAuthorization: async () => ({ redeemed: false, receipt: null, blockers: [] }),
      claimRunnerStart: async () => ({ claimed: false, receipt: null, blockers: [] }),
      acceptRunnerHeartbeat: async () => ({ accepted: false, receipt: null, blockers: [] }),
      reconcileRunnerHeartbeatExpiry: async (input) => ({ reconciled: false, reservation_id: input.reservation_id, state: null, expired: false, blockers: [] }),
      observeRunnerStart: async () => ({ observed: false, receipt: null, blockers: [] }),
      settleRunnerOutcome: async () => ({ settled: false, receipt: null, blockers: [] }),
      recordRunnerUsageEvidence: async () => ({ recorded: false, receipt: null, blockers: [] }),
      cancel: async (input) => ({ cancelled: false, reservation_id: input.reservation_id, state: null, already_terminal: false, released_cost_usd: 0, blockers: [] }),
      recordDenial: async () => {},
    }, { approvalIssuers: {}, budgetIssuers: {} }, Number.NaN),
    /age ceiling/i,
  );

  await t.test('unregistered operation', async () => {
      const h = await harness();
    try {
      const operation = binding({ operation_id: 'operation-unregistered', effect_id: 'effect-unregistered' });
      const operationDigest = sha256Digest(operation);
      const { signature: _approvalSignature, ...approvalBody } = h.approval;
      const { signature: _budgetSignature, ...budgetBody } = h.budget;
      const approval = signApprovalReceipt({ ...approvalBody, receipt_id: 'approval-unregistered', binding_digest_sha256: operationDigest }, APPROVAL_SECRET);
      const budget = signBudgetReceipt({ ...budgetBody, receipt_id: 'budget-unregistered', binding_digest_sha256: operationDigest }, BUDGET_SECRET);
      await h.store.registerBudget(budget.receipt_id, budget.hard_limit_usd);
      const result = await h.authority.admit({ binding: operation, approval_receipt: approval, budget_receipt: budget, reservation_duration_ms: 60_000 });
      assert.equal(result.admitted, false);
      assert.match(result.blockers.join(' '), /prepared operation is missing/i);
    } finally { await h.pool.close(); }
  });

  await t.test('invalid evidence rejected at control-plane boundary', async () => {
    const h = await harness();
    try {
      await assert.rejects(
        h.store.putHostEvidence({
          host_id: h.operation.host_id,
          observed_at: 'not-a-time',
          status: 'ready',
          capacity_slots: 1,
          secret_readiness: true,
          access_review_expires_at: EXPIRES,
          allowed_capabilities: ['repository.read'],
        }),
      );
    } finally { await h.pool.close(); }
  });

  await t.test('stale evidence denied at operation time', async () => {
    const h = await harness();
    try {
      await h.store.putHostEvidence({
        host_id: h.operation.host_id,
        observed_at: new Date(NOW_MS - 10 * 60_000).toISOString(),
        status: 'ready',
        capacity_slots: 1,
        secret_readiness: true,
        access_review_expires_at: EXPIRES,
        allowed_capabilities: ['repository.read', 'repository.write'],
      });
      const result = await h.authority.admit({
        binding: h.operation,
        approval_receipt: h.approval,
        budget_receipt: h.budget,
        reservation_duration_ms: 60_000,
      });
      assert.equal(result.admitted, false);
      assert.match(result.blockers.join(' '), /stale/i);
    } finally { await h.pool.close(); }
  });

  await t.test('database time defeats a stale application clock', async () => {
    const h = await harness();
    try {
      const issuedAt = new Date(NOW_MS - 20 * 60_000).toISOString();
      const expiredAt = new Date(NOW_MS - 60_000).toISOString();
      const approval = signApprovalReceipt({
        schema_version: 'starlight.operation_approval.v1', receipt_id: h.approval.receipt_id,
        issuer: h.approval.issuer, key_id: h.approval.key_id, issued_at: issuedAt, expires_at: expiredAt,
        binding_digest_sha256: h.approval.binding_digest_sha256, scope: h.approval.scope,
        allowed_capabilities: h.approval.allowed_capabilities,
      }, APPROVAL_SECRET);
      const budget = signBudgetReceipt({
        schema_version: 'starlight.operation_budget.v1', receipt_id: h.budget.receipt_id,
        issuer: h.budget.issuer, key_id: h.budget.key_id, issued_at: issuedAt, expires_at: expiredAt,
        binding_digest_sha256: h.budget.binding_digest_sha256, budget_policy_id: h.budget.budget_policy_id,
        hard_limit_usd: h.budget.hard_limit_usd,
      }, BUDGET_SECRET);
      const staleClockAuthority = new OperationAuthority(h.store, {
        approvalIssuers: { [approval.issuer]: { [approval.key_id]: APPROVAL_SECRET } },
        budgetIssuers: { [budget.issuer]: { [budget.key_id]: BUDGET_SECRET } },
      }, 5 * 60_000, () => new Date(NOW_MS - 10 * 60_000).toISOString());
      const result = await staleClockAuthority.admit({
        binding: h.operation,
        approval_receipt: approval,
        budget_receipt: budget,
        reservation_duration_ms: 15 * 60_000,
      });
      assert.equal(result.admitted, false);
      assert.match(result.blockers.join(' '), /expired before the reservation transaction/i);
    } finally { await h.pool.close(); }
  });

  await t.test('missing serialization row fails closed', async () => {
    const h = await harness();
    try {
      await h.pool.execute('DELETE FROM swarm_authority_control');
      const result = await h.authority.admit({
        binding: h.operation,
        approval_receipt: h.approval,
        budget_receipt: h.budget,
        reservation_duration_ms: 60_000,
      });
      assert.equal(result.admitted, false);
      assert.match(result.blockers.join(' '), /serialization control row/i);
    } finally { await h.pool.close(); }
  });
});

test('consumes once, returns an idempotent receipt, and never persists or audits the bearer token', async () => {
  const h = await harness();
  try {
    const reservation = await reserve(h);
    assert.match(reservation.consume_token, /^[A-Za-z0-9_-]{43}$/);

    const forged = await h.authority.consume({
      ...consumption(h, reservation),
      consume_token: 'A'.repeat(43),
    });
    assert.equal(forged.consumed, false);
    assert.match(forged.blockers.join(' '), /does not exist/i);

    const first = await h.authority.consume(consumption(h, reservation));
    assert.equal(first.consumed, true);
    if (!first.consumed) return;
    assert.equal(first.receipt.state, 'consumed-not-started');
    assert.equal(first.receipt.consumption_expires_at, reservation.reservation_expires_at);
    assert.deepEqual(first.receipt.budget_windows, reservation.budget_windows);

    const retry = await h.authority.consume(consumption(h, reservation));
    assert.equal(retry.consumed, true);
    if (!retry.consumed) return;
    assert.equal(retry.receipt.consumption_id, first.receipt.consumption_id);
    assert.equal(retry.receipt.consumed_at, first.receipt.consumed_at);

    const stored = await h.pool.rows('SELECT consume_token_sha256,state,consumption_id FROM swarm_authority_reservations');
    assert.equal(stored[0].state, 'consumed-not-started');
    assert.equal(stored[0].consumption_id, first.receipt.consumption_id);
    assert.notEqual(stored[0].consume_token_sha256, reservation.consume_token);
    const audit = await h.pool.rows('SELECT event,detail FROM swarm_authority_audit ORDER BY seq');
    assert.deepEqual(audit.map((row) => row.event), [
      'broker-principal-registered', 'budget-window-registered', 'budget-window-registered',
      'reserved', 'consume-denied', 'consumed',
    ]);
    assert.doesNotMatch(JSON.stringify(audit), new RegExp(reservation.consume_token));
  } finally { await h.pool.close(); }
});

test('consume binds the durable execution identity and preserves the reservation after a denial', async () => {
  const h = await harness();
  try {
    const reservation = await reserve(h);
    const aliased = await h.authority.consume({
      ...consumption(h, reservation),
      lease_claim_token: reservation.consume_token,
    });
    assert.equal(aliased.consumed, false);
    assert.match(aliased.blockers.join(' '), /invalid|distinct/i);
    const denied = await h.authority.consume({
      ...consumption(h, reservation),
      execution_identity: 'different-execution-identity',
    });
    assert.equal(denied.consumed, false);
    assert.match(denied.blockers.join(' '), /identity/i);
    const accepted = await h.authority.consume(consumption(h, reservation));
    assert.equal(accepted.consumed, true);
  } finally { await h.pool.close(); }
});

test('binds a separate lease credential and issues one idempotent, explicitly non-dispatched start lease', async () => {
  const h = await harness();
  try {
    const reservation = await reserve(h);
    const consumed = await h.authority.consume(consumption(h, reservation));
    assert.equal(consumed.consumed, true);
    if (!consumed.consumed) return;

    const changedCredential = await h.authority.consume({
      ...consumption(h, reservation),
      lease_claim_token: 'M'.repeat(43),
    });
    assert.equal(changedCredential.consumed, false);
    assert.match(changedCredential.blockers.join(' '), /changed the lease-claim credential/i);

    const forged = await h.authority.leaseStart({
      ...startLease(h, reservation, consumed.receipt.consumption_id),
      lease_claim_token: 'M'.repeat(43),
    });
    assert.equal(forged.leased, false);
    assert.match(forged.blockers.join(' '), /does not exist/i);

    const aliased = await h.authority.leaseStart({
      ...startLease(h, reservation, consumed.receipt.consumption_id),
      redemption_token: LEASE_CLAIM_TOKEN,
    });
    assert.equal(aliased.leased, false);
    assert.match(aliased.blockers.join(' '), /invalid/i);

    const consumeAsRedemption = await h.authority.leaseStart({
      ...startLease(h, reservation, consumed.receipt.consumption_id),
      redemption_token: reservation.consume_token,
    });
    assert.equal(consumeAsRedemption.leased, false);
    assert.match(consumeAsRedemption.blockers.join(' '), /pairwise distinct/i);

    const consumeAsControl = await h.authority.leaseStart({
      ...startLease(h, reservation, consumed.receipt.consumption_id),
      control_token: reservation.consume_token,
    });
    assert.equal(consumeAsControl.leased, false);
    assert.match(consumeAsControl.blockers.join(' '), /pairwise distinct/i);

    const input = startLease(h, reservation, consumed.receipt.consumption_id);
    const first = await h.authority.leaseStart(input);
    assert.equal(first.leased, true);
    if (!first.leased) return;
    assert.equal(first.receipt.state, 'leased-not-started');
    assert.equal(first.receipt.dispatch_state, 'not-dispatched');
    assert.equal(first.receipt.runner_activation_authorized, false);
    assert.equal(first.receipt.lease_duration_ms, input.lease_duration_ms);
    assert.equal(first.receipt.lease_claim_token_sha256, consumed.receipt.lease_claim_token_sha256);

    const retry = await h.authority.leaseStart(input);
    assert.equal(retry.leased, true);
    if (!retry.leased) return;
    assert.deepEqual(retry.receipt, first.receipt);

    const competing = await h.authority.leaseStart({
      ...input,
      start_request_id: '00000000-0000-4000-8000-000000000102',
    });
    assert.equal(competing.leased, false);
    assert.match(competing.blockers.join(' '), /different start lease/i);

    const stored = await h.pool.rows(`SELECT state,lease_id,start_request_id,lease_claim_token_sha256
      FROM swarm_authority_reservations`);
    assert.equal(stored[0].state, 'leased-not-started');
    assert.equal(stored[0].lease_id, first.receipt.lease_id);
    assert.equal(stored[0].start_request_id, input.start_request_id);
    const issued = await h.pool.rows("SELECT detail FROM swarm_authority_audit WHERE event='start-lease-issued'");
    assert.equal(issued.length, 1);
    const audit = JSON.stringify(await h.pool.rows('SELECT detail FROM swarm_authority_audit ORDER BY seq'));
    assert.doesNotMatch(audit, new RegExp(reservation.consume_token));
    assert.doesNotMatch(audit, new RegExp(LEASE_CLAIM_TOKEN));
  } finally { await h.pool.close(); }
});

test('redeems one start authority, moves reserved ledgers to committed, and quarantines cancellation', async () => {
  const h = await harness();
  try {
    const reservation = await reserve(h);
    const consumed = await h.authority.consume(consumption(h, reservation));
    assert.equal(consumed.consumed, true);
    if (!consumed.consumed) return;
    const leaseInput = startLease(h, reservation, consumed.receipt.consumption_id);
    const leased = await h.authority.leaseStart(leaseInput);
    assert.equal(leased.leased, true);
    if (!leased.leased) return;

    const forged = await h.authority.redeemStartAuthorization(startRedemption(
      h, reservation, leased.receipt.lease_id, { redemption_token: 'F'.repeat(43) },
    ));
    assert.equal(forged.redeemed, false);
    assert.match(forged.blockers.join(' '), /credential/i);

    const identityDrift = await h.authority.redeemStartAuthorization({
      ...startRedemption(h, reservation, leased.receipt.lease_id),
      broker_execution_identity: 'caller-forged-broker',
    });
    assert.equal(identityDrift.redeemed, false);
    assert.match(identityDrift.blockers.join(' '), /invalid/i);

    const input = startRedemption(h, reservation, leased.receipt.lease_id);
    const first = await h.authority.redeemStartAuthorization(input);
    assert.equal(first.redeemed, true);
    if (!first.redeemed) return;
    assert.equal(first.receipt.authorization_state, 'start-authorized');
    assert.equal(first.receipt.execution_observed, false);
    assert.equal(first.receipt.state, 'start-authorized-not-observed');
    assert.equal(first.receipt.committed_cost_usd, h.operation.requested_cost_usd);
    assert.equal(first.receipt.broker_execution_identity, BROKER_IDENTITY);
    assert.equal(first.receipt.broker_database_role, BROKER_DATABASE_ROLE);
    assert.equal(first.receipt.broker_role_contract_sha256, BROKER_DATABASE_ROLE_CONTRACT_SHA256);

    const retry = await h.authority.redeemStartAuthorization(input);
    assert.equal(retry.redeemed, true);
    if (retry.redeemed) assert.deepEqual(retry.receipt, first.receipt);
    const competing = await h.authority.redeemStartAuthorization({
      ...input,
      redemption_request_id: '00000000-0000-4000-8000-000000000302',
    });
    assert.equal(competing.redeemed, false);
    assert.match(competing.blockers.join(' '), /different redemption request/i);

    const authorized = await h.pool.rows(`SELECT r.state,b.reserved_usd,b.committed_usd,
      host.reserved_slots,host.authorized_slots
      FROM swarm_authority_reservations r,swarm_authority_budgets b,swarm_authority_hosts host`);
    assert.equal(authorized[0].state, 'start-authorized-not-observed');
    assert.equal(Number(authorized[0].reserved_usd), 0);
    assert.equal(Number(authorized[0].committed_usd), 0.25);
    assert.equal(Number(authorized[0].reserved_slots), 0);
    assert.equal(Number(authorized[0].authorized_slots), 1);
    const windows = await h.pool.rows('SELECT reserved_usd,committed_usd FROM swarm_authority_budget_windows');
    assert.ok(windows.every((row) => Number(row.reserved_usd) === 0 && Number(row.committed_usd) === 0.25));

    const stopped = await h.authority.cancel(cancellation(reservation, 'stop after authorization'));
    assert.equal(stopped.cancelled, false);
    assert.equal(stopped.state, 'stop-requested');
    assert.equal(stopped.released_cost_usd, 0);
    const retained = await h.pool.rows(`SELECT r.state,b.committed_usd,host.authorized_slots
      FROM swarm_authority_reservations r,swarm_authority_budgets b,swarm_authority_hosts host`);
    assert.equal(retained[0].state, 'stop-requested');
    assert.equal(Number(retained[0].committed_usd), 0.25);
    assert.equal(Number(retained[0].authorized_slots), 1);
    const audit = JSON.stringify(await h.pool.rows('SELECT detail FROM swarm_authority_audit ORDER BY seq'));
    assert.doesNotMatch(audit, new RegExp(REDEMPTION_TOKEN));
    assert.doesNotMatch(audit, new RegExp(CONTROL_TOKEN));
    const redemptions = await h.pool.rows("SELECT event FROM swarm_authority_audit WHERE event='start-authority-redeemed'");
    assert.equal(redemptions.length, 1);
  } finally { await h.pool.close(); }
});

test('runner claim is transport-attested, replay-safe, and remains not-started', async () => {
  const h = await harness(binding(), {}, runnerSessionAttestor);
  try {
    const reservation = await reserve(h);
    const consumed = await h.authority.consume(consumption(h, reservation));
    assert.equal(consumed.consumed, true);
    if (!consumed.consumed) return;
    const leased = await h.authority.leaseStart(startLease(h, reservation, consumed.receipt.consumption_id));
    assert.equal(leased.leased, true);
    if (!leased.leased) return;
    const redeemed = await h.authority.redeemStartAuthorization(
      startRedemption(h, reservation, leased.receipt.lease_id),
    );
    assert.equal(redeemed.redeemed, true);
    if (!redeemed.redeemed) return;

    const input = runnerClaim(h, reservation, redeemed.receipt.redemption_id);
    const first = await h.authority.claimRunnerStart(input);
    assert.equal(first.claimed, true, first.blockers.join(' '));
    if (!first.claimed) return;
    assert.equal(first.receipt.state, 'runner-claimed-not-started');
    assert.equal(first.receipt.execution_observed, false);
    assert.equal(first.receipt.dispatch_state, 'not-dispatched');
    assert.equal(first.receipt.runner_id, h.operation.execution_identity);
    assert.equal(first.receipt.runtime_id, h.operation.runtime_id);

    const retry = await h.authority.claimRunnerStart(input);
    assert.equal(retry.claimed, true, retry.blockers.join(' '));
    if (retry.claimed) assert.deepEqual(retry.receipt, first.receipt);
    const competing = await h.authority.claimRunnerStart({
      ...input, claim_request_id: '00000000-0000-4000-8000-000000000402',
    });
    assert.equal(competing.claimed, false);
    assert.match(competing.blockers.join(' '), /different runner claim/i);

    await h.store.revoke(`runner:${h.operation.execution_identity}`, NOW, 'runner identity revoked');
    const rows = await h.pool.rows(`SELECT r.state,b.committed_usd,host.authorized_slots
      FROM swarm_authority_reservations r,swarm_authority_budgets b,swarm_authority_hosts host`);
    assert.equal(rows[0].state, 'stop-requested');
    assert.equal(Number(rows[0].committed_usd), 0.25);
    assert.equal(Number(rows[0].authorized_slots), 1);
    const audit = JSON.stringify(await h.pool.rows('SELECT event,detail FROM swarm_authority_audit ORDER BY seq'));
    assert.doesNotMatch(audit, new RegExp(HEARTBEAT_TOKEN));
    assert.doesNotMatch(audit, new RegExp(CONTROL_TOKEN));
    const accepted = await h.pool.rows("SELECT event FROM swarm_authority_audit WHERE event='runner-claim-accepted'");
    assert.equal(accepted.length, 1);
  } finally { await h.pool.close(); }
});

test('runner heartbeat rotates credentials, renews once, and never proves execution', async () => {
  const h = await harness(binding(), {}, runnerSessionAttestor);
  try {
    const { reservation, redeemed } = await authorizeForRunnerClaim(h, 90_000);
    const claim = await h.authority.claimRunnerStart(
      runnerClaim(h, reservation, redeemed.receipt.redemption_id),
    );
    assert.equal(claim.claimed, true, claim.blockers.join(' '));
    if (!claim.claimed) return;

    const input = runnerHeartbeat(h, reservation, claim.receipt.claim_id);
    const first = await h.authority.acceptRunnerHeartbeat(input);
    assert.equal(first.accepted, true, first.blockers.join(' '));
    if (!first.accepted) return;
    assert.equal(first.receipt.heartbeat_sequence, 1);
    assert.equal(first.receipt.state, 'runner-claimed-not-started');
    assert.equal(first.receipt.execution_observed, false);
    assert.equal(first.receipt.dispatch_state, 'not-dispatched');
    assert.ok(Date.parse(first.receipt.claim_expires_at) > Date.parse(claim.receipt.claim_expires_at));

    const retry = await h.authority.acceptRunnerHeartbeat(input);
    assert.equal(retry.accepted, true, retry.blockers.join(' '));
    if (retry.accepted) assert.deepEqual(retry.receipt, first.receipt);

    const stale = await h.authority.acceptRunnerHeartbeat(runnerHeartbeat(
      h, reservation, claim.receipt.claim_id,
      { heartbeat_request_id: '00000000-0000-4000-8000-000000000502', heartbeat_sequence: 2 },
    ));
    assert.equal(stale.accepted, false);
    assert.match(stale.blockers.join(' '), /credential/i);

    const recycled = await h.authority.acceptRunnerHeartbeat(runnerHeartbeat(
      h, reservation, claim.receipt.claim_id,
      {
        heartbeat_request_id: '00000000-0000-4000-8000-000000000504',
        heartbeat_sequence: 2,
        heartbeat_token: NEXT_HEARTBEAT_TOKEN,
        next_heartbeat_token: HEARTBEAT_TOKEN,
      },
    ));
    assert.equal(recycled.accepted, false);
    assert.match(recycled.blockers.join(' '), /already issued/i);

    const rows = await h.pool.rows(`SELECT r.state,r.runner_heartbeat_sequence,
      b.reserved_usd,b.committed_usd,host.reserved_slots,host.authorized_slots
      FROM swarm_authority_reservations r,swarm_authority_budgets b,swarm_authority_hosts host`);
    assert.equal(rows[0].state, 'runner-claimed-not-started');
    assert.equal(Number(rows[0].runner_heartbeat_sequence), 1);
    assert.deepEqual([
      Number(rows[0].reserved_usd), Number(rows[0].committed_usd),
      Number(rows[0].reserved_slots), Number(rows[0].authorized_slots),
    ], [0, 0.25, 0, 1]);
    const audit = JSON.stringify(await h.pool.rows('SELECT event,detail FROM swarm_authority_audit ORDER BY seq'));
    assert.doesNotMatch(audit, new RegExp(HEARTBEAT_TOKEN));
    assert.doesNotMatch(audit, new RegExp(NEXT_HEARTBEAT_TOKEN));
    const accepted = await h.pool.rows("SELECT event FROM swarm_authority_audit WHERE event='runner-heartbeat-accepted'");
    assert.equal(accepted.length, 1);
  } finally { await h.pool.close(); }
});

test('runner heartbeat fails closed for invalid, unauthenticated, expired, or drifted authority', async (t) => {
  await t.test('next credential aliases the current credential', async () => {
    const h = await harness(binding(), {}, runnerSessionAttestor);
    try {
      const { reservation, redeemed } = await authorizeForRunnerClaim(h, 90_000);
      const claim = await h.authority.claimRunnerStart(runnerClaim(h, reservation, redeemed.receipt.redemption_id));
      assert.equal(claim.claimed, true);
      if (!claim.claimed) return;
      const denied = await h.authority.acceptRunnerHeartbeat(runnerHeartbeat(
        h, reservation, claim.receipt.claim_id, { next_heartbeat_token: HEARTBEAT_TOKEN },
      ));
      assert.equal(denied.accepted, false);
      assert.match(denied.blockers.join(' '), /invalid/i);
      const state = await h.pool.rows('SELECT state,runner_heartbeat_sequence FROM swarm_authority_reservations');
      assert.equal(state[0].state, 'runner-claimed-not-started');
      assert.equal(state[0].runner_heartbeat_sequence, null);
    } finally { await h.pool.close(); }
  });

  await t.test('default runner attestor refuses heartbeat', async () => {
    const h = await harness(binding(), {}, runnerSessionAttestor);
    try {
      const { reservation, redeemed } = await authorizeForRunnerClaim(h, 90_000);
      const claim = await h.authority.claimRunnerStart(runnerClaim(h, reservation, redeemed.receipt.redemption_id));
      assert.equal(claim.claimed, true);
      if (!claim.claimed) return;
      const closed = new OperationAuthority(
        new PostgresOperationAuthorityStore(h.pool, { brokerSessionAttestor }),
        { approvalIssuers: {}, budgetIssuers: {} },
      );
      const denied = await closed.acceptRunnerHeartbeat(runnerHeartbeat(h, reservation, claim.receipt.claim_id));
      assert.equal(denied.accepted, false);
      assert.match(denied.blockers.join(' '), /attestor is not configured/i);
      const state = await h.pool.rows('SELECT state FROM swarm_authority_reservations');
      assert.equal(state[0].state, 'runner-claimed-not-started');
    } finally { await h.pool.close(); }
  });

  await t.test('expired prior claim is quarantined with committed resources retained', async () => {
    const h = await harness(binding(), {}, runnerSessionAttestor);
    try {
      const { reservation, redeemed } = await authorizeForRunnerClaim(h, 90_000);
      const claim = await h.authority.claimRunnerStart(runnerClaim(h, reservation, redeemed.receipt.redemption_id));
      assert.equal(claim.claimed, true);
      if (!claim.claimed) return;
      await h.pool.execute(`UPDATE swarm_authority_reservations SET
        runner_claim_accepted_at=clock_timestamp()-INTERVAL '70 seconds',
        runner_evidence_observed_at=clock_timestamp()-INTERVAL '61 seconds',
        runner_access_review_expires_at=clock_timestamp()+INTERVAL '1 minute',
        runner_claim_expires_at=clock_timestamp()-INTERVAL '1 second'`);
      const denied = await h.authority.acceptRunnerHeartbeat(runnerHeartbeat(h, reservation, claim.receipt.claim_id));
      assert.equal(denied.accepted, false);
      assert.match(denied.blockers.join(' '), /expired/i);
      const rows = await h.pool.rows(`SELECT r.state,b.committed_usd,host.authorized_slots
        FROM swarm_authority_reservations r,swarm_authority_budgets b,swarm_authority_hosts host`);
      assert.equal(rows[0].state, 'stop-requested');
      assert.equal(Number(rows[0].committed_usd), 0.25);
      assert.equal(Number(rows[0].authorized_slots), 1);
    } finally { await h.pool.close(); }
  });

  await t.test('channel drift is quarantined', async () => {
    let channel = '9'.repeat(64);
    const mutableAttestor: RunnerSessionAttestor = async () => ({
      valid: true,
      session: {
        runner_id: 'openai-codex-worker', runner_identity_evidence_ref: 'identity-attestation-001',
        runner_instance_id: 'runner-instance-001', runtime_id: 'railway-temporal',
        host_id: 'trusted-host-001', channel_binding_sha256: channel,
        launch_attempt_id: 'launch-attempt-channel-drift', fencing_generation: 1,
        observed_at: new Date().toISOString(),
        access_review_expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
      },
      blockers: [],
    });
    const h = await harness(binding(), {}, mutableAttestor);
    try {
      const { reservation, redeemed } = await authorizeForRunnerClaim(h, 90_000);
      const claim = await h.authority.claimRunnerStart(runnerClaim(h, reservation, redeemed.receipt.redemption_id));
      assert.equal(claim.claimed, true);
      if (!claim.claimed) return;
      channel = 'a'.repeat(64);
      const denied = await h.authority.acceptRunnerHeartbeat(runnerHeartbeat(h, reservation, claim.receipt.claim_id));
      assert.equal(denied.accepted, false);
      assert.match(denied.blockers.join(' '), /channel drifted/i);
      const state = await h.pool.rows('SELECT state FROM swarm_authority_reservations');
      assert.equal(state[0].state, 'stop-requested');
    } finally { await h.pool.close(); }
  });

  await t.test('stored latest request sequence drift is quarantined on retry', async () => {
    const h = await harness(binding(), {}, runnerSessionAttestor);
    try {
      const { reservation, redeemed } = await authorizeForRunnerClaim(h, 90_000);
      const claim = await h.authority.claimRunnerStart(runnerClaim(h, reservation, redeemed.receipt.redemption_id));
      assert.equal(claim.claimed, true);
      if (!claim.claimed) return;
      const input = runnerHeartbeat(h, reservation, claim.receipt.claim_id);
      assert.equal((await h.authority.acceptRunnerHeartbeat(input)).accepted, true);
      await h.pool.execute('UPDATE swarm_authority_reservations SET runner_heartbeat_sequence=2');
      const denied = await h.authority.acceptRunnerHeartbeat(input);
      assert.equal(denied.accepted, false);
      assert.match(denied.blockers.join(' '), /history drifted|replay drifted/i);
      const state = await h.pool.rows('SELECT state FROM swarm_authority_reservations');
      assert.equal(state[0].state, 'stop-requested');
    } finally { await h.pool.close(); }
  });

  await t.test('monotonic second heartbeat consumes only the rotated credential', async () => {
    const h = await harness(binding(), {}, runnerSessionAttestor);
    try {
      const { reservation, redeemed } = await authorizeForRunnerClaim(h, 90_000);
      const claim = await h.authority.claimRunnerStart(runnerClaim(h, reservation, redeemed.receipt.redemption_id));
      assert.equal(claim.claimed, true);
      if (!claim.claimed) return;
      const first = await h.authority.acceptRunnerHeartbeat(runnerHeartbeat(h, reservation, claim.receipt.claim_id));
      assert.equal(first.accepted, true);
      const secondInput = runnerHeartbeat(
        h, reservation, claim.receipt.claim_id,
        {
          heartbeat_request_id: '00000000-0000-4000-8000-000000000503',
          heartbeat_sequence: 2,
          heartbeat_token: NEXT_HEARTBEAT_TOKEN,
          next_heartbeat_token: SECOND_NEXT_HEARTBEAT_TOKEN,
        },
      );
      const tooSoon = await h.authority.acceptRunnerHeartbeat(secondInput);
      assert.equal(tooSoon.accepted, false);
      assert.match(tooSoon.blockers.join(' '), /minimum interval/i);
      assert.equal((await h.pool.rows("SELECT event FROM swarm_authority_audit WHERE event='runner-heartbeat-denied'")).length, 0);
      await h.pool.execute(`UPDATE swarm_authority_reservations SET
        runner_claim_accepted_at=runner_claim_accepted_at-INTERVAL '2 seconds',
        runner_heartbeat_accepted_at=runner_heartbeat_accepted_at-INTERVAL '2 seconds'`);
      const second = await h.authority.acceptRunnerHeartbeat(secondInput);
      assert.equal(second.accepted, true, second.blockers.join(' '));
      if (second.accepted) assert.equal(second.receipt.heartbeat_sequence, 2);
      const recycled = await h.authority.acceptRunnerHeartbeat(runnerHeartbeat(
        h, reservation, claim.receipt.claim_id,
        {
          heartbeat_request_id: '00000000-0000-4000-8000-000000000505',
          heartbeat_sequence: 3,
          heartbeat_token: SECOND_NEXT_HEARTBEAT_TOKEN,
          next_heartbeat_token: NEXT_HEARTBEAT_TOKEN,
        },
      ));
      assert.equal(recycled.accepted, false);
      assert.match(recycled.blockers.join(' '), /already issued/i);
      const events = await h.pool.rows("SELECT event FROM swarm_authority_audit WHERE event='runner-heartbeat-accepted'");
      assert.equal(events.length, 2);
    } finally { await h.pool.close(); }
  });
});

test('server-owned start evidence advances one claim exactly once without releasing committed authority', async () => {
  let evidence: RunnerStartEvidence | undefined;
  const startAttestor: RunnerStartEvidenceAttestor = async () => evidence
    ? { valid: true, evidence, blockers: [] }
    : { valid: false, evidence: null, blockers: ['No server-owned process evidence exists.'] };
  const h = await harness(binding(), {}, runnerSessionAttestor, startAttestor);
  try {
    const { reservation, redeemed } = await authorizeForRunnerClaim(h, 90_000);
    const claim = await h.authority.claimRunnerStart(runnerClaim(h, reservation, redeemed.receipt.redemption_id));
    assert.equal(claim.claimed, true, claim.blockers.join(' '));
    if (!claim.claimed) return;
    evidence = runnerStartEvidence(h, reservation, claim.receipt.claim_id);

    const input = runnerStartObservation(h, reservation, claim.receipt.claim_id);
    const first = await h.authority.observeRunnerStart(input);
    assert.equal(first.observed, true, first.blockers.join(' '));
    if (!first.observed) return;
    assert.equal(first.receipt.state, 'runner-start-observed');
    assert.equal(first.receipt.execution_observed, true);
    assert.equal(first.receipt.workload_effect_observed, false);
    assert.equal(first.receipt.dispatch_state, 'not-dispatched');

    const retry = await h.authority.observeRunnerStart(input);
    assert.equal(retry.observed, true, retry.blockers.join(' '));
    if (retry.observed) assert.deepEqual(retry.receipt, first.receipt);

    const rows = await h.pool.rows(`SELECT r.state,b.reserved_usd,b.committed_usd,
      host.reserved_slots,host.authorized_slots
      FROM swarm_authority_reservations r,swarm_authority_budgets b,swarm_authority_hosts host`);
    assert.equal(rows[0].state, 'runner-start-observed');
    assert.deepEqual([
      Number(rows[0].reserved_usd), Number(rows[0].committed_usd),
      Number(rows[0].reserved_slots), Number(rows[0].authorized_slots),
    ], [0, 0.25, 0, 1]);
    const accepted = await h.pool.rows("SELECT event FROM swarm_authority_audit WHERE event='runner-start-observed'");
    assert.equal(accepted.length, 1);
    const audit = JSON.stringify(await h.pool.rows('SELECT event,detail FROM swarm_authority_audit ORDER BY seq'));
    assert.doesNotMatch(audit, new RegExp(START_OBSERVATION_TOKEN));
  } finally { await h.pool.close(); }
});

test('settles fenced runner outcomes once, releases only host capacity, and retains committed spend', async (t) => {
  await t.test('authoritative never-started evidence', async () => {
    let outcomeEvidence: RunnerOutcomeEvidence | undefined;
    let startEvidence: RunnerStartEvidence | undefined;
    const outcomeAttestor: RunnerOutcomeEvidenceAttestor = async () => outcomeEvidence
      ? { valid: true, evidence: outcomeEvidence, blockers: [] }
      : { valid: false, evidence: null, blockers: ['No server-owned outcome evidence exists.'] };
    const startAttestor: RunnerStartEvidenceAttestor = async () => startEvidence
      ? { valid: true, evidence: startEvidence, blockers: [] }
      : { valid: false, evidence: null, blockers: ['No server-owned process evidence exists.'] };
    const h = await harness(binding(), {}, runnerSessionAttestor, startAttestor, outcomeAttestor);
    try {
      const { reservation, redeemed } = await authorizeForRunnerClaim(h, 90_000);
      const claim = await h.authority.claimRunnerStart(runnerClaim(h, reservation, redeemed.receipt.redemption_id));
      assert.equal(claim.claimed, true, claim.blockers.join(' '));
      if (!claim.claimed) return;
      outcomeEvidence = runnerOutcomeEvidence(h, reservation, claim.receipt.claim_id, 'never-started');
      const request = runnerOutcome(h, reservation, claim.receipt.claim_id);
      const settled = await h.authority.settleRunnerOutcome(request);
      assert.equal(settled.settled, true, settled.blockers.join(' '));
      if (!settled.settled) return;
      assert.equal(settled.receipt.state, 'runner-never-started-observed');
      assert.equal(settled.receipt.host_capacity_released, false);
      assert.equal(settled.receipt.budget_commitment_released, false);
      assert.equal(settled.receipt.actual_usage_reconciled, false);
      assert.equal(settled.receipt.released_cost_usd, 0);
      const retry = await h.authority.settleRunnerOutcome(request);
      assert.equal(retry.settled, true, retry.blockers.join(' '));
      if (retry.settled) assert.deepEqual(retry.receipt, settled.receipt);

      startEvidence = runnerStartEvidence(h, reservation, claim.receipt.claim_id);
      const lateStart = await h.authority.observeRunnerStart(
        runnerStartObservation(h, reservation, claim.receipt.claim_id),
      );
      assert.equal(lateStart.observed, false);
      const rows = await h.pool.rows(`SELECT r.state,b.committed_usd,host.authorized_slots
        FROM swarm_authority_reservations r,swarm_authority_budgets b,swarm_authority_hosts host`);
      assert.equal(rows[0].state, 'stop-requested');
      assert.equal(Number(rows[0].committed_usd), 0.25);
      assert.equal(Number(rows[0].authorized_slots), 1);
      assert.ok((await h.pool.rows('SELECT committed_usd FROM swarm_authority_budget_windows'))
        .every((row) => Number(row.committed_usd) === 0.25));
      assert.equal((await h.pool.rows("SELECT event FROM swarm_authority_audit WHERE event='runner-outcome-observed'")).length, 1);
      assert.equal((await h.pool.rows("SELECT event FROM swarm_authority_audit WHERE event='host-capacity-released'")).length, 0);
    } finally { await h.pool.close(); }
  });

  await t.test('process-terminal evidence is bound to the stored start observation', async () => {
    let startEvidence: RunnerStartEvidence | undefined;
    let outcomeEvidence: RunnerOutcomeEvidence | undefined;
    const startAttestor: RunnerStartEvidenceAttestor = async () => startEvidence
      ? { valid: true, evidence: startEvidence, blockers: [] }
      : { valid: false, evidence: null, blockers: ['No server-owned process evidence exists.'] };
    const outcomeAttestor: RunnerOutcomeEvidenceAttestor = async () => outcomeEvidence
      ? { valid: true, evidence: outcomeEvidence, blockers: [] }
      : { valid: false, evidence: null, blockers: ['No server-owned outcome evidence exists.'] };
    const h = await harness(binding(), {}, runnerSessionAttestor, startAttestor, outcomeAttestor);
    try {
      const { reservation, redeemed } = await authorizeForRunnerClaim(h, 90_000);
      const claim = await h.authority.claimRunnerStart(runnerClaim(h, reservation, redeemed.receipt.redemption_id));
      assert.equal(claim.claimed, true, claim.blockers.join(' '));
      if (!claim.claimed) return;
      startEvidence = runnerStartEvidence(h, reservation, claim.receipt.claim_id);
      const started = await h.authority.observeRunnerStart(
        runnerStartObservation(h, reservation, claim.receipt.claim_id),
      );
      assert.equal(started.observed, true, started.blockers.join(' '));
      if (!started.observed) return;
      outcomeEvidence = runnerOutcomeEvidence(h, reservation, claim.receipt.claim_id, 'process-terminal', {
        start_observation_id: started.receipt.observation_id,
        process_started_at: started.receipt.process_started_at,
        outcome_at: new Date(Math.max(Date.now(), Date.parse(started.receipt.process_started_at))).toISOString(),
        observed_at: new Date(Math.max(Date.now(), Date.parse(started.receipt.process_started_at))).toISOString(),
      });
      const settled = await h.authority.settleRunnerOutcome(runnerOutcome(
        h, reservation, claim.receipt.claim_id,
        { outcome_request_id: '00000000-0000-4000-8000-000000000802' },
      ));
      assert.equal(settled.settled, true, settled.blockers.join(' '));
      if (!settled.settled) return;
      assert.equal(settled.receipt.state, 'runner-terminal-observed');
      assert.equal(settled.receipt.execution_observed, true);
      assert.equal(settled.receipt.workload_effect_observed, false);
      const rows = await h.pool.rows(`SELECT r.state,b.committed_usd,host.authorized_slots
        FROM swarm_authority_reservations r,swarm_authority_budgets b,swarm_authority_hosts host`);
      assert.deepEqual([rows[0].state, Number(rows[0].committed_usd), Number(rows[0].authorized_slots)],
        ['runner-terminal-observed', 0.25, 0]);
    } finally { await h.pool.close(); }
  });

  await t.test('default outcome attestor refuses release', async () => {
    const h = await harness(binding(), {}, runnerSessionAttestor);
    try {
      const { reservation, redeemed } = await authorizeForRunnerClaim(h, 90_000);
      const claim = await h.authority.claimRunnerStart(runnerClaim(h, reservation, redeemed.receipt.redemption_id));
      assert.equal(claim.claimed, true);
      if (!claim.claimed) return;
      const denied = await h.authority.settleRunnerOutcome(runnerOutcome(h, reservation, claim.receipt.claim_id));
      assert.equal(denied.settled, false);
      assert.match(denied.blockers.join(' '), /attestor is not configured/i);
      const rows = await h.pool.rows(`SELECT r.state,b.committed_usd,host.authorized_slots
        FROM swarm_authority_reservations r,swarm_authority_budgets b,swarm_authority_hosts host`);
      assert.deepEqual([rows[0].state, Number(rows[0].committed_usd), Number(rows[0].authorized_slots)],
        ['runner-claimed-not-started', 0.25, 1]);
    } finally { await h.pool.close(); }
  });

  await t.test('retry drift, future evidence, and disabled broker principal fail closed', async (sub) => {
    await sub.test('exact retry with channel drift', async () => {
      let outcomeEvidence: RunnerOutcomeEvidence | undefined;
      const outcomeAttestor: RunnerOutcomeEvidenceAttestor = async () => outcomeEvidence
        ? { valid: true, evidence: outcomeEvidence, blockers: [] }
        : { valid: false, evidence: null, blockers: ['No server-owned outcome evidence exists.'] };
      const h = await harness(binding(), {}, runnerSessionAttestor, undefined, outcomeAttestor);
      try {
        const { reservation, redeemed } = await authorizeForRunnerClaim(h, 90_000);
        const claim = await h.authority.claimRunnerStart(runnerClaim(h, reservation, redeemed.receipt.redemption_id));
        assert.equal(claim.claimed, true);
        if (!claim.claimed) return;
        outcomeEvidence = runnerOutcomeEvidence(h, reservation, claim.receipt.claim_id, 'never-started');
        const request = runnerOutcome(h, reservation, claim.receipt.claim_id);
        assert.equal((await h.authority.settleRunnerOutcome(request)).settled, true);
        outcomeEvidence = { ...outcomeEvidence, channel_binding_sha256: '8'.repeat(64) };
        const denied = await h.authority.settleRunnerOutcome(request);
        assert.equal(denied.settled, false);
        assert.match(denied.blockers.join(' '), /another execution generation/i);
      } finally { await h.pool.close(); }
    });

    await sub.test('future supervisor evidence is a typed denial', async () => {
      let outcomeEvidence: RunnerOutcomeEvidence | undefined;
      const outcomeAttestor: RunnerOutcomeEvidenceAttestor = async () => outcomeEvidence
        ? { valid: true, evidence: outcomeEvidence, blockers: [] }
        : { valid: false, evidence: null, blockers: ['No server-owned outcome evidence exists.'] };
      const h = await harness(binding(), {}, runnerSessionAttestor, undefined, outcomeAttestor);
      try {
        const { reservation, redeemed } = await authorizeForRunnerClaim(h, 90_000);
        const claim = await h.authority.claimRunnerStart(runnerClaim(h, reservation, redeemed.receipt.redemption_id));
        assert.equal(claim.claimed, true);
        if (!claim.claimed) return;
        const future = new Date(Date.now() + 30_000).toISOString();
        outcomeEvidence = runnerOutcomeEvidence(h, reservation, claim.receipt.claim_id, 'never-started', {
          outcome_at: future,
          observed_at: future,
          access_review_expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
        });
        const denied = await h.authority.settleRunnerOutcome(runnerOutcome(h, reservation, claim.receipt.claim_id));
        assert.equal(denied.settled, false);
        assert.match(denied.blockers.join(' '), /chronology/i);
        assert.equal((await h.pool.rows('SELECT state FROM swarm_authority_reservations'))[0].state,
          'runner-claimed-not-started');
      } finally { await h.pool.close(); }
    });

    await sub.test('disabled broker principal cannot settle', async () => {
      let outcomeEvidence: RunnerOutcomeEvidence | undefined;
      const outcomeAttestor: RunnerOutcomeEvidenceAttestor = async () => outcomeEvidence
        ? { valid: true, evidence: outcomeEvidence, blockers: [] }
        : { valid: false, evidence: null, blockers: ['No server-owned outcome evidence exists.'] };
      const h = await harness(binding(), {}, runnerSessionAttestor, undefined, outcomeAttestor);
      try {
        const { reservation, redeemed } = await authorizeForRunnerClaim(h, 90_000);
        const claim = await h.authority.claimRunnerStart(runnerClaim(h, reservation, redeemed.receipt.redemption_id));
        assert.equal(claim.claimed, true);
        if (!claim.claimed) return;
        outcomeEvidence = runnerOutcomeEvidence(h, reservation, claim.receipt.claim_id, 'never-started');
        await h.store.putBrokerPrincipalEvidence(brokerEvidence({ state: 'disabled' }));
        const denied = await h.authority.settleRunnerOutcome(runnerOutcome(h, reservation, claim.receipt.claim_id));
        assert.equal(denied.settled, false);
        assert.match(denied.blockers.join(' '), /broker principal/i);
        const rows = await h.pool.rows(`SELECT r.state,b.committed_usd,host.authorized_slots
          FROM swarm_authority_reservations r,swarm_authority_budgets b,swarm_authority_hosts host`);
        assert.deepEqual([rows[0].state, Number(rows[0].committed_usd), Number(rows[0].authorized_slots)],
          ['stop-requested', 0.25, 1]);
      } finally { await h.pool.close(); }
    });
  });

  await t.test('next heartbeat cannot recycle the outcome credential', async () => {
    const h = await harness(binding(), {}, runnerSessionAttestor);
    try {
      const { reservation, redeemed } = await authorizeForRunnerClaim(h, 90_000);
      const claim = await h.authority.claimRunnerStart(runnerClaim(h, reservation, redeemed.receipt.redemption_id));
      assert.equal(claim.claimed, true);
      if (!claim.claimed) return;
      const denied = await h.authority.acceptRunnerHeartbeat(runnerHeartbeat(
        h, reservation, claim.receipt.claim_id, { next_heartbeat_token: OUTCOME_TOKEN },
      ));
      assert.equal(denied.accepted, false);
      assert.match(denied.blockers.join(' '), /aliases/i);
    } finally { await h.pool.close(); }
  });

  await t.test('a later reservation cannot recycle any earlier runner credential domain', async (sub) => {
    const cases = [
      ['old outcome as initial heartbeat', 'heartbeat_token', OUTCOME_TOKEN],
      ['old outcome as start observation', 'start_observation_token', OUTCOME_TOKEN],
      ['old start observation as outcome', 'outcome_token', START_OBSERVATION_TOKEN],
      ['old heartbeat as start observation', 'start_observation_token', HEARTBEAT_TOKEN],
    ] as const;
    let caseNumber = 0;
    for (const [name, field, recycledToken] of cases) {
      caseNumber += 1;
      await sub.test(name, async () => {
        const h = await harness(binding(), {}, runnerSessionAttestor);
        try {
          const first = await authorizeForRunnerClaim(h, 90_000);
          const firstClaim = await h.authority.claimRunnerStart(
            runnerClaim(h, first.reservation, first.redeemed.receipt.redemption_id),
          );
          assert.equal(firstClaim.claimed, true, firstClaim.blockers.join(' '));

          const suffix = String(900 + caseNumber);
          const operation = binding({
            operation_id: `operation-credential-${suffix}`,
            effect_id: `effect-credential-${suffix}`,
            call_id: `call-credential-${suffix}`,
          });
          const second = await authorizeRelatedForRunnerClaim(h, operation, suffix);
          const claimInput = {
            claim_request_id: `00000000-0000-4000-8002-${suffix.padStart(12, '0')}`,
            reservation_id: second.reservation.reservation_id,
            redemption_id: second.redeemed.receipt.redemption_id,
            operation_id: operation.operation_id,
            effect_id: operation.effect_id,
            binding_digest_sha256: second.reservation.binding_digest_sha256,
            control_token: second.controlToken,
            heartbeat_token: 'I'.repeat(43),
            start_observation_token: 'T'.repeat(43),
            outcome_token: 'Y'.repeat(43),
            usage_reconciliation_token: 'Z'.repeat(43),
            provider_usage_correlation_id: `provider-correlation-${suffix}`,
          };
          claimInput[field] = recycledToken;
          const denied = await h.authority.claimRunnerStart(claimInput);
          assert.equal(denied.claimed, false);
          assert.match(denied.blockers.join(' '), /aliases an issued lifecycle credential/i);
          const row = (await h.pool.rows(`SELECT state FROM swarm_authority_reservations
            WHERE reservation_id='${second.reservation.reservation_id}'`))[0];
          assert.equal(row.state, 'start-authorized-not-observed');
        } finally { await h.pool.close(); }
      });
    }
  });

  await t.test('historical terminal rows survive broker role-contract rotation', async () => {
    let startEvidence: RunnerStartEvidence | undefined;
    let outcomeEvidence: RunnerOutcomeEvidence | undefined;
    const startAttestor: RunnerStartEvidenceAttestor = async () => startEvidence
      ? { valid: true, evidence: startEvidence, blockers: [] }
      : { valid: false, evidence: null, blockers: ['No server-owned process evidence exists.'] };
    const outcomeAttestor: RunnerOutcomeEvidenceAttestor = async () => outcomeEvidence
      ? { valid: true, evidence: outcomeEvidence, blockers: [] }
      : { valid: false, evidence: null, blockers: ['No server-owned outcome evidence exists.'] };
    const h = await harness(binding(), {}, runnerSessionAttestor, startAttestor, outcomeAttestor);
    try {
      const { reservation, redeemed } = await authorizeForRunnerClaim(h, 90_000);
      const claim = await h.authority.claimRunnerStart(runnerClaim(h, reservation, redeemed.receipt.redemption_id));
      assert.equal(claim.claimed, true);
      if (!claim.claimed) return;
      startEvidence = runnerStartEvidence(h, reservation, claim.receipt.claim_id);
      const started = await h.authority.observeRunnerStart(runnerStartObservation(h, reservation, claim.receipt.claim_id));
      assert.equal(started.observed, true);
      if (!started.observed) return;
      const terminalAt = new Date(Math.max(Date.now(), Date.parse(started.receipt.process_started_at))).toISOString();
      outcomeEvidence = runnerOutcomeEvidence(h, reservation, claim.receipt.claim_id, 'process-terminal', {
        start_observation_id: started.receipt.observation_id,
        process_started_at: started.receipt.process_started_at,
        outcome_at: terminalAt,
        observed_at: terminalAt,
      });
      assert.equal((await h.authority.settleRunnerOutcome(runnerOutcome(h, reservation, claim.receipt.claim_id))).settled, true);
      await h.pool.execute(`UPDATE swarm_authority_reservations
        SET broker_role_contract_sha256='${'f'.repeat(64)}' WHERE state='runner-terminal-observed'`);
      await h.store.initialize();
      const rows = await h.pool.rows('SELECT state,broker_role_contract_sha256 FROM swarm_authority_reservations');
      assert.equal(rows[0].state, 'runner-terminal-observed');
      assert.equal(rows[0].broker_role_contract_sha256, 'f'.repeat(64));
    } finally { await h.pool.close(); }
  });
});

test('records authenticated provider usage evidence without releasing committed budget', async (t) => {
  await t.test('missing dedicated usage authority denies evidence and preserves ledgers', async () => {
    let outcomeEvidence: RunnerOutcomeEvidence | undefined;
    const outcomeAttestor: RunnerOutcomeEvidenceAttestor = async () => outcomeEvidence
      ? { valid: true, evidence: outcomeEvidence, blockers: [] }
      : { valid: false, evidence: null, blockers: ['No server-owned outcome evidence exists.'] };
    const h = await harness(binding(), {}, runnerSessionAttestor, undefined, outcomeAttestor);
    try {
      const { reservation, redeemed } = await authorizeForRunnerClaim(h, 90_000);
      const claim = await h.authority.claimRunnerStart(runnerClaim(h, reservation, redeemed.receipt.redemption_id));
      assert.equal(claim.claimed, true, claim.blockers.join(' '));
      if (!claim.claimed) return;
      outcomeEvidence = runnerOutcomeEvidence(h, reservation, claim.receipt.claim_id, 'never-started');
      const settled = await h.authority.settleRunnerOutcome(runnerOutcome(h, reservation, claim.receipt.claim_id));
      assert.equal(settled.settled, true, settled.blockers.join(' '));
      if (!settled.settled) return;
      const denied = await h.authority.recordRunnerUsageEvidence(runnerUsageRequest(
        h, reservation, claim.receipt.claim_id, settled.receipt.outcome_id,
      ));
      assert.equal(denied.recorded, false);
      assert.match(denied.blockers.join(' '), /database authority is not configured/i);
      const rows = await h.pool.rows(`SELECT b.committed_usd,host.authorized_slots
        FROM swarm_authority_budgets b,swarm_authority_hosts host`);
      assert.deepEqual([Number(rows[0].committed_usd), Number(rows[0].authorized_slots)], [0.25, 1]);
      assert.equal((await h.pool.rows('SELECT * FROM swarm_authority_usage_evidence')).length, 0);
      const audit = await h.pool.rows(
        "SELECT detail FROM swarm_authority_audit WHERE event='runner-usage-evidence-denied' ORDER BY seq DESC LIMIT 1",
      );
      assert.equal(audit.length, 1);
      assert.deepEqual(audit[0]?.detail, {
        reservation_id: reservation.reservation_id,
        claim_id: claim.receipt.claim_id,
        outcome_id: settled.receipt.outcome_id,
        usage_request_id: '00000000-0000-4000-8000-000000000a01',
        usage_sequence: 1,
        blockers: ['Dedicated usage-evidence database authority is not configured.'],
        released_cost_usd: '0.000000',
        verifier_handoff_completed: false,
      });
    } finally { await h.pool.close(); }
  });

  await t.test('post-handoff verifier refusal is durably audited without consuming the token', async () => {
    let outcomeEvidence: RunnerOutcomeEvidence | undefined;
    let usageEvidence: RunnerUsageEvidence | undefined;
    const outcomeAttestor: RunnerOutcomeEvidenceAttestor = async () => outcomeEvidence
      ? { valid: true, evidence: outcomeEvidence, blockers: [] }
      : { valid: false, evidence: null, blockers: ['No server-owned outcome evidence exists.'] };
    const usageAttestor: RunnerUsageEvidenceAttestor = async () => usageEvidence
      ? { valid: true, evidence: usageEvidence, blockers: [] }
      : { valid: false, evidence: null, blockers: ['No provider usage evidence exists.'] };
    const refusedVerifier: UsageEvidenceDatabaseSessionAttestor = async () => ({
      valid: false, session: null, blockers: ['Verifier role drifted.'],
    });
    const h = await harness(
      binding(), {}, runnerSessionAttestor, undefined, outcomeAttestor, usageAttestor, refusedVerifier,
    );
    try {
      const { reservation, redeemed } = await authorizeForRunnerClaim(h, 90_000);
      const claim = await h.authority.claimRunnerStart(runnerClaim(h, reservation, redeemed.receipt.redemption_id));
      assert.equal(claim.claimed, true, claim.blockers.join(' '));
      if (!claim.claimed) return;
      outcomeEvidence = runnerOutcomeEvidence(h, reservation, claim.receipt.claim_id, 'never-started');
      const settled = await h.authority.settleRunnerOutcome(runnerOutcome(h, reservation, claim.receipt.claim_id));
      assert.equal(settled.settled, true, settled.blockers.join(' '));
      if (!settled.settled) return;
      usageEvidence = runnerUsageEvidence(
        h, reservation, claim.receipt.claim_id, settled.receipt.outcome_id,
        claim.receipt.accepted_at, settled.receipt.outcome_at,
      );
      const denied = await h.authority.recordRunnerUsageEvidence(runnerUsageRequest(
        h, reservation, claim.receipt.claim_id, settled.receipt.outcome_id,
      ));
      assert.equal(denied.recorded, false);
      assert.match(denied.blockers.join(' '), /verifier role drifted/i);
      const audit = await h.pool.rows(
        "SELECT detail FROM swarm_authority_audit WHERE event='runner-usage-evidence-denied' ORDER BY seq DESC LIMIT 1",
      );
      assert.equal(audit.length, 1);
      assert.deepEqual(audit[0]?.detail, {
        reservation_id: reservation.reservation_id,
        claim_id: claim.receipt.claim_id,
        outcome_id: settled.receipt.outcome_id,
        usage_request_id: '00000000-0000-4000-8000-000000000a01',
        usage_sequence: 1,
        blockers: ['Usage-evidence database session is not authorized: Verifier role drifted.'],
        released_cost_usd: '0.000000',
        verifier_handoff_completed: true,
      });
      const state = await h.pool.rows(`SELECT usage_reconciliation_token_sha256,
        (SELECT COUNT(*) FROM swarm_authority_usage_evidence) AS evidence_count
        FROM swarm_authority_reservations`);
      assert.equal(state[0]?.usage_reconciliation_token_sha256,
        createHash('sha256').update(USAGE_TOKEN, 'utf8').digest('hex'));
      assert.equal(Number(state[0]?.evidence_count), 0);
    } finally { await h.pool.close(); }
  });

  await t.test('post-handoff query failure releases a one-client pool before durable audit', async () => {
    let outcomeEvidence: RunnerOutcomeEvidence | undefined;
    let usageEvidence: RunnerUsageEvidence | undefined;
    const outcomeAttestor: RunnerOutcomeEvidenceAttestor = async () => outcomeEvidence
      ? { valid: true, evidence: outcomeEvidence, blockers: [] }
      : { valid: false, evidence: null, blockers: ['No server-owned outcome evidence exists.'] };
    const usageAttestor: RunnerUsageEvidenceAttestor = async () => usageEvidence
      ? { valid: true, evidence: usageEvidence, blockers: [] }
      : { valid: false, evidence: null, blockers: ['No provider usage evidence exists.'] };
    const throwingUsagePool = (pool: PGlitePool): AuthoritySqlPool => ({
      connect: async () => {
        const client = await pool.connect();
        return {
          query: async (sql, values) => {
            if (sql.includes('starlight_append_runner_usage_evidence')) {
              throw new Error('injected verifier query failure');
            }
            return client.query(sql, values);
          },
          release: () => client.release?.(),
        };
      },
    });
    const h = await harness(
      binding(), {}, runnerSessionAttestor, undefined, outcomeAttestor, usageAttestor,
      testUsageEvidenceSessionAttestor, throwingUsagePool,
    );
    try {
      const { reservation, redeemed } = await authorizeForRunnerClaim(h, 90_000);
      const claim = await h.authority.claimRunnerStart(runnerClaim(h, reservation, redeemed.receipt.redemption_id));
      assert.equal(claim.claimed, true, claim.blockers.join(' '));
      if (!claim.claimed) return;
      outcomeEvidence = runnerOutcomeEvidence(h, reservation, claim.receipt.claim_id, 'never-started');
      const settled = await h.authority.settleRunnerOutcome(runnerOutcome(h, reservation, claim.receipt.claim_id));
      assert.equal(settled.settled, true, settled.blockers.join(' '));
      if (!settled.settled) return;
      usageEvidence = runnerUsageEvidence(
        h, reservation, claim.receipt.claim_id, settled.receipt.outcome_id,
        claim.receipt.accepted_at, settled.receipt.outcome_at,
      );
      await assert.rejects(
        h.authority.recordRunnerUsageEvidence(runnerUsageRequest(
          h, reservation, claim.receipt.claim_id, settled.receipt.outcome_id,
        )),
        /injected verifier query failure/i,
      );
      const audit = await h.pool.rows(
        "SELECT detail FROM swarm_authority_audit WHERE event='runner-usage-evidence-denied' ORDER BY seq DESC LIMIT 1",
      );
      assert.equal(audit.length, 1);
      assert.match(JSON.stringify(audit[0]?.detail), /injected verifier query failure/i);
      const state = await h.pool.rows(`SELECT usage_reconciliation_token_sha256,
        (SELECT COUNT(*) FROM swarm_authority_usage_evidence) AS evidence_count
        FROM swarm_authority_reservations`);
      assert.equal(state[0]?.usage_reconciliation_token_sha256,
        createHash('sha256').update(USAGE_TOKEN, 'utf8').digest('hex'));
      assert.equal(Number(state[0]?.evidence_count), 0);
    } finally { await h.pool.close(); }
  });

  await t.test('provisional then final evidence rotates credentials idempotently and releases zero', async () => {
    let outcomeEvidence: RunnerOutcomeEvidence | undefined;
    let usageEvidence: RunnerUsageEvidence | undefined;
    const outcomeAttestor: RunnerOutcomeEvidenceAttestor = async () => outcomeEvidence
      ? { valid: true, evidence: outcomeEvidence, blockers: [] }
      : { valid: false, evidence: null, blockers: ['No server-owned outcome evidence exists.'] };
    const usageAttestor: RunnerUsageEvidenceAttestor = async () => usageEvidence
      ? { valid: true, evidence: usageEvidence, blockers: [] }
      : { valid: false, evidence: null, blockers: ['No provider usage evidence exists.'] };
    const h = await harness(binding(), {}, runnerSessionAttestor, undefined, outcomeAttestor, usageAttestor);
    try {
      const { reservation, redeemed } = await authorizeForRunnerClaim(h, 90_000);
      const claim = await h.authority.claimRunnerStart(runnerClaim(h, reservation, redeemed.receipt.redemption_id));
      assert.equal(claim.claimed, true, claim.blockers.join(' '));
      if (!claim.claimed) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
      outcomeEvidence = runnerOutcomeEvidence(h, reservation, claim.receipt.claim_id, 'never-started');
      const settled = await h.authority.settleRunnerOutcome(runnerOutcome(h, reservation, claim.receipt.claim_id));
      assert.equal(settled.settled, true, settled.blockers.join(' '));
      if (!settled.settled) return;

      usageEvidence = runnerUsageEvidence(
        h, reservation, claim.receipt.claim_id, settled.receipt.outcome_id,
        claim.receipt.accepted_at, settled.receipt.outcome_at,
      );
      const firstInput = runnerUsageRequest(h, reservation, claim.receipt.claim_id, settled.receipt.outcome_id);
      const first = await h.authority.recordRunnerUsageEvidence(firstInput);
      assert.equal(first.recorded, true, first.blockers.join(' '));
      if (!first.recorded) return;
      assert.deepEqual([
        first.receipt.statement_status, first.receipt.cumulative_cost_usd,
        first.receipt.actual_usage_reconciled, first.receipt.budget_commitment_released,
        first.receipt.released_cost_usd,
      ], ['provisional', '0.000000', false, false, '0.000000']);
      const retry = await h.authority.recordRunnerUsageEvidence(firstInput);
      assert.equal(retry.recorded, true, retry.blockers.join(' '));
      if (retry.recorded) assert.deepEqual(retry.receipt, first.receipt);

      const finalEvidence = runnerUsageEvidence(
        h, reservation, claim.receipt.claim_id, settled.receipt.outcome_id,
        claim.receipt.accepted_at, settled.receipt.outcome_at,
        {
          provider_event_id: '00000000-0000-4000-8000-000000000902',
          evidence_ref: 'provider-usage-evidence-002',
          evidence_sha256: 'f'.repeat(64),
          statement_status: 'final',
          cumulative_cost_usd: '0.000000',
        },
      );
      const finalInput = runnerUsageRequest(
        h, reservation, claim.receipt.claim_id, settled.receipt.outcome_id,
        {
          usage_request_id: '00000000-0000-4000-8000-000000000a02',
          usage_sequence: 2,
          usage_reconciliation_token: NEXT_USAGE_TOKEN,
          next_usage_reconciliation_token: SECOND_NEXT_USAGE_TOKEN,
        },
      );
      const driftCases: Array<[string, Partial<RunnerUsageEvidence>]> = [
        ['provider', { provider_id: 'provider-test-002' }],
        ['account', { provider_account_ref: 'provider-account-test-002' }],
        ['meter', { meter_id: 'provider-tokens' }],
        ['issuer', { issuer: 'provider-billing-test-002' }],
        ['key', { key_id: 'provider-billing-key-002' }],
        ['start', { usage_started_at: settled.receipt.outcome_at }],
        ['end', { usage_ended_at: claim.receipt.accepted_at,
          statement_finalized_at: finalEvidence.observed_at }],
      ];
      for (const [name, drift] of driftCases) {
        usageEvidence = { ...finalEvidence, ...drift };
        const denied = await h.authority.recordRunnerUsageEvidence(finalInput);
        assert.equal(denied.recorded, false, name);
        assert.match(denied.blockers.join(' '), /stream identity, key, interval, cost, or token chain drifted/i, name);
      }
      usageEvidence = finalEvidence;
      const final = await h.authority.recordRunnerUsageEvidence(finalInput);
      assert.equal(final.recorded, true, final.blockers.join(' '));
      if (final.recorded) assert.equal(final.receipt.statement_status, 'final');
      const rows = await h.pool.rows(`SELECT b.committed_usd,host.authorized_slots
        FROM swarm_authority_budgets b,swarm_authority_hosts host`);
      assert.deepEqual([Number(rows[0].committed_usd), Number(rows[0].authorized_slots)], [0.25, 1]);
      assert.equal((await h.pool.rows('SELECT * FROM swarm_authority_usage_evidence')).length, 2);
      assert.equal((await h.pool.rows("SELECT event FROM swarm_authority_audit WHERE event='runner-usage-evidence-observed'")).length, 2);
    } finally { await h.pool.close(); }
  });

  await t.test('over-budget evidence is retained as a breach while every commitment remains locked', async () => {
    let outcomeEvidence: RunnerOutcomeEvidence | undefined;
    let usageEvidence: RunnerUsageEvidence | undefined;
    const outcomeAttestor: RunnerOutcomeEvidenceAttestor = async () => outcomeEvidence
      ? { valid: true, evidence: outcomeEvidence, blockers: [] }
      : { valid: false, evidence: null, blockers: ['No server-owned outcome evidence exists.'] };
    const usageAttestor: RunnerUsageEvidenceAttestor = async () => usageEvidence
      ? { valid: true, evidence: usageEvidence, blockers: [] }
      : { valid: false, evidence: null, blockers: ['No provider usage evidence exists.'] };
    const h = await harness(binding(), {}, runnerSessionAttestor, undefined, outcomeAttestor, usageAttestor);
    try {
      const { reservation, redeemed } = await authorizeForRunnerClaim(h, 90_000);
      const claim = await h.authority.claimRunnerStart(runnerClaim(h, reservation, redeemed.receipt.redemption_id));
      assert.equal(claim.claimed, true, claim.blockers.join(' '));
      if (!claim.claimed) return;
      outcomeEvidence = runnerOutcomeEvidence(h, reservation, claim.receipt.claim_id, 'never-started');
      const settled = await h.authority.settleRunnerOutcome(runnerOutcome(h, reservation, claim.receipt.claim_id));
      assert.equal(settled.settled, true, settled.blockers.join(' '));
      if (!settled.settled) return;
      usageEvidence = runnerUsageEvidence(
        h, reservation, claim.receipt.claim_id, settled.receipt.outcome_id,
        claim.receipt.accepted_at, settled.receipt.outcome_at,
        { statement_status: 'final', cumulative_cost_usd: '0.300000' },
      );
      const recorded = await h.authority.recordRunnerUsageEvidence(runnerUsageRequest(
        h, reservation, claim.receipt.claim_id, settled.receipt.outcome_id,
      ));
      assert.equal(recorded.recorded, true, recorded.blockers.join(' '));
      if (!recorded.recorded) return;
      assert.equal(recorded.receipt.budget_breach_observed, true);
      assert.equal(recorded.receipt.budget_commitment_released, false);
      assert.equal(recorded.receipt.released_cost_usd, '0.000000');
      const ledgers = await h.pool.rows(`SELECT b.committed_usd,w.committed_usd AS window_committed
        FROM swarm_authority_budgets b CROSS JOIN swarm_authority_budget_windows w ORDER BY w.window_id`);
      assert.ok(ledgers.every((row) => Number(row.committed_usd) === 0.25
        && Number(row.window_committed) === 0.25));
      assert.equal((await h.pool.rows("SELECT event FROM swarm_authority_audit WHERE event='runner-usage-budget-breach'")).length, 1);
    } finally { await h.pool.close(); }
  });

  await t.test('migration rejects stream, token-chain, and binding corruption', async () => {
    let outcomeEvidence: RunnerOutcomeEvidence | undefined;
    let usageEvidence: RunnerUsageEvidence | undefined;
    const outcomeAttestor: RunnerOutcomeEvidenceAttestor = async () => outcomeEvidence
      ? { valid: true, evidence: outcomeEvidence, blockers: [] }
      : { valid: false, evidence: null, blockers: ['No server-owned outcome evidence exists.'] };
    const usageAttestor: RunnerUsageEvidenceAttestor = async () => usageEvidence
      ? { valid: true, evidence: usageEvidence, blockers: [] }
      : { valid: false, evidence: null, blockers: ['No provider usage evidence exists.'] };
    const h = await harness(binding(), {}, runnerSessionAttestor, undefined, outcomeAttestor, usageAttestor);
    try {
      const { reservation, redeemed } = await authorizeForRunnerClaim(h, 90_000);
      const claim = await h.authority.claimRunnerStart(runnerClaim(h, reservation, redeemed.receipt.redemption_id));
      assert.equal(claim.claimed, true, claim.blockers.join(' '));
      if (!claim.claimed) return;
      outcomeEvidence = runnerOutcomeEvidence(h, reservation, claim.receipt.claim_id, 'never-started');
      const settled = await h.authority.settleRunnerOutcome(runnerOutcome(h, reservation, claim.receipt.claim_id));
      assert.equal(settled.settled, true, settled.blockers.join(' '));
      if (!settled.settled) return;
      usageEvidence = runnerUsageEvidence(
        h, reservation, claim.receipt.claim_id, settled.receipt.outcome_id,
        claim.receipt.accepted_at, settled.receipt.outcome_at,
      );
      assert.equal((await h.authority.recordRunnerUsageEvidence(runnerUsageRequest(
        h, reservation, claim.receipt.claim_id, settled.receipt.outcome_id,
      ))).recorded, true);
      usageEvidence = runnerUsageEvidence(
        h, reservation, claim.receipt.claim_id, settled.receipt.outcome_id,
        claim.receipt.accepted_at, settled.receipt.outcome_at,
        {
          provider_event_id: '00000000-0000-4000-8000-000000000903',
          evidence_ref: 'provider-usage-evidence-003', evidence_sha256: 'a'.repeat(64),
          statement_status: 'final', cumulative_cost_usd: '0.000000',
        },
      );
      assert.equal((await h.authority.recordRunnerUsageEvidence(runnerUsageRequest(
        h, reservation, claim.receipt.claim_id, settled.receipt.outcome_id,
        {
          usage_request_id: '00000000-0000-4000-8000-000000000a03', usage_sequence: 2,
          usage_reconciliation_token: NEXT_USAGE_TOKEN,
          next_usage_reconciliation_token: SECOND_NEXT_USAGE_TOKEN,
        },
      ))).recorded, true);
      const original = (await h.pool.rows(`SELECT provider_id,next_token_sha256,authorized_cost_usd
        FROM swarm_authority_usage_evidence WHERE usage_sequence=2`))[0];

      await h.pool.execute("UPDATE swarm_authority_usage_evidence SET provider_id='drifted-provider' WHERE usage_sequence=2");
      await assert.rejects(h.store.initialize(), /stream drifted or regressed/i);
      await h.pool.execute(`UPDATE swarm_authority_usage_evidence SET provider_id='${String(original.provider_id)}'
        WHERE usage_sequence=2`);
      await h.store.initialize();

      await h.pool.execute(`UPDATE swarm_authority_usage_evidence SET next_token_sha256='${'0'.repeat(64)}'
        WHERE usage_sequence=2`);
      await assert.rejects(h.store.initialize(), /token chain is missing or inconsistent/i);
      await h.pool.execute(`UPDATE swarm_authority_usage_evidence
        SET next_token_sha256='${String(original.next_token_sha256)}' WHERE usage_sequence=2`);
      await h.store.initialize();

      await h.pool.execute('UPDATE swarm_authority_usage_evidence SET authorized_cost_usd=0.200000 WHERE usage_sequence=2');
      await assert.rejects(h.store.initialize(), /binding or breach attribution is inconsistent/i);
      await h.pool.execute(`UPDATE swarm_authority_usage_evidence
        SET authorized_cost_usd=${Number(original.authorized_cost_usd)} WHERE usage_sequence=2`);
      await h.store.initialize();
    } finally { await h.pool.close(); }
  });
});

test('start observation defaults closed and quarantines replay evidence drift', async (t) => {
  await t.test('no server-owned evidence attestor', async () => {
    const h = await harness(binding(), {}, runnerSessionAttestor);
    try {
      const { reservation, redeemed } = await authorizeForRunnerClaim(h, 90_000);
      const claim = await h.authority.claimRunnerStart(runnerClaim(h, reservation, redeemed.receipt.redemption_id));
      assert.equal(claim.claimed, true);
      if (!claim.claimed) return;
      const denied = await h.authority.observeRunnerStart(
        runnerStartObservation(h, reservation, claim.receipt.claim_id),
      );
      assert.equal(denied.observed, false);
      assert.match(denied.blockers.join(' '), /attestor is not configured/i);
      const rows = await h.pool.rows('SELECT state FROM swarm_authority_reservations');
      assert.equal(rows[0].state, 'runner-claimed-not-started');
    } finally { await h.pool.close(); }
  });

  await t.test('changed server evidence on exact retry', async () => {
    let evidence: RunnerStartEvidence | undefined;
    const startAttestor: RunnerStartEvidenceAttestor = async () => evidence
      ? { valid: true, evidence, blockers: [] }
      : { valid: false, evidence: null, blockers: ['No server-owned process evidence exists.'] };
    const h = await harness(binding(), {}, runnerSessionAttestor, startAttestor);
    try {
      const { reservation, redeemed } = await authorizeForRunnerClaim(h, 90_000);
      const claim = await h.authority.claimRunnerStart(runnerClaim(h, reservation, redeemed.receipt.redemption_id));
      assert.equal(claim.claimed, true);
      if (!claim.claimed) return;
      evidence = runnerStartEvidence(h, reservation, claim.receipt.claim_id);
      const input = runnerStartObservation(h, reservation, claim.receipt.claim_id);
      assert.equal((await h.authority.observeRunnerStart(input)).observed, true);
      evidence = { ...evidence, evidence_sha256: 'd'.repeat(64) };
      const denied = await h.authority.observeRunnerStart(input);
      assert.equal(denied.observed, false);
      assert.match(denied.blockers.join(' '), /replay evidence drifted/i);
      const rows = await h.pool.rows(`SELECT r.state,b.committed_usd,host.authorized_slots
        FROM swarm_authority_reservations r,swarm_authority_budgets b,swarm_authority_hosts host`);
      assert.equal(rows[0].state, 'stop-requested');
      assert.equal(Number(rows[0].committed_usd), 0.25);
      assert.equal(Number(rows[0].authorized_slots), 1);
    } finally { await h.pool.close(); }
  });
});

test('heartbeats and expiry preserve observed-start semantics without claiming workload effects', async () => {
  let evidence: RunnerStartEvidence | undefined;
  const startAttestor: RunnerStartEvidenceAttestor = async () => evidence
    ? { valid: true, evidence, blockers: [] }
    : { valid: false, evidence: null, blockers: ['No server-owned process evidence exists.'] };
  const h = await harness(binding(), {}, runnerSessionAttestor, startAttestor);
  try {
    const { reservation, redeemed } = await authorizeForRunnerClaim(h, 90_000);
    const claim = await h.authority.claimRunnerStart(runnerClaim(h, reservation, redeemed.receipt.redemption_id));
    assert.equal(claim.claimed, true);
    if (!claim.claimed) return;
    evidence = runnerStartEvidence(h, reservation, claim.receipt.claim_id);
    const startInput = runnerStartObservation(h, reservation, claim.receipt.claim_id);
    const started = await h.authority.observeRunnerStart(startInput);
    assert.equal(started.observed, true);
    if (!started.observed) return;

    const heartbeat = await h.authority.acceptRunnerHeartbeat(
      runnerHeartbeat(h, reservation, claim.receipt.claim_id),
    );
    assert.equal(heartbeat.accepted, true, heartbeat.blockers.join(' '));
    if (heartbeat.accepted) {
      assert.equal(heartbeat.receipt.state, 'runner-start-observed');
      assert.equal(heartbeat.receipt.execution_observed, true);
      assert.equal(heartbeat.receipt.workload_effect_observed, false);
    }
    const startRetry = await h.authority.observeRunnerStart(startInput);
    assert.equal(startRetry.observed, true, startRetry.blockers.join(' '));
    if (startRetry.observed) assert.deepEqual(startRetry.receipt, started.receipt);
    assert.equal((await h.pool.rows(
      "SELECT event FROM swarm_authority_audit WHERE event='runner-start-observed'",
    )).length, 1);
    await h.pool.execute(`UPDATE swarm_authority_reservations SET
      runner_claim_accepted_at=clock_timestamp()-INTERVAL '70 seconds',
      runner_evidence_observed_at=clock_timestamp()-INTERVAL '61 seconds',
      runner_heartbeat_accepted_at=clock_timestamp()-INTERVAL '61 seconds',
      runner_start_observation_accepted_at=clock_timestamp()-INTERVAL '60 seconds',
      runner_start_evidence_observed_at=clock_timestamp()-INTERVAL '60 seconds',
      runner_process_started_at=clock_timestamp()-INTERVAL '60 seconds',
      runner_claim_expires_at=clock_timestamp()-INTERVAL '1 second'`);
    const expired = await h.authority.reconcileRunnerHeartbeatExpiry({
      reservation_id: reservation.reservation_id,
      claim_id: claim.receipt.claim_id,
      operation_id: h.operation.operation_id,
      binding_digest_sha256: reservation.binding_digest_sha256,
    });
    assert.equal(expired.reconciled, true);
    if (expired.reconciled) {
      assert.equal(expired.state, 'stop-requested');
      assert.equal(expired.expired, true);
    }
    const rows = await h.pool.rows(`SELECT r.state,b.committed_usd,host.authorized_slots
      FROM swarm_authority_reservations r,swarm_authority_budgets b,swarm_authority_hosts host`);
    assert.equal(rows[0].state, 'stop-requested');
    assert.equal(Number(rows[0].committed_usd), 0.25);
    assert.equal(Number(rows[0].authorized_slots), 1);
  } finally { await h.pool.close(); }
});

test('an exact latest-heartbeat retry remains idempotent after start observation', async () => {
  let evidence: RunnerStartEvidence | undefined;
  const startAttestor: RunnerStartEvidenceAttestor = async () => evidence
    ? { valid: true, evidence, blockers: [] }
    : { valid: false, evidence: null, blockers: ['No server-owned process evidence exists.'] };
  const h = await harness(binding(), {}, runnerSessionAttestor, startAttestor);
  try {
    const { reservation, redeemed } = await authorizeForRunnerClaim(h, 90_000);
    const claim = await h.authority.claimRunnerStart(runnerClaim(h, reservation, redeemed.receipt.redemption_id));
    assert.equal(claim.claimed, true);
    if (!claim.claimed) return;
    const heartbeatInput = runnerHeartbeat(h, reservation, claim.receipt.claim_id);
    const heartbeat = await h.authority.acceptRunnerHeartbeat(heartbeatInput);
    assert.equal(heartbeat.accepted, true, heartbeat.blockers.join(' '));
    if (!heartbeat.accepted) return;
    evidence = runnerStartEvidence(h, reservation, claim.receipt.claim_id);
    assert.equal((await h.authority.observeRunnerStart(
      runnerStartObservation(h, reservation, claim.receipt.claim_id),
    )).observed, true);

    const retry = await h.authority.acceptRunnerHeartbeat(heartbeatInput);
    assert.equal(retry.accepted, true, retry.blockers.join(' '));
    if (retry.accepted) {
      assert.equal(retry.receipt.state, 'runner-start-observed');
      assert.equal(retry.receipt.execution_observed, true);
      assert.equal(retry.receipt.workload_effect_observed, false);
    }
    const rows = await h.pool.rows(`SELECT r.state,b.committed_usd,host.authorized_slots
      FROM swarm_authority_reservations r,swarm_authority_budgets b,swarm_authority_hosts host`);
    assert.equal(rows[0].state, 'runner-start-observed');
    assert.equal(Number(rows[0].committed_usd), 0.25);
    assert.equal(Number(rows[0].authorized_slots), 1);
    assert.equal((await h.pool.rows(
      "SELECT event FROM swarm_authority_audit WHERE event='runner-heartbeat-accepted'",
    )).length, 1);
  } finally { await h.pool.close(); }
});

test('heartbeat expiry reconciliation never releases unknown committed execution', async () => {
  const h = await harness(binding(), {}, runnerSessionAttestor);
  try {
    const { reservation, redeemed } = await authorizeForRunnerClaim(h, 90_000);
    const claim = await h.authority.claimRunnerStart(runnerClaim(h, reservation, redeemed.receipt.redemption_id));
    assert.equal(claim.claimed, true);
    if (!claim.claimed) return;
    const input = {
      reservation_id: reservation.reservation_id,
      claim_id: claim.receipt.claim_id,
      operation_id: h.operation.operation_id,
      binding_digest_sha256: reservation.binding_digest_sha256,
    };
    const live = await h.authority.reconcileRunnerHeartbeatExpiry(input);
    assert.equal(live.reconciled, true);
    if (live.reconciled) {
      assert.equal(live.state, 'runner-claimed-not-started');
      assert.equal(live.expired, false);
    }
    await h.pool.execute(`UPDATE swarm_authority_reservations SET
      runner_claim_accepted_at=clock_timestamp()-INTERVAL '70 seconds',
      runner_evidence_observed_at=clock_timestamp()-INTERVAL '61 seconds',
      runner_access_review_expires_at=clock_timestamp()+INTERVAL '1 minute',
      runner_claim_expires_at=clock_timestamp()-INTERVAL '1 second'`);
    const expired = await h.authority.reconcileRunnerHeartbeatExpiry(input);
    assert.equal(expired.reconciled, true);
    if (expired.reconciled) {
      assert.equal(expired.state, 'stop-requested');
      assert.equal(expired.expired, true);
    }
    const rows = await h.pool.rows(`SELECT r.state,b.reserved_usd,b.committed_usd,
      host.reserved_slots,host.authorized_slots
      FROM swarm_authority_reservations r,swarm_authority_budgets b,swarm_authority_hosts host`);
    assert.equal(rows[0].state, 'stop-requested');
    assert.deepEqual([
      Number(rows[0].reserved_usd), Number(rows[0].committed_usd),
      Number(rows[0].reserved_slots), Number(rows[0].authorized_slots),
    ], [0, 0.25, 0, 1]);
  } finally { await h.pool.close(); }
});

test('runner claim defaults closed when no authenticated transport is configured', async () => {
  const h = await harness();
  try {
    const reservation = await reserve(h);
    const consumed = await h.authority.consume(consumption(h, reservation));
    assert.equal(consumed.consumed, true);
    if (!consumed.consumed) return;
    const leased = await h.authority.leaseStart(startLease(h, reservation, consumed.receipt.consumption_id));
    assert.equal(leased.leased, true);
    if (!leased.leased) return;
    const redeemed = await h.authority.redeemStartAuthorization(
      startRedemption(h, reservation, leased.receipt.lease_id),
    );
    assert.equal(redeemed.redeemed, true);
    if (!redeemed.redeemed) return;
    const denied = await h.authority.claimRunnerStart(
      runnerClaim(h, reservation, redeemed.receipt.redemption_id),
    );
    assert.equal(denied.claimed, false);
    assert.match(denied.blockers.join(' '), /attestor is not configured/i);
    const rows = await h.pool.rows('SELECT state FROM swarm_authority_reservations');
    assert.equal(rows[0].state, 'start-authorized-not-observed');
  } finally { await h.pool.close(); }
});

test('runner claim quarantines expired, revoked, or corrupted committed authority', async (t) => {
  await t.test('malformed stored revocation binding', async () => {
    const h = await harness(binding(), {}, runnerSessionAttestor);
    try {
      const { reservation, redeemed } = await authorizeForRunnerClaim(h);
      await h.pool.execute("UPDATE swarm_authority_reservations SET revocation_refs='{}'::jsonb");
      const denied = await h.authority.claimRunnerStart(runnerClaim(h, reservation, redeemed.receipt.redemption_id));
      assert.equal(denied.claimed, false);
      assert.match(denied.blockers.join(' '), /revocation binding is invalid/i);
      const state = await h.pool.rows('SELECT state FROM swarm_authority_reservations');
      assert.equal(state[0].state, 'stop-requested');
    } finally { await h.pool.close(); }
  });

  for (const expiry of ['reservation', 'lease'] as const) {
    await t.test(`expired ${expiry}`, async () => {
      const h = await harness(binding(), {}, runnerSessionAttestor);
      try {
        const { reservation, redeemed } = await authorizeForRunnerClaim(h);
        if (expiry === 'reservation') {
          await h.pool.execute("UPDATE swarm_authority_reservations SET reservation_expires_at=clock_timestamp()-INTERVAL '1 second'");
        } else {
          await h.pool.execute(`UPDATE swarm_authority_reservations
            SET lease_issued_at=clock_timestamp()-(lease_duration_ms*INTERVAL '1 millisecond')-INTERVAL '1 second',
                lease_expires_at=clock_timestamp()-INTERVAL '1 second'`);
        }
        const denied = await h.authority.claimRunnerStart(runnerClaim(h, reservation, redeemed.receipt.redemption_id));
        assert.equal(denied.claimed, false);
        assert.match(denied.blockers.join(' '), /expired/i);
        const state = await h.pool.rows('SELECT state FROM swarm_authority_reservations');
        assert.equal(state[0].state, 'stop-requested');
      } finally { await h.pool.close(); }
    });
  }

  await t.test('relational broker state drift', async () => {
    const h = await harness(binding(), {}, runnerSessionAttestor);
    try {
      const { reservation, redeemed } = await authorizeForRunnerClaim(h);
      await h.pool.execute("UPDATE swarm_authority_broker_principals SET state='disabled'");
      const denied = await h.authority.claimRunnerStart(runnerClaim(h, reservation, redeemed.receipt.redemption_id));
      assert.equal(denied.claimed, false);
      assert.match(denied.blockers.join(' '), /broker principal/i);
      const state = await h.pool.rows('SELECT state FROM swarm_authority_reservations');
      assert.equal(state[0].state, 'stop-requested');
    } finally { await h.pool.close(); }
  });
});

test('runner claim expiry is capped by the original transport observation', async () => {
  let observed = 0;
  const nearlyStale: RunnerSessionAttestor = async () => {
    observed = Date.now() - 55_000;
    return {
      valid: true,
      session: {
        runner_id: 'openai-codex-worker', runner_identity_evidence_ref: 'identity-attestation-001',
        runner_instance_id: 'runner-instance-nearly-stale', runtime_id: 'railway-temporal',
        host_id: 'trusted-host-001', channel_binding_sha256: '8'.repeat(64),
        launch_attempt_id: 'launch-attempt-nearly-stale', fencing_generation: 1,
        observed_at: new Date(observed).toISOString(),
        access_review_expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
      },
      blockers: [],
    };
  };
  const h = await harness(binding(), {}, nearlyStale);
  try {
    const { reservation, redeemed } = await authorizeForRunnerClaim(h, 10_000);
    const claimed = await h.authority.claimRunnerStart(runnerClaim(h, reservation, redeemed.receipt.redemption_id));
    assert.equal(claimed.claimed, true, claimed.blockers.join(' '));
    if (claimed.claimed) {
      assert.ok(Date.parse(claimed.receipt.claim_expires_at) <= observed + 60_000);
    }
  } finally { await h.pool.close(); }
});

test('runner claims reject credential aliasing and quarantine authenticated channel drift', async (t) => {
  await t.test('heartbeat aliases control credential', async () => {
    const h = await harness(binding(), {}, runnerSessionAttestor);
    try {
      const { reservation, redeemed } = await authorizeForRunnerClaim(h);
      const denied = await h.authority.claimRunnerStart(runnerClaim(
        h, reservation, redeemed.receipt.redemption_id, { heartbeat_token: CONTROL_TOKEN },
      ));
      assert.equal(denied.claimed, false);
      assert.match(denied.blockers.join(' '), /invalid/i);
      const state = await h.pool.rows('SELECT state FROM swarm_authority_reservations');
      assert.equal(state[0].state, 'start-authorized-not-observed');
    } finally { await h.pool.close(); }
  });

  await t.test('start-observation aliases heartbeat credential', async () => {
    const h = await harness(binding(), {}, runnerSessionAttestor);
    try {
      const { reservation, redeemed } = await authorizeForRunnerClaim(h);
      const denied = await h.authority.claimRunnerStart(runnerClaim(
        h, reservation, redeemed.receipt.redemption_id,
        { start_observation_token: HEARTBEAT_TOKEN },
      ));
      assert.equal(denied.claimed, false);
      assert.match(denied.blockers.join(' '), /invalid/i);
      const state = await h.pool.rows('SELECT state FROM swarm_authority_reservations');
      assert.equal(state[0].state, 'start-authorized-not-observed');
    } finally { await h.pool.close(); }
  });

  await t.test('channel binding drifts on exact retry', async () => {
    let channel = 'a'.repeat(64);
    const mutableAttestor: RunnerSessionAttestor = async () => ({
      valid: true,
      session: {
        runner_id: 'openai-codex-worker', runner_identity_evidence_ref: 'identity-attestation-001',
        runner_instance_id: 'runner-instance-mutable', runtime_id: 'railway-temporal',
        host_id: 'trusted-host-001', channel_binding_sha256: channel,
        launch_attempt_id: 'launch-attempt-mutable', fencing_generation: 1,
        observed_at: new Date().toISOString(),
        access_review_expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
      },
      blockers: [],
    });
    const h = await harness(binding(), {}, mutableAttestor);
    try {
      const { reservation, redeemed } = await authorizeForRunnerClaim(h);
      const input = runnerClaim(h, reservation, redeemed.receipt.redemption_id);
      assert.equal((await h.authority.claimRunnerStart(input)).claimed, true);
      channel = 'b'.repeat(64);
      const denied = await h.authority.claimRunnerStart(input);
      assert.equal(denied.claimed, false);
      assert.match(denied.blockers.join(' '), /drifted/i);
      const state = await h.pool.rows('SELECT state FROM swarm_authority_reservations');
      assert.equal(state[0].state, 'stop-requested');
    } finally { await h.pool.close(); }
  });
});

test('runner claim replay quarantines stored expiry and revocation drift', async (t) => {
  await t.test('claim expiry is extended beyond its original authority', async () => {
    const h = await harness(binding(), {}, runnerSessionAttestor);
    try {
      const { reservation, redeemed } = await authorizeForRunnerClaim(h);
      const input = runnerClaim(h, reservation, redeemed.receipt.redemption_id);
      assert.equal((await h.authority.claimRunnerStart(input)).claimed, true);
      await h.pool.execute(`UPDATE swarm_authority_reservations SET
        runner_evidence_observed_at=clock_timestamp(),
        runner_access_review_expires_at=clock_timestamp()+INTERVAL '1 hour',
        runner_claim_expires_at=clock_timestamp()+INTERVAL '30 minutes'`);
      const denied = await h.authority.claimRunnerStart(input);
      assert.equal(denied.claimed, false);
      assert.match(denied.blockers.join(' '), /replay evidence drifted/i);
      const state = await h.pool.rows('SELECT state FROM swarm_authority_reservations');
      assert.equal(state[0].state, 'stop-requested');
    } finally { await h.pool.close(); }
  });

  await t.test('stored canonical runner revocations are weakened', async () => {
    const h = await harness(binding(), {}, runnerSessionAttestor);
    try {
      const { reservation, redeemed } = await authorizeForRunnerClaim(h);
      const input = runnerClaim(h, reservation, redeemed.receipt.redemption_id);
      assert.equal((await h.authority.claimRunnerStart(input)).claimed, true);
      await h.pool.execute("UPDATE swarm_authority_reservations SET runner_revocation_refs='[]'::jsonb");
      const denied = await h.authority.claimRunnerStart(input);
      assert.equal(denied.claimed, false);
      assert.match(denied.blockers.join(' '), /revocation binding drifted/i);
      const state = await h.pool.rows('SELECT state FROM swarm_authority_reservations');
      assert.equal(state[0].state, 'stop-requested');
    } finally { await h.pool.close(); }
  });

  await t.test('direct identity revocation does not trust the mutable revocation array', async () => {
    const h = await harness(binding(), {}, runnerSessionAttestor);
    try {
      const { reservation, redeemed } = await authorizeForRunnerClaim(h);
      assert.equal((await h.authority.claimRunnerStart(
        runnerClaim(h, reservation, redeemed.receipt.redemption_id),
      )).claimed, true);
      await h.pool.execute("UPDATE swarm_authority_reservations SET runner_revocation_refs='[]'::jsonb");
      await h.store.revoke(`runner:${h.operation.execution_identity}`, NOW, 'runner revoked after binding drift');
      const state = await h.pool.rows('SELECT state FROM swarm_authority_reservations');
      assert.equal(state[0].state, 'stop-requested');
    } finally { await h.pool.close(); }
  });
});

test('redeems through the exact restricted database role and ignores a temp-shadowed authority table', async () => {
  const h = await harness();
  try {
    const databaseName = String((await h.pool.rows('SELECT current_database() AS name'))[0].name);
    await h.pool.execute('DELETE FROM swarm_authority_broker_principals');
    await h.store.putBrokerPrincipalEvidence(brokerEvidence({ database_name: databaseName }));
    const reservation = await reserve(h);
    const consumed = await h.authority.consume(consumption(h, reservation));
    assert.equal(consumed.consumed, true);
    if (!consumed.consumed) return;
    const leased = await h.authority.leaseStart(startLease(h, reservation, consumed.receipt.consumption_id));
    assert.equal(leased.leased, true);
    if (!leased.leased) return;

    await h.pool.execute(`CREATE ROLE starlight_authority_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
      ${usageAuthorityRoutineOwnerGrantSql('starlight_authority_owner')}
      CREATE ROLE ${BROKER_DATABASE_ROLE} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
      ${brokerDatabaseRoleGrantSql(BROKER_DATABASE_ROLE)}
      SET SESSION AUTHORIZATION ${BROKER_DATABASE_ROLE};
      CREATE TEMP TABLE swarm_authority_broker_principals (database_role TEXT);`);
    const restrictedStore = new PostgresOperationAuthorityStore(h.pool);
    const redeemed = await restrictedStore.redeemStartAuthorization(
      startRedemption(h, reservation, leased.receipt.lease_id),
    );
    assert.equal(redeemed.redeemed, true, redeemed.blockers.join(' '));
    if (redeemed.redeemed) {
      assert.equal(redeemed.receipt.broker_database_role, BROKER_DATABASE_ROLE);
      assert.equal(redeemed.receipt.broker_database_name, databaseName);
      const restrictedClaimStore = new PostgresOperationAuthorityStore(h.pool, { runnerSessionAttestor });
      const claimed = await restrictedClaimStore.claimRunnerStart(
        runnerClaim(h, reservation, redeemed.receipt.redemption_id),
      );
      assert.equal(claimed.claimed, true, claimed.blockers.join(' '));
    }
  } finally { await h.pool.close(); }
});

test('a late authorization retry requests stop without releasing committed resources', async () => {
  const h = await harness();
  try {
    const reservation = await reserve(h);
    const consumed = await h.authority.consume(consumption(h, reservation));
    assert.equal(consumed.consumed, true);
    if (!consumed.consumed) return;
    const leased = await h.authority.leaseStart(startLease(h, reservation, consumed.receipt.consumption_id));
    assert.equal(leased.leased, true);
    if (!leased.leased) return;
    const input = startRedemption(h, reservation, leased.receipt.lease_id);
    assert.equal((await h.authority.redeemStartAuthorization(input)).redeemed, true);
    await h.pool.execute("UPDATE swarm_authority_reservations SET reservation_expires_at=clock_timestamp()-INTERVAL '1 second'");

    const lateRetry = await h.authority.redeemStartAuthorization(input);
    assert.equal(lateRetry.redeemed, false);
    assert.match(lateRetry.blockers.join(' '), /expired/i);
    const state = await h.pool.rows(`SELECT r.state,b.committed_usd,host.authorized_slots
      FROM swarm_authority_reservations r,swarm_authority_budgets b,swarm_authority_hosts host`);
    assert.equal(state[0].state, 'stop-requested');
    assert.equal(Number(state[0].committed_usd), 0.25);
    assert.equal(Number(state[0].authorized_slots), 1);
  } finally { await h.pool.close(); }
});

test('redemption derives broker identity from fresh server-owned database principal evidence', async (t) => {
  await t.test('unregistered database role is denied without consuming the lease', async () => {
    const h = await harness();
    try {
      const reservation = await reserve(h);
      const consumed = await h.authority.consume(consumption(h, reservation));
      assert.equal(consumed.consumed, true);
      if (!consumed.consumed) return;
      const leased = await h.authority.leaseStart(startLease(h, reservation, consumed.receipt.consumption_id));
      assert.equal(leased.leased, true);
      if (!leased.leased) return;
      const otherAttestor: BrokerDatabaseSessionAttestor = async () => ({
        valid: true,
        session: {
          database_role: 'unregistered_broker_role', database_name: BROKER_DATABASE_NAME,
          contract_digest_sha256: BROKER_DATABASE_ROLE_CONTRACT_SHA256,
        },
        blockers: [],
      });
      const otherAuthority = new OperationAuthority(
        new PostgresOperationAuthorityStore(h.pool, { brokerSessionAttestor: otherAttestor }),
        {
          approvalIssuers: { [h.approval.issuer]: { [h.approval.key_id]: APPROVAL_SECRET } },
          budgetIssuers: { [h.budget.issuer]: { [h.budget.key_id]: BUDGET_SECRET } },
        },
      );
      const denied = await otherAuthority.redeemStartAuthorization(
        startRedemption(h, reservation, leased.receipt.lease_id),
      );
      assert.equal(denied.redeemed, false);
      assert.match(denied.blockers.join(' '), /broker principal/i);
      const state = await h.pool.rows('SELECT state FROM swarm_authority_reservations');
      assert.equal(state[0].state, 'leased-not-started');
    } finally { await h.pool.close(); }
  });

  await t.test('stale principal evidence is denied without moving reserved ledgers', async () => {
    const h = await harness();
    try {
      const reservation = await reserve(h);
      const consumed = await h.authority.consume(consumption(h, reservation));
      assert.equal(consumed.consumed, true);
      if (!consumed.consumed) return;
      const leased = await h.authority.leaseStart(startLease(h, reservation, consumed.receipt.consumption_id));
      assert.equal(leased.leased, true);
      if (!leased.leased) return;
      await h.store.putBrokerPrincipalEvidence(brokerEvidence({
        observed_at: new Date(NOW_MS - 10 * 60_000).toISOString(),
      }));
      const denied = await h.authority.redeemStartAuthorization(
        startRedemption(h, reservation, leased.receipt.lease_id),
      );
      assert.equal(denied.redeemed, false);
      assert.match(denied.blockers.join(' '), /stale/i);
      const state = await h.pool.rows(`SELECT r.state,b.reserved_usd,b.committed_usd,h.reserved_slots,h.authorized_slots
        FROM swarm_authority_reservations r,swarm_authority_budgets b,swarm_authority_hosts h`);
      assert.equal(state[0].state, 'leased-not-started');
      assert.deepEqual([
        Number(state[0].reserved_usd), Number(state[0].committed_usd),
        Number(state[0].reserved_slots), Number(state[0].authorized_slots),
      ], [0.25, 0, 1, 0]);
    } finally { await h.pool.close(); }
  });

  await t.test('disabling the authenticated principal quarantines existing start authority', async () => {
    const h = await harness();
    try {
      const reservation = await reserve(h);
      const consumed = await h.authority.consume(consumption(h, reservation));
      assert.equal(consumed.consumed, true);
      if (!consumed.consumed) return;
      const leased = await h.authority.leaseStart(startLease(h, reservation, consumed.receipt.consumption_id));
      assert.equal(leased.leased, true);
      if (!leased.leased) return;
      assert.equal((await h.authority.redeemStartAuthorization(
        startRedemption(h, reservation, leased.receipt.lease_id),
      )).redeemed, true);
      await h.store.putBrokerPrincipalEvidence(brokerEvidence({ state: 'disabled' }));
      const state = await h.pool.rows(`SELECT r.state,b.committed_usd,h.authorized_slots
        FROM swarm_authority_reservations r,swarm_authority_budgets b,swarm_authority_hosts h`);
      assert.equal(state[0].state, 'stop-requested');
      assert.equal(Number(state[0].committed_usd), 0.25);
      assert.equal(Number(state[0].authorized_slots), 1);
    } finally { await h.pool.close(); }
  });
});

test('redemption rejects host attribution drift from the signed operation binding', async () => {
  const h = await harness();
  try {
    const reservation = await reserve(h);
    const consumed = await h.authority.consume(consumption(h, reservation));
    assert.equal(consumed.consumed, true);
    if (!consumed.consumed) return;
    const leased = await h.authority.leaseStart(startLease(h, reservation, consumed.receipt.consumption_id));
    assert.equal(leased.leased, true);
    if (!leased.leased) return;
    await h.store.putHostEvidence({
      host_id: 'trusted-host-002', observed_at: NOW, status: 'ready', capacity_slots: 4,
      secret_readiness: true, access_review_expires_at: EXPIRES,
      allowed_capabilities: ['repository.read', 'repository.write'],
    });
    await h.pool.execute("UPDATE swarm_authority_reservations SET host_id='trusted-host-002'");

    const denied = await h.authority.redeemStartAuthorization(
      startRedemption(h, reservation, leased.receipt.lease_id),
    );
    assert.equal(denied.redeemed, false);
    assert.match(denied.blockers.join(' '), /signed operation binding/i);
    const state = await h.pool.rows('SELECT state FROM swarm_authority_reservations');
    assert.equal(state[0].state, 'leased-not-started');
  } finally { await h.pool.close(); }
});

test('an exact authorization retry quarantines signed host attribution drift', async () => {
  const h = await harness();
  try {
    const reservation = await reserve(h);
    const consumed = await h.authority.consume(consumption(h, reservation));
    assert.equal(consumed.consumed, true);
    if (!consumed.consumed) return;
    const leased = await h.authority.leaseStart(startLease(h, reservation, consumed.receipt.consumption_id));
    assert.equal(leased.leased, true);
    if (!leased.leased) return;
    const input = startRedemption(h, reservation, leased.receipt.lease_id);
    assert.equal((await h.authority.redeemStartAuthorization(input)).redeemed, true);
    await h.store.putHostEvidence({
      host_id: 'trusted-host-002', observed_at: NOW, status: 'ready', capacity_slots: 4,
      secret_readiness: true, access_review_expires_at: EXPIRES,
      allowed_capabilities: ['repository.read', 'repository.write'],
    });
    await h.pool.execute("UPDATE swarm_authority_reservations SET host_id='trusted-host-002'");

    const denied = await h.authority.redeemStartAuthorization(input);
    assert.equal(denied.redeemed, false);
    assert.match(denied.blockers.join(' '), /signed binding/i);
    const state = await h.pool.rows(`SELECT r.state,b.committed_usd,h.authorized_slots
      FROM swarm_authority_reservations r
      JOIN swarm_authority_budgets b ON b.receipt_id=r.budget_receipt_id
      JOIN swarm_authority_hosts h ON h.host_id='trusted-host-001'`);
    assert.equal(state[0].state, 'stop-requested');
    assert.equal(Number(state[0].committed_usd), 0.25);
    assert.equal(Number(state[0].authorized_slots), 1);
  } finally { await h.pool.close(); }
});

test('migration cancels a pre-redemption lease and releases its reserved ledgers once', async () => {
  const h = await harness();
  try {
    const reservation = await reserve(h);
    const consumed = await h.authority.consume(consumption(h, reservation));
    assert.equal(consumed.consumed, true);
    if (!consumed.consumed) return;
    const leased = await h.authority.leaseStart(startLease(h, reservation, consumed.receipt.consumption_id));
    assert.equal(leased.leased, true);
    await h.pool.execute(`
      ALTER TABLE swarm_authority_reservations DROP CONSTRAINT swarm_authority_reservations_lease_fields_check;
      UPDATE swarm_authority_reservations
      SET redemption_token_sha256=NULL,control_token_sha256=NULL,
          broker_execution_identity=NULL,broker_identity_evidence_ref=NULL;
    `);
    await h.store.initialize();
    await h.store.initialize();
    const state = await h.pool.rows(`SELECT r.state,b.reserved_usd,b.committed_usd,
      host.reserved_slots,host.authorized_slots
      FROM swarm_authority_reservations r,swarm_authority_budgets b,swarm_authority_hosts host`);
    assert.equal(state[0].state, 'cancelled');
    assert.equal(Number(state[0].reserved_usd), 0);
    assert.equal(Number(state[0].committed_usd), 0);
    assert.equal(Number(state[0].reserved_slots), 0);
    assert.equal(Number(state[0].authorized_slots), 0);
    const windows = await h.pool.rows('SELECT reserved_usd,committed_usd FROM swarm_authority_budget_windows');
    assert.ok(windows.every((row) => Number(row.reserved_usd) === 0 && Number(row.committed_usd) === 0));
    const events = await h.pool.rows(`SELECT event FROM swarm_authority_audit
      WHERE event='reservation-cancelled' AND detail->>'reason'='lease predated redemption and control credentials'`);
    assert.equal(events.length, 1);
  } finally { await h.pool.close(); }
});

test('legacy-lease migration rejects grouped host underfunding before mutating rows', async () => {
  const h = await harness();
  try {
    const firstReservation = await reserve(h);
    const firstConsumption = await h.authority.consume(consumption(h, firstReservation));
    assert.equal(firstConsumption.consumed, true);
    if (!firstConsumption.consumed) return;
    assert.equal((await h.authority.leaseStart(startLease(
      h, firstReservation, firstConsumption.receipt.consumption_id,
    ))).leased, true);

    const relatedOperation = binding({ operation_id: 'operation-legacy-002', effect_id: 'effect-legacy-002' });
    const related = await admitRelated(h, relatedOperation, 'legacy-002');
    assert.equal(related.admitted, true);
    if (!related.admitted) return;
    const relatedConsumption = await h.authority.consume({
      reservation_id: related.reservation.reservation_id,
      operation_id: relatedOperation.operation_id,
      effect_id: relatedOperation.effect_id,
      binding_digest_sha256: related.reservation.binding_digest_sha256,
      execution_identity: relatedOperation.execution_identity,
      identity_evidence_ref: relatedOperation.identity_evidence_ref,
      consume_token: related.reservation.consume_token,
      lease_claim_token: 'M'.repeat(43),
    });
    assert.equal(relatedConsumption.consumed, true);
    if (!relatedConsumption.consumed) return;
    const relatedLease = await h.authority.leaseStart({
      reservation_id: related.reservation.reservation_id,
      consumption_id: relatedConsumption.receipt.consumption_id,
      start_request_id: '00000000-0000-4000-8000-000000000109',
      operation_id: relatedOperation.operation_id,
      effect_id: relatedOperation.effect_id,
      binding_digest_sha256: related.reservation.binding_digest_sha256,
      execution_identity: relatedOperation.execution_identity,
      identity_evidence_ref: relatedOperation.identity_evidence_ref,
      lease_claim_token: 'M'.repeat(43),
      redemption_token: 'S'.repeat(43),
      control_token: 'T'.repeat(43),
      broker_execution_identity: BROKER_IDENTITY,
      broker_identity_evidence_ref: BROKER_EVIDENCE,
      lease_duration_ms: 5_000,
    });
    assert.equal(relatedLease.leased, true);

    await h.pool.execute(`
      ALTER TABLE swarm_authority_reservations DROP CONSTRAINT swarm_authority_reservations_lease_fields_check;
      UPDATE swarm_authority_reservations
      SET redemption_token_sha256=NULL,control_token_sha256=NULL,
          broker_execution_identity=NULL,broker_identity_evidence_ref=NULL;
      UPDATE swarm_authority_hosts SET reserved_slots=1;
    `);
    await assert.rejects(h.store.initialize(), /legacy start lease host ledger is inconsistent/i);
    const preserved = await h.pool.rows('SELECT state FROM swarm_authority_reservations ORDER BY operation_id');
    assert.deepEqual(preserved.map((row) => row.state), ['leased-not-started', 'leased-not-started']);

    await h.pool.execute('UPDATE swarm_authority_hosts SET reserved_slots=2');
    await h.store.initialize();
    await h.store.initialize();
    const terminal = await h.pool.rows('SELECT state FROM swarm_authority_reservations ORDER BY operation_id');
    assert.deepEqual(terminal.map((row) => row.state), ['cancelled', 'cancelled']);
    const events = await h.pool.rows(`SELECT event FROM swarm_authority_audit
      WHERE event='reservation-cancelled' AND detail->>'reason'='lease predated redemption and control credentials'`);
    assert.equal(events.length, 2);
  } finally { await h.pool.close(); }
});

test('admission counts both committed cost and authorized host slots', async (t) => {
  const authorize = async (h: Harness) => {
    const reservation = await reserve(h);
    const consumed = await h.authority.consume(consumption(h, reservation));
    if (!consumed.consumed) assert.fail(consumed.blockers.join(' '));
    const leased = await h.authority.leaseStart(startLease(h, reservation, consumed.receipt.consumption_id));
    if (!leased.leased) assert.fail(leased.blockers.join(' '));
    const redeemed = await h.authority.redeemStartAuthorization(startRedemption(h, reservation, leased.receipt.lease_id));
    if (!redeemed.redeemed) assert.fail(redeemed.blockers.join(' '));
  };

  await t.test('authorized slot exhausts host capacity', async () => {
    const h = await harness();
    try {
      const observedAt = new Date().toISOString();
      await h.store.putHostEvidence({
        host_id: h.operation.host_id, observed_at: observedAt, status: 'ready', capacity_slots: 1,
        secret_readiness: true, access_review_expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
        allowed_capabilities: ['repository.read', 'repository.write'],
      });
      await authorize(h);
      const related = binding({ operation_id: 'operation-capacity-002', effect_id: 'effect-capacity-002' });
      const denied = await admitRelated(h, related, 'capacity-002');
      assert.equal(denied.admitted, false);
      assert.match(denied.blockers.join(' '), /no available capacity/i);
    } finally { await h.pool.close(); }
  });

  await t.test('committed cost exhausts aggregate windows', async () => {
    const h = await harness(binding(), { policyLimit: 0.25, dailyLimit: 0.25 });
    try {
      await authorize(h);
      const related = binding({ operation_id: 'operation-budget-002', effect_id: 'effect-budget-002' });
      const denied = await admitRelated(h, related, 'budget-002');
      assert.equal(denied.admitted, false);
      assert.match(denied.blockers.join(' '), /aggregate budget window is exhausted/i);
    } finally { await h.pool.close(); }
  });
});

test('initialization rejects an authorized row with orphaned budget attribution', async () => {
  const h = await harness();
  try {
    const reservation = await reserve(h);
    const consumed = await h.authority.consume(consumption(h, reservation));
    assert.equal(consumed.consumed, true);
    if (!consumed.consumed) return;
    const leased = await h.authority.leaseStart(startLease(h, reservation, consumed.receipt.consumption_id));
    assert.equal(leased.leased, true);
    if (!leased.leased) return;
    const redeemed = await h.authority.redeemStartAuthorization(startRedemption(h, reservation, leased.receipt.lease_id));
    assert.equal(redeemed.redeemed, true);
    await h.pool.execute("UPDATE swarm_authority_reservations SET budget_receipt_id='missing-budget'");
    await assert.rejects(h.store.initialize(), /authorized operation attribution is missing, ambiguous, or inconsistent/i);
    const state = await h.pool.rows('SELECT state,budget_receipt_id FROM swarm_authority_reservations');
    assert.equal(state[0].state, 'start-authorized-not-observed');
    assert.equal(state[0].budget_receipt_id, 'missing-budget');
  } finally { await h.pool.close(); }
});

test('start leases remain bounded by operation and reservation time', async () => {
  const h = await harness();
  try {
    const reservation = await reserve(h);
    const consumed = await h.authority.consume(consumption(h, reservation));
    assert.equal(consumed.consumed, true);
    if (!consumed.consumed) return;
    const denied = await h.authority.leaseStart(startLease(h, reservation, consumed.receipt.consumption_id, {
      lease_duration_ms: 121_000,
    }));
    assert.equal(denied.leased, false);
    assert.match(denied.blockers.join(' '), /operation timeout/i);
    const stored = await h.pool.rows('SELECT state,lease_id FROM swarm_authority_reservations');
    assert.equal(stored[0].state, 'consumed-not-started');
    assert.equal(stored[0].lease_id, null);
  } finally { await h.pool.close(); }
});

test('a migrated consumption without a lease credential remains start-ineligible but cancellable', async () => {
  const h = await harness();
  try {
    const reservation = await reserve(h);
    const consumed = await h.authority.consume(consumption(h, reservation));
    assert.equal(consumed.consumed, true);
    if (!consumed.consumed) return;
    await h.pool.execute('UPDATE swarm_authority_reservations SET lease_claim_token_sha256=NULL');
    await h.store.initialize();
    await h.store.initialize();

    const denied = await h.authority.leaseStart(startLease(h, reservation, consumed.receipt.consumption_id));
    assert.equal(denied.leased, false);
    assert.match(denied.blockers.join(' '), /does not exist/i);
    const beforeCancel = await h.pool.rows('SELECT state,lease_id FROM swarm_authority_reservations');
    assert.equal(beforeCancel[0].state, 'consumed-not-started');
    assert.equal(beforeCancel[0].lease_id, null);

    const cancelled = await h.authority.cancel(cancellation(reservation, 'retire pre-lease consumption'));
    assert.equal(cancelled.cancelled, true);
    assert.equal(cancelled.released_cost_usd, h.operation.requested_cost_usd);
    const afterCancel = await h.pool.rows(`SELECT r.state,b.reserved_usd,h.reserved_slots
      FROM swarm_authority_reservations r,swarm_authority_budgets b,swarm_authority_hosts h`);
    assert.equal(afterCancel[0].state, 'cancelled');
    assert.equal(Number(afterCancel[0].reserved_usd), 0);
    assert.equal(Number(afterCancel[0].reserved_slots), 0);
    const windows = await h.pool.rows('SELECT reserved_usd FROM swarm_authority_budget_windows');
    assert.ok(windows.every((row) => Number(row.reserved_usd) === 0));
  } finally { await h.pool.close(); }
});

test('an unredeemed expired lease releases every reservation exactly once and preserves its tombstone', async () => {
  const h = await harness();
  try {
    const reservation = await reserve(h);
    const consumed = await h.authority.consume(consumption(h, reservation));
    assert.equal(consumed.consumed, true);
    if (!consumed.consumed) return;
    const input = startLease(h, reservation, consumed.receipt.consumption_id);
    assert.equal((await h.authority.leaseStart(input)).leased, true);
    await h.pool.execute(`UPDATE swarm_authority_reservations SET
      lease_issued_at=statement_timestamp()-INTERVAL '2 minutes',
      lease_expires_at=statement_timestamp()-INTERVAL '1 minute',lease_duration_ms=60000`);
    const expired = await h.authority.leaseStart(input);
    assert.equal(expired.leased, false);
    assert.match(expired.blockers.join(' '), /expired before runner connection/i);
    const rows = await h.pool.rows(`SELECT r.state,b.reserved_usd,h.reserved_slots
      FROM swarm_authority_reservations r,swarm_authority_budgets b,swarm_authority_hosts h`);
    assert.equal(rows[0].state, 'expired');
    assert.equal(Number(rows[0].reserved_usd), 0);
    assert.equal(Number(rows[0].reserved_slots), 0);
    const windows = await h.pool.rows('SELECT reserved_usd FROM swarm_authority_budget_windows');
    assert.ok(windows.every((row) => Number(row.reserved_usd) === 0));
    const replay = await h.authority.leaseStart(input);
    assert.equal(replay.leased, false);
    assert.match(replay.blockers.join(' '), /expired/i);
  } finally { await h.pool.close(); }
});

test('revocation and expiry deny consumption, release resources once, and retain replay tombstones', async (t) => {
  await t.test('revocation', async () => {
    const h = await harness();
    try {
      const reservation = await reserve(h);
      await h.store.revoke('key:starlight-approval:approval-key-001', NOW, 'operator rotation');
      const denied = await h.authority.consume(consumption(h, reservation));
      assert.equal(denied.consumed, false);
      assert.match(denied.blockers.join(' '), /cancelled/i);
      const rows = await h.pool.rows(`SELECT r.state,b.reserved_usd,h.reserved_slots
        FROM swarm_authority_reservations r,swarm_authority_budgets b,swarm_authority_hosts h`);
      assert.equal(rows[0].state, 'cancelled');
      assert.equal(Number(rows[0].reserved_usd), 0);
      assert.equal(Number(rows[0].reserved_slots), 0);
      const windows = await h.pool.rows('SELECT reserved_usd FROM swarm_authority_budget_windows');
      assert.ok(windows.every((row) => Number(row.reserved_usd) === 0));
    } finally { await h.pool.close(); }
  });

  await t.test('revocation after lease issuance', async () => {
    const h = await harness();
    try {
      const reservation = await reserve(h);
      const consumed = await h.authority.consume(consumption(h, reservation));
      assert.equal(consumed.consumed, true);
      if (!consumed.consumed) return;
      const leaseInput = startLease(h, reservation, consumed.receipt.consumption_id);
      assert.equal((await h.authority.leaseStart(leaseInput)).leased, true);

      await h.store.revoke('key:starlight-approval:approval-key-001', NOW, 'operator rotation');
      await h.store.revoke('key:starlight-approval:approval-key-001', NOW, 'idempotent retry');
      const replay = await h.authority.leaseStart(leaseInput);
      assert.equal(replay.leased, false);
      assert.match(replay.blockers.join(' '), /cancelled/i);
      const rows = await h.pool.rows(`SELECT r.state,b.reserved_usd,h.reserved_slots
        FROM swarm_authority_reservations r,swarm_authority_budgets b,swarm_authority_hosts h`);
      assert.equal(rows[0].state, 'cancelled');
      assert.equal(Number(rows[0].reserved_usd), 0);
      assert.equal(Number(rows[0].reserved_slots), 0);
      const windows = await h.pool.rows('SELECT reserved_usd FROM swarm_authority_budget_windows');
      assert.ok(windows.every((row) => Number(row.reserved_usd) === 0));
      const cancellations = await h.pool.rows("SELECT event FROM swarm_authority_audit WHERE event='reservation-cancelled'");
      assert.equal(cancellations.length, 1);
    } finally { await h.pool.close(); }
  });

  await t.test('revocation after start authorization quarantines committed resources', async () => {
    const h = await harness();
    try {
      const reservation = await reserve(h);
      const consumed = await h.authority.consume(consumption(h, reservation));
      assert.equal(consumed.consumed, true);
      if (!consumed.consumed) return;
      const leased = await h.authority.leaseStart(startLease(h, reservation, consumed.receipt.consumption_id));
      assert.equal(leased.leased, true);
      if (!leased.leased) return;
      assert.equal((await h.authority.redeemStartAuthorization(
        startRedemption(h, reservation, leased.receipt.lease_id),
      )).redeemed, true);
      await h.store.revoke('key:starlight-approval:approval-key-001', NOW, 'post-authorization rotation');
      const rows = await h.pool.rows(`SELECT r.state,b.reserved_usd,b.committed_usd,
        host.reserved_slots,host.authorized_slots
        FROM swarm_authority_reservations r,swarm_authority_budgets b,swarm_authority_hosts host`);
      assert.equal(rows[0].state, 'stop-requested');
      assert.equal(Number(rows[0].reserved_usd), 0);
      assert.equal(Number(rows[0].committed_usd), 0.25);
      assert.equal(Number(rows[0].reserved_slots), 0);
      assert.equal(Number(rows[0].authorized_slots), 1);
    } finally { await h.pool.close(); }
  });

  await t.test('expiry', async () => {
    const h = await harness();
    try {
      const reservation = await reserve(h);
      await h.pool.execute("UPDATE swarm_authority_reservations SET reservation_expires_at=clock_timestamp()-INTERVAL '1 minute'");
      const denied = await h.authority.consume(consumption(h, reservation));
      assert.equal(denied.consumed, false);
      assert.match(denied.blockers.join(' '), /expired/i);
      const rows = await h.pool.rows(`SELECT r.state,b.reserved_usd,h.reserved_slots
        FROM swarm_authority_reservations r,swarm_authority_budgets b,swarm_authority_hosts h`);
      assert.equal(rows[0].state, 'expired');
      assert.equal(Number(rows[0].reserved_usd), 0);
      assert.equal(Number(rows[0].reserved_slots), 0);
      const windows = await h.pool.rows('SELECT reserved_usd FROM swarm_authority_budget_windows');
      assert.ok(windows.every((row) => Number(row.reserved_usd) === 0));
      const replay = await h.authority.admit({
        binding: h.operation,
        approval_receipt: h.approval,
        budget_receipt: h.budget,
        reservation_duration_ms: 5 * 60_000,
      });
      assert.equal(replay.admitted, false);
      assert.match(replay.blockers.join(' '), /already reserved/i);
    } finally { await h.pool.close(); }
  });

  await t.test('prepared-operation cancellation proactively invalidates an issued pre-start lease', async () => {
    const h = await harness();
    try {
      const reservation = await reserve(h);
      const consumed = await h.authority.consume(consumption(h, reservation));
      assert.equal(consumed.consumed, true);
      if (!consumed.consumed) return;
      const leaseInput = startLease(h, reservation, consumed.receipt.consumption_id);
      assert.equal((await h.authority.leaseStart(leaseInput)).leased, true);
      await h.store.cancelPreparedOperation(h.operation.operation_id);
      const denied = await h.authority.leaseStart(leaseInput);
      assert.equal(denied.leased, false);
      assert.match(denied.blockers.join(' '), /cancelled/i);
      const rows = await h.pool.rows(`SELECT r.state,b.reserved_usd,h.reserved_slots
        FROM swarm_authority_reservations r,swarm_authority_budgets b,swarm_authority_hosts h`);
      assert.equal(rows[0].state, 'cancelled');
      assert.equal(Number(rows[0].reserved_usd), 0);
      assert.equal(Number(rows[0].reserved_slots), 0);
      const windows = await h.pool.rows('SELECT reserved_usd FROM swarm_authority_budget_windows');
      assert.ok(windows.every((row) => Number(row.reserved_usd) === 0));
    } finally { await h.pool.close(); }
  });

  await t.test('prepared-operation cancellation after authorization requests stop without release', async () => {
    const h = await harness();
    try {
      const reservation = await reserve(h);
      const consumed = await h.authority.consume(consumption(h, reservation));
      assert.equal(consumed.consumed, true);
      if (!consumed.consumed) return;
      const leased = await h.authority.leaseStart(startLease(h, reservation, consumed.receipt.consumption_id));
      assert.equal(leased.leased, true);
      if (!leased.leased) return;
      assert.equal((await h.authority.redeemStartAuthorization(
        startRedemption(h, reservation, leased.receipt.lease_id),
      )).redeemed, true);
      await h.store.cancelPreparedOperation(h.operation.operation_id);
      const rows = await h.pool.rows(`SELECT r.state,b.committed_usd,host.authorized_slots
        FROM swarm_authority_reservations r,swarm_authority_budgets b,swarm_authority_hosts host`);
      assert.equal(rows[0].state, 'stop-requested');
      assert.equal(Number(rows[0].committed_usd), 0.25);
      assert.equal(Number(rows[0].authorized_slots), 1);
    } finally { await h.pool.close(); }
  });
});

test('cancellation releases a reserved, consumed, or unredeemed leased hold exactly once', async (t) => {
  for (const mode of ['reserved-not-started', 'consumed-not-started', 'leased-not-started'] as const) {
    await t.test(mode, async () => {
      const h = await harness();
      try {
        const reservation = await reserve(h);
        if (mode !== 'reserved-not-started') {
          const consumed = await h.authority.consume(consumption(h, reservation));
          assert.equal(consumed.consumed, true);
          if (consumed.consumed && mode === 'leased-not-started') {
            assert.equal((await h.authority.leaseStart(
              startLease(h, reservation, consumed.receipt.consumption_id),
            )).leased, true);
          }
        }
        const spoofed = await h.authority.cancel({
          ...cancellation(reservation, 'unauthorized cancellation'),
          cancel_token: 'A'.repeat(43),
        });
        assert.equal(spoofed.cancelled, false);
        assert.match(spoofed.blockers.join(' '), /does not exist/i);
        const first = await h.authority.cancel(cancellation(reservation, 'operator cancelled before start'));
        assert.equal(first.cancelled, true);
        if (!first.cancelled) return;
        assert.equal(first.already_terminal, false);
        assert.equal(first.released_cost_usd, h.operation.requested_cost_usd);
        const retry = await h.authority.cancel(cancellation(reservation, 'idempotent retry'));
        assert.equal(retry.cancelled, true);
        if (!retry.cancelled) return;
        assert.equal(retry.already_terminal, true);
        assert.equal(retry.released_cost_usd, 0);
        const rows = await h.pool.rows('SELECT reserved_usd FROM swarm_authority_budgets');
        const hosts = await h.pool.rows('SELECT reserved_slots FROM swarm_authority_hosts');
        assert.equal(Number(rows[0].reserved_usd), 0);
        assert.equal(Number(hosts[0].reserved_slots), 0);
        const windows = await h.pool.rows('SELECT reserved_usd FROM swarm_authority_budget_windows');
        assert.ok(windows.every((row) => Number(row.reserved_usd) === 0));
        const audit = await h.pool.rows('SELECT detail FROM swarm_authority_audit ORDER BY seq');
        assert.doesNotMatch(JSON.stringify(audit), new RegExp(reservation.cancel_token));
      } finally { await h.pool.close(); }
    });
  }
});

test('a missing aggregate hold rolls back cancellation and preserves every remaining ledger', async () => {
  const h = await harness();
  try {
    const reservation = await reserve(h);
    await h.pool.execute(`DELETE FROM swarm_authority_budget_holds
      WHERE reservation_id='${reservation.reservation_id}'::uuid AND window_id='${reservation.budget_windows[0].window_id}'`);
    await assert.rejects(
      () => h.authority.cancel(cancellation(reservation, 'must fail closed')),
      /aggregate budget holds are missing/i,
    );
    const rows = await h.pool.rows(`SELECT r.state,b.reserved_usd,h.reserved_slots
      FROM swarm_authority_reservations r,swarm_authority_budgets b,swarm_authority_hosts h`);
    assert.equal(rows[0].state, 'reserved-not-started');
    assert.equal(Number(rows[0].reserved_usd), 0.25);
    assert.equal(Number(rows[0].reserved_slots), 1);
    const windows = await h.pool.rows('SELECT reserved_usd FROM swarm_authority_budget_windows');
    assert.ok(windows.every((row) => Number(row.reserved_usd) === 0.25));
  } finally { await h.pool.close(); }
});

test('aggregate attribution corruption fails closed and leaves durable refusal evidence', async (t) => {
  await t.test('initialization rejects a partial active hold set', async () => {
    const h = await harness();
    try {
      const reservation = await reserve(h);
      await h.pool.execute(`DELETE FROM swarm_authority_budget_holds
        WHERE reservation_id='${reservation.reservation_id}'::uuid AND window_id='${reservation.budget_windows[0].window_id}'`);
      await assert.rejects(() => h.store.initialize(), /active aggregate budget attribution is inconsistent/i);
      const audits = await h.pool.rows("SELECT detail FROM swarm_authority_audit WHERE event='denied' ORDER BY seq DESC LIMIT 1");
      assert.match(JSON.stringify(audits[0]?.detail), /integrity_refusal.*initialize/i);
    } finally { await h.pool.close(); }
  });

  await t.test('consumption rejects an aggregate ledger that no longer funds its active holds', async () => {
    const h = await harness();
    try {
      const reservation = await reserve(h);
      // This difference collapses to equality as a JavaScript Number; PostgreSQL
      // NUMERIC must remain the authority for the comparison.
      await h.pool.execute(`UPDATE swarm_authority_budget_windows SET reserved_usd=0.24999999999999999
        WHERE window_id='${reservation.budget_windows[0].window_id}'`);
      const result = await h.authority.consume(consumption(h, reservation));
      assert.equal(result.consumed, false);
      assert.match(result.blockers.join(' '), /aggregate budget holds are missing, ambiguous, or inconsistent/i);
      const stored = await h.pool.rows('SELECT state FROM swarm_authority_reservations');
      assert.equal(stored[0].state, 'reserved-not-started');
    } finally { await h.pool.close(); }
  });

  await t.test('stored cost and every ledger cannot drift together from the signed binding', async () => {
    const h = await harness();
    try {
      const reservation = await reserve(h);
      await h.pool.execute(`
        UPDATE swarm_authority_reservations SET reserved_cost_usd=0.10 WHERE reservation_id='${reservation.reservation_id}'::uuid;
        UPDATE swarm_authority_budget_holds SET reserved_cost_usd=0.10 WHERE reservation_id='${reservation.reservation_id}'::uuid;
        UPDATE swarm_authority_budget_windows SET reserved_usd=0.10;
        UPDATE swarm_authority_budgets SET reserved_usd=0.10;
      `);
      const result = await h.authority.consume(consumption(h, reservation));
      assert.equal(result.consumed, false);
      assert.match(result.blockers.join(' '), /signed cost is invalid/i);
      await assert.rejects(() => h.store.initialize(), /active aggregate budget attribution is inconsistent/i);
    } finally { await h.pool.close(); }
  });

  await t.test('revocation cannot release holds attributed to the wrong signed policy', async () => {
    const h = await harness();
    try {
      await reserve(h);
      await h.pool.execute("UPDATE swarm_authority_budget_windows SET policy_id='corrupt-policy' WHERE kind='daily'");
      await assert.rejects(
        () => h.store.revoke('key:starlight-approval:approval-key-001', NOW, 'integrity exercise'),
        /aggregate budget holds are missing, ambiguous, or inconsistent/i,
      );
      const stored = await h.pool.rows('SELECT state FROM swarm_authority_reservations');
      assert.equal(stored[0].state, 'reserved-not-started');
      const audits = await h.pool.rows("SELECT detail FROM swarm_authority_audit WHERE event='denied' ORDER BY seq DESC LIMIT 1");
      assert.match(JSON.stringify(audits[0]?.detail), /integrity_refusal.*revoke/i);
    } finally { await h.pool.close(); }
  });
});
