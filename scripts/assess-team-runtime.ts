import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { assessTeamRuntimeAdmission } from '../src/swarm/runtime-admission';
import { resolveGeneratedOutput } from '../src/swarm/runtime-output';

function usage(): never {
  throw new Error(
    'Usage: npm run runtime:assess -- <plan.json> <evidence.json> [--output runtime/generated/<assessment.json>] [--force] [--now <ISO>]',
  );
}

function main(): void {
  const argv = process.argv.slice(2);
  const positionals: string[] = [];
  let outputPath: string | undefined;
  let now = new Date().toISOString();
  let force = false;

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--output') {
      outputPath = argv[index + 1] ?? usage();
      index += 1;
    } else if (value === '--now') {
      now = argv[index + 1] ?? usage();
      index += 1;
    } else if (value === '--force') {
      force = true;
    } else if (value.startsWith('--')) {
      throw new Error(`Unknown option: ${value}`);
    } else {
      positionals.push(value);
    }
  }

  if (positionals.length !== 2 || !Number.isFinite(Date.parse(now))) {
    usage();
  }

  const plan: unknown = JSON.parse(readFileSync(resolve(positionals[0]), 'utf8'));
  const evidence: unknown = JSON.parse(readFileSync(resolve(positionals[1]), 'utf8'));
  const assessment = assessTeamRuntimeAdmission(plan, evidence, now);
  const output = `${JSON.stringify(assessment, null, 2)}\n`;

  if (outputPath) {
    const safeOutputPath = resolveGeneratedOutput(process.cwd(), outputPath, force);
    mkdirSync(dirname(safeOutputPath), { recursive: true });
    writeFileSync(safeOutputPath, output, 'utf8');
    process.stdout.write(`${safeOutputPath}\n`);
    return;
  }

  process.stdout.write(output);
}

main();
