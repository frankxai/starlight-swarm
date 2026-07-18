import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseHandContract } from './hand-contract';
import { assessHandAdmission, compileOpenFangHand } from './hand-adapter';
import { assertComparableHands, compileHermesHand } from './hermes-hand-adapter';
import { evaluatePilot } from './pilot-scorecard';
import { createA0DryExperiment } from './pilot-admission';

interface PilotCliIo {
  cwd: string;
  out: (message: string) => void;
  err: (message: string) => void;
}

const USAGE = [
  'Usage:',
  '  npm run hand:pilot -- validate <hand-contract.json>',
  '  npm run hand:pilot -- compile-openfang <hand-contract.json>',
  '  npm run hand:pilot -- compile-hermes <hand-contract.json>',
  '  npm run hand:pilot -- compare <hermes-contract.json> <openfang-contract.json>',
  '  npm run hand:pilot -- admit-openfang <hand-contract.json> <environment.json>',
  '  npm run hand:pilot -- dry-a0 <hand-contract.json> <environment.json> <now.iso>',
  '  npm run hand:pilot -- score <hermes-receipts.json> <openfang-receipts.json>',
].join('\n');

function readJson(path: string, cwd: string): unknown {
  return JSON.parse(readFileSync(resolve(cwd, path), 'utf8'));
}

export function runPilotCli(args: string[], io: PilotCliIo): number {
  try {
    const [command, ...rest] = args;
    if (command === 'validate' && rest.length === 1) {
      const hand = parseHandContract(readJson(rest[0], io.cwd));
      io.out(`${hand.id} is valid (${hand.runtime}, enabled=${hand.enabled})`);
      return 0;
    }

    if (command === 'compile-openfang' && rest.length === 1) {
      const compiled = compileOpenFangHand(readJson(rest[0], io.cwd));
      io.out(compiled.toml);
      return 0;
    }

    if (command === 'compile-hermes' && rest.length === 1) {
      io.out(JSON.stringify(compileHermesHand(readJson(rest[0], io.cwd)), null, 2));
      return 0;
    }

    if (command === 'compare' && rest.length === 2) {
      assertComparableHands(readJson(rest[0], io.cwd), readJson(rest[1], io.cwd));
      io.out('Hermes and OpenFang Hand contracts are comparable.');
      return 0;
    }

    if (command === 'admit-openfang' && rest.length === 2) {
      const handInput = readJson(rest[0], io.cwd);
      const compiled = compileOpenFangHand(handInput);
      const decision = assessHandAdmission(handInput, compiled, readJson(rest[1], io.cwd));
      io.out(JSON.stringify(decision, null, 2));
      return decision.admitted ? 0 : 3;
    }

    if (command === 'dry-a0' && rest.length === 3) {
      const experiment = createA0DryExperiment(
        readJson(rest[0], io.cwd),
        readJson(rest[1], io.cwd),
        rest[2],
      );
      io.out(JSON.stringify(experiment, null, 2));
      return 0;
    }

    if (command === 'score' && rest.length === 2) {
      const hermesReceipts = readJson(rest[0], io.cwd);
      const openfangReceipts = readJson(rest[1], io.cwd);
      if (!Array.isArray(hermesReceipts) || !Array.isArray(openfangReceipts)) {
        throw new Error('score inputs must each be a JSON array of run receipts');
      }
      const evaluation = evaluatePilot(hermesReceipts, openfangReceipts);
      io.out(JSON.stringify(evaluation, null, 2));
      return evaluation.decision === 'stop-openfang' ? 3 : 0;
    }

    io.err(USAGE);
    return 2;
  } catch (error) {
    io.err((error as Error).message);
    return 1;
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
  process.exitCode = runPilotCli(process.argv.slice(2), {
    cwd: process.cwd(),
    out: (message) => console.log(message),
    err: (message) => console.error(message),
  });
}
