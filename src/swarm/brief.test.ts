import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BRIEF_SCHEMA, briefProblems, toQueenSessionMission, validateBrief, verifierIsIndependent, withBriefDefaults } from './brief';
import type { Brief } from './brief';

export function sampleBrief(over: Partial<Brief> = {}): Brief {
  return withBriefDefaults({
    id: 'brief-1',
    objective: 'Survey the three model routers in the estate and name the one to keep.',
    acceptance: ['The survey names each router by file path.', 'The recommendation cites one measured number.'],
    output: { format: 'markdown', maxBytes: 20_000 },
    tools: ['Read', 'Grep'],
    boundaries: ['No edits outside docs/.', 'No network.'],
    budget: { microUsd: 2_000_000, wallTimeMs: 600_000 },
    maker: { id: 'general:starlight-hermes', model: 'gemini-2.5-flash' },
    verifier: { id: 'checker:starlight-sentinel', model: 'claude-opus-4-6' },
    allowedChecks: ['npm test', 'npm run typecheck'],
    general: 'starlight-hermes',
    ...over,
  });
}

test('a complete brief has no problems and carries the schema and defaults', () => {
  const b = sampleBrief();
  assert.deepEqual(briefProblems(b), []);
  assert.equal(b.schema, BRIEF_SCHEMA);
  assert.equal(b.governance, 'hierarchical');
  assert.equal(b.budget.split?.collective, 30);
  assert.equal(validateBrief(b).ok, true);
});

test('every missing field is named; nothing is silently defaulted into validity', () => {
  const problems = briefProblems({ schema: BRIEF_SCHEMA });
  for (const needle of ['id', 'objective', 'acceptance', 'tools', 'boundaries', 'output', 'budget', 'maker', 'verifier', 'allowedChecks']) {
    assert.ok(problems.some((p) => p.includes(needle)), `expected a problem naming ${needle}: ${problems.join(' | ')}`);
  }
  assert.ok(briefProblems(null).length === 1);
  assert.ok(briefProblems({ ...sampleBrief(), schema: 'other' }).some((p) => /schema/.test(p)));
});

test('verifier independence: same id or same model is refused', () => {
  assert.ok(verifierIsIndependent({ id: 'a', model: 'm1' }, { id: 'b', model: 'm2' }));
  assert.ok(verifierIsIndependent({ id: 'a', model: 'm1' }, { id: 'human:frank' }));
  assert.ok(!verifierIsIndependent({ id: 'a' }, { id: 'a' }));
  assert.ok(!verifierIsIndependent({ id: 'a', model: 'm1' }, { id: 'b', model: 'm1' }));
  const sameModel = sampleBrief({ verifier: { id: 'checker', model: 'gemini-2.5-flash' } });
  assert.ok(briefProblems(sameModel).some((p) => /not independent/.test(p)));
  const sameId = sampleBrief({ verifier: { id: 'general:starlight-hermes', model: 'claude-opus-4-6' } });
  assert.ok(briefProblems(sameId).some((p) => /not independent/.test(p)));
});

test('budget is integer micro-USD and wall time; zero and fractions are refused', () => {
  assert.ok(briefProblems(sampleBrief({ budget: { microUsd: 0, wallTimeMs: 1 } })).some((p) => /microUsd/.test(p)));
  assert.ok(briefProblems(sampleBrief({ budget: { microUsd: 1.5, wallTimeMs: 1 } })).some((p) => /microUsd/.test(p)));
  assert.ok(briefProblems(sampleBrief({ budget: { microUsd: 1, wallTimeMs: 0 } })).some((p) => /wallTimeMs/.test(p)));
  assert.ok(briefProblems(sampleBrief({ budget: { microUsd: 1, wallTimeMs: 1, split: { collective: 1, workers: 1, scouts: 1, memory: 1 } } })).some((p) => /sum to 100/.test(p)));
});

test('allowedChecks are exact commands: globs and shell metacharacters are refused', () => {
  assert.ok(briefProblems(sampleBrief({ allowedChecks: ['npm run *'] })).some((p) => /pattern/.test(p)));
  assert.ok(briefProblems(sampleBrief({ allowedChecks: ['npm test; rm -rf /'] })).some((p) => /metacharacters/.test(p)));
  assert.deepEqual(briefProblems(sampleBrief({ allowedChecks: [] })), []);
});

test('json output needs a schema; unknown general or governance is refused', () => {
  assert.ok(briefProblems(sampleBrief({ output: { format: 'json', maxBytes: 10 } })).some((p) => /output.schema/.test(p)));
  assert.deepEqual(briefProblems(sampleBrief({ output: { format: 'json', maxBytes: 10, schema: 'x.schema.json' } })), []);
  assert.ok(briefProblems({ ...sampleBrief(), general: 'queen-coordinator' }).some((p) => /Domain General/.test(p)));
  assert.ok(briefProblems({ ...sampleBrief(), governance: 'coup' }).some((p) => /governance/.test(p)));
});

test('toQueenSessionMission converts units and refuses an incomplete brief', () => {
  const m = toQueenSessionMission(sampleBrief({ maxPromptBytes: 4096 }));
  assert.equal(m.maxCostUsd, 2);
  assert.equal(m.timeoutMs, 600_000);
  assert.equal(m.maxOutputBytes, 20_000);
  assert.deepEqual(m.capabilities, ['Read', 'Grep']);
  assert.equal(m.maxPromptBytes, 4096);
  assert.throws(() => toQueenSessionMission({ ...sampleBrief(), objective: '' }), /incomplete/);
});
