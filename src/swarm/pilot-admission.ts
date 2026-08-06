import { createHash } from 'node:crypto';

import { assessHandAdmission, compileOpenFangHand } from './hand-adapter';

const FRESHNESS_WINDOW_MS = 15 * 60 * 1000;

export interface FreshnessDecision {
  fresh: boolean;
  reason: string;
}

export interface A0DryExperiment {
  experiment_id: 'A0-compiler-admission';
  execution_status: 'blocked';
  outcome_status: 'dry-check-complete';
  runtime_spawned: false;
  blockers: string[];
  warnings: string[];
  receipt: {
    contract_sha256: string;
    lease_id: null;
    observed_at: string;
    lease_expires_at: null;
    heartbeat_at: null;
    maker_id: 'a0-dry-experiment';
    verifier_binding: 'pending-independent-review';
    process: {
      owner: 'none';
      pid: null;
      child_pids: number[];
      cleanup_status: 'not-started';
    };
  };
}

export function validateAdmissionFreshness(observedAt: string, now: string): FreshnessDecision {
  const observedMs = Date.parse(observedAt);
  const nowMs = Date.parse(now);
  if (Number.isNaN(observedMs) || Number.isNaN(nowMs)) {
    return { fresh: false, reason: 'Admission evidence must use valid ISO timestamps.' };
  }

  const ageMs = nowMs - observedMs;
  if (ageMs > FRESHNESS_WINDOW_MS) {
    return { fresh: false, reason: 'Admission evidence is older than 15 minutes.' };
  }
  if (ageMs < -5 * 60 * 1000) {
    return { fresh: false, reason: 'Admission evidence is more than five minutes in the future.' };
  }
  return { fresh: true, reason: 'Admission evidence is fresh.' };
}

function hashContract(contract: unknown): string {
  return createHash('sha256').update(JSON.stringify(contract)).digest('hex');
}

function readObservedAt(environment: unknown): string | undefined {
  if (!environment || typeof environment !== 'object') return undefined;
  const candidate = (environment as Record<string, unknown>).evidence_observed_at;
  return typeof candidate === 'string' ? candidate : undefined;
}

/**
 * Deterministically proves the compiler/admission path without invoking OpenFang,
 * scheduling a job, reading credentials, or creating a child process.
 */
export function createA0DryExperiment(
  contract: unknown,
  environment: unknown,
  now: string,
): A0DryExperiment {
  const compiled = compileOpenFangHand(contract);
  const admission = assessHandAdmission(contract, compiled, environment, now);
  const observedAt = readObservedAt(environment);
  const contractSha = hashContract(contract);

  return {
    experiment_id: 'A0-compiler-admission',
    execution_status: 'blocked',
    outcome_status: 'dry-check-complete',
    runtime_spawned: false,
    blockers: [...admission.blockers],
    warnings: admission.warnings,
    receipt: {
      contract_sha256: contractSha,
      lease_id: null,
      observed_at: observedAt ?? now,
      lease_expires_at: null,
      heartbeat_at: null,
      maker_id: 'a0-dry-experiment',
      verifier_binding: 'pending-independent-review',
      process: {
        owner: 'none',
        pid: null,
        child_pids: [],
        cleanup_status: 'not-started',
      },
    },
  };
}
