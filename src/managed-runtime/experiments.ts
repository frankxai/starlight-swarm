/**
 * experiments.ts — hypotheses with kill criteria, as the registry that gates
 * promotion.
 *
 * Every stream runs on experiments, not opinions. An experiment names one
 * primary metric, a baseline, a pass threshold, and a kill criterion with a
 * date. `evaluateExperiment()` is pure. `canPromote()` is the only way a
 * stream moves up the ladder: dry-run → shadow → pilot → standing.
 *
 * `starlight-evals` stays the independent proof plane; this registry points at
 * its runs by id and records the verdicts.
 */

import { z } from 'zod';
import { identifierSchema, isoDateTimeSchema } from './contract';

export const stageSchema = z.enum(['dry-run', 'shadow', 'pilot', 'standing', 'killed']);
export type Stage = z.infer<typeof stageSchema>;

export const STAGE_ORDER: readonly Stage[] = Object.freeze(['dry-run', 'shadow', 'pilot', 'standing']);

export const metricDirectionSchema = z.enum(['higher-is-better', 'lower-is-better']);

export const experimentSchema = z
  .object({
    id: identifierSchema,
    streamId: identifierSchema,
    hypothesis: z.string().trim().min(1),
    /** One primary metric. Secondary metrics belong in the eval run, not here. */
    metric: z.string().trim().min(1),
    direction: metricDirectionSchema,
    baseline: z.number(),
    /** Pass when the observed value beats this in `direction`. */
    threshold: z.number(),
    /** Kill when the observed value is on the wrong side of this at or after `killBy`. */
    killBelow: z.number(),
    killBy: isoDateTimeSchema,
    /** Ids of eval runs in starlight-evals or the ops ledger that back the observation. */
    evidence: z.array(z.string().min(1)).default([]),
    status: z.enum(['proposed', 'running', 'passed', 'failed', 'killed']).default('proposed'),
  })
  .strict();
export type Experiment = z.output<typeof experimentSchema>;
export type ExperimentInput = z.input<typeof experimentSchema>;

export type Verdict = 'pass' | 'fail' | 'kill' | 'inconclusive';

export interface Observation {
  value: number;
  observedAt: string;
  /** At least one evidence ref, or the observation is inconclusive. */
  evidence: readonly string[];
}

function better(direction: Experiment['direction'], value: number, target: number): boolean {
  return direction === 'higher-is-better' ? value >= target : value <= target;
}

/**
 * Evaluate one observation against an experiment.
 *
 *   inconclusive — no evidence, or a non-finite value
 *   kill         — on the wrong side of `killBelow` at or after `killBy`
 *   pass         — beats `threshold`
 *   fail         — otherwise
 */
export function evaluateExperiment(experiment: Experiment, observation: Observation): Verdict {
  if (!observation.evidence.length || !Number.isFinite(observation.value)) {
    return 'inconclusive';
  }
  const atOrPastKillDate = Date.parse(observation.observedAt) >= Date.parse(experiment.killBy);
  const pastKillLine = !better(experiment.direction, observation.value, experiment.killBelow);
  if (atOrPastKillDate && pastKillLine) {
    return 'kill';
  }
  return better(experiment.direction, observation.value, experiment.threshold) ? 'pass' : 'fail';
}

/** Apply a verdict to an experiment, appending evidence. Pure. */
export function applyVerdict(experiment: Experiment, verdict: Verdict, evidence: readonly string[]): Experiment {
  const status: Experiment['status'] =
    verdict === 'pass' ? 'passed' : verdict === 'kill' ? 'killed' : verdict === 'fail' ? 'failed' : experiment.status;
  return experimentSchema.parse({
    ...experiment,
    status,
    evidence: Array.from(new Set([...experiment.evidence, ...evidence])),
  });
}

export type PromotionDecision =
  | { ok: true; from: Stage; to: Stage; because: string }
  | { ok: false; from: Stage; because: string };

/**
 * A stream may move exactly one rung up, and only when at least one of its
 * experiments has passed and none is killed. `dry-run → shadow` needs no
 * experiment: shadow is where the first measurements come from.
 */
export function canPromote(current: Stage, experiments: readonly Experiment[]): PromotionDecision {
  if (current === 'killed') {
    return { ok: false, from: current, because: 'A killed stream does not come back without a new board decision.' };
  }
  const index = STAGE_ORDER.indexOf(current);
  if (index < 0 || index === STAGE_ORDER.length - 1) {
    return { ok: false, from: current, because: 'Already at standing; nothing above it.' };
  }
  const next = STAGE_ORDER[index + 1];
  if (current === 'dry-run') {
    return { ok: true, from: current, to: next, because: 'Shadow needs no passing experiment; it produces the first one.' };
  }
  if (experiments.some((experiment) => experiment.status === 'killed')) {
    return { ok: false, from: current, because: 'A killed experiment blocks promotion until the board reviews it.' };
  }
  const passed = experiments.filter((experiment) => experiment.status === 'passed');
  if (!passed.length) {
    return { ok: false, from: current, because: 'No passing experiment backs the promotion.' };
  }
  return { ok: true, from: current, to: next, because: `Backed by ${passed.map((experiment) => experiment.id).join(', ')}.` };
}
