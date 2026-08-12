import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { prepareRuntimeBundle } from '../src/swarm/runtime-adapters';
import { resolveGeneratedOutput } from '../src/swarm/runtime-output';
import { assertGitJsonSourceProvenance } from '../src/swarm/runtime-provenance';
import { parseRuntimePlanningPolicy } from '../src/swarm/runtime-policy';
import { verifyTeamPackDirectory } from '../src/swarm/team-pack-verifier';

function usage(): never {
  throw new Error(
    'Usage: tsx scripts/prepare-runtime-bundle.ts <pack-dir> <plan.json> <team-profile.json> <runtime-policy.json> --output runtime/generated/<bundle.json> [--force]',
  );
}

const args = process.argv.slice(2);
const [packPath, planPath, profilePath, policyPath] = args;
if (!packPath || !planPath || !profilePath || !policyPath) usage();

let outputPath: string | undefined;
let force = false;
for (let index = 4; index < args.length; index += 1) {
  if (args[index] === '--output') {
    outputPath = args[index + 1] ?? usage();
    index += 1;
  } else if (args[index] === '--force') {
    force = true;
  } else {
    throw new Error(`Unknown option: ${args[index]}`);
  }
}
if (!outputPath) usage();

const readJson = (path: string): unknown => JSON.parse(readFileSync(resolve(path), 'utf8'));
const plan = readJson(planPath);
const profile = readJson(profilePath);
const policy = readJson(policyPath);
const parsedPolicy = parseRuntimePlanningPolicy(policy);
assertGitJsonSourceProvenance(
  resolve(profilePath),
  parsedPolicy.source.team_profile_source,
);
const verification = verifyTeamPackDirectory(resolve(packPath), plan, profile, policy);
const bundle = prepareRuntimeBundle(plan, verification);
const written = resolveGeneratedOutput(process.cwd(), outputPath, force);
mkdirSync(dirname(written), { recursive: true });
writeFileSync(written, `${JSON.stringify(bundle, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify({ status: bundle.status, output: written, lanes: bundle.lanes.length })}\n`);
