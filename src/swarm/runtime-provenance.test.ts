import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assertGitJsonSourceProvenance } from './runtime-provenance';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

test('source provenance binds semantic JSON to the declared Git repo, path, and commit', () => {
  const root = mkdtempSync(join(tmpdir(), 'starlight-runtime-provenance-'));
  try {
    git(root, 'init');
    git(root, 'config', 'user.email', 'runtime-test@example.invalid');
    git(root, 'config', 'user.name', 'Runtime Test');
    git(root, 'remote', 'add', 'origin', 'https://github.com/frankxai/source-fixture.git');

    const relativePath = 'core/teams/team-profile.json';
    const profilePath = join(root, relativePath);
    mkdirSync(join(root, 'core', 'teams'), { recursive: true });
    writeFileSync(profilePath, '{"team":{"id":"fixture"},"version":1}\n', 'utf8');
    git(root, 'add', relativePath);
    git(root, 'commit', '-m', 'fixture profile');
    const commit = git(root, 'rev-parse', 'HEAD');
    git(root, 'update-ref', 'refs/remotes/origin/main', commit);
    const source = {
      repository: 'frankxai/source-fixture',
      commit_sha: commit,
      path: relativePath,
    };

    assert.doesNotThrow(() => assertGitJsonSourceProvenance(profilePath, source));

    writeFileSync(
      profilePath,
      '{\n  "team": { "id": "fixture" },\n  "version": 1\n}\n',
      'utf8',
    );
    assert.doesNotThrow(() => assertGitJsonSourceProvenance(profilePath, source));

    writeFileSync(profilePath, '{"team":{"id":"drifted"},"version":1}\n', 'utf8');
    assert.throws(
      () => assertGitJsonSourceProvenance(profilePath, source),
      /does not match.*declared commit/i,
    );

    assert.throws(
      () =>
        assertGitJsonSourceProvenance(profilePath, {
          ...source,
          repository: 'frankxai/different-source',
        }),
      /origin.*does not match/i,
    );

    assert.throws(
      () =>
        assertGitJsonSourceProvenance(profilePath, {
          ...source,
          path: 'core/teams/different-profile.json',
        }),
      /path.*does not match/i,
    );

    writeFileSync(profilePath, '{"team":{"id":"unpublished"},"version":1}\n', 'utf8');
    git(root, 'add', relativePath);
    git(root, 'commit', '-m', 'unpublished profile');
    const unpublishedCommit = git(root, 'rev-parse', 'HEAD');
    assert.throws(
      () =>
        assertGitJsonSourceProvenance(profilePath, {
          ...source,
          commit_sha: unpublishedCommit,
        }),
      /not reachable from any fetched origin ref/i,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
