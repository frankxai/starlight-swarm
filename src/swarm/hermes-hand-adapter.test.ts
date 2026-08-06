import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { assertComparableHands, compileHermesHand } from './hermes-hand-adapter';

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
}

test('compiles a disabled local Hermes job with only the web toolset', () => {
  const compiled = compileHermesHand(
    readJson('../../hands/examples/collector-hermes-pilot.hand.json'),
  );

  assert.equal(compiled.enabled, false);
  assert.equal(compiled.schedule, 'every 1440m');
  assert.equal(compiled.repeat, 14);
  assert.deepEqual(compiled.enabled_toolsets, ['web']);
  assert.equal(compiled.deliver, 'local');
  assert.equal(compiled.attach_to_session, false);
  assert.match(compiled.prompt, /SIS remains the only canonical/i);
  assert.match(compiled.prompt, /final response/i);
});

test('Hermes and OpenFang pilot contracts are comparable', () => {
  const hermes = readJson('../../hands/examples/collector-hermes-pilot.hand.json');
  const openfang = readJson('../../hands/examples/collector-openfang-pilot.hand.json');

  assert.doesNotThrow(() => assertComparableHands(hermes, openfang));
});

test('comparison rejects mission or budget drift between runtimes', () => {
  const hermes = readJson('../../hands/examples/collector-hermes-pilot.hand.json') as any;
  const openfang = readJson('../../hands/examples/collector-openfang-pilot.hand.json');
  hermes.execution.max_tool_calls = 99;

  assert.throws(() => assertComparableHands(hermes, openfang), /max_tool_calls/i);
});

test('checked-in Hermes job exactly matches compiler output', () => {
  const contract = readJson('../../hands/examples/collector-hermes-pilot.hand.json');
  const expected = readJson('../../hands/hermes/collector-hermes-pilot/job.json');

  assert.deepEqual(expected, compileHermesHand(contract));
});
