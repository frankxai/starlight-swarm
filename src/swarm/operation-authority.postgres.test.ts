import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Pool } from 'pg';

import { OperationAuthority, signApprovalReceipt, signBudgetReceipt, type OperationBinding } from './operation-authority';
import { PostgresOperationAuthorityStore, type AuthoritySqlPool } from './postgres-operation-authority';
import { sha256Digest } from './runtime-digest';

const databaseUrl = process.env.TEST_DATABASE_URL;
const approvalSecret = 'postgres-approval-secret-at-least-32-bytes';
const budgetSecret = 'postgres-budget-secret-at-least-32-bytes';
const leaseClaimToken = 'L'.repeat(43);

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
      swarm_authority_budget_holds,swarm_authority_budget_windows,
      swarm_authority_reservations,swarm_authority_audit RESTART IDENTITY`);
    const operation = binding();
    const digest = sha256Digest(operation);
    const now = new Date();
    const expires = new Date(now.getTime() + 10 * 60_000).toISOString();
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
    const secondAuthority = new OperationAuthority(new PostgresOperationAuthorityStore(authorityPool), keyring);
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
    return { authority, secondAuthority, reservation: admitted.reservation, consume };
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
      const secondStore = new PostgresOperationAuthorityStore(authorityPool);
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
