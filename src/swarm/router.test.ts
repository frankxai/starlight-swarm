import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ModelRouter, tierFor } from './router';
import { SWARM_MODEL_MATRIX } from './generals';

test('tier follows the general by default, explicit tier wins, high-risk forces council', () => {
  assert.equal(tierFor({}), 'build');
  assert.equal(tierFor({ general: 'starlight-hermes' }), 'scout');
  assert.equal(tierFor({ general: 'starlight-sentinel' }), 'council');
  assert.equal(tierFor({ general: 'starlight-hermes', tier: 'build' }), 'build');
  assert.equal(tierFor({ general: 'starlight-hermes', highRisk: true }), 'council');
});

test('primary available: used, no fallback, reason names the model', () => {
  const r = new ModelRouter().route({ general: 'starlight-weaver' });
  assert.equal(r.usedModel, SWARM_MODEL_MATRIX.build.primaryModel);
  assert.equal(r.wasFallback, false);
  assert.equal(r.refused, false);
  assert.match(r.reason, /claude-sonnet-4-6/);
});

test('non-critical lane falls back and says so on the result', () => {
  const router = new ModelRouter({ availability: (m) => m !== 'gemini-2.5-flash' });
  const r = router.route({ general: 'starlight-hermes' });
  assert.equal(r.usedModel, 'deepseek-v3.2');
  assert.equal(r.wasFallback, true);
  assert.equal(r.critical, false);
  assert.match(r.reason, /fell back/);
});

test('critical lanes never fall back silently: refuse and escalate to the founder board', () => {
  const noOpus = new ModelRouter({ availability: (m) => m !== 'claude-opus-4-6' });
  for (const req of [{ general: 'starlight-sentinel' as const }, { highRisk: true }, { tier: 'build' as const, critical: true }]) {
    const avail = req.tier === 'build' ? new ModelRouter({ availability: (m) => m !== 'claude-sonnet-4-6' }) : noOpus;
    const r = avail.route(req);
    assert.equal(r.refused, true, JSON.stringify(req));
    assert.equal(r.usedModel, '');
    assert.equal(r.wasFallback, false);
    assert.equal(r.escalate, 'founder-board');
    assert.equal(r.critical, true);
  }
});

test('no model at all: refused with both models named', () => {
  const r = new ModelRouter({ availability: () => false }).route({ general: 'starlight-sage' });
  assert.equal(r.refused, true);
  assert.match(r.reason, /claude-sonnet-4-6, gpt-5.4/);
});
