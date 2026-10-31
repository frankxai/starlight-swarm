/**
 * router.ts — workload class → provider + model, as pure policy.
 *
 * The table encodes the proposal's §4.2. Every entry has a default provider,
 * a model class, and an optional fallback provider used only for reversible
 * work when the default is unavailable. The router never calls a provider.
 *
 * Concrete model ids are policy inputs the owner sets. Defaults below are the
 * ids documented by each SDK at the time of writing; override them through
 * `RouterPolicy.models` rather than editing the table.
 */

import type { ModelClass, Provider, WorkloadClass } from './contract';

export interface RouteEntry {
  provider: Provider;
  modelClass: ModelClass;
  /** Used only when `reversible` is true and the default provider is marked unavailable. */
  fallback?: Provider;
  why: string;
}

export const ROUTING_TABLE: Readonly<Record<WorkloadClass, RouteEntry>> = Object.freeze({
  architecture: {
    provider: 'anthropic',
    modelClass: 'top',
    why: 'Protocol-heavy reasoning compounds best here (STACK.md L1 stance).',
  },
  canon: {
    provider: 'anthropic',
    modelClass: 'top',
    why: 'Canon work needs the top reasoning tier and the SIP attestation flow.',
  },
  'protocol-reasoning': {
    provider: 'anthropic',
    modelClass: 'top',
    why: 'Same as architecture.',
  },
  'board-review': {
    provider: 'anthropic',
    modelClass: 'top',
    why: 'Board pressure-tests are not a place to save tokens.',
  },
  'long-horizon-build': {
    provider: 'anthropic',
    modelClass: 'operational',
    why: 'Managed Agents: hosted sandbox, versioned agent, hard session budget, outcomes grading.',
  },
  'repo-steward': {
    provider: 'anthropic',
    modelClass: 'operational',
    why: 'Scheduled deployments plus GitHub repository resources on the session.',
  },
  'scheduled-deliverable': {
    provider: 'anthropic',
    modelClass: 'operational',
    why: 'Deployments fire sessions on a cron; no client-side scheduler.',
  },
  'tool-orchestration': {
    provider: 'openai',
    modelClass: 'operational',
    fallback: 'anthropic',
    why: 'Agents SDK handoffs, guardrails, hosted tools, tracing.',
  },
  'multi-agent-handoff': {
    provider: 'openai',
    modelClass: 'operational',
    fallback: 'anthropic',
    why: 'Handoffs are first-class in the Agents SDK.',
  },
  'customer-chat': {
    provider: 'openai',
    modelClass: 'operational',
    fallback: 'anthropic',
    why: 'ChatKit stays supported after the AgentKit builder sunset.',
  },
  'bulk-extraction': {
    provider: 'gemini',
    modelClass: 'flash',
    fallback: 'anthropic',
    why: 'Lowest cost per sandboxed loop; free tier for experiments.',
  },
  classification: {
    provider: 'gemini',
    modelClass: 'flash',
    fallback: 'anthropic',
    why: 'Same as bulk extraction.',
  },
  'research-scan': {
    provider: 'gemini',
    modelClass: 'flash',
    fallback: 'openai',
    why: 'Deep Research and Antigravity agents run in a Google-hosted sandbox.',
  },
  'sandbox-research': {
    provider: 'gemini',
    modelClass: 'flash',
    fallback: 'anthropic',
    why: 'Network allowlist and managed credentials injected at egress.',
  },
  'volume-creator-work': {
    provider: 'anthropic',
    modelClass: 'small',
    fallback: 'openai',
    why: 'Router may swap by measured cost per completed task; default is the small tier.',
  },
  'offline-sovereign': {
    provider: 'self-hosted',
    modelClass: 'local',
    why: 'Air-gapped canon work never leaves the operator.',
  },
});

/** Concrete model ids per provider and class. Owner-settable policy. */
export type ModelTable = Readonly<Record<Provider, Partial<Record<ModelClass, string>>>>;

/**
 * Defaults come from each SDK's documentation at the time of writing:
 * Anthropic ids from the Managed Agents model enum; the Gemini alias from the
 * GenAI SDK readme; the Gemini agent id from the SDK's `AgentOption` type.
 * OpenAI model ids are left to the owner — the Agents SDK applies its own
 * default when `model` is omitted, and that is what the adapter does.
 */
export const DEFAULT_MODELS: ModelTable = Object.freeze({
  anthropic: {
    top: 'claude-opus-5-5',
    operational: 'claude-sonnet-5-5',
    small: 'claude-haiku-5-5',
    flash: 'claude-haiku-5-5',
  },
  openai: {},
  gemini: {
    flash: 'gemini-flash-latest',
    operational: 'gemini-flash-latest',
    small: 'gemini-flash-latest',
  },
  'self-hosted': {
    local: 'llama-3.x-local',
  },
  'dry-run': {
    top: 'dry-run',
    operational: 'dry-run',
    small: 'dry-run',
    flash: 'dry-run',
    local: 'dry-run',
  },
});

/** The Gemini managed agent the adapter targets. From the SDK's `AgentOption` union. */
export const GEMINI_MANAGED_AGENT = 'antigravity-preview-05-2026' as const;

export interface RouterPolicy {
  /** Providers currently marked unavailable (outage, quota, policy). */
  unavailable?: ReadonlySet<Provider>;
  /** Owner overrides for concrete model ids. */
  models?: ModelTable;
  /** When true, every class routes to the dry-run provider (tests, demos). */
  dryRun?: boolean;
}

export interface Route {
  provider: Provider;
  modelClass: ModelClass;
  /** Concrete model id, or `undefined` when the provider applies its own default. */
  model: string | undefined;
  /** True when the fallback provider was used. */
  degraded: boolean;
  why: string;
}

/**
 * Resolve a workload class to a route.
 *
 * Degradation rule: a fallback is used only for `reversible` work. Irreversible
 * work on an unavailable provider throws — it must wait, never silently move.
 */
export function routeWorkload(
  workloadClass: WorkloadClass,
  options: { reversible: boolean },
  policy: RouterPolicy = {},
): Route {
  const entry = ROUTING_TABLE[workloadClass];
  if (!entry) {
    throw new Error(`Unknown workload class: ${String(workloadClass)}`);
  }

  if (policy.dryRun) {
    return {
      provider: 'dry-run',
      modelClass: entry.modelClass,
      model: 'dry-run',
      degraded: false,
      why: `dry-run policy (would be ${entry.provider}/${entry.modelClass}: ${entry.why})`,
    };
  }

  const unavailable = policy.unavailable ?? new Set<Provider>();
  const models = policy.models ?? DEFAULT_MODELS;

  if (!unavailable.has(entry.provider)) {
    return {
      provider: entry.provider,
      modelClass: entry.modelClass,
      model: models[entry.provider]?.[entry.modelClass],
      degraded: false,
      why: entry.why,
    };
  }

  if (!options.reversible) {
    throw new Error(
      `Provider ${entry.provider} is unavailable and ${workloadClass} is not reversible; the run must wait.`,
    );
  }

  if (!entry.fallback || unavailable.has(entry.fallback)) {
    throw new Error(`Provider ${entry.provider} is unavailable and ${workloadClass} has no available fallback.`);
  }

  return {
    provider: entry.fallback,
    modelClass: entry.modelClass,
    model: models[entry.fallback]?.[entry.modelClass],
    degraded: true,
    why: `${entry.provider} unavailable; reversible work degraded to ${entry.fallback}. ${entry.why}`,
  };
}
