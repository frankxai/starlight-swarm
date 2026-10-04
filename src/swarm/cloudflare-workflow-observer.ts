import { createHash } from 'node:crypto';
import dns from 'node:dns';
import https from 'node:https';
import type { IncomingMessage, ClientRequest } from 'node:http';
import type { TLSSocket } from 'node:tls';
import { TextDecoder } from 'node:util';
import { z } from 'zod';

import { sha256Digest } from './runtime-digest';
import {
  cloudflareWorkflowOperationEnvelope, cloudflareWorkflowTargetSchema,
  isIssuedCloudflareWorkflowOperation, type CloudflareWorkflowTarget,
} from './workflow-operation-context';

const API_HOST = 'api.cloudflare.com';
const MAX_RESPONSE_BYTES = 65_536;
const OBSERVATION_TTL_MS = 60_000;
const configSchema = z.object({
  target: cloudflareWorkflowTargetSchema,
  credential_ref: z.string().min(3).max(160).regex(/^[a-z0-9][a-z0-9._:-]*$/),
  access_review_expires_at: z.iso.datetime({ offset: true }),
  timeout_ms: z.number().int().min(1000).max(15_000),
}).strict();
const statusSchema = z.enum(['queued', 'running', 'paused', 'errored', 'terminated', 'complete', 'waitingForPause', 'waiting', 'rollingBack']);
const time = z.iso.datetime({ offset: true });
const responseSchema = z.object({
  success: z.literal(true), errors: z.array(z.unknown()).length(0),
  result: z.object({
    status: statusSchema, versionId: z.uuid(), params: z.unknown(), queued: time,
    start: time.nullish(), end: time.nullish(),
  }).passthrough(),
}).passthrough();
const workflowResponseSchema = z.object({
  success: z.literal(true), errors: z.array(z.unknown()).length(0),
  result: z.object({ id: z.uuid(), name: z.string(), script_deleted: z.boolean().optional() }).passthrough(),
}).passthrough();

export interface CloudflareWorkflowObservation {
  schema_version: 'starlight.cloudflare_workflow_observation.v1';
  target: CloudflareWorkflowTarget;
  binding_digest_sha256: string;
  credential_ref: string;
  response_body_sha256: string;
  workflow_metadata_body_sha256: string;
  observed_at: string;
  expires_at: string;
  status: z.infer<typeof statusSchema>;
  queued_at: string;
  started_at: string | null;
  ended_at: string | null;
  workflow_terminal_observed: boolean;
  workflow_script_deleted: boolean | null;
  execution_authority_granted: false;
  descendants_quiesced: false;
  external_effects_settled: false;
  budget_commitment_released: false;
}
export type CloudflareWorkflowObservationResult =
  | { observed: true; observation: CloudflareWorkflowObservation; instance_absence_proven: false; blockers: [] }
  | { observed: false; observation: null; instance_absence_proven: false; blockers: string[] };
type Configuration = z.infer<typeof configSchema>;
type State = { config: Configuration; token: string; inFlight: boolean; issued: WeakSet<object> };
const states = new WeakMap<object, State>();

function publicIPv4(address: string): boolean {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(address)) return false;
  const [a, b, c, d] = address.split('.').map(Number);
  if ([a, b, c, d].some((part) => part > 255)) return false;
  return !(a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && (b === 0 || b === 168 || (b === 88 && c === 99)))
    || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
    || (a === 203 && b === 0 && c === 113));
}

/** Fixed origin, no redirects/proxy/custom fetch, IPv4 DNS pinning, standard TLS validation. */
class ObservationTransportRefusal extends Error {}

function readResource(state: State, resource: 'workflow' | 'instance', deadline: number): Promise<Buffer> {
  const { config, token } = state;
  const target = config.target;
  const ownerPath = `/client/v4/accounts/${target.account_id}/workflows/${target.workflow_name}`;
  const path = resource === 'workflow' ? ownerPath : `${ownerPath}/instances/${target.instance_id}?simple=true`;
  if (Date.now() >= deadline) return Promise.reject(new ObservationTransportRefusal('Workflow observation exceeded its total DNS/request/body deadline.'));
  return new Promise((resolve, reject) => {
    let settled = false;
    let request: ClientRequest | undefined;
    let response: IncomingMessage | undefined;
    const finish = (error: string | null, body = Buffer.alloc(0)) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) {
        response?.destroy(); request?.destroy(); reject(new ObservationTransportRefusal(error));
      } else resolve(body);
    };
    const timer = setTimeout(() => finish('Workflow observation exceeded its total DNS/request/body deadline.'), Math.max(1, deadline - Date.now()));
    // The deadline includes DNS. A late DNS callback cannot open a request after refusal.
    dns.lookup(API_HOST, { all: true, family: 4 }, (error, addresses) => {
      if (settled) return;
      if (error || !addresses.length || addresses.length > 20
        || addresses.some((entry) => entry.family !== 4 || !publicIPv4(entry.address))) {
        finish('Workflow API DNS resolution is unavailable or outside the public IPv4 boundary.'); return;
      }
      const address = addresses[0].address;
      try {
        request = https.request({
          hostname: API_HOST, port: 443, servername: API_HOST, family: 4,
          method: 'GET', path, agent: false, rejectUnauthorized: true,
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Accept-Encoding': 'identity', 'Cache-Control': 'no-cache' },
          lookup: (_hostname, _options, callback) => callback(null, address, 4),
        }, (incoming) => {
          response = incoming;
          if (settled) { incoming.destroy(); return; }
          const socket = incoming.socket as TLSSocket;
          if (!socket.encrypted || socket.authorized !== true || socket.remoteAddress !== address) {
            finish('Workflow API TLS peer is not authenticated at the pinned address.'); return;
          }
          if (incoming.statusCode !== 200) {
            finish(`Workflow API HTTP ${incoming.statusCode ?? 'unknown'} is inconclusive; no redirect or retry was sent.`); return;
          }
          const type = incoming.headers['content-type'];
          const length = incoming.headers['content-length'];
          const encoding = incoming.headers['content-encoding'];
          if (typeof type !== 'string' || !/^application\/json(?:\s*;|$)/i.test(type)
            || (encoding !== undefined && encoding !== 'identity')
            || (length !== undefined && (!/^\d+$/.test(length) || Number(length) > MAX_RESPONSE_BYTES))) {
            finish('Workflow API content type or declared length is outside the bounded JSON contract.'); return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          incoming.on('data', (chunk: Buffer) => {
            if (settled) return;
            size += chunk.length;
            if (size > MAX_RESPONSE_BYTES) { finish('Workflow API response exceeded the bounded JSON limit.'); return; }
            chunks.push(chunk);
          });
          incoming.on('error', () => finish('Workflow API response failed before complete readback.'));
          incoming.on('aborted', () => finish('Workflow API response was interrupted.'));
          incoming.on('end', () => {
            if (!incoming.complete) finish('Workflow API response was incomplete.');
            else finish(null, Buffer.concat(chunks));
          });
        });
        request.on('error', () => finish('Workflow API request failed; its state remains unknown.'));
        request.end();
      } catch { finish('Workflow API request could not be opened.'); }
    });
  });
}

const refused = (blocker: string): CloudflareWorkflowObservationResult => ({
  observed: false, observation: null, instance_absence_proven: false, blockers: [blocker],
});

/**
 * Construct only in server bootstrap with an account-scoped READ token in
 * STARLIGHT_CLOUDFLARE_OBSERVER_TOKEN. No credentials, endpoint or transport callbacks
 * come from workload JSON. This class can only GET; it never starts, stops or admits work.
 */
export class CloudflareWorkflowObserver {
  constructor(untrustedConfiguration: unknown) {
    const config = configSchema.parse(untrustedConfiguration);
    const token = process.env.STARLIGHT_CLOUDFLARE_OBSERVER_TOKEN;
    if (!token || !/^[A-Za-z0-9_-]{20,200}$/.test(token)) throw new Error('Workflow observer credential is absent or invalid.');
    Object.freeze(config.target); Object.freeze(config);
    states.set(this, { config, token, inFlight: false, issued: new WeakSet() });
    Object.freeze(this);
  }

  isIssuedObservation(input: unknown): input is CloudflareWorkflowObservation {
    const state = states.get(this);
    if (!state || typeof input !== 'object' || input === null || !state.issued.has(input)) return false;
    return Date.parse((input as CloudflareWorkflowObservation).expires_at) > Date.now();
  }

  async observe(untrustedOperation: unknown): Promise<CloudflareWorkflowObservationResult> {
    const state = states.get(this);
    if (!state || !isIssuedCloudflareWorkflowOperation(untrustedOperation)) return refused('Workflow operation context receipt was not issued.');
    if (sha256Digest(untrustedOperation.context.target) !== sha256Digest(state.config.target)) return refused('Workflow operation targets a different server-owned tenant, deployment, version or instance.');
    if (Date.parse(state.config.access_review_expires_at) <= Date.now()) return refused('Workflow observer access review is expired.');
    if (state.inFlight) return refused('Workflow observer already has one bounded request in flight.');
    state.inFlight = true;
    try {
      const deadline = Date.now() + state.config.timeout_ms;
      const decoder = new TextDecoder('utf-8', { fatal: true });
      const workflowRaw = await readResource(state, 'workflow', deadline);
      const workflow = workflowResponseSchema.safeParse(JSON.parse(decoder.decode(workflowRaw)));
      if (!workflow.success || workflow.data.result.id !== state.config.target.workflow_uuid
        || workflow.data.result.name !== state.config.target.workflow_name) {
        return refused('Workflow API identity differs from the server-owned workflow UUID or name.');
      }
      if (Date.parse(state.config.access_review_expires_at) <= Date.now()) return refused('Workflow observer access review expired during identity readback.');
      const raw = await readResource(state, 'instance', deadline);
      const now = Date.now();
      if (Date.parse(state.config.access_review_expires_at) <= now) return refused('Workflow observer access review expired during readback.');
      const parsed = responseSchema.safeParse(JSON.parse(decoder.decode(raw)));
      if (!parsed.success) return refused('Workflow API response does not satisfy its status/version/time contract.');
      const result = parsed.data.result;
      // REST creation encodes params as JSON; readback may return decoded data or its string.
      const params = typeof result.params === 'string' ? JSON.parse(result.params) : result.params;
      if (result.versionId !== state.config.target.version_id
        || sha256Digest(params) !== sha256Digest(cloudflareWorkflowOperationEnvelope(untrustedOperation))) {
        return refused('Workflow API readback differs from the exact version or bound-operation correlation payload.');
      }
      const queued = Date.parse(result.queued);
      const start = result.start ? Date.parse(result.start) : null;
      const end = result.end ? Date.parse(result.end) : null;
      if (queued > now || (start !== null && (start < queued || start > now))
        || (end !== null && (end < (start ?? queued) || end > now))) {
        return refused('Workflow API timestamps are contradictory or from the future.');
      }
      const observation: CloudflareWorkflowObservation = Object.freeze({
        schema_version: 'starlight.cloudflare_workflow_observation.v1', target: state.config.target,
        binding_digest_sha256: sha256Digest(untrustedOperation.binding), credential_ref: state.config.credential_ref,
        response_body_sha256: createHash('sha256').update(raw).digest('hex'),
        workflow_metadata_body_sha256: createHash('sha256').update(workflowRaw).digest('hex'),
        observed_at: new Date(now).toISOString(),
        expires_at: new Date(Math.min(now + OBSERVATION_TTL_MS, Date.parse(state.config.access_review_expires_at))).toISOString(),
        status: result.status, queued_at: new Date(queued).toISOString(),
        started_at: start === null ? null : new Date(start).toISOString(), ended_at: end === null ? null : new Date(end).toISOString(),
        workflow_terminal_observed: end !== null && ['complete', 'errored', 'terminated'].includes(result.status),
        workflow_script_deleted: workflow.data.result.script_deleted ?? null,
        execution_authority_granted: false, descendants_quiesced: false,
        external_effects_settled: false, budget_commitment_released: false,
      });
      state.issued.add(observation);
      return { observed: true, observation, instance_absence_proven: false, blockers: [] };
    } catch (error) {
      return refused(error instanceof ObservationTransportRefusal ? error.message : 'Authenticated workflow readback is unavailable or invalid; the instance state remains unknown.');
    } finally { state.inFlight = false; }
  }
}
