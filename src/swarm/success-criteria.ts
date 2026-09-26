/**
 * success-criteria.ts — the highest demands for this repo, as checkable rows.
 *
 * A criterion is met only when a test or a ledger entry says so. Prose in
 * README is not evidence (charter clause 6).
 */

export type CriterionStatus = 'met' | 'held' | 'open';

export interface SuccessCriterion {
  id: string;
  demand: string;
  proof: string;
  status: CriterionStatus;
}

export const SUCCESS_CRITERIA: readonly SuccessCriterion[] = [
  {
    id: 'SC-01',
    demand: 'Exactly one canonical L6 runtime: this repository.',
    proof: 'kernel.test.ts — canonicalL6() returns frankxai/starlight-swarm',
    status: 'met',
  },
  {
    id: 'SC-02',
    demand: 'No monorepo merge of the estate. Adjacent products stay pinned.',
    proof: 'kernel.test.ts — policy.monorepo === rejected; members keep distinct repos',
    status: 'met',
  },
  {
    id: 'SC-03',
    demand: 'No transfer / pay / settle / move_funds tool exists in this runtime.',
    proof: 'integrations.test.ts + kernel.test.ts scan of PaymentsMcp keys',
    status: 'met',
  },
  {
    id: 'SC-04',
    demand: 'Charter may only raise a gate. Ledger defects refuse outright.',
    proof: 'charter.test.ts monotonicity + ledger refusals',
    status: 'met',
  },
  {
    id: 'SC-05',
    demand: 'Team-profile provenance is Git-pinned. Working-tree drift fails closed.',
    proof: 'runtime-provenance.test.ts + runtime-security.test.ts',
    status: 'met',
  },
  {
    id: 'SC-06',
    demand: 'Admission is report-only. Caller-authored receipts never activate.',
    proof: 'runtime-admission.test.ts + checked-in assessment admitted:false',
    status: 'met',
  },
  {
    id: 'SC-07',
    demand: 'Every absorbed research pattern carries attribution and a refuse line.',
    proof: 'absorption.test.ts — source.url + refuse non-empty; no owed attribution',
    status: 'met',
  },
  {
    id: 'SC-08',
    demand: 'OpenFang / Hermes Hands compile but stay blocked until explicit enable.',
    proof: 'hand-adapter.test.ts + pilot-admission.test.ts',
    status: 'met',
  },
  {
    id: 'SC-09',
    demand: 'Eve is never mission authority. Connected or high-risk work cannot route there.',
    proof: 'runtime-security.test.ts + runtime-planner.test.ts',
    status: 'met',
  },
  {
    id: 'SC-10',
    demand: 'SIS Gateway enforces worker append-only and queen domain bounds.',
    proof: 'swarm issue #10 — blocked on SIS #49 / #84',
    status: 'open',
  },
  {
    id: 'SC-11',
    demand: 'Trusted production activation authority with signed, revocable receipts.',
    proof: 'swarm issue #15 — Phase 1 not started',
    status: 'open',
  },
  {
    id: 'SC-12',
    demand: 'Actualization runtime: Reality Diff → bounded action → Evidence Receipt.',
    proof: 'swarm issue #18 — blocked on SIS #84',
    status: 'open',
  },
  {
    id: 'SC-13',
    demand: 'Operator visual overview shows kernel, streams, absorption, and hold state without inferring readiness.',
    proof: 'observatory.test.ts + /swarm getStaticProps snapshot',
    status: 'met',
  },
  {
    id: 'SC-14',
    demand: 'Unknown health stays unknown. Assessment blockers remain visible.',
    proof: 'observatory.test.ts reads runtime/generated assessment admitted:false',
    status: 'met',
  },
];

export function criteriaByStatus(status: CriterionStatus): readonly SuccessCriterion[] {
  return SUCCESS_CRITERIA.filter((c) => c.status === status);
}

export function successOverview() {
  const met = criteriaByStatus('met').length;
  const held = criteriaByStatus('held').length;
  const open = criteriaByStatus('open').length;
  return {
    total: SUCCESS_CRITERIA.length,
    met,
    held,
    open,
    headline: `${met} met · ${open} open · ${held} held — dry-run only`,
    items: SUCCESS_CRITERIA,
  };
}
