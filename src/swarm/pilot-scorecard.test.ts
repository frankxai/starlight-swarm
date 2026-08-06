import { test } from 'node:test';
import assert from 'node:assert/strict';

import { evaluatePilot, parsePilotRunReceipt } from './pilot-scorecard';

function run(
  runtime: 'hermes-cron' | 'openfang-sidecar',
  index: number,
  overrides: Record<string, unknown> = {},
) {
  return {
    schema_version: 'starlight.hand.pilot-receipt.v1',
    run_id: `${runtime}-${index}`,
    hand_id: 'collector-openfang-pilot',
    runtime,
    started_at_unix_ms: Date.UTC(2026, 6, index + 1, 6, 0, 0),
    status: 'completed',
    artifact_candidates: Array.from(
      { length: runtime === 'openfang-sidecar' ? 3 : 2 },
      (_, candidateIndex) => ({
        ref: `artifact-${runtime}-${index}-${candidateIndex}`,
        accepted: candidateIndex < (runtime === 'openfang-sidecar' ? 2 : 1),
      }),
    ),
    citation_coverage: runtime === 'openfang-sidecar' ? 0.98 : 0.93,
    graph_candidates: Array.from({ length: 100 }, (_, candidateIndex) => ({
      ref: `graph-${runtime}-${index}-${candidateIndex}`,
      accepted: candidateIndex < (runtime === 'openfang-sidecar' ? 90 : 82),
    })),
    operator_minutes: runtime === 'openfang-sidecar' ? 3 : 7,
    model_cost_usd: runtime === 'openfang-sidecar' ? 0.4 : 0.3,
    failure_count: 0,
    forbidden_attempts: 0,
    unexpected_schedules: 0,
    credential_exposure: false,
    evidence_refs: [`runtime/openfang-pilot/inbox/${runtime}-${index}.json`],
    ...overrides,
  };
}

test('parses a bounded machine-readable pilot receipt', () => {
  const parsed = parsePilotRunReceipt(run('hermes-cron', 0));

  assert.equal(parsed.status, 'completed');
  assert.equal(parsed.citation_coverage, 0.93);
});

test('rejects impossible quality ratios', () => {
  assert.throws(
    () => parsePilotRunReceipt(run('hermes-cron', 0, { citation_coverage: 1.5 })),
    /citation_coverage/i,
  );
});

test('rejects annotation-dependent or malformed string timestamps', () => {
  assert.throws(
    () =>
      parsePilotRunReceipt(
        run('hermes-cron', 0, {
          started_at_unix_ms: undefined,
          started_at: 'not-a-timestamp',
        }),
      ),
    /started_at_unix_ms|unrecognized key|started_at/i,
  );
});

test('rejects legacy independent counts that can claim more acceptances than candidates', () => {
  assert.throws(
    () =>
      parsePilotRunReceipt(
        run('hermes-cron', 0, { artifact_candidate_count: 1, accepted_artifacts: 2 }),
      ),
    /unrecognized key|artifact_candidate_count|accepted_artifacts/i,
  );
});

test('stops OpenFang immediately on a forbidden action attempt', () => {
  const result = evaluatePilot(
    Array.from({ length: 7 }, (_, index) => run('hermes-cron', index)),
    Array.from({ length: 7 }, (_, index) =>
      run('openfang-sidecar', index, index === 3 ? { forbidden_attempts: 1 } : {}),
    ),
  );

  assert.equal(result.decision, 'stop-openfang');
  assert.match(result.reasons.join(' '), /forbidden/i);
});

test('continues collecting evidence before seven completed runs per runtime', () => {
  const result = evaluatePilot(
    Array.from({ length: 3 }, (_, index) => run('hermes-cron', index)),
    Array.from({ length: 3 }, (_, index) => run('openfang-sidecar', index)),
  );

  assert.equal(result.decision, 'continue');
  assert.match(result.reasons.join(' '), /seven completed runs/i);
});

test('promotes OpenFang only when it wins delivery, graph, and operator-effort gates', () => {
  const result = evaluatePilot(
    Array.from({ length: 7 }, (_, index) => run('hermes-cron', index)),
    Array.from({ length: 7 }, (_, index) => run('openfang-sidecar', index)),
  );

  assert.equal(result.decision, 'promote-openfang-sidecar');
  assert.equal(result.summary.openfang.completed_runs, 7);
  assert.ok(
    result.summary.openfang.accepted_artifacts > result.summary.hermes.accepted_artifacts,
  );
});

test('retains Hermes when OpenFang does not reduce operator effort', () => {
  const result = evaluatePilot(
    Array.from({ length: 7 }, (_, index) => run('hermes-cron', index)),
    Array.from({ length: 7 }, (_, index) =>
      run('openfang-sidecar', index, { operator_minutes: 9 }),
    ),
  );

  assert.equal(result.decision, 'retain-hermes');
  assert.match(result.reasons.join(' '), /operator effort/i);
});
