import assert from 'node:assert/strict';
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
} from './postgres-operation-authority';
import { sha256Digest } from './runtime-digest';

const NOW_MS = Date.now();
const NOW = new Date(NOW_MS).toISOString();
const EXPIRES = new Date(NOW_MS + 10 * 60_000).toISOString();
const APPROVAL_SECRET = 'approval-secret-at-least-32-bytes-long';
const BUDGET_SECRET = 'budget-secret-at-least-32-bytes-long';

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

async function harness(operation = binding()) {
  const pool = new PGlitePool();
  const store = new PostgresOperationAuthorityStore(pool);
  await store.initialize();
  await store.putHostEvidence({
    host_id: operation.host_id,
    observed_at: NOW,
    status: 'ready',
    capacity_slots: 2,
    secret_readiness: true,
    access_review_expires_at: EXPIRES,
    allowed_capabilities: ['repository.read', 'repository.write'],
  });
  const digest = sha256Digest(operation);
  const approval = signApprovalReceipt({
    schema_version: 'starlight.operation_approval.v1',
    receipt_id: 'approval-001',
    issuer: 'starlight-approval',
    key_id: 'approval-key-001',
    issued_at: NOW,
    expires_at: EXPIRES,
    binding_digest_sha256: digest,
    scope: 'admit-bounded-operation',
    allowed_capabilities: ['repository.read', 'repository.write'],
  }, APPROVAL_SECRET);
  const budget = signBudgetReceipt({
    schema_version: 'starlight.operation_budget.v1',
    receipt_id: 'budget-001',
    issuer: 'starlight-budget',
    key_id: 'budget-key-001',
    issued_at: NOW,
    expires_at: EXPIRES,
    binding_digest_sha256: digest,
    budget_policy_id: operation.budget_policy_id,
    hard_limit_usd: 0.5,
  }, BUDGET_SECRET);
  await store.registerBudget(budget.receipt_id, budget.hard_limit_usd);
  await store.putPreparedOperation(operation.operation_id, digest, NOW);
  const authority = new OperationAuthority(store, {
    approvalIssuers: { [approval.issuer]: { [approval.key_id]: APPROVAL_SECRET } },
    budgetIssuers: { [budget.issuer]: { [budget.key_id]: BUDGET_SECRET } },
  }, 5 * 60_000, () => NOW);
  return { pool, store, authority, operation, approval, budget };
}

type Harness = Awaited<ReturnType<typeof harness>>;

async function reserve(h: Harness, duration = 60_000) {
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
  };
}

function cancellation(reservation: Awaited<ReturnType<typeof reserve>>, reason: string) {
  return {
    reservation_id: reservation.reservation_id,
    cancel_token: reservation.cancel_token,
    reason,
  };
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
    assert.deepEqual(audits.map((row) => row.event), ['reserved', 'denied', 'denied']);
  } finally { await h.pool.close(); }
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
    assert.deepEqual(audit.map((row) => row.event), ['reserved', 'consume-denied', 'consumed']);
    assert.doesNotMatch(JSON.stringify(audit), new RegExp(reservation.consume_token));
  } finally { await h.pool.close(); }
});

test('consume binds the durable execution identity and preserves the reservation after a denial', async () => {
  const h = await harness();
  try {
    const reservation = await reserve(h);
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
      const replay = await h.authority.admit({
        binding: h.operation,
        approval_receipt: h.approval,
        budget_receipt: h.budget,
        reservation_duration_ms: 60_000,
      });
      assert.equal(replay.admitted, false);
      assert.match(replay.blockers.join(' '), /already reserved/i);
    } finally { await h.pool.close(); }
  });

  await t.test('prepared-operation cancellation invalidates an existing consumption receipt before worker start', async () => {
    const h = await harness();
    try {
      const reservation = await reserve(h);
      const consumed = await h.authority.consume(consumption(h, reservation));
      assert.equal(consumed.consumed, true);
      await h.store.cancelPreparedOperation(h.operation.operation_id);
      const denied = await h.authority.consume(consumption(h, reservation));
      assert.equal(denied.consumed, false);
      assert.match(denied.blockers.join(' '), /cancelled before worker start/i);
      const rows = await h.pool.rows(`SELECT r.state,b.reserved_usd,h.reserved_slots
        FROM swarm_authority_reservations r,swarm_authority_budgets b,swarm_authority_hosts h`);
      assert.equal(rows[0].state, 'cancelled');
      assert.equal(Number(rows[0].reserved_usd), 0);
      assert.equal(Number(rows[0].reserved_slots), 0);
    } finally { await h.pool.close(); }
  });
});

test('cancellation releases a reserved or consumed hold exactly once', async (t) => {
  for (const consumeFirst of [false, true]) {
    await t.test(consumeFirst ? 'consumed-not-started' : 'reserved-not-started', async () => {
      const h = await harness();
      try {
        const reservation = await reserve(h);
        if (consumeFirst) assert.equal((await h.authority.consume(consumption(h, reservation))).consumed, true);
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
        const audit = await h.pool.rows('SELECT detail FROM swarm_authority_audit ORDER BY seq');
        assert.doesNotMatch(JSON.stringify(audit), new RegExp(reservation.cancel_token));
      } finally { await h.pool.close(); }
    });
  }
});
