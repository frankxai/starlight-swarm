/**
 * integrations.test.ts — unit tests for the real Payments-MCP adapter
 * (paymentsMcpFromClient) and its fail-closed posture, plus proof that the
 * Payments Queen drives verify_mandate / check_spend_cap THROUGH the adapter.
 *
 * Run:  node --test --import tsx src/swarm/integrations.test.ts
 *
 * No subprocess is spawned. A MOCK PaymentsMcpClient records the tool calls and
 * returns canned structuredContent, so we test the wire shape and the
 * fail-closed mapping without the real server.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { paymentsMcpFromClient, connectRealPayments } from './integrations';
import type { PaymentsMcpClient } from './integrations';
import { Queen } from './queen';
import type { StreamSpec } from './streams';
import type { Task } from './worker';
import type { Action, StreamId } from './escalation';
import type { SisVaultMcp } from './integrations';

/** A recording mock MCP client. Maps tool name → canned structured result. */
function mockClient(
  responses: Record<string, { structuredContent?: Record<string, unknown>; isError?: boolean }>,
): { client: PaymentsMcpClient; calls: Array<{ name: string; arguments: Record<string, unknown> }> } {
  const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  const client: PaymentsMcpClient = {
    async callTool(args) {
      calls.push(args);
      return responses[args.name] ?? { structuredContent: {}, isError: false };
    },
  };
  return { client, calls };
}

function fakeVault(): SisVaultMcp {
  return {
    async sis_append_entry() {
      return { ok: true, id: 'test' };
    },
    async sis_vault_search() {
      return [];
    },
    async sis_confirm() {
      return { ok: true };
    },
  };
}

function action(stream: StreamId, partial: Partial<Action> & Pick<Action, 'kind'>): Action {
  return { stream, irreversible: false, movesMoney: false, crossStream: false, ...partial };
}

function paymentsSpec(): StreamSpec {
  return {
    id: 'payments',
    label: 'Payments',
    purpose: 'test',
    queen: { name: 'Payments Queen', harness: [], selfImprovingLoop: ['verify mandate'] },
    workers: [{ name: 'mandate-verifier', skill: 'agentic-payments', does: 'verify mandate' }],
    mcp: [],
  };
}

/* ---------------------------------------------------------------- *
 * Adapter wire shape — maps the real server's verdicts correctly.
 * ---------------------------------------------------------------- */

test('verify_mandate maps server verdict "verified" → valid:true and calls the right tool', async () => {
  const { client, calls } = mockClient({
    verify_mandate: { structuredContent: { verdict: 'verified', reason: 'ok' } },
  });
  const payments = paymentsMcpFromClient(client);
  const res = await payments.verify_mandate({ signature: 'sig', amount: 40, purpose: 'p' });

  assert.equal(res.valid, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'verify_mandate');
  // The adapter must send both a mandate and a charge object (the real schema).
  assert.ok('mandate' in calls[0].arguments);
  assert.ok('charge' in calls[0].arguments);
});

test('FAIL-CLOSED: verify_mandate maps "reject" → valid:false', async () => {
  const { client } = mockClient({ verify_mandate: { structuredContent: { verdict: 'reject', reason: 'bad sig' } } });
  const res = await paymentsMcpFromClient(client).verify_mandate({ signature: '', amount: 1, purpose: 'p' });
  assert.equal(res.valid, false);
});

test('FAIL-CLOSED: verify_mandate maps isError → valid:false even if verdict says verified', async () => {
  const { client } = mockClient({ verify_mandate: { structuredContent: { verdict: 'verified' }, isError: true } });
  const res = await paymentsMcpFromClient(client).verify_mandate({ signature: 's', amount: 1, purpose: 'p' });
  assert.equal(res.valid, false);
});

test('FAIL-CLOSED: verify_mandate on a thrown transport error → valid:false', async () => {
  const client: PaymentsMcpClient = {
    async callTool() {
      throw new Error('socket closed');
    },
  };
  const res = await paymentsMcpFromClient(client).verify_mandate({ signature: 's', amount: 1, purpose: 'p' });
  assert.equal(res.valid, false);
  assert.match(res.reason, /unreachable|fail-closed/i);
});

test('check_spend_cap maps "within-cap" → withinCap:true', async () => {
  const { client, calls } = mockClient({ check_spend_cap: { structuredContent: { verdict: 'within-cap' } } });
  const res = await paymentsMcpFromClient(client).check_spend_cap('payments', 40);
  assert.equal(res.withinCap, true);
  assert.equal(calls[0].name, 'check_spend_cap');
});

test('FAIL-CLOSED: check_spend_cap maps "escalate" → withinCap:false', async () => {
  const { client } = mockClient({ check_spend_cap: { structuredContent: { verdict: 'escalate' } } });
  const res = await paymentsMcpFromClient(client).check_spend_cap('payments', 5000);
  assert.equal(res.withinCap, false);
});

test('FAIL-CLOSED: check_spend_cap on transport throw → withinCap:false', async () => {
  const client: PaymentsMcpClient = {
    async callTool() {
      throw new Error('boom');
    },
  };
  const res = await paymentsMcpFromClient(client).check_spend_cap('payments', 5000);
  assert.equal(res.withinCap, false);
});

test('record_audit_entry maps recorded:true → ok:true; audit-first failure → ok:false', async () => {
  const okClient = mockClient({ record_audit_entry: { structuredContent: { recorded: true } } });
  const okRes = await paymentsMcpFromClient(okClient.client).record_audit_entry({
    agent: 'a', stream: 'payments', task: 't', note: 'n', timestamp: 'ts',
  });
  assert.equal(okRes.ok, true);

  const failClient = mockClient({ record_audit_entry: { structuredContent: { recorded: false }, isError: true } });
  const failRes = await paymentsMcpFromClient(failClient.client).record_audit_entry({
    agent: 'a', stream: 'payments', task: 't', note: 'n', timestamp: 'ts',
  });
  assert.equal(failRes.ok, false);
});

test('require_human_approval always returns pending (never approved)', async () => {
  const { client } = mockClient({});
  const res = await paymentsMcpFromClient(client).require_human_approval('over cap');
  assert.deepEqual(res, { pending: true });
});

/* ---------------------------------------------------------------- *
 * Queen ↔ adapter integration — the Payments Queen calls verify_mandate
 * and check_spend_cap THROUGH the adapter during a loop step.
 * ---------------------------------------------------------------- */

test('Payments Queen drives verify_mandate + check_spend_cap through the adapter', async () => {
  const { client, calls } = mockClient({
    verify_mandate: { structuredContent: { verdict: 'verified', reason: 'ok' } },
    check_spend_cap: { structuredContent: { verdict: 'within-cap' } },
  });
  const payments = paymentsMcpFromClient(client);

  const queen = new Queen(paymentsSpec());
  const task: Task = {
    id: 'pay-1',
    worker: 'mandate-verifier',
    description: 'settle within cap',
    proposes: action('payments', { kind: 'payment', movesMoney: true, amount: 40, cap: 100 }),
  };

  await queen.stepLoop([task], { vault: fakeVault(), payments });

  const toolNames = calls.map((c) => c.name);
  assert.ok(toolNames.includes('verify_mandate'), 'queen must call verify_mandate through the adapter');
  assert.ok(toolNames.includes('check_spend_cap'), 'queen must call check_spend_cap through the adapter');
});

/* ---------------------------------------------------------------- *
 * Graceful degradation — connectRealPayments never crashes when the
 * server binary is absent; it falls back to the fail-closed dry-run.
 * ---------------------------------------------------------------- */

test('connectRealPayments degrades cleanly when the server is not built', async () => {
  const logs: string[] = [];
  const { payments, close } = await connectRealPayments(
    { serverPath: '/nonexistent/payments-mcp/dist/index.js' },
    (m) => logs.push(m),
  );
  // It must return a working (fail-closed) adapter, not throw.
  const res = await payments.verify_mandate({ signature: 's', amount: 1, purpose: 'p' });
  assert.equal(res.valid, false, 'fallback adapter must be fail-closed');
  await close();
  assert.ok(logs.some((l) => /not built|fall(ing)? back/i.test(l)));
});
