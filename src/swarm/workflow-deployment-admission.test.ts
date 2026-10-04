import assert from 'node:assert/strict';
import dns from 'node:dns';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { after, afterEach, before, mock, test } from 'node:test';

import { CloudflareWorkflowObserver } from './cloudflare-workflow-observer';
import { PostgresOperationAuthorityStore, type AuthoritySqlPool } from './postgres-operation-authority';
import { CloudflareWorkflowOperationAdmission } from './workflow-operation-admission';
import { bindCloudflareWorkflowOperation, cloudflareWorkflowOperationEnvelope } from './workflow-operation-context';
import { workflowOperationFixture } from './workflow-operation-test-fixtures';
import { deriveWorkflowInstanceOwnership } from './workflow-instance-ownership';
import { sha256Digest } from './runtime-digest';

let fixture: ReturnType<typeof workflowOperationFixture>;
let operation: ReturnType<typeof bindCloudflareWorkflowOperation>;
let previousToken: string | undefined;
before(() => {
  fixture = workflowOperationFixture();
  operation = bindCloudflareWorkflowOperation(fixture.plan, fixture.profile, fixture.verification, fixture.binding, fixture.target);
  previousToken = process.env.STARLIGHT_CLOUDFLARE_OBSERVER_TOKEN;
  process.env.STARLIGHT_CLOUDFLARE_OBSERVER_TOKEN = 'test-deployment-observer-only';
});
after(() => {
  fixture?.cleanup();
  if (previousToken === undefined) delete process.env.STARLIGHT_CLOUDFLARE_OBSERVER_TOKEN;
  else process.env.STARLIGHT_CLOUDFLARE_OBSERVER_TOKEN = previousToken;
});
afterEach(() => mock.restoreAll());

function store(onRead?: () => 'ready' | 'cancelled' | void) {
  const ownership = deriveWorkflowInstanceOwnership(operation);
  const queries: string[] = [];
  const denials: string[][] = [];
  const pool: AuthoritySqlPool = { connect: async () => ({ query: async (sql, values) => {
    queries.push(sql);
    if (sql.includes('FROM swarm_authority_workflow_instances')) {
      const preparedState = onRead?.() ?? 'ready';
      return { rows: [{ operation_id: ownership.operation_id, binding_digest_sha256: ownership.binding_digest_sha256,
        ownership, registered_at: new Date(Date.now() - 5000).toISOString(), account_id: ownership.target.account_id,
        workflow_name: ownership.target.workflow_name, instance_id: ownership.target.instance_id,
        prepared_digest: ownership.binding_digest_sha256, prepared_state: preparedState, workflow_ownership_required: true,
        observed_at: new Date(Date.now()).toISOString() }] };
    }
    if (sql.includes('INSERT INTO swarm_authority_audit')) denials.push(JSON.parse(String(values![3])).blockers);
    assert.equal(sql.includes('swarm_authority_reservations'), false, 'No reservation may follow an unverified deployment or invalid signature.');
    return { rows: [] };
  } }) };
  return { adapter: new PostgresOperationAuthorityStore(pool), queries, denials };
}

function observer(overrides = {}) {
  return new CloudflareWorkflowObserver({ target: fixture.target, credential_ref: 'deployment-observer-one',
    access_review_expires_at: new Date(Date.now() + 60_000).toISOString(), timeout_ms: 1000, ...overrides });
}
function admission(adapter: PostgresOperationAuthorityStore, liveObserver?: CloudflareWorkflowObserver, overrides = {}) {
  return new CloudflareWorkflowOperationAdmission({ schema_version: 'starlight.workflow_operation_admission_bootstrap.v1',
    operation_id: operation.binding.operation_id, binding_digest_sha256: sha256Digest(operation.binding),
    target: fixture.target, expires_at: new Date(Date.now() + 60_000).toISOString(), ...overrides },
  operation, adapter, adapter, { approvalIssuers: {}, budgetIssuers: {} }, liveObserver);
}
const request = () => ({ approval_receipt: {}, budget_receipt: {}, reservation_duration_ms: 1000 });

function network(options: { version?: string; status?: string; deleted?: boolean; omitDeleted?: boolean;
  payload?: unknown; httpStatus?: number; onInstance?: () => void } = {}) {
  let calls = 0;
  mock.method(dns, 'lookup', (...args: unknown[]) => {
    const callback = args[args.length - 1] as Function;
    queueMicrotask(() => callback(null, [{ address: '8.8.8.8', family: 4 }]));
  });
  mock.method(https, 'request', (config: https.RequestOptions, callback: Function) => {
    calls++;
    const req = new EventEmitter() as EventEmitter & { end(): void; destroy(): void };
    req.destroy = () => {};
    req.end = () => {
      const instance = config.path?.includes('/instances/');
      if (instance) options.onInstance?.();
      const payload = instance
        ? { status: options.status ?? 'running', versionId: options.version ?? fixture.target.version_id,
          params: options.payload ?? cloudflareWorkflowOperationEnvelope(operation),
          queued: new Date(Date.now() - 3000).toISOString(), start: new Date(Date.now() - 2000).toISOString(), end: null }
        : { id: fixture.target.workflow_uuid, name: fixture.target.workflow_name,
          ...(options.omitDeleted ? {} : { script_deleted: options.deleted ?? false }) };
      const response = Readable.from([Buffer.from(JSON.stringify({ success: true, errors: [], result: payload }))]) as Readable & {
        statusCode: number; headers: object; socket: object; complete: boolean;
      };
      response.statusCode = options.httpStatus ?? 200;
      response.headers = { 'content-type': 'application/json' };
      response.socket = { encrypted: true, authorized: true, remoteAddress: '8.8.8.8' };
      response.complete = true;
      queueMicrotask(() => callback(response));
    };
    return req;
  });
  return { get calls() { return calls; } };
}

test('workflow registration data cannot admit without a configured authenticated observer', async () => {
  const h = store(); const result = await admission(h.adapter).admit(request());
  assert.equal(result.admitted, false); assert.match(result.blockers.join(' '), /observer.*(absent|configured)/i);
  assert.ok(h.denials.length > 0);
});

test('a caller-authored observer or serialized observation cannot replace the server capability', () => {
  const h = store();
  assert.throws(() => admission(h.adapter, { observe: async () => ({ observed: true }) } as unknown as CloudflareWorkflowObserver), /observer/i);
});

test('an object with the observer prototype still lacks its private transport state', async () => {
  const fake = Object.create(CloudflareWorkflowObserver.prototype) as CloudflareWorkflowObserver;
  Object.assign(fake, { observe: async () => ({ observed: true, observation: {} }), isIssuedObservation: () => true });
  const h = store(); const result = await admission(h.adapter, fake).admit(request());
  assert.equal(result.admitted, false); assert.match(result.blockers.join(' '), /observation|readback|context/i);
});

test('authenticated wrong-version readback denies before any reservation', async () => {
  const net = network({ version: '33333333-3333-4333-8333-333333333333' }); const h = store();
  const result = await admission(h.adapter, observer()).admit(request());
  assert.equal(result.admitted, false); assert.match(result.blockers.join(' '), /version/i); assert.equal(net.calls, 2);
});

test('later observer method replacement cannot bypass the captured transport or issuance check', async () => {
  const net = network({ version: '33333333-3333-4333-8333-333333333333' }); const h = store();
  const client = admission(h.adapter, observer());
  mock.method(CloudflareWorkflowObserver.prototype, 'observe', async () => ({ observed: true, observation: {} } as never));
  mock.method(CloudflareWorkflowObserver.prototype, 'isIssuedObservation', (() => true) as never);
  const result = await client.admit(request());
  assert.equal(result.admitted, false); assert.match(result.blockers.join(' '), /version/i); assert.equal(net.calls, 2);
});

test('readback of another operation envelope denies admission', async () => {
  network({ payload: { ...cloudflareWorkflowOperationEnvelope(operation), operation_binding_digest_sha256: 'f'.repeat(64) } });
  const h = store(); const result = await admission(h.adapter, observer()).admit(request());
  assert.equal(result.admitted, false); assert.match(result.blockers.join(' '), /correlation|bound-operation/i);
});

for (const status of ['queued', 'paused', 'waitingForPause', 'waiting', 'rollingBack', 'complete', 'errored', 'terminated']) {
  test(`a ${status} workflow cannot reserve a new effect`, async () => {
    network({ status }); const h = store(); const result = await admission(h.adapter, observer()).admit(request());
    assert.equal(result.admitted, false); assert.match(result.blockers.join(' '), /running|runnable/i);
  });
}

for (const options of [{ deleted: true }, { omitDeleted: true }]) {
  test(`deleted or unknown workflow script state denies: ${JSON.stringify(options)}`, async () => {
    network(options); const h = store(); const result = await admission(h.adapter, observer()).admit(request());
    assert.equal(result.admitted, false); assert.match(result.blockers.join(' '), /script/i);
  });
}

test('HTTP 404 remains inconclusive and cannot grant admission or absence', async () => {
  const net = network({ httpStatus: 404 }); const h = store(); const result = await admission(h.adapter, observer()).admit(request());
  assert.equal(result.admitted, false); assert.match(result.blockers.join(' '), /404.*inconclusive/i); assert.equal(net.calls, 1);
});

test('a valid running version remains subject to signed human approval and budget', async () => {
  const net = network(); const h = store(); const result = await admission(h.adapter, observer()).admit(request());
  assert.equal(result.admitted, false); assert.match(result.blockers.join(' '), /approval.*invalid|budget.*invalid/i); assert.equal(net.calls, 2);
});

test('bootstrap expiry during readback cannot reuse its earlier duration or clock', async () => {
  const fixed = Date.now(); const expiry = new Date(fixed + 30_000).toISOString();
  network({ onInstance: () => { mock.method(Date, 'now', () => fixed + 29_500); } });
  const h = store(); const result = await admission(h.adapter, observer(), { expires_at: expiry }).admit(request());
  assert.equal(result.admitted, false); assert.match(result.blockers.join(' '), /expired|second/i);
});

test('an observation that expires during durable ownership readback cannot be cached as readiness', async () => {
  const fixed = Date.now(); network();
  let reads = 0;
  const h = store(() => { if (++reads === 2) mock.method(Date, 'now', () => fixed + 60_001); });
  const result = await admission(h.adapter, observer(), { expires_at: new Date(fixed + 120_000).toISOString() }).admit(request());
  assert.equal(result.admitted, false); assert.match(result.blockers.join(' '), /fresh|expired/i);
});

test('cancellation during deployment readback denies before signed admission', async () => {
  network(); let reads = 0;
  const h = store(() => ++reads === 2 ? 'cancelled' : 'ready');
  const result = await admission(h.adapter, observer()).admit(request());
  assert.equal(result.admitted, false); assert.match(result.blockers.join(' '), /no longer ready/i); assert.equal(reads, 2);
});
