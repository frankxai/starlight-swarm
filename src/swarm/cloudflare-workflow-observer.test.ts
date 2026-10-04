import assert from 'node:assert/strict';
import dns from 'node:dns';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { after, afterEach, before, mock, test } from 'node:test';

import { CloudflareWorkflowObserver } from './cloudflare-workflow-observer';
import { bindCloudflareWorkflowOperation, cloudflareWorkflowOperationEnvelope } from './workflow-operation-context';
import { workflowOperationFixture } from './workflow-operation-test-fixtures';

let fixture: ReturnType<typeof workflowOperationFixture>;
let operation: ReturnType<typeof bindCloudflareWorkflowOperation>;
let oldToken: string | undefined;
before(() => {
  fixture = workflowOperationFixture();
  operation = bindCloudflareWorkflowOperation(fixture.plan, fixture.profile, fixture.verification, fixture.binding, fixture.target);
  oldToken = process.env.STARLIGHT_CLOUDFLARE_OBSERVER_TOKEN;
  process.env.STARLIGHT_CLOUDFLARE_OBSERVER_TOKEN = 'test-observer-token-value-only';
});
after(() => {
  fixture?.cleanup();
  if (oldToken === undefined) delete process.env.STARLIGHT_CLOUDFLARE_OBSERVER_TOKEN;
  else process.env.STARLIGHT_CLOUDFLARE_OBSERVER_TOKEN = oldToken;
});
afterEach(() => mock.restoreAll());

function observer(overrides = {}) {
  return new CloudflareWorkflowObserver({
    target: fixture.target, credential_ref: 'read-only-observer-one',
    access_review_expires_at: new Date(Date.now() + 60_000).toISOString(), timeout_ms: 1000,
    ...overrides,
  });
}
function body(overrides = {}) {
  return {
    success: true, errors: [], messages: [],
    result: { status: 'running', queued: new Date(Date.now() - 10_000).toISOString(),
      start: new Date(Date.now() - 5000).toISOString(), end: null,
      versionId: fixture.target.version_id, params: cloudflareWorkflowOperationEnvelope(operation), ...overrides },
  };
}

function network(payload: unknown, options: { status?: number; address?: string; authenticated?: boolean; contentType?: string; raw?: string; hang?: boolean; abortBody?: boolean; workflowUuid?: string; remoteAddress?: string } = {}) {
  let requestOptions: https.RequestOptions | undefined;
  let requests = 0;
  let destroyed = 0;
  mock.method(dns, 'lookup', (...args: unknown[]) => {
    const callback = args[args.length - 1] as Function;
    queueMicrotask(() => callback(null, [{ address: options.address ?? '8.8.8.8', family: 4 }]));
  });
  mock.method(https, 'request', (config: https.RequestOptions, callback: Function) => {
    requests++; requestOptions = config;
    const request = new EventEmitter() as EventEmitter & { end(): void; destroy(error?: Error): void };
    request.destroy = (error) => { destroyed++; if (error) queueMicrotask(() => request.emit('error', error)); };
    request.end = () => {
      if (options.hang) return;
      const ownerPayload = { success: true, errors: [], result: { id: options.workflowUuid ?? fixture.target.workflow_uuid, name: fixture.target.workflow_name } };
      const response = Readable.from([Buffer.from(options.raw ?? JSON.stringify(config.path?.includes('/instances/') ? payload : ownerPayload))]) as Readable & { statusCode: number; headers: Record<string, string>; socket: object; complete: boolean };
      response.statusCode = options.status ?? 200;
      response.headers = { 'content-type': options.contentType ?? 'application/json' };
      response.socket = { encrypted: true, authorized: options.authenticated !== false, remoteAddress: options.remoteAddress ?? options.address ?? '8.8.8.8' };
      response.complete = !options.abortBody;
      queueMicrotask(() => callback(response));
    };
    return request;
  });
  return { get config() { return requestOptions!; }, get requests() { return requests; }, get destroyed() { return destroyed; } };
}

test('readback uses a fixed authenticated HTTPS origin, pinned public address and exact instance', async () => {
  const net = network(body()); const client = observer();
  const result = await client.observe(operation);
  assert.equal(result.observed, true);
  assert.equal(net.requests, 2);
  assert.equal(net.config.hostname, 'api.cloudflare.com');
  assert.equal(net.config.method, 'GET');
  assert.equal(net.config.agent, false);
  assert.equal(net.config.rejectUnauthorized, true);
  assert.match(net.config.path!, /mission-instance-one\?simple=true$/);
  assert.equal(JSON.stringify(client).includes('test-observer-token-value-only'), false);
  assert.equal(JSON.stringify(result).includes('test-observer-token-value-only'), false);
  assert.equal(client.isIssuedObservation(result.observed ? result.observation : null), true);
  if (!result.observed) throw new Error('Expected authenticated observation.');
  assert.equal(client.isIssuedObservation(JSON.parse(JSON.stringify(result.observation))), false);
  assert.equal(result.observation.status, 'running');
  assert.equal(result.observation.execution_authority_granted, false);
  assert.equal(result.observation.external_effects_settled, false);
  assert.equal(result.observation.budget_commitment_released, false);
  assert.equal(Object.isFrozen(result.observation), true);
});
test('copied operation data and another tenant cannot select a request destination', async () => {
  const net = network(body());
  assert.equal((await observer().observe(JSON.parse(JSON.stringify(operation)))).observed, false);
  const other = bindCloudflareWorkflowOperation(fixture.plan, fixture.profile, fixture.verification, fixture.binding, { ...fixture.target, account_id: 'b'.repeat(32) });
  assert.equal((await observer().observe(other)).observed, false);
  assert.equal(net.requests, 0);
});
test('expired access and missing credentials deny before any network call', async () => {
  const net = network(body());
  assert.equal((await observer({ access_review_expires_at: '2020-01-01T00:00:00.000Z' }).observe(operation)).observed, false);
  delete process.env.STARLIGHT_CLOUDFLARE_OBSERVER_TOKEN;
  assert.throws(() => observer(), /credential/i);
  process.env.STARLIGHT_CLOUDFLARE_OBSERVER_TOKEN = 'test-observer-token-value-only';
  assert.equal(net.requests, 0);
});
for (const address of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '100.64.0.1', '192.168.1.1', '198.18.1.1', '224.1.1.1']) {
  test(`DNS destination ${address} is refused before sending credentials`, async () => {
    const net = network(body(), { address });
    assert.equal((await observer().observe(operation)).observed, false);
    assert.equal(net.requests, 0);
  });
}
for (const status of [301, 401, 404, 429, 500]) {
  test(`HTTP ${status} is inconclusive and never followed or retried`, async () => {
    const net = network(body(), { status });
    const result = await observer().observe(operation);
    assert.equal(result.observed, false);
    assert.equal(net.requests, 1);
    assert.equal(result.instance_absence_proven, false);
  });
}
test('an invalid TLS peer, invalid JSON, wrong version or changed operation payload cannot attest', async () => {
  for (const [payload, options] of [
    [body(), { authenticated: false }], [body(), { raw: 'not JSON' }],
    [body({ versionId: '33333333-3333-4333-8333-333333333333' }), {}],
    [body({ params: {} }), {}], [body(), { contentType: 'text/html' }], [body(), { abortBody: true }],
  ] as const) {
    mock.restoreAll(); network(payload, options);
    assert.equal((await observer().observe(operation)).observed, false);
  }
});
test('oversized response and a stalled request close the owned request without retry', async () => {
  let net = network(body(), { raw: 'x'.repeat(65_537) });
  assert.equal((await observer().observe(operation)).observed, false);
  mock.restoreAll(); net = network(body(), { hang: true });
  const result = await observer().observe(operation);
  assert.equal(result.observed, false);
  assert.equal(net.requests, 1); assert.ok(net.destroyed > 0);
});
test('engine termination and rollback retain external effect and budget holds', async () => {
  for (const status of ['terminated', 'rollingBack']) {
    mock.restoreAll(); network(body({ status, end: status === 'terminated' ? new Date(Date.now() - 1000).toISOString() : null }));
    const result = await observer().observe(operation);
    assert.equal(result.observed, true);
    if (!result.observed) throw new Error('Expected engine observation.');
    assert.equal(result.observation.workflow_terminal_observed, status === 'terminated');
    assert.equal(result.observation.descendants_quiesced, false);
    assert.equal(result.observation.budget_commitment_released, false);
  }
});
test('a future or contradictory provider timestamp is refused', async () => {
  network(body({ start: new Date(Date.now() + 60_000).toISOString() }));
  assert.equal((await observer().observe(operation)).observed, false);
});
test('a recreated workflow name and a TLS address outside the DNS pin are refused', async () => {
  let net = network(body(), { workflowUuid: '33333333-3333-4333-8333-333333333333' });
  assert.equal((await observer().observe(operation)).observed, false);
  assert.equal(net.requests, 1);
  mock.restoreAll(); net = network(body(), { remoteAddress: '8.8.4.4' });
  assert.equal((await observer().observe(operation)).observed, false);
  assert.equal(net.requests, 1);
});
test('one observer refuses parallel reads and never substitutes another instance on recovery', async () => {
  const net = network(body(), { hang: true }); const client = observer();
  const pending = client.observe(operation);
  const duplicate = await client.observe(operation);
  assert.equal(duplicate.observed, false);
  assert.match(duplicate.blockers.join(' '), /in flight/);
  assert.equal((await pending).observed, false);
  assert.equal(net.requests, 1);
});
test('an issued observation becomes unusable when its access review expires', async () => {
  network(body()); const client = observer(); const result = await client.observe(operation);
  if (!result.observed) throw new Error('Expected authenticated observation.');
  const expires = Date.parse(result.observation.expires_at);
  mock.method(Date, 'now', () => expires);
  assert.equal(client.isIssuedObservation(result.observation), false);
  assert.equal((await client.observe(operation)).observed, false);
});
test('a stalled DNS callback cannot send credentials after the overall deadline', async () => {
  let callback: Function | undefined; let requests = 0;
  mock.method(dns, 'lookup', (...args: unknown[]) => { callback = args[args.length - 1] as Function; });
  mock.method(https, 'request', () => { requests++; throw new Error('No request is authorized after timeout.'); });
  const result = await observer().observe(operation);
  assert.equal(result.observed, false); assert.equal(requests, 0);
  callback!(null, [{ address: '8.8.8.8', family: 4 }]);
  assert.equal(requests, 0);
});
