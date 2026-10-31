/**
 * receipts.ts — the sealed record every run leaves behind.
 *
 * A receipt is what makes the estate's moat compound: provider, model, usage,
 * cost, completion, and what the run composed under SIP, hashed and frozen.
 * The digest covers every field except itself, over canonical JSON (sorted
 * keys), so two independent writers produce the same digest for the same run.
 *
 * The attestation is a declared label. A verifiable claim needs a signed
 * receipt (the proposed SIP graph extension). This module does not sign.
 */

import { createHash } from 'node:crypto';
import { runReceiptSchema, RUN_RECEIPT_SCHEMA_VERSION } from './contract';
import type { Attestation, RunReceipt } from './contract';

/** Canonical JSON: object keys sorted recursively, arrays in order, no whitespace. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      out[key] = sortKeys(source[key]);
    }
    return out;
  }
  return value;
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** What the runtime always composes; adapters add the provider-specific element. */
export const BASE_COMPOSED: readonly string[] = Object.freeze([
  'SIP sovereignty clause (verify-only money plane)',
  'starlight-swarm escalation spine',
  'starlight managed-runtime contract v0',
]);

export function attestation(extraComposed: readonly string[] = []): Attestation {
  const composed = Array.from(new Set([...BASE_COMPOSED, ...extraComposed]));
  return { builtOnSip: true, substrate: 'SIP', composed };
}

export type ReceiptDraft = Omit<RunReceipt, 'schemaVersion' | 'digest' | 'attestation'> & {
  composed?: readonly string[];
};

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value as object)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

/** Build, validate, hash, and freeze a receipt. */
export function sealReceipt(draft: ReceiptDraft): RunReceipt {
  const { composed, ...rest } = draft;
  const unsigned = {
    ...rest,
    schemaVersion: RUN_RECEIPT_SCHEMA_VERSION,
    attestation: attestation(composed ?? []),
  };
  const digest = sha256Hex(canonicalJson(unsigned));
  const receipt = runReceiptSchema.parse({ ...unsigned, digest });
  return deepFreeze(receipt);
}

/** True when the receipt validates and its digest matches its content. */
export function verifyReceipt(candidate: unknown): candidate is RunReceipt {
  const parsed = runReceiptSchema.safeParse(candidate);
  if (!parsed.success) return false;
  const { digest, ...unsigned } = parsed.data;
  return sha256Hex(canonicalJson(unsigned)) === digest;
}
