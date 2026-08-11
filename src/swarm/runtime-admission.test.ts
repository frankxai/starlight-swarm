import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  assessTeamRuntimeAdmission,
  computePlanDigest,
  parseRuntimeAdmissionEvidence,
  type RuntimeAdmissionEvidence,
} from './runtime-admission';
import { parseTeamRuntimePlan } from './runtime-plan-contract';
import { testRuntimePlan } from './runtime-test-fixtures';

const packDigest = 'a'.repeat(64);
const compilerVersion = 'starlight.team_pack.compiler.v2' as const;

function checkedInPlan() {
  return parseTeamRuntimePlan(testRuntimePlan());
}

function evidence(
  overrides: Partial<RuntimeAdmissionEvidence> = {},
): RuntimeAdmissionEvidence {
  const plan = checkedInPlan();
  const digest = computePlanDigest(plan);
  const binding = {
    plan_digest_sha256: digest,
    source_profile_digest_sha256: plan.source_profile.sha256,
    source_runtime_policy_digest_sha256: plan.routing_policy.policy_digest_sha256,
    pack_digest_sha256: packDigest,
    compiler_version: compilerVersion,
  };
  return {
    observed_at: '2026-08-06T03:00:00.000Z',
    duplicate_lane_ids: [],
    available_memory_gib: 16,
    runtime_health: {
      'vercel-eve': 'ready',
      'railway-temporal': 'ready',
      'hermes-local': 'ready',
    },
    verified_pack: {
      status: 'verified-human-approval-required',
      team_id: plan.team_id,
      ...binding,
    },
    approval_receipt: {
      receipt_id: 'approval-12345678',
      issuer: 'untrusted-example-approval',
      ...binding,
      expires_at: '2026-08-06T04:00:00.000Z',
      scope: 'activate-team-runtime',
    },
    budget_receipt: {
      receipt_id: 'budget-12345678',
      issuer: 'untrusted-example-budget',
      ...binding,
      budget_policy_id: plan.budget.policy_id,
      hard_daily_limit_usd: plan.budget.max_daily_cost_usd,
      expires_at: '2026-08-06T04:00:00.000Z',
    },
    ...overrides,
  };
}

test('report-only assessment fails closed on stale evidence, unhealthy runtimes, duplicates, and low capacity', () => {
  const result = assessTeamRuntimeAdmission(
    checkedInPlan(),
    evidence({
      observed_at: '2026-08-06T02:00:00.000Z',
      duplicate_lane_ids: ['durable-builder'],
      available_memory_gib: 4,
      runtime_health: {
        'vercel-eve': 'degraded',
        'railway-temporal': 'ready',
        'hermes-local': 'ready',
      },
    }),
    '2026-08-06T03:05:00.000Z',
  );

  assert.equal(result.admitted, false);
  assert.match(result.blockers.join(' '), /older than 15 minutes/i);
  assert.match(result.blockers.join(' '), /duplicate live lane ids/i);
  assert.match(result.blockers.join(' '), /vercel-eve is degraded/i);
  assert.match(result.blockers.join(' '), /below the 8 GiB/i);
});

test('fresh caller-authored receipts and health can never activate through the report-only assessor', () => {
  const result = assessTeamRuntimeAdmission(
    checkedInPlan(),
    evidence(),
    '2026-08-06T03:05:00.000Z',
  );

  assert.equal(result.admitted, false);
  assert.equal(result.approval_receipt_id, null);
  assert.equal(result.budget_receipt_id, null);
  assert.match(result.blockers.join(' '), /report-only|production admission gate is not implemented/i);
});

test('receipts must bind the exact verified profile, plan, pack, and compiler tuple', () => {
  const unbound = evidence();
  unbound.approval_receipt.pack_digest_sha256 = 'b'.repeat(64);
  const result = assessTeamRuntimeAdmission(
    checkedInPlan(),
    unbound,
    '2026-08-06T03:05:00.000Z',
  );

  assert.equal(result.admitted, false);
  assert.match(result.blockers.join(' '), /pack digest/i);
});

test('admission evidence rejects unknown runtime health keys', () => {
  const malformed = evidence();
  (malformed.runtime_health as Record<string, string>).railwayTemporal = 'ready';
  assert.throws(
    () => parseRuntimeAdmissionEvidence(malformed),
    /runtime_health[\s\S]*(?:unrecognized|invalid)/i,
  );
});
