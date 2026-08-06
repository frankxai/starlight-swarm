import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runPilotCli } from './pilot-cli';

test('validate command accepts the checked-in bounded Hand contract', () => {
  const output: string[] = [];
  const code = runPilotCli(
    ['validate', 'hands/examples/collector-openfang-pilot.hand.json'],
    {
      cwd: process.cwd(),
      out: (message) => output.push(message),
      err: (message) => output.push(`ERR:${message}`),
    },
  );

  assert.equal(code, 0);
  assert.match(output.join('\n'), /collector-openfang-pilot.*valid/i);
});

test('unknown commands fail closed with usage guidance', () => {
  const errors: string[] = [];
  const code = runPilotCli(['launch'], {
    cwd: process.cwd(),
    out: () => {},
    err: (message) => errors.push(message),
  });

  assert.equal(code, 2);
  assert.match(errors.join('\n'), /validate|score/i);
});

test('compile-openfang emits a reactive Hand without autonomous iterations', () => {
  const output: string[] = [];
  const code = runPilotCli(
    ['compile-openfang', 'hands/examples/collector-openfang-pilot.hand.json'],
    {
      cwd: process.cwd(),
      out: (message) => output.push(message),
      err: () => {},
    },
  );

  assert.equal(code, 0);
  assert.match(output.join('\n'), /id = "collector-openfang-pilot"/);
  assert.doesNotMatch(output.join('\n'), /max_iterations/);
});

test('admit-openfang returns a distinct blocked exit code for a disabled Hand', () => {
  const output: string[] = [];
  const code = runPilotCli(
    [
      'admit-openfang',
      'hands/examples/collector-openfang-pilot.hand.json',
      'hands/examples/openfang-single-run.admission.example.json',
    ],
    {
      cwd: process.cwd(),
      out: (message) => output.push(message),
      err: () => {},
    },
  );

  assert.equal(code, 3);
  assert.match(output.join('\n'), /"admitted": false/);
  assert.match(output.join('\n'), /enabled=false/i);
});

test('dry-a0 emits a deterministic blocked lifecycle receipt without launching OpenFang', () => {
  const output: string[] = [];
  const code = runPilotCli(
    [
      'dry-a0',
      'hands/examples/collector-openfang-pilot.hand.json',
      'hands/examples/openfang-single-run.admission.example.json',
      '2026-07-18T08:00:00.000Z',
    ],
    { cwd: process.cwd(), out: (message) => output.push(message), err: () => {} },
  );

  assert.equal(code, 0);
  const receipt = JSON.parse(output.join('\n'));
  assert.equal(receipt.execution_status, 'blocked');
  assert.equal(receipt.runtime_spawned, false);
  assert.equal(receipt.receipt.process.cleanup_status, 'not-started');
});

test('compile-hermes and compare expose the paired baseline through the CLI', () => {
  const compiled: string[] = [];
  const compileCode = runPilotCli(
    ['compile-hermes', 'hands/examples/collector-hermes-pilot.hand.json'],
    { cwd: process.cwd(), out: (message) => compiled.push(message), err: () => {} },
  );
  const comparison: string[] = [];
  const compareCode = runPilotCli(
    [
      'compare',
      'hands/examples/collector-hermes-pilot.hand.json',
      'hands/examples/collector-openfang-pilot.hand.json',
    ],
    { cwd: process.cwd(), out: (message) => comparison.push(message), err: () => {} },
  );

  assert.equal(compileCode, 0);
  assert.match(compiled.join('\n'), /starlight\.hermes-hand-job\.v1/);
  assert.equal(compareCode, 0);
  assert.match(comparison.join('\n'), /comparable/i);
});
