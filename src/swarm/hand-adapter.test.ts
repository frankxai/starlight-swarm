import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { assessHandAdmission, compileOpenFangHand } from './hand-adapter';

function fixture() {
  const fixtureUrl = new URL('../../hands/examples/collector-openfang-pilot.hand.json', import.meta.url);
  return JSON.parse(readFileSync(fixtureUrl, 'utf8'));
}

function safeEnvironment(overrides: Record<string, unknown> = {}) {
  return {
    action: 'single-run',
    free_gib: 200,
    available_memory_gib: 12,
    checksum_verified: true,
    defender_detections: 0,
    publisher_signed: false,
    credential_strategy: 'isolated-pilot',
    runtime_process_owned: true,
    port_available: true,
    equivalent_schedule_count: 0,
    adapter_preserves_denies: true,
    canonical_memory_writes: false,
    ...overrides,
  };
}

test('compiles an OpenFang Hand as reactive with a strict read-only tool allowlist', () => {
  const compiled = compileOpenFangHand(fixture());

  assert.equal(compiled.execution_mode, 'reactive');
  assert.match(compiled.toml, /tools = \["web_search", "web_fetch", "knowledge_query", "knowledge_add_entity"\]/);
  assert.match(compiled.toml, /mcp_servers = \["starlight-deny-all-mcp"\]/);
  assert.match(compiled.toml, /skills = \["starlight-hand-read-only"\]/);
  assert.doesNotMatch(compiled.toml, /max_iterations/);
  assert.doesNotMatch(compiled.toml, /shell_exec|file_write|schedule_create|event_publish/);
});

test('rejects tools that the OpenFang read-only adapter cannot faithfully confine', () => {
  const hand = fixture();
  hand.capabilities.tools.push('browser_automation');

  assert.throws(() => compileOpenFangHand(hand), /unsupported OpenFang tools.*browser_automation/i);
});

test('rejects a Hermes contract sent to the OpenFang compiler', () => {
  const hand = fixture();
  hand.runtime = 'hermes-cron';

  assert.throws(() => compileOpenFangHand(hand), /runtime.*openfang-sidecar/i);
});

test('admission rejects an inert contract until activation is explicit', () => {
  const hand = fixture();
  const result = assessHandAdmission(hand, compileOpenFangHand(hand), safeEnvironment());

  assert.equal(result.admitted, false);
  assert.match(result.blockers.join(' '), /enabled=false/i);
});

test('admission rejects primary-profile credentials and continuous Hand mode', () => {
  const hand = fixture();
  hand.enabled = true;
  const compiled = { ...compileOpenFangHand(hand), execution_mode: 'continuous' as const };
  const result = assessHandAdmission(
    hand,
    compiled,
    safeEnvironment({ credential_strategy: 'primary-profile' }),
  );

  assert.equal(result.admitted, false);
  assert.match(result.blockers.join(' '), /reactive/i);
  assert.match(result.blockers.join(' '), /primary-profile/i);
});

test('admission fails closed on capacity, integrity, schedule, and memory violations', () => {
  const hand = fixture();
  hand.enabled = true;
  const result = assessHandAdmission(
    hand,
    compileOpenFangHand(hand),
    safeEnvironment({
      available_memory_gib: 4,
      checksum_verified: false,
      defender_detections: 1,
      equivalent_schedule_count: 1,
      canonical_memory_writes: true,
    }),
  );

  assert.equal(result.admitted, false);
  assert.match(result.blockers.join(' '), /memory.*8 GiB/i);
  assert.match(result.blockers.join(' '), /checksum/i);
  assert.match(result.blockers.join(' '), /Defender/i);
  assert.match(result.blockers.join(' '), /equivalent schedule/i);
  assert.match(result.blockers.join(' '), /canonical memory/i);
});

test('admits one bounded run with isolated credentials and records unsigned-binary warning', () => {
  const hand = fixture();
  hand.enabled = true;
  const result = assessHandAdmission(
    hand,
    compileOpenFangHand(hand),
    safeEnvironment({ evidence_observed_at: '2026-07-18T08:00:00.000Z' }),
    '2026-07-18T08:05:00.000Z',
  );

  assert.equal(result.admitted, true);
  assert.deepEqual(result.blockers, []);
  assert.match(result.warnings.join(' '), /not Authenticode-signed/i);
});

test('admission fails closed when live environment evidence has no observation timestamp', () => {
  const hand = fixture();
  hand.enabled = true;
  const result = assessHandAdmission(hand, compileOpenFangHand(hand), safeEnvironment());

  assert.equal(result.admitted, false);
  assert.match(result.blockers.join(' '), /evidence_observed_at is required/i);
});

test('admission rejects stale environment evidence even when every other gate is green', () => {
  const hand = fixture();
  hand.enabled = true;
  const result = assessHandAdmission(
    hand,
    compileOpenFangHand(hand),
    safeEnvironment({ evidence_observed_at: '2026-07-18T08:00:00.000Z' }),
    '2026-07-18T08:16:00.000Z',
  );

  assert.equal(result.admitted, false);
  assert.match(result.blockers.join(' '), /older than 15 minutes/i);
});

test('checked-in OpenFang HAND.toml exactly matches the compiler output', () => {
  const compiled = compileOpenFangHand(fixture());
  const handUrl = new URL('../../hands/openfang/collector-openfang-pilot/HAND.toml', import.meta.url);

  assert.equal(readFileSync(handUrl, 'utf8'), compiled.toml);
});

test('OpenFang adapter skill preserves the external scheduler and SIS boundaries', () => {
  const skillUrl = new URL('../../hands/openfang/collector-openfang-pilot/SKILL.md', import.meta.url);
  const skill = readFileSync(skillUrl, 'utf8');

  assert.match(skill, /never create.*schedule/i);
  assert.match(skill, /never write directly to SIS/i);
  assert.match(skill, /never send.*external/i);
  assert.match(skill, /run receipt/i);
});
