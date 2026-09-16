/**
 * capabilities.ts — tool access as an enforced grant rather than a comment.
 *
 * streams.ts has always said the right thing: "ONLY the Payments stream touches
 * the Payments MCP, and only verify-only tools (IAM L3)". It said it in a code
 * comment. worker.ts says workers have no payment access "by IAM" — also a
 * comment. Nothing in the runtime stopped a worker handed a payments handle
 * from calling it, which means the boundary was documentation wearing the
 * language of enforcement.
 *
 * This module makes the boundary structural. A holder carries a frozen grant; a
 * brokered MCP handle checks the grant before every call and REFUSES otherwise
 * — loudly, with a remedy, and (when wired to a ledger) in writing.
 *
 * §13.2 OF THE CHARTER IS THE DESIGN CONSTRAINT.
 * Authority is inherited downward and never relaxed downward: a coordinator may
 * impose stricter refusals on what it spawns, and may never grant a permission
 * it does not itself hold. `restrict()` is that sentence as code — it narrows,
 * and throws when asked to widen. The failure is loud because a silent widening
 * is precisely the privilege escalation the clause exists to prevent.
 *
 * Nothing here executes a tool. It only decides whether a call may be forwarded
 * to the handle the caller already had.
 */

import type { PaymentsMcp, SisVaultMcp } from './integrations';
import type { StreamId } from './escalation';
import type { SwarmLedger } from './ledger';

/**
 * The tool surface the runtime brokers, named tool-by-tool rather than
 * server-by-server. Server-level grants ("payments") would make verify-only and
 * settle-capable tools indistinguishable, and the whole posture of this repo is
 * that the money surface is granular.
 */
export type Capability =
  | 'vault.append'
  | 'vault.read'
  | 'vault.confirm'
  | 'payments.verify_mandate'
  | 'payments.check_spend_cap'
  | 'payments.record_audit_entry'
  | 'payments.require_human_approval';

export const ALL_CAPABILITIES: readonly Capability[] = Object.freeze([
  'vault.append',
  'vault.read',
  'vault.confirm',
  'payments.verify_mandate',
  'payments.check_spend_cap',
  'payments.record_audit_entry',
  'payments.require_human_approval',
]);

/**
 * A worker appends to shared memory and does nothing else. It cannot read the
 * vault back, cannot confirm a pattern, and has no path to the money surface.
 */
export const WORKER_CAPABILITIES: readonly Capability[] = Object.freeze(['vault.append']);

/** A queen owns its stream's memory: append, read, confirm. No money. */
export const QUEEN_CAPABILITIES: readonly Capability[] = Object.freeze([
  'vault.append',
  'vault.read',
  'vault.confirm',
]);

/**
 * The Payments Queen adds the four VERIFY-ONLY payment tools. There is no
 * transfer capability in this union to grant, and adding one is the repo's
 * standing hard stop — the enum is the enforcement point for that rule.
 */
export const PAYMENTS_QUEEN_CAPABILITIES: readonly Capability[] = Object.freeze([
  'vault.append',
  'vault.read',
  'vault.confirm',
  'payments.verify_mandate',
  'payments.check_spend_cap',
  'payments.record_audit_entry',
  'payments.require_human_approval',
]);

/**
 * Thrown when a holder calls a tool outside its grant.
 *
 * A refusal is a first-class output (clause 5), so this carries the reason and
 * the remedy rather than a bare message, and the broker writes both down before
 * throwing. Failing loudly is the fail-closed choice: a broker that returned a
 * safe-looking placeholder would let a caller mistake a denial for a result.
 */
export class CapabilityRefusal extends Error {
  readonly capability: Capability;
  readonly holder: string;
  readonly remedy: string;

  constructor(holder: string, capability: Capability, remedy: string) {
    super(`CAPABILITY REFUSED [${holder}] may not call ${capability}. FIX: ${remedy}`);
    this.name = 'CapabilityRefusal';
    this.holder = holder;
    this.capability = capability;
    this.remedy = remedy;
    // Required for `instanceof` to survive the es5 target in tsconfig.json.
    Object.setPrototypeOf(this, CapabilityRefusal.prototype);
  }
}

export interface CapabilityGrant {
  readonly holder: string;
  has(capability: Capability): boolean;
  /** Sorted, so a grant renders and hashes identically across runs. */
  list(): Capability[];
  /**
   * Derive a narrower grant for something this holder spawns. Throws on any
   * capability the parent does not itself hold (§13.2).
   */
  restrict(holder: string, capabilities: readonly Capability[]): CapabilityGrant;
}

export function makeGrant(holder: string, capabilities: readonly Capability[]): CapabilityGrant {
  const held = Object.freeze(capabilities.slice().sort());
  const index: Record<string, true> = {};
  for (const capability of held) index[capability] = true;

  return Object.freeze({
    holder,
    has: (capability: Capability) => index[capability] === true,
    list: () => held.slice(),
    restrict(childHolder: string, requested: readonly Capability[]): CapabilityGrant {
      const widened = requested.filter((capability) => index[capability] !== true);
      if (widened.length > 0) {
        throw new CapabilityRefusal(
          childHolder,
          widened[0],
          `Authority is inherited downward and never relaxed downward (charter §13.2). ${holder} does not hold ` +
            `${widened.join(', ')}, so it cannot grant them. Narrow the request, or raise ${holder}'s own grant deliberately.`,
        );
      }
      return makeGrant(childHolder, requested);
    },
  });
}

/** The grant a stream's queen holds. Only Payments reaches the money surface. */
export function queenGrant(stream: StreamId, holder: string): CapabilityGrant {
  return makeGrant(holder, stream === 'payments' ? PAYMENTS_QUEEN_CAPABILITIES : QUEEN_CAPABILITIES);
}

/** The grant a worker holds — append-only, on every stream including Payments. */
export function workerGrant(holder: string): CapabilityGrant {
  return makeGrant(holder, WORKER_CAPABILITIES);
}

/** Observers notified as calls are allowed or refused. */
export interface CapabilityAudit {
  onAllowed?(holder: string, capability: Capability): void;
  onDenied?(refusal: CapabilityRefusal): void;
}

/** An audit that writes every denial into the ledger (clauses 5 and 6). */
export function ledgerAudit(ledger: SwarmLedger, stream?: string): CapabilityAudit {
  return {
    onDenied(refusal) {
      ledger.append({
        kind: 'capability-denied',
        actor: refusal.holder,
        stream,
        subject: refusal.capability,
        summary: `${refusal.holder} attempted ${refusal.capability} outside its grant and was refused.`,
        detail: { remedy: refusal.remedy },
      });
    },
  };
}

function guard(grant: CapabilityGrant, capability: Capability, remedy: string, audit?: CapabilityAudit): void {
  if (grant.has(capability)) {
    audit?.onAllowed?.(grant.holder, capability);
    return;
  }
  const refusal = new CapabilityRefusal(grant.holder, capability, remedy);
  audit?.onDenied?.(refusal);
  throw refusal;
}

/**
 * Wrap a vault handle so each tool is checked against the grant first.
 *
 * The wrapper satisfies the same `SisVaultMcp` interface the caller already
 * consumes, so brokering is invisible to correct code and fatal to incorrect
 * code — which is the only arrangement that stays true as the runtime grows.
 */
export function brokerVault(vault: SisVaultMcp, grant: CapabilityGrant, audit?: CapabilityAudit): SisVaultMcp {
  return {
    async sis_append_entry(entry) {
      guard(grant, 'vault.append', 'Append-only memory is the worker tier\'s one side effect; grant it explicitly.', audit);
      return vault.sis_append_entry(entry);
    },
    async sis_vault_search(query) {
      guard(grant, 'vault.read', 'Reading prior context is a queen-tier capability. Ask the queen for the context instead.', audit);
      return vault.sis_vault_search(query);
    },
    async sis_confirm(id) {
      guard(grant, 'vault.confirm', 'Confirming a pattern strengthens shared memory — queen tier only.', audit);
      return vault.sis_confirm(id);
    },
  };
}

/**
 * Wrap a payments handle. Every tool here is verify-only and every one of them
 * is still gated: holding the handle is not the same as holding the grant, and
 * this is the difference the previous version of the runtime could not express.
 */
export function brokerPayments(payments: PaymentsMcp, grant: CapabilityGrant, audit?: CapabilityAudit): PaymentsMcp {
  const scopedToPayments =
    'Only the Payments Queen touches the money control surface (IAM L3). A holder outside that seat ' +
    'must route the proposal through the Payments stream, not reach for the tool.';
  return {
    async verify_mandate(proof) {
      guard(grant, 'payments.verify_mandate', scopedToPayments, audit);
      return payments.verify_mandate(proof);
    },
    async check_spend_cap(stream, amount) {
      guard(grant, 'payments.check_spend_cap', scopedToPayments, audit);
      return payments.check_spend_cap(stream, amount);
    },
    async record_audit_entry(entry) {
      guard(grant, 'payments.record_audit_entry', scopedToPayments, audit);
      return payments.record_audit_entry(entry);
    },
    async require_human_approval(reason) {
      guard(grant, 'payments.require_human_approval', scopedToPayments, audit);
      return payments.require_human_approval(reason);
    },
  };
}
