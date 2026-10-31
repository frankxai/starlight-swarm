import test from 'node:test';
import assert from 'node:assert/strict';
import { selectModel } from './router.mjs';
import { runPlan } from './runtime.mjs';
import { julesExecutionCutoff, acceptanceLowerBound } from './evidence-routing.mjs';

const now = Date.parse('2026-10-31T13:00:00Z');
const presets = { version: 'fixture:v1', routes: { debugging: { model: 'frontier', effort: 'high' }, security: { model: 'frontier', effort: 'high' } } };
const policy = { version: 1, mode: 'frontier', datasetId: 'fixture:repair-v1', datasetHash: 'a'.repeat(64), rubricHash: 'b'.repeat(64), caseCount: 100, minimumLowerBound: 0.9, maxCostPerAcceptedMicroUsd: 25_000 };
const capability = (model = 'frontier', extra = {}) => ({ model, runtime: 'codex-cloud', provider: 'fixture-provider', available: true, verifiedAt: new Date(now).toISOString(), efforts: ['high'], tools: ['read', 'patch'], evidenceRef: `fixture:probe:${model}`, ...extra });
const evaluation = (model = 'frontier', extra = {}) => ({ model, runtime: 'codex-cloud', provider: 'fixture-provider', effort: 'high', taskClass: 'debugging', ...policy, mode: undefined, acceptedCases: 100, attempts: 110, criticalFailures: 0, totalCostMicroUsd: 2_000_000, costBasis: 'all-attempts-measured', costScope: 'execution-repair-and-verification', verifiedAt: new Date(now).toISOString(), evidenceRef: `fixture:eval:${model}`, costEvidenceRef: `fixture:cost:${model}`, ...extra });
const request = extra => ({ taskClass: 'debugging', runtime: 'codex-cloud', tools: ['read', 'patch'], model: 'frontier', effort: 'high', allowFallback: true, fallbacks: ['efficient', 'weak'], selectionPolicy: { ...policy }, ...extra });
const catalog = [capability(), capability('efficient'), capability('weak')];
const evaluations = [evaluation(), evaluation('efficient', { acceptedCases: 99, totalCostMicroUsd: 10_000 }), evaluation('weak', { acceptedCases: 98, totalCostMicroUsd: 1_000 })];
const select = (r = request(), e = evaluations, c = catalog, opts = {}) => selectModel(r, c, presets, { now, evaluations: e, ...opts });

test('frontier uses comparable quality ahead of lower price and records exact evidence', () => {
  const s = select();
  assert.equal(s.model, 'frontier');
  assert.equal(s.evidenceStatus, 'measured-frozen-suite-only');
  assert.equal(s.executionAuthorityGranted, false);
  assert.equal(s.evaluation.attempts, 110);
  assert.equal(s.evaluation.costPerAcceptedMicroUsd, 20_000);
  assert.match(s.evaluation.recordHash, /^[a-f0-9]{64}$/);
});
test('ordinary efficiency can choose cheaper only within explicit quality tolerance', () => {
  const s = select(request({ selectionPolicy: { ...policy, mode: 'efficient', qualityTolerance: 0.02 } }), evaluations, catalog, { risk: 'ordinary' });
  assert.equal(s.model, 'efficient');
  assert.equal(s.wasFallback, true);
  assert.equal(select(request({ selectionPolicy: { ...policy, mode: 'efficient' } }), evaluations, catalog, { risk: 'ordinary' }).model, 'frontier');
});
test('cost ceiling cannot silently lower frontier quality', () => {
  const s = select(request({ selectionPolicy: { ...policy, maxCostPerAcceptedMicroUsd: 1000 } }));
  assert.equal(s.status, 'hold');
  assert.match(s.reason, /cost ceiling/);
});
test('explicit model and reviewer independence remain binding', () => {
  assert.equal(select(request({ allowFallback: false }), [evaluations[1]]).status, 'hold');
  assert.equal(select(request({ independentOf: 'fixture-provider' })).status, 'hold');
});
test('public catalog, missing or stale probes do not qualify measured results', () => {
  for (const extra of [{ available: false }, { verifiedAt: '2020-01-01' }, { tools: ['read'] }, { efforts: ['low'] }, { evidenceRef: '' }]) {
    assert.equal(select(request({ allowFallback: false }), evaluations, [capability('frontier', extra)]).status, 'hold');
  }
});
test('unknown, stale, future, mismatched and failed evaluation evidence holds', () => {
  const invalid = [
    { totalCostMicroUsd: null }, { totalCostMicroUsd: -1 }, { totalCostMicroUsd: Number.MAX_SAFE_INTEGER + 1 },
    { criticalFailures: 1 }, { acceptedCases: 101 }, { acceptedCases: 0 }, { attempts: 99 },
    { caseCount: 99 }, { rubricHash: 'c'.repeat(64) }, { datasetHash: 'd'.repeat(64) },
    { effort: 'low' }, { runtime: 'local' }, { provider: 'other' },
    { verifiedAt: new Date(now - 7 * 86_400_000 - 1).toISOString() }, { verifiedAt: new Date(now + 1).toISOString() },
    { costBasis: 'catalog-estimate' }, { costScope: 'input-output-only' }, { costEvidenceRef: '' }, { evidenceRef: '' },
  ];
  for (const extra of invalid) assert.equal(select(request({ allowFallback: false }), [evaluation('frontier', extra)]).status, 'hold', JSON.stringify(extra));
  assert.equal(select(request(), []).status, 'hold');
});
test('frozen suite quality floor excludes inadequate candidates', () => {
  assert.equal(select(request({ allowFallback: false }), [evaluation('frontier', { acceptedCases: 80 })]).status, 'hold');
  assert.ok(acceptanceLowerBound(100, 100) < 1);
  assert.ok(acceptanceLowerBound(99, 100) < acceptanceLowerBound(100, 100));
});
test('ambiguous records and invalid or unbounded policy reject before dispatch', () => {
  assert.throws(() => select(request(), [evaluation(), evaluation()]), /Ambiguous/);
  for (const p of [{ version: 2 }, { datasetHash: 'unknown' }, { rubricHash: '' }, { caseCount: 19 }, { minimumLowerBound: 0 }, { maxCostPerAcceptedMicroUsd: undefined }, { mode: 'efficient', qualityTolerance: 0.03 }, { qualityTolerance: 0.01 }]) {
    assert.throws(() => select(request({ selectionPolicy: { ...policy, ...p } })), /policy|hash|cases|floor|ceiling|tolerance|quality/);
  }
});
test('consequential, security and standalone selection reject efficient quality trade', () => {
  const r = request({ selectionPolicy: { ...policy, mode: 'efficient' } });
  assert.throws(() => select(r), /ordinary tasks/);
  assert.throws(() => select({ ...r, taskClass: 'security' }, evaluations, catalog, { risk: 'ordinary' }), /ordinary tasks/);
});
test('Jules cutoff applies to both aliases and to legacy selection', () => {
  const end = Date.parse(julesExecutionCutoff);
  for (const runtime of ['jules', 'jules-cloud']) {
    const r = request({ runtime, selectionPolicy: undefined, allowFallback: false });
    const c = [capability('frontier', { runtime, verifiedAt: new Date(end - 1).toISOString() })];
    assert.equal(select(r, [], c, { now: end - 1 }).status, 'selected');
    assert.equal(select(r, [], c, { now: end }).status, 'hold');
  }
});
test('invalid or expired capability lifecycle and invalid clock fail closed', () => {
  for (const executionNotAfter of ['unknown', new Date(now).toISOString()]) assert.equal(select(request({ allowFallback: false }), evaluations, [capability('frontier', { executionNotAfter })]).status, 'hold');
  assert.throws(() => select(request(), evaluations, catalog, { now: NaN }), /selection time/);
});

const task = { id: 'repair', objective: 'Repair fixture', repo: 'fixture/repo', access: 'read', risk: 'ordinary', ownedPaths: [], inputRefs: ['fixture:bug'], dependsOn: [], artifact: 'fixture:patch', stopCondition: 'Verified patch', verification: 'Fixture regression', request: request() };
const plan = { version: 1, id: 'evidence-routing', pattern: 'single', tasks: [task] };
const opts = extra => ({ catalog, evaluations, presets, now, admission: { decision: 'allow', maxParallel: 1 }, onCheckpoint: async () => {}, verify: async () => ({ passed: true, reviewerProvider: 'independent-fixture', evidenceRefs: ['fixture:passed'] }), adapter: async (_, { selection }) => ({ model: selection.model, provider: selection.provider, runtime: selection.runtime, artifacts: ['fixture:patch'] }), ...extra });
test('runPlan passes host evidence and stores measured routing in dispatch intent', async () => {
  const snapshots = [];
  const r = await runPlan(plan, opts({ onCheckpoint: async s => snapshots.push(s) }));
  assert.equal(r.status, 'complete');
  assert.equal(snapshots[0].events[0].selection.evaluation.evidenceRef, 'fixture:eval:frontier');
  assert.equal(r.results.repair.selection.evaluation.caseCount, 100);
});
test('runPlan cannot accept task-supplied evaluations or request-supplied risk downgrade', async () => {
  let called = false;
  const forged = structuredClone(plan);
  forged.tasks[0].request.evaluations = evaluations;
  assert.equal((await runPlan(forged, opts({ evaluations: [], adapter: async () => { called = true; } }))).status, 'hold');
  assert.equal(called, false);
  forged.tasks[0].risk = 'consequential';
  forged.tasks[0].request.risk = 'ordinary';
  forged.tasks[0].request.selectionPolicy.mode = 'efficient';
  await assert.rejects(runPlan(forged, opts()), /ordinary tasks/);
});
test('resume re-verifies artifacts and does not dispatch an already verified result', async () => {
  const checkpoint = await runPlan(plan, opts());
  let calls = 0;
  const resumed = await runPlan(plan, opts({ checkpoint, adapter: async () => { calls++; }, verify: async (_, __, ctx) => {
    assert.equal(ctx.resumed, true);
    return { passed: true, evidenceRefs: ['fixture:reverified'] };
  } }));
  assert.equal(resumed.status, 'complete');
  assert.equal(calls, 0);
  assert.deepEqual(resumed.results.repair.verification.evidenceRefs, ['fixture:reverified']);
});
