/**
 * receipts.ts — one signed receipt per dispatch, in the format the estate
 * already verifies: starlight.run-receipt.v1 (run-receipt.ts, vendored
 * byte-identical from the Starlight Intelligence System).
 *
 * This module is the thin layer between a dispatch and that format. It
 *   - drafts a RunReceipt from a Brief, the route the router chose, the stages
 *     that ran, the gate decisions, and the evidence;
 *   - carries the router's answer (usedModel / wasFallback / reason) in the
 *     stage records, so every receipt says which model actually ran;
 *   - issues it only through signRunReceipt(), which refuses an incomplete
 *     receipt, and never writes PASS without evidence;
 *   - appends one JSON line per envelope to a ledger (append-only by shape).
 *
 * Nothing here decides anything. A receipt records; the verifier credits.
 */

import { createHash } from 'node:crypto';
import type { Brief } from './brief';
import type { RouteResult } from './router';
import type { DsseEnvelope, RunReceipt, RunReceiptDecision, RunReceiptEvidence, RunReceiptStage } from './run-receipt';
import { RUN_RECEIPT_SCHEMA, receiptProblems, signRunReceipt, totalsFromStages, verdictFromStages, verifyRunReceipt } from './run-receipt';

export const DISPATCH_RUN_KIND = 'queen.dispatch';

export interface DispatchRecord {
  brief: Brief;
  route: RouteResult;
  /** Machine or runtime that ran the dispatch. */
  host: string;
  startedAt: string;
  endedAt: string;
  /** The artifact the dispatch produced, named and digested. */
  subject: { name: string; sha256: string };
  stages: RunReceiptStage[];
  decisions?: RunReceiptDecision[];
  evidence: RunReceiptEvidence[];
  issuer: string;
  correlationId?: string;
}

export function sha256Of(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}

/** A deterministic receipt id from the brief, subject and end time. */
export function dispatchReceiptId(record: Pick<DispatchRecord, 'brief' | 'subject' | 'endedAt'>): string {
  return `rcpt_${sha256Of(`${record.brief.id}\n${record.subject.sha256}\n${record.endedAt}`).slice(0, 24)}`;
}

/**
 * The route stage: a stage record that carries the router's answer. Placed
 * first so a reader sees which model ran before reading what it produced.
 */
export function routeStage(route: RouteResult): RunReceiptStage {
  return {
    name: 'route',
    status: route.refused ? 'failed' : 'ok',
    ...(route.usedModel ? { model: route.usedModel } : {}),
    note: `${route.reason}${route.wasFallback ? ' [fallback]' : ''}`,
  };
}

/** Draft the receipt. Does not sign; does not hide problems — receiptProblems() still applies. */
export function draftDispatchReceipt(record: DispatchRecord, issuedAt: string = record.endedAt): RunReceipt {
  const stages = [routeStage(record.route), ...record.stages];
  return {
    schema: RUN_RECEIPT_SCHEMA,
    receiptId: dispatchReceiptId(record),
    issuedAt,
    issuer: { name: record.issuer },
    run: {
      id: record.brief.id,
      kind: DISPATCH_RUN_KIND,
      host: record.host,
      startedAt: record.startedAt,
      endedAt: record.endedAt,
      ...(record.correlationId ? { correlationId: record.correlationId } : {}),
    },
    subject: { name: record.subject.name, digest: { sha256: record.subject.sha256 } },
    stages,
    totals: totalsFromStages(stages),
    decisions: record.decisions ?? [],
    evidence: record.evidence,
    verdict: verdictFromStages(stages),
  };
}

export interface IssuedReceipt {
  receipt: RunReceipt;
  envelope: DsseEnvelope;
}

/** Draft and sign in one step. Throws with every problem when the draft is incomplete. */
export function issueDispatchReceipt(record: DispatchRecord, privateKeyPem: string, issuedAt?: string): IssuedReceipt {
  const receipt = draftDispatchReceipt(record, issuedAt);
  const problems = receiptProblems(receipt);
  if (problems.length) throw new Error(`refusing to issue dispatch receipt: ${problems.join('; ')}`);
  return { receipt, envelope: signRunReceipt(receipt, privateKeyPem) };
}

/** One envelope, one line. The ledger is JSONL and only ever grows. */
export function ledgerLine(envelope: DsseEnvelope): string {
  return JSON.stringify(envelope) + '\n';
}

export interface LedgerEntry {
  line: number;
  envelope: DsseEnvelope | null;
  ok: boolean;
  reasons: string[];
  receipt: RunReceipt | null;
}

/** Verify every line of a ledger against trusted keys. A bad line is reported, never skipped. */
export function verifyLedger(text: string, trustedPublicKeys: string[]): LedgerEntry[] {
  const entries: LedgerEntry[] = [];
  text.split('\n').forEach((raw, i) => {
    if (!raw.trim()) return;
    let envelope: DsseEnvelope | null = null;
    try {
      envelope = JSON.parse(raw) as DsseEnvelope;
    } catch {
      entries.push({ line: i + 1, envelope: null, ok: false, reasons: ['line is not JSON'], receipt: null });
      return;
    }
    const result = verifyRunReceipt(envelope, trustedPublicKeys);
    entries.push({ line: i + 1, envelope, ok: result.ok, reasons: result.reasons, receipt: result.receipt });
  });
  return entries;
}
