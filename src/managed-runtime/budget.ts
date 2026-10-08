/**
 * budget.ts — reserve before a run, settle after, escalate on over-cap.
 *
 * Inference spend is `kind: 'spend'` in the swarm's escalation vocabulary: it
 * is capital, not a payment to a third party, so it never carries
 * `movesMoney`. Under cap it is autonomous; over cap `classify()` sends it to
 * the founder and the board. This module reuses that spine rather than
 * re-deriving the rule, so a future tightening of `classify()` tightens
 * budgets too.
 *
 * Fail-closed: a non-finite limit, spend, or request is treated as over-cap.
 * Nothing here moves money. Reservations are bookkeeping.
 */

import { classify } from '../swarm/escalation';
import type { Classification, StreamId } from '../swarm/escalation';
import { budgetReservationSchema } from './contract';
import type { BudgetReservation } from './contract';

export interface BudgetPolicy {
  /** Stream the spend belongs to (queens never command across streams). */
  stream: StreamId;
  /** Total ceiling for the period, in micro-USD. */
  limitMicroUsd: number;
  /** Ceiling for a single run, in micro-USD. */
  perRunCapMicroUsd: number;
}

export type ReserveResult =
  | { ok: true; reservation: BudgetReservation; classification: Classification }
  | { ok: false; classification: Classification; reason: string };

/**
 * Reserve `requestMicroUsd` for a run.
 *
 * The effective cap is the smaller of the per-run cap and the remaining period
 * budget, so a run that would breach either escalates.
 */
export function reserveBudget(
  policy: BudgetPolicy,
  spentMicroUsd: number,
  requestMicroUsd: number,
  ids: { reservationId: string; runId: string; workspaceId: string },
  now: Date = new Date(),
): ReserveResult {
  const finite =
    Number.isFinite(policy.limitMicroUsd) &&
    Number.isFinite(policy.perRunCapMicroUsd) &&
    Number.isFinite(spentMicroUsd) &&
    Number.isFinite(requestMicroUsd);

  const remaining = finite ? Math.max(0, policy.limitMicroUsd - spentMicroUsd) : Number.NaN;
  const cap = finite ? Math.min(policy.perRunCapMicroUsd, remaining) : Number.NaN;

  const classification = classify({
    kind: 'spend',
    stream: policy.stream,
    irreversible: false,
    movesMoney: false,
    crossStream: false,
    amount: finite ? requestMicroUsd : Number.NaN,
    cap,
  });

  if (classification.decision !== 'autonomous') {
    return {
      ok: false,
      classification,
      reason: finite
        ? `Requested ${requestMicroUsd} micro-USD exceeds effective cap ${cap} (per-run ${policy.perRunCapMicroUsd}, remaining ${remaining}).`
        : 'Budget inputs are not finite numbers; fail-closed to escalation.',
    };
  }

  if (!Number.isInteger(requestMicroUsd) || requestMicroUsd <= 0) {
    // classify() passed the amount but a reservation must be a positive integer.
    return {
      ok: false,
      classification: {
        decision: 'founder-board',
        reason: 'Reservation amount must be a positive integer of micro-USD.',
        gates: ['founder.review'],
      },
      reason: `Invalid reservation amount ${requestMicroUsd}.`,
    };
  }

  const reservation = budgetReservationSchema.parse({
    reservationId: ids.reservationId,
    runId: ids.runId,
    workspaceId: ids.workspaceId,
    currency: 'USD',
    limitMicroUsd: policy.limitMicroUsd,
    spentMicroUsdBefore: spentMicroUsd,
    reservedMicroUsd: requestMicroUsd,
    status: 'reserved',
    reservedAt: now.toISOString(),
  });

  return { ok: true, reservation, classification };
}

export interface Settlement {
  reservationId: string;
  reservedMicroUsd: number;
  actualMicroUsd: number;
  /** Positive when the run cost more than it reserved. Never silently absorbed. */
  overrunMicroUsd: number;
  /** Spend after this run, for the next reservation's `spentMicroUsdBefore`. */
  spentMicroUsdAfter: number;
}

/** Settle a reservation against the measured cost on the receipt. */
export function settleBudget(reservation: BudgetReservation, actualMicroUsd: number): Settlement {
  if (!Number.isInteger(actualMicroUsd) || actualMicroUsd < 0) {
    throw new Error(`Actual cost must be a non-negative integer of micro-USD, got ${actualMicroUsd}.`);
  }
  return {
    reservationId: reservation.reservationId,
    reservedMicroUsd: reservation.reservedMicroUsd,
    actualMicroUsd,
    overrunMicroUsd: Math.max(0, actualMicroUsd - reservation.reservedMicroUsd),
    spentMicroUsdAfter: reservation.spentMicroUsdBefore + actualMicroUsd,
  };
}

/** Micro-USD → the minor-unit (cents) string the Anthropic session budget wants. Rounds up. */
export function microUsdToCentsString(microUsd: number): string {
  if (!Number.isInteger(microUsd) || microUsd < 0) {
    throw new Error(`micro-USD must be a non-negative integer, got ${microUsd}.`);
  }
  return String(Math.ceil(microUsd / 10_000));
}

/** Minor-unit (cents) string → micro-USD integer. */
export function centsStringToMicroUsd(cents: string): number {
  if (!/^(0|[1-9][0-9]*)$/.test(cents)) {
    throw new Error(`cents must be an integer decimal string, got ${JSON.stringify(cents)}.`);
  }
  return Number(cents) * 10_000;
}
