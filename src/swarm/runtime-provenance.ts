import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';

import { sha256Digest } from './runtime-digest';
import {
  teamProfileSourceSchema,
  type TeamProfileSource,
} from './runtime-planner';

function git(repositoryRoot: string, args: string[]): string {
  try {
    return execFileSync('git', ['-C', repositoryRoot, ...args], {
      encoding: 'utf8',
      maxBuffer: 5 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    throw new Error(`Unable to verify source profile provenance with git ${args[0]}.`);
  }
}

function normalizeRepository(remote: string): string | null {
  const value = remote.trim().replace(/\\/g, '/').replace(/\.git$/i, '');
  const ssh = value.match(/^git@github\.com:([^/]+\/[^/]+)$/i);
  if (ssh) return ssh[1].toLowerCase();

  try {
    const url = new URL(value);
    if (url.hostname.toLowerCase() !== 'github.com') return null;
    const path = url.pathname.replace(/^\/+|\/+$/g, '');
    return /^[^/]+\/[^/]+$/.test(path) ? path.toLowerCase() : null;
  } catch {
    return null;
  }
}

function parseJson(label: string, value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
}

function assertCommitReachableFromOrigin(repositoryRoot: string, commitSha: string): void {
  const objectType = git(repositoryRoot, ['cat-file', '-t', commitSha]);
  if (objectType !== 'commit') {
    throw new Error(`Declared source profile object ${commitSha} is not a Git commit.`);
  }

  const containingRefs = git(repositoryRoot, [
    'for-each-ref',
    '--format=%(refname)',
    '--contains',
    commitSha,
    'refs/remotes/origin/',
  ])
    .split(/\r?\n/)
    .filter((ref) => ref.startsWith('refs/remotes/origin/'));
  if (containingRefs.length === 0) {
    throw new Error(
      `Declared source profile commit ${commitSha} is not reachable from any fetched origin ref. Fetch the declared origin before retrying.`,
    );
  }
}

export function assertGitJsonSourceProvenance(
  profilePath: string,
  sourceInput: TeamProfileSource,
): void {
  const source = teamProfileSourceSchema.parse(sourceInput);
  const resolvedProfile = resolve(profilePath);
  const repositoryRoot = git(dirname(resolvedProfile), ['rev-parse', '--show-toplevel']);
  const actualRemote = normalizeRepository(git(repositoryRoot, ['remote', 'get-url', 'origin']));
  if (actualRemote !== source.repository.toLowerCase()) {
    throw new Error(
      `Source profile origin does not match declared repository ${source.repository}.`,
    );
  }

  const actualPath = relative(repositoryRoot, resolvedProfile).split(sep).join('/');
  if (actualPath !== source.path) {
    throw new Error(
      `Source profile path ${actualPath} does not match declared path ${source.path}.`,
    );
  }

  assertCommitReachableFromOrigin(repositoryRoot, source.commit_sha);

  const workingJson = parseJson(
    'Working source profile',
    readFileSync(resolvedProfile, 'utf8'),
  );
  const committedJson = parseJson(
    'Declared source profile',
    git(repositoryRoot, ['show', `${source.commit_sha}:${source.path}`]),
  );
  if (sha256Digest(workingJson) !== sha256Digest(committedJson)) {
    throw new Error(
      `Working source profile does not match the declared commit ${source.commit_sha}.`,
    );
  }
}
