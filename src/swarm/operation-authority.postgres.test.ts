import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Pool } from 'pg';

import { OperationAuthority, signApprovalReceipt, signBudgetReceipt, type OperationBinding } from './operation-authority';
import { PostgresOperationAuthorityStore, type AuthoritySqlPool } from './postgres-operation-authority';
import { sha256Digest } from './runtime-digest';

const databaseUrl = process.env.TEST_DATABASE_URL;
const approvalSecret = 'postgres-approval-secret-at-least-32-bytes';
const budgetSecret = 'postgres-budget-secret-at-least-32-bytes';

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
  const store = new PostgresOperationAuthorityStore(authorityPool);
  await store.initialize();

  const prepare = async () => {
    await pool.query(`TRUNCATE swarm_authority_revocations,swarm_authority_hosts,
      swarm_authority_budgets,swarm_authority_prepared_operations,
      swarm_authority_reservations,swarm_authority_audit RESTART IDENTITY`);
    const operation = binding();
    const digest = sha256Digest(operation);
    const now = new Date();
    const expires = new Date(now.getTime() + 10 * 60_000).toISOString();
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
    const authority = new OperationAuthority(store, {
      approvalIssuers: { [approval.issuer]: { [approval.key_id]: approvalSecret } },
      budgetIssuers: { [budget.issuer]: { [budget.key_id]: budgetSecret } },
    });
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
    };
    return { authority, reservation: admitted.reservation, consume };
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
  } finally {
    await pool.end();
  }
});
