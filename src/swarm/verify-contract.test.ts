import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { checkProblems, policyFromBrief, verifyClaim } from './verify-contract';
import type { CheckRunner, CompletionClaim, VerifyPolicy } from './verify-contract';
import { sampleBrief } from './brief.test';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const NOW = Date.parse('2026-10-19T12:00:00Z');
const FRESH = new Date(NOW - 60_000).toISOString();

function runner(exit: Record<string, number> = {}): CheckRunner & { ran: string[] } {
  const ran: string[] = [];
  return { ran, async run(command) { ran.push(command); return { command, exitCode: exit[command] ?? 0 }; } };
}
const files: Record<string, string> = { 'out/survey.md': 'survey body' };
const digest = async (ref: string) => (ref in files ? sha(files[ref]) : null);
const policy: VerifyPolicy = { allowedChecks: ['npm test', 'npm run typecheck'], maxEvidenceAgeMs: 3_600_000 };

function claim(over: Partial<CompletionClaim> = {}): CompletionClaim {
  return {
    briefId: 'brief-1',
    kind: 'research',
    checksClaimed: ['npm test'],
    evidence: [{ ref: 'out/survey.md', sha256: sha('survey body'), producedAt: FRESH }],
    ...over,
  };
}

test('credit comes only from a re-run: a green claim is re-run and credited', async () => {
  const r = runner();
  const out = await verifyClaim(claim(), policy, r, digest, NOW);
  assert.equal(out.credited, true, out.reasons.join('; '));
  assert.deepEqual(r.ran, ['npm test']);
});

test('a claim with no checks is a claim with no credit', async () => {
  const out = await verifyClaim(claim({ checksClaimed: [] }), policy, runner(), digest, NOW);
  assert.equal(out.credited, false);
  assert.ok(out.reasons.some((x) => /no checks/.test(x)));
});

test('unlisted, glob and shell-metachar checks are refused before anything runs', async () => {
  const r = runner();
  for (const bad of ['npm run build', 'npm run *', 'npm test; echo pwned', 'npm test && true']) {
    const out = await verifyClaim(claim({ checksClaimed: [bad] }), policy, r, digest, NOW);
    assert.equal(out.credited, false, bad);
  }
  assert.deepEqual(r.ran, [], 'nothing outside the allowlist is ever executed');
  assert.ok(checkProblems('npm tes', policy).some((p) => /exact match/.test(p)));
  assert.deepEqual(checkProblems('npm test', policy), []);
});

test('a failing re-run withholds credit even though the maker claimed green', async () => {
  const out = await verifyClaim(claim(), policy, runner({ 'npm test': 1 }), digest, NOW);
  assert.equal(out.credited, false);
  assert.ok(out.reasons.some((x) => /failed on re-run/.test(x)));
  assert.equal(out.reruns[0].exitCode, 1);
});

test('evidence must digest the same, be readable, be fresh, and not come from the future', async () => {
  const changed = claim({ evidence: [{ ref: 'out/survey.md', sha256: sha('other'), producedAt: FRESH }] });
  assert.ok((await verifyClaim(changed, policy, runner(), digest, NOW)).reasons.some((x) => /digest changed/.test(x)));
  const missing = claim({ evidence: [{ ref: 'out/gone.md', sha256: sha('x'), producedAt: FRESH }] });
  assert.ok((await verifyClaim(missing, policy, runner(), digest, NOW)).reasons.some((x) => /cannot be read/.test(x)));
  const stale = claim({ evidence: [{ ref: 'out/survey.md', sha256: sha('survey body'), producedAt: new Date(NOW - 2 * 3_600_000).toISOString() }] });
  assert.ok((await verifyClaim(stale, policy, runner(), digest, NOW)).reasons.some((x) => /stale/.test(x)));
  const future = claim({ evidence: [{ ref: 'out/survey.md', sha256: sha('survey body'), producedAt: new Date(NOW + 3_600_000).toISOString() }] });
  assert.ok((await verifyClaim(future, policy, runner(), digest, NOW)).reasons.some((x) => /future/.test(x)));
  const none = claim({ evidence: [] });
  assert.ok((await verifyClaim(none, policy, runner(), digest, NOW)).reasons.some((x) => /no evidence/.test(x)));
});

test('a code claim must name its commit', async () => {
  const noCommit = await verifyClaim(claim({ kind: 'code' }), policy, runner(), digest, NOW);
  assert.ok(noCommit.reasons.some((x) => /commit/.test(x)));
  const withCommit = await verifyClaim(claim({ kind: 'code', commit: 'f7aa7f8' }), policy, runner(), digest, NOW);
  assert.equal(withCommit.credited, true, withCommit.reasons.join('; '));
});

test('a runner that throws reads as refused, never as credited', async () => {
  const boom: CheckRunner = { async run() { throw new Error('spawn failed'); } };
  const out = await verifyClaim(claim(), policy, boom, digest, NOW);
  assert.equal(out.credited, false);
  assert.ok(out.reasons.some((x) => /could not be re-run/.test(x)));
});

test('policyFromBrief copies the brief allowlist exactly', () => {
  const p = policyFromBrief(sampleBrief(), 1000);
  assert.deepEqual(p.allowedChecks, ['npm test', 'npm run typecheck']);
  assert.equal(p.maxEvidenceAgeMs, 1000);
});
