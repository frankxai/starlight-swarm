/**
 * eval-harness.ts — a regression suite for the safety spine itself.
 *
 * The runtime already has unit tests, and they are good at the cases someone
 * thought of. What it did not have is the thing a governed agent system needs
 * most: a standing evaluation that re-derives the safety properties from the
 * REAL decision path — worker report → classify() → checkCharter() → Queen.decide()
 * — across the whole space of actions the type system admits, not just the
 * handful a test author enumerated.
 *
 * Two halves, because they fail differently.
 *
 *   SCENARIOS  are golden expectations. They pin specific, meaningful cases to
 *              specific verdicts, and they fail when behavior CHANGES.
 *
 *   INVARIANTS are properties swept over the full action matrix. They do not
 *              care what any single verdict is; they fail when a property that
 *              must hold everywhere stops holding somewhere. This is the half
 *              that catches the case nobody wrote a test for — which is, by
 *              construction, the case that gets shipped.
 *
 * Both are pure. Nothing here fires an action, touches an MCP, or writes a
 * ledger entry: the harness must be safe to run in a loop, in CI, on a laptop.
 */

import { checkCharter, raiseTo } from './charter';
import type { CharterContext, ClauseId } from './charter';
import { classify } from './escalation';
import type { Action, ActionKind, Decision, StreamId } from './escalation';
import { issueHandoff, verifyHandoff } from './handoff';
import { SwarmLedger } from './ledger';
import { Queen } from './queen';
import type { QueenDecision } from './queen';
import { sha256Digest } from './runtime-digest';
import { getStream, STREAMS } from './streams';

export type Verdict = QueenDecision['verdict'];

/** One pinned expectation about how the swarm must rule on one proposal. */
export interface GovernanceScenario {
  id: string;
  description: string;
  /** `null` exercises the fail-closed path where no proposal arrived at all. */
  action: Action | null;
  context?: CharterContext;
  expect: {
    /** The escalation spine's own answer, when the scenario pins it. */
    classification?: Decision;
    /** The tier actually applied after the charter floor is combined in. */
    effective: Decision;
    verdict: Verdict;
    refused?: boolean;
    /** Clause ids that MUST appear among the breaches. Extras are allowed. */
    clauses?: ClauseId[];
  };
}

export interface ObservedOutcome {
  classification: Decision;
  effective: Decision;
  verdict: Verdict;
  refused: boolean;
  clauses: ClauseId[];
}

export interface ScenarioResult {
  id: string;
  description: string;
  passed: boolean;
  /** One line per disagreement, phrased as expected-vs-observed. */
  mismatches: string[];
  observed: ObservedOutcome;
}

export interface InvariantResult {
  id: string;
  description: string;
  /** How many points of the action matrix the property was evaluated at. */
  checked: number;
  passed: boolean;
  /** Capped at MAX_REPORTED_VIOLATIONS — a broken property breaks loudly. */
  violations: string[];
  violationCount: number;
}

export interface EvalReport {
  ok: boolean;
  scenarios: { total: number; passed: number; failed: number; results: ScenarioResult[] };
  invariants: { total: number; passed: number; failed: number; results: InvariantResult[] };
  /**
   * A digest over every observed outcome. Stable across runs by construction —
   * two runs that disagree on this one hex string disagree about governance,
   * which makes it the cheapest possible regression signal in a diff.
   */
  digest: string;
}

const MAX_REPORTED_VIOLATIONS = 8;

/** Severity order, mirroring charter.ts. Used only to compare, never to decide. */
const SEVERITY: readonly Decision[] = ['autonomous', 'queen-gate', 'founder-board', 'human-gate'];
const severityRank = (d: Decision): number => {
  const i = SEVERITY.indexOf(d);
  return i === -1 ? SEVERITY.length : i;
};

/**
 * One queen per stream, built once and reused across the sweep.
 *
 * Reusing the real Queen rather than re-deriving the verdict mapping is the
 * point: a harness that reimplements the thing it audits agrees with itself
 * forever and tells you nothing.
 */
const QUEENS: Record<StreamId, Queen> = STREAMS.reduce((acc, spec) => {
  acc[spec.id] = new Queen(spec);
  return acc;
}, {} as Record<StreamId, Queen>);

function queenFor(action: Action | null): Queen {
  const stream = action ? getStream(action.stream)?.id ?? 'content' : 'content';
  return QUEENS[stream];
}

function decideFor(action: Action | null, context: CharterContext): QueenDecision {
  return queenFor(action).decide(
    {
      worker: 'eval-harness',
      stream: action?.stream ?? 'content',
      taskId: 'eval',
      // A null proposal is exactly the input clause 1 exists for; the cast
      // hands the spine the same undefined it would get from a real caller.
      proposed: action as Action,
      note: 'evaluation harness probe',
    },
    context,
  );
}

/** Run one proposal through the real decision path. */
export function observe(action: Action | null, context: CharterContext = {}): ObservedOutcome {
  const decision = decideFor(action, context);
  return {
    classification: decision.classification.decision,
    effective: decision.effective,
    verdict: decision.verdict,
    refused: decision.charter.refused,
    clauses: decision.charter.breaches.map((b) => b.clause),
  };
}

export function runScenario(scenario: GovernanceScenario): ScenarioResult {
  const observed = observe(scenario.action, scenario.context);
  const mismatches: string[] = [];
  const { expect } = scenario;

  if (expect.classification && observed.classification !== expect.classification) {
    mismatches.push(`classification: expected ${expect.classification}, observed ${observed.classification}`);
  }
  if (observed.effective !== expect.effective) {
    mismatches.push(`effective: expected ${expect.effective}, observed ${observed.effective}`);
  }
  if (observed.verdict !== expect.verdict) {
    mismatches.push(`verdict: expected ${expect.verdict}, observed ${observed.verdict}`);
  }
  if (expect.refused !== undefined && observed.refused !== expect.refused) {
    mismatches.push(`refused: expected ${expect.refused}, observed ${observed.refused}`);
  }
  for (const clause of expect.clauses ?? []) {
    if (!observed.clauses.includes(clause)) {
      mismatches.push(`clause ${clause}: expected among breaches, observed [${observed.clauses.join(', ') || 'none'}]`);
    }
  }

  return { id: scenario.id, description: scenario.description, passed: mismatches.length === 0, mismatches, observed };
}

/* ------------------------------------------------------------------ *
 * The action matrix the invariants sweep.
 * ------------------------------------------------------------------ */

const ALL_KINDS: readonly ActionKind[] = [
  'research',
  'draft',
  'bind-link',
  'schedule-post',
  'build-page',
  'payment',
  'new-rail',
  'new-vendor',
  'spend',
  'delete',
  'rename-url',
  'rotate-key',
  'send-blast',
  'move-funds',
];

const ALL_STREAMS: readonly StreamId[] = ['affiliate', 'products', 'content', 'payments'];

/**
 * Money shapes worth sweeping, including the two that have historically slipped
 * past naive comparisons: absent amounts and NaN. `NaN > cap` is false, so an
 * unguarded over-cap check reads a NaN charge as within cap.
 */
const MONEY_SHAPES: readonly Partial<Action>[] = [
  {},
  { amount: 40, cap: 100 },
  { amount: 500, cap: 100 },
  { amount: Number.NaN, cap: 100 },
  { amount: 40 },
];

/** Every action the type system admits, at the granularity that matters. */
export function actionMatrix(): Action[] {
  const actions: Action[] = [];
  for (const kind of ALL_KINDS) {
    for (const stream of ALL_STREAMS) {
      for (const irreversible of [false, true]) {
        for (const movesMoney of [false, true]) {
          for (const crossStream of [false, true]) {
            for (const money of MONEY_SHAPES) {
              actions.push({ kind, stream, irreversible, movesMoney, crossStream, ...money });
            }
          }
        }
      }
    }
  }
  return actions;
}

/** Kinds that commit rather than prepare. Mirrors charter.ts COMMIT_KINDS. */
const COMMIT_KINDS: readonly ActionKind[] = ['move-funds', 'delete', 'rename-url', 'rotate-key', 'send-blast'];

const KNOWN_CLAUSES: readonly ClauseId[] = [
  'fail-closed',
  'human-gate',
  'attribution',
  'sovereignty',
  'refusal-visible',
  'no-unbacked-claim',
];

function describeAction(a: Action): string {
  return (
    `${a.kind}/${a.stream} irreversible=${a.irreversible} money=${a.movesMoney} cross=${a.crossStream} ` +
    `amount=${String(a.amount)} cap=${String(a.cap)}`
  );
}

interface Property {
  id: string;
  description: string;
  /** Returns a violation message, or null when the property holds here. */
  check(action: Action): string | null;
}

const PROPERTIES: readonly Property[] = [
  {
    id: 'charter-only-raises',
    description: 'The charter may raise a gate and may never lower one, for every action in the matrix.',
    check(action) {
      const base = classify(action).decision;
      const effective = raiseTo(base, checkCharter(action).floor);
      return severityRank(effective) >= severityRank(base)
        ? null
        : `${describeAction(action)} — charter lowered ${base} to ${effective}`;
    },
  },
  {
    id: 'irreversible-never-acts',
    description: 'Nothing irreversible or commit-class ever earns the act verdict; it lands on a human.',
    check(action) {
      if (!action.irreversible && !COMMIT_KINDS.includes(action.kind)) return null;
      const { verdict, effective } = observe(action);
      if (verdict === 'act') return `${describeAction(action)} — irreversible action earned verdict act`;
      if (verdict !== 'refuse' && effective !== 'human-gate') {
        return `${describeAction(action)} — irreversible action settled at ${effective}, not human-gate`;
      }
      return null;
    },
  },
  {
    id: 'money-never-autonomous',
    description: 'Anything that declares it moves money clears at least a queen gate; autonomy never settles.',
    check(action) {
      // `movesMoney` is the authoritative signal, not the kind: escalation.ts
      // deliberately treats a `spend` PROPOSAL that moves nothing as a draft.
      if (!action.movesMoney && action.kind !== 'payment' && action.kind !== 'move-funds') return null;
      const { effective } = observe(action);
      return effective === 'autonomous' ? `${describeAction(action)} — money-moving action ruled autonomous` : null;
    },
  },
  {
    id: 'unquantified-money-reaches-a-human',
    description: 'A charge with no finite amount or cap is doubt, and doubt takes the human gate.',
    check(action) {
      if (!action.movesMoney) return null;
      if (Number.isFinite(action.amount) && Number.isFinite(action.cap)) return null;
      const { effective, verdict } = observe(action);
      return effective === 'human-gate' || verdict === 'refuse'
        ? null
        : `${describeAction(action)} — unquantified charge settled at ${effective}`;
    },
  },
  {
    id: 'undeclared-safety-field-fails-closed',
    description: 'Dropping any declared safety boolean routes the proposal to a human (clause 1).',
    check(action) {
      for (const field of ['irreversible', 'movesMoney', 'crossStream'] as const) {
        const degraded = { ...action };
        delete (degraded as Partial<Action>)[field];
        const { effective, verdict } = observe(degraded as Action);
        if (effective !== 'human-gate' && verdict !== 'refuse') {
          return `${describeAction(action)} — dropping ${field} settled at ${effective}, not human-gate`;
        }
      }
      return null;
    },
  },
  {
    id: 'breaches-are-actionable',
    description: 'Every breach names a known clause and carries a reason and a remedy a human can act on.',
    check(action) {
      const verdict = checkCharter(action, {
        attributionOwed: ['probe-instrument'],
        claims: [{ statement: 'probe claim', backedBy: [] }],
        exportable: false,
      });
      for (const b of verdict.breaches) {
        if (!KNOWN_CLAUSES.includes(b.clause)) return `${describeAction(action)} — unknown clause id ${b.clause}`;
        if (!b.reason?.trim()) return `${describeAction(action)} — breach ${b.clause} has no reason`;
        if (!b.remedy?.trim()) return `${describeAction(action)} — breach ${b.clause} has no remedy`;
        if (b.disposition === 'raise' && !b.floor) {
          return `${describeAction(action)} — breach ${b.clause} raises to no floor`;
        }
      }
      return null;
    },
  },
  {
    id: 'verdict-matches-effective-tier',
    description: 'The queen verdict is a faithful reading of the effective tier — no tier maps two ways.',
    check(action) {
      const { verdict, effective, refused } = observe(action);
      if (refused) return verdict === 'refuse' ? null : `${describeAction(action)} — refused but verdict ${verdict}`;
      const expected: Verdict =
        effective === 'autonomous' || effective === 'queen-gate'
          ? 'act'
          : effective === 'founder-board'
            ? 'escalate'
            : 'human';
      return verdict === expected ? null : `${describeAction(action)} — ${effective} mapped to ${verdict}, expected ${expected}`;
    },
  },
  {
    id: 'decisions-are-deterministic',
    description: 'The same proposal decided twice yields the same verdict — governance is not sampled.',
    check(action) {
      const first = sha256Digest(observe(action));
      const second = sha256Digest(observe(action));
      return first === second ? null : `${describeAction(action)} — two decisions disagreed (${first.slice(0, 8)} vs ${second.slice(0, 8)})`;
    },
  },
  {
    id: 'handoffs-are-issued-and-verifiable',
    description: 'Anything the queen cannot settle leaves as a packet that verifies at the tier it was ruled at.',
    check(action) {
      const decision = decideFor(action, {});
      const ledger = new SwarmLedger({ clock: () => '2026-01-01T00:00:00.000Z' });
      const entry = ledger.append({ kind: 'decision', actor: 'eval', subject: 'eval', summary: 'probe' });
      const packet = issueHandoff(
        decision,
        action,
        { queen: 'eval', worker: 'eval-harness', stream: action.stream, taskId: 'eval', task: 'probe' },
        entry,
        '2026-01-01T00:00:00.000Z',
      );

      if (decision.verdict === 'act' || decision.verdict === 'refuse') {
        return packet === null ? null : `${describeAction(action)} — a ${decision.verdict} verdict issued a handoff packet`;
      }
      if (packet === null) return `${describeAction(action)} — ${decision.effective} issued no packet for the gate to act on`;
      if (packet.gate !== decision.effective) {
        return `${describeAction(action)} — packet asks for ${packet.gate} on a ${decision.effective} ruling`;
      }
      const verification = verifyHandoff(packet, ledger.entries());
      return verification.valid
        ? null
        : `${describeAction(action)} — freshly issued packet failed verification: ${verification.defects.map((d) => d.code).join(', ')}`;
    },
  },
  {
    id: 'ledger-defects-outrank-approval',
    description: 'An unbacked claim or lost sovereignty refuses outright; no gate tier clears a ledger defect.',
    check(action) {
      const unbacked = observe(action, { claims: [{ statement: 'unbacked capability', backedBy: [] }] });
      if (unbacked.verdict !== 'refuse') {
        return `${describeAction(action)} — unbacked claim resolved to ${unbacked.verdict}`;
      }
      const captive = observe(action, { exportable: false });
      if (captive.verdict !== 'refuse') {
        return `${describeAction(action)} — non-exportable state resolved to ${captive.verdict}`;
      }
      return null;
    },
  },
];

export function runInvariants(matrix: Action[] = actionMatrix()): InvariantResult[] {
  return PROPERTIES.map((property) => {
    const violations: string[] = [];
    let violationCount = 0;
    for (const action of matrix) {
      const violation = property.check(action);
      if (violation === null) continue;
      violationCount += 1;
      if (violations.length < MAX_REPORTED_VIOLATIONS) violations.push(violation);
    }
    return {
      id: property.id,
      description: property.description,
      checked: matrix.length,
      passed: violationCount === 0,
      violations,
      violationCount,
    };
  });
}

export function evaluateGovernance(scenarios: readonly GovernanceScenario[]): EvalReport {
  const results = scenarios.map(runScenario);
  const invariants = runInvariants();
  const scenariosPassed = results.filter((r) => r.passed).length;
  const invariantsPassed = invariants.filter((r) => r.passed).length;

  return {
    ok: scenariosPassed === results.length && invariantsPassed === invariants.length,
    scenarios: {
      total: results.length,
      passed: scenariosPassed,
      failed: results.length - scenariosPassed,
      results,
    },
    invariants: {
      total: invariants.length,
      passed: invariantsPassed,
      failed: invariants.length - invariantsPassed,
      results: invariants,
    },
    digest: sha256Digest(results.map((r) => ({ id: r.id, observed: r.observed }))),
  };
}

/** Render a report for a terminal. Failures lead; passes are counted, not listed. */
export function formatReport(report: EvalReport): string {
  const lines: string[] = [];
  lines.push('  SWARM GOVERNANCE EVALUATION');
  lines.push(`  scenarios  ${report.scenarios.passed}/${report.scenarios.total} passed`);
  lines.push(
    `  invariants ${report.invariants.passed}/${report.invariants.total} held ` +
      `(swept over ${report.invariants.results[0]?.checked ?? 0} actions each)`,
  );
  lines.push(`  digest     ${report.digest}`);

  for (const result of report.scenarios.results) {
    if (result.passed) continue;
    lines.push('');
    lines.push(`  ✗ SCENARIO ${result.id} — ${result.description}`);
    for (const mismatch of result.mismatches) lines.push(`      ${mismatch}`);
  }

  for (const invariant of report.invariants.results) {
    if (invariant.passed) continue;
    lines.push('');
    lines.push(`  ✗ INVARIANT ${invariant.id} — ${invariant.description}`);
    lines.push(`      ${invariant.violationCount} violation(s); first ${invariant.violations.length}:`);
    for (const violation of invariant.violations) lines.push(`        ${violation}`);
  }

  lines.push('');
  lines.push(report.ok ? '  RESULT: PASS — the safety spine holds.' : '  RESULT: FAIL — governance regressed. Nothing ships on a red spine.');
  return lines.join('\n');
}
