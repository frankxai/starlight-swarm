import { createHash } from 'node:crypto';

// Operator cutoff, deliberately conservative because Google's notice names a date,
// not an exact timezone. This applies to these aliases in this library only.
export const julesExecutionCutoff = '2026-11-11T00:00:00.000Z';
export const julesLifecycleSource = 'https://jules.google/docs/changelog/2026-10-29';
const maxEvaluationAgeMs = 7 * 86_400_000;
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const sha256 = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
function demand(condition, message) {
  if (!condition) throw new Error(message);
}

export function runtimeEligible(capability, now) {
  if (['jules', 'jules-cloud'].includes(capability.runtime) && now >= Date.parse(julesExecutionCutoff)) return false;
  if (capability.executionNotAfter !== undefined) {
    const end = Date.parse(capability.executionNotAfter);
    if (!Number.isFinite(end) || now >= end) return false;
  }
  return true;
}

// Wilson lower bound for the observed accepted-case proportion. This is a
// conservative comparison on one frozen suite, not a general intelligence score.
export function acceptanceLowerBound(accepted, cases) {
  const z2 = 1.96 ** 2;
  const p = accepted / cases;
  return (p + z2 / (2 * cases) - 1.96 * Math.sqrt((p * (1 - p) + z2 / (4 * cases)) / cases)) / (1 + z2 / cases);
}

export function selectByEvidence(candidates, request, evaluations, { now, risk = 'consequential' }) {
  const policy = request.selectionPolicy;
  demand(policy?.version === 1 && ['frontier', 'efficient'].includes(policy.mode), 'Invalid evidence selection policy');
  demand(nonempty(policy.datasetId) && sha256(policy.datasetHash) && sha256(policy.rubricHash), 'Frozen dataset and rubric hashes are required');
  demand(integer(policy.caseCount) && policy.caseCount >= 20, 'At least 20 frozen cases are required');
  demand(Number.isFinite(policy.minimumLowerBound) && policy.minimumLowerBound > 0 && policy.minimumLowerBound <= 1, 'A quality floor is required');
  demand(integer(policy.maxCostPerAcceptedMicroUsd), 'A measured cost ceiling is required');
  demand(['ordinary', 'consequential'].includes(risk), 'Task risk is required');
  const tolerance = policy.qualityTolerance ?? 0;
  demand(Number.isFinite(tolerance) && tolerance >= 0 && tolerance <= 0.02, 'Quality tolerance must be between zero and 0.02');
  demand(policy.mode !== 'frontier' || tolerance === 0, 'Frontier selection cannot trade quality for cost');
  // The containing plan, not the request, supplies risk. Standalone callers
  // default to consequential. High-risk task classes always use frontier mode.
  demand(policy.mode !== 'efficient' || (risk === 'ordinary' && !['security', 'architecture'].includes(request.taskClass)), 'Efficient routing is restricted to ordinary tasks');
  demand(Array.isArray(evaluations), 'Host evaluation records are required');
  const measured = [];
  for (const candidate of candidates) {
    const matches = evaluations.filter(e => e?.model === candidate.model && e.provider === candidate.provider &&
      e.runtime === candidate.runtime && e.effort === candidate.effort && e.taskClass === request.taskClass &&
      e.datasetId === policy.datasetId && e.datasetHash === policy.datasetHash && e.rubricHash === policy.rubricHash);
    demand(matches.length <= 1, 'Ambiguous evaluation identity; host must reconcile records');
    const e = matches[0];
    if (!e) continue;
    const age = now - Date.parse(e.verifiedAt);
    if (!Number.isFinite(age) || age < 0 || age > maxEvaluationAgeMs || e.caseCount !== policy.caseCount) continue;
    if (!integer(e.acceptedCases) || e.acceptedCases < 1 || e.acceptedCases > e.caseCount ||
        !integer(e.attempts) || e.attempts < e.caseCount || e.criticalFailures !== 0) continue;
    if (!integer(e.totalCostMicroUsd) || e.costBasis !== 'all-attempts-measured' ||
        e.costScope !== 'execution-repair-and-verification' || !nonempty(e.evidenceRef) || !nonempty(e.costEvidenceRef)) continue;
    const lowerBound = acceptanceLowerBound(e.acceptedCases, e.caseCount);
    if (lowerBound < policy.minimumLowerBound) continue;
    measured.push({ candidate, evaluation: e, lowerBound, costPerAccepted: e.totalCostMicroUsd / e.acceptedCases });
  }
  if (!measured.length) return { status: 'hold', reason: 'No eligible candidate has fresh comparable evaluation, quality and measured cost evidence' };
  measured.sort((a, b) => b.lowerBound - a.lowerBound || a.costPerAccepted - b.costPerAccepted);
  const bestQuality = measured[0].lowerBound;
  const allowed = measured.filter(m => m.lowerBound >= bestQuality - tolerance && m.costPerAccepted <= policy.maxCostPerAcceptedMicroUsd);
  if (!allowed.length) return { status: 'hold', reason: 'Measured cost ceiling excludes the quality frontier; explicit policy revision is required' };
  if (policy.mode === 'efficient') allowed.sort((a, b) => a.costPerAccepted - b.costPerAccepted || b.lowerBound - a.lowerBound);
  const winner = allowed[0];
  return {
    ...winner.candidate,
    reason: policy.mode === 'frontier' ? 'Best observed quality lower bound on the frozen suite' : 'Lowest measured cost within the explicit quality tolerance',
    evidenceStatus: 'measured-frozen-suite-only', executionAuthorityGranted: false,
    evaluation: {
      datasetId: policy.datasetId, datasetHash: policy.datasetHash, rubricHash: policy.rubricHash,
      caseCount: policy.caseCount, acceptedCases: winner.evaluation.acceptedCases,
      attempts: winner.evaluation.attempts, acceptanceLowerBound: winner.lowerBound,
      costPerAcceptedMicroUsd: winner.costPerAccepted, verifiedAt: winner.evaluation.verifiedAt,
      evidenceRef: winner.evaluation.evidenceRef, costEvidenceRef: winner.evaluation.costEvidenceRef,
      recordHash: createHash('sha256').update(JSON.stringify(winner.evaluation)).digest('hex'),
    },
  };
}
