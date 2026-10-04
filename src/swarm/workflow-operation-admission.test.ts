import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { PostgresOperationAuthorityStore, type AuthoritySqlPool } from './postgres-operation-authority';
import { CloudflareWorkflowOperationAdmission } from './workflow-operation-admission';
import { bindCloudflareWorkflowOperation } from './workflow-operation-context';
import { workflowOperationFixture } from './workflow-operation-test-fixtures';
import { sha256Digest } from './runtime-digest';

const digest = 'a'.repeat(64);
const now = new Date().toISOString();
// Fault-injected transport only. Real SQL races/privileges/admission run in PostgreSQL CI.
function sqlFixture(existing?: Record<string, unknown>, failAt?: string) {
  const queries: string[] = [];
  let row = existing;
  const pool: AuthoritySqlPool = { connect: async () => ({
    query: async (sql, values) => {
      queries.push(sql);
      if (failAt && sql.includes(failAt)) throw new Error('injected persistence failure');
      if (sql.includes('starlight_authority_lock()')) return { rows: [{ locked: true }] };
      if (sql.includes('clock_timestamp()')) return { rows: [{ now }] };
      if (sql.startsWith('INSERT INTO swarm_authority_prepared_operations')) {
        const inserted = !row;
        row ??= { operation_id: values![0], binding_digest_sha256: values![1], registered_at: values![2], state: 'ready' };
        return { rows: inserted ? [{ operation_id: values![0] }] : [] };
      }
      if (sql.includes('FROM swarm_authority_prepared_operations')) return { rows: row ? [row] : [] };
      return { rows: [] };
    }, release: () => queries.push('RELEASE'),
  }) };
  return { store: new PostgresOperationAuthorityStore(pool), queries, row: () => row };
}

test('legacy registration cannot silently accept a different immutable binding', async () => {
  const h = sqlFixture({ operation_id: 'operation-one', binding_digest_sha256: 'b'.repeat(64), registered_at: now, state: 'ready' });
  await assert.rejects(() => h.store.putPreparedOperation('operation-one', digest, now), /immutable|differs/i);
  assert.equal(h.row()!.binding_digest_sha256, 'b'.repeat(64));
});
test('registration reads the committed candidate under the authority lock and retries preserve original time', async () => {
  const h = sqlFixture();
  const first = await h.store.registerPreparedOperation('operation-one', digest);
  if (!first.registered) assert.fail(first.blockers.join(' '));
  assert.equal(first.registered, true);
  assert.equal(first.already_registered, false);
  assert.equal(first.receipt.execution_authority_granted, false);
  assert.equal(first.receipt.binding_digest_sha256, digest);
  const second = await h.store.registerPreparedOperation('operation-one', digest);
  if (!second.registered) assert.fail(second.blockers.join(' '));
  assert.equal(second.registered, true);
  assert.equal(second.already_registered, true);
  assert.equal(second.receipt.registered_at, first.receipt.registered_at);
  assert.ok(h.queries.some((sql) => sql.includes('FOR UPDATE')));
  assert.equal(h.queries.filter((sql) => sql.includes("VALUES ('prepared-operation-registered'")).length, 1);
});
test('cancelled registrations remain permanent tombstones', async () => {
  const h = sqlFixture({ operation_id: 'operation-one', binding_digest_sha256: digest, registered_at: now, state: 'cancelled' });
  const result = await h.store.registerPreparedOperation('operation-one', digest);
  assert.equal(result.registered, false);
  assert.match(result.blockers.join(' '), /cancelled/i);
  assert.equal(h.row()!.state, 'cancelled');
  assert.ok(h.queries.some((sql) => sql.includes('prepared-operation-registration-denied')));
});
test('future or malformed persisted registration times cannot become ready evidence', async () => {
  const h = sqlFixture({ operation_id: 'operation-one', binding_digest_sha256: digest, registered_at: '2099-01-01T00:00:00Z', state: 'ready' });
  const future = await h.store.registerPreparedOperation('operation-one', digest);
  assert.equal(future.registered, false); assert.match(future.blockers.join(' '), /future/i);
  const corrupt = sqlFixture({ operation_id: 'operation-one', binding_digest_sha256: digest, registered_at: 'invalid', state: 'ready' });
  await assert.rejects(() => corrupt.store.registerPreparedOperation('operation-one', digest), /invalid.*timestamp/i);
});
for (const failAt of ['FROM swarm_authority_prepared_operations', "VALUES ('prepared-operation-registered'", 'COMMIT']) {
  test(`persistence failure at ${failAt} never returns a registration receipt`, async () => {
    const h = sqlFixture(undefined, failAt);
    await assert.rejects(() => h.store.registerPreparedOperation('operation-one', digest), /injected persistence failure/);
    assert.ok(h.queries.includes('ROLLBACK'));
    assert.equal(h.queries.at(-1), 'RELEASE');
  });
}
test('invalid operation identifiers and digests never reach SQL', async () => {
  const h = sqlFixture();
  await assert.rejects(() => h.store.registerPreparedOperation('../escape', digest));
  await assert.rejects(() => h.store.registerPreparedOperation('operation-one', 'not-a-digest'));
  assert.equal(h.queries.length, 0);
});
test('database time after lock waiting denies an expired registration before insertion', async () => {
  const h = sqlFixture();
  const result = await h.store.registerPreparedOperation('operation-one', digest, '2020-01-01T00:00:00Z');
  assert.equal(result.registered, false);
  assert.match(result.blockers.join(' '), /deadline expired/);
  assert.equal(h.queries.some((sql) => sql.startsWith('INSERT INTO swarm_authority_prepared_operations')), false);
});

let fixture: ReturnType<typeof workflowOperationFixture>;
before(() => { fixture = workflowOperationFixture(); });
after(() => fixture?.cleanup());
const bound = () => bindCloudflareWorkflowOperation(fixture.plan, fixture.profile, fixture.verification, fixture.binding, fixture.target);
const config = (operation = bound()) => ({
  schema_version: 'starlight.workflow_operation_admission_bootstrap.v1' as const,
  operation_id: operation.binding.operation_id, binding_digest_sha256: sha256Digest(operation.binding),
  target: operation.context.target, expires_at: new Date(Date.now() + 60_000).toISOString(),
});
const keyring = { approvalIssuers: {}, budgetIssuers: {} };
test('bootstrap rejects copied receipts, substituted targets or bindings and fake durable stores', () => {
  const operation = bound(); const h = sqlFixture();
  assert.throws(() => new CloudflareWorkflowOperationAdmission(config(operation), { ...operation }, h.store, h.store, keyring), /issued/i);
  assert.throws(() => new CloudflareWorkflowOperationAdmission({ ...config(operation), binding_digest_sha256: digest }, operation, h.store, h.store, keyring), /binding/i);
  assert.throws(() => new CloudflareWorkflowOperationAdmission({ ...config(operation), target: { ...fixture.target, account_id: 'b'.repeat(32) } }, operation, h.store, h.store, keyring), /target/i);
  assert.throws(() => new CloudflareWorkflowOperationAdmission(config(operation), operation, { durable: true } as PostgresOperationAuthorityStore, h.store, keyring), /PostgreSQL/i);
});
test('expired bootstrap cannot register or admit and denial is audited', async () => {
  const operation = bound(); const h = sqlFixture();
  const client = new CloudflareWorkflowOperationAdmission({ ...config(operation), expires_at: '2020-01-01T00:00:00Z' }, operation, h.store, h.store, keyring);
  const result = await client.register(); assert.equal(result.registered, false);
  const admission = await client.admit({ approval_receipt: {}, budget_receipt: {}, reservation_duration_ms: 1000 });
  assert.equal(admission.admitted, false);
  assert.equal(h.queries.some((sql) => sql.startsWith('INSERT INTO swarm_authority_prepared_operations')), false);
  assert.ok(h.queries.some((sql) => sql.includes('INSERT INTO swarm_authority_audit')));
});
test('invalid signatures cannot reserve and workload fields cannot replace the sealed operation', async () => {
  const operation = bound(); const h = sqlFixture();
  const client = new CloudflareWorkflowOperationAdmission(config(operation), operation, h.store, h.store, keyring);
  const result = await client.admit({ approval_receipt: {}, budget_receipt: {}, reservation_duration_ms: 1000 });
  assert.equal(result.admitted, false);
  const injected = await client.admit({ binding: { ...operation.binding, host_id: 'other-host' }, approval_receipt: {}, budget_receipt: {}, reservation_duration_ms: 1000 });
  assert.equal(injected.admitted, false);
  assert.match(injected.blockers.join(' '), /invalid/i);
  assert.equal(h.queries.some((sql) => sql.includes('swarm_authority_reservations')), false);
  assert.equal(Object.isFrozen(client), true);
  assert.deepEqual(Object.keys(client), []);
});
