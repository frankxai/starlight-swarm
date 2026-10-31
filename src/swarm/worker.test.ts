import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { makeWorker } from './worker';
import type { Action } from './escalation';
import type { SisVaultMcp, VaultEntry } from './integrations';

test('makeWorker creates a worker that appends to vault and returns report', async () => {
  const appended: VaultEntry[] = [];
  const mockVault: SisVaultMcp = {
    sis_append_entry: async (entry: VaultEntry) => {
      appended.push(entry);
      return { ok: true, id: 'test-id' };
    },
    sis_vault_search: async () => [],
    sis_confirm: async () => ({ ok: true }),
  };

  const worker = makeWorker('test-worker', 'content', 'test-skill');
  assert.equal(worker.name, 'test-worker');
  assert.equal(worker.stream, 'content');
  assert.equal(worker.skill, 'test-skill');

  const dummyAction: Action = {
    kind: 'draft',
    stream: 'content',
    irreversible: false,
    movesMoney: false,
    crossStream: false,
  };

  const report = await worker.run(
    {
      id: 'task-1',
      description: 'test task',
      proposes: dummyAction,
    },
    mockVault
  );

  assert.equal(report.worker, 'test-worker');
  assert.equal(report.stream, 'content');
  assert.equal(report.taskId, 'task-1');
  assert.deepEqual(report.proposed, dummyAction);
  assert.match(report.note, /test-skill/);

  assert.equal(appended.length, 1);
  assert.equal(appended[0].agent, 'test-worker');
  assert.equal(appended[0].stream, 'content');
  assert.equal(appended[0].task, 'task-1');
  assert.match(appended[0].note, /test task/);
  assert.ok(appended[0].timestamp);
});
