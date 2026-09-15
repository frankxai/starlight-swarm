import type {
  AdmissionReservation,
  AdmissionResult,
  AtomicAdmissionRequest,
  OperationAuthorityStore,
  TrustedHostEvidence,
} from './operation-authority';
import { z } from 'zod';

const controlId = z.string().min(3).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const controlTime = z.iso.datetime({ offset: true });
const hostEvidenceSchema = z.object({
  host_id: controlId,
  observed_at: controlTime,
  status: z.enum(['ready', 'degraded', 'offline']),
  available_slots: z.number().int().nonnegative().max(10_000),
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
  host_id TEXT PRIMARY KEY, evidence JSONB NOT NULL, observed_at TIMESTAMPTZ NOT NULL
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
  binding_digest_sha256 CHAR(64) NOT NULL, approval_receipt_id TEXT NOT NULL,
  budget_receipt_id TEXT NOT NULL, host_id TEXT NOT NULL, reserved_cost_usd NUMERIC NOT NULL,
  reserved_at TIMESTAMPTZ NOT NULL, reservation_expires_at TIMESTAMPTZ NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('reserved-not-started'))
);
CREATE TABLE IF NOT EXISTS swarm_authority_audit (
  seq BIGSERIAL PRIMARY KEY, event TEXT NOT NULL CHECK (event IN ('admitted','denied','revoked','cancelled')),
  operation_id TEXT NOT NULL, binding_digest_sha256 CHAR(64) NOT NULL,
  at TIMESTAMPTZ NOT NULL, detail JSONB NOT NULL
);
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

function sqlInstant(value: unknown): string {
  const parsed = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(parsed.getTime())) throw new Error('Database returned an invalid transaction timestamp.');
  return parsed.toISOString();
}

function hostEvidence(row: Record<string, unknown> | undefined): TrustedHostEvidence | null {
  const parsed = hostEvidenceSchema.safeParse(row?.evidence);
  return parsed.success ? parsed.data : null;
}

/** PostgreSQL is the concurrency boundary; every mutable admission check runs in one transaction. */
export class PostgresOperationAuthorityStore implements OperationAuthorityStore {
  readonly durable = true;
  constructor(private readonly pool: AuthoritySqlPool) {}

  async initialize(): Promise<void> {
    const client = await this.pool.connect();
    try { await client.query(OPERATION_AUTHORITY_MIGRATION_SQL); } finally { client.release?.(); }
  }

  async putHostEvidence(evidence: TrustedHostEvidence): Promise<void> {
    const trusted = hostEvidenceSchema.parse(evidence);
    const client = await this.pool.connect();
    try {
      await client.query(
        `INSERT INTO swarm_authority_hosts (host_id,evidence,observed_at) VALUES ($1,$2::jsonb,$3::timestamptz)
         ON CONFLICT (host_id) DO UPDATE SET evidence=EXCLUDED.evidence, observed_at=EXCLUDED.observed_at`,
        [trusted.host_id, JSON.stringify(trusted), trusted.observed_at],
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
      await client.query('SELECT singleton FROM swarm_authority_control WHERE singleton=TRUE FOR UPDATE');
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
         VALUES ('cancelled',$1,$2,NOW(),$3::jsonb)`,
        [operationId, prepared.rows[0].binding_digest_sha256, JSON.stringify({ reason: 'control-plane cancellation' })],
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
      await client.query('SELECT singleton FROM swarm_authority_control WHERE singleton=TRUE FOR UPDATE');
      await client.query(
        `INSERT INTO swarm_authority_revocations (ref,revoked_at,reason) VALUES ($1,$2::timestamptz,$3)
         ON CONFLICT (ref) DO NOTHING`, [ref, at, reason],
      );
      await client.query(
        `INSERT INTO swarm_authority_audit (event,operation_id,binding_digest_sha256,at,detail)
         VALUES ('revoked','control-plane',$1,$2::timestamptz,$3::jsonb)`,
        ['0'.repeat(64), at, JSON.stringify({ ref, reason })],
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
      const control = await client.query('SELECT singleton FROM swarm_authority_control WHERE singleton=TRUE FOR UPDATE');
      if (control.rows.length !== 1) {
        return await deny('Authority serialization control row is missing or ambiguous.');
      }
      // Unlike transaction_timestamp()/NOW(), this advances while the transaction waits for the control lock.
      const databaseTime = await client.query('SELECT clock_timestamp() AS now');
      const transactionNow = sqlInstant(databaseTime.rows[0]?.now);
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

      const hostRow = await client.query('SELECT evidence FROM swarm_authority_hosts WHERE host_id=$1 FOR UPDATE', [request.binding.host_id]);
      const host = hostEvidence(hostRow.rows[0]);
      if (!host) return await deny('Trusted host evidence is missing.');
      if (host.host_id !== request.binding.host_id) return await deny('Trusted host evidence identity does not match the requested host.');
      const nowMs = transactionNowMs;
      if (host.status !== 'ready') return await deny('Trusted host is not ready.');
      if (nowMs - Date.parse(host.observed_at) > request.max_host_evidence_age_ms || Date.parse(host.observed_at) > nowMs + 60_000) return await deny('Trusted host evidence is stale or from the future.');
      if (!host.secret_readiness) return await deny('Trusted host secrets are not ready.');
      if (Date.parse(host.access_review_expires_at) <= nowMs) return await deny('Trusted host access review is expired.');
      if (!Number.isInteger(host.available_slots) || host.available_slots < 1) return await deny('Trusted host has no available capacity.');
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
         (reservation_id,operation_id,effect_id,binding_digest_sha256,approval_receipt_id,budget_receipt_id,host_id,reserved_cost_usd,reserved_at,reservation_expires_at,state)
         VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9::timestamptz,$10::timestamptz,'reserved-not-started')
         ON CONFLICT DO NOTHING RETURNING *`,
        [request.reservation_id, request.binding.operation_id, request.binding.effect_id, request.binding_digest_sha256,
          request.approval.receipt_id, request.budget.receipt_id, request.binding.host_id,
          request.binding.requested_cost_usd, transactionNow, request.reservation_expires_at],
      );
      if (!inserted.rows[0]) return await deny('Operation or external effect was already admitted.');
      await client.query('UPDATE swarm_authority_budgets SET reserved_usd=reserved_usd+$2 WHERE receipt_id=$1', [request.budget.receipt_id, request.binding.requested_cost_usd]);
      const nextHost = { ...host, available_slots: host.available_slots - 1 };
      await client.query('UPDATE swarm_authority_hosts SET evidence=$2::jsonb WHERE host_id=$1', [host.host_id, JSON.stringify(nextHost)]);
      const reservation: AdmissionReservation = {
        schema_version: 'starlight.operation_admission.v1', reservation_id: request.reservation_id,
        operation_id: request.binding.operation_id, effect_id: request.binding.effect_id,
        binding_digest_sha256: request.binding_digest_sha256, approval_receipt_id: request.approval.receipt_id,
        budget_receipt_id: request.budget.receipt_id, host_id: request.binding.host_id,
        reserved_cost_usd: request.binding.requested_cost_usd, reserved_at: transactionNow,
        reservation_expires_at: request.reservation_expires_at, state: 'reserved-not-started',
      };
      await client.query(
        `INSERT INTO swarm_authority_audit (event,operation_id,binding_digest_sha256,at,detail)
         VALUES ('admitted',$1,$2,$3::timestamptz,$4::jsonb)`,
        [request.binding.operation_id, request.binding_digest_sha256, transactionNow, JSON.stringify(reservation)],
      );
      await client.query('COMMIT');
      return { admitted: true, reservation, blockers: [] };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release?.(); }
  }
}
