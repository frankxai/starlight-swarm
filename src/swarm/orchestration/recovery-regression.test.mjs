import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runPlan } from './runtime.mjs';
const now = Date.now(), presets = JSON.parse(readFileSync(new URL('./presets.json', import.meta.url)));
const task = id => ({ id, objective: 'Private mock task', repo: 'example/project', artifact: 'fixture', stopCondition: 'done', verification: 'fixture verification', inputRefs: ['fixture:input'], access: 'read', risk: 'ordinary', ownedPaths: [], dependsOn: [], request: { taskClass: 'debugging', runtime: 'fixture', tools: ['read'] } });
const plan = (tasks = [task('worker')]) => ({ version: 1, id: 'bounded-fixture', pattern: tasks.length === 1 ? 'single' : 'sequential', tasks });
const cap = { model: 'gpt-6-sol', runtime: 'fixture', provider: 'openai', available: true, verifiedAt: new Date(now).toISOString(), efforts: ['high'], tools: ['read'], evidenceRef: 'fixture:availability' };
const options = extra => ({ catalog: [cap], presets, now, onCheckpoint: async () => {}, admission: { decision: 'allow', maxParallel: 1 }, adapter: async (_t, { selection }) => ({ model: selection.model, provider: selection.provider, runtime: selection.runtime, artifacts: ['fixture:artifact'] }), verify: async () => ({ passed: true, evidenceRefs: ['fixture:verify'] }), ...extra });
test('catalog hold cannot erase unknown execution', async () => {
  const checkpoint = await runPlan(plan(), options({ adapter: async () => { throw new Error('lost response'); } }));
  assert.equal(checkpoint.capacityRetained, true); let calls = 0;
  await assert.rejects(runPlan(plan(), options({ checkpoint, catalog: [], adapter: async () => { calls++; }, verify: async () => { calls++; } })), /unresolved execution/);
  assert.equal(calls, 0); assert.equal(checkpoint.capacityRetained, true);
});
test('invalid checkpoint is rejected before catalog hold', async () => {
  await assert.rejects(runPlan(plan(), options({ catalog: [], checkpoint: { version: 99 } })), /checkpoint/i);
});
test('pre-aborted resume invokes no verification callback', async () => {
  const checkpoint = await runPlan(plan(), options()), controller = new AbortController(); controller.abort(new Error('cancelled'));
  let calls = 0; await assert.rejects(runPlan(plan(), options({ checkpoint, signal: controller.signal, verify: async () => { calls++; } })), /cancelled/); assert.equal(calls, 0);
});
test('cancellation inside resumed verification is passed through and stops later callbacks', async () => {
  const p = plan([task('a'), { ...task('b'), dependsOn: ['a'] }]);
  const checkpoint = await runPlan(p, options()), controller = new AbortController(); let calls = 0;
  await assert.rejects(runPlan(p, options({ checkpoint, signal: controller.signal, verify: async (_t, _o, ctx) => { assert.equal(ctx.signal, controller.signal); calls++; controller.abort(new Error('cancelled during verification')); return { passed: true, evidenceRefs: ['fixture:verify'] }; } })), /cancelled during/);
  assert.equal(calls, 1); assert.equal(checkpoint.status, 'complete');
});
test('cached output identity must match selected capability', async () => {
  const checkpoint = await runPlan(plan(), options());
  for (const field of ['model', 'provider', 'runtime']) { const bad = structuredClone(checkpoint); bad.results.worker.output[field] = 'tampered'; await assert.rejects(runPlan(plan(), options({ checkpoint: bad })), /identity/); }
});
test('valid completed checkpoint is reverified without dispatch and keeps event history', async () => {
  const checkpoint = await runPlan(plan(), options()); let checks = 0;
  const resumed = await runPlan(plan(), options({ checkpoint, adapter: async () => { throw new Error('must not dispatch'); }, verify: async (_t, _o, ctx) => { assert.equal(ctx.resumed, true); checks++; return { passed: true, evidenceRefs: ['fixture:resume'] }; } }));
  assert.equal(resumed.status, 'complete'); assert.equal(checks, 1); assert.deepEqual(resumed.events.slice(0, checkpoint.events.length), checkpoint.events);
  assert.deepEqual(resumed.results.worker.verification.evidenceRefs, ['fixture:resume']);
});
test('unknown status and explicit unresolved IDs independently block even with scrubbed events', async () => {
  const checkpoint = await runPlan(plan(), options());
  for (const delta of [{ status: 'unknown' }, ...[['worker'], 'invalid', 0, '', false, null].map(unresolvedTaskIds => ({ unresolvedTaskIds }))]) {
    const old = { ...checkpoint, ...delta, capacityRetained: false, events: [] };
    await assert.rejects(runPlan(plan(), options({ checkpoint: old, catalog: [] })), /unresolved execution/);
  }
});
test('capability hold preserves valid cached results and events without claiming completion', async () => {
  const checkpoint = await runPlan(plan(), options());
  const held = await runPlan(plan(), options({ checkpoint, catalog: [] }));
  assert.equal(held.status, 'hold'); assert.deepEqual(held.results, checkpoint.results); assert.deepEqual(held.events, checkpoint.events);
  held.events.length = 0; assert.notEqual(checkpoint.events.length, 0);
});
test('malformed resumed artifact references reject before callback', async () => {
  const checkpoint = await runPlan(plan(), options()); let calls = 0;
  for (const artifacts of [[], null, ['']]) { const old = structuredClone(checkpoint); old.results.worker.output.artifacts = artifacts;
    await assert.rejects(runPlan(plan(), options({ checkpoint: old, verify: async () => { calls++; } })), /artifact references/);
  }
  assert.equal(calls, 0);
});
test('unknown cached task and malformed artifacts reject even during capability hold', async () => {
  const checkpoint = await runPlan(plan(), options());
  const ghost = structuredClone(checkpoint); ghost.results.ghost = ghost.results.worker;
  await assert.rejects(runPlan(plan(), options({ checkpoint: ghost, catalog: [] })), /task is invalid/);
  const malformed = structuredClone(checkpoint); malformed.results.worker.output.artifacts = [];
  await assert.rejects(runPlan(plan(), options({ checkpoint: malformed, catalog: [] })), /artifact references/);
});
test('resumed verifier receives a copy and cannot mutate caller checkpoint', async () => {
  const checkpoint = await runPlan(plan(), options()), before = structuredClone(checkpoint);
  await runPlan(plan(), options({ checkpoint, verify: async (_t, output) => { output.artifacts.length = 0; return { passed: true, evidenceRefs: ['fixture:verify'] }; } }));
  assert.deepEqual(checkpoint, before);
});
