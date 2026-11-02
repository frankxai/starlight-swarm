/**
 * router.test.ts — routing policy: every class routes, fallback only for
 * reversible work, irreversible work waits, dry-run overrides everything.
 *
 * Run:  node --test --import tsx src/managed-runtime/router.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ROUTING_TABLE, DEFAULT_MODELS, routeWorkload } from './router';
import { workloadClassSchema } from './contract';
import type { Provider } from './contract';

test('every workload class in the schema has a routing entry', () => {
  for (const workloadClass of workloadClassSchema.options) {
    assert.ok(ROUTING_TABLE[workloadClass], `missing route for ${workloadClass}`);
  }
});

test('every routing entry resolves without throwing when all providers are available', () => {
  for (const workloadClass of workloadClassSchema.options) {
    const route = routeWorkload(workloadClass, { reversible: false });
    assert.equal(route.degraded, false);
    assert.equal(route.provider, ROUTING_TABLE[workloadClass].provider);
  }
});

test('architecture routes to Anthropic top tier with a concrete model id', () => {
  const route = routeWorkload('architecture', { reversible: false });
  assert.equal(route.provider, 'anthropic');
  assert.equal(route.modelClass, 'top');
  assert.equal(route.model, DEFAULT_MODELS.anthropic.top);
});

test('openai routes leave the model undefined so the SDK applies its default', () => {
  const route = routeWorkload('tool-orchestration', { reversible: true });
  assert.equal(route.provider, 'openai');
  assert.equal(route.model, undefined);
});

test('reversible work degrades to the fallback when the default provider is unavailable', () => {
  const route = routeWorkload('bulk-extraction', { reversible: true }, { unavailable: new Set<Provider>(['gemini']) });
  assert.equal(route.provider, 'anthropic');
  assert.equal(route.degraded, true);
  assert.match(route.why, /unavailable/);
});

test('irreversible work never degrades; it throws and waits', () => {
  assert.throws(
    () => routeWorkload('bulk-extraction', { reversible: false }, { unavailable: new Set<Provider>(['gemini']) }),
    /not reversible/,
  );
});

test('a class with no fallback throws when its provider is unavailable even for reversible work', () => {
  assert.throws(
    () => routeWorkload('architecture', { reversible: true }, { unavailable: new Set<Provider>(['anthropic']) }),
    /no available fallback/,
  );
});

test('fallback that is itself unavailable throws', () => {
  assert.throws(
    () =>
      routeWorkload('tool-orchestration', { reversible: true }, { unavailable: new Set<Provider>(['openai', 'anthropic']) }),
    /no available fallback/,
  );
});

test('dry-run policy routes everything to the dry-run provider and records the real route', () => {
  const route = routeWorkload('canon', { reversible: false }, { dryRun: true });
  assert.equal(route.provider, 'dry-run');
  assert.equal(route.model, 'dry-run');
  assert.match(route.why, /would be anthropic\/top/);
});

test('owner model overrides win over defaults', () => {
  const route = routeWorkload(
    'customer-chat',
    { reversible: true },
    { models: { ...DEFAULT_MODELS, openai: { operational: 'owner-set-model' } } },
  );
  assert.equal(route.model, 'owner-set-model');
});
