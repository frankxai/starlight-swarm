import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Pool, type PoolClient } from 'pg';

import { OperationAuthority, signApprovalReceipt, signBudgetReceipt, type OperationBinding } from './operation-authority';
import {
  PostgresOperationAuthorityStore,
  type AuthoritySqlPool,
  type RunnerSessionAttestor,
  type RunnerOutcomeEvidence,
  type RunnerOutcomeEvidenceAttestor,
  type RunnerStartEvidence,
  type RunnerStartEvidenceAttestor,
  type RunnerUsageEvidence,
  type RunnerUsageEvidenceAttestor,
} from './postgres-operation-authority';
import { sha256Digest } from './runtime-digest';
import {
  BROKER_DATABASE_ROLE_CONTRACT_SHA256,
  attestUsageEvidenceDatabaseSession,
  brokerDatabaseRoleGrantSql,
  usageAuthorityRoutineOwnerGrantSql,
  usageEvidenceDatabaseRoleGrantSql,
  type BrokerDatabaseSessionAttestor,
} from './authority-role-contract';

const databaseUrl = process.env.TEST_DATABASE_URL;
const approvalSecret = 'postgres-approval-secret-at-least-32-bytes';
const budgetSecret = 'postgres-budget-secret-at-least-32-bytes';
const leaseClaimToken = 'L'.repeat(43);
const redemptionToken = 'R'.repeat(43);
const controlToken = 'C'.repeat(43);
const heartbeatToken = 'H'.repeat(43);
const startObservationToken = 'S'.repeat(43);
const outcomeToken = 'O'.repeat(43);
const usageToken = 'U'.repeat(43);
const nextUsageToken = 'V'.repeat(43);
const secondNextUsageToken = 'W'.repeat(43);
const competingUsageToken = 'X'.repeat(43);
const nextHeartbeatToken = 'N'.repeat(43);
const competingHeartbeatToken = 'M'.repeat(43);
let currentRunnerLaunchAttemptId = 'postgres-launch-attempt-001';
const brokerSessionAttestor: BrokerDatabaseSessionAttestor = async () => ({
  valid: true,
  session: {
    database_role: 'starlight_postgres_test_broker',
    database_name: 'starlight_test',
    contract_digest_sha256: BROKER_DATABASE_ROLE_CONTRACT_SHA256,
  },
  blockers: [],
});
const runnerSessionAttestor: RunnerSessionAttestor = async () => {
  const now = Date.now();
  return {
    valid: true,
    session: {
      runner_id: 'postgres-execution-001',
      runner_identity_evidence_ref: 'postgres-identity-evidence-001',
      runner_instance_id: 'postgres-runner-instance-001',
      runtime_id: 'postgres-test-runtime',
      host_id: 'postgres-test-host',
      channel_binding_sha256: '9'.repeat(64),
      launch_attempt_id: currentRunnerLaunchAttemptId,
      fencing_generation: 1,
      observed_at: new Date(now).toISOString(),
      access_review_expires_at: new Date(now + 10 * 60_000).toISOString(),
    },
    blockers: [],
  };
};
let currentStartEvidence: RunnerStartEvidence | undefined;
let currentOutcomeEvidence: RunnerOutcomeEvidence | undefined;
let currentUsageEvidence: RunnerUsageEvidence | undefined;
const runnerStartEvidenceAttestor: RunnerStartEvidenceAttestor = async () => currentStartEvidence
  ? { valid: true, evidence: currentStartEvidence, blockers: [] }
  : { valid: false, evidence: null, blockers: ['No server-owned process evidence exists.'] };
const runnerOutcomeEvidenceAttestor: RunnerOutcomeEvidenceAttestor = async () => currentOutcomeEvidence
  ? { valid: true, evidence: currentOutcomeEvidence, blockers: [] }
  : { valid: false, evidence: null, blockers: ['No server-owned outcome evidence exists.'] };
const runnerUsageEvidenceAttestor: RunnerUsageEvidenceAttestor = async () => currentUsageEvidence
  ? { valid: true, evidence: currentUsageEvidence, blockers: [] }
  : { valid: false, evidence: null, blockers: ['No provider usage evidence exists.'] };
const storeOptions = {
  brokerSessionAttestor, runnerSessionAttestor, runnerStartEvidenceAttestor, runnerOutcomeEvidenceAttestor,
  runnerUsageEvidenceAttestor,
};

function binding(): OperationBinding {
  return {
    schema_version: 'starlight.operation_binding.v1',
    operation_id: 'postgres-operation-001',
    effect_id: 'postgres-effect-001',
    mission_id: 'postgres-mission-001',
    call_id: 'postgres-call-maker-001',
    role: 'maker',
    actor_id: 'postgres-maker-001',
    execution_identity: 'postgres-execution-001',
    identity_evidence_ref: 'postgres-identity-evidence-001',
    context_digest_sha256: '1'.repeat(64),
    prompt_sha256: '2'.repeat(64),
    timeout_ms: 120_000,
    requested_operation: 'repository.write',
    effect: {
      kind: 'repository.write',
      resource: 'repo://frankxai/starlight-swarm/race-fixture',
      parameters_digest_sha256: '3'.repeat(64),
    },
    source_profile: {
      repository: 'frankxai/starlight-swarm',
      commit_sha: '1efb525e046b7dacf508d0f174d2399a8412acf9',
      path: 'config/teams/starlight-core.team.yaml',
      digest_sha256: '4'.repeat(64),
    },
    policy_digest_sha256: '5'.repeat(64),
    plan_digest_sha256: '6'.repeat(64),
    pack_digest_sha256: '7'.repeat(64),
    compiler_version: 'starlight.team_pack.compiler.v2',
    lane_id: 'postgres-durable-builder',
    workload_id: 'postgres-bounded-maker',
    runtime_id: 'postgres-test-runtime',
    host_id: 'postgres-test-host',
    capabilities: ['repository.read', 'repository.write'],
    budget_policy_id: 'postgres-budget-policy',
    requested_cost_usd: 0.25,
  };
}

test('real PostgreSQL serializes consume, cancel and revoke races without duplicate transitions', {
  skip: databaseUrl ? false : 'TEST_DATABASE_URL is required for the real PostgreSQL race lane.',
  timeout: 60_000,
}, async (t) => {
  const pool = new Pool({ connectionString: databaseUrl, max: 16 });
  const authorityPool: AuthoritySqlPool = {
    connect: async () => {
      const client = await pool.connect();
      return {
        query: async (sql, values) => {
          const result = await client.query(sql, values);
          return { rows: result.rows as Record<string, unknown>[], rowCount: result.rowCount };
        },
        release: () => client.release(),
      };
    },
  };
  const bootstrapStore = new PostgresOperationAuthorityStore(authorityPool, storeOptions);
  await bootstrapStore.initialize();

  // Ephemeral CI-only roles; these credentials never leave the disposable test database.
  const brokerPassword = 'postgres-broker-test-only';
  const verifierPassword = 'postgres-verifier-test-only';
  await pool.query(`
    REVOKE CREATE,TEMPORARY ON DATABASE starlight_test FROM PUBLIC;
    CREATE ROLE starlight_authority_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
    ${usageAuthorityRoutineOwnerGrantSql('starlight_authority_owner')}
    CREATE ROLE starlight_postgres_test_broker LOGIN PASSWORD '${brokerPassword}'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
    GRANT CONNECT,TEMPORARY ON DATABASE starlight_test TO starlight_postgres_test_broker;
    ${brokerDatabaseRoleGrantSql('starlight_postgres_test_broker')}
    CREATE ROLE starlight_postgres_usage_verifier LOGIN PASSWORD '${verifierPassword}'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
    GRANT CONNECT ON DATABASE starlight_test TO starlight_postgres_usage_verifier;
    ${usageEvidenceDatabaseRoleGrantSql('starlight_postgres_usage_verifier')}
  `);
  const connectionFor = (role: string, password: string) => {
    const parsed = new URL(databaseUrl!);
    parsed.username = role;
    parsed.password = password;
    return parsed.toString();
  };
  const brokerRolePool = new Pool({
    connectionString: connectionFor('starlight_postgres_test_broker', brokerPassword), max: 8,
  });
  const verifierRolePool = new Pool({
    connectionString: connectionFor('starlight_postgres_usage_verifier', verifierPassword), max: 8,
  });
  const adaptPool = (rolePool: Pool): AuthoritySqlPool => ({
    connect: async () => {
      const client = await rolePool.connect();
      return {
        query: async (sql, values) => {
          const result = await client.query(sql, values);
          return { rows: result.rows as Record<string, unknown>[], rowCount: result.rowCount };
        },
        release: () => client.release(),
      };
    },
  });
  const brokerRoleAuthorityPool = adaptPool(brokerRolePool);
  const verifierRoleAuthorityPool = adaptPool(verifierRolePool);
  const usageStoreOptions = {
    ...storeOptions,
    usageEvidencePool: verifierRoleAuthorityPool,
  };
  const store = new PostgresOperationAuthorityStore(authorityPool, usageStoreOptions);

  const prepare = async () => {
    currentRunnerLaunchAttemptId = 'postgres-launch-attempt-001';
    currentStartEvidence = undefined;
    currentOutcomeEvidence = undefined;
    currentUsageEvidence = undefined;
    await pool.query(`TRUNCATE swarm_authority_revocations,swarm_authority_hosts,
      swarm_authority_budgets,swarm_authority_prepared_operations,
      swarm_authority_budget_holds,swarm_authority_budget_windows,
      swarm_authority_usage_evidence,swarm_authority_usage_tokens,swarm_authority_heartbeat_tokens,
      swarm_authority_reservations,swarm_authority_audit RESTART IDENTITY`);
    const operation = binding();
    const digest = sha256Digest(operation);
    const now = new Date();
    const expires = new Date(now.getTime() + 10 * 60_000).toISOString();
    const brokerEvidence = {
      schema_version: 'starlight.broker_principal_evidence.v1',
      database_role: 'starlight_postgres_test_broker',
      database_name: 'starlight_test',
      broker_execution_identity: 'postgres-broker-001',
      broker_identity_evidence_ref: 'postgres-broker-evidence-001',
      authn_kind: 'postgres-session-role',
      role_contract_digest_sha256: BROKER_DATABASE_ROLE_CONTRACT_SHA256,
      observed_at: now.toISOString(),
      access_review_expires_at: expires,
      state: 'ready',
    } as const;
    await store.putBrokerPrincipalEvidence(brokerEvidence);
    await store.registerBudgetWindow({
      window_id: `${operation.budget_policy_id}:policy-window`,
      policy_id: operation.budget_policy_id,
      kind: 'policy',
      starts_at: new Date(now.getTime() - 60_000).toISOString(),
      ends_at: new Date(now.getTime() + 15 * 60_000).toISOString(),
      currency: 'USD',
      hard_limit_usd: 0.5,
    });
    await store.registerBudgetWindow({
      window_id: `${operation.budget_policy_id}:daily-window`,
      policy_id: operation.budget_policy_id,
      kind: 'daily',
      starts_at: new Date(now.getTime() - 60_000).toISOString(),
      ends_at: new Date(now.getTime() + 15 * 60_000).toISOString(),
      currency: 'USD',
      hard_limit_usd: 0.5,
    });
    await store.putHostEvidence({
      host_id: operation.host_id,
      observed_at: now.toISOString(),
      status: 'ready',
      capacity_slots: 1,
      secret_readiness: true,
      access_review_expires_at: expires,
      allowed_capabilities: operation.capabilities,
    });
    const approval = signApprovalReceipt({
      schema_version: 'starlight.operation_approval.v1', receipt_id: 'postgres-approval-001',
      issuer: 'postgres-approval', key_id: 'postgres-approval-key', issued_at: now.toISOString(),
      expires_at: expires, binding_digest_sha256: digest, scope: 'admit-bounded-operation',
      allowed_capabilities: operation.capabilities,
    }, approvalSecret);
    const budget = signBudgetReceipt({
      schema_version: 'starlight.operation_budget.v1', receipt_id: 'postgres-budget-001',
      issuer: 'postgres-budget', key_id: 'postgres-budget-key', issued_at: now.toISOString(),
      expires_at: expires, binding_digest_sha256: digest, budget_policy_id: operation.budget_policy_id,
      hard_limit_usd: 0.5,
    }, budgetSecret);
    await store.registerBudget(budget.receipt_id, budget.hard_limit_usd);
    await store.putPreparedOperation(operation.operation_id, digest, now.toISOString());
    const keyring = {
      approvalIssuers: { [approval.issuer]: { [approval.key_id]: approvalSecret } },
      budgetIssuers: { [budget.issuer]: { [budget.key_id]: budgetSecret } },
    };
    const authority = new OperationAuthority(store, keyring);
    const secondAuthority = new OperationAuthority(
      new PostgresOperationAuthorityStore(authorityPool, usageStoreOptions), keyring,
    );
    const admitted = await authority.admit({
      binding: operation,
      approval_receipt: approval,
      budget_receipt: budget,
      reservation_duration_ms: 5 * 60_000,
    });
    if (!admitted.admitted) assert.fail(admitted.blockers.join(' '));
    const tokens = {
      leaseClaim: leaseClaimToken,
      redemption: redemptionToken,
      control: controlToken,
      heartbeat: heartbeatToken,
      startObservation: startObservationToken,
      outcome: outcomeToken,
      usage: usageToken,
    };
    const consume = {
      reservation_id: admitted.reservation.reservation_id,
      operation_id: operation.operation_id,
      effect_id: operation.effect_id,
      binding_digest_sha256: admitted.reservation.binding_digest_sha256,
      execution_identity: operation.execution_identity,
      identity_evidence_ref: operation.identity_evidence_ref,
      consume_token: admitted.reservation.consume_token,
      lease_claim_token: tokens.leaseClaim,
    };
    return {
      authority, secondAuthority, store, brokerEvidence, reservation: admitted.reservation, consume, tokens,
      providerCorrelation: 'postgres-provider-correlation-001',
    };
  };

  const authorize = async (h: Awaited<ReturnType<typeof prepare>>, suffix: string) => {
    const consumed = await h.authority.consume(h.consume);
    assert.equal(consumed.consumed, true);
    if (!consumed.consumed) throw new Error('consume failed');
    const lease = await h.authority.leaseStart({
      reservation_id: h.reservation.reservation_id,
      consumption_id: consumed.receipt.consumption_id,
      start_request_id: `00000000-0000-4000-8000-0000000002${suffix}`,
      operation_id: h.consume.operation_id,
      effect_id: h.consume.effect_id,
      binding_digest_sha256: h.consume.binding_digest_sha256,
      execution_identity: h.consume.execution_identity,
      identity_evidence_ref: h.consume.identity_evidence_ref,
      lease_claim_token: h.tokens.leaseClaim,
      redemption_token: h.tokens.redemption,
      control_token: h.tokens.control,
      broker_execution_identity: 'postgres-broker-001',
      broker_identity_evidence_ref: 'postgres-broker-evidence-001',
      lease_duration_ms: 110_000,
    });
    assert.equal(lease.leased, true);
    if (!lease.leased) throw new Error('lease failed');
    const redeemed = await h.authority.redeemStartAuthorization({
      reservation_id: h.reservation.reservation_id,
      lease_id: lease.receipt.lease_id,
      redemption_request_id: `00000000-0000-4000-8000-0000000003${suffix}`,
      operation_id: h.consume.operation_id,
      effect_id: h.consume.effect_id,
      binding_digest_sha256: h.consume.binding_digest_sha256,
      execution_identity: h.consume.execution_identity,
      identity_evidence_ref: h.consume.identity_evidence_ref,
      redemption_token: h.tokens.redemption,
    });
    assert.equal(redeemed.redeemed, true);
    if (!redeemed.redeemed) throw new Error('redemption failed');
    return {
      claim_request_id: `00000000-0000-4000-8000-0000000004${suffix}`,
      reservation_id: h.reservation.reservation_id,
      redemption_id: redeemed.receipt.redemption_id,
      operation_id: h.consume.operation_id,
      effect_id: h.consume.effect_id,
      binding_digest_sha256: h.consume.binding_digest_sha256,
      control_token: h.tokens.control,
      heartbeat_token: h.tokens.heartbeat,
      start_observation_token: h.tokens.startObservation,
      outcome_token: h.tokens.outcome,
      usage_reconciliation_token: h.tokens.usage,
      provider_usage_correlation_id: h.providerCorrelation,
    };
  };

  const claimForHeartbeat = async (h: Awaited<ReturnType<typeof prepare>>, suffix: string) => {
    currentRunnerLaunchAttemptId = `postgres-launch-attempt-${suffix}`;
    const claimInput = await authorize(h, suffix);
    const claimed = await h.authority.claimRunnerStart(claimInput);
    assert.equal(claimed.claimed, true, claimed.blockers.join(' '));
    if (!claimed.claimed) throw new Error('runner claim failed');
    return {
      heartbeat_request_id: `00000000-0000-4000-8000-0000000005${suffix}`,
      heartbeat_sequence: 1,
      reservation_id: h.reservation.reservation_id,
      claim_id: claimed.receipt.claim_id,
      operation_id: h.consume.operation_id,
      effect_id: h.consume.effect_id,
      binding_digest_sha256: h.consume.binding_digest_sha256,
      heartbeat_token: h.tokens.heartbeat,
      next_heartbeat_token: nextHeartbeatToken,
    };
  };

  const claimForStartObservation = async (h: Awaited<ReturnType<typeof prepare>>, suffix: string) => {
    currentRunnerLaunchAttemptId = `postgres-launch-attempt-${suffix}`;
    const claimInput = await authorize(h, suffix);
    const claimed = await h.authority.claimRunnerStart(claimInput);
    assert.equal(claimed.claimed, true, claimed.blockers.join(' '));
    if (!claimed.claimed) throw new Error('runner claim failed');
    const observedAt = claimed.receipt.accepted_at;
    currentStartEvidence = {
      schema_version: 'starlight.runner_start_evidence.v1',
      reservation_id: h.reservation.reservation_id,
      claim_id: claimed.receipt.claim_id,
      operation_id: h.consume.operation_id,
      effect_id: h.consume.effect_id,
      binding_digest_sha256: h.consume.binding_digest_sha256,
      runner_id: 'postgres-execution-001',
      runner_identity_evidence_ref: 'postgres-identity-evidence-001',
      runner_instance_id: 'postgres-runner-instance-001',
      runtime_id: 'postgres-test-runtime',
      host_id: 'postgres-test-host',
      channel_binding_sha256: '9'.repeat(64),
      launch_attempt_id: currentRunnerLaunchAttemptId,
      fencing_generation: 1,
      process_instance_sha256: 'b'.repeat(64),
      evidence_ref: 'postgres-runtime-start-evidence-001',
      evidence_sha256: 'c'.repeat(64),
      process_started_at: observedAt,
      observed_at: observedAt,
      access_review_expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
      state: 'start-observed',
    };
    return {
      observation_request_id: `00000000-0000-4000-8000-0000000006${suffix}`,
      reservation_id: h.reservation.reservation_id,
      claim_id: claimed.receipt.claim_id,
      operation_id: h.consume.operation_id,
      effect_id: h.consume.effect_id,
      binding_digest_sha256: h.consume.binding_digest_sha256,
      start_observation_token: h.tokens.startObservation,
    };
  };

  const claimForNeverStartedOutcome = async (h: Awaited<ReturnType<typeof prepare>>, suffix: string) => {
    currentRunnerLaunchAttemptId = `postgres-launch-attempt-${suffix}`;
    const claimInput = await authorize(h, suffix);
    const claimed = await h.authority.claimRunnerStart(claimInput);
    assert.equal(claimed.claimed, true, claimed.blockers.join(' '));
    if (!claimed.claimed) throw new Error('runner claim failed');
    const observedAt = claimed.receipt.accepted_at;
    currentOutcomeEvidence = {
      schema_version: 'starlight.runner_outcome_evidence.v1',
      outcome_event_id: `00000000-0000-4000-8000-0000000007${suffix}`,
      outcome_kind: 'never-started',
      reservation_id: h.reservation.reservation_id,
      claim_id: claimed.receipt.claim_id,
      operation_id: h.consume.operation_id,
      effect_id: h.consume.effect_id,
      binding_digest_sha256: h.consume.binding_digest_sha256,
      runner_id: 'postgres-execution-001',
      runner_identity_evidence_ref: 'postgres-identity-evidence-001',
      runner_instance_id: 'postgres-runner-instance-001',
      runtime_id: 'postgres-test-runtime',
      host_id: 'postgres-test-host',
      channel_binding_sha256: '9'.repeat(64),
      launch_attempt_id: currentRunnerLaunchAttemptId,
      fencing_generation: 1,
      process_instance_sha256: null,
      start_observation_id: null,
      start_evidence_ref: null,
      start_evidence_sha256: null,
      process_started_at: null,
      exit_disposition: null,
      evidence_ref: `postgres-outcome-evidence-${suffix}`,
      evidence_sha256: suffix.padStart(64, 'd').slice(-64),
      outcome_at: observedAt,
      observed_at: observedAt,
      access_review_expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
      restart_fenced: true,
      launch_queue_closed: true,
      descendants_quiesced: true,
      remote_stop_confirmed: false,
    };
    return {
      outcome_request_id: `00000000-0000-4000-8000-0000000008${suffix}`,
      reservation_id: h.reservation.reservation_id,
      claim_id: claimed.receipt.claim_id,
      operation_id: h.consume.operation_id,
      effect_id: h.consume.effect_id,
      binding_digest_sha256: h.consume.binding_digest_sha256,
      outcome_token: h.tokens.outcome,
    };
  };

  const settleForUsageEvidence = async (
    h: Awaited<ReturnType<typeof prepare>>,
    suffix: string,
    statementStatus: 'provisional' | 'final' = 'final',
    cumulativeCostUsd = '0.000000',
    evidenceSchemaVersion: RunnerUsageEvidence['schema_version'] = 'starlight.runner_usage_provider_evidence.v1',
  ) => {
    const outcomeRequest = await claimForNeverStartedOutcome(h, suffix);
    const settled = await h.authority.settleRunnerOutcome(outcomeRequest);
    assert.equal(settled.settled, true, settled.blockers.join(' '));
    if (!settled.settled) throw new Error('runner outcome failed');
    const observedAt = settled.receipt.outcome_at;
    currentUsageEvidence = {
      schema_version: evidenceSchemaVersion,
      provider_event_id: `00000000-0000-4000-8000-0000000009${suffix}`,
      reservation_id: h.reservation.reservation_id,
      claim_id: settled.receipt.claim_id,
      outcome_id: settled.receipt.outcome_id,
      operation_id: h.consume.operation_id,
      effect_id: h.consume.effect_id,
      binding_digest_sha256: h.consume.binding_digest_sha256,
      runner_id: 'postgres-execution-001',
      runner_identity_evidence_ref: 'postgres-identity-evidence-001',
      runner_instance_id: 'postgres-runner-instance-001',
      runtime_id: 'postgres-test-runtime',
      host_id: 'postgres-test-host',
      channel_binding_sha256: '9'.repeat(64),
      launch_attempt_id: currentRunnerLaunchAttemptId,
      fencing_generation: 1,
      process_instance_sha256: null,
      provider_id: 'postgres-provider-001',
      provider_account_ref: 'postgres-provider-account-001',
      provider_usage_correlation_id: h.providerCorrelation,
      meter_id: 'provider-cost-usd',
      evidence_ref: `postgres-usage-evidence-${suffix}`,
      evidence_sha256: suffix.padStart(64, 'e').slice(-64),
      usage_started_at: observedAt,
      usage_ended_at: observedAt,
      statement_status: statementStatus,
      statement_finalized_at: statementStatus === 'final' ? observedAt : null,
      observed_at: observedAt,
      access_review_expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
      currency: 'USD',
      cumulative_cost_usd: cumulativeCostUsd,
      authn_kind: 'provider-signed-statement',
      issuer: 'postgres-provider-billing',
      key_id: 'postgres-provider-key-001',
    };
    return {
      usage_request_id: `00000000-0000-4000-8000-000000000a${suffix}`,
      usage_sequence: 1,
      reservation_id: h.reservation.reservation_id,
      claim_id: settled.receipt.claim_id,
      outcome_id: settled.receipt.outcome_id,
      operation_id: h.consume.operation_id,
      effect_id: h.consume.effect_id,
      binding_digest_sha256: h.consume.binding_digest_sha256,
      usage_reconciliation_token: h.tokens.usage,
      next_usage_reconciliation_token: nextUsageToken,
    };
  };

  const admitRelated = async (h: Awaited<ReturnType<typeof prepare>>, suffix: string) => {
    const now = new Date();
    const issuedAt = now.toISOString();
    const expires = new Date(now.getTime() + 10 * 60_000).toISOString();
    await h.store.putHostEvidence({
      host_id: 'postgres-test-host', observed_at: issuedAt, status: 'ready', capacity_slots: 2,
      secret_readiness: true, access_review_expires_at: expires,
      allowed_capabilities: ['repository.read', 'repository.write'],
    });
    const operation: OperationBinding = {
      ...binding(),
      operation_id: `postgres-related-operation-${suffix}`,
      effect_id: `postgres-related-effect-${suffix}`,
      call_id: `postgres-related-call-${suffix}`,
      effect: { ...binding().effect, resource: `repo://frankxai/starlight-swarm/related-${suffix}` },
    };
    const digest = sha256Digest(operation);
    const approval = signApprovalReceipt({
      schema_version: 'starlight.operation_approval.v1', receipt_id: `postgres-related-approval-${suffix}`,
      issuer: 'postgres-approval', key_id: 'postgres-approval-key', issued_at: issuedAt,
      expires_at: expires, binding_digest_sha256: digest, scope: 'admit-bounded-operation',
      allowed_capabilities: operation.capabilities,
    }, approvalSecret);
    const budget = signBudgetReceipt({
      schema_version: 'starlight.operation_budget.v1', receipt_id: `postgres-related-budget-${suffix}`,
      issuer: 'postgres-budget', key_id: 'postgres-budget-key', issued_at: issuedAt,
      expires_at: expires, binding_digest_sha256: digest, budget_policy_id: operation.budget_policy_id,
      hard_limit_usd: 0.5,
    }, budgetSecret);
    await h.store.registerBudget(budget.receipt_id, budget.hard_limit_usd);
    await h.store.putPreparedOperation(operation.operation_id, digest, issuedAt);
    const admitted = await h.authority.admit({
      binding: operation, approval_receipt: approval, budget_receipt: budget,
      reservation_duration_ms: 5 * 60_000,
    });
    assert.equal(admitted.admitted, true, admitted.blockers.join(' '));
    if (!admitted.admitted) throw new Error('related admission failed');
    const tokens = {
      leaseClaim: `related-lease-${suffix}`.padEnd(43, 'l'),
      redemption: `related-redeem-${suffix}`.padEnd(43, 'r'),
      control: `related-control-${suffix}`.padEnd(43, 'c'),
      heartbeat: `related-heartbeat-${suffix}`.padEnd(43, 'h'),
      startObservation: `related-start-${suffix}`.padEnd(43, 's'),
      outcome: `related-outcome-${suffix}`.padEnd(43, 'o'),
      usage: `related-usage-${suffix}`.padEnd(43, 'u'),
    };
    return {
      ...h,
      reservation: admitted.reservation,
      consume: {
        reservation_id: admitted.reservation.reservation_id,
        operation_id: operation.operation_id,
        effect_id: operation.effect_id,
        binding_digest_sha256: admitted.reservation.binding_digest_sha256,
        execution_identity: operation.execution_identity,
        identity_evidence_ref: operation.identity_evidence_ref,
        consume_token: admitted.reservation.consume_token,
        lease_claim_token: tokens.leaseClaim,
      },
      tokens,
      providerCorrelation: `postgres-provider-correlation-${suffix}`,
    };
  };

  try {
    await t.test('duplicate consumers observe one durable transition and one receipt', async () => {
      const h = await prepare();
      const results = await Promise.all(Array.from({ length: 8 }, () => h.authority.consume(h.consume)));
      assert.ok(results.every((result) => result.consumed));
      const ids = results.flatMap((result) => result.consumed ? [result.receipt.consumption_id] : []);
      assert.equal(new Set(ids).size, 1);
      const events = await pool.query("SELECT event FROM swarm_authority_audit WHERE event='consumed'");
      assert.equal(events.rowCount, 1);
    });

    await t.test('independent authorities issue one pre-start lease under competing request ids', async () => {
      const h = await prepare();
      const consumed = await h.authority.consume(h.consume);
      assert.equal(consumed.consumed, true);
      if (!consumed.consumed) return;
      const input = {
        reservation_id: h.reservation.reservation_id,
        consumption_id: consumed.receipt.consumption_id,
        start_request_id: '00000000-0000-4000-8000-000000000201',
        operation_id: h.consume.operation_id,
        effect_id: h.consume.effect_id,
        binding_digest_sha256: h.consume.binding_digest_sha256,
        execution_identity: h.consume.execution_identity,
        identity_evidence_ref: h.consume.identity_evidence_ref,
        lease_claim_token: leaseClaimToken,
        redemption_token: redemptionToken,
        control_token: controlToken,
        broker_execution_identity: 'postgres-broker-001',
        broker_identity_evidence_ref: 'postgres-broker-evidence-001',
        lease_duration_ms: 30_000,
      };
      const [first, second] = await Promise.all([
        h.authority.leaseStart(input),
        h.secondAuthority.leaseStart({
          ...input,
          start_request_id: '00000000-0000-4000-8000-000000000202',
        }),
      ]);
      assert.equal([first, second].filter((result) => result.leased).length, 1);
      assert.equal([first, second].filter((result) => !result.leased).length, 1);
      const state = await pool.query('SELECT state,lease_id FROM swarm_authority_reservations');
      assert.equal(state.rows[0].state, 'leased-not-started');
      assert.ok(state.rows[0].lease_id);
      const events = await pool.query("SELECT event FROM swarm_authority_audit WHERE event='start-lease-issued'");
      assert.equal(events.rowCount, 1);
    });

    await t.test('independent authorities redeem one start authorization and commit ledgers once', async () => {
      const h = await prepare();
      const consumed = await h.authority.consume(h.consume);
      assert.equal(consumed.consumed, true);
      if (!consumed.consumed) return;
      const lease = await h.authority.leaseStart({
        reservation_id: h.reservation.reservation_id,
        consumption_id: consumed.receipt.consumption_id,
        start_request_id: '00000000-0000-4000-8000-000000000211',
        operation_id: h.consume.operation_id,
        effect_id: h.consume.effect_id,
        binding_digest_sha256: h.consume.binding_digest_sha256,
        execution_identity: h.consume.execution_identity,
        identity_evidence_ref: h.consume.identity_evidence_ref,
        lease_claim_token: leaseClaimToken,
        redemption_token: redemptionToken,
        control_token: controlToken,
        broker_execution_identity: 'postgres-broker-001',
        broker_identity_evidence_ref: 'postgres-broker-evidence-001',
        lease_duration_ms: 30_000,
      });
      assert.equal(lease.leased, true);
      if (!lease.leased) return;
      const redemption = {
        reservation_id: h.reservation.reservation_id,
        lease_id: lease.receipt.lease_id,
        redemption_request_id: '00000000-0000-4000-8000-000000000311',
        operation_id: h.consume.operation_id,
        effect_id: h.consume.effect_id,
        binding_digest_sha256: h.consume.binding_digest_sha256,
        execution_identity: h.consume.execution_identity,
        identity_evidence_ref: h.consume.identity_evidence_ref,
        redemption_token: redemptionToken,
      };
      const [first, second] = await Promise.all([
        h.authority.redeemStartAuthorization(redemption),
        h.secondAuthority.redeemStartAuthorization({
          ...redemption,
          redemption_request_id: '00000000-0000-4000-8000-000000000312',
        }),
      ]);
      assert.equal([first, second].filter((result) => result.redeemed).length, 1);
      assert.equal([first, second].filter((result) => !result.redeemed).length, 1);
      const state = await pool.query(`SELECT r.state,b.reserved_usd,b.committed_usd,
        h.reserved_slots,h.authorized_slots
        FROM swarm_authority_reservations r,swarm_authority_budgets b,swarm_authority_hosts h`);
      assert.equal(state.rows[0].state, 'start-authorized-not-observed');
      assert.equal(Number(state.rows[0].reserved_usd), 0);
      assert.equal(Number(state.rows[0].committed_usd), 0.25);
      assert.equal(Number(state.rows[0].reserved_slots), 0);
      assert.equal(Number(state.rows[0].authorized_slots), 1);
      const events = await pool.query("SELECT event FROM swarm_authority_audit WHERE event='start-authority-redeemed'");
      assert.equal(events.rowCount, 1);
    });

    await t.test('competing authenticated runner claims produce one claim transition', async () => {
      const h = await prepare();
      const claim = await authorize(h, '41');
      const [first, second] = await Promise.all([
        h.authority.claimRunnerStart(claim),
        h.secondAuthority.claimRunnerStart({
          ...claim, claim_request_id: '00000000-0000-4000-8000-000000000442',
        }),
      ]);
      assert.equal([first, second].filter((result) => result.claimed).length, 1);
      assert.equal([first, second].filter((result) => !result.claimed).length, 1);
      const state = await pool.query(`SELECT r.state,b.committed_usd,h.authorized_slots
        FROM swarm_authority_reservations r,swarm_authority_budgets b,swarm_authority_hosts h`);
      assert.equal(state.rows[0].state, 'runner-claimed-not-started');
      assert.equal(Number(state.rows[0].committed_usd), 0.25);
      assert.equal(Number(state.rows[0].authorized_slots), 1);
      const events = await pool.query("SELECT event FROM swarm_authority_audit WHERE event='runner-claim-accepted'");
      assert.equal(events.rowCount, 1);
    });

    await t.test('runner claim versus cancellation retains committed authority after either winner', async () => {
      const h = await prepare();
      const claim = await authorize(h, '51');
      await Promise.all([
        h.authority.claimRunnerStart(claim),
        h.secondAuthority.cancel({
          reservation_id: h.reservation.reservation_id,
          cancel_token: h.reservation.cancel_token,
          reason: 'concurrent claim cancellation',
        }),
      ]);
      const state = await pool.query(`SELECT r.state,b.reserved_usd,b.committed_usd,
        h.reserved_slots,h.authorized_slots
        FROM swarm_authority_reservations r,swarm_authority_budgets b,swarm_authority_hosts h`);
      assert.equal(state.rows[0].state, 'stop-requested');
      assert.deepEqual([
        Number(state.rows[0].reserved_usd), Number(state.rows[0].committed_usd),
        Number(state.rows[0].reserved_slots), Number(state.rows[0].authorized_slots),
      ], [0, 0.25, 0, 1]);
    });

    await t.test('runner claim versus broker disable cannot leave active authority under a disabled principal', async () => {
      const h = await prepare();
      const claim = await authorize(h, '61');
      await Promise.all([
        h.authority.claimRunnerStart(claim),
        h.store.putBrokerPrincipalEvidence({ ...h.brokerEvidence, state: 'disabled' as const }),
      ]);
      const state = await pool.query(`SELECT r.state,b.committed_usd,h.authorized_slots
        FROM swarm_authority_reservations r,swarm_authority_budgets b,swarm_authority_hosts h`);
      assert.equal(state.rows[0].state, 'stop-requested');
      assert.equal(Number(state.rows[0].committed_usd), 0.25);
      assert.equal(Number(state.rows[0].authorized_slots), 1);
    });

    await t.test('runner claim versus runner revocation always quarantines committed authority', async () => {
      const h = await prepare();
      const claim = await authorize(h, '71');
      await Promise.all([
        h.authority.claimRunnerStart(claim),
        h.store.revoke('runner:postgres-execution-001', new Date().toISOString(), 'concurrent runner revocation'),
      ]);
      const state = await pool.query(`SELECT r.state,b.reserved_usd,b.committed_usd,
        h.reserved_slots,h.authorized_slots
        FROM swarm_authority_reservations r,swarm_authority_budgets b,swarm_authority_hosts h`);
      assert.equal(state.rows[0].state, 'stop-requested');
      assert.deepEqual([
        Number(state.rows[0].reserved_usd), Number(state.rows[0].committed_usd),
        Number(state.rows[0].reserved_slots), Number(state.rows[0].authorized_slots),
      ], [0, 0.25, 0, 1]);
    });

    await t.test('competing next heartbeats rotate one credential and preserve committed ledgers', async () => {
      const h = await prepare();
      const heartbeat = await claimForHeartbeat(h, '81');
      const [first, second] = await Promise.all([
        h.authority.acceptRunnerHeartbeat(heartbeat),
        h.secondAuthority.acceptRunnerHeartbeat({
          ...heartbeat,
          heartbeat_request_id: '00000000-0000-4000-8000-000000000582',
          next_heartbeat_token: competingHeartbeatToken,
        }),
      ]);
      assert.equal([first, second].filter((result) => result.accepted).length, 1);
      assert.equal([first, second].filter((result) => !result.accepted).length, 1);
      const state = await pool.query(`SELECT r.state,r.runner_heartbeat_sequence,
        b.reserved_usd,b.committed_usd,h.reserved_slots,h.authorized_slots
        FROM swarm_authority_reservations r,swarm_authority_budgets b,swarm_authority_hosts h`);
      assert.equal(state.rows[0].state, 'runner-claimed-not-started');
      assert.equal(Number(state.rows[0].runner_heartbeat_sequence), 1);
      assert.deepEqual([
        Number(state.rows[0].reserved_usd), Number(state.rows[0].committed_usd),
        Number(state.rows[0].reserved_slots), Number(state.rows[0].authorized_slots),
      ], [0, 0.25, 0, 1]);
      const events = await pool.query("SELECT event FROM swarm_authority_audit WHERE event='runner-heartbeat-accepted'");
      assert.equal(events.rowCount, 1);
    });

    await t.test('heartbeat history prevents recycling an earlier credential', async () => {
      const h = await prepare();
      const heartbeat = await claimForHeartbeat(h, '83');
      const first = await h.authority.acceptRunnerHeartbeat(heartbeat);
      assert.equal(first.accepted, true, first.blockers.join(' '));
      const recycled = await h.secondAuthority.acceptRunnerHeartbeat({
        ...heartbeat,
        heartbeat_request_id: '00000000-0000-4000-8000-000000000584',
        heartbeat_sequence: 2,
        heartbeat_token: nextHeartbeatToken,
        next_heartbeat_token: heartbeatToken,
      });
      assert.equal(recycled.accepted, false);
      assert.match(recycled.blockers.join(' '), /already issued/i);
      const history = await pool.query(
        'SELECT sequence,kind FROM swarm_authority_heartbeat_tokens ORDER BY sequence',
      );
      assert.deepEqual(history.rows.map((row) => [Number(row.sequence), row.kind]), [[0, 'claim'], [1, 'heartbeat']]);
    });

    await t.test('heartbeat versus cancellation cannot resurrect committed authority', async () => {
      const h = await prepare();
      const heartbeat = await claimForHeartbeat(h, '91');
      await Promise.all([
        h.authority.acceptRunnerHeartbeat(heartbeat),
        h.secondAuthority.cancel({
          reservation_id: h.reservation.reservation_id,
          cancel_token: h.reservation.cancel_token,
          reason: 'concurrent heartbeat cancellation',
        }),
      ]);
      const state = await pool.query(`SELECT r.state,b.committed_usd,h.authorized_slots
        FROM swarm_authority_reservations r,swarm_authority_budgets b,swarm_authority_hosts h`);
      assert.equal(state.rows[0].state, 'stop-requested');
      assert.equal(Number(state.rows[0].committed_usd), 0.25);
      assert.equal(Number(state.rows[0].authorized_slots), 1);
    });

    await t.test('heartbeat versus broker disable cannot leave active authority', async () => {
      const h = await prepare();
      const heartbeat = await claimForHeartbeat(h, '92');
      await Promise.all([
        h.authority.acceptRunnerHeartbeat(heartbeat),
        h.store.putBrokerPrincipalEvidence({ ...h.brokerEvidence, state: 'disabled' as const }),
      ]);
      const state = await pool.query(`SELECT r.state,b.committed_usd,h.authorized_slots
        FROM swarm_authority_reservations r,swarm_authority_budgets b,swarm_authority_hosts h`);
      assert.equal(state.rows[0].state, 'stop-requested');
      assert.equal(Number(state.rows[0].committed_usd), 0.25);
      assert.equal(Number(state.rows[0].authorized_slots), 1);
    });

    await t.test('heartbeat versus runner revocation cannot leave active authority', async () => {
      const h = await prepare();
      const heartbeat = await claimForHeartbeat(h, '93');
      await Promise.all([
        h.authority.acceptRunnerHeartbeat(heartbeat),
        h.store.revoke('runner:postgres-execution-001', new Date().toISOString(), 'concurrent heartbeat revocation'),
      ]);
      const state = await pool.query(`SELECT r.state,b.committed_usd,h.authorized_slots
        FROM swarm_authority_reservations r,swarm_authority_budgets b,swarm_authority_hosts h`);
      assert.equal(state.rows[0].state, 'stop-requested');
      assert.equal(Number(state.rows[0].committed_usd), 0.25);
      assert.equal(Number(state.rows[0].authorized_slots), 1);
    });

    await t.test('heartbeat versus prepared cancellation cannot leave active authority', async () => {
      const h = await prepare();
      const heartbeat = await claimForHeartbeat(h, '95');
      await Promise.all([
        h.authority.acceptRunnerHeartbeat(heartbeat),
        h.store.cancelPreparedOperation(heartbeat.operation_id),
      ]);
      const state = await pool.query(`SELECT r.state,b.committed_usd,h.authorized_slots
        FROM swarm_authority_reservations r,swarm_authority_budgets b,swarm_authority_hosts h`);
      assert.equal(state.rows[0].state, 'stop-requested');
      assert.equal(Number(state.rows[0].committed_usd), 0.25);
      assert.equal(Number(state.rows[0].authorized_slots), 1);
    });

    await t.test('heartbeat versus degraded host evidence cannot leave active authority', async () => {
      const h = await prepare();
      const heartbeat = await claimForHeartbeat(h, '96');
      const now = Date.now();
      await Promise.all([
        h.authority.acceptRunnerHeartbeat(heartbeat),
        h.store.putHostEvidence({
          host_id: 'postgres-test-host',
          observed_at: new Date(now).toISOString(),
          status: 'degraded',
          capacity_slots: 1,
          secret_readiness: true,
          access_review_expires_at: new Date(now + 10 * 60_000).toISOString(),
          allowed_capabilities: ['repository.read', 'repository.write'],
        }),
      ]);
      const state = await pool.query(`SELECT r.state,b.committed_usd,h.authorized_slots
        FROM swarm_authority_reservations r,swarm_authority_budgets b,swarm_authority_hosts h`);
      assert.equal(state.rows[0].state, 'stop-requested');
      assert.equal(Number(state.rows[0].committed_usd), 0.25);
      assert.equal(Number(state.rows[0].authorized_slots), 1);
    });

    await t.test('heartbeat versus expiry reconciliation cannot resurrect expired authority', async () => {
      const h = await prepare();
      const heartbeat = await claimForHeartbeat(h, '94');
      await pool.query(`UPDATE swarm_authority_reservations SET
        runner_claim_accepted_at=clock_timestamp()-INTERVAL '70 seconds',
        runner_evidence_observed_at=clock_timestamp()-INTERVAL '61 seconds',
        runner_access_review_expires_at=clock_timestamp()+INTERVAL '1 minute',
        runner_claim_expires_at=clock_timestamp()-INTERVAL '1 second'`);
      await Promise.all([
        h.authority.acceptRunnerHeartbeat(heartbeat),
        h.secondAuthority.reconcileRunnerHeartbeatExpiry({
          reservation_id: heartbeat.reservation_id,
          claim_id: heartbeat.claim_id,
          operation_id: heartbeat.operation_id,
          binding_digest_sha256: heartbeat.binding_digest_sha256,
        }),
      ]);
      const state = await pool.query(`SELECT r.state,b.committed_usd,h.authorized_slots
        FROM swarm_authority_reservations r,swarm_authority_budgets b,swarm_authority_hosts h`);
      assert.equal(state.rows[0].state, 'stop-requested');
      assert.equal(Number(state.rows[0].committed_usd), 0.25);
      assert.equal(Number(state.rows[0].authorized_slots), 1);
    });

    await t.test('competing start observations produce one durable transition and one receipt', async () => {
      const h = await prepare();
      const observation = await claimForStartObservation(h, '01');
      const [first, second] = await Promise.all([
        h.authority.observeRunnerStart(observation),
        h.secondAuthority.observeRunnerStart({
          ...observation,
          observation_request_id: '00000000-0000-4000-8000-000000000602',
        }),
      ]);
      assert.equal([first, second].filter((result) => result.observed).length, 1, JSON.stringify([first, second]));
      assert.equal([first, second].filter((result) => !result.observed).length, 1);
      const state = await pool.query(`SELECT r.state,b.committed_usd,h.authorized_slots
        FROM swarm_authority_reservations r,swarm_authority_budgets b,swarm_authority_hosts h`);
      assert.equal(state.rows[0].state, 'runner-start-observed');
      assert.equal(Number(state.rows[0].committed_usd), 0.25);
      assert.equal(Number(state.rows[0].authorized_slots), 1);
      const events = await pool.query("SELECT event FROM swarm_authority_audit WHERE event='runner-start-observed'");
      assert.equal(events.rowCount, 1);
    });

    await t.test('start observation versus heartbeat renewal stays observed or conservatively requests stop', async () => {
      const h = await prepare();
      const observation = await claimForStartObservation(h, '05');
      const heartbeat = {
        heartbeat_request_id: '00000000-0000-4000-8000-000000000505',
        heartbeat_sequence: 1,
        reservation_id: observation.reservation_id,
        claim_id: observation.claim_id,
        operation_id: observation.operation_id,
        effect_id: observation.effect_id,
        binding_digest_sha256: observation.binding_digest_sha256,
        heartbeat_token: heartbeatToken,
        next_heartbeat_token: nextHeartbeatToken,
      };
      const results = await Promise.all([
        h.authority.observeRunnerStart(observation),
        h.secondAuthority.acceptRunnerHeartbeat(heartbeat),
      ]);
      const state = await pool.query(`SELECT r.state,b.committed_usd,h.authorized_slots
        FROM swarm_authority_reservations r,swarm_authority_budgets b,swarm_authority_hosts h`);
      assert.ok(['runner-start-observed', 'stop-requested'].includes(String(state.rows[0].state)),
        JSON.stringify({ results, state: state.rows[0].state }));
      assert.equal(Number(state.rows[0].committed_usd), 0.25);
      assert.equal(Number(state.rows[0].authorized_slots), 1);
    });

    await t.test('start observation versus heartbeat expiry always retains committed authority', async () => {
      const h = await prepare();
      const observation = await claimForStartObservation(h, '06');
      await pool.query(`UPDATE swarm_authority_reservations SET
        runner_claim_accepted_at=clock_timestamp()-INTERVAL '70 seconds',
        runner_evidence_observed_at=clock_timestamp()-INTERVAL '61 seconds',
        runner_access_review_expires_at=clock_timestamp()+INTERVAL '1 minute',
        runner_claim_expires_at=clock_timestamp()-INTERVAL '1 second'`);
      await Promise.all([
        h.authority.observeRunnerStart(observation),
        h.secondAuthority.reconcileRunnerHeartbeatExpiry({
          reservation_id: observation.reservation_id,
          claim_id: observation.claim_id,
          operation_id: observation.operation_id,
          binding_digest_sha256: observation.binding_digest_sha256,
        }),
      ]);
      const state = await pool.query(`SELECT r.state,b.committed_usd,h.authorized_slots
        FROM swarm_authority_reservations r,swarm_authority_budgets b,swarm_authority_hosts h`);
      assert.equal(state.rows[0].state, 'stop-requested');
      assert.equal(Number(state.rows[0].committed_usd), 0.25);
      assert.equal(Number(state.rows[0].authorized_slots), 1);
    });

    await t.test('start observation versus cancellation cannot release committed authority', async () => {
      const h = await prepare();
      const observation = await claimForStartObservation(h, '11');
      await Promise.all([
        h.authority.observeRunnerStart(observation),
        h.secondAuthority.cancel({
          reservation_id: h.reservation.reservation_id,
          cancel_token: h.reservation.cancel_token,
          reason: 'concurrent start-observation cancellation',
        }),
      ]);
      const state = await pool.query(`SELECT r.state,b.committed_usd,h.authorized_slots
        FROM swarm_authority_reservations r,swarm_authority_budgets b,swarm_authority_hosts h`);
      assert.equal(state.rows[0].state, 'stop-requested');
      assert.equal(Number(state.rows[0].committed_usd), 0.25);
      assert.equal(Number(state.rows[0].authorized_slots), 1);
    });

    await t.test('start observation versus broker disable cannot leave active authority', async () => {
      const h = await prepare();
      const observation = await claimForStartObservation(h, '21');
      await Promise.all([
        h.authority.observeRunnerStart(observation),
        h.store.putBrokerPrincipalEvidence({ ...h.brokerEvidence, state: 'disabled' as const }),
      ]);
      const state = await pool.query(`SELECT r.state,b.committed_usd,h.authorized_slots
        FROM swarm_authority_reservations r,swarm_authority_budgets b,swarm_authority_hosts h`);
      assert.equal(state.rows[0].state, 'stop-requested');
      assert.equal(Number(state.rows[0].committed_usd), 0.25);
      assert.equal(Number(state.rows[0].authorized_slots), 1);
    });

    await t.test('start observation versus runner revocation cannot leave active authority', async () => {
      const h = await prepare();
      const observation = await claimForStartObservation(h, '31');
      await Promise.all([
        h.authority.observeRunnerStart(observation),
        h.store.revoke('runner:postgres-execution-001', new Date().toISOString(), 'concurrent start revocation'),
      ]);
      const state = await pool.query(`SELECT r.state,b.committed_usd,h.authorized_slots
        FROM swarm_authority_reservations r,swarm_authority_budgets b,swarm_authority_hosts h`);
      assert.equal(state.rows[0].state, 'stop-requested');
      assert.equal(Number(state.rows[0].committed_usd), 0.25);
      assert.equal(Number(state.rows[0].authorized_slots), 1);
    });

    await t.test('start observation versus preparation cancellation cannot leave active authority', async () => {
      const h = await prepare();
      const observation = await claimForStartObservation(h, '41');
      await Promise.all([
        h.authority.observeRunnerStart(observation),
        h.store.cancelPreparedOperation(observation.operation_id),
      ]);
      const state = await pool.query(`SELECT r.state,b.committed_usd,h.authorized_slots
        FROM swarm_authority_reservations r,swarm_authority_budgets b,swarm_authority_hosts h`);
      assert.equal(state.rows[0].state, 'stop-requested');
      assert.equal(Number(state.rows[0].committed_usd), 0.25);
      assert.equal(Number(state.rows[0].authorized_slots), 1);
    });

    await t.test('start observation versus degraded host cannot leave active authority', async () => {
      const h = await prepare();
      const observation = await claimForStartObservation(h, '51');
      const now = Date.now();
      await Promise.all([
        h.authority.observeRunnerStart(observation),
        h.store.putHostEvidence({
          host_id: 'postgres-test-host',
          observed_at: new Date(now).toISOString(),
          status: 'degraded',
          capacity_slots: 1,
          secret_readiness: true,
          access_review_expires_at: new Date(now + 10 * 60_000).toISOString(),
          allowed_capabilities: ['repository.read', 'repository.write'],
        }),
      ]);
      const state = await pool.query(`SELECT r.state,b.committed_usd,h.authorized_slots
        FROM swarm_authority_reservations r,swarm_authority_budgets b,swarm_authority_hosts h`);
      assert.equal(state.rows[0].state, 'stop-requested');
      assert.equal(Number(state.rows[0].committed_usd), 0.25);
      assert.equal(Number(state.rows[0].authorized_slots), 1);
    });

    await t.test('duplicate never-started settlement retains capacity and committed spend', async () => {
      const h = await prepare();
      const outcome = await claimForNeverStartedOutcome(h, '71');
      const results = await Promise.all([
        h.authority.settleRunnerOutcome(outcome),
        h.secondAuthority.settleRunnerOutcome(outcome),
      ]);
      assert.ok(results.every((result) => result.settled));
      const state = await pool.query(`SELECT r.state,b.committed_usd,h.authorized_slots
        FROM swarm_authority_reservations r,swarm_authority_budgets b,swarm_authority_hosts h`);
      assert.equal(state.rows[0].state, 'runner-never-started-observed');
      assert.equal(Number(state.rows[0].committed_usd), 0.25);
      assert.equal(Number(state.rows[0].authorized_slots), 1);
      const events = await pool.query("SELECT event FROM swarm_authority_audit WHERE event='runner-outcome-observed'");
      assert.equal(events.rowCount, 1);
    });

    await t.test('never-started outcome versus delayed start observation never double-releases', async () => {
      const h = await prepare();
      const outcome = await claimForNeverStartedOutcome(h, '72');
      const observedAt = new Date().toISOString();
      currentStartEvidence = {
        schema_version: 'starlight.runner_start_evidence.v1',
        reservation_id: h.reservation.reservation_id,
        claim_id: outcome.claim_id,
        operation_id: outcome.operation_id,
        effect_id: outcome.effect_id,
        binding_digest_sha256: outcome.binding_digest_sha256,
        runner_id: 'postgres-execution-001',
        runner_identity_evidence_ref: 'postgres-identity-evidence-001',
        runner_instance_id: 'postgres-runner-instance-001',
        runtime_id: 'postgres-test-runtime',
        host_id: 'postgres-test-host',
        channel_binding_sha256: '9'.repeat(64),
        launch_attempt_id: currentRunnerLaunchAttemptId,
        fencing_generation: 1,
        process_instance_sha256: 'b'.repeat(64),
        evidence_ref: 'postgres-runtime-start-evidence-72',
        evidence_sha256: 'e'.repeat(64),
        process_started_at: observedAt,
        observed_at: observedAt,
        access_review_expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
        state: 'start-observed',
      };
      await Promise.all([
        h.authority.settleRunnerOutcome(outcome),
        h.secondAuthority.observeRunnerStart({
          observation_request_id: '00000000-0000-4000-8000-000000000672',
          reservation_id: outcome.reservation_id,
          claim_id: outcome.claim_id,
          operation_id: outcome.operation_id,
          effect_id: outcome.effect_id,
          binding_digest_sha256: outcome.binding_digest_sha256,
          start_observation_token: startObservationToken,
        }),
      ]);
      const state = await pool.query(`SELECT r.state,b.committed_usd,h.authorized_slots
        FROM swarm_authority_reservations r,swarm_authority_budgets b,swarm_authority_hosts h`);
      assert.ok(['stop-requested', 'runner-start-observed'].includes(String(state.rows[0].state)));
      assert.equal(Number(state.rows[0].committed_usd), 0.25);
      assert.equal(Number(state.rows[0].authorized_slots), 1);
    });

    await t.test('outcome settlement versus broker disable retains conservative resources', async () => {
      const h = await prepare();
      const outcome = await claimForNeverStartedOutcome(h, '73');
      await Promise.all([
        h.authority.settleRunnerOutcome(outcome),
        h.store.putBrokerPrincipalEvidence({ ...h.brokerEvidence, state: 'disabled' as const }),
      ]);
      const state = await pool.query(`SELECT r.state,b.committed_usd,h.authorized_slots
        FROM swarm_authority_reservations r,swarm_authority_budgets b,swarm_authority_hosts h`);
      assert.ok(['runner-never-started-observed', 'stop-requested'].includes(String(state.rows[0].state)));
      assert.equal(Number(state.rows[0].committed_usd), 0.25);
      assert.equal(Number(state.rows[0].authorized_slots), 1);
    });

    await t.test('duplicate provider usage evidence records one immutable event and releases no budget', async () => {
      const h = await prepare();
      const usage = await settleForUsageEvidence(
        h, '74', 'final', '0.000000000001', 'starlight.runner_usage_provider_evidence.v2',
      );
      const results = await Promise.all([
        h.authority.recordRunnerUsageEvidence(usage),
        h.secondAuthority.recordRunnerUsageEvidence(usage),
      ]);
      assert.ok(results.every((result) => result.recorded));
      const ids = results.flatMap((result) => result.recorded ? [result.receipt.usage_evidence_id] : []);
      assert.equal(new Set(ids).size, 1);
      const state = await pool.query(`SELECT b.committed_usd,h.authorized_slots
        FROM swarm_authority_budgets b,swarm_authority_hosts h`);
      assert.equal(Number(state.rows[0].committed_usd), 0.25);
      assert.equal(Number(state.rows[0].authorized_slots), 1);
      const evidence = await pool.query(`SELECT usage_sequence,evidence_schema_version,
        cumulative_cost_usd::text AS cumulative_cost_usd FROM swarm_authority_usage_evidence`);
      assert.deepEqual(evidence.rows.map((row) => [Number(row.usage_sequence), row.evidence_schema_version,
        row.cumulative_cost_usd]), [[1, 'starlight.runner_usage_provider_evidence.v2', '0.000000000001']]);
      const events = await pool.query("SELECT event FROM swarm_authority_audit WHERE event='runner-usage-evidence-observed'");
      assert.equal(events.rowCount, 1);
    });

    await t.test('real broker and no-table verifier roles serialize append without privilege escape', async () => {
      const h = await prepare();
      const usage = await settleForUsageEvidence(h, '80');
      const realOptions = { runnerUsageEvidenceAttestor, usageEvidencePool: verifierRoleAuthorityPool };
      const first = new PostgresOperationAuthorityStore(brokerRoleAuthorityPool, realOptions);
      const second = new PostgresOperationAuthorityStore(brokerRoleAuthorityPool, realOptions);

      await assert.rejects(
        brokerRolePool.query("SELECT public.starlight_append_runner_usage_evidence('{}'::jsonb)"),
        /permission denied/i,
      );
      await assert.rejects(
        verifierRolePool.query('SELECT * FROM swarm_authority_reservations'),
        /permission denied/i,
      );
      await assert.rejects(
        verifierRolePool.query(`UPDATE swarm_authority_reservations
          SET usage_reconciliation_token_sha256=repeat('f',64) WHERE FALSE`),
        /permission denied/i,
      );

      const directDenied = await verifierRolePool.query(
        `SELECT public.starlight_append_runner_usage_evidence('{}'::jsonb) AS result`,
      );
      assert.equal(directDenied.rows[0]?.result?.ok, false);
      assert.equal(directDenied.rows[0]?.result?.audited, true);
      const directAudit = await pool.query(
        `SELECT detail FROM swarm_authority_audit
          WHERE event='runner-usage-evidence-denied' ORDER BY seq DESC LIMIT 1`,
      );
      const database = await pool.query('SELECT current_database() AS name');
      assert.deepEqual(directAudit.rows[0]?.detail, {
        reservation_id: null,
        usage_request_id: null,
        blockers: ['Runner usage-evidence append input is invalid.'],
        direct_function_refusal: true,
        authenticated_database_role: 'starlight_postgres_usage_verifier',
        authenticated_database_name: database.rows[0]?.name,
        released_cost_usd: '0.000000',
      });

      const results = await Promise.all([
        first.recordRunnerUsageEvidence(usage),
        second.recordRunnerUsageEvidence(usage),
      ]);
      assert.ok(results.every((result) => result.recorded),
        results.flatMap((result) => result.blockers).join(' '));
      const ids = results.flatMap((result) => result.recorded ? [result.receipt.usage_evidence_id] : []);
      assert.equal(new Set(ids).size, 1);
      const evidence = await pool.query('SELECT usage_sequence FROM swarm_authority_usage_evidence');
      assert.deepEqual(evidence.rows.map((row) => Number(row.usage_sequence)), [1]);

      const wrongToken = await first.recordRunnerUsageEvidence({
        ...usage, usage_reconciliation_token: competingUsageToken,
      });
      assert.equal(wrongToken.recorded, false);
      assert.match(wrongToken.blockers.join(' '), /retry drifted|credential is invalid/i);
      const state = await pool.query(`SELECT b.committed_usd,h.authorized_slots
        FROM swarm_authority_budgets b,swarm_authority_hosts h`);
      assert.deepEqual([Number(state.rows[0].committed_usd), Number(state.rows[0].authorized_slots)], [0.25, 1]);
    });

    await t.test('real verifier attestation rejects a system-catalog relation grant', async () => {
      let client: PoolClient | undefined;
      let grantApplied = false;
      try {
        await pool.query('GRANT SELECT ON pg_catalog.pg_authid TO starlight_postgres_usage_verifier');
        grantApplied = true;
        client = await verifierRolePool.connect();
        const attestation = await attestUsageEvidenceDatabaseSession({
          query: async (sql, values) => {
            assert.ok(client);
            const result = await client.query(sql, values);
            return { rows: result.rows as Record<string, unknown>[] };
          },
        });
        assert.equal(attestation.valid, false);
        assert.match(attestation.blockers.join(' '), /non-default system-relation or sequence authority/i);
      } finally {
        try {
          client?.release();
        } finally {
          if (grantApplied) {
            await pool.query('REVOKE SELECT ON pg_catalog.pg_authid FROM starlight_postgres_usage_verifier');
          }
        }
      }
    });

    await t.test('real verifier attestation rejects system-schema CREATE authority', async () => {
      let client: PoolClient | undefined;
      try {
        await pool.query('GRANT CREATE ON SCHEMA pg_catalog TO starlight_postgres_usage_verifier');
        client = await verifierRolePool.connect();
        const attestation = await attestUsageEvidenceDatabaseSession({
          query: async (sql, values) => {
            assert.ok(client);
            const result = await client.query(sql, values);
            return { rows: result.rows as Record<string, unknown>[] };
          },
        });
        assert.equal(attestation.valid, false);
        assert.match(attestation.blockers.join(' '), /must not access schemas outside the public verifier boundary/i);
      } finally {
        try {
          client?.release();
        } finally {
          await pool.query('REVOKE CREATE ON SCHEMA pg_catalog FROM starlight_postgres_usage_verifier');
        }
      }
    });

    await t.test('usage evidence versus broker disable never releases committed authority', async () => {
      const h = await prepare();
      const usage = await settleForUsageEvidence(h, '75');
      const [recorded] = await Promise.all([
        h.authority.recordRunnerUsageEvidence(usage),
        h.store.putBrokerPrincipalEvidence({ ...h.brokerEvidence, state: 'disabled' as const }),
      ]);
      assert.ok(recorded.recorded || recorded.blockers.length > 0);
      const state = await pool.query(`SELECT r.state,b.committed_usd,h.authorized_slots
        FROM swarm_authority_reservations r,swarm_authority_budgets b,swarm_authority_hosts h`);
      assert.ok(['runner-never-started-observed', 'stop-requested'].includes(String(state.rows[0].state)));
      assert.equal(Number(state.rows[0].committed_usd), 0.25);
      assert.equal(Number(state.rows[0].authorized_slots), 1);
      const evidence = await pool.query('SELECT usage_evidence_id FROM swarm_authority_usage_evidence');
      assert.ok(evidence.rowCount === 0 || evidence.rowCount === 1);
    });

    await t.test('competing final provider statements accept one sequence-two transition', async () => {
      const h = await prepare();
      const first = await settleForUsageEvidence(h, '76', 'provisional');
      const recordedFirst = await h.authority.recordRunnerUsageEvidence(first);
      assert.equal(recordedFirst.recorded, true, recordedFirst.blockers.join(' '));
      if (!recordedFirst.recorded || !currentUsageEvidence) return;
      const finalizedAt = new Date().toISOString();
      currentUsageEvidence = {
        ...currentUsageEvidence,
        provider_event_id: '00000000-0000-4000-8000-000000000b76',
        evidence_ref: 'postgres-usage-evidence-76-final',
        evidence_sha256: 'f'.repeat(62) + '76',
        statement_status: 'final',
        statement_finalized_at: finalizedAt,
        observed_at: finalizedAt,
      };
      const second = {
        ...first,
        usage_request_id: '00000000-0000-4000-8000-000000000a77',
        usage_sequence: 2,
        usage_reconciliation_token: nextUsageToken,
        next_usage_reconciliation_token: secondNextUsageToken,
      };
      const results = await Promise.all([
        h.authority.recordRunnerUsageEvidence(second),
        h.secondAuthority.recordRunnerUsageEvidence({
          ...second,
          usage_request_id: '00000000-0000-4000-8000-000000000a78',
          next_usage_reconciliation_token: competingUsageToken,
        }),
      ]);
      assert.equal(results.filter((result) => result.recorded).length, 1);
      const evidence = await pool.query('SELECT usage_sequence,statement_status FROM swarm_authority_usage_evidence ORDER BY usage_sequence');
      assert.deepEqual(evidence.rows.map((row) => [Number(row.usage_sequence), row.statement_status]),
        [[1, 'provisional'], [2, 'final']]);
      const state = await pool.query('SELECT committed_usd FROM swarm_authority_budgets');
      assert.equal(Number(state.rows[0].committed_usd), 0.25);
    });

    await t.test('final overage is retained as a breach and cannot release any commitment', async () => {
      const h = await prepare();
      const usage = await settleForUsageEvidence(h, '77', 'final', '0.300000');
      const recorded = await h.authority.recordRunnerUsageEvidence(usage);
      assert.equal(recorded.recorded, true, recorded.blockers.join(' '));
      if (!recorded.recorded) return;
      assert.equal(recorded.receipt.budget_breach_observed, true);
      const state = await pool.query(`SELECT b.committed_usd,w.committed_usd AS window_committed,
        h.authorized_slots FROM swarm_authority_budgets b
        CROSS JOIN swarm_authority_budget_windows w CROSS JOIN swarm_authority_hosts h`);
      assert.ok(state.rows.every((row) => Number(row.committed_usd) === 0.25
        && Number(row.window_committed) === 0.25 && Number(row.authorized_slots) === 1));
      const breach = await pool.query("SELECT event FROM swarm_authority_audit WHERE event='runner-usage-budget-breach'");
      assert.equal(breach.rowCount, 1);
    });

    await t.test('usage evidence versus cancellation retains committed authority in every interleaving', async () => {
      const h = await prepare();
      const usage = await settleForUsageEvidence(h, '78');
      await Promise.all([
        h.authority.recordRunnerUsageEvidence(usage),
        h.secondAuthority.cancel({
          reservation_id: h.reservation.reservation_id,
          cancel_token: h.reservation.cancel_token,
          reason: 'usage evidence cancellation race',
        }),
      ]);
      const state = await pool.query(`SELECT b.committed_usd,w.committed_usd AS window_committed,
        h.authorized_slots FROM swarm_authority_budgets b
        CROSS JOIN swarm_authority_budget_windows w CROSS JOIN swarm_authority_hosts h`);
      assert.ok(state.rows.every((row) => Number(row.committed_usd) === 0.25
        && Number(row.window_committed) === 0.25 && Number(row.authorized_slots) === 1));
    });

    await t.test('usage evidence versus runner revocation cannot release committed authority', async () => {
      const h = await prepare();
      const usage = await settleForUsageEvidence(h, '79');
      await Promise.all([
        h.authority.recordRunnerUsageEvidence(usage),
        h.store.revoke('runner:postgres-execution-001', new Date().toISOString(), 'usage evidence race'),
      ]);
      const state = await pool.query(`SELECT r.state,b.committed_usd,w.committed_usd AS window_committed,
        h.authorized_slots FROM swarm_authority_reservations r CROSS JOIN swarm_authority_budgets b
        CROSS JOIN swarm_authority_budget_windows w CROSS JOIN swarm_authority_hosts h`);
      assert.ok(state.rows.every((row) => Number(row.committed_usd) === 0.25
        && Number(row.window_committed) === 0.25 && Number(row.authorized_slots) === 1));
      assert.ok(['runner-never-started-observed', 'stop-requested'].includes(String(state.rows[0].state)));
    });

    await t.test('cross-reservation evidence and credential replay fail closed', async () => {
      const h = await prepare();
      const firstUsage = await settleForUsageEvidence(h, '80');
      const firstRecorded = await h.authority.recordRunnerUsageEvidence(firstUsage);
      assert.equal(firstRecorded.recorded, true, firstRecorded.blockers.join(' '));
      if (!firstRecorded.recorded || !currentUsageEvidence) return;
      const firstEvidence = currentUsageEvidence;

      const related = await admitRelated(h, '02');
      const secondUsage = await settleForUsageEvidence(related, '81');
      assert.ok(currentUsageEvidence);
      if (!currentUsageEvidence) return;
      const secondEvidence = currentUsageEvidence;
      currentUsageEvidence = {
        ...secondEvidence,
        provider_event_id: firstEvidence.provider_event_id,
        evidence_ref: firstEvidence.evidence_ref,
        evidence_sha256: firstEvidence.evidence_sha256,
      };
      const duplicateEvidence = await related.authority.recordRunnerUsageEvidence({
        ...secondUsage,
        next_usage_reconciliation_token: `related-next-02`.padEnd(43, 'n'),
      });
      assert.equal(duplicateEvidence.recorded, false);
      assert.match(duplicateEvidence.blockers.join(' '), /already bound/i);

      currentUsageEvidence = secondEvidence;
      const recycledCredential = await related.authority.recordRunnerUsageEvidence(secondUsage);
      assert.equal(recycledCredential.recorded, false);
      assert.match(recycledCredential.blockers.join(' '), /already issued/i);
      const state = await pool.query(`SELECT SUM(committed_usd) AS committed FROM swarm_authority_budgets`);
      assert.equal(Number(state.rows[0].committed), 0.5);
      const evidence = await pool.query('SELECT reservation_id FROM swarm_authority_usage_evidence');
      assert.equal(evidence.rowCount, 1);
    });

    await t.test('redemption versus cancellation has only released or quarantined outcomes', async () => {
      const h = await prepare();
      const consumed = await h.authority.consume(h.consume);
      assert.equal(consumed.consumed, true);
      if (!consumed.consumed) return;
      const lease = await h.authority.leaseStart({
        reservation_id: h.reservation.reservation_id,
        consumption_id: consumed.receipt.consumption_id,
        start_request_id: '00000000-0000-4000-8000-000000000221',
        operation_id: h.consume.operation_id,
        effect_id: h.consume.effect_id,
        binding_digest_sha256: h.consume.binding_digest_sha256,
        execution_identity: h.consume.execution_identity,
        identity_evidence_ref: h.consume.identity_evidence_ref,
        lease_claim_token: leaseClaimToken,
        redemption_token: redemptionToken,
        control_token: controlToken,
        broker_execution_identity: 'postgres-broker-001',
        broker_identity_evidence_ref: 'postgres-broker-evidence-001',
        lease_duration_ms: 30_000,
      });
      assert.equal(lease.leased, true);
      if (!lease.leased) return;
      await Promise.all([
        h.authority.redeemStartAuthorization({
          reservation_id: h.reservation.reservation_id,
          lease_id: lease.receipt.lease_id,
          redemption_request_id: '00000000-0000-4000-8000-000000000321',
          operation_id: h.consume.operation_id,
          effect_id: h.consume.effect_id,
          binding_digest_sha256: h.consume.binding_digest_sha256,
          execution_identity: h.consume.execution_identity,
          identity_evidence_ref: h.consume.identity_evidence_ref,
          redemption_token: redemptionToken,
        }),
        h.secondAuthority.cancel({
          reservation_id: h.reservation.reservation_id,
          cancel_token: h.reservation.cancel_token,
          reason: 'concurrent cancellation',
        }),
      ]);
      const state = await pool.query(`SELECT r.state,b.reserved_usd,b.committed_usd,
        h.reserved_slots,h.authorized_slots
        FROM swarm_authority_reservations r,swarm_authority_budgets b,swarm_authority_hosts h`);
      if (state.rows[0].state === 'cancelled') {
        assert.deepEqual([
          Number(state.rows[0].reserved_usd), Number(state.rows[0].committed_usd),
          Number(state.rows[0].reserved_slots), Number(state.rows[0].authorized_slots),
        ], [0, 0, 0, 0]);
      } else {
        assert.equal(state.rows[0].state, 'stop-requested');
        assert.deepEqual([
          Number(state.rows[0].reserved_usd), Number(state.rows[0].committed_usd),
          Number(state.rows[0].reserved_slots), Number(state.rows[0].authorized_slots),
        ], [0, 0.25, 0, 1]);
      }
    });

    await t.test('broker disable versus redemption has only reserved or quarantined outcomes', async () => {
      const h = await prepare();
      const consumed = await h.authority.consume(h.consume);
      assert.equal(consumed.consumed, true);
      if (!consumed.consumed) return;
      const lease = await h.authority.leaseStart({
        reservation_id: h.reservation.reservation_id,
        consumption_id: consumed.receipt.consumption_id,
        start_request_id: '00000000-0000-4000-8000-000000000231',
        operation_id: h.consume.operation_id,
        effect_id: h.consume.effect_id,
        binding_digest_sha256: h.consume.binding_digest_sha256,
        execution_identity: h.consume.execution_identity,
        identity_evidence_ref: h.consume.identity_evidence_ref,
        lease_claim_token: leaseClaimToken,
        redemption_token: redemptionToken,
        control_token: controlToken,
        broker_execution_identity: 'postgres-broker-001',
        broker_identity_evidence_ref: 'postgres-broker-evidence-001',
        lease_duration_ms: 30_000,
      });
      assert.equal(lease.leased, true);
      if (!lease.leased) return;
      await Promise.all([
        h.authority.redeemStartAuthorization({
          reservation_id: h.reservation.reservation_id,
          lease_id: lease.receipt.lease_id,
          redemption_request_id: '00000000-0000-4000-8000-000000000331',
          operation_id: h.consume.operation_id,
          effect_id: h.consume.effect_id,
          binding_digest_sha256: h.consume.binding_digest_sha256,
          execution_identity: h.consume.execution_identity,
          identity_evidence_ref: h.consume.identity_evidence_ref,
          redemption_token: redemptionToken,
        }),
        h.store.putBrokerPrincipalEvidence({ ...h.brokerEvidence, state: 'disabled' }),
      ]);
      const state = await pool.query(`SELECT r.state,b.reserved_usd,b.committed_usd,
        host.reserved_slots,host.authorized_slots
        FROM swarm_authority_reservations r,swarm_authority_budgets b,swarm_authority_hosts host`);
      if (state.rows[0].state === 'leased-not-started') {
        assert.deepEqual([
          Number(state.rows[0].reserved_usd), Number(state.rows[0].committed_usd),
          Number(state.rows[0].reserved_slots), Number(state.rows[0].authorized_slots),
        ], [0.25, 0, 1, 0]);
      } else {
        assert.equal(state.rows[0].state, 'stop-requested');
        assert.deepEqual([
          Number(state.rows[0].reserved_usd), Number(state.rows[0].committed_usd),
          Number(state.rows[0].reserved_slots), Number(state.rows[0].authorized_slots),
        ], [0, 0.25, 0, 1]);
      }
    });

    await t.test('lease versus prepared cancellation always ends cancelled with one release', async () => {
      const h = await prepare();
      const consumed = await h.authority.consume(h.consume);
      assert.equal(consumed.consumed, true);
      if (!consumed.consumed) return;
      const lease = {
        reservation_id: h.reservation.reservation_id,
        consumption_id: consumed.receipt.consumption_id,
        start_request_id: '00000000-0000-4000-8000-000000000203',
        operation_id: h.consume.operation_id,
        effect_id: h.consume.effect_id,
        binding_digest_sha256: h.consume.binding_digest_sha256,
        execution_identity: h.consume.execution_identity,
        identity_evidence_ref: h.consume.identity_evidence_ref,
        lease_claim_token: leaseClaimToken,
        redemption_token: redemptionToken,
        control_token: controlToken,
        broker_execution_identity: 'postgres-broker-001',
        broker_identity_evidence_ref: 'postgres-broker-evidence-001',
        lease_duration_ms: 30_000,
      };
      await Promise.all([
        h.secondAuthority.leaseStart(lease),
        store.cancelPreparedOperation(h.consume.operation_id),
      ]);
      const state = await pool.query(`SELECT r.state,b.reserved_usd,h.reserved_slots
        FROM swarm_authority_reservations r,swarm_authority_budgets b,swarm_authority_hosts h`);
      assert.equal(state.rows[0].state, 'cancelled');
      assert.equal(Number(state.rows[0].reserved_usd), 0);
      assert.equal(Number(state.rows[0].reserved_slots), 0);
      const windows = await pool.query('SELECT reserved_usd FROM swarm_authority_budget_windows');
      assert.ok(windows.rows.every((row) => Number(row.reserved_usd) === 0));
      const cancellations = await pool.query("SELECT event FROM swarm_authority_audit WHERE event='reservation-cancelled'");
      assert.equal(cancellations.rowCount, 1);
    });

    await t.test('consume versus cancel resolves to a cancelled tombstone with one release', async () => {
      const h = await prepare();
      await Promise.all([
        h.authority.consume(h.consume),
        h.authority.cancel({
          reservation_id: h.reservation.reservation_id,
          cancel_token: h.reservation.cancel_token,
          reason: 'race cancellation',
        }),
      ]);
      const state = await pool.query(`SELECT r.state,b.reserved_usd,h.reserved_slots
        FROM swarm_authority_reservations r,swarm_authority_budgets b,swarm_authority_hosts h`);
      assert.equal(state.rows[0].state, 'cancelled');
      assert.equal(Number(state.rows[0].reserved_usd), 0);
      assert.equal(Number(state.rows[0].reserved_slots), 0);
      const cancellations = await pool.query("SELECT event FROM swarm_authority_audit WHERE event='reservation-cancelled'");
      assert.equal(cancellations.rowCount, 1);
    });

    await t.test('consume versus revoke remains serialized and revocation invalidates the non-started result', async () => {
      const h = await prepare();
      await Promise.all([
        h.authority.consume(h.consume),
        store.revoke('key:postgres-approval:postgres-approval-key', new Date().toISOString(), 'race revocation'),
      ]);
      const state = await pool.query(`SELECT r.state,b.reserved_usd,h.reserved_slots
        FROM swarm_authority_reservations r,swarm_authority_budgets b,swarm_authority_hosts h`);
      assert.equal(state.rows[0].state, 'cancelled');
      assert.equal(Number(state.rows[0].reserved_usd), 0);
      assert.equal(Number(state.rows[0].reserved_slots), 0);
      const cancellations = await pool.query("SELECT event FROM swarm_authority_audit WHERE event='reservation-cancelled'");
      assert.equal(cancellations.rowCount, 1);
    });

    await t.test('independent authorities cannot oversubscribe shared policy and daily windows', async () => {
      await pool.query(`TRUNCATE swarm_authority_revocations,swarm_authority_hosts,
        swarm_authority_budgets,swarm_authority_prepared_operations,
        swarm_authority_budget_holds,swarm_authority_budget_windows,
        swarm_authority_usage_evidence,swarm_authority_usage_tokens,swarm_authority_heartbeat_tokens,
        swarm_authority_reservations,swarm_authority_audit RESTART IDENTITY`);
      const now = new Date();
      const issuedAt = now.toISOString();
      const expires = new Date(now.getTime() + 10 * 60_000).toISOString();
      const startsAt = new Date(now.getTime() - 60_000).toISOString();
      const endsAt = new Date(now.getTime() + 15 * 60_000).toISOString();
      const base = binding();
      await store.registerBudgetWindow({
        window_id: 'postgres-policy-window', policy_id: base.budget_policy_id, kind: 'policy',
        starts_at: startsAt, ends_at: endsAt, currency: 'USD', hard_limit_usd: 0.75,
      });
      await store.registerBudgetWindow({
        window_id: 'postgres-daily-window', policy_id: base.budget_policy_id, kind: 'daily',
        starts_at: startsAt, ends_at: endsAt, currency: 'USD', hard_limit_usd: 0.5,
      });
      await store.putHostEvidence({
        host_id: base.host_id, observed_at: issuedAt, status: 'ready', capacity_slots: 4,
        secret_readiness: true, access_review_expires_at: expires,
        allowed_capabilities: base.capabilities,
      });
      const secondStore = new PostgresOperationAuthorityStore(authorityPool, usageStoreOptions);
      const authorities = [store, secondStore].map((authorityStore) => new OperationAuthority(authorityStore, {
        approvalIssuers: { 'postgres-approval': { 'postgres-approval-key': approvalSecret } },
        budgetIssuers: { 'postgres-budget': { 'postgres-budget-key': budgetSecret } },
      }));
      const inputs = [];
      for (let index = 1; index <= 3; index += 1) {
        const operation: OperationBinding = {
          ...base,
          operation_id: `postgres-aggregate-operation-00${index}`,
          effect_id: `postgres-aggregate-effect-00${index}`,
          call_id: `postgres-aggregate-call-00${index}`,
          effect: { ...base.effect, resource: `repo://frankxai/starlight-swarm/race-fixture-${index}` },
        };
        const digest = sha256Digest(operation);
        const approval = signApprovalReceipt({
          schema_version: 'starlight.operation_approval.v1', receipt_id: `postgres-aggregate-approval-00${index}`,
          issuer: 'postgres-approval', key_id: 'postgres-approval-key', issued_at: issuedAt,
          expires_at: expires, binding_digest_sha256: digest, scope: 'admit-bounded-operation',
          allowed_capabilities: operation.capabilities,
        }, approvalSecret);
        const budget = signBudgetReceipt({
          schema_version: 'starlight.operation_budget.v1', receipt_id: `postgres-aggregate-budget-00${index}`,
          issuer: 'postgres-budget', key_id: 'postgres-budget-key', issued_at: issuedAt,
          expires_at: expires, binding_digest_sha256: digest, budget_policy_id: operation.budget_policy_id,
          hard_limit_usd: 0.5,
        }, budgetSecret);
        await store.registerBudget(budget.receipt_id, budget.hard_limit_usd);
        await store.putPreparedOperation(operation.operation_id, digest, issuedAt);
        inputs.push({
          binding: operation, approval_receipt: approval, budget_receipt: budget,
          reservation_duration_ms: 5 * 60_000,
        });
      }
      const results = await Promise.all(inputs.map((input, index) => authorities[index % 2].admit(input)));
      assert.equal(results.filter((result) => result.admitted).length, 2);
      const denied = results.filter((result) => !result.admitted);
      assert.equal(denied.length, 1);
      assert.match(denied[0].blockers.join(' '), /aggregate budget window is exhausted/i);
      const ledgers = await pool.query(`SELECT kind,reserved_usd FROM swarm_authority_budget_windows ORDER BY kind`);
      assert.deepEqual(ledgers.rows.map((row) => [row.kind, Number(row.reserved_usd)]), [['daily', 0.5], ['policy', 0.5]]);
      const host = await pool.query('SELECT reserved_slots FROM swarm_authority_hosts');
      assert.equal(Number(host.rows[0].reserved_slots), 2);

      const admitted = results.flatMap((result) => result.admitted ? [result.reservation] : []);
      await Promise.all(admitted.map((reservation, index) => authorities[index % 2].cancel({
        reservation_id: reservation.reservation_id,
        cancel_token: reservation.cancel_token,
        reason: 'aggregate race cleanup',
      })));
      const released = await pool.query('SELECT kind,reserved_usd FROM swarm_authority_budget_windows ORDER BY kind');
      assert.deepEqual(released.rows.map((row) => [row.kind, Number(row.reserved_usd)]), [['daily', 0], ['policy', 0]]);
      const releasedHost = await pool.query('SELECT reserved_slots FROM swarm_authority_hosts');
      assert.equal(Number(releasedHost.rows[0].reserved_slots), 0);
    });
  } finally {
    await brokerRolePool.end();
    await verifierRolePool.end();
    await pool.end();
  }
});
