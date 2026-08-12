import test from 'node:test';
import assert from 'node:assert/strict';

import { canonicalJson } from './runtime-digest';

test('canonical JSON uses deterministic JavaScript code-unit key ordering', () => {
  assert.equal(
    canonicalJson({ ä: 'umlaut', a: 'lowercase', Z: 'uppercase' }),
    '{"Z":"uppercase","a":"lowercase","ä":"umlaut"}',
  );
});
