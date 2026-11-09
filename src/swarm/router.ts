/**
 * router.ts — ModelRouter v0: configuration plus reporting, no network.
 *
 * The router answers one question per dispatch — which model, and why — and
 * puts the answer where the receipt can carry it (`usedModel`, `wasFallback`,
 * `reason`). It reads the Domain Generals and the model matrix as data
 * (generals.ts) so swapping a model is a data change, not a code change.
 *
 * One rule distinguishes it from a plain lookup: on a critical lane the
 * router never falls back silently. Council-tier work, anything flagged
 * high-risk, and anything the caller marks critical either runs on the model
 * the matrix names or stops and escalates to the founder board. A quiet
 * downgrade on the lane that reviews money is the failure mode this exists
 * to prevent.
 */

import type { Decision } from './escalation';
import type { DomainGeneralId, SwarmModelSelection, SwarmModelTier } from './generals';
import { DOMAIN_GENERALS, SWARM_MODEL_MATRIX } from './generals';

export interface RouteRequest {
  /** Explicit tier wins over the General's default. */
  tier?: SwarmModelTier;
  general?: DomainGeneralId;
  /** High-risk surfaces route to council and are treated as critical. */
  highRisk?: boolean;
  /** Critical lanes refuse to fall back. Council tier is always critical. */
  critical?: boolean;
}

export interface RouteResult {
  tier: SwarmModelTier;
  /** The model the dispatch should run on; empty when refused. */
  usedModel: string;
  wasFallback: boolean;
  /** Why this model, in one line a receipt can carry. */
  reason: string;
  /** True when no acceptable model was available. Nothing runs. */
  refused: boolean;
  /** Where a refusal goes. Always the founder board in v0. */
  escalate?: Decision;
  critical: boolean;
}

/** Answers "may this model be used right now?". Defaults to yes for every model. */
export type ModelAvailability = (model: string) => boolean;

export interface ModelRouterOptions {
  matrix?: Readonly<Record<SwarmModelTier, SwarmModelSelection>>;
  availability?: ModelAvailability;
}

export function tierFor(req: RouteRequest): SwarmModelTier {
  if (req.highRisk) return 'council';
  if (req.tier) return req.tier;
  if (req.general) return DOMAIN_GENERALS[req.general].defaultTier;
  return 'build';
}

export class ModelRouter {
  private readonly matrix: Readonly<Record<SwarmModelTier, SwarmModelSelection>>;
  private readonly available: ModelAvailability;

  constructor(opts: ModelRouterOptions = {}) {
    this.matrix = opts.matrix ?? SWARM_MODEL_MATRIX;
    this.available = opts.availability ?? (() => true);
  }

  route(req: RouteRequest = {}): RouteResult {
    const tier = tierFor(req);
    const lane = this.matrix[tier];
    const critical = Boolean(req.critical) || Boolean(req.highRisk) || tier === 'council';
    const base = { tier, critical };

    if (this.available(lane.primaryModel)) {
      return { ...base, usedModel: lane.primaryModel, wasFallback: false, refused: false, reason: `${tier} tier primary ${lane.primaryModel} available` };
    }

    if (critical) {
      return {
        ...base,
        usedModel: '',
        wasFallback: false,
        refused: true,
        escalate: 'founder-board',
        reason: `${tier} tier primary ${lane.primaryModel} unavailable on a critical lane; no silent fallback. Escalate.`,
      };
    }

    if (this.available(lane.fallbackModel)) {
      return {
        ...base,
        usedModel: lane.fallbackModel,
        wasFallback: true,
        refused: false,
        reason: `${tier} tier primary ${lane.primaryModel} unavailable; fell back to ${lane.fallbackModel}`,
      };
    }

    return {
      ...base,
      usedModel: '',
      wasFallback: false,
      refused: true,
      escalate: 'founder-board',
      reason: `${tier} tier has no available model (${lane.primaryModel}, ${lane.fallbackModel}). Escalate.`,
    };
  }
}
