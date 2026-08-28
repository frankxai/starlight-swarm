/**
 * absorption.ts — research and sibling-stack patterns this repo absorbs.
 *
 * Absorption means: take the pattern, attribute the source, map it onto an
 * existing Starlight primitive, and refuse the parts that would weaken the
 * charter or create a second Queen.
 *
 * It does not mean: vendor their runtime, copy their OAuth, or claim we are
 * them. Clause 3 (attribution) and clause 6 (no unbacked claim) both apply.
 */

export type AbsorptionDisposition =
  | 'absorb-pattern'
  | 'already-absorbed'
  | 'cite-only'
  | 'reject-as-authority'
  | 'watch';

export type StarlightSeat =
  | 'topology'
  | 'team-cell'
  | 'handoff'
  | 'hand-sidecar'
  | 'charter'
  | 'control-plane'
  | 'durable-runtime'
  | 'model-router'
  | 'observatory';

export interface AbsorptionSource {
  project: string;
  url: string;
  license: string;
  notes: string;
}

export interface AbsorbedPrimitive {
  id: string;
  name: string;
  source: AbsorptionSource;
  mapsTo: StarlightSeat;
  disposition: AbsorptionDisposition;
  pattern: string;
  refuse: string;
  safetyNote: string;
}

export const ABSORPTION_LEDGER: readonly AbsorbedPrimitive[] = [
  {
    id: 'ruflo-topologies',
    name: 'Ruflo / Claude-Flow topologies + anti-drift defaults',
    source: {
      project: 'ruvnet/ruflo',
      url: 'https://github.com/ruvnet/ruflo',
      license: 'MIT (upstream; verify on bump)',
      notes: 'Formerly claude-flow. Hierarchical, mesh, hierarchical-mesh, ring, star, adaptive. Anti-drift: max 6–8 agents, specialized roles, Raft for leader state.',
    },
    mapsTo: 'topology',
    disposition: 'absorb-pattern',
    pattern: 'Queen-led hierarchical outer + mesh inside a stream. Team cells stay 3–5 roles (coordinator, maker, independent verifier) and never grow past the anti-drift band without a founder gate.',
    refuse: 'Ruflo consensus is not Queen authority. Raft/BFT/Gossip never admit a worker or move money.',
    safetyNote: 'Topology is a coordination choice. Admission and capital stay on classify() + checkCharter().',
  },
  {
    id: 'ruflo-hive-mind',
    name: 'Hive-mind queen with worker reports',
    source: {
      project: 'ruvnet/ruflo',
      url: 'https://github.com/ruvnet/ruflo/wiki/Hive-Mind',
      license: 'MIT (upstream; verify on bump)',
      notes: 'Queen assigns, workers report, queen keeps authoritative state.',
    },
    mapsTo: 'team-cell',
    disposition: 'already-absorbed',
    pattern: 'Queen class + worker mesh + founder for cross-stream. Already the L6 model.',
    refuse: 'Do not add a second hive-mind scheduler beside Hermes/Queen.',
    safetyNote: 'Workers never self-gate. Queens never command across streams.',
  },
  {
    id: 'omo-team-mode',
    name: 'oh-my-openagent Team Mode + hostile critics',
    source: {
      project: 'code-yeongyu/oh-my-openagent',
      url: 'https://github.com/code-yeongyu/oh-my-openagent',
      license: 'Upstream license; verify on bump',
      notes: 'Lead + up to 8 parallel members. hyperplan uses five hostile critics. Multi-harness layering (OpenCode, Codex, Pi).',
    },
    mapsTo: 'team-cell',
    disposition: 'absorb-pattern',
    pattern: 'Independent verifier cannot be the maker. Optional critic council maps to GStack. Multi-harness is an adapter seat, not a new Queen.',
    refuse: 'Do not absorb OAuth-token or provider-login patterns. Do not grant team_* tools that bypass classify().',
    safetyNote: 'Parallel members still report findings. The Queen decides act-vs-escalate.',
  },
  {
    id: 'omo-ulw-loop',
    name: 'oh-my-openagent ulw-loop / ultrawork persistence',
    source: {
      project: 'code-yeongyu/oh-my-openagent',
      url: 'https://github.com/code-yeongyu/oh-my-openagent',
      license: 'Upstream license; verify on bump',
      notes: 'Persistent work loops with continuation. Powerful and easy to leave running.',
    },
    mapsTo: 'topology',
    disposition: 'absorb-pattern',
    pattern: 'Maps to Ruflow: bounded cycle on a goal until objective, budget, or explicit stop. Queen owns the cadence.',
    refuse: 'No Hand may set max_iterations / continuous hourly mode. No worker creates its own schedule.',
    safetyNote: 'Relentless flow without a stop condition is a Paperclip without a valve.',
  },
  {
    id: 'openai-swarm-handoff',
    name: 'OpenAI Swarm agent + handoff',
    source: {
      project: 'openai/swarm',
      url: 'https://github.com/openai/swarm',
      license: 'MIT',
      notes: 'Educational. Superseded by the OpenAI Agents SDK. Two primitives: Agent and handoff.',
    },
    mapsTo: 'handoff',
    disposition: 'absorb-pattern',
    pattern: 'A Hand is the typed, fail-closed handoff envelope. Agents do not pass raw conversation control; they pass a bounded contract.',
    refuse: 'Stateless client-side handoff is not a substitute for SIS memory or Temporal identity.',
    safetyNote: 'Handoff without a receipt is a missing audit entry.',
  },
  {
    id: 'openai-agents-sdk',
    name: 'OpenAI Agents SDK guardrails + tracing',
    source: {
      project: 'openai/openai-agents-python',
      url: 'https://github.com/openai/openai-agents-python',
      license: 'MIT',
      notes: 'Production evolution of Swarm: guardrails, tracing, state.',
    },
    mapsTo: 'observatory',
    disposition: 'watch',
    pattern: 'Guardrails map to charter + classify. Tracing maps to Langfuse/OTel (ADR).',
    refuse: 'Do not dual-primary LangSmith + Langfuse. Do not treat SDK guardrails as a replacement for checkCharter().',
    safetyNote: 'Watch. Adopt only as a worker-library, never as Queen.',
  },
  {
    id: 'openfang-sidecar',
    name: 'OpenFang reactive sidecar',
    source: {
      project: 'RightNow-AI/openfang',
      url: 'https://github.com/RightNow-AI/openfang',
      license: 'Upstream license; verify on bump',
      notes: 'v0.6.9: max_iterations becomes hourly Continuous. Empty allowlists mean all tools.',
    },
    mapsTo: 'hand-sidecar',
    disposition: 'already-absorbed',
    pattern: 'starlight.hand.v1 + OpenFang compiler. Reactive only. enabled=false by default.',
    refuse: 'OpenFang is never Queen, scheduler, or SIS writer.',
    safetyNote: 'Compiled and blocked. See hands/OPENFANG-PILOT.md.',
  },
  {
    id: 'bless-charter',
    name: 'Blessing Protocol §13',
    source: {
      project: 'frankxai/bless',
      url: 'https://github.com/frankxai/bless',
      license: 'See upstream',
      notes: 'Six non-waivable clauses. Executable form is charter.ts.',
    },
    mapsTo: 'charter',
    disposition: 'already-absorbed',
    pattern: 'checkCharter() + raiseTo(). May only raise a gate.',
    refuse: 'No session grant relaxes a clause.',
    safetyNote: 'Tested. Code wins if prose and code disagree.',
  },
  {
    id: 'hermes-control-plane',
    name: 'Hermes as control plane',
    source: {
      project: 'NousResearch Hermes Agent',
      url: 'https://hermes-agent.nousresearch.com/docs/user-guide/features/kanban',
      license: 'Upstream',
      notes: 'Human interface, scheduler, existing Codex runtime.',
    },
    mapsTo: 'control-plane',
    disposition: 'already-absorbed',
    pattern: 'Queen owns admission and schedule requests. Hermes is the operator seat. Workers are reactive.',
    refuse: 'Hermes cron must not become an independent mission scheduler.',
    safetyNote: 'ADR 2026-08-06. Local Hermes is not an HA promise.',
  },
  {
    id: 'temporal-railway',
    name: 'Temporal on Railway as durable backbone',
    source: {
      project: 'temporalio/temporal',
      url: 'https://docs.temporal.io/workflows',
      license: 'MIT',
      notes: 'Durable missions, retries, timers, workflow identity.',
    },
    mapsTo: 'durable-runtime',
    disposition: 'cite-only',
    pattern: 'Prepared bundles emit task queues, workflow-ID prefixes, leases, kill-switch names. They do not start Temporal.',
    refuse: 'Prepared JSON is not activation. Health unknown ⇒ not admitted.',
    safetyNote: 'Phase 0 complete. Phase 1 requires trusted authority (issue #15).',
  },
  {
    id: 'vercel-eve',
    name: 'Vercel Eve interactive specialist',
    source: {
      project: 'vercel/eve',
      url: 'https://github.com/vercel/eve',
      license: 'Upstream',
      notes: 'Interactive TypeScript agent service. Own schedules and memory.',
    },
    mapsTo: 'durable-runtime',
    disposition: 'reject-as-authority',
    pattern: 'Narrow allowlist for low-risk interactive work only. Temporal remains mission authority.',
    refuse: 'Eve cannot take connected, high-risk, code-executing, or mission-authority work. No independent Eve schedules.',
    safetyNote: 'Planner tests already reject forged Eve lanes.',
  },
];

export function absorbed(): readonly AbsorbedPrimitive[] {
  return ABSORPTION_LEDGER;
}

export function absorbedByDisposition(d: AbsorptionDisposition): readonly AbsorbedPrimitive[] {
  return ABSORPTION_LEDGER.filter((p) => p.disposition === d);
}

export function absorptionOverview() {
  return {
    count: ABSORPTION_LEDGER.length,
    items: ABSORPTION_LEDGER.map((p) => ({
      id: p.id,
      name: p.name,
      source: p.source.project,
      url: p.source.url,
      mapsTo: p.mapsTo,
      disposition: p.disposition,
      pattern: p.pattern,
      refuse: p.refuse,
    })),
  };
}
