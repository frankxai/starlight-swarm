import { z } from 'zod';
import { OperationAuthority, type AdmissionResult, type AuthorityKeyring } from './operation-authority';
import { PostgresOperationAuthorityStore, type PreparedOperationRegistrationResult } from './postgres-operation-authority';
import { sha256Digest } from './runtime-digest';
import { cloudflareWorkflowTargetSchema, isIssuedCloudflareWorkflowOperation, type BoundCloudflareWorkflowOperation } from './workflow-operation-context';
import type { WorkflowInstanceOwnershipReadResult } from './workflow-instance-ownership';
import { deriveWorkflowInstanceOwnership } from './workflow-instance-ownership';

const bootstrapSchema = z.object({
  schema_version: z.literal('starlight.workflow_operation_admission_bootstrap.v1'),
  operation_id: z.string().min(3).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  binding_digest_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  target: cloudflareWorkflowTargetSchema,
  expires_at: z.iso.datetime({ offset: true }),
}).strict();
const requestSchema = z.object({
  approval_receipt: z.unknown(), budget_receipt: z.unknown(),
  reservation_duration_ms: z.number().int().min(1000).max(15 * 60_000),
}).strict();
const issuerKeys = z.record(z.string().min(3).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  z.record(z.string().min(3).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/), z.string().min(32).max(4096)));
const keyringSchema = z.object({ approvalIssuers: issuerKeys, budgetIssuers: issuerKeys }).strict();
type State = {
  config: z.infer<typeof bootstrapSchema>; operation: BoundCloudflareWorkflowOperation;
  registry: PostgresOperationAuthorityStore; admissionStore: PostgresOperationAuthorityStore;
  keys: AuthorityKeyring;
};
const state = new WeakMap<CloudflareWorkflowOperationAdmission, State>();

/**
 * Server bootstrap capability for ONE externally selected operation. Never expose this object,
 * database pools or issuer keys to a workload. It registers immutable data and delegates admission
 * to the existing signed/durable authority; it cannot sign, start, stop or settle an executor.
 * Constructor configuration is a deployment trust root, not proof of a human pilot approval.
 */
export class CloudflareWorkflowOperationAdmission {
  constructor(config: unknown, operation: unknown,
    registry: PostgresOperationAuthorityStore, admissionStore: PostgresOperationAuthorityStore,
    keyring: AuthorityKeyring,
  ) {
    if (!isIssuedCloudflareWorkflowOperation(operation)) throw new Error('Workflow operation was not issued by the verified binding pipeline.');
    if (!(registry instanceof PostgresOperationAuthorityStore) || !(admissionStore instanceof PostgresOperationAuthorityStore)) {
      throw new Error('Bootstrap requires actual PostgreSQL authority adapters, not caller-authored durable flags.');
    }
    const parsed = bootstrapSchema.parse(config);
    if (parsed.operation_id !== operation.binding.operation_id || parsed.binding_digest_sha256 !== sha256Digest(operation.binding)) {
      throw new Error('Bootstrap operation ID or binding differs from the exact externally selected operation.');
    }
    if (sha256Digest(parsed.target) !== sha256Digest(operation.context.target)) throw new Error('Bootstrap target differs from the exact workflow operation target.');
    // Parsing produces a private snapshot; later mutations/rotation require reconstruction.
    const keys = keyringSchema.parse(keyring);
    state.set(this, { config: parsed, operation, registry, admissionStore, keys });
    Object.freeze(this);
  }

  async register(): Promise<PreparedOperationRegistrationResult> {
    const s = state.get(this);
    if (!s) throw new Error('Workflow admission bootstrap was not constructed.');
    if (Date.parse(s.config.expires_at) <= Date.now()) {
      const blockers = ['Workflow admission bootstrap is expired.'];
      await s.registry.recordDenial(s.config.binding_digest_sha256, s.config.operation_id, new Date().toISOString(), blockers);
      return { registered: false, already_registered: false, receipt: null, blockers };
    }
    return s.registry.registerPreparedWorkflowOperation(s.operation, s.config.expires_at);
  }

  /** Recovery remains readable after bootstrap expiry; this never refreshes admission authority. */
  async ownership(): Promise<WorkflowInstanceOwnershipReadResult> {
    const s = state.get(this);
    if (!s) throw new Error('Workflow admission bootstrap was not constructed.');
    return s.registry.readWorkflowInstanceOwnership(s.config.operation_id, s.config.binding_digest_sha256);
  }

  async admit(input: unknown): Promise<AdmissionResult> {
    const s = state.get(this);
    if (!s) throw new Error('Workflow admission bootstrap was not constructed.');
    const parsed = requestSchema.safeParse(input);
    const at = new Date().toISOString();
    const remaining = Date.parse(s.config.expires_at) - Date.parse(at);
    if (!parsed.success || remaining < 1000) {
      const blockers = [parsed.success ? 'Workflow admission bootstrap is expired or has less than one second remaining.' : 'Workflow admission request is invalid.'];
      await s.admissionStore.recordDenial(s.config.binding_digest_sha256, s.config.operation_id, new Date().toISOString(), blockers);
      return { admitted: false, reservation: null, blockers };
    }
    // No cached registration/readiness boolean: reserve rechecks the exact durable row, revocation,
    // fresh host/access/capabilities, both cumulative windows and idempotency under the SQL lock.
    const ownership = await s.registry.readWorkflowInstanceOwnership(s.config.operation_id, s.config.binding_digest_sha256);
    if (!ownership.found || sha256Digest(ownership.ownership) !== sha256Digest(deriveWorkflowInstanceOwnership(s.operation))) {
      const blockers = ['Exact durable workflow instance ownership is missing or differs.'];
      await s.admissionStore.recordDenial(s.config.binding_digest_sha256, s.config.operation_id, at, blockers);
      return { admitted: false, reservation: null, blockers };
    }
    const authority = new OperationAuthority(s.admissionStore, s.keys, undefined, () => at);
    return authority.admit({ ...parsed.data, binding: s.operation.binding,
      reservation_duration_ms: Math.min(parsed.data.reservation_duration_ms, remaining) });
  }
}
