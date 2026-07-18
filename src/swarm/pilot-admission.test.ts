import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createA0DryExperiment, validateAdmissionFreshness } from './pilot-admission';

test('rejects stale admission evidence before an OpenFang process can start', () => {
  const result = validateAdmissionFreshness('2026-07-18T08:00:00.000Z', '2026-07-18T08:16:00.000Z');

  assert.equal(result.fresh, false);
  assert.match(result.reason, /older than 15 minutes/i);
});

test('A0 is deterministic and remains blocked by the disabled contract without spawning a runtime', () => {
  const contract = JSON.parse(
    readFileSync(new URL('../../hands/examples/collector-openfang-pilot.hand.json', import.meta.url), 'utf8'),
  );
  const environment = JSON.parse(
    readFileSync(
      new URL('../../hands/examples/openfang-single-run.admission.example.json', import.meta.url),
      'utf8',
    ),
  );

  const first = createA0DryExperiment(contract, environment, '2026-07-18T08:00:00.000Z');
  const second = createA0DryExperiment(contract, environment, '2026-07-18T08:00:00.000Z');

  assert.deepEqual(first, second);
  assert.equal(first.execution_status, 'blocked');
  assert.equal(first.outcome_status, 'dry-check-complete');
  assert.equal(first.runtime_spawned, false);
  assert.match(first.blockers.join(' '), /enabled=false/i);
  assert.equal(first.receipt.lease_id, null);
  assert.equal(first.receipt.lease_expires_at, null);
  assert.equal(first.receipt.heartbeat_at, null);
  assert.equal(first.receipt.verifier_binding, 'pending-independent-review');
  assert.equal(first.receipt.process.child_pids.length, 0);
  assert.equal(first.receipt.process.cleanup_status, 'not-started');
});
