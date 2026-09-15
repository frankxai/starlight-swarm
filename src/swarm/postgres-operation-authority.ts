import { createHash, randomUUID } from 'node:crypto';

import { cancellationInputSchema, consumptionInputSchema, operationBindingSchema } from './operation-authority';
import type {
  AdmissionReservation,
  AdmissionResult,
  AtomicAdmissionRequest,
  CancellationInput,
  CancellationResult,
  ConsumptionInput,
  ConsumptionReceipt,
  ConsumptionResult,
  OperationAuthorityStore,
  TrustedHostEvidence,
} from './operation-authority';
import { z } from 'zod';

const controlId = z.string().min(3).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const controlTime = z.iso.datetime({ offset: true });
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

export const OPERATION_AUTHORITY_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS swarm_authority_revocations (
  ref TEXT PRIMARY KEY, revoked_at TIMESTAMPTZ NOT NULL, reason TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS swarm_authority_control (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO swarm_authority_control (singleton) VALUES (TRUE) ON CONFLICT (singleton) DO NOTHING;
CREATE TABLE IF NOT EXISTS swarm_authority_hosts (
  host_id TEXT PRIMARY KEY, evidence JSONB NOT NULL, observed_at TIMESTAMPTZ NOT NULL,
  capacity_slots INTEGER NOT NULL CHECK (capacity_slots >= 0),
  reserved_slots INTEGER NOT NULL DEFAULT 0 CHECK (reserved_slots >= 0)
);
CREATE TABLE IF NOT EXISTS swarm_authority_budgets (
  receipt_id TEXT PRIMARY KEY, hard_limit_usd NUMERIC NOT NULL CHECK (hard_limit_usd >= 0),
  reserved_usd NUMERIC NOT NULL DEFAULT 0 CHECK (reserved_usd >= 0)
);
CREATE TABLE IF NOT EXISTS swarm_authority_prepared_operations (
  operation_id TEXT PRIMARY KEY, binding_digest_sha256 CHAR(64) NOT NULL,
  registered_at TIMESTAMPTZ NOT NULL, state TEXT NOT NULL CHECK (state IN ('ready','cancelled'))
);
CREATE TABLE IF NOT EXISTS swarm_authority_reservations (
  reservation_id UUID PRIMARY KEY, operation_id TEXT NOT NULL UNIQUE, effect_id TEXT NOT NULL UNIQUE,
  binding_digest_sha256 CHAR(64) NOT NULL, binding JSONB NOT NULL, revocation_refs JSONB NOT NULL,
  consume_token_sha256 CHAR(64) NOT NULL, cancel_token_sha256 CHAR(64) NOT NULL,
  approval_receipt_id TEXT NOT NULL,
  budget_receipt_id TEXT NOT NULL, host_id TEXT NOT NULL, reserved_cost_usd NUMERIC NOT NULL,
  reserved_at TIMESTAMPTZ NOT NULL, reservation_expires_at TIMESTAMPTZ NOT NULL,
  max_host_evidence_age_ms INTEGER NOT NULL CHECK (max_host_evidence_age_ms BETWEEN 1000 AND 3600000),
  consumption_id UUID UNIQUE, consumed_at TIMESTAMPTZ,
  state TEXT NOT NULL CHECK (state IN ('reserved-not-started','consumed-not-started','cancelled','expired'))
);
CREATE TABLE IF NOT EXISTS swarm_authority_audit (
  seq BIGSERIAL PRIMARY KEY, event TEXT NOT NULL CHECK (event IN ('admitted','reserved','denied','revoked','cancelled','consumed','consume-denied','reservation-cancelled','expired')),
  operation_id TEXT NOT NULL, binding_digest_sha256 CHAR(64) NOT NULL,
  at TIMESTAMPTZ NOT NULL, detail JSONB NOT NULL
);

-- Upgrade the earlier, never-deployed PR #24 reservation-only schema. Its rows
-- cannot be safely consumed because no bearer digest or durable binding exists,
-- so they are cancelled as replay tombstones and their per-receipt holds released.
ALTER TABLE swarm_authority_hosts ADD COLUMN IF NOT EXISTS capacity_slots INTEGER;
ALTER TABLE swarm_authority_hosts ADD COLUMN IF NOT EXISTS reserved_slots INTEGER;
ALTER TABLE swarm_authority_reservations ADD COLUMN IF NOT EXISTS binding JSONB;
ALTER TABLE swarm_authority_reservations ADD COLUMN IF NOT EXISTS revocation_refs JSONB;
ALTER TABLE swarm_authority_reservations ADD COLUMN IF NOT EXISTS consume_token_sha256 CHAR(64);
ALTER TABLE swarm_authority_reservations ADD COLUMN IF NOT EXISTS cancel_token_sha256 CHAR(64);
ALTER TABLE swarm_authority_reservations ADD COLUMN IF NOT EXISTS max_host_evidence_age_ms INTEGER;
ALTER TABLE swarm_authority_reservations ADD COLUMN IF NOT EXISTS consumption_id UUID;
ALTER TABLE swarm_authority_reservations ADD COLUMN IF NOT EXISTS consumed_at TIMESTAMPTZ;

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

ALTER TABLE swarm_authority_hosts ALTER COLUMN capacity_slots SET NOT NULL;
ALTER TABLE swarm_authority_hosts ALTER COLUMN reserved_slots SET DEFAULT 0;
ALTER TABLE swarm_authority_hosts ALTER COLUMN reserved_slots SET NOT NULL;
ALTER TABLE swarm_authority_hosts DROP CONSTRAINT IF EXISTS swarm_authority_hosts_capacity_slots_check;
ALTER TABLE swarm_authority_hosts ADD CONSTRAINT swarm_authority_hosts_capacity_slots_check CHECK (capacity_slots >= 0);
ALTER TABLE swarm_authority_hosts DROP CONSTRAINT IF EXISTS swarm_authority_hosts_reserved_slots_check;
ALTER TABLE swarm_authority_hosts ADD CONSTRAINT swarm_authority_hosts_reserved_slots_check CHECK (reserved_slots >= 0);
ALTER TABLE swarm_authority_reservations ALTER COLUMN binding SET NOT NULL;
ALTER TABLE swarm_authority_reservations ALTER COLUMN revocation_refs SET NOT NULL;
ALTER TABLE swarm_authority_reservations ALTER COLUMN consume_token_sha256 SET NOT NULL;
ALTER TABLE swarm_authority_reservations ALTER COLUMN cancel_token_sha256 SET NOT NULL;
ALTER TABLE swarm_authority_reservations ALTER COLUMN max_host_evidence_age_ms SET NOT NULL;
ALTER TABLE swarm_authority_reservations ADD CONSTRAINT swarm_authority_reservations_state_check
  CHECK (state IN ('reserved-not-started','consumed-not-started','cancelled','expired'));
ALTER TABLE swarm_authority_audit DROP CONSTRAINT IF EXISTS swarm_authority_audit_event_check;
ALTER TABLE swarm_authority_audit ADD CONSTRAINT swarm_authority_audit_event_check
  CHECK (event IN ('admitted','reserved','denied','revoked','cancelled','consumed','consume-denied','reservation-cancelled','expired'));
`;

interface SqlResult { rows: Record<string, unknown>[]; rowCount?: number | null }
export interface AuthoritySqlClient {
  query(sql: string, values?: unknown[]): Promise<SqlResult>;
  release?(): void;
}
export interface AuthoritySqlPool { connect(): Promise<AuthoritySqlClient> }

function denial(blocker: string): AdmissionResult {
  return { admitted: false, reservation: null, blockers: [blocker] };
}

function consumptionDenied(blocker: string): ConsumptionResult {
  return { consumed: false, receipt: null, blockers: [blocker] };
}

function cancellationDenied(
  reservationId: string,
  blocker: string,
  state: null | 'expired' = null,
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

function hostEvidence(row: Record<string, unknown> | undefined): TrustedHostEvidence | null {
  const parsed = hostEvidenceSchema.safeParse(row?.evidence);
  return parsed.success ? parsed.data : null;
}

async function lockAuthority(client: AuthoritySqlClient): Promise<boolean> {
  const control = await client.query(
    'SELECT singleton FROM swarm_authority_control WHERE singleton=TRUE FOR UPDATE',
  );
  return control.rows.length === 1;
}

async function wallClock(client: AuthoritySqlClient): Promise<string> {
  // Unlike transaction_timestamp()/NOW(), this advances while a transaction waits for a lock.
  const result = await client.query('SELECT clock_timestamp() AS now');
  return sqlInstant(result.rows[0]?.now);
}

/** PostgreSQL is the concurrency boundary; every mutable admission check runs in one transaction. */
export class PostgresOperationAuthorityStore implements OperationAuthorityStore {
  readonly durable = true;
  constructor(private readonly pool: AuthoritySqlPool) {}

  async initialize(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(OPERATION_AUTHORITY_MIGRATION_SQL);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release?.(); }
  }

  async putHostEvidence(evidence: TrustedHostEvidence): Promise<void> {
    const trusted = hostEvidenceSchema.parse(evidence);
    const client = await this.pool.connect();
    try {
      await client.query(
        `INSERT INTO swarm_authority_hosts (host_id,evidence,observed_at,capacity_slots,reserved_slots)
         VALUES ($1,$2::jsonb,$3::timestamptz,$4,0)
         ON CONFLICT (host_id) DO UPDATE SET evidence=EXCLUDED.evidence,
         observed_at=EXCLUDED.observed_at, capacity_slots=EXCLUDED.capacity_slots`,
        [trusted.host_id, JSON.stringify(trusted), trusted.observed_at, trusted.capacity_slots],
      );
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
    try {
      await client.query('BEGIN');
      if (!await lockAuthority(client)) throw new Error('Authority serialization control row is missing or ambiguous.');
      const prepared = await client.query(
        'SELECT binding_digest_sha256 FROM swarm_authority_prepared_operations WHERE operation_id=$1 FOR UPDATE',
        [operationId],
      );
      if (!prepared.rows[0]) throw new Error('Prepared operation does not exist.');
      await client.query(
        `UPDATE swarm_authority_prepared_operations SET state='cancelled' WHERE operation_id=$1`,
        [operationId],
      );
      await client.query(
        `INSERT INTO swarm_authority_audit (event,operation_id,binding_digest_sha256,at,detail)
         VALUES ('cancelled',$1,$2,$3::timestamptz,$4::jsonb)`,
        [operationId, prepared.rows[0].binding_digest_sha256, await wallClock(client), JSON.stringify({ reason: 'control-plane cancellation' })],
      );
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release?.(); }
  }

  async revoke(ref: string, at: string, reason: string): Promise<void> {
    z.string().min(5).max(500).parse(ref);
    controlTime.parse(at);
    z.string().min(1).max(1_000).parse(reason);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (!await lockAuthority(client)) throw new Error('Authority serialization control row is missing or ambiguous.');
      const transactionAt = await wallClock(client);
      await client.query(
        `INSERT INTO swarm_authority_revocations (ref,revoked_at,reason) VALUES ($1,$2::timestamptz,$3)
         ON CONFLICT (ref) DO NOTHING`, [ref, transactionAt, reason],
      );
      const affected = await client.query(
        `SELECT reservation_id,operation_id,binding_digest_sha256,budget_receipt_id,host_id,reserved_cost_usd,state
         FROM swarm_authority_reservations
         WHERE state IN ('reserved-not-started','consumed-not-started')
           AND revocation_refs @> jsonb_build_array($1::text)
         FOR UPDATE`,
        [ref],
      );
      for (const row of affected.rows) {
        const transitioned = await client.query(
          `UPDATE swarm_authority_reservations SET state='cancelled'
           WHERE reservation_id=$1::uuid AND state IN ('reserved-not-started','consumed-not-started')
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
      await client.query(
        `INSERT INTO swarm_authority_audit (event,operation_id,binding_digest_sha256,at,detail)
         VALUES ('revoked','control-plane',$1,$2::timestamptz,$3::jsonb)`,
        ['0'.repeat(64), transactionAt, JSON.stringify({ ref, requested_at: at, reason })],
      );
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release?.(); }
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

  private async releaseResources(
    client: AuthoritySqlClient,
    row: Record<string, unknown>,
  ): Promise<number> {
    const cost = Number(row.reserved_cost_usd);
    if (!Number.isFinite(cost) || cost < 0) throw new Error('Reservation cost ledger is invalid.');
    const budget = await client.query(
      `UPDATE swarm_authority_budgets SET reserved_usd=reserved_usd-$2
       WHERE receipt_id=$1 AND reserved_usd >= $2 RETURNING reserved_usd`,
      [row.budget_receipt_id, cost],
    );
    if (budget.rows.length !== 1) throw new Error('Budget release would underflow or references a missing receipt.');
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
      if (!await lockAuthority(client)) return await deny('Authority serialization control row is missing or ambiguous.');
      at = await wallClock(client);
      const nowMs = Date.parse(at);
      const found = await client.query(
        `SELECT reservation_id,operation_id,effect_id,binding_digest_sha256,binding,revocation_refs,
                approval_receipt_id,budget_receipt_id,host_id,reserved_cost_usd,
                reservation_expires_at,max_host_evidence_age_ms,state,consumption_id,consumed_at
         FROM swarm_authority_reservations
         WHERE reservation_id=$1::uuid AND consume_token_sha256=$2 FOR UPDATE`,
        [request.reservation_id, createHash('sha256').update(request.consume_token, 'utf8').digest('hex')],
      );
      const row = found.rows[0];
      if (!row) return await deny('Reservation does not exist.');
      if (row.operation_id !== request.operation_id || row.effect_id !== request.effect_id || row.binding_digest_sha256 !== request.binding_digest_sha256) {
        return await deny('Consumption request does not match the reserved operation and effect.');
      }
      const binding = operationBindingSchema.safeParse(row.binding);
      if (!binding.success || binding.data.execution_identity !== request.execution_identity || binding.data.identity_evidence_ref !== request.identity_evidence_ref) {
        return await deny('Consumption identity does not match the reserved binding.');
      }
      if (row.state === 'cancelled' || row.state === 'expired') return await deny(`Reservation is ${row.state}.`);
      if (row.state !== 'reserved-not-started' && row.state !== 'consumed-not-started') return await deny('Reservation state is invalid.');

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
        const receipt: ConsumptionReceipt = {
          schema_version: 'starlight.operation_consumption.v1',
          consumption_id: row.consumption_id,
          reservation_id: request.reservation_id,
          operation_id: request.operation_id,
          effect_id: request.effect_id,
          binding_digest_sha256: request.binding_digest_sha256,
          execution_identity: request.execution_identity,
          identity_evidence_ref: request.identity_evidence_ref,
          consumed_at: sqlInstant(row.consumed_at),
          consumption_expires_at: sqlInstant(row.reservation_expires_at),
          state: 'consumed-not-started',
        };
        await client.query('COMMIT');
        return { consumed: true, receipt, blockers: [] };
      }

      const hostRow = await client.query(
        'SELECT evidence,capacity_slots,reserved_slots FROM swarm_authority_hosts WHERE host_id=$1 FOR UPDATE',
        [row.host_id],
      );
      const host = hostEvidence(hostRow.rows[0]);
      const capacity = Number(hostRow.rows[0]?.capacity_slots);
      const reserved = Number(hostRow.rows[0]?.reserved_slots);
      const maxAge = Number(row.max_host_evidence_age_ms);
      if (!host || host.host_id !== row.host_id || host.status !== 'ready' || !host.secret_readiness) {
        return await deny('Trusted host is unavailable at consumption time.');
      }
      if (host.capacity_slots !== capacity) return await deny('Trusted host capacity evidence and ledger differ.');
      if (nowMs - Date.parse(host.observed_at) > maxAge || Date.parse(host.observed_at) > nowMs + 60_000) {
        return await deny('Trusted host evidence is stale or from the future at consumption time.');
      }
      if (Date.parse(host.access_review_expires_at) <= nowMs) return await deny('Trusted host access review is expired at consumption time.');
      if (!Number.isSafeInteger(capacity) || !Number.isSafeInteger(reserved) || reserved < 1 || capacity < reserved) {
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
        consumed_at: at,
        consumption_expires_at: sqlInstant(row.reservation_expires_at),
        state: 'consumed-not-started',
      };
      const consumed = await client.query(
        `UPDATE swarm_authority_reservations SET state='consumed-not-started',consumption_id=$2::uuid,consumed_at=$3::timestamptz
         WHERE reservation_id=$1::uuid AND state='reserved-not-started' RETURNING reservation_id`,
        [request.reservation_id, receipt.consumption_id, at],
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
      throw error;
    } finally { client.release?.(); }
  }

  async cancel(input: CancellationInput): Promise<CancellationResult> {
    const parsed = cancellationInputSchema.safeParse(input);
    if (!parsed.success) return cancellationDenied(String(input?.reservation_id ?? 'invalid-reservation'), 'Cancellation request is invalid.');
    const request = parsed.data;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (!await lockAuthority(client)) throw new Error('Authority serialization control row is missing or ambiguous.');
      const at = await wallClock(client);
      const found = await client.query(
        `SELECT reservation_id,operation_id,binding_digest_sha256,budget_receipt_id,host_id,reserved_cost_usd,state
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
      if (row.state === 'cancelled') {
        await client.query('COMMIT');
        return { cancelled: true, reservation_id: request.reservation_id, state: 'cancelled', already_terminal: true, released_cost_usd: 0, blockers: [] };
      }
      if (row.state === 'expired') {
        await client.query('COMMIT');
        return cancellationDenied(request.reservation_id, 'Reservation is already expired.', 'expired', true);
      }
      if (row.state !== 'reserved-not-started' && row.state !== 'consumed-not-started') {
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
         WHERE reservation_id=$1::uuid AND state IN ('reserved-not-started','consumed-not-started') RETURNING reservation_id`,
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
        'SELECT evidence,capacity_slots,reserved_slots FROM swarm_authority_hosts WHERE host_id=$1 FOR UPDATE',
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
      if (!Number.isSafeInteger(capacitySlots) || !Number.isSafeInteger(reservedSlots) || capacitySlots < 0 || reservedSlots < 0) {
        return await deny('Trusted host capacity ledger is invalid.');
      }
      if (host.capacity_slots !== capacitySlots) return await deny('Trusted host capacity evidence and ledger differ.');
      if (capacitySlots - reservedSlots < 1) return await deny('Trusted host has no available capacity.');
      const hostCaps = new Set(host.allowed_capabilities);
      if (request.binding.capabilities.some((item) => !hostCaps.has(item))) return await deny('Trusted host does not allow every requested capability.');

      const budgetRow = await client.query('SELECT hard_limit_usd,reserved_usd FROM swarm_authority_budgets WHERE receipt_id=$1 FOR UPDATE', [request.budget.receipt_id]);
      if (!budgetRow.rows[0]) return await deny('Durable budget registry entry is missing.');
      const registeredLimit = Number(budgetRow.rows[0].hard_limit_usd);
      const reserved = Number(budgetRow.rows[0].reserved_usd);
      if (registeredLimit !== request.budget.hard_limit_usd) return await deny('Signed and durable budget ceilings differ.');
      if (reserved + request.binding.requested_cost_usd > registeredLimit) return await deny('Durable budget is exhausted.');

      const inserted = await client.query(
        `INSERT INTO swarm_authority_reservations
         (reservation_id,operation_id,effect_id,binding_digest_sha256,binding,revocation_refs,
          consume_token_sha256,cancel_token_sha256,approval_receipt_id,budget_receipt_id,host_id,reserved_cost_usd,reserved_at,
          reservation_expires_at,max_host_evidence_age_ms,state)
         VALUES ($1::uuid,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9,$10,$11,$12,$13::timestamptz,$14::timestamptz,$15,'reserved-not-started')
         ON CONFLICT DO NOTHING RETURNING *`,
        [request.reservation_id, request.binding.operation_id, request.binding.effect_id, request.binding_digest_sha256,
          JSON.stringify(request.binding), JSON.stringify(refs), request.consume_token_sha256, request.cancel_token_sha256,
          request.approval.receipt_id, request.budget.receipt_id, request.binding.host_id,
          request.binding.requested_cost_usd, transactionNow, request.reservation_expires_at,
          request.max_host_evidence_age_ms],
      );
      if (!inserted.rows[0]) return await deny('Operation or external effect was already reserved.');
      await client.query('UPDATE swarm_authority_budgets SET reserved_usd=reserved_usd+$2 WHERE receipt_id=$1', [request.budget.receipt_id, request.binding.requested_cost_usd]);
      await client.query('UPDATE swarm_authority_hosts SET reserved_slots=reserved_slots+1 WHERE host_id=$1', [host.host_id]);
      const reservation: AdmissionReservation = {
        schema_version: 'starlight.operation_admission.v1', reservation_id: request.reservation_id,
        operation_id: request.binding.operation_id, effect_id: request.binding.effect_id,
        binding_digest_sha256: request.binding_digest_sha256, approval_receipt_id: request.approval.receipt_id,
        budget_receipt_id: request.budget.receipt_id, host_id: request.binding.host_id,
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
