import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { parseWorkloadRequirements } from '../src/swarm/runtime-input';
import { resolveGeneratedOutput } from '../src/swarm/runtime-output';
import { planTeamRuntime } from '../src/swarm/runtime-planner';
import { parseRuntimePlanningPolicy } from '../src/swarm/runtime-policy';

interface Arguments {
  teamPath: string;
  workloadsPath: string;
  policyPath: string;
  outputPath?: string;
  generatedAt: string;
  force: boolean;
}

function usage(): never {
  throw new Error(
    'Usage: npm run runtime:plan -- <team-profile.json> <workloads.json> <runtime-policy.json> [--output runtime/generated/<plan.json>] [--force] [--generated-at <ISO>]',
  );
}

function parseArguments(argv: string[]): Arguments {
  const positionals: string[] = [];
  let outputPath: string | undefined;
  let generatedAt = new Date().toISOString();
  let force = false;

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--output') {
      outputPath = argv[index + 1] ?? usage();
      index += 1;
    } else if (value === '--generated-at') {
      generatedAt = argv[index + 1] ?? usage();
      index += 1;
    } else if (value === '--force') {
      force = true;
    } else if (value.startsWith('--')) {
      throw new Error(`Unknown option: ${value}`);
    } else {
      positionals.push(value);
    }
  }

  if (positionals.length !== 3) return usage();
  if (!Number.isFinite(Date.parse(generatedAt))) {
    throw new Error('--generated-at must be a valid ISO timestamp.');
  }

  return {
    teamPath: resolve(positionals[0]),
    workloadsPath: resolve(positionals[1]),
    policyPath: resolve(positionals[2]),
    outputPath,
    generatedAt,
    force,
  };
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function main(): void {
  const args = parseArguments(process.argv.slice(2));
  const team = readJson(args.teamPath);
  const workloads = parseWorkloadRequirements(readJson(args.workloadsPath));
  const policy = parseRuntimePlanningPolicy(readJson(args.policyPath));
  const plan = planTeamRuntime(team, workloads, args.generatedAt, {
    max_daily_cost_usd: policy.source.max_daily_cost_usd,
    policy_id: policy.source.budget_policy_id,
    routing_policy: policy.routing_policy,
    source_profile: policy.source.team_profile_source,
  });
  const output = `${JSON.stringify(plan, null, 2)}\n`;

  if (args.outputPath) {
    const safeOutputPath = resolveGeneratedOutput(process.cwd(), args.outputPath, args.force);
    mkdirSync(dirname(safeOutputPath), { recursive: true });
    writeFileSync(safeOutputPath, output, 'utf8');
    process.stdout.write(`${safeOutputPath}\n`);
    return;
  }

  process.stdout.write(output);
}

main();
