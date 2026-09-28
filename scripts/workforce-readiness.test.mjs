import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { assessWorkforce, validatePortfolio, renderWorkforceMarkdown } from './workforce-readiness.mjs';

const portfolio = JSON.parse(readFileSync(new URL('../runtime/policies/estate-workforce.json', import.meta.url), 'utf8'));
const now = '2026-09-05T10:00:00Z';
const fixture = () => ({
  schema: 'starlight.systems-graph/v1', generatedAt: now,
  sources: Object.fromEntries(['windows', 'hermes', 'loops', 'railway', 'n8n'].map(id => [id, { capturedAt: now }])),
  findings: { hermes: { planeStalled: false }, loops: { planeStalled: false }, n8n: { active: 27, heartbeatFiles: 1 } },
  nodes: [{ id: 'agent:steward-frankx', name: 'steward-frankx', plane: 'agent-corps',
    state: 'live', heartbeatAgeH: 0.01, lastObserved: now }],
});
const codes = result => result.blockers.map(item => item.code);

test('twelve business units map to three pilots without granting authority', () => {
  const result = assessWorkforce(portfolio, fixture(), now);
  assert.equal(result.units.length, 12);
  assert.equal(result.counts.pilot_candidates, 3);
  assert.equal(result.admitted, false);
  assert.equal(result.counts.verified_active_workers, null);
  assert.equal(result.units[0].steward_evidence, 'recent-steward-evidence');
  assert(codes(result).includes('trusted-admission-required'));
  assert(codes(result).includes('cloud-queue-proof-required'));
});
test('fresh generation cannot launder stale provider snapshots', () => {
  const graph = fixture();
  graph.sources.railway.capturedAt = '2026-09-02T00:00:00Z';
  assert(codes(assessWorkforce(portfolio, graph, now)).includes('source-railway-stale'));
});
test('stale and future graph timestamps cannot establish steward liveness', () => {
  for (const timestamp of ['2026-09-04T10:00:00Z', '2026-09-06T10:00:00Z', 'garbage']) {
    const graph = fixture(); graph.generatedAt = timestamp;
    assert.equal(assessWorkforce(portfolio, graph, now).units[0].steward_evidence, 'unverified');
  }
});
test('stalled planes remain blocked even with nominally live agents', () => {
  const graph = fixture(); graph.findings.hermes.planeStalled = true; graph.findings.loops.planeStalled = true;
  const result = assessWorkforce(portfolio, graph, now);
  assert(codes(result).includes('hermes-not-proven-running'));
  assert(codes(result).includes('loops-not-proven-running'));
});
test('active n8n flag alone never establishes completed runs', () => {
  const graph = fixture(); graph.findings.n8n.heartbeatFiles = 0;
  assert(codes(assessWorkforce(portfolio, graph, now)).includes('n8n-run-proof-missing'));
});
test('missing and malformed graph evidence fails closed', () => {
  for (const graph of [null, {}, [], { schema: 'unknown', nodes: [] }]) {
    const result = assessWorkforce(portfolio, graph, now);
    assert.equal(result.admitted, false);
    assert(codes(result).includes('invalid-systems-graph'));
  }
});
test('invalid evaluation time is rejected', () => {
  assert.throws(() => assessWorkforce(portfolio, fixture(), 'bad'), /ISO timestamp/);
});
test('duplicate or missing node identities are reported', () => {
  const graph = fixture(); graph.nodes.push({ ...graph.nodes[0] });
  const result = assessWorkforce(portfolio, graph, now);
  assert(codes(result).includes('ambiguous-node-identities'));
  assert.equal(result.units[0].steward_evidence, 'unverified');
});
test('steward last observation and heartbeat must both be fresh', () => {
  const graph = fixture(); graph.nodes[0].lastObserved = '2026-09-01T00:00:00Z';
  assert.equal(assessWorkforce(portfolio, graph, now).units[0].steward_evidence, 'unverified');
  graph.nodes[0].lastObserved = now; graph.nodes[0].heartbeatAgeH = -1;
  assert.equal(assessWorkforce(portfolio, graph, now).units[0].steward_evidence, 'unverified');
});
test('portfolio rejects second authority, duplicates, spending and missing critics', () => {
  for (const mutate of [
    p => { p.authority = 'brand-queen'; },
    p => { p.units[1].id = p.units[0].id; },
    p => { p.budget.authorized_daily_usd = 25; },
    p => { p.roles.pop(); },
    p => { p.units[4].pilot = true; },
  ]) {
    const copy = structuredClone(portfolio); mutate(copy);
    assert.throws(() => validatePortfolio(copy));
  }
});
test('markdown is an evidence table with actionable owners', () => {
  const text = renderWorkforceMarkdown(assessWorkforce(portfolio, fixture(), now));
  assert(text.includes('| GenCreator | steward-revenue | pilot-candidate |'));
  assert(text.includes('Owner: steward-substrate'));
  assert(text.includes('activation not authorized'));
});
