import { z } from 'zod';

import { parseHandContract } from './hand-contract';
import type { HandContract } from './hand-contract';

const OPENFANG_READ_ONLY_TOOLS = new Set([
  'web_search',
  'web_fetch',
  'knowledge_query',
  'knowledge_add_entity',
  'knowledge_add_relation',
  'memory_recall',
]);

export interface CompiledOpenFangHand {
  hand_id: string;
  execution_mode: 'reactive' | 'continuous';
  toml: string;
  source_contract: HandContract;
}

const admissionEnvironmentSchema = z
  .object({
    action: z.enum(['single-run', 'enable-schedule']),
    free_gib: z.number().nonnegative(),
    available_memory_gib: z.number().nonnegative(),
    checksum_verified: z.boolean(),
    defender_detections: z.number().int().nonnegative(),
    publisher_signed: z.boolean(),
    credential_strategy: z.enum(['isolated-pilot', 'none', 'primary-profile']),
    runtime_process_owned: z.boolean(),
    port_available: z.boolean(),
    equivalent_schedule_count: z.number().int().nonnegative(),
    adapter_preserves_denies: z.boolean(),
    canonical_memory_writes: z.boolean(),
    evidence_observed_at: z.string().datetime().optional(),
  })
  .strict();

export type AdmissionEnvironment = z.infer<typeof admissionEnvironmentSchema>;

export interface HandAdmissionDecision {
  admitted: boolean;
  action: AdmissionEnvironment['action'];
  blockers: string[];
  warnings: string[];
}

export function validateAdmissionFreshness(observedAt: string, now: string): { fresh: boolean; reason: string } {
  const observedMs = Date.parse(observedAt);
  const nowMs = Date.parse(now);
  if (Number.isNaN(observedMs) || Number.isNaN(nowMs)) {
    return { fresh: false, reason: 'Admission evidence must use valid ISO timestamps.' };
  }
  if (nowMs - observedMs > 15 * 60 * 1000) {
    return { fresh: false, reason: 'Admission evidence is older than 15 minutes.' };
  }
  if (observedMs - nowMs > 5 * 60 * 1000) {
    return { fresh: false, reason: 'Admission evidence is more than five minutes in the future.' };
  }
  return { fresh: true, reason: 'Admission evidence is fresh.' };
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlArray(values: string[]): string {
  return `[${values.map(tomlString).join(', ')}]`;
}

function buildSystemPrompt(hand: HandContract): string {
  const doneWhen = hand.mission.done_when.map((condition) => `- ${condition}`).join('\n');
  return [
    'You are a bounded Starlight Hand running under Starlight Queen governance.',
    `Mission: ${hand.mission.outcome}`,
    'You are reactive: run exactly once for each explicit invocation and never create a schedule.',
    'Use only the declared tool allowlist. Do not attempt any unlisted capability.',
    'Treat OpenFang memory as temporary working state. SIS remains the only canonical authority.',
    'Return a source-backed graph projection in your final response; do not publish or send it.',
    'Every graph relation must include a public source URL and confidence from 0 to 1.',
    'Complete the phases in order: recover, plan, collect, cross-check, graph, verify, receipt.',
    'Done conditions:',
    doneWhen,
  ].join('\n\n');
}

export function compileOpenFangHand(input: unknown): CompiledOpenFangHand {
  const hand = parseHandContract(input);
  if (hand.runtime !== 'openfang-sidecar') {
    throw new Error(`runtime must be openfang-sidecar, received ${hand.runtime}`);
  }

  const unsupported = hand.capabilities.tools.filter(
    (tool) => !OPENFANG_READ_ONLY_TOOLS.has(tool),
  );
  if (unsupported.length > 0) {
    throw new Error(`unsupported OpenFang tools: ${unsupported.join(', ')}`);
  }

  const prompt = buildSystemPrompt(hand);
  const lines = [
    `id = ${tomlString(hand.id)}`,
    `name = ${tomlString(`Starlight ${hand.id}`)}`,
    `description = ${tomlString(hand.mission.outcome)}`,
    'category = "data"',
    'icon = "🔬"',
    `tools = ${tomlArray(hand.capabilities.tools)}`,
    'skills = ["starlight-hand-read-only"]',
    'mcp_servers = ["starlight-deny-all-mcp"]',
    '',
    '[[settings]]',
    'key = "target_subject"',
    'label = "Target Subject"',
    'description = "Public subject for this bounded research run"',
    'setting_type = "text"',
    'default = "autonomous agent runtimes"',
    '',
    '[agent]',
    `name = ${tomlString(hand.id)}`,
    `description = ${tomlString(hand.mission.outcome)}`,
    'module = "builtin:chat"',
    'provider = "default"',
    'model = "default"',
    'max_tokens = 8192',
    'temperature = 0.2',
    `system_prompt = ${tomlString(prompt)}`,
    '',
  ];

  // Deliberately omit max_iterations. OpenFang v0.6.9 converts any Hand with
  // max_iterations into an hourly Continuous agent and auto-approves Hand tools.
  return {
    hand_id: hand.id,
    execution_mode: 'reactive',
    toml: lines.join('\n'),
    source_contract: hand,
  };
}

export function assessHandAdmission(
  handInput: unknown,
  compiled: CompiledOpenFangHand,
  environmentInput: unknown,
  now = new Date().toISOString(),
): HandAdmissionDecision {
  const hand = parseHandContract(handInput);
  const environment = admissionEnvironmentSchema.parse(environmentInput);
  const blockers: string[] = [];
  const warnings: string[] = [];

  if (!environment.evidence_observed_at) {
    blockers.push('Admission evidence_observed_at is required.');
  } else {
    const freshness = validateAdmissionFreshness(environment.evidence_observed_at, now);
    if (!freshness.fresh) blockers.push(freshness.reason);
  }

  if (!hand.enabled) blockers.push('Hand contract has enabled=false; activation must be explicit.');
  if (compiled.execution_mode !== 'reactive') {
    blockers.push('OpenFang pilot Hands must remain reactive, never Continuous.');
  }
  if (compiled.hand_id !== hand.id) blockers.push('Compiled Hand ID does not match its contract.');
  if (environment.free_gib < 80) blockers.push('At least 80 GiB free disk is required.');
  if (environment.available_memory_gib < 8) {
    blockers.push('Available memory is below the 8 GiB admission floor.');
  }
  if (!environment.checksum_verified) blockers.push('OpenFang release checksum is not verified.');
  if (environment.defender_detections > 0) {
    blockers.push('Microsoft Defender reported a detection for the OpenFang binary.');
  }
  if (environment.credential_strategy !== 'isolated-pilot') {
    blockers.push(
      `Credential strategy ${environment.credential_strategy} is forbidden; use isolated-pilot credentials.`,
    );
  }
  if (!environment.runtime_process_owned) blockers.push('Runtime process ownership is not proven.');
  if (!environment.port_available) blockers.push('The isolated sidecar port is unavailable.');
  if (environment.equivalent_schedule_count > 0) {
    blockers.push('An equivalent schedule already exists; do not create a duplicate scheduler.');
  }
  if (!environment.adapter_preserves_denies) {
    blockers.push('The runtime adapter does not preserve every contract deny capability.');
  }
  if (environment.canonical_memory_writes) {
    blockers.push('OpenFang requested canonical memory writes; SIS must remain authoritative.');
  }
  if (environment.action === 'enable-schedule' && hand.schedule.every_minutes < 1440) {
    blockers.push('The OpenFang pilot schedule must be daily or slower.');
  }
  if (!environment.publisher_signed) {
    warnings.push('OpenFang v0.6.9 is not Authenticode-signed; retain checksum and Defender evidence.');
  }

  return {
    admitted: blockers.length === 0,
    action: environment.action,
    blockers,
    warnings,
  };
}
