import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { sha256Digest } from './runtime-digest';
import {
  testRuntimePlan,
  testRuntimePlanningPolicySource,
  testTeamProfile,
} from './runtime-test-fixtures';
import {
  parsePreparedRuntimeBundle,
  prepareRuntimeBundle,
  probeRuntimeHealth,
  verifyPreparedRuntimeBundle,
} from './runtime-adapters';
import { parseRuntimePlanningPolicy } from './runtime-policy';
import { compileTeamPack } from './team-pack';
import {
  verifyTeamPackDirectory,
  type TeamPackVerificationResult,
} from './team-pack-verifier';

function fabricatedVerification(): TeamPackVerificationResult {
  const plan = testRuntimePlan();
  const policy = parseRuntimePlanningPolicy(testRuntimePlanningPolicySource);
  const pack = compileTeamPack(testTeamProfile, plan, testRuntimePlanningPolicySource);
  return {
    status: 'verified-human-approval-required',
    team_id: plan.team_id,
    plan_digest_sha256: pack.manifest.plan_digest_sha256,
    source_profile_digest_sha256: pack.manifest.source_profile_digest_sha256,
    source_runtime_policy_digest_sha256: policy.source_digest_sha256,
    pack_digest_sha256: sha256Digest({
      manifest: pack.manifest,
      file_digests: pack.file_digests,
    }),
    compiler_version: pack.manifest.compiler_version,
    files_verified: Object.keys(pack.files).length + 1,
  };
}

function verification(plan = testRuntimePlan()): TeamPackVerificationResult {
  const pack = compileTeamPack(testTeamProfile, plan, testRuntimePlanningPolicySource);
  const directory = mkdtempSync(join(tmpdir(), 'starlight-runtime-adapter-pack-'));
  for (const [path, content] of Object.entries(pack.files)) {
    const destination = join(directory, path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, content, 'utf8');
  }
  const packDigest = sha256Digest({ manifest: pack.manifest, file_digests: pack.file_digests });
  writeFileSync(
    join(directory, 'manifest.json'),
    `${JSON.stringify({ ...pack.manifest, pack_digest_sha256: packDigest }, null, 2)}\n`,
    'utf8',
  );
  return verifyTeamPackDirectory(
    directory,
    plan,
    testTeamProfile,
    testRuntimePlanningPolicySource,
  );
}

test('rejects a caller-fabricated pack verification object even when its fields match', () => {
  assert.throws(
    () => prepareRuntimeBundle(testRuntimePlan(), fabricatedVerification()),
    /issued by the team-pack verifier/i,
  );
});

test('prepares three bounded lanes without granting activation authority', () => {
  const bundle = prepareRuntimeBundle(testRuntimePlan(), verification());

  assert.equal(bundle.status, 'prepared-human-approval-required');
  assert.equal(bundle.lanes.length, 3);
  assert.deepEqual(
    bundle.lanes.map((lane) => lane.runtime),
    ['vercel-eve', 'railway-temporal', 'hermes-local'],
  );
  assert.ok(bundle.lanes.every((lane) => lane.max_concurrency === 1));
  assert.ok(bundle.lanes.every((lane) => lane.lease_ttl_seconds === 900));
  assert.ok(bundle.lanes.every((lane) => lane.activation_authority.includes('not-implemented')));

  const eve = bundle.lanes.find((lane) => lane.runtime === 'vercel-eve');
  assert.deepEqual(eve?.runtime_config, {
    kind: 'vercel-eve',
    deployment_target: 'existing-vercel-project',
    workflow_route: '/api/eve',
    tool_grants: [],
    write_scopes: [],
    canonical_state: 'read-only-projection',
  });

  const durable = bundle.lanes.find((lane) => lane.runtime === 'railway-temporal');
  assert.match(
    durable?.runtime_config.kind === 'railway-temporal'
      ? durable.runtime_config.workflow_id_prefix
      : '',
    /^starlight\/starlight-platform-team-[a-f0-9]{24}-durable-builder-[a-f0-9]{24}\//,
  );
});

test('derived deployment and kill-switch identities remain unique for normalization-colliding lane ids', () => {
  const plan = testRuntimePlan();
  plan.lanes[1].id = 'maker.a';
  plan.lanes[2].id = 'maker_a';
  const receipt = verification(plan);

  const bundle = prepareRuntimeBundle(plan, receipt);
  assert.equal(new Set(bundle.lanes.map((lane) => lane.deployment_id)).size, bundle.lanes.length);
  assert.equal(new Set(bundle.lanes.map((lane) => lane.kill_switch)).size, bundle.lanes.length);
});

test('rejects an issued pack receipt that is not bound to the exact runtime plan', () => {
  const plan = testRuntimePlan();
  const issuedForAnotherPlan = verification();
  plan.generated_at = '2026-08-06T03:01:00.000Z';
  assert.throws(
    () => prepareRuntimeBundle(plan, issuedForAnotherPlan),
    /exact runtime plan, profile, and policy/i,
  );
});

test('prepared bundle parser rejects adapter-shape confusion and duplicate authorities', () => {
  const plan = testRuntimePlan();
  const receipt = verification(plan);
  const bundle = prepareRuntimeBundle(plan, receipt);
  const forged = structuredClone(bundle);
  forged.lanes[0].runtime_config = {
    kind: 'hermes-local',
    deployment_target: 'isolated-hermes-profile',
    profile: 'starlight-team-worker',
    canonical_state: 'sis-postgres',
  };
  assert.throws(() => parsePreparedRuntimeBundle(forged), /prepared runtime bundle/i);

  const duplicate = structuredClone(bundle);
  duplicate.lanes[1].deployment_id = duplicate.lanes[0].deployment_id;
  assert.throws(() => parsePreparedRuntimeBundle(duplicate), /deployment ids must be unique/i);
});

test('prepared bundle verification rejects any descriptor not deterministically derived from its plan and issued pack', () => {
  const plan = testRuntimePlan();
  const receipt = verification(plan);
  const bundle = prepareRuntimeBundle(plan, receipt);
  bundle.lanes[1].lease_ttl_seconds = 901 as 900;
  assert.throws(
    () => verifyPreparedRuntimeBundle(bundle, plan, receipt),
    /prepared runtime bundle|canonical derived bundle/i,
  );
});

test('health probe is GET-only, redacts paths, and requires the bounded ready contract', async () => {
  let method = '';
  const fetcher: typeof fetch = async (_input, init) => {
    method = init?.method ?? '';
    return new Response(JSON.stringify({ ok: true, status: 'ready' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const result = await probeRuntimeHealth(
    'http://127.0.0.1:8787/health',
    '2026-08-06T04:00:00.000Z',
    fetcher,
  );
  assert.equal(method, 'GET');
  assert.equal(result.status, 'ready');
  assert.equal(result.endpoint_origin, 'http://127.0.0.1:8787');
  assert.doesNotMatch(JSON.stringify(result), /\/health/);
});

test('health probe fails closed for every remote host and non-health path', async () => {
  await assert.rejects(
    () => probeRuntimeHealth('http://worker.example.test/health'),
    /loopback/i,
  );
  await assert.rejects(
    () => probeRuntimeHealth('https://169.254.169.254/latest/meta-data'),
    /loopback|remote/i,
  );
  await assert.rejects(
    () => probeRuntimeHealth('https://worker.example.test/health'),
    /server-owned registry|remote/i,
  );
  await assert.rejects(
    () => probeRuntimeHealth('http://localhost/private/health'),
    /literal loopback/i,
  );
  await assert.rejects(
    () => probeRuntimeHealth('http://localhost/health'),
    /literal loopback/i,
  );
});
