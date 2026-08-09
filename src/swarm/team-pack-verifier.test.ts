import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
import { compileTeamPack } from './team-pack';
import { verifyTeamPackDirectory } from './team-pack-verifier';

function materializePack(): string {
  const pack = compileTeamPack(
    testTeamProfile,
    testRuntimePlan(),
    testRuntimePlanningPolicySource,
  );
  const directory = mkdtempSync(join(tmpdir(), 'starlight-team-pack-'));
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
  return directory;
}

test('verifies every declared artifact against the canonical plan and profile', () => {
  const result = verifyTeamPackDirectory(
    materializePack(),
    testRuntimePlan(),
    testTeamProfile,
    testRuntimePlanningPolicySource,
  );
  assert.equal(result.status, 'verified-human-approval-required');
  assert.equal(result.files_verified, 15);
  assert.match(result.pack_digest_sha256, /^[a-f0-9]{64}$/);
  assert.equal(result.compiler_version, 'starlight.team_pack.compiler.v2');
});

test('rejects a tampered team-pack file', () => {
  const directory = materializePack();
  writeFileSync(join(directory, 'SYSTEM.md'), '# forged\n', 'utf8');
  assert.throws(
    () => verifyTeamPackDirectory(directory, testRuntimePlan(), testTeamProfile, testRuntimePlanningPolicySource),
    /digest mismatch/i,
  );
});

test('rejects a self-consistent pack that differs from deterministic compiler output', () => {
  const directory = materializePack();
  const forgedContent = '# attacker-authored but internally consistent\n';
  writeFileSync(join(directory, 'SYSTEM.md'), forgedContent, 'utf8');

  const manifestPath = join(directory, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const systemEntry = manifest.files.find((file: { path: string }) => file.path === 'SYSTEM.md');
  systemEntry.sha256 = sha256Digest(forgedContent);
  systemEntry.bytes = Buffer.byteLength(forgedContent);
  const { pack_digest_sha256: _oldPackDigest, ...manifestWithoutPackDigest } = manifest;
  const fileDigests = Object.fromEntries(
    manifest.files.map((file: { path: string; sha256: string }) => [file.path, file.sha256]),
  );
  manifest.pack_digest_sha256 = sha256Digest({
    manifest: manifestWithoutPackDigest,
    file_digests: fileDigests,
  });
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  assert.throws(
    () => verifyTeamPackDirectory(directory, testRuntimePlan(), testTeamProfile, testRuntimePlanningPolicySource),
    /deterministic compiler output/i,
  );
});

test('rejects undeclared files in a team pack', () => {
  const directory = materializePack();
  writeFileSync(join(directory, 'UNDECLARED.md'), 'surprise\n', 'utf8');
  assert.throws(
    () => verifyTeamPackDirectory(directory, testRuntimePlan(), testTeamProfile, testRuntimePlanningPolicySource),
    /undeclared/i,
  );
});

test('rejects a self-consistent pack when the supplied canonical plan differs', () => {
  const forgedPlan = structuredClone(testRuntimePlan());
  forgedPlan.generated_at = '2026-08-06T03:01:00.000Z';
  assert.throws(
    () => verifyTeamPackDirectory(materializePack(), forgedPlan, testTeamProfile, testRuntimePlanningPolicySource),
    /canonical plan digest/i,
  );
});

test('rejects a self-consistent pack when the supplied canonical profile differs', () => {
  const forgedProfile = structuredClone(testTeamProfile);
  forgedProfile.ownership.version = '9.9.9';
  assert.throws(
    () => verifyTeamPackDirectory(materializePack(), testRuntimePlan(), forgedProfile, testRuntimePlanningPolicySource),
    /canonical profile digest|profile version/i,
  );
});
