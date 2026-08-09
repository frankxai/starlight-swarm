import { readFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';

import { verifyTeamPackDirectory } from '../src/swarm/team-pack-verifier';

const requestedPath = process.argv[2];
const planPath = process.argv[3];
const profilePath = process.argv[4];
const runtimePolicyPath = process.argv[5];
if (
  !requestedPath ||
  !planPath ||
  !profilePath ||
  !runtimePolicyPath ||
  process.argv.length !== 6
) {
  throw new Error(
    'Usage: tsx scripts/verify-team-pack.ts <runtime/generated/packs/<pack-id>> <plan.json> <team-profile.json> <runtime-policy.json>',
  );
}

const repositoryRoot = process.cwd();
const packDirectory = resolve(repositoryRoot, requestedPath);
const relativePath = relative(repositoryRoot, packDirectory);
if (
  relativePath === '' ||
  relativePath === '..' ||
  relativePath.startsWith(`..${sep}`) ||
  !relativePath.split(sep).join('/').startsWith('runtime/generated/packs/')
) {
  throw new Error('Team-pack verification is confined to runtime/generated/packs/<pack-id>.');
}

const readJson = (path: string): unknown =>
  JSON.parse(readFileSync(resolve(repositoryRoot, path), 'utf8'));
const plan = readJson(planPath);
const profile = readJson(profilePath);
const runtimePolicy = readJson(runtimePolicyPath);

process.stdout.write(
  `${JSON.stringify({
    ...verifyTeamPackDirectory(packDirectory, plan, profile, runtimePolicy),
    directory: relativePath.split(sep).join('/'),
  })}\n`,
);
