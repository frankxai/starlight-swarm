/**
 * charter.ts — the benevolence charter, as an executable gate.
 *
 * Source: the Blessing Protocol §13 (github.com/frankxai/bless), which defines
 * "benevolent" not as an adjective but as a set of refusals that hold under
 * pressure. §13.1 is explicit that a charter existing only as prose is a charter
 * that has not been tested. This module is that test.
 *
 * RELATIONSHIP TO escalation.ts — read this before changing either.
 *
 *   classify()      answers "WHO decides?" — it routes an action up the ladder.
 *   checkCharter()  answers "MAY this proceed at all, and at what floor?"
 *
 * They are deliberately INDEPENDENT implementations of overlapping invariants.
 * That redundancy is the point: if a future edit to classify() accidentally
 * downgrades the irreversible-or-money rule, the charter still catches it, and
 * the queen still routes to a human. Defense in depth beats a single spine.
 *
 * The composition rule is one-directional and absolute:
 *
 *   THE CHARTER MAY ONLY RAISE A GATE. IT MAY NEVER LOWER ONE.
 *
 * `raiseTo()` implements exactly that, and charter.test.ts proves it holds for
 * every action shape in the matrix. A charter that could lower a gate would be a
 * privilege-escalation vector wearing the language of safety.
 *
 * Nothing here executes an action, moves money, or fires a side effect.
 */

import type { Action, Decision } from './escalation';

/** The six clauses, in the order §13 states them (by how often they fail). */
export type ClauseId =
  | 'fail-closed' //         1. uncertainty resolves to the safe verdict
  | 'human-gate' //          2. humans commit the irreversible + capital
  | 'attribution' //         3. nothing runs with credit outstanding
  | 'sovereignty' //         4. the operator can read, export, and leave
  | 'refusal-visible' //     5. refusal is a first-class, reasoned, logged output
  | 'no-unbacked-claim'; //  6. capability claims trace to a ledger entry

/** A clause as carried in agent.md — text plus the reason it is load-bearing. */
export interface Clause {
  id: ClauseId;
  /** The normative sentence, as it appears in the Blessing Protocol §13. */
  text: string;
  /** Why this clause is the one that fails, in practice. */
  rationale: string;
}

/**
 * THE CHARTER. Frozen at module scope because it is inherited, never negotiated.
 *
 * §13.2: inherited downward and never relaxed downward. A coordinator may impose
 * STRICTER refusals on agents it spawns; it may never grant one a permission it
 * does not itself hold, and no session-level grant of autonomy reaches into this
 * list. Freezing makes "relax it at runtime" a TypeError rather than a bug.
 */
export const BENEVOLENCE_CHARTER: {
  readonly protocol: string;
  readonly version: string;
  readonly clauses: readonly Clause[];
} = Object.freeze({
  protocol: 'The Blessing Protocol §13',
  version: 'v0.2',
  clauses: Object.freeze([
    Object.freeze({
      id: 'fail-closed' as const,
      text: 'Uncertainty resolves to the safe verdict, never the permissive one.',
      rationale:
        'A missing value, an unparseable input, or an unreachable dependency must force the higher ' +
        'gate. Doubt is never resolved in favor of action.',
    }),
    Object.freeze({
      id: 'human-gate' as const,
      text:
        'Agents draft, verify, and gate. Humans commit anything that moves capital, sends outward, ' +
        'deletes, or otherwise cannot be undone.',
      rationale: 'Not delegable — not by escalation policy, and not by convenience.',
    }),
    Object.freeze({
      id: 'attribution' as const,
      text: 'No instrument operates in the system with attribution owed.',
      rationale:
        'A system that runs on uncredited work is not benevolent regardless of what it produces. ' +
        'Cheap to fix; expensive to the standard if tolerated.',
    }),
    Object.freeze({
      id: 'sovereignty' as const,
      text: 'The operator can read, export, and leave at any time. Ledgers stay plain text, append-only, locally owned.',
      rationale: 'No adopter may be held hostage by any implementation, including the reference ones.',
    }),
    Object.freeze({
      id: 'refusal-visible' as const,
      text: 'Refusal is a first-class output, surfaced with a reason a human can act on, and logged.',
      rationale:
        'A system that cannot say no is not safe; a system whose refusals are hidden is not honest.',
    }),
    Object.freeze({
      id: 'no-unbacked-claim' as const,
      text: 'What the system claims it can do traces to a blessing, a lineage record, or a passing test.',
      rationale: 'Overclaiming ends trust fastest, and it is the failure an eager agent commits most readily.',
    }),
  ]),
});

/**
 * Ledger-shaped facts the charter needs but an Action does not carry.
 *
 * Clauses 1, 2 and 5 are action-shaped — checkable from the proposal alone.
 * Clauses 3, 4 and 6 are ledger-shaped — they need the operator's lineage state.
 * Every field is optional and every DEFAULT IS THE SAFE ONE: an omitted context
 * asserts nothing and therefore blocks nothing, but an explicitly-bad value
 * refuses. Absent evidence is not treated as evidence of absence.
 */
export interface CharterContext {
  /**
   * Lineage ids/names whose attribution is still `owed` (Blessing Protocol §11.4).
   * Non-empty → clause 3 refuses until a record is appended.
   */
  attributionOwed?: readonly string[];
  /**
   * Capability claims this action would make public, each with the ledger refs
   * backing it (blessing id, lineage id, or test name). A claim with no refs
   * refuses under clause 6.
   */
  claims?: readonly { statement: string; backedBy: readonly string[] }[];
  /**
   * False when the action would put operator state somewhere they cannot read,
   * export, or walk away from. Refuses under clause 4.
   */
  exportable?: boolean;
}

/** Why a clause failed, and the one thing that would clear it. */
export interface Breach {
  clause: ClauseId;
  /** What is wrong, in one line a human can act on (clause 5). */
  reason: string;
  /** The specific remedy. Never "review this" — always the concrete next move. */
  remedy: string;
  /**
   * How the breach disposes of the action:
   *  - 'refuse' → does not proceed at any gate. A ledger defect no approval fixes.
   *  - 'raise'  → may proceed, but no lower than `floor`.
   */
  disposition: 'refuse' | 'raise';
  /** The decision floor imposed when disposition is 'raise'. */
  floor?: Decision;
}

/** The charter's verdict on one proposed action. */
export interface CharterVerdict {
  conforms: boolean;
  breaches: Breach[];
  /** True when at least one breach refuses outright. */
  refused: boolean;
  /** The highest floor any breach imposes, or null when none does. */
  floor: Decision | null;
}

/**
 * Severity order of the escalation tiers. Higher index = harder stop.
 * This is the ONLY place the ordering is encoded; raiseTo() depends on it.
 */
const SEVERITY: readonly Decision[] = ['autonomous', 'queen-gate', 'founder-board', 'human-gate'];

/** Rank of a decision. An unknown decision ranks highest — fail closed (clause 1). */
function rank(d: Decision | null): number {
  if (d === null) return -1;
  const i = SEVERITY.indexOf(d);
  return i === -1 ? SEVERITY.length : i;
}

/**
 * raiseTo() — combine a base decision with a charter floor, taking the HARDER of
 * the two. The charter can only tighten. This function is the guarantee.
 */
export function raiseTo(base: Decision, floor: Decision | null): Decision {
  return rank(floor) > rank(base) ? (floor as Decision) : base;
}

/** True when a value is a real boolean — not undefined, not a truthy string. */
function isBool(v: unknown): v is boolean {
  return typeof v === 'boolean';
}

/**
 * Action kinds that COMMIT rather than prepare: they cannot be undone once fired.
 * Mirrors ALWAYS_IRREVERSIBLE in escalation.ts on purpose — the duplication is the
 * independence that makes the charter a real second read (see the header note).
 */
const COMMIT_KINDS: readonly string[] = ['move-funds', 'delete', 'rename-url', 'rotate-key', 'send-blast'];

/**
 * SCOPE NOTE — why clause 2 does not fire on every `movesMoney` action.
 *
 * Clause 2 says humans *commit* what moves capital. Committing is not the same as
 * authorizing. This repo's spend-cap ladder (escalation.ts) deliberately lets the
 * Payments Queen authorize a quantified, in-cap charge behind mandate-verify +
 * cap-check + audit, and there is no transfer tool anywhere in the system for it
 * to settle with. The charter does not second-guess that contract — if it floored
 * every money-adjacent action at human-gate, the cap ladder would become dead code
 * and the charter would be rewriting doctrine under the banner of enforcing it.
 *
 * What the charter DOES independently assert is the irreversibility invariant, and
 * one hole the cap ladder alone can leave: money moving with no quantified cap.
 * An unquantified charge is doubt, and clause 1 sends doubt to a human.
 */
function unquantifiedMoney(action: Action): boolean {
  return action.movesMoney === true && (!Number.isFinite(action.amount) || !Number.isFinite(action.cap));
}

/**
 * checkCharter() — run a proposed action against all six clauses.
 *
 * Pure. No side effects, no I/O, no execution. Returns every breach found rather
 * than short-circuiting on the first, because an operator fixing one defect
 * should see the others in the same pass.
 */
export function checkCharter(action: Action | null | undefined, ctx: CharterContext = {}): CharterVerdict {
  const breaches: Breach[] = [];

  // ── Clause 1 — fail closed ────────────────────────────────────────────────
  // A missing action, or one whose safety-relevant fields are not real booleans,
  // is uncertainty. Uncertainty routes to a human; it never routes to action.
  if (!action) {
    breaches.push({
      clause: 'fail-closed',
      reason: 'No action was supplied to the charter gate.',
      remedy: 'Pass the proposed action. A null proposal is treated as maximally unsafe, not as a no-op.',
      disposition: 'raise',
      floor: 'human-gate',
    });
  } else {
    const unknownFields = (['irreversible', 'movesMoney', 'crossStream'] as const).filter(
      (f) => !isBool(action[f]),
    );
    if (unknownFields.length > 0) {
      breaches.push({
        clause: 'fail-closed',
        reason: `Safety fields are not declared as booleans: ${unknownFields.join(', ')}.`,
        remedy:
          `Set ${unknownFields.join(', ')} explicitly on the action. An undeclared safety field is ` +
          'doubt, and doubt takes the higher gate.',
        disposition: 'raise',
        floor: 'human-gate',
      });
    }

    // ── Clause 2 — human gate on the irreversible ───────────────────────────
    // An INDEPENDENT assertion of the invariant classify() also enforces. If the
    // two ever disagree, the queen takes the harder answer and a test fails.
    // Scope is deliberately irreversibility + commitment — see the note on
    // COMMIT_KINDS above for why `movesMoney` alone does not trip this.
    if (action.irreversible === true || COMMIT_KINDS.includes(action.kind)) {
      breaches.push({
        clause: 'human-gate',
        reason:
          'Action commits something that cannot be undone ' +
          `(kind=${action.kind}, irreversible=${String(action.irreversible)}).`,
        remedy: 'Prepare and verify it, then hand it to a human to commit. Agents never commit this class.',
        disposition: 'raise',
        floor: 'human-gate',
      });
    }

    // Clause 1 applied to money: a charge with no finite amount or cap is an
    // unquantified risk. The cap ladder fails it closed to founder-board; the
    // charter takes it one tier further, because "how much?" has no answer yet.
    if (unquantifiedMoney(action)) {
      breaches.push({
        clause: 'fail-closed',
        reason: `Money-moving action with no quantified amount/cap (amount=${String(action.amount)}, cap=${String(action.cap)}).`,
        remedy: 'Declare a finite amount and a finite cap on the action, or route it to a human to commit.',
        disposition: 'raise',
        floor: 'human-gate',
      });
    }
  }

  // ── Clause 3 — attribution honored ────────────────────────────────────────
  // A ledger defect. No approval tier makes uncredited work credited, so this
  // refuses outright — and the remedy takes about a minute.
  const owed = ctx.attributionOwed ?? [];
  if (owed.length > 0) {
    breaches.push({
      clause: 'attribution',
      reason: `${owed.length} instrument(s) in use with attribution owed: ${owed.join(', ')}.`,
      remedy:
        'Append an attribution record to palace/lineage.jsonl moving each to `honored` ' +
        '(Blessing Protocol §11.4), then re-run. No gate substitutes for paying the credit.',
      disposition: 'refuse',
    });
  }

  // ── Clause 4 — sovereignty ────────────────────────────────────────────────
  if (ctx.exportable === false) {
    breaches.push({
      clause: 'sovereignty',
      reason: 'Action would place operator state where it cannot be read, exported, or left behind.',
      remedy:
        'Keep the ledger plain text, append-only, and locally owned. If a hosted store is needed, ' +
        'the local copy remains authoritative.',
      disposition: 'refuse',
    });
  }

  // ── Clause 6 — no capability claim without a ledger entry ─────────────────
  const unbacked = (ctx.claims ?? []).filter((c) => (c.backedBy?.length ?? 0) === 0);
  if (unbacked.length > 0) {
    breaches.push({
      clause: 'no-unbacked-claim',
      reason: `${unbacked.length} capability claim(s) with no ledger backing: ` +
        unbacked.map((c) => `"${c.statement}"`).join(', ') + '.',
      remedy:
        'Back each claim with a blessing id, a lineage id, or a passing test name — or cut the claim. ' +
        'Trimming an overclaim is always cheaper than defending one.',
      disposition: 'refuse',
    });
  }

  // ── Clause 5 — refusal is a first-class output ────────────────────────────
  // Enforced structurally rather than as a check: every Breach above carries a
  // non-empty reason AND remedy, and charter.test.ts asserts that for all of
  // them. A refusal a human cannot act on would itself be a clause-5 breach.

  const floors = breaches.filter((b) => b.disposition === 'raise' && b.floor).map((b) => b.floor as Decision);
  const floor = floors.length === 0 ? null : floors.reduce((a, b) => (rank(b) > rank(a) ? b : a));

  return {
    conforms: breaches.length === 0,
    breaches,
    refused: breaches.some((b) => b.disposition === 'refuse'),
    floor,
  };
}

/**
 * explain() — render a verdict as lines a human can act on (clause 5).
 * Refusals must be legible, not merely correct.
 */
export function explain(verdict: CharterVerdict): string {
  if (verdict.conforms) return 'CHARTER OK — all six clauses hold.';
  return verdict.breaches
    .map((b) => {
      const tag = b.disposition === 'refuse' ? 'REFUSE' : `RAISE→${b.floor}`;
      return `CHARTER ${tag} [${b.clause}] ${b.reason} FIX: ${b.remedy}`;
    })
    .join('\n');
}
