import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { sha256Digest } from '../src/swarm/runtime-digest';
import { assertGitJsonSourceProvenance } from '../src/swarm/runtime-provenance';
import { parseRuntimePlanningPolicy } from '../src/swarm/runtime-policy';
import { compileTeamPack } from '../src/swarm/team-pack';
import { writeTeamPackAtomically } from '../src/swarm/team-pack-writer';

function usage(): never {
  throw new Error(
    'Usage: tsx scripts/compile-team-pack.ts <team-profile.json> <runtime-plan.json> <runtime-policy.json> [--output runtime/generated/packs/<id>]',
  );
}

const args = process.argv.slice(2);
const teamProfilePath = args[0];
const planPath = args[1];
const runtimePolicyPath = args[2];
if (!teamProfilePath || !planPath || !runtimePolicyPath) usage();

let requestedOutput: string | undefined;
for (let index = 3; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === '--output') {
    requestedOutput = args[index + 1] ?? usage();
    index += 1;
    continue;
  }
  throw new Error(`Unknown argument: ${arg}`);
}

const teamInput: unknown = JSON.parse(readFileSync(resolve(teamProfilePath), 'utf8'));
const planInput: unknown = JSON.parse(readFileSync(resolve(planPath), 'utf8'));
const runtimePolicyInput: unknown = JSON.parse(readFileSync(resolve(runtimePolicyPath), 'utf8'));
const runtimePolicy = parseRuntimePlanningPolicy(runtimePolicyInput);
assertGitJsonSourceProvenance(
  resolve(teamProfilePath),
  runtimePolicy.source.team_profile_source,
);
const pack = compileTeamPack(teamInput, planInput, runtimePolicyInput);
const packDigest = sha256Digest({ manifest: pack.manifest, file_digests: pack.file_digests });
const defaultOutput = `runtime/generated/packs/${pack.manifest.team_id}-${pack.manifest.plan_digest_sha256.slice(0, 12)}-${packDigest.slice(0, 12)}`;
const written = writeTeamPackAtomically(
  process.cwd(),
  requestedOutput ?? defaultOutput,
  pack,
);

process.stdout.write(
  `${JSON.stringify({
    status: 'compiled-human-approval-required',
    ...written,
    team_id: pack.manifest.team_id,
    plan_digest_sha256: pack.manifest.plan_digest_sha256,
  })}\n`,
);
