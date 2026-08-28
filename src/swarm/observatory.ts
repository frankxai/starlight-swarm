/**
 * observatory.ts — read-only snapshot for the /swarm visual overview.
 *
 * Composes streams, kernel, absorption, charter, and the checked-in
 * admission assessment. No side effects. Never infers readiness.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BENEVOLENCE_CHARTER } from './charter';
import { absorptionOverview } from './absorption';
import { KERNEL_VERSION, kernelOverview } from './kernel';
import { swarmTree } from './streams';
import { successOverview } from './success-criteria';

export interface AdmissionSnapshot {
  admitted: boolean;
  approval_receipt_id: string | null;
  budget_receipt_id: string | null;
  blockers: string[];
  warnings: string[];
}

const ASSESSMENT_PATH = resolve(
  process.cwd(),
  'runtime/generated/starlight-platform-pilot.assessment.json',
);

export function loadCheckedInAssessment(path = ASSESSMENT_PATH): AdmissionSnapshot {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as AdmissionSnapshot;
  if (typeof raw.admitted !== 'boolean' || !Array.isArray(raw.blockers)) {
    throw new Error('assessment snapshot is malformed');
  }
  return raw;
}

export function observatorySnapshot(assessment = loadCheckedInAssessment()) {
  if (assessment.admitted === true) {
    throw new Error('observatory refuses to project an admitted snapshot from a report-only assessor');
  }
  return {
    version: KERNEL_VERSION,
    posture: 'dry-run-only' as const,
    admitted: false as const,
    headline: 'Kernel Observatory — planned, not admitted, no live funds',
    founder: swarmTree().founder,
    streams: swarmTree().streams,
    kernel: kernelOverview(),
    absorbed: absorptionOverview(),
    charter: {
      protocol: BENEVOLENCE_CHARTER.protocol,
      version: BENEVOLENCE_CHARTER.version,
      clauses: BENEVOLENCE_CHARTER.clauses.map((c) => ({ id: c.id, text: c.text })),
    },
    admission: assessment,
    criteria: successOverview(),
  };
}

export type ObservatorySnapshot = ReturnType<typeof observatorySnapshot>;
