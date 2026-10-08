/**
 * revenue-streams.ts — the portfolio as typed data, with gates and kill
 * criteria, mirroring §6 of the proposal.
 *
 * This file is the registry the founder board reads. It contains no revenue
 * figures: every number is a placeholder the owner sets in `targets`, and the
 * validator refuses a stream that claims a figure without a source.
 *
 * Portfolio rule enforced here: at most three streams in `pilot` at once.
 */

import { z } from 'zod';
import { identifierSchema, workloadClassSchema } from './contract';
import { stageSchema } from './experiments';
import type { StreamId } from '../swarm/escalation';

/** Connectors the estate has decided on (§3.1). Adding one is a board item, not a typo. */
export const KNOWN_CONNECTORS = Object.freeze([
  'anthropic-managed-agents',
  'openai-agents-sdk',
  'gemini-managed-agents',
  'cloudflare-workflows',
  'vercel-workflows',
  'supabase',
  'cloudflare-r2',
  'github',
  'notion',
  'stripe',
  'lemonsqueezy',
  'whop',
  'polar',
  'x402',
  'ap2-verify-only',
  'payments-mcp-verify-only',
  'marine-mcp',
  'seedance-byteplus',
  'fal',
  'higgsfield',
  'kling',
  'veo',
  'suno',
  'youtube',
  'tiktok-symphony',
  'spotify',
  'postiz',
  'resend',
  'linkedin',
  'skool',
  'circle',
  'open-collective',
  'github-sponsors',
] as const);
export type Connector = (typeof KNOWN_CONNECTORS)[number];

const connectorSchema = z.enum(KNOWN_CONNECTORS);

/** A target is a number with a source and a date, or it does not exist. */
export const targetSchema = z
  .object({
    metric: z.string().trim().min(1),
    value: z.number().finite(),
    unit: z.string().trim().min(1),
    source: z.string().trim().min(1),
    setOn: z.string().refine((value) => !Number.isNaN(Date.parse(value)), 'must be a date'),
  })
  .strict();

export const revenueStreamSchema = z
  .object({
    id: identifierSchema,
    name: z.string().trim().min(1),
    /** Which swarm stream governs its escalation. */
    swarmStream: z.enum(['affiliate', 'products', 'content', 'payments']),
    mechanism: z.string().trim().min(1),
    recurring: z.boolean(),
    connectors: z.array(connectorSchema).min(1),
    /** The workload classes this stream's agents run under. */
    workloads: z.array(workloadClassSchema).min(1),
    stage: stageSchema,
    promotionGate: z.string().trim().min(1),
    killCriterion: z.string().trim().min(1),
    experimentIds: z.array(identifierSchema).default([]),
    owner: identifierSchema,
    /** Owner-set figures. Empty until Frank sets them. Never invented here. */
    targets: z.array(targetSchema).default([]),
  })
  .strict();
export type RevenueStream = z.output<typeof revenueStreamSchema>;
export type RevenueStreamInput = z.input<typeof revenueStreamSchema>;

export const MAX_PILOTS = 3;

/** The portfolio as proposed on 2026-10-08. Stages start at dry-run; the board moves them. */
export const REVENUE_STREAMS: readonly RevenueStreamInput[] = Object.freeze([
  {
    id: 'R1',
    name: 'Estate commissioning',
    swarmStream: 'products',
    mechanism: 'Full Mind plus Mesh plus Steward build for one principal or alliance under a SOW, Pilot to Standing.',
    recurring: false,
    connectors: ['anthropic-managed-agents', 'cloudflare-workflows', 'github', 'stripe'],
    workloads: ['architecture', 'long-horizon-build', 'board-review'],
    stage: 'shadow',
    promotionGate: 'One signed SOW with named pilot roles.',
    killCriterion: 'No signed SOW within 90 days of the first three qualified conversations.',
    owner: 'general-ceo',
  },
  {
    id: 'R2',
    name: 'Steward retainer',
    swarmStream: 'products',
    mechanism: 'Monthly operations, evolution, and access on a running estate.',
    recurring: true,
    connectors: ['anthropic-managed-agents', 'github', 'stripe', 'notion'],
    workloads: ['repo-steward', 'scheduled-deliverable'],
    stage: 'dry-run',
    promotionGate: 'One estate at Standing.',
    killCriterion: 'Retainer churns before month three.',
    owner: 'general-coo',
  },
  {
    id: 'R3',
    name: 'Agentic OS installs',
    swarmStream: 'products',
    mechanism: 'Evaluated installs of agentic-business-os and siblings: template plus packs plus downstream registry.',
    recurring: false,
    connectors: ['github', 'stripe'],
    workloads: ['tool-orchestration', 'long-horizon-build'],
    stage: 'shadow',
    promotionGate: 'Second registered downstream beyond the first.',
    killCriterion: 'Fewer than two installs by Q1 2027.',
    owner: 'general-cpo',
  },
  {
    id: 'R4',
    name: 'GenCreator Companion',
    swarmStream: 'products',
    mechanism: 'Source to Creator Mission to review to export; the CreatorPack is the product unit.',
    recurring: true,
    connectors: ['supabase', 'vercel-workflows', 'anthropic-managed-agents', 'lemonsqueezy'],
    workloads: ['tool-orchestration', 'volume-creator-work'],
    stage: 'dry-run',
    promotionGate: 'Companion alpha gates pass; merchant of record chosen.',
    killCriterion: 'Companion alpha fails its own ADR-010 gates.',
    owner: 'gencreator-product-lead',
  },
  {
    id: 'R5',
    name: 'Media production engine',
    swarmStream: 'content',
    mechanism: 'Shorts, lyric videos, cinematic reels from the catalog and the research hub; ad revenue, sync, sponsorship.',
    recurring: true,
    connectors: ['seedance-byteplus', 'fal', 'higgsfield', 'kling', 'veo', 'suno', 'youtube', 'tiktok-symphony', 'spotify', 'cloudflare-r2'],
    workloads: ['volume-creator-work', 'tool-orchestration'],
    stage: 'dry-run',
    promotionGate: 'Twelve weeks of weekly output with receipts; first sync or sponsorship inquiry logged.',
    killCriterion: 'Output cadence breaks for four consecutive weeks.',
    owner: 'visual-design-gods',
  },
  {
    id: 'R6',
    name: 'Metered agent services',
    swarmStream: 'payments',
    mechanism: 'MCP endpoints and APIs sold per call to agents; x402 pay-per-call, API keys for Web2.',
    recurring: true,
    connectors: ['marine-mcp', 'payments-mcp-verify-only', 'cloudflare-workflows', 'x402', 'ap2-verify-only'],
    workloads: ['sandbox-research', 'bulk-extraction'],
    stage: 'dry-run',
    promotionGate: 'One external agent paying per call in a pilot.',
    killCriterion: 'No external caller within 60 days of the pilot going live.',
    owner: 'general-cto',
  },
  {
    id: 'R7',
    name: 'Memberships and retreats',
    swarmStream: 'content',
    mechanism: 'GenCreator community, Vibeclubs formats, co-creation retreats.',
    recurring: true,
    connectors: ['whop', 'skool', 'circle', 'resend'],
    workloads: ['customer-chat', 'volume-creator-work'],
    stage: 'dry-run',
    promotionGate: 'Cohort filled with delivery evidence complete.',
    killCriterion: 'Cohort under minimum viable size.',
    owner: 'community-fabric-orchestrator',
  },
  {
    id: 'R8',
    name: 'Digital products and templates',
    swarmStream: 'products',
    mechanism: 'Prompt library, packs, courses, books.',
    recurring: false,
    connectors: ['lemonsqueezy', 'github', 'resend'],
    workloads: ['volume-creator-work', 'classification'],
    stage: 'shadow',
    promotionGate: 'Product page passes integrity guard.',
    killCriterion: 'Under threshold units in 90 days (owner sets the threshold).',
    owner: 'product-engine-orchestrator',
  },
  {
    id: 'R9',
    name: 'Agentic income network',
    swarmStream: 'affiliate',
    mechanism: 'Affiliate comparison engine, bound links, scheduled posts under the queen gate.',
    recurring: true,
    connectors: ['postiz', 'github', 'linkedin'],
    workloads: ['research-scan', 'classification'],
    stage: 'dry-run',
    promotionGate: 'Affiliate queen at Pilot.',
    killCriterion: 'Payout below the stream cap for two quarters.',
    owner: 'general-cmo',
  },
  {
    id: 'R10',
    name: 'Capital and deal intelligence',
    swarmStream: 'payments',
    mechanism: 'Advisory and co-investment theses for principals on Wealth IS and Investment IS; never custody, never money movement.',
    recurring: true,
    connectors: ['notion', 'github', 'stripe'],
    workloads: ['board-review', 'research-scan'],
    stage: 'dry-run',
    promotionGate: 'One principal retains the thesis service.',
    killCriterion: 'Thesis service produces no decision the principal acts on in two quarters.',
    owner: 'general-cfo',
  },
]);

export interface PortfolioReport {
  ok: boolean;
  streams: RevenueStream[];
  pilots: string[];
  problems: string[];
}

/** Validate a portfolio: schema, unique ids, pilot cap, and no figure without a source. */
export function validatePortfolio(inputs: readonly RevenueStreamInput[] = REVENUE_STREAMS): PortfolioReport {
  const problems: string[] = [];
  const streams: RevenueStream[] = [];
  const seen = new Set<string>();

  for (const input of inputs) {
    const parsed = revenueStreamSchema.safeParse(input);
    if (!parsed.success) {
      problems.push(`${String((input as { id?: unknown }).id ?? '?')}: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`);
      continue;
    }
    if (seen.has(parsed.data.id)) {
      problems.push(`${parsed.data.id}: duplicate id`);
      continue;
    }
    seen.add(parsed.data.id);
    streams.push(parsed.data);
  }

  const pilots = streams.filter((stream) => stream.stage === 'pilot').map((stream) => stream.id);
  if (pilots.length > MAX_PILOTS) {
    problems.push(`${pilots.length} streams in pilot; the portfolio rule allows ${MAX_PILOTS}.`);
  }

  return { ok: problems.length === 0, streams, pilots, problems };
}

/** Map a revenue stream to the swarm stream id its escalation runs under. */
export function swarmStreamOf(stream: RevenueStream): StreamId {
  return stream.swarmStream;
}
