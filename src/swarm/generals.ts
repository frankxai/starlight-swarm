/**
 * generals.ts — the role contract of the Starlight Queen's swarm, as data.
 *
 * One Queen leads Domain Generals; Generals lead Specialists; Specialists
 * dispatch Workers. Every tier may propose; only the tiers named in
 * ROLE_CONTRACTS may dispatch, and no tier commits an irreversible action
 * (that stays with the escalation spine in escalation.ts + charter.ts).
 *
 * The five Domain Generals and the three-tier model matrix are vendored from
 * the Starlight Intelligence System swarm-command module so this kernel
 * carries the same identities without depending on SIS:
 *   repo   frankxai/Starlight-Intelligence-System
 *   path   src/queen/swarm-command.ts
 *   commit 8d9c0173076ce2f83a7a65d8454421a835eccd21
 * When that module ships as a package export, this file becomes a re-export.
 *
 * Governance modes are absorbed from the retired hive-mind queen-coordinator
 * definition. What was kept: three modes and the default budget split. What
 * was dropped: coup prevention, triple-vote arbitration, Byzantine consensus.
 * Emergency mode is not a shortcut around the gate: it is gated behind the
 * human tier precisely because that is when a shortcut would be taken.
 *
 * Nothing here executes. Data and pure predicates only.
 */

import type { Decision } from './escalation';

/** Provenance of the vendored shapes below. Recorded, not asserted. */
export const GENERALS_SOURCE = Object.freeze({
  repo: 'frankxai/Starlight-Intelligence-System',
  path: 'src/queen/swarm-command.ts',
  commit: '8d9c0173076ce2f83a7a65d8454421a835eccd21',
});

/** The four tiers of the swarm, top to bottom. */
export type RoleTier = 'queen' | 'general' | 'specialist' | 'worker';

export type DomainGeneralId =
  | 'starlight-architect'
  | 'starlight-weaver'
  | 'starlight-sentinel'
  | 'starlight-sage'
  | 'starlight-hermes';

export type SwarmModelTier = 'scout' | 'build' | 'council';

export interface DomainGeneralProfile {
  id: DomainGeneralId;
  title: string;
  domain: string;
  defaultTier: SwarmModelTier;
  invariants: string[];
  requiredGates: string[];
}

export interface SwarmModelSelection {
  tier: SwarmModelTier;
  primaryModel: string;
  fallbackModel: string;
}

/** Vendored verbatim from GENERALS_SOURCE. Identities, not behaviour. */
export const DOMAIN_GENERALS: Readonly<Record<DomainGeneralId, DomainGeneralProfile>> = Object.freeze({
  'starlight-architect': {
    id: 'starlight-architect',
    title: 'General of Architecture and Substrate',
    domain: 'architecture',
    defaultTier: 'build',
    invariants: [
      'Preserve backward-compatible TypeScript exports and SIP v1.1.1 protocol contracts.',
      'Prefer simple interfaces with deterministic internal state transitions.',
    ],
    requiredGates: ['npm test', 'symmetry-suites'],
  },
  'starlight-weaver': {
    id: 'starlight-weaver',
    title: 'General of Customer Experience and Design Excellence',
    domain: 'experience-design',
    defaultTier: 'build',
    invariants: [
      'Enforce sentence-case headings and Starlight editorial voice without generated prestige filler.',
      'Preserve responsive layout stability, keyboard navigation, and reduced-motion states.',
    ],
    requiredGates: ['design-contract', 'editorial-contract'],
  },
  'starlight-sentinel': {
    id: 'starlight-sentinel',
    title: 'General of Security, Governance and Fail-Closed Safety',
    domain: 'security-governance',
    defaultTier: 'council',
    invariants: [
      'Money and high-risk paths fail closed and never arm auto-merge.',
      'Enforce maker-checker independence on every review receipt.',
    ],
    requiredGates: ['merge-review-tests', 'independent-review-policy'],
  },
  'starlight-sage': {
    id: 'starlight-sage',
    title: 'General of Memory Vaults, Evals and Knowledge Synthesis',
    domain: 'memory-evals',
    defaultTier: 'build',
    invariants: [
      'Keep event-sourced JSONL vaults append-only with verifiable provenance.',
      'Ground claims in metrics/current.json with explicit verification timestamps.',
    ],
    requiredGates: ['vault-integrity', 'alexandria-tests'],
  },
  'starlight-hermes': {
    id: 'starlight-hermes',
    title: 'General of Cross-Repo Reconnaissance and Live Documentation',
    domain: 'reconnaissance',
    defaultTier: 'scout',
    invariants: [
      'Ground framework and SDK usage in Context7 live documentation before code synthesis.',
      'Deduplicate findings across repositories with exact file and commit provenance.',
    ],
    requiredGates: ['repo-bridge-check'],
  },
});

/** Vendored verbatim from GENERALS_SOURCE. Model ids are data the router reads. */
export const SWARM_MODEL_MATRIX: Readonly<Record<SwarmModelTier, SwarmModelSelection>> = Object.freeze({
  scout: { tier: 'scout', primaryModel: 'gemini-2.5-flash', fallbackModel: 'deepseek-v3.2' },
  build: { tier: 'build', primaryModel: 'claude-sonnet-4-6', fallbackModel: 'gpt-5.4' },
  council: { tier: 'council', primaryModel: 'claude-opus-4-6', fallbackModel: 'gpt-5.4-pro' },
});

export const DOMAIN_GENERAL_IDS = Object.freeze(Object.keys(DOMAIN_GENERALS) as DomainGeneralId[]);

export function isDomainGeneralId(value: unknown): value is DomainGeneralId {
  return typeof value === 'string' && (DOMAIN_GENERAL_IDS as readonly string[]).includes(value);
}

/**
 * The C-suite Generals compiled in Agentic Creator OS are lenses a decision is
 * read through, not seats that dispatch. A Domain General may apply any lens;
 * a lens never holds a budget or a tool.
 */
export const GOVERNANCE_LENSES = Object.freeze([
  'ceo', 'cfo', 'cto', 'caio', 'coo', 'cpo', 'cmo', 'cco', 'chro',
] as const);
export type GovernanceLens = (typeof GOVERNANCE_LENSES)[number];

/** What each tier may do. Dispatch flows down only; nothing dispatches up or sideways. */
export interface RoleContract {
  tier: RoleTier;
  /** Tiers this tier may hand a Brief to. */
  mayDispatch: readonly RoleTier[];
  /** Whether this tier may hold a budget of its own (workers never do). */
  holdsBudget: boolean;
  /** Who credits this tier's completed work. Never itself. */
  creditedBy: readonly RoleTier[];
}

export const ROLE_CONTRACTS: Readonly<Record<RoleTier, RoleContract>> = Object.freeze({
  queen: { tier: 'queen', mayDispatch: ['general', 'specialist', 'worker'], holdsBudget: true, creditedBy: ['queen'] },
  general: { tier: 'general', mayDispatch: ['specialist', 'worker'], holdsBudget: true, creditedBy: ['queen'] },
  specialist: { tier: 'specialist', mayDispatch: ['worker'], holdsBudget: true, creditedBy: ['general', 'queen'] },
  worker: { tier: 'worker', mayDispatch: [], holdsBudget: false, creditedBy: ['specialist', 'general', 'queen'] },
});

/** True when `from` may hand a Brief to `to`. A tier never dispatches to itself. */
export function canDispatch(from: RoleTier, to: RoleTier): boolean {
  return ROLE_CONTRACTS[from].mayDispatch.includes(to);
}

/**
 * The queen's crediting rule: the queen is credited by an independent checker,
 * which this table models as the 'queen' tier of a *different* actor. The
 * identity check itself lives in brief.ts (verifierIsIndependent).
 */

/** How the Queen coordinates her Generals. */
export type GovernanceMode = 'hierarchical' | 'democratic' | 'emergency';

export interface GovernanceModeSpec {
  mode: GovernanceMode;
  description: string;
  /** The escalation tier any switch INTO this mode must clear first. */
  entryDecision: Decision;
}

export const GOVERNANCE_MODES: Readonly<Record<GovernanceMode, GovernanceModeSpec>> = Object.freeze({
  hierarchical: {
    mode: 'hierarchical',
    description: 'Queen briefs, Generals lead, verifier credits. The default.',
    entryDecision: 'autonomous',
  },
  democratic: {
    mode: 'democratic',
    description: 'Generals each return a verdict; the Queen records the spread and decides. Used for design choices, never for money.',
    entryDecision: 'queen-gate',
  },
  emergency: {
    mode: 'emergency',
    description: 'Scope collapses to one General and a stop plan. Entered only through the human gate, because emergencies are when gates get skipped.',
    entryDecision: 'human-gate',
  },
});

/**
 * Default budget split across the swarm, in percent. Absorbed from the retired
 * hive-mind definition; it is a Brief default, not a rule — a Brief may
 * override it, and validateBrief() only requires the parts to sum to 100.
 */
export interface BudgetSplit {
  collective: number;
  workers: number;
  scouts: number;
  memory: number;
}

export const DEFAULT_BUDGET_SPLIT: Readonly<BudgetSplit> = Object.freeze({
  collective: 30,
  workers: 40,
  scouts: 20,
  memory: 10,
});

export function budgetSplitProblems(split: unknown): string[] {
  const problems: string[] = [];
  if (!split || typeof split !== 'object') return ['budget.split must be an object'];
  const s = split as Record<string, unknown>;
  let total = 0;
  for (const key of ['collective', 'workers', 'scouts', 'memory'] as const) {
    const v = s[key];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
      problems.push(`budget.split.${key} must be a finite number >= 0`);
    } else {
      total += v;
    }
  }
  if (problems.length === 0 && total !== 100) problems.push(`budget.split must sum to 100 (got ${total})`);
  return problems;
}
