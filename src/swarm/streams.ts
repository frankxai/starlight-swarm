/**
 * streams.ts — the four income streams, their queens, and worker rosters as
 * typed configuration.
 *
 * Source of truth: agentic-ops-hub/docs/AGENT-STACK.md ("Tier 2 — Stream Queens")
 * and ECOSYSTEM.md (L6 SWARM RUNTIME). This module is *data*, not behavior:
 * the cockpit and the dry-run both read this shape to render the
 * stream → queen → worker tree. No action fires from here.
 *
 * Model: hybrid queens-per-stream. Topology = queen-led per stream, mesh within
 * a stream. Queens never command across streams; they coordinate through the
 * founder (see queen.ts + escalation.ts).
 */

import type { StreamId } from './escalation';

/** A worker seat inside a stream. Reuses the `worker-specialist` harness. */
export interface WorkerSpec {
  /** Worker role name, per AGENT-STACK.md "Workers" column. */
  name: string;
  /** The single ACOS skill this worker is scoped to (IAM L3 — one job each). */
  skill: string;
  /** One-line job description. */
  does: string;
}

/** A queen seat. Reuses `queen-coordinator` + `hierarchical-coordinator`. */
export interface QueenSpec {
  /** Queen role name, per AGENT-STACK.md. */
  name: string;
  /** The harness patterns this queen reuses (claude-flow). */
  harness: string[];
  /** Ordered steps of the stream's self-improving loop. */
  selfImprovingLoop: string[];
}

/** A full income stream: one queen leading a mesh of workers. */
export interface StreamSpec {
  id: StreamId;
  /** Display label. */
  label: string;
  /** What the stream generates / governs. */
  purpose: string;
  /** The single queen leading this stream. */
  queen: QueenSpec;
  /** The worker mesh (peer-to-peer within the stream). */
  workers: WorkerSpec[];
  /** MCP servers this stream's agents touch (verify-only where money is near). */
  mcp: string[];
}

/** The founder agent seat — owns capital, thesis, and the irreversible gate. */
export interface FounderSpec {
  name: string;
  /** The governance gate the founder holds. */
  gate: string;
  /** What the founder owns (never delegated to autonomy). */
  owns: string[];
  /** Where the income thesis is sourced from. */
  thesisSource: string;
}

/**
 * Tier 1 — the founder. Reuses `starlight-orchestrator` (SIS) as the seat;
 * decisions pressure-tested by `/starlight-board`.
 */
export const FOUNDER: FounderSpec = {
  name: 'starlight-orchestrator',
  gate: '/starlight-board',
  owns: [
    'income thesis (which streams, what gate ladder)',
    'all capital allocation',
    'any irreversible action (new rail, contract, over-cap spend, structural change)',
    'conflict resolution between queens',
  ],
  thesisSource: 'SIS Wealth IS (/wealth-dpi, /wealth-thesis-review, /wealth-gate-progress)',
};

/**
 * Tier 2 + Tier 3 — the four streams, each a queen leading a worker mesh.
 * Mirrors the AGENT-STACK.md table exactly.
 */
export const STREAMS: StreamSpec[] = [
  {
    id: 'affiliate',
    label: 'Affiliate',
    purpose: 'Recurring affiliate revenue (agenticincome hub + agenticpassiveincome spoke).',
    queen: {
      name: 'Affiliate Queen',
      harness: ['queen-coordinator', 'hierarchical-coordinator'],
      selfImprovingLoop: ['audit', 'join programs', 'bind links', 'measure', 're-rank'],
    },
    workers: [
      { name: 'catalog-auditor', skill: 'affiliate-audit', does: 'audit the program catalog for fit + honesty' },
      { name: 'link-binder', skill: 'agentic-income', does: 'bind approved affiliate links (queen-gated)' },
      { name: 'disclosure-checker', skill: 'integrity-guard', does: 'verify FTC disclosure on every placement' },
      { name: 'ranker', skill: 'agentic-income', does: 're-rank programs by measured performance' },
    ],
    mcp: ['SIS Vault (append-only for workers, rw for queen)', 'Slack (escalation channel)'],
  },
  {
    id: 'products',
    label: 'Products',
    purpose: 'Digital products, templates, courses.',
    queen: {
      name: 'Products Queen',
      harness: ['queen-coordinator', 'hierarchical-coordinator'],
      selfImprovingLoop: ['gap-scan', 'build', 'price', 'launch', 'retro'],
    },
    workers: [
      { name: 'product-architect', skill: 'product-engine', does: 'scan gaps + spec the product' },
      { name: 'packager', skill: 'product-engine', does: 'package the build into shippable form' },
      { name: 'pricer', skill: 'model-revenue', does: 'model price points (no money movement)' },
      { name: 'launch-coordinator', skill: 'factory', does: 'sequence the launch (queen-gated publish)' },
    ],
    mcp: ['SIS Vault (append-only for workers, rw for queen)', 'Slack (escalation channel)'],
  },
  {
    id: 'content',
    label: 'Content',
    purpose: 'Traffic → trust → routing.',
    queen: {
      name: 'Content Queen',
      harness: ['queen-coordinator', 'hierarchical-coordinator'],
      selfImprovingLoop: ['top-queries', 'draft', 'gate', 'publish', 'learn'],
    },
    workers: [
      { name: 'researcher', skill: 'research', does: 'surface top queries + signals' },
      { name: 'writer', skill: 'article-creator', does: 'draft the piece (not public until gated)' },
      { name: 'hook-engineer', skill: 'hook', does: 'engineer tri-modal hooks' },
      { name: 'distributor', skill: 'generate-social', does: 'draft platform variants (queen-gated publish)' },
    ],
    mcp: ['SIS Vault (append-only for workers, rw for queen)', 'Slack (escalation channel)'],
  },
  {
    id: 'payments',
    label: 'Payments',
    purpose: 'Authorization + settlement governance (the money control surface).',
    queen: {
      name: 'Payments Queen',
      harness: ['queen-coordinator', 'hierarchical-coordinator'],
      selfImprovingLoop: ['propose-charge', 'verify mandate', 'check cap', 'settle', 'audit'],
    },
    workers: [
      { name: 'mandate-verifier', skill: 'agentic-payments', does: 'verify AP2 mandate (verify-only MCP)' },
      { name: 'spend-cap-enforcer', skill: 'agentic-payments', does: 'enforce per-tx/day/stream caps' },
      { name: 'settlement-auditor', skill: 'agentic-payments', does: 'write the append-only audit entry' },
      { name: 'fraud-sentinel', skill: 'agentic-payments', does: 'flag anomalies + replay attempts' },
    ],
    // ONLY the Payments stream touches the Payments MCP, and only verify-only tools (IAM L3).
    mcp: [
      'SIS Vault (append-only for workers, rw for queen)',
      'Payments MCP (verify-only: verify_mandate / check_spend_cap / record_audit_entry / require_human_approval)',
      'Slack (escalation channel)',
    ],
  },
];

/** Lookup a stream spec by id. */
export function getStream(id: StreamId): StreamSpec | undefined {
  return STREAMS.find((s) => s.id === id);
}

/**
 * A plain JSON-serializable snapshot of the founder/queen/worker tree.
 * The cockpit (page + static HTML) reads this shape — no logic, no side effects.
 */
export function swarmTree() {
  return {
    founder: FOUNDER,
    streams: STREAMS.map((s) => ({
      id: s.id,
      label: s.label,
      purpose: s.purpose,
      queen: s.queen.name,
      loop: s.queen.selfImprovingLoop,
      workers: s.workers.map((w) => ({ name: w.name, skill: w.skill, does: w.does })),
      mcp: s.mcp,
    })),
  };
}
