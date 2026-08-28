/**
 * ledger.test.ts — the append-only record, and the properties that make it one.
 *
 * Run:  node --test --import tsx src/swarm/ledger.test.ts
 *
 * The load-bearing claims:
 *   1. the chain detects tampering — content edits, reordering, and excisions,
 *   2. an export reads back and re-verifies without this module's state,
 *   3. an unbacked capability claim is refused AND the refusal is recorded.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  GENESIS_HASH,
  LEDGER_SCHEMA_VERSION,
  SwarmLedger,
  explainVerification,
  readLedgerJsonl,
  verifyEntries,
} from './ledger';
import type { LedgerEntry } from './ledger';

/** A fixed clock, so entries differ only where the test makes them differ. */
function fixedClock(): () => string {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString();
}

function seeded(): SwarmLedger {
  const ledger = new SwarmLedger({ clock: fixedClock() });
  ledger.append({ kind: 'decision', actor: 'Content Queen', stream: 'content', subject: 'con-1', summary: 'ACT at autonomous' });
  ledger.append({ kind: 'decision', actor: 'Payments Queen', stream: 'payments', subject: 'pay-1', summary: 'ACT at queen-gate' });
  ledger.append({ kind: 'refusal', actor: 'Payments Queen', stream: 'payments', subject: 'pay-2', summary: 'ESCALATE at founder-board' });
  return ledger;
}

test('an empty ledger heads at genesis and verifies', () => {
  const ledger = new SwarmLedger();
  assert.equal(ledger.head(), GENESIS_HASH);
  assert.equal(ledger.size, 0);
  assert.equal(ledger.verify().intact, true);
});

test('entries are sequenced, chained, and stamped with the schema version', () => {
  const ledger = seeded();
  const entries = ledger.entries();

  assert.equal(entries.length, 3);
  entries.forEach((entry, index) => {
    assert.equal(entry.seq, index);
    assert.equal(entry.schema_version, LEDGER_SCHEMA_VERSION);
    assert.match(entry.sha256, /^[a-f0-9]{64}$/);
    assert.equal(entry.prev_sha256, index === 0 ? GENESIS_HASH : entries[index - 1].sha256);
  });
  assert.equal(ledger.head(), entries[2].sha256);
  assert.equal(ledger.verify().intact, true);
});

test('the ledger exposes no way to mutate or drop an entry', () => {
  const ledger = seeded();
  // Append-only is expressed as an absent capability, not a documented promise.
  for (const forbidden of ['update', 'delete', 'remove', 'truncate', 'set', 'splice']) {
    assert.equal(
      typeof (ledger as unknown as Record<string, unknown>)[forbidden],
      'undefined',
      `SwarmLedger must not expose ${forbidden}()`,
    );
  }
  // And the view a caller receives cannot be written back through.
  const view = ledger.entries();
  assert.throws(() => (view as LedgerEntry[]).push(view[0]));
  assert.equal(ledger.size, 3);
});

test('editing an entry breaks the chain at that entry', () => {
  const entries = seeded().entries().map((entry) => ({ ...entry }));
  entries[1].summary = 'ACT at autonomous';

  const verification = verifyEntries(entries);
  assert.equal(verification.intact, false);
  assert.ok(verification.breaks.some((b) => b.seq === 1 && /does not match its recorded digest/.test(b.reason)));
  assert.match(explainVerification(verification), /LEDGER BROKEN/);
});

test('excising an entry breaks the chain at the gap', () => {
  const entries = seeded().entries().slice();
  const withoutMiddle = [entries[0], entries[2]];

  const verification = verifyEntries(withoutMiddle);
  assert.equal(verification.intact, false);
  assert.ok(verification.breaks.some((b) => /chains to/.test(b.reason)), 'a removed entry must leave a visible gap');
});

test('reordering entries breaks the chain', () => {
  const entries = seeded().entries().slice();
  const verification = verifyEntries([entries[1], entries[0], entries[2]]);
  assert.equal(verification.intact, false);
});

test('an export reads back, re-verifies, and survives a corrupt line without losing the rest', () => {
  const ledger = seeded();
  const readBack = readLedgerJsonl(ledger.toJsonl());
  assert.equal(readBack.entries.length, 3);
  assert.equal(readBack.verification.intact, true);
  assert.equal(readBack.verification.head, ledger.head());

  const corrupted = readLedgerJsonl(`${ledger.toJsonl()}\n{not json`);
  assert.equal(corrupted.entries.length, 3, 'the readable history survives one bad line');
  assert.equal(corrupted.verification.intact, false);
  assert.ok(corrupted.verification.breaks.some((b) => /not valid JSON/.test(b.reason)));
});

test('the sink receives each entry as it is appended, for a local plain-text mirror', () => {
  const lines: string[] = [];
  const ledger = new SwarmLedger({ clock: fixedClock(), sink: (line) => lines.push(line) });
  ledger.append({ kind: 'note', actor: 'operator', subject: 'boot', summary: 'runtime started' });
  ledger.append({ kind: 'note', actor: 'operator', subject: 'halt', summary: 'runtime stopped' });

  assert.equal(lines.length, 2);
  assert.equal(lines.join('\n'), ledger.toJsonl());
  assert.equal(readLedgerJsonl(lines.join('\n')).verification.intact, true);
});

test('a fixed clock makes two independent ledgers hash identically', () => {
  // Reproducibility is what lets one run be diffed against the next; a
  // wall-clock stamp in every entry would make every run incomparable.
  assert.equal(seeded().head(), seeded().head());
});

test('an unbacked capability claim is refused, and the refusal is written down', () => {
  const ledger = new SwarmLedger({ clock: fixedClock() });
  const result = ledger.attestClaim('Content Queen', 'Fully autonomous revenue', []);

  assert.equal(result.attested, false);
  assert.equal(result.entry.kind, 'refusal');
  assert.equal(ledger.entriesOfKind('claim').length, 0);
  assert.equal(ledger.entriesOfKind('refusal').length, 1);
  assert.equal(result.entry.detail?.clause, 'no-unbacked-claim');
  assert.ok(String(result.entry.detail?.remedy).length > 0, 'a refusal carries the move that clears it');
});

test('whitespace refs do not count as backing', () => {
  const ledger = new SwarmLedger({ clock: fixedClock() });
  assert.equal(ledger.attestClaim('Products Queen', 'Ships itself', ['   ']).attested, false);
});

test('a backed claim is recorded as a claim, carrying its refs', () => {
  const ledger = new SwarmLedger({ clock: fixedClock() });
  const result = ledger.attestClaim('Content Queen', 'Governed dry-run swarm', ['test:eval-harness', 'lineage:swarm-v0.2']);

  assert.equal(result.attested, true);
  assert.equal(result.entry.kind, 'claim');
  assert.deepEqual(result.entry.backedBy, ['test:eval-harness', 'lineage:swarm-v0.2']);
  assert.equal(ledger.verify().intact, true);
});
