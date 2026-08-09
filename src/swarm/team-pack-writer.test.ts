import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { CompiledTeamPack } from './team-pack';
import { writeTeamPackAtomically } from './team-pack-writer';

function pack(): CompiledTeamPack {
  return {
    manifest: {
      schema_version: 'starlight.team_pack.v1',
      compiler_version: 'starlight.team_pack.compiler.v2',
      team_id: 'test-team',
      team_profile_version: '1.0.0',
      generated_at: '2026-08-06T03:00:00.000Z',
      source_profile_digest_sha256: 'a'.repeat(64),
      source_profile_repository: 'frankxai/starlight-agent-config',
      source_profile_commit_sha: '12b8733f1af061578d979e93e7bb6c1763f8f9e3',
      source_profile_path: 'core/teams/test-team.team-profile.json',
      runtime_policy_id: 'test-runtime-policy-v1',
      source_runtime_policy_digest_sha256: '4'.repeat(64),
      plan_digest_sha256: '2'.repeat(64),
      activation_status: 'planned-human-approval-required',
      files: [{ path: 'roles/maker.md', sha256: '3'.repeat(64), bytes: 6 }],
    },
    files: { 'roles/maker.md': 'maker\n' },
    file_digests: { 'roles/maker.md': '3'.repeat(64) },
  };
}

test('writes a new team pack through a private directory and publishes it once', () => {
  const repo = mkdtempSync(join(tmpdir(), 'starlight-pack-writer-'));
  const result = writeTeamPackAtomically(
    repo,
    'runtime/generated/packs/test-pack',
    pack(),
  );

  assert.equal(result.output_directory, 'runtime/generated/packs/test-pack');
  assert.equal(readFileSync(join(repo, result.output_directory, 'roles/maker.md'), 'utf8'), 'maker\n');
  assert.match(result.pack_digest_sha256, /^[a-f0-9]{64}$/);
});

test('never replaces an existing pack or follows a nested symlink', () => {
  const repo = mkdtempSync(join(tmpdir(), 'starlight-pack-writer-symlink-'));
  const outsideDirectory = join(repo, 'outside');
  const target = join(outsideDirectory, 'maker.md');
  const packDirectory = join(repo, 'runtime', 'generated', 'packs', 'test-pack');
  mkdirSync(outsideDirectory, { recursive: true });
  mkdirSync(packDirectory, { recursive: true });
  writeFileSync(target, 'preserve\n', 'utf8');
  symlinkSync(outsideDirectory, join(packDirectory, 'roles'), 'junction');

  assert.throws(
    () => writeTeamPackAtomically(repo, 'runtime/generated/packs/test-pack', pack()),
    /immutable|already exists/i,
  );
  assert.equal(readFileSync(target, 'utf8'), 'preserve\n');
});
