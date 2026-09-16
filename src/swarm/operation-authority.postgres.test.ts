import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Pool } from 'pg';

import { OperationAuthority, signApprovalReceipt, signBudgetReceipt, type OperationBinding } from './operation-authority';
import {
  PostgresOperationAuthorityStore,
  type AuthoritySqlPool,
  type RunnerSessionAttestor,
} from './postgres-operation-authority';
import { sha256Digest } from './runtime-digest';
import {
  BROKER_DATABASE_ROLE_CONTRACT_SHA256,
  type BrokerDatabaseSessionAttestor,
} from './authority-role-contract';

const databaseUrl = process.env.TEST_DATABASE_URL;
const approvalSecret = 'postgres-approval-secret-at-least-32-bytes';
const budgetSecret = 'postgres-budget-secret-at-least-32-bytes';
const leaseClaimToken = 'L'.repeat(43);
const redemptionToken = 'R'.repeat(43);
const controlToken = 'C'.repeat(43);
const heartbeatToken = 'H'.repeat(43);
const nextHeartbeatToken = 'N'.repeat(43);
const competingHeartbeatToken = 'M'.repeat(43);
const brokerSessionAttestor: BrokerDatabaseSessionAttestor = async () => ({
  valid: true,
  session: {
    database_role: 'starlight_postgres_test_broker',
    database_name: 'starlight_postgres_test',
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
      observed_at: new Date(now).toISOString(),
      access_review_expires_at: new Date(now + 10 * 60_000).toISOString(),
    },
    blockers: [],
  };
};
const storeOptions = { brokerSessionAttestor, runnerSessionAttestor };

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
  const store = new PostgresOperationAuthorityStore(authorityPool, storeOptions);
  await store.initialize();

  const prepare = async () => {
    await pool.query(`TRUNCATE swarm_authority_revocations,swarm_authority_hosts,
      swarm_authority_budgets,swarm_authority_prepared_operations,
      swarm_authority_budget_holds,swarm_authority_budget_windows,
      swarm_authority_heartbeat_tokens,
      swarm_authority_reservations,swarm_authority_audit RESTART IDENTITY`);
    const operation = binding();
    const digest = sha256Digest(operation);
    const now = new Date();
    const expires = new Date(now.getTime() + 10 * 60_000).toISOString();
    const brokerEvidence = {
      schema_version: 'starlight.broker_principal_evidence.v1',
      database_role: 'starlight_postgres_test_broker',
      database_name: 'starlight_postgres_test',
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
    const secondAuthority = new OperationAuthority(new PostgresOperationAuthorityStore(authorityPool, storeOptions), keyring);
    const admitted = await authority.admit({
      binding: operation,
      approval_receipt: approval,
      budget_receipt: budget,
      reservation_duration_ms: 5 * 60_000,
    });
    if (!admitted.admitted) assert.fail(admitted.blockers.join(' '));
    const consume = {
      reservation_id: admitted.reservation.reservation_id,
      operation_id: operation.operation_id,
      effect_id: operation.effect_id,
      binding_digest_sha256: admitted.reservation.binding_digest_sha256,
      execution_identity: operation.execution_identity,
      identity_evidence_ref: operation.identity_evidence_ref,
      consume_token: admitted.reservation.consume_token,
      lease_claim_token: leaseClaimToken,
    };
    return { authority, secondAuthority, store, brokerEvidence, reservation: admitted.reservation, consume };
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
      lease_claim_token: leaseClaimToken,
      redemption_token: redemptionToken,
      control_token: controlToken,
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
      redemption_token: redemptionToken,
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
      control_token: controlToken,
      heartbeat_token: heartbeatToken,
    };
  };

  const claimForHeartbeat = async (h: Awaited<ReturnType<typeof prepare>>, suffix: string) => {
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
      heartbeat_token: heartbeatToken,
      next_heartbeat_token: nextHeartbeatToken,
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
      const secondStore = new PostgresOperationAuthorityStore(authorityPool, storeOptions);
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
    await pool.end();
  }
});
