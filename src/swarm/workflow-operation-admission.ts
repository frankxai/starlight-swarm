import { z } from 'zod';
import { OperationAuthority, type AdmissionResult, type AuthorityKeyring } from './operation-authority';
import { PostgresOperationAuthorityStore, type PreparedOperationRegistrationResult } from './postgres-operation-authority';
import { sha256Digest } from './runtime-digest';
import { cloudflareWorkflowTargetSchema, isIssuedCloudflareWorkflowOperation, type BoundCloudflareWorkflowOperation } from './workflow-operation-context';
import type { WorkflowInstanceOwnershipReadResult } from './workflow-instance-ownership';
import { deriveWorkflowInstanceOwnership } from './workflow-instance-ownership';
import { CloudflareWorkflowObserver, type CloudflareWorkflowObservationResult } from './cloudflare-workflow-observer';

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
  observe: ((operation: unknown) => Promise<CloudflareWorkflowObservationResult>) | null;
  isIssuedObservation: ((observation: unknown) => boolean) | null;
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
    observer?: CloudflareWorkflowObserver,
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
    if (observer !== undefined && !(observer instanceof CloudflareWorkflowObserver)) {
      throw new Error('Workflow admission requires the server-owned authenticated Cloudflare observer.');
    }
    // Capture the real methods at trusted bootstrap. A prototype-shaped object or later
    // method replacement cannot manufacture the observer's private issued-receipt state.
    const observe = observer ? CloudflareWorkflowObserver.prototype.observe.bind(observer) : null;
    const isIssuedObservation = observer ? CloudflareWorkflowObserver.prototype.isIssuedObservation.bind(observer) : null;
    state.set(this, { config: parsed, operation, registry, admissionStore, keys, observe, isIssuedObservation });
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
    let at = new Date(Date.now()).toISOString();
    const remaining = Date.parse(s.config.expires_at) - Date.parse(at);
    if (!parsed.success || remaining < 1000) {
      const blockers = [parsed.success ? 'Workflow admission bootstrap is expired or has less than one second remaining.' : 'Workflow admission request is invalid.'];
      await s.admissionStore.recordDenial(s.config.binding_digest_sha256, s.config.operation_id, new Date().toISOString(), blockers);
      return { admitted: false, reservation: null, blockers };
    }
    // No cached registration/readiness boolean: reserve rechecks the exact durable row, revocation,
    // fresh host/access/capabilities, both cumulative windows and idempotency under the SQL lock.
    const ownership = await s.registry.readWorkflowInstanceOwnership(s.config.operation_id, s.config.binding_digest_sha256);
    if (!ownership.found || ownership.prepared_state !== 'ready'
      || sha256Digest(ownership.ownership) !== sha256Digest(deriveWorkflowInstanceOwnership(s.operation))) {
      const blockers = ['Exact durable workflow instance ownership is missing or differs.'];
      await s.admissionStore.recordDenial(s.config.binding_digest_sha256, s.config.operation_id, at, blockers);
      return { admitted: false, reservation: null, blockers };
    }
    const deny = async (blocker: string): Promise<AdmissionResult> => {
      const blockers = [blocker];
      await s.admissionStore.recordDenial(s.config.binding_digest_sha256, s.config.operation_id,
        new Date(Date.now()).toISOString(), blockers);
      return { admitted: false, reservation: null, blockers };
    };
    if (!s.observe || !s.isIssuedObservation) return deny('Workflow deployment observer is not configured; no reservation is permitted.');
    const result = await s.observe(s.operation);
    if (!result.observed) return deny(result.blockers.join(' '));
    const observation = result.observation;
    if (!s.isIssuedObservation(observation) || observation.binding_digest_sha256 !== s.config.binding_digest_sha256
      || sha256Digest(observation.target) !== sha256Digest(s.config.target)) {
      return deny('Workflow deployment readback is not fresh or does not bind the exact approved operation and target.');
    }
    if (observation.status !== 'running' || observation.workflow_terminal_observed) {
      return deny('Workflow instance is not running; no new effect reservation is permitted.');
    }
    if (observation.workflow_script_deleted !== false) return deny('Workflow script deletion state is deleted or unknown.');
    // Re-read after the bounded network operation. SQL reservation rechecks ready/revocation
    // under its own lock; this prevents a stale recovery row from serving as readiness here.
    const current = await s.registry.readWorkflowInstanceOwnership(s.config.operation_id, s.config.binding_digest_sha256);
    if (!current.found || current.prepared_state !== 'ready'
      || sha256Digest(current.ownership) !== sha256Digest(ownership.ownership)) {
      return deny('Exact workflow ownership is no longer ready after deployment readback.');
    }
    at = new Date(Date.now()).toISOString();
    const currentRemaining = Math.min(Date.parse(s.config.expires_at), Date.parse(observation.expires_at)) - Date.parse(at);
    if (currentRemaining < 1000 || !s.isIssuedObservation(observation)) {
      return deny('Workflow bootstrap or fresh deployment observation expired or has less than one second remaining.');
    }
    const authority = new OperationAuthority(s.admissionStore, s.keys, undefined, () => at);
    return authority.admit({ ...parsed.data, binding: s.operation.binding,
      reservation_duration_ms: Math.min(parsed.data.reservation_duration_ms, currentRemaining) });
  }
}
