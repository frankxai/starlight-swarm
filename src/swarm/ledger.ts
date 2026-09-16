/**
 * ledger.ts — the append-only, hash-chained record of what the swarm decided.
 *
 * Two charter clauses have, until now, existed only as prose in this runtime:
 *
 *   clause 4 (sovereignty)       "Ledgers stay plain text, append-only, locally owned."
 *   clause 6 (no-unbacked-claim) "What the system claims traces to a ledger entry."
 *
 * A clause with no storage behind it is a clause that cannot be checked, and
 * charter.ts already takes the position that an untested charter is not a
 * charter. This module is the storage: a sequence of JSON lines, each carrying
 * the hash of the one before it, with no update and no delete in the API.
 *
 * WHY A HASH CHAIN AND NOT JUST AN ARRAY.
 * Append-only is a property of the writer; a reader who was handed a file has
 * no way to know the writer honored it. Chaining each entry to its predecessor
 * makes a silent edit detectable by anyone holding the text — including the
 * operator who exported it and walked away, which is the case clause 4 exists
 * to protect. `verify()` is the reader's half of the guarantee.
 *
 * WHAT THIS MODULE MAY NOT DO.
 * It does not execute, gate, or approve. A ledger that could deny would be a
 * second gate competing with escalation.ts and charter.ts, and the repo already
 * pays for its redundancy deliberately in those two. The one refusal that lives
 * here is clause 6's, because an unbacked claim IS a ledger defect: there is
 * nothing to refuse except the act of writing it down as backed.
 */

import { sha256Digest } from './runtime-digest';

export const LEDGER_SCHEMA_VERSION = 'starlight.swarm.ledger.v1';

/** The hash a first entry chains to. Fixed so two ledgers are comparable. */
export const GENESIS_HASH = '0'.repeat(64);

/**
 * What an entry is about. Kept small on purpose — a ledger whose vocabulary
 * grows per feature stops being readable by the operator it belongs to.
 */
export type LedgerEventKind =
  | 'decision' //            a queen ruled on a proposal
  | 'refusal' //             the charter refused outright, or a gate said no
  | 'capability-denied' //   a tool call was attempted outside its grant
  | 'claim' //               a capability claim, with the refs backing it
  | 'note'; //               operator/context breadcrumb

/** The caller-supplied half of an entry. Everything else the ledger derives. */
export interface LedgerRecord {
  kind: LedgerEventKind;
  /** Who acted: a queen, a worker, the founder, or a tool broker. */
  actor: string;
  /** Stream the entry belongs to, when it belongs to one. */
  stream?: string;
  /** What the entry is about — a task id, a tool name, a claim statement. */
  subject: string;
  /** One line a human can act on (clause 5 applies to the record, too). */
  summary: string;
  /** Structured detail. Must be JSON-serializable — it is hashed canonically. */
  detail?: Record<string, unknown>;
  /** Blessing ids, lineage ids, or test names backing a claim (clause 6). */
  backedBy?: readonly string[];
}

/** A record after the ledger has sequenced, timestamped, and chained it. */
export interface LedgerEntry extends LedgerRecord {
  schema_version: typeof LEDGER_SCHEMA_VERSION;
  seq: number;
  at: string;
  prev_sha256: string;
  sha256: string;
}

/** Where a chain stops being trustworthy, and why. */
export interface LedgerBreak {
  seq: number;
  reason: string;
}

export interface LedgerVerification {
  intact: boolean;
  entries: number;
  head: string;
  breaks: LedgerBreak[];
}

export interface LedgerOptions {
  /** Injectable clock. A fixed clock makes a dry-run byte-reproducible. */
  clock?: () => string;
  /**
   * Called with each entry's JSON line as it is appended. This is the hook a
   * caller uses to mirror the ledger to a local file; the ledger itself does no
   * I/O, so nothing here can put operator state somewhere unreadable.
   */
  sink?: (line: string) => void;
}

/** The bytes that are hashed: the whole entry except its own digest. */
function digestOf(entry: Omit<LedgerEntry, 'sha256'>): string {
  return sha256Digest(entry);
}

/**
 * SwarmLedger — an in-memory chain with a plain-text export.
 *
 * There is deliberately no `update`, `delete`, `truncate`, or index setter.
 * Append-only is expressed as an absent capability rather than a documented
 * convention, because a convention is what an eager agent routes around.
 */
export class SwarmLedger {
  private readonly chain: LedgerEntry[] = [];
  private readonly clock: () => string;
  private readonly sink?: (line: string) => void;

  constructor(options: LedgerOptions = {}) {
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.sink = options.sink;
  }

  /** Hash of the newest entry, or the genesis hash on an empty ledger. */
  head(): string {
    const last = this.chain[this.chain.length - 1];
    return last ? last.sha256 : GENESIS_HASH;
  }

  get size(): number {
    return this.chain.length;
  }

  /** A frozen read-only view. Callers get the data, never the array. */
  entries(): readonly LedgerEntry[] {
    return Object.freeze(this.chain.slice());
  }

  /** Entries of one kind, in order. */
  entriesOfKind(kind: LedgerEventKind): readonly LedgerEntry[] {
    return this.entries().filter((entry) => entry.kind === kind);
  }

  append(record: LedgerRecord): LedgerEntry {
    const unhashed: Omit<LedgerEntry, 'sha256'> = {
      schema_version: LEDGER_SCHEMA_VERSION,
      seq: this.chain.length,
      at: this.clock(),
      prev_sha256: this.head(),
      kind: record.kind,
      actor: record.actor,
      subject: record.subject,
      summary: record.summary,
      ...(record.stream === undefined ? {} : { stream: record.stream }),
      ...(record.detail === undefined ? {} : { detail: record.detail }),
      ...(record.backedBy === undefined ? {} : { backedBy: record.backedBy.slice() }),
    };
    const entry: LedgerEntry = Object.freeze({ ...unhashed, sha256: digestOf(unhashed) });
    this.chain.push(entry);
    this.sink?.(JSON.stringify(entry));
    return entry;
  }

  /**
   * Record a capability claim, refusing to record it as backed when nothing
   * backs it (clause 6). The refusal is itself written down: a claim that was
   * attempted and rejected is exactly the history an operator needs, and
   * silently dropping it would trade one clause-6 defect for a clause-5 one.
   */
  attestClaim(
    actor: string,
    statement: string,
    backedBy: readonly string[],
  ): { attested: true; entry: LedgerEntry } | { attested: false; entry: LedgerEntry; reason: string } {
    const refs = backedBy.filter((ref) => ref.trim().length > 0);
    if (refs.length === 0) {
      const reason = `Capability claim "${statement}" has no blessing, lineage id, or passing test behind it.`;
      return {
        attested: false,
        reason,
        entry: this.append({
          kind: 'refusal',
          actor,
          subject: statement,
          summary: reason,
          detail: {
            clause: 'no-unbacked-claim',
            remedy: 'Back the claim with a blessing id, a lineage id, or a passing test name — or cut the claim.',
          },
        }),
      };
    }
    return {
      attested: true,
      entry: this.append({
        kind: 'claim',
        actor,
        subject: statement,
        summary: `Claim backed by ${refs.length} ledger ref(s).`,
        backedBy: refs,
      }),
    };
  }

  /**
   * Recompute the chain and report every place it disagrees with itself.
   * Reports ALL breaks rather than the first: an operator auditing a tampered
   * export should see the extent of the damage in one pass.
   */
  verify(): LedgerVerification {
    return verifyEntries(this.chain);
  }

  /** Plain text, one JSON object per line — the export clause 4 promises. */
  toJsonl(): string {
    return this.chain.map((entry) => JSON.stringify(entry)).join('\n');
  }
}

/** Verify any entry sequence, including one read back from a file. */
export function verifyEntries(entries: readonly LedgerEntry[]): LedgerVerification {
  const breaks: LedgerBreak[] = [];
  let expectedPrev = GENESIS_HASH;

  entries.forEach((entry, index) => {
    if (entry.schema_version !== LEDGER_SCHEMA_VERSION) {
      breaks.push({ seq: index, reason: `Unknown ledger schema version "${entry.schema_version}".` });
    }
    if (entry.seq !== index) {
      breaks.push({ seq: index, reason: `Entry claims seq ${entry.seq} but sits at position ${index}.` });
    }
    if (entry.prev_sha256 !== expectedPrev) {
      breaks.push({
        seq: index,
        reason: `Entry chains to ${entry.prev_sha256.slice(0, 12)}… but the previous entry hashes to ${expectedPrev.slice(0, 12)}…`,
      });
    }

    const { sha256, ...unhashed } = entry;
    const recomputed = digestOf(unhashed as Omit<LedgerEntry, 'sha256'>);
    if (recomputed !== sha256) {
      breaks.push({ seq: index, reason: 'Entry content does not match its recorded digest — it was edited after the fact.' });
    }
    expectedPrev = sha256;
  });

  return {
    intact: breaks.length === 0,
    entries: entries.length,
    head: entries.length === 0 ? GENESIS_HASH : entries[entries.length - 1].sha256,
    breaks,
  };
}

/**
 * Read a ledger back from its plain-text export and verify it in one step.
 *
 * The operator's exit path (clause 4) is only real if the exported bytes are
 * re-readable without this codebase; parsing is trivial by design, and an
 * unparseable line is reported as a break rather than thrown, so one corrupt
 * line does not cost the operator the rest of their history.
 */
export function readLedgerJsonl(text: string): { entries: LedgerEntry[]; verification: LedgerVerification } {
  const lines = text.split('\n').filter((line) => line.trim().length > 0);
  const entries: LedgerEntry[] = [];
  const parseBreaks: LedgerBreak[] = [];

  lines.forEach((line, index) => {
    try {
      entries.push(JSON.parse(line) as LedgerEntry);
    } catch {
      parseBreaks.push({ seq: index, reason: 'Line is not valid JSON.' });
    }
  });

  const verification = verifyEntries(entries);
  return {
    entries,
    verification: {
      ...verification,
      intact: verification.intact && parseBreaks.length === 0,
      breaks: parseBreaks.concat(verification.breaks),
    },
  };
}

/** Render a verification as lines a human can act on. */
export function explainVerification(v: LedgerVerification): string {
  if (v.intact) return `LEDGER OK — ${v.entries} entr(ies), head ${v.head.slice(0, 12)}…`;
  return [`LEDGER BROKEN — ${v.breaks.length} defect(s) across ${v.entries} entr(ies):`]
    .concat(v.breaks.map((b) => `  seq ${b.seq}: ${b.reason}`))
    .join('\n');
}
