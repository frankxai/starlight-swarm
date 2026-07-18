import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { parseHandContract } from './hand-contract';

function boundedCollector(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 'starlight.hand.v1',
    id: 'collector-openfang-pilot',
    owner: 'starlight-queen',
    runtime: 'openfang-sidecar',
    mode: 'read-only',
    enabled: false,
    mission: {
      outcome: 'Produce a source-backed competitive-change brief.',
      done_when: [
        'report exists',
        'receipt validates',
        'every graph edge cites a source',
      ],
    },
    schedule: {
      kind: 'interval',
      every_minutes: 1440,
      timezone: 'Europe/Amsterdam',
      max_runs: 14,
    },
    capabilities: {
      tools: ['web_search', 'web_fetch', 'knowledge_query', 'knowledge_add_entity'],
      deny: ['shell_exec', 'file_write', 'external_send', 'publish', 'spend', 'secrets'],
    },
    memory: {
      canonical_authority: 'SIS',
      write_mode: 'projection-only',
      read_namespaces: ['public-strategic'],
      knowledge_graph: {
        source_required: true,
        confidence_required: true,
      },
    },
    execution: {
      max_minutes: 30,
      max_model_cost_usd: 1,
      max_tool_calls: 40,
      workdir: 'runtime/openfang-pilot/inbox',
    },
    phases: ['recover', 'plan', 'collect', 'cross-check', 'graph', 'verify', 'receipt'],
    human_gates: ['external_send', 'publish', 'spend', 'secrets', 'repo_write'],
    receipt: {
      required_artifacts: ['report', 'machine-readable-receipt', 'sourced-graph-delta'],
      verifier: 'independent',
    },
    ...overrides,
  };
}

test('accepts a disabled, read-only, SIS-projection collector hand', () => {
  const parsed = parseHandContract(boundedCollector());

  assert.equal(parsed.id, 'collector-openfang-pilot');
  assert.equal(parsed.enabled, false);
  assert.equal(parsed.memory.canonical_authority, 'SIS');
});

test('rejects a second canonical memory authority', () => {
  const hand = boundedCollector({
    memory: {
      canonical_authority: 'OpenFang',
      write_mode: 'projection-only',
      read_namespaces: ['public-strategic'],
      knowledge_graph: { source_required: true, confidence_required: true },
    },
  });

  assert.throws(() => parseHandContract(hand), /canonical_authority[\s\S]*SIS/i);
});

test('rejects shell execution in read-only mode even when it is also denied', () => {
  const hand = boundedCollector({
    capabilities: {
      tools: ['web_search', 'shell_exec'],
      deny: ['shell_exec', 'file_write', 'external_send', 'publish', 'spend', 'secrets'],
    },
  });

  assert.throws(() => parseHandContract(hand), /read-only.*shell_exec/i);
});

test('requires all irreversible capabilities to be denied for read-only hands', () => {
  const hand = boundedCollector({
    capabilities: {
      tools: ['web_search'],
      deny: ['shell_exec', 'file_write'],
    },
  });

  assert.throws(() => parseHandContract(hand), /missing deny capabilities.*external_send/i);
});

test('rejects an aggressive sub-hour autonomous interval', () => {
  const hand = boundedCollector({
    schedule: {
      kind: 'interval',
      every_minutes: 15,
      timezone: 'Europe/Amsterdam',
      max_runs: 14,
    },
  });

  assert.throws(() => parseHandContract(hand), /every_minutes.*60/i);
});

test('requires sourced and confidence-scored graph projections', () => {
  const hand = boundedCollector({
    memory: {
      canonical_authority: 'SIS',
      write_mode: 'projection-only',
      read_namespaces: ['public-strategic'],
      knowledge_graph: { source_required: false, confidence_required: true },
    },
  });

  assert.throws(() => parseHandContract(hand), /knowledge graph.*source.*confidence/i);
});

test('requires the full recover-to-receipt lifecycle', () => {
  const hand = boundedCollector({ phases: ['collect', 'graph', 'receipt'] });

  assert.throws(() => parseHandContract(hand), /missing phases.*recover/i);
});

test('the checked-in OpenFang pilot hand satisfies the runtime contract', () => {
  const fixtureUrl = new URL('../../hands/examples/collector-openfang-pilot.hand.json', import.meta.url);
  const fixture = JSON.parse(readFileSync(fixtureUrl, 'utf8'));

  const parsed = parseHandContract(fixture);
  assert.equal(parsed.runtime, 'openfang-sidecar');
  assert.equal(parsed.enabled, false, 'pilot must remain inert until the credential gate is approved');
});
