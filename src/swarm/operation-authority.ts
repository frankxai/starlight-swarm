import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

import { z } from 'zod';

import { canonicalJson, sha256Digest } from './runtime-digest';

const id = z.string().min(3).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const iso = z.iso.datetime({ offset: true });
const capability = z.string().min(3).max(160).regex(/^[a-z0-9][a-z0-9._:-]*$/);

export const operationBindingSchema = z.object({
  schema_version: z.literal('starlight.operation_binding.v1'),
  operation_id: id,
  effect_id: id,
  mission_id: id,
  call_id: id,
  role: z.enum(['maker', 'checker']),
  actor_id: id,
  execution_identity: id,
  identity_evidence_ref: id,
  context_digest_sha256: digest,
  prompt_sha256: digest,
  timeout_ms: z.number().int().min(1_000).max(60 * 60_000),
  requested_operation: id,
  effect: z.object({
    kind: id,
    resource: z.string().min(3).max(1_000).regex(/^\S+$/),
    parameters_digest_sha256: digest,
  }).strict(),
  source_profile: z.object({
    repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
    commit_sha: z.string().regex(/^[a-f0-9]{40}$/),
    path: z.string().min(1).max(500).refine((value) => !value.startsWith('/') && !value.split('/').includes('..')),
    digest_sha256: digest,
  }).strict(),
  policy_digest_sha256: digest,
  plan_digest_sha256: digest,
  pack_digest_sha256: digest,
  compiler_version: id,
  lane_id: id,
  workload_id: id,
  runtime_id: id,
  host_id: id,
  capabilities: z.array(capability).min(1).max(32),
  budget_policy_id: id,
  requested_cost_usd: z.number().finite().nonnegative().max(10_000),
}).strict().superRefine((value, context) => {
  if (new Set(value.capabilities).size !== value.capabilities.length) {
    context.addIssue({ code: 'custom', path: ['capabilities'], message: 'Capabilities must be unique.' });
  }
  if (value.effect.kind !== value.requested_operation) {
    context.addIssue({ code: 'custom', path: ['effect', 'kind'], message: 'Effect kind must match the requested operation.' });
  }
});

const signedReceiptBase = {
  receipt_id: id,
  issuer: id,
  key_id: id,
  issued_at: iso,
  expires_at: iso,
  binding_digest_sha256: digest,
};

export const approvalReceiptSchema = z.object({
  schema_version: z.literal('starlight.operation_approval.v1'),
  ...signedReceiptBase,
  scope: z.literal('admit-bounded-operation'),
  allowed_capabilities: z.array(capability).min(1).max(32),
  signature: digest,
}).strict().superRefine((value, context) => {
  if (new Set(value.allowed_capabilities).size !== value.allowed_capabilities.length) {
    context.addIssue({ code: 'custom', path: ['allowed_capabilities'], message: 'Allowed capabilities must be unique.' });
  }
  if (Date.parse(value.issued_at) >= Date.parse(value.expires_at)) {
    context.addIssue({ code: 'custom', path: ['expires_at'], message: 'Receipt must expire after it is issued.' });
  }
});

export const budgetReceiptSchema = z.object({
  schema_version: z.literal('starlight.operation_budget.v1'),
  ...signedReceiptBase,
  budget_policy_id: id,
  hard_limit_usd: z.number().finite().nonnegative().max(10_000),
  signature: digest,
}).strict().superRefine((value, context) => {
  if (Date.parse(value.issued_at) >= Date.parse(value.expires_at)) {
    context.addIssue({ code: 'custom', path: ['expires_at'], message: 'Receipt must expire after it is issued.' });
  }
});

export type OperationBinding = z.infer<typeof operationBindingSchema>;
export type ApprovalReceipt = z.infer<typeof approvalReceiptSchema>;
export type BudgetReceipt = z.infer<typeof budgetReceiptSchema>;

export interface TrustedHostEvidence {
  host_id: string;
  observed_at: string;
  status: 'ready' | 'degraded' | 'offline';
  capacity_slots: number;
  secret_readiness: boolean;
  access_review_expires_at: string;
  allowed_capabilities: string[];
}

export interface AtomicAdmissionRequest {
  reservation_id: string;
  now: string;
  reservation_expires_at: string;
  consume_token: string;
  consume_token_sha256: string;
  cancel_token: string;
  cancel_token_sha256: string;
  binding: OperationBinding;
  binding_digest_sha256: string;
  approval: Pick<ApprovalReceipt, 'receipt_id' | 'issuer' | 'key_id' | 'expires_at'>;
  budget: Pick<BudgetReceipt, 'receipt_id' | 'issuer' | 'key_id' | 'expires_at' | 'hard_limit_usd'>;
  max_host_evidence_age_ms: number;
}

export interface BudgetWindowEvidence {
  window_id: string;
  kind: 'policy' | 'daily';
  starts_at: string;
  ends_at: string;
  currency: 'USD';
}

export interface AdmissionReservation {
  schema_version: 'starlight.operation_admission.v1';
  reservation_id: string;
  operation_id: string;
  effect_id: string;
  binding_digest_sha256: string;
  approval_receipt_id: string;
  budget_receipt_id: string;
  budget_policy_id: string;
  budget_windows: BudgetWindowEvidence[];
  host_id: string;
  reserved_cost_usd: number;
  reserved_at: string;
  reservation_expires_at: string;
  /** One-use bearer secret. It is returned once, stored only as SHA-256, and never audited. */
  consume_token: string;
  /** Separate cancellation secret. It is returned once, stored only as SHA-256, and never audited. */
  cancel_token: string;
  state: 'reserved-not-started';
}

export const consumptionInputSchema = z.object({
  reservation_id: z.uuid(),
  operation_id: id,
  effect_id: id,
  binding_digest_sha256: digest,
  execution_identity: id,
  identity_evidence_ref: id,
  consume_token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
}).strict();

export type ConsumptionInput = z.infer<typeof consumptionInputSchema>;

export const cancellationInputSchema = z.object({
  reservation_id: z.uuid(),
  cancel_token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  reason: z.string().trim().min(1).max(1_000),
}).strict();

export type CancellationInput = z.infer<typeof cancellationInputSchema>;

export interface ConsumptionReceipt {
  schema_version: 'starlight.operation_consumption.v1';
  consumption_id: string;
  reservation_id: string;
  operation_id: string;
  effect_id: string;
  binding_digest_sha256: string;
  execution_identity: string;
  identity_evidence_ref: string;
  budget_policy_id: string;
  budget_windows: BudgetWindowEvidence[];
  consumed_at: string;
  consumption_expires_at: string;
  state: 'consumed-not-started';
}

export type ConsumptionResult =
  | { consumed: true; receipt: ConsumptionReceipt; blockers: [] }
  | { consumed: false; receipt: null; blockers: string[] };

export type CancellationResult =
  | { cancelled: true; reservation_id: string; state: 'cancelled'; already_terminal: boolean; released_cost_usd: number; blockers: [] }
  | { cancelled: false; reservation_id: string; state: null | 'expired'; already_terminal: boolean; released_cost_usd: 0; blockers: string[] };

export type AdmissionResult =
  | { admitted: true; reservation: AdmissionReservation; blockers: [] }
  | { admitted: false; reservation: null; blockers: string[] };

/** The implementation must transact revocation, health, budget and replay checks with the reservation insert. */
export interface OperationAuthorityStore {
  readonly durable: boolean;
  reserve(request: AtomicAdmissionRequest): Promise<AdmissionResult>;
  consume(input: ConsumptionInput): Promise<ConsumptionResult>;
  cancel(input: CancellationInput): Promise<CancellationResult>;
  recordDenial(bindingDigest: string, operationId: string, at: string, blockers: string[]): Promise<void>;
}

export interface AuthorityKeyring {
  approvalIssuers: Readonly<Record<string, Readonly<Record<string, string>>>>;
  budgetIssuers: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

export interface AdmissionInput {
  binding: unknown;
  approval_receipt: unknown;
  budget_receipt: unknown;
  reservation_duration_ms: number;
}

function unsigned<T extends { signature: string }>(receipt: T): Omit<T, 'signature'> {
  const { signature: _signature, ...body } = receipt;
  return body;
}

function receiptSignature(body: object, secret: string): string {
  return createHmac('sha256', secret)
    .update(canonicalJson({ domain: 'starlight.operation-authority.v1', receipt: body }))
    .digest('hex');
}

export function signApprovalReceipt(
  body: Omit<ApprovalReceipt, 'signature'>,
  secret: string,
): ApprovalReceipt {
  return approvalReceiptSchema.parse({ ...body, signature: receiptSignature(body, secret) });
}

export function signBudgetReceipt(
  body: Omit<BudgetReceipt, 'signature'>,
  secret: string,
): BudgetReceipt {
  return budgetReceiptSchema.parse({ ...body, signature: receiptSignature(body, secret) });
}

function verifyReceipt(
  receipt: ApprovalReceipt | BudgetReceipt,
  issuers: AuthorityKeyring['approvalIssuers'],
): boolean {
  const secret = issuers[receipt.issuer]?.[receipt.key_id];
  if (!secret || secret.length < 32) return false;
  const expected = Buffer.from(receiptSignature(unsigned(receipt), secret), 'hex');
  const actual = Buffer.from(receipt.signature, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function invalid(blockers: string[]): AdmissionResult {
  return { admitted: false, reservation: null, blockers };
}

/**
 * Cryptographic admission front door. It can issue a single reservation but never starts a worker.
 * The durable store remains the operation-time authority for revocation, capacity and budget.
 */
export class OperationAuthority {
  private readonly maxHostEvidenceAgeMs: number;

  constructor(
    private readonly store: OperationAuthorityStore,
    private readonly keyring: AuthorityKeyring,
    maxHostEvidenceAgeMs = 5 * 60_000,
    private readonly clock: () => string = () => new Date().toISOString(),
  ) {
    if (!Number.isInteger(maxHostEvidenceAgeMs) || maxHostEvidenceAgeMs < 1_000 || maxHostEvidenceAgeMs > 60 * 60_000) {
      throw new Error('Host evidence age ceiling must be between 1 second and 1 hour.');
    }
    this.maxHostEvidenceAgeMs = maxHostEvidenceAgeMs;
  }

  async admit(input: AdmissionInput): Promise<AdmissionResult> {
    const blockers: string[] = [];
    const now = this.clock();
    const parsedBinding = operationBindingSchema.safeParse(input.binding);
    const parsedApproval = approvalReceiptSchema.safeParse(input.approval_receipt);
    const parsedBudget = budgetReceiptSchema.safeParse(input.budget_receipt);
    let fallbackDigest = '0'.repeat(64);
    try { fallbackDigest = sha256Digest(input.binding); } catch { blockers.push('Operation binding cannot be digested.'); }
    const fallbackOperation = parsedBinding.success ? parsedBinding.data.operation_id : 'invalid-operation';

    if (!this.store.durable) blockers.push('A durable authority store is required.');
    if (!parsedBinding.success) blockers.push('Operation binding is invalid.');
    if (!parsedApproval.success) blockers.push('Approval receipt is invalid.');
    if (!parsedBudget.success) blockers.push('Budget receipt is invalid.');
    if (!Number.isInteger(input.reservation_duration_ms) || input.reservation_duration_ms < 1_000 || input.reservation_duration_ms > 15 * 60_000) {
      blockers.push('Reservation duration must be between 1 second and 15 minutes.');
    }
    const nowMs = Date.parse(now);
    if (!Number.isFinite(nowMs)) blockers.push('Admission time is invalid.');
    if (blockers.length || !parsedBinding.success || !parsedApproval.success || !parsedBudget.success) {
      const auditAt = Number.isFinite(nowMs) ? now : new Date().toISOString();
      await this.store.recordDenial(fallbackDigest, fallbackOperation, auditAt, blockers);
      return invalid(blockers);
    }

    const binding = parsedBinding.data;
    const approval = parsedApproval.data;
    const budget = parsedBudget.data;
    const bindingDigest = sha256Digest(binding);

    if (!verifyReceipt(approval, this.keyring.approvalIssuers)) blockers.push('Approval signature or issuer is not trusted.');
    if (!verifyReceipt(budget, this.keyring.budgetIssuers)) blockers.push('Budget signature or issuer is not trusted.');
    for (const [label, receipt] of [['Approval', approval], ['Budget', budget]] as const) {
      if (receipt.binding_digest_sha256 !== bindingDigest) blockers.push(`${label} receipt is bound to another operation.`);
      if (Date.parse(receipt.issued_at) > nowMs + 60_000) blockers.push(`${label} receipt was issued in the future.`);
      if (Date.parse(receipt.expires_at) <= nowMs) blockers.push(`${label} receipt is expired.`);
    }
    if (budget.budget_policy_id !== binding.budget_policy_id) blockers.push('Budget policy does not match the operation.');
    if (binding.requested_cost_usd > budget.hard_limit_usd) blockers.push('Requested cost exceeds the signed budget ceiling.');
    const allowed = new Set(approval.allowed_capabilities);
    if (binding.capabilities.some((item) => !allowed.has(item))) blockers.push('Requested capabilities exceed the signed approval.');
    if (blockers.length) {
      await this.store.recordDenial(bindingDigest, binding.operation_id, now, blockers);
      return invalid(blockers);
    }

    const receiptExpiry = Math.min(Date.parse(approval.expires_at), Date.parse(budget.expires_at));
    const reservationExpiry = Math.min(nowMs + input.reservation_duration_ms, receiptExpiry);
    const consumeToken = randomBytes(32).toString('base64url');
    const cancelToken = randomBytes(32).toString('base64url');
    return this.store.reserve({
      reservation_id: randomUUID(),
      now,
      reservation_expires_at: new Date(reservationExpiry).toISOString(),
      consume_token: consumeToken,
      consume_token_sha256: createHash('sha256').update(consumeToken, 'utf8').digest('hex'),
      cancel_token: cancelToken,
      cancel_token_sha256: createHash('sha256').update(cancelToken, 'utf8').digest('hex'),
      binding,
      binding_digest_sha256: bindingDigest,
      approval,
      budget,
      max_host_evidence_age_ms: this.maxHostEvidenceAgeMs,
    });
  }

  async consume(input: unknown): Promise<ConsumptionResult> {
    if (!this.store.durable) return { consumed: false, receipt: null, blockers: ['A durable authority store is required.'] };
    const parsed = consumptionInputSchema.safeParse(input);
    if (!parsed.success) {
      const at = this.clock();
      await this.store.recordDenial('0'.repeat(64), 'invalid-operation', Number.isFinite(Date.parse(at)) ? at : new Date().toISOString(), ['Consumption request is invalid.']);
      return { consumed: false, receipt: null, blockers: ['Consumption request is invalid.'] };
    }
    return this.store.consume(parsed.data);
  }

  async cancel(input: unknown): Promise<CancellationResult> {
    const fallbackReservationId = typeof input === 'object' && input !== null && 'reservation_id' in input
      ? String(input.reservation_id)
      : 'invalid-reservation';
    if (!this.store.durable) {
      return { cancelled: false, reservation_id: fallbackReservationId, state: null, already_terminal: false, released_cost_usd: 0, blockers: ['A durable authority store is required.'] };
    }
    const parsed = cancellationInputSchema.safeParse(input);
    if (!parsed.success) {
      const at = this.clock();
      await this.store.recordDenial('0'.repeat(64), 'invalid-operation', Number.isFinite(Date.parse(at)) ? at : new Date().toISOString(), ['Cancellation request is invalid.']);
      return { cancelled: false, reservation_id: fallbackReservationId, state: null, already_terminal: false, released_cost_usd: 0, blockers: ['Cancellation request is invalid.'] };
    }
    return this.store.cancel(parsed.data);
  }
}
