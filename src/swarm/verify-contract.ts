/**
 * verify-contract.ts — completion credit, as a contract.
 *
 * A worker receipt is a claim. Credit comes only from checks this process
 * re-runs itself. This module ports that rule from the private Queen runtime
 * (agentic-ops/lifecycle/queen-verify.js) into a typed, runner-injected
 * contract the open kernel and the private controller can both satisfy:
 *
 *   - allowedChecks is an exact-match list. No globs, no prefixes, no shell
 *     metacharacters. A claimed check that is not on the list is refused, not
 *     ignored.
 *   - every claimed check is re-run through the injected runner and must exit 0;
 *   - every evidence file is re-digested and must match the claimed sha256;
 *   - evidence must be fresh (produced within the policy window, never in the future);
 *   - a code task must name the commit it produced;
 *   - a claim with no checks is a claim with no credit.
 *
 * The runner is injected so the kernel never spawns anything on its own, and
 * so a test can prove each refusal without touching a shell.
 */

import type { Brief } from './brief';

export type ClaimKind = 'code' | 'content' | 'research' | 'ops';

export interface ClaimEvidence {
  /** Path or ref the verifier can digest again. */
  ref: string;
  sha256: string;
  /** ISO date-time the maker says the artifact was produced. */
  producedAt: string;
}

/** What a maker hands up when it says it is done. */
export interface CompletionClaim {
  briefId: string;
  kind: ClaimKind;
  /** Exact command strings the maker says it ran green. */
  checksClaimed: string[];
  evidence: ClaimEvidence[];
  /** Required for `code`: the commit the work landed in (7–40 hex). */
  commit?: string;
}

export interface VerifyPolicy {
  /** Exact command strings that may be re-run. Usually Brief.allowedChecks. */
  allowedChecks: string[];
  /** Evidence older than this is stale. */
  maxEvidenceAgeMs: number;
  /** Future-dated evidence tolerance (clock skew). */
  clockSkewMs?: number;
}

export interface CheckRun {
  command: string;
  exitCode: number;
  durationMs?: number;
}

/** Injected. Runs ONE exact command string and reports its exit code. */
export interface CheckRunner {
  run(command: string): Promise<CheckRun>;
}

/** Injected. Returns the current sha256 of a ref, or null when it cannot be read. */
export type Digester = (ref: string) => Promise<string | null>;

export interface VerifyOutcome {
  credited: boolean;
  reasons: string[];
  reruns: CheckRun[];
}

const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{7,40}$/;
const GLOB = /[*?[\]{}]/;
const SHELL_META = /[;&|`$<>]/;

/** Why a single check string may not be run. Exact match against the allowlist. */
export function checkProblems(command: string, policy: Pick<VerifyPolicy, 'allowedChecks'>): string[] {
  const problems: string[] = [];
  if (typeof command !== 'string' || !command.trim()) return ['check is empty'];
  if (GLOB.test(command)) problems.push(`check is a pattern, not a command: ${JSON.stringify(command)}`);
  if (SHELL_META.test(command)) problems.push(`check carries shell metacharacters: ${JSON.stringify(command)}`);
  if (!policy.allowedChecks.includes(command)) problems.push(`check is not on allowedChecks (exact match): ${JSON.stringify(command)}`);
  return problems;
}

export function policyFromBrief(brief: Brief, maxEvidenceAgeMs: number): VerifyPolicy {
  return { allowedChecks: [...brief.allowedChecks], maxEvidenceAgeMs };
}

/**
 * verifyClaim() — the only path to credit. Re-runs, re-digests, refuses.
 * Never throws on a bad claim: a thrown error would read as "not refused".
 */
export async function verifyClaim(
  claim: CompletionClaim,
  policy: VerifyPolicy,
  runner: CheckRunner,
  digest: Digester,
  now: number = Date.now(),
): Promise<VerifyOutcome> {
  const reasons: string[] = [];
  const reruns: CheckRun[] = [];

  if (!claim || typeof claim !== 'object') return { credited: false, reasons: ['claim is not an object'], reruns };
  if (!Array.isArray(claim.checksClaimed) || claim.checksClaimed.length === 0) {
    reasons.push('claim names no checks; a receipt without checks is a claim without credit');
  }
  if (!Array.isArray(claim.evidence) || claim.evidence.length === 0) {
    reasons.push('claim carries no evidence');
  }
  if (claim.kind === 'code' && !(typeof claim.commit === 'string' && COMMIT.test(claim.commit))) {
    reasons.push('code claim must name the commit it produced');
  }

  // Allowlist first: an unlisted command is never executed, not even to see what it does.
  const runnable: string[] = [];
  for (const command of claim.checksClaimed ?? []) {
    const problems = checkProblems(command, policy);
    if (problems.length) reasons.push(...problems);
    else runnable.push(command);
  }
  if (reasons.length) return { credited: false, reasons, reruns };

  for (const command of runnable) {
    let run: CheckRun;
    try {
      run = await runner.run(command);
    } catch (err) {
      run = { command, exitCode: -1 };
      reasons.push(`check could not be re-run: ${command} (${(err as Error)?.message ?? 'error'})`);
    }
    reruns.push(run);
    if (run.exitCode !== 0) reasons.push(`check failed on re-run: ${command} (exit ${run.exitCode})`);
  }

  const skew = policy.clockSkewMs ?? 60_000;
  for (const ev of claim.evidence) {
    if (!SHA256.test(ev.sha256 ?? '')) {
      reasons.push(`evidence ${ev.ref} has no sha256`);
      continue;
    }
    const produced = Date.parse(ev.producedAt ?? '');
    if (!Number.isFinite(produced)) reasons.push(`evidence ${ev.ref} has no producedAt`);
    else if (produced > now + skew) reasons.push(`evidence ${ev.ref} is dated in the future`);
    else if (now - produced > policy.maxEvidenceAgeMs) reasons.push(`evidence ${ev.ref} is stale (${Math.round((now - produced) / 1000)}s old)`);
    const current = await digest(ev.ref);
    if (current === null) reasons.push(`evidence ${ev.ref} cannot be read`);
    else if (current !== ev.sha256) reasons.push(`evidence ${ev.ref} digest changed since the claim`);
  }

  return { credited: reasons.length === 0, reasons, reruns };
}
