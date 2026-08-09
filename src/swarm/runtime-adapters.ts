import { z } from 'zod';

import { computePlanDigest } from './runtime-admission';
import { sha256Digest } from './runtime-digest';
import { parseTeamRuntimePlan } from './runtime-plan-contract';
import type { RuntimeId, TeamRuntimePlan } from './runtime-planner';
import {
  isIssuedTeamPackVerificationResult,
  type TeamPackVerificationResult,
} from './team-pack-verifier';

export type PreparedLaneStatus = 'prepared-human-approval-required';

interface CommonPreparedLane {
  schema_version: 'starlight.prepared_runtime_lane.v1';
  deployment_id: string;
  team_id: string;
  lane_id: string;
  role_id: string;
  runtime: RuntimeId;
  status: PreparedLaneStatus;
  plan_digest_sha256: string;
  pack_digest_sha256: string;
  runtime_policy_digest_sha256: string;
  max_concurrency: 1;
  lease_ttl_seconds: 900;
  heartbeat_timeout_seconds: 120;
  kill_switch: string;
  activation_authority: 'trusted-server-internal-authority-not-implemented';
  required_secret_names: string[];
}

export type PreparedRuntimeLane = CommonPreparedLane & {
  runtime_config:
    | {
        kind: 'railway-temporal';
        deployment_target: 'existing-railway-service';
        task_queue: string;
        workflow_id_prefix: string;
        canonical_state: 'sis-postgres';
      }
    | {
        kind: 'vercel-eve';
        deployment_target: 'existing-vercel-project';
        workflow_route: '/api/eve';
        tool_grants: [];
        write_scopes: [];
        canonical_state: 'read-only-projection';
      }
    | {
        kind: 'hermes-local';
        deployment_target: 'isolated-hermes-profile';
        profile: 'starlight-team-worker';
        canonical_state: 'sis-postgres';
      }
    | {
        kind: 'n8n-integration';
        deployment_target: 'existing-n8n-service';
        workflow_tag: string;
        canonical_state: 'event-connector-only';
      };
};

export interface PreparedRuntimeBundle {
  schema_version: 'starlight.prepared_runtime_bundle.v1';
  team_id: string;
  generated_at: string;
  status: PreparedLaneStatus;
  plan_digest_sha256: string;
  source_profile_digest_sha256: string;
  source_runtime_policy_digest_sha256: string;
  pack_digest_sha256: string;
  lanes: PreparedRuntimeLane[];
  blockers: [
    'Trusted server-internal activation authority is not implemented.',
    'Infrastructure mutation requires fresh health, capacity, access, budget, and human approval receipts.',
  ];
}

const healthEndpointSchema = z
  .string()
  .url()
  .superRefine((value, context) => {
    const url = new URL(value);
    const loopback = ['127.0.0.1', '[::1]'].includes(url.hostname);
    if (!loopback) {
      context.addIssue({
        code: 'custom',
        message: 'Health endpoint must use a literal loopback address; remote and named hosts are disabled.',
      });
    }
    if (!['http:', 'https:'].includes(url.protocol)) {
      context.addIssue({ code: 'custom', message: 'Loopback health endpoints must use HTTP or HTTPS.' });
    }
    if (url.username || url.password || url.search || url.hash) {
      context.addIssue({ code: 'custom', message: 'Health endpoint URLs cannot embed auth, query, or fragment data.' });
    }
    if (url.pathname !== '/health') {
      context.addIssue({ code: 'custom', message: 'Health endpoint must use the exact /health path.' });
    }
  });

const preparedDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const preparedIdSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]*$/);
const runtimeConfigSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('railway-temporal'),
    deployment_target: z.literal('existing-railway-service'),
    task_queue: z.string().min(1),
    workflow_id_prefix: z.string().min(1),
    canonical_state: z.literal('sis-postgres'),
  }).strict(),
  z.object({
    kind: z.literal('vercel-eve'),
    deployment_target: z.literal('existing-vercel-project'),
    workflow_route: z.literal('/api/eve'),
    tool_grants: z.tuple([]),
    write_scopes: z.tuple([]),
    canonical_state: z.literal('read-only-projection'),
  }).strict(),
  z.object({
    kind: z.literal('hermes-local'),
    deployment_target: z.literal('isolated-hermes-profile'),
    profile: z.literal('starlight-team-worker'),
    canonical_state: z.literal('sis-postgres'),
  }).strict(),
  z.object({
    kind: z.literal('n8n-integration'),
    deployment_target: z.literal('existing-n8n-service'),
    workflow_tag: z.string().min(1),
    canonical_state: z.literal('event-connector-only'),
  }).strict(),
]);
const preparedLaneSchema = z.object({
  schema_version: z.literal('starlight.prepared_runtime_lane.v1'),
  deployment_id: preparedIdSchema,
  team_id: preparedIdSchema,
  lane_id: preparedIdSchema,
  role_id: preparedIdSchema,
  runtime: z.enum(['railway-temporal', 'vercel-eve', 'hermes-local', 'n8n-integration']),
  status: z.literal('prepared-human-approval-required'),
  plan_digest_sha256: preparedDigestSchema,
  pack_digest_sha256: preparedDigestSchema,
  runtime_policy_digest_sha256: preparedDigestSchema,
  max_concurrency: z.literal(1),
  lease_ttl_seconds: z.literal(900),
  heartbeat_timeout_seconds: z.literal(120),
  kill_switch: z.string().regex(/^STARLIGHT_KILL_[A-Z0-9_]+$/),
  activation_authority: z.literal('trusted-server-internal-authority-not-implemented'),
  required_secret_names: z.array(z.string().regex(/^[A-Z][A-Z0-9_]+$/)),
  runtime_config: runtimeConfigSchema,
}).strict().superRefine((lane, context) => {
  if (lane.runtime !== lane.runtime_config.kind) {
    context.addIssue({ code: 'custom', message: 'Prepared lane runtime and runtime_config kind must match.' });
  }
  if (new Set(lane.required_secret_names).size !== lane.required_secret_names.length) {
    context.addIssue({ code: 'custom', message: 'Prepared lane secret names must be unique.' });
  }
});
const preparedRuntimeBundleSchema = z.object({
  schema_version: z.literal('starlight.prepared_runtime_bundle.v1'),
  team_id: preparedIdSchema,
  generated_at: z.string().datetime({ offset: true }),
  status: z.literal('prepared-human-approval-required'),
  plan_digest_sha256: preparedDigestSchema,
  source_profile_digest_sha256: preparedDigestSchema,
  source_runtime_policy_digest_sha256: preparedDigestSchema,
  pack_digest_sha256: preparedDigestSchema,
  lanes: z.array(preparedLaneSchema).min(3).max(5),
  blockers: z.tuple([
    z.literal('Trusted server-internal activation authority is not implemented.'),
    z.literal('Infrastructure mutation requires fresh health, capacity, access, budget, and human approval receipts.'),
  ]),
}).strict().superRefine((bundle, context) => {
  const unique = (values: string[], message: string) => {
    if (new Set(values).size !== values.length) context.addIssue({ code: 'custom', message });
  };
  unique(bundle.lanes.map((lane) => lane.lane_id), 'Prepared lane ids must be unique.');
  unique(bundle.lanes.map((lane) => lane.role_id), 'Prepared role ids must be unique.');
  unique(bundle.lanes.map((lane) => lane.deployment_id), 'Prepared deployment ids must be unique.');
  unique(bundle.lanes.map((lane) => lane.kill_switch), 'Prepared kill switches must be unique.');
  for (const lane of bundle.lanes) {
    if (
      lane.team_id !== bundle.team_id ||
      lane.plan_digest_sha256 !== bundle.plan_digest_sha256 ||
      lane.pack_digest_sha256 !== bundle.pack_digest_sha256 ||
      lane.runtime_policy_digest_sha256 !== bundle.source_runtime_policy_digest_sha256
    ) {
      context.addIssue({ code: 'custom', message: 'Prepared lane authority bindings must match its bundle.' });
    }
  }
});

export interface RuntimeHealthProbeResult {
  endpoint_origin: string;
  observed_at: string;
  status: 'ready' | 'degraded' | 'offline';
  http_status: number | null;
  detail: string;
}

function slug(value: string): string {
  return value.replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

function identitySegment(value: string): string {
  return `${slug(value)}-${sha256Digest(value).slice(0, 24)}`;
}

function killSwitch(laneId: string): string {
  const readable = laneId.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  return `STARLIGHT_KILL_${readable}_${sha256Digest(laneId).slice(0, 24).toUpperCase()}`;
}

function commonLane(
  plan: TeamRuntimePlan,
  lane: TeamRuntimePlan['lanes'][number],
  verification: TeamPackVerificationResult,
): CommonPreparedLane {
  const planDigest = computePlanDigest(plan);
  return {
    schema_version: 'starlight.prepared_runtime_lane.v1',
    deployment_id: `${identitySegment(plan.team_id)}-${identitySegment(lane.id)}-${planDigest.slice(0, 12)}`,
    team_id: plan.team_id,
    lane_id: lane.id,
    role_id: lane.role_id,
    runtime: lane.runtime,
    status: 'prepared-human-approval-required',
    plan_digest_sha256: planDigest,
    pack_digest_sha256: verification.pack_digest_sha256,
    runtime_policy_digest_sha256: plan.routing_policy.policy_digest_sha256,
    max_concurrency: 1,
    lease_ttl_seconds: 900,
    heartbeat_timeout_seconds: 120,
    kill_switch: killSwitch(lane.id),
    activation_authority: 'trusted-server-internal-authority-not-implemented',
    required_secret_names: [],
  };
}

function prepareLane(
  plan: TeamRuntimePlan,
  lane: TeamRuntimePlan['lanes'][number],
  verification: TeamPackVerificationResult,
): PreparedRuntimeLane {
  const common = commonLane(plan, lane, verification);
  const identity = `${identitySegment(plan.team_id)}-${identitySegment(lane.id)}`;

  switch (lane.runtime) {
    case 'railway-temporal':
      return {
        ...common,
        required_secret_names: ['TEMPORAL_ADDRESS', 'TEMPORAL_NAMESPACE', 'DATABASE_URL'],
        runtime_config: {
          kind: 'railway-temporal',
          deployment_target: 'existing-railway-service',
          task_queue: `starlight-${identity}`,
          workflow_id_prefix: `starlight/${identity}/${common.plan_digest_sha256.slice(0, 12)}`,
          canonical_state: 'sis-postgres',
        },
      };
    case 'vercel-eve':
      return {
        ...common,
        required_secret_names: ['AI_GATEWAY_API_KEY'],
        runtime_config: {
          kind: 'vercel-eve',
          deployment_target: 'existing-vercel-project',
          workflow_route: '/api/eve',
          tool_grants: [],
          write_scopes: [],
          canonical_state: 'read-only-projection',
        },
      };
    case 'hermes-local':
      return {
        ...common,
        required_secret_names: [],
        runtime_config: {
          kind: 'hermes-local',
          deployment_target: 'isolated-hermes-profile',
          profile: 'starlight-team-worker',
          canonical_state: 'sis-postgres',
        },
      };
    case 'n8n-integration':
      return {
        ...common,
        required_secret_names: ['N8N_BASE_URL', 'N8N_API_KEY'],
        runtime_config: {
          kind: 'n8n-integration',
          deployment_target: 'existing-n8n-service',
          workflow_tag: `starlight:${identity}`,
          canonical_state: 'event-connector-only',
        },
      };
    case 'cloudflare-agents':
      throw new Error('Cloudflare Agents is deferred and has no admitted deployment adapter.');
    default:
      throw new Error(`Unknown runtime adapter: ${String(lane.runtime)}`);
  }
}

export function prepareRuntimeBundle(
  untrustedPlan: unknown,
  verification: TeamPackVerificationResult,
): PreparedRuntimeBundle {
  if (!isIssuedTeamPackVerificationResult(verification)) {
    throw new Error('Pack verification receipt was not issued by the team-pack verifier.');
  }
  const plan = parseTeamRuntimePlan(untrustedPlan);
  const planDigest = computePlanDigest(plan);
  if (
    verification.team_id !== plan.team_id ||
    verification.plan_digest_sha256 !== planDigest ||
    verification.source_profile_digest_sha256 !== plan.source_profile.sha256 ||
    verification.source_runtime_policy_digest_sha256 !==
      plan.routing_policy.policy_digest_sha256
  ) {
    throw new Error('Verified pack receipt does not bind the exact runtime plan, profile, and policy.');
  }

  return {
    schema_version: 'starlight.prepared_runtime_bundle.v1',
    team_id: plan.team_id,
    generated_at: plan.generated_at,
    status: 'prepared-human-approval-required',
    plan_digest_sha256: planDigest,
    source_profile_digest_sha256: plan.source_profile.sha256,
    source_runtime_policy_digest_sha256: plan.routing_policy.policy_digest_sha256,
    pack_digest_sha256: verification.pack_digest_sha256,
    lanes: plan.lanes.map((lane) => prepareLane(plan, lane, verification)),
    blockers: [
      'Trusted server-internal activation authority is not implemented.',
      'Infrastructure mutation requires fresh health, capacity, access, budget, and human approval receipts.',
    ],
  };
}

export function parsePreparedRuntimeBundle(input: unknown): PreparedRuntimeBundle {
  const result = preparedRuntimeBundleSchema.safeParse(input);
  if (!result.success) {
    throw new Error(`Invalid prepared runtime bundle: ${result.error.message}`);
  }
  return result.data as PreparedRuntimeBundle;
}

export function verifyPreparedRuntimeBundle(
  input: unknown,
  untrustedPlan: unknown,
  verification: TeamPackVerificationResult,
): PreparedRuntimeBundle {
  const parsed = parsePreparedRuntimeBundle(input);
  const canonical = prepareRuntimeBundle(untrustedPlan, verification);
  if (sha256Digest(parsed) !== sha256Digest(canonical)) {
    throw new Error('Prepared runtime bundle does not match the canonical derived bundle.');
  }
  return parsed;
}

export async function probeRuntimeHealth(
  untrustedEndpoint: string,
  observedAt = new Date().toISOString(),
  fetcher: typeof fetch = fetch,
): Promise<RuntimeHealthProbeResult> {
  const endpoint = healthEndpointSchema.parse(untrustedEndpoint);
  const parsed = new URL(endpoint);
  const endpointOrigin = parsed.origin;

  try {
    const response = await fetcher(endpoint, {
      method: 'GET',
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(5_000),
    });
    const body = (await response.json()) as { ok?: unknown; status?: unknown };
    const ready = response.ok && body.ok === true && body.status === 'ready';
    return {
      endpoint_origin: endpointOrigin,
      observed_at: observedAt,
      status: ready ? 'ready' : 'degraded',
      http_status: response.status,
      detail: ready ? 'Bounded health contract passed.' : 'Health contract did not report ok=true,status=ready.',
    };
  } catch (error) {
    return {
      endpoint_origin: endpointOrigin,
      observed_at: observedAt,
      status: 'offline',
      http_status: null,
      detail: error instanceof Error ? error.name : 'Health probe failed.',
    };
  }
}
