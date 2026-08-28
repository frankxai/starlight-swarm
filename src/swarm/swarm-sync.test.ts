import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolve } from 'node:path';

import { assessSwarmSync } from './swarm-sync';

test('assessSwarmSync reports ok/warn for this repository without failing load-bearing checks', () => {
  const report = assessSwarmSync({
    repositoryRoot: resolve(process.cwd()),
    now: () => new Date('2026-08-28T12:00:00.000Z'),
  });

  assert.equal(report.schema_version, 'starlight.swarm_sync.v1');
  assert.ok(report.checks.length >= 7);
  assert.ok(report.worker_skills.length > 0);
  assert.ok(report.claude_skills.length > 0);
  assert.ok(report.memory_import.skills >= 1);

  const agents = report.checks.find((c) => c.id === 'agents-md');
  const charter = report.checks.find((c) => c.id === 'charter-module');
  const funds = report.checks.find((c) => c.id === 'no-live-funds');
  assert.equal(agents?.status, 'ok');
  assert.equal(charter?.status, 'ok');
  assert.equal(funds?.status, 'ok');
  assert.notEqual(report.overall, 'fail');
});
