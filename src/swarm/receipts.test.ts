import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { draftDispatchReceipt, issueDispatchReceipt, ledgerLine, routeStage, sha256Of, verifyLedger } from './receipts';
import type { DispatchRecord } from './receipts';
import { receiptProblems, verifyRunReceipt } from './run-receipt';
import { ModelRouter } from './router';
import { sampleBrief } from './brief.test';

function keys() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    priv: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    pub: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

function record(over: Partial<DispatchRecord> = {}): DispatchRecord {
  const body = '# survey\n';
  return {
    brief: sampleBrief(),
    route: new ModelRouter().route({ general: 'starlight-hermes' }),
    host: 'test-host',
    startedAt: '2026-10-19T12:00:00.000Z',
    endedAt: '2026-10-19T12:05:00.000Z',
    subject: { name: 'out/survey.md', sha256: sha256Of(body) },
    stages: [{ name: 'work', status: 'ok', model: 'gemini-2.5-flash', provider: 'google', costEur: 0.0120, latencyMs: 4200, inputTokens: 1000, outputTokens: 400 }],
    evidence: [{ kind: 'source', ref: 'out/survey.md', sha256: sha256Of(body) }],
    issuer: 'starlight-queen',
    ...over,
  };
}

test('a dispatch receipt drafts into the estate format with the route stage first', () => {
  const r = draftDispatchReceipt(record());
  assert.deepEqual(receiptProblems(r), []);
  assert.equal(r.schema, 'starlight.run-receipt.v1');
  assert.equal(r.run.kind, 'queen.dispatch');
  assert.equal(r.stages[0].name, 'route');
  assert.equal(r.stages[0].model, 'gemini-2.5-flash');
  assert.equal(r.verdict, 'PASS');
  assert.equal(r.totals.costEur, 0.012);
  assert.match(r.receiptId, /^rcpt_[0-9a-f]{24}$/);
});

test('the receipt carries the router answer, fallback included', () => {
  const fb = new ModelRouter({ availability: (m) => m !== 'gemini-2.5-flash' }).route({ general: 'starlight-hermes' });
  const stage = routeStage(fb);
  assert.equal(stage.model, 'deepseek-v3.2');
  assert.match(stage.note ?? '', /\[fallback\]/);
});

test('a refused route can never produce a PASS receipt', () => {
  const refused = new ModelRouter({ availability: () => false }).route({ general: 'starlight-sentinel' });
  const r = draftDispatchReceipt(record({ route: refused }));
  assert.notEqual(r.verdict, 'PASS');
  assert.equal(r.stages[0].status, 'failed');
});

test('issue signs with Ed25519 and the ledger line verifies against the public key only', () => {
  const { priv, pub } = keys();
  const other = keys();
  const { envelope, receipt } = issueDispatchReceipt(record(), priv);
  assert.equal(receipt.issuer.keyid, undefined, 'draft keeps no keyid; the envelope payload carries it');
  const ok = verifyRunReceipt(envelope, [pub]);
  assert.equal(ok.ok, true, ok.reasons.join('; '));
  assert.equal(ok.receipt?.run.id, 'brief-1');
  const wrongKey = verifyRunReceipt(envelope, [other.pub]);
  assert.equal(wrongKey.ok, false);
  const line = ledgerLine(envelope);
  assert.ok(line.endsWith('\n') && !line.slice(0, -1).includes('\n'));
  const entries = verifyLedger(line + 'not json\n' + line, [pub]);
  assert.deepEqual(entries.map((e) => e.ok), [true, false, true]);
  assert.deepEqual(entries[1].reasons, ['line is not JSON']);
});

test('PASS without evidence is refused at issue time', () => {
  const { priv } = keys();
  assert.throws(() => issueDispatchReceipt(record({ evidence: [] }), priv), /refusing to issue/);
});
