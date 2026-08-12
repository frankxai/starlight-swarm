import { z } from 'zod';

import { runtimeIds, type RuntimeId, type TeamRuntimePlan } from './runtime-planner';
import { sha256Digest } from './runtime-digest';
import { parseTeamRuntimePlan } from './runtime-plan-contract';

export interface PackBinding {
  plan_digest_sha256: string;
  source_profile_digest_sha256: string;
  source_runtime_policy_digest_sha256: string;
  pack_digest_sha256: string;
  compiler_version: 'starlight.team_pack.compiler.v2';
}

export interface ApprovalReceipt extends PackBinding {
  receipt_id: string;
  issuer: string;
  expires_at: string;
  scope: 'activate-team-runtime';
}

export interface BudgetReceipt extends PackBinding {
  receipt_id: string;
  issuer: string;
  budget_policy_id: string;
  hard_daily_limit_usd: number;
  expires_at: string;
}

export interface RuntimeAdmissionEvidence {
  observed_at: string;
  duplicate_lane_ids: string[];
  available_memory_gib: number;
  runtime_health: Partial<Record<RuntimeId, 'ready' | 'degraded' | 'offline' | 'unknown'>>;
  verified_pack: PackBinding & {
    status: 'verified-human-approval-required';
    team_id: string;
  };
  approval_receipt: ApprovalReceipt;
  budget_receipt: BudgetReceipt;
}

export interface RuntimeAdmissionResult {
  admitted: boolean;
  approval_receipt_id: string | null;
  budget_receipt_id: string | null;
  blockers: string[];
  warnings: string[];
}

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const packBindingSchema = {
  plan_digest_sha256: digestSchema,
  source_profile_digest_sha256: digestSchema,
  source_runtime_policy_digest_sha256: digestSchema,
  pack_digest_sha256: digestSchema,
  compiler_version: z.literal('starlight.team_pack.compiler.v2'),
};
const receiptBase = {
  receipt_id: z.string().min(8),
  issuer: z.string().min(1),
  ...packBindingSchema,
  expires_at: z.iso.datetime({ offset: true }),
};

const evidenceSchema = z
  .object({
    observed_at: z.iso.datetime({ offset: true }),
    duplicate_lane_ids: z.array(z.string().min(1)),
    available_memory_gib: z.number().nonnegative().finite(),
    runtime_health: z.partialRecord(
      z.enum(runtimeIds),
      z.enum(['ready', 'degraded', 'offline', 'unknown']),
    ),
    verified_pack: z
      .object({
        status: z.literal('verified-human-approval-required'),
        team_id: z.string().min(1),
        ...packBindingSchema,
      })
      .strict(),
    approval_receipt: z
      .object({
        ...receiptBase,
        scope: z.literal('activate-team-runtime'),
      })
      .strict(),
    budget_receipt: z
      .object({
        ...receiptBase,
        budget_policy_id: z.string().min(1),
        hard_daily_limit_usd: z.number().positive().finite(),
      })
      .strict(),
  })
  .strict();

export function parseRuntimeAdmissionEvidence(input: unknown): RuntimeAdmissionEvidence {
  const result = evidenceSchema.safeParse(input);
  if (!result.success) {
    const details = result.error.issues
      .slice(0, 4)
      .map((issue) => `${issue.path.join('.') || 'root'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid runtime admission evidence: ${details}`);
  }
  return result.data as RuntimeAdmissionEvidence;
}

export function computePlanDigest(plan: TeamRuntimePlan): string {
  return sha256Digest(plan);
}

function blocked(message: string): RuntimeAdmissionResult {
  return {
    admitted: false,
    approval_receipt_id: null,
    budget_receipt_id: null,
    blockers: [message],
    warnings: [],
  };
}

export function assessTeamRuntimeAdmission(
  untrustedPlan: unknown,
  untrustedEvidence: unknown,
  now = new Date().toISOString(),
): RuntimeAdmissionResult {
  let plan: TeamRuntimePlan;
  let evidence: RuntimeAdmissionEvidence;

  try {
    plan = parseTeamRuntimePlan(untrustedPlan);
  } catch (error) {
    return blocked(error instanceof Error ? error.message : 'Invalid team runtime plan.');
  }

  try {
    evidence = parseRuntimeAdmissionEvidence(untrustedEvidence);
  } catch (error) {
    return blocked(error instanceof Error ? error.message : 'Invalid runtime admission evidence.');
  }

  const blockers: string[] = [];
  const warnings: string[] = [];
  const planDigest = computePlanDigest(plan);
  const nowMs = Date.parse(now);
  const observedAtMs = Date.parse(evidence.observed_at);

  if (!Number.isFinite(nowMs)) {
    blockers.push('Admission evaluation time must be a valid ISO timestamp.');
  } else if (nowMs - observedAtMs > 15 * 60 * 1000) {
    blockers.push('Admission evidence is older than 15 minutes.');
  } else if (observedAtMs > nowMs + 60_000) {
    blockers.push('Admission evidence cannot be observed in the future.');
  }

  const approvalExpiresMs = Date.parse(evidence.approval_receipt.expires_at);
  const budgetExpiresMs = Date.parse(evidence.budget_receipt.expires_at);
  if (Number.isFinite(nowMs) && approvalExpiresMs <= nowMs) {
    blockers.push('Approval receipt is expired.');
  }
  if (Number.isFinite(nowMs) && budgetExpiresMs <= nowMs) {
    blockers.push('Budget guardrail receipt is expired.');
  }

  if (evidence.verified_pack.plan_digest_sha256 !== planDigest) {
    blockers.push('Verified team pack is not bound to the exact runtime plan digest.');
  }
  if (evidence.verified_pack.source_profile_digest_sha256 !== plan.source_profile.sha256) {
    blockers.push('Verified team pack is not bound to the exact source profile digest.');
  }
  if (
    evidence.verified_pack.source_runtime_policy_digest_sha256 !==
    plan.routing_policy.policy_digest_sha256
  ) {
    blockers.push('Verified team pack is not bound to the exact runtime policy digest.');
  }
  if (evidence.verified_pack.team_id !== plan.team_id) {
    blockers.push('Verified team pack is not bound to the runtime plan team.');
  }

  for (const [label, receipt] of [
    ['Approval', evidence.approval_receipt],
    ['Budget', evidence.budget_receipt],
  ] as const) {
    if (receipt.plan_digest_sha256 !== planDigest) {
      blockers.push(`${label} receipt is not bound to the exact runtime plan digest.`);
    }
    if (receipt.source_profile_digest_sha256 !== evidence.verified_pack.source_profile_digest_sha256) {
      blockers.push(`${label} receipt is not bound to the verified source profile digest.`);
    }
    if (
      receipt.source_runtime_policy_digest_sha256 !==
      evidence.verified_pack.source_runtime_policy_digest_sha256
    ) {
      blockers.push(`${label} receipt is not bound to the verified runtime policy digest.`);
    }
    if (receipt.pack_digest_sha256 !== evidence.verified_pack.pack_digest_sha256) {
      blockers.push(`${label} receipt is not bound to the verified team-pack digest.`);
    }
    if (receipt.compiler_version !== evidence.verified_pack.compiler_version) {
      blockers.push(`${label} receipt is not bound to the verified team-pack compiler version.`);
    }
  }

  if (evidence.budget_receipt.budget_policy_id !== plan.budget.policy_id) {
    blockers.push('Budget receipt policy does not match the runtime plan.');
  }
  if (evidence.budget_receipt.hard_daily_limit_usd !== plan.budget.max_daily_cost_usd) {
    blockers.push('Budget receipt hard limit does not match the runtime plan.');
  }
  if (plan.budget.planned_daily_cost_usd > evidence.budget_receipt.hard_daily_limit_usd) {
    blockers.push('Planned daily cost exceeds the verified hard budget limit.');
  }

  if (evidence.duplicate_lane_ids.length > 0) {
    blockers.push(`Duplicate live lane ids already exist: ${evidence.duplicate_lane_ids.join(', ')}`);
  }

  const requiredRuntimes = new Set(plan.lanes.map((lane) => lane.runtime));
  for (const runtime of Array.from(requiredRuntimes)) {
    const status = evidence.runtime_health[runtime] ?? 'unknown';
    if (status !== 'ready') {
      blockers.push(`Runtime ${runtime} is ${status}; expected ready.`);
    }
  }

  if (requiredRuntimes.has('hermes-local') && evidence.available_memory_gib < 8) {
    blockers.push(
      `Local Hermes memory ${evidence.available_memory_gib} GiB is below the 8 GiB admission floor.`,
    );
  }

  if (requiredRuntimes.has('vercel-eve')) {
    warnings.push('Vercel Eve remains a beta interaction surface, not canonical mission authority.');
  }

  blockers.push(
    'Production admission gate is not implemented; this assessor is report-only and caller-authored evidence can never activate workers.',
  );

  return {
    admitted: false,
    approval_receipt_id: null,
    budget_receipt_id: null,
    blockers,
    warnings,
  };
}
