import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { selectModel, validatePlan } from './router.mjs';
import { runPlan } from './runtime.mjs';

const presets = JSON.parse(readFileSync(new URL('./presets.json', import.meta.url)));
const now = Date.now();
const cap = (model = 'gpt-6-sol') => ({ model, runtime: 'test', provider: 'openai', available: true, verifiedAt: new Date(now).toISOString(), efforts: ['medium', 'high', 'xhigh'], tools: ['read'], evidenceRef: 'fixture:availability' });
const task = (id = 'worker') => ({ id, objective: 'Fix a bounded fixture', repo: 'example/project', artifact: 'patch', stopCondition: 'Tests pass', verification: 'Independent regression suite', inputRefs: ['fixture:bug'], access: 'read', risk: 'ordinary', ownedPaths: [], dependsOn: [], request: { taskClass: 'debugging', runtime: 'test', tools: ['read'] } });
const plan = (pattern = 'single', tasks = [task()]) => ({ version: 1, id: 'test-plan', pattern, tasks });
const adapter = async (t, { selection }) => ({ model: selection.model, provider: selection.provider, runtime: selection.runtime, artifacts: [`fixture:${t.id}`] });
const verify = async () => ({ passed: true, evidenceRefs: ['fixture:test-passed'] });
const options = extra => ({ catalog: [cap()], presets, now, adapter, verify, onCheckpoint: async () => {}, admission: { decision: 'allow', maxParallel: 2 }, ...extra });

test('GPT-6 selection is provisional, capability-checked and model-specific', () => {
  const r = selectModel(task().request, [cap()], presets, { now });
  assert.equal(r.model, 'gpt-6-sol');
  assert.equal(r.evidenceStatus, 'provisional-unranked');
  assert.equal(r.wasFallback, false);
});
test('unavailable, stale, future, unsupported effort and wrong runtime hold', () => {
  for (const delta of [{ available: false }, { verifiedAt: '2020-01-01' }, { verifiedAt: new Date(now + 1).toISOString() }, { efforts: ['low'] }, { runtime: 'other' }, { tools: [] }]) {
    assert.equal(selectModel(task().request, [{ ...cap(), ...delta }], presets, { now }).status, 'hold');
  }
});
test('explicit model never silently falls back', () => {
  const r = { ...task().request, model: 'missing', fallbacks: ['gpt-6-sol'] };
  assert.equal(selectModel(r, [cap()], presets, { now }).status, 'hold');
  assert.equal(selectModel({ ...r, allowFallback: true }, [cap()], presets, { now }).wasFallback, true);
});
test('duplicate identity and missing contract fields reject', () => {
  assert.throws(() => selectModel(task().request, [cap(), cap()], presets, { now }), /Ambiguous/);
  assert.throws(() => validatePlan(plan('single', [{ ...task(), verification: '' }])), /verification/);
});
test('review selection requires a different provider', () => {
  assert.equal(selectModel({ ...task().request, independentOf: 'openai' }, [cap()], presets, { now }).status, 'hold');
});
test('writer scopes reject duplicate, parent-child, case alias and traversal', () => {
  for (const pair of [['src/a', 'src/a'], ['src', 'src/a'], ['SRC/A', 'src/a']]) {
    assert.throws(() => validatePlan(plan('parallel', pair.map((p, i) => ({ ...task(`t${i}`), access: 'write', ownedPaths: [p] })))), /Conflicting/);
  }
  assert.throws(() => validatePlan(plan('single', [{ ...task(), access: 'write', ownedPaths: ['../escape'] }])), /relative/);
});
test('unknown dependency and cycle reject before invocation', () => {
  assert.throws(() => validatePlan(plan('sequential', [{ ...task(), dependsOn: ['missing'] }])), /dependency/);
  assert.throws(() => validatePlan(plan('sequential', [{ ...task('a'), dependsOn: ['b'] }, { ...task('b'), dependsOn: ['a'] }])), /cycle/);
});
test('single and sequential patterns produce verified artifacts', async () => {
  assert.equal((await runPlan(plan(), options())).status, 'complete');
  const p = plan('sequential', [task('a'), { ...task('b'), dependsOn: ['a'] }]);
  const calls = [];
  const r = await runPlan(p, options({ adapter: async (t, ctx) => { calls.push([t.id, Object.keys(ctx.dependencies)]); return adapter(t, ctx); } }));
  assert.equal(r.status, 'complete');
  assert.deepEqual(calls, [['a', []], ['b', ['a']]]);
});
test('parallel respects machine admission; manager synthesizes after workers', async () => {
  let active = 0, peak = 0;
  const r = await runPlan(plan('parallel', [task('a'), task('b')]), options({ admission: { decision: 'allow', maxParallel: 1 }, adapter: async (t, ctx) => {
    active++; peak = Math.max(peak, active); await new Promise(r => setTimeout(r, 2)); active--; return adapter(t, ctx);
  } }));
  assert.equal(r.status, 'complete'); assert.equal(peak, 1);
  const m = await runPlan(plan('manager', [task('a'), task('b'), { ...task('synthesis'), dependsOn: ['a', 'b'] }]), options());
  assert.equal(m.status, 'complete');
});
test('refinement has at most two attempts and passes verifier feedback', async () => {
  let count = 0;
  const r = await runPlan(plan('refinement'), options({ adapter: async (t, ctx) => { if (ctx.attempt === 2) assert.equal(ctx.feedback, 'Fix edge case'); return adapter(t, ctx); }, verify: async () => ++count === 1 ? { passed: false, feedback: 'Fix edge case' } : verify() }));
  assert.equal(r.results.worker.attempts, 2);
  const failed = await runPlan(plan('refinement'), options({ verify: async () => ({ passed: false, feedback: 'Still broken' }) }));
  assert.equal(failed.status, 'unknown');
  assert.equal(failed.events.filter(event => event.phase === 'verification').length, 2);
  assert.deepEqual(failed.unresolvedTaskIds, ['worker']);
});
test('admission and catalog holds never call adapters', async () => {
  let calls = 0; const o = options({ adapter: async () => { calls++; } });
  await assert.rejects(runPlan(plan(), { ...o, admission: { decision: 'hold', maxParallel: 0 } }), /admission/);
  assert.equal((await runPlan(plan(), { ...o, catalog: [] })).status, 'hold'); assert.equal(calls, 0);
});
test('reported model mismatch, missing artifacts and missing evidence retain unresolved execution', async () => {
  for (const o of [options({ adapter: async () => ({ model: 'other' }) }), options({ adapter: async (t, ctx) => ({ ...await adapter(t, ctx), artifacts: [] }) }), options({ verify: async () => ({ passed: true }) })]) {
    assert.equal((await runPlan(plan(), o)).status, 'unknown');
  }
});
test('consequential results require independent verification', async () => {
  const p = plan('single', [{ ...task(), risk: 'consequential' }]);
  assert.equal((await runPlan(p, options())).status, 'unknown');
  assert.equal((await runPlan(p, options({ verify: async () => ({ ...await verify(), reviewerProvider: 'anthropic' }) }))).status, 'complete');
});
test('cancellation and timeout stop scheduling dependent work', async () => {
  const controller = new AbortController(); controller.abort();
  let calls = 0;
  assert.equal((await runPlan(plan(), options({ signal: controller.signal, adapter: async () => { calls++; } }))).status, 'cancelled');
  assert.equal(calls, 0);
  const r = await runPlan(plan('sequential', [task('a'), { ...task('b'), dependsOn: ['a'] }]), options({ timeoutMs: 5, adapter: async (_t, { signal }) => { calls++; return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); } }));
  assert.equal(r.status, 'unknown'); assert.match(r.error, /timeout/); assert.equal(calls, 1);
  assert.equal(r.capacityRetained, true);
  assert.deepEqual(r.unresolvedTaskIds, ['a']);
  await assert.rejects(runPlan(plan('sequential', [task('a'), { ...task('b'), dependsOn: ['a'] }]), options({ checkpoint: r })), /unresolved execution/);
});
test('resume re-verifies artifacts and rejects stale or tampered checkpoints', async () => {
  const first = await runPlan(plan(), options()); let calls = 0, checks = 0;
  const resumed = await runPlan(plan(), options({ checkpoint: first, adapter: async () => { calls++; }, verify: async () => { checks++; return verify(); } }));
  assert.equal(resumed.status, 'complete'); assert.equal(calls, 0); assert.equal(checks, 1);
  assert.deepEqual(resumed.events, first.events);
  await assert.rejects(runPlan({ ...plan(), id: 'changed' }, options({ checkpoint: first })), /Checkpoint/);
  await assert.rejects(runPlan(plan(), options({ checkpoint: first, verify: async () => ({ passed: false }) })), /Verification/);
});

test('dispatch intent is checkpointed before effects with a stable idempotency key', async () => {
  const order = [];
  const seen = [];
  const run = async () => runPlan(plan(), options({
    onCheckpoint: async snapshot => { order.push('checkpoint'); seen.push(snapshot); },
    adapter: async (t, ctx) => { order.push('adapter'); return adapter(t, ctx); },
  }));
  const first = await run();
  assert.equal(first.status, 'complete');
  assert.deepEqual(order.slice(0, 2), ['checkpoint', 'adapter']);
  assert.equal(seen[0].events[0].phase, 'dispatch_intent');
  assert.equal(seen[0].events[0].idempotencyKey.length, 64);
  const second = await run();
  assert.equal(second.events[0].idempotencyKey, first.events[0].idempotencyKey);
});

test('a failed intent checkpoint prevents dispatch', async () => {
  let calls = 0;
  let writes = 0;
  const receipt = await runPlan(plan(), options({
    onCheckpoint: async () => { if (++writes === 1) throw new Error('Store unavailable'); },
    adapter: async () => { calls++; return {}; },
  }));
  assert.equal(receipt.status, 'failed');
  assert.equal(calls, 0);
  assert.equal(receipt.capacityRetained, false);
  assert.equal(receipt.events.at(-1).phase, 'not_started');
});

test('parallel checkpoint writes serialize and unresolved work controls the final status', async () => {
  let activeWrites = 0;
  let peakWrites = 0;
  const persisted = [];
  const receipt = await runPlan(plan('parallel', [task('a'), task('b')]), options({
    onCheckpoint: async snapshot => {
      activeWrites++;
      peakWrites = Math.max(peakWrites, activeWrites);
      await new Promise(resolve => setTimeout(resolve, 2));
      persisted.push(snapshot);
      activeWrites--;
    },
    adapter: async (t, ctx) => {
      if (t.id === 'a') throw new Error('Transport lost');
      await new Promise(resolve => setTimeout(resolve, 2));
      return adapter(t, ctx);
    },
  }));
  assert.equal(peakWrites, 1);
  assert.equal(receipt.status, 'unknown');
  assert.equal(receipt.capacityRetained, true);
  assert.deepEqual(receipt.unresolvedTaskIds, ['a']);
  assert.equal(receipt.results.b.status, 'verified');
  assert.equal(persisted.at(-1).status, 'unknown');
});
