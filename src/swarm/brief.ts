/**
 * brief.ts — the unit of dispatch. Nothing is handed to a General, Specialist
 * or Worker without a Brief, and a Brief is complete or it is refused.
 *
 * The shape follows the finding that most multi-agent variance is explained
 * by what the lead wrote down before dispatch: objective, output contract,
 * tools, boundaries, budget. It extends the QueenSessionMission shape used
 * by the Starlight Intelligence System (id, objective, acceptance, capabilities,
 * maxCostUsd, timeoutMs, maxOutputBytes, maxPromptBytes) so a Brief can be
 * handed to that runtime unchanged — see toQueenSessionMission().
 *
 * Two invariants live here and nowhere else:
 *   1. completeness — briefProblems() returns [] or the Brief is not dispatched;
 *   2. verifier independence — the actor who credits the work is not the actor
 *      who did it, by identity AND by model when both are named (Maker ≠ Checker).
 *
 * Pure. No I/O, no clock beyond what the caller passes in.
 */

import type { StreamId } from './escalation';
import type { BudgetSplit, DomainGeneralId, GovernanceMode, RoleTier } from './generals';
import { budgetSplitProblems, DEFAULT_BUDGET_SPLIT, isDomainGeneralId } from './generals';

export const BRIEF_SCHEMA = 'starlight.queen-brief.v1';

/** An actor on either side of the maker/checker line. */
export interface BriefActor {
  /** Stable id: an agent id, a harness session, a person's handle. */
  id: string;
  /** Model id as the provider names it, when the actor is a model. */
  model?: string;
  provider?: string;
  tier?: RoleTier;
}

export interface BriefBudget {
  /** Spend ceiling in micro-USD (1 USD = 1_000_000). Integers only; no doubt about cents. */
  microUsd: number;
  /** Wall-clock ceiling for the whole dispatch. */
  wallTimeMs: number;
  /** How the ceiling is split across the swarm. Defaults to DEFAULT_BUDGET_SPLIT. */
  split?: BudgetSplit;
}

export type BriefOutputFormat = 'markdown' | 'json' | 'diff' | 'files' | 'receipt';

export interface BriefOutputContract {
  format: BriefOutputFormat;
  /** Hard cap on the produced artifact; the verifier refuses larger output. */
  maxBytes: number;
  /** Schema id or path the verifier validates `json` output against. */
  schema?: string;
}

export interface Brief {
  schema: typeof BRIEF_SCHEMA;
  id: string;
  /** One sentence. What done looks like, not how to get there. */
  objective: string;
  /** Checkable statements. A verifier re-runs these; it never takes them on trust. */
  acceptance: string[];
  output: BriefOutputContract;
  /** Tool allowlist. Empty means read-only reasoning with no tools. */
  tools: string[];
  /** What the actor must not do. At least one line, always. */
  boundaries: string[];
  budget: BriefBudget;
  maker: BriefActor;
  /** Who credits the result. Independent of the maker — see verifierIsIndependent(). */
  verifier: BriefActor;
  /**
   * Exact command strings the verifier may re-run. Exact match, no globs; the
   * verify contract (verify-contract.ts) refuses anything outside this list.
   */
  allowedChecks: string[];
  /** Which Domain General leads. Optional for a worker-only brief. */
  general?: DomainGeneralId;
  governance?: GovernanceMode;
  stream?: StreamId;
  /** Taste pack the output is judged against (design.md / taste.md ids). */
  tastePack?: string;
  /** Prompt-size ceiling handed to the runtime. */
  maxPromptBytes?: number;
}

const SHELL_META = /[;&|`$<>]/;

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

function isStringList(v: unknown): v is string[] {
  return Array.isArray(v) && v.every(isNonEmptyString);
}

function isPositiveInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

function actorProblems(actor: unknown, label: string): string[] {
  if (!actor || typeof actor !== 'object') return [`${label} is missing`];
  const a = actor as Record<string, unknown>;
  const problems: string[] = [];
  if (!isNonEmptyString(a.id)) problems.push(`${label}.id is missing`);
  if (a.model !== undefined && !isNonEmptyString(a.model)) problems.push(`${label}.model must be a non-empty string when set`);
  return problems;
}

/**
 * Maker ≠ Checker. Independent when the ids differ and, when both name a
 * model, the models differ too. A checker without a named model is a human
 * or a policy and passes on identity alone.
 */
export function verifierIsIndependent(maker: BriefActor, verifier: BriefActor): boolean {
  if (!maker?.id || !verifier?.id) return false;
  if (maker.id === verifier.id) return false;
  if (maker.model && verifier.model && maker.model === verifier.model) return false;
  return true;
}

/** Every reason a Brief may not be dispatched. Empty means dispatchable. */
export function briefProblems(brief: unknown): string[] {
  if (!brief || typeof brief !== 'object') return ['brief is not an object'];
  const b = brief as Record<string, unknown>;
  const problems: string[] = [];

  if (b.schema !== BRIEF_SCHEMA) problems.push(`schema is ${JSON.stringify(b.schema)}, expected ${BRIEF_SCHEMA}`);
  if (!isNonEmptyString(b.id)) problems.push('id is missing');
  if (!isNonEmptyString(b.objective)) problems.push('objective is missing');
  if (!isStringList(b.acceptance) || b.acceptance.length === 0) problems.push('acceptance needs at least one checkable statement');
  if (!Array.isArray(b.tools) || !b.tools.every(isNonEmptyString)) problems.push('tools must be a list of tool names (empty is allowed)');
  if (!isStringList(b.boundaries) || b.boundaries.length === 0) problems.push('boundaries needs at least one line');

  if (!b.output || typeof b.output !== 'object') {
    problems.push('output contract is missing');
  } else {
    const o = b.output as Record<string, unknown>;
    if (!['markdown', 'json', 'diff', 'files', 'receipt'].includes(o.format as string)) problems.push(`output.format ${JSON.stringify(o.format)} is not known`);
    if (!isPositiveInt(o.maxBytes)) problems.push('output.maxBytes must be a positive integer');
    if (o.format === 'json' && !isNonEmptyString(o.schema)) problems.push('output.schema is required for json output');
  }

  if (!b.budget || typeof b.budget !== 'object') {
    problems.push('budget is missing');
  } else {
    const bud = b.budget as Record<string, unknown>;
    if (!isPositiveInt(bud.microUsd)) problems.push('budget.microUsd must be a positive integer');
    if (!isPositiveInt(bud.wallTimeMs)) problems.push('budget.wallTimeMs must be a positive integer');
    if (bud.split !== undefined) problems.push(...budgetSplitProblems(bud.split));
  }

  problems.push(...actorProblems(b.maker, 'maker'));
  problems.push(...actorProblems(b.verifier, 'verifier'));
  if (problems.every((p) => !p.startsWith('maker') && !p.startsWith('verifier'))) {
    if (!verifierIsIndependent(b.maker as BriefActor, b.verifier as BriefActor)) {
      problems.push('verifier is not independent of maker (same id or same model)');
    }
  }

  if (!Array.isArray(b.allowedChecks) || !b.allowedChecks.every(isNonEmptyString)) {
    problems.push('allowedChecks must be a list of exact command strings (empty is allowed)');
  } else {
    for (const c of b.allowedChecks) {
      if (/[*?[\]{}]/.test(c)) problems.push(`allowedChecks entry is a pattern, not a command: ${JSON.stringify(c)}`);
      if (SHELL_META.test(c)) problems.push(`allowedChecks entry carries shell metacharacters: ${JSON.stringify(c)}`);
    }
  }

  if (b.general !== undefined && !isDomainGeneralId(b.general)) problems.push(`general ${JSON.stringify(b.general)} is not a Domain General`);
  if (b.governance !== undefined && !['hierarchical', 'democratic', 'emergency'].includes(b.governance as string)) {
    problems.push(`governance ${JSON.stringify(b.governance)} is not a mode`);
  }
  if (b.maxPromptBytes !== undefined && !isPositiveInt(b.maxPromptBytes)) problems.push('maxPromptBytes must be a positive integer when set');

  return problems;
}

export interface BriefValidation {
  ok: boolean;
  problems: string[];
}

export function validateBrief(brief: unknown): BriefValidation {
  const problems = briefProblems(brief);
  return { ok: problems.length === 0, problems };
}

/** Fill the defaults a hand-written Brief usually omits. Does not make an invalid Brief valid. */
export function withBriefDefaults(partial: Omit<Brief, 'schema'> & { schema?: typeof BRIEF_SCHEMA }): Brief {
  return {
    ...partial,
    schema: BRIEF_SCHEMA,
    governance: partial.governance ?? 'hierarchical',
    budget: { ...partial.budget, split: partial.budget.split ?? { ...DEFAULT_BUDGET_SPLIT } },
  };
}

/**
 * The QueenSessionMission shape the Starlight Intelligence System runtime
 * consumes (src/queen-session.ts). A Brief is a strict superset; this adapter
 * drops what that runtime does not read and converts the budget units.
 */
export interface QueenSessionMission {
  id: string;
  objective: string;
  acceptance: string[];
  capabilities: string[];
  maxCostUsd: number;
  timeoutMs: number;
  maxOutputBytes: number;
  maxPromptBytes?: number;
}

export function toQueenSessionMission(brief: Brief): QueenSessionMission {
  const problems = briefProblems(brief);
  if (problems.length) throw new Error(`brief is incomplete: ${problems.join('; ')}`);
  return {
    id: brief.id,
    objective: brief.objective,
    acceptance: [...brief.acceptance],
    capabilities: [...brief.tools],
    maxCostUsd: brief.budget.microUsd / 1_000_000,
    timeoutMs: brief.budget.wallTimeMs,
    maxOutputBytes: brief.output.maxBytes,
    ...(brief.maxPromptBytes !== undefined ? { maxPromptBytes: brief.maxPromptBytes } : {}),
  };
}
