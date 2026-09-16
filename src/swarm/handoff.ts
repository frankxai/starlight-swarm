/**
 * handoff.ts — the artifact a human actually receives at the gate.
 *
 * Clause 2 says agents draft, verify, and gate, and humans commit. The drafting
 * and the gating were real in this runtime; the handing-over was a line of
 * console output. Whoever holds the human gate got a sentence, not a document —
 * no proposal to inspect, no record of who ruled, no way to tell whether the
 * thing in front of them is what the spine actually decided.
 *
 * A handoff packet is that document, and it is verifiable rather than trusted.
 *
 * WHY VERIFICATION RE-DERIVES INSTEAD OF CHECKING A SIGNATURE.
 * A packet carries the proposal it is about. `verifyHandoff()` runs that
 * proposal back through classify() and checkCharter() and compares the answer
 * to the gate the packet claims. A tampered packet asking a human to wave
 * through a move-funds action labelled "queen-gate" therefore fails on its own
 * contents — no key, no trusted issuer, no revocation problem. The packet is
 * checked against the doctrine, not against whoever produced it.
 *
 * TWO REFUSALS ARE STRUCTURAL HERE.
 *   1. A packet that claims a LOWER gate than the spine assigns is invalid.
 *      Handoff can raise a gate; it can never launder one downward.
 *   2. A charter refusal produces NO packet at all. There is nothing for a
 *      human to approve: an uncredited instrument or an unbacked claim is a
 *      ledger defect, and the remedy is to fix the ledger. You cannot escalate
 *      your way out of a refusal, and the absence of an issuing path is how
 *      that is enforced rather than merely stated.
 *
 * Nothing here approves anything. A verified packet means "this is genuinely
 * what the swarm decided and it genuinely needs you" — never "proceed".
 */

import { checkCharter, raiseTo } from './charter';
import type { Breach, CharterContext } from './charter';
import { classify } from './escalation';
import type { Action, Decision } from './escalation';
import type { QueenDecision } from './queen';
import type { LedgerEntry } from './ledger';
import { sha256Digest } from './runtime-digest';

export const HANDOFF_SCHEMA_VERSION = 'starlight.swarm.handoff.v1';

/** The tiers that require someone other than the queen. Nothing else hands off. */
export type HandoffGate = Extract<Decision, 'founder-board' | 'human-gate'>;

export interface HandoffPacket {
  schema_version: typeof HANDOFF_SCHEMA_VERSION;
  /** Derived from the content digest, so a mutated packet cannot keep its id. */
  packet_id: string;
  created_at: string;
  /** Who must act. Never below what the spine assigned. */
  gate: HandoffGate;
  /** What the human is being asked to do, in one line. */
  requested_of_human: string;
  origin: { queen: string; worker: string; stream: string; task_id: string; task: string };
  /** The proposal itself, so the verifier can re-derive rather than trust. */
  proposal: Action;
  classification: { decision: Decision; reason: string };
  charter: { floor: Decision | null; breaches: Breach[] };
  /** Gates still to be satisfied before this may be committed. */
  outstanding_gates: string[];
  /** Binding to the append-only record this decision was written into. */
  ledger: { seq: number; entry_sha256: string };
  content_digest_sha256: string;
}

export interface HandoffDefect {
  code:
    | 'schema'
    | 'digest'
    | 'ledger-binding'
    | 'gate-downgrade'
    | 'refusal-not-approvable'
    | 'gates-missing';
  reason: string;
  remedy: string;
}

export interface HandoffVerification {
  valid: boolean;
  defects: HandoffDefect[];
}

const SEVERITY: readonly Decision[] = ['autonomous', 'queen-gate', 'founder-board', 'human-gate'];
function rank(d: Decision | null): number {
  if (d === null) return -1;
  const i = SEVERITY.indexOf(d);
  return i === -1 ? SEVERITY.length : i;
}

/** The bytes bound by the digest: everything except the id and the digest itself. */
type UnboundPacket = Omit<HandoffPacket, 'packet_id' | 'content_digest_sha256'>;

function bind(unbound: UnboundPacket): HandoffPacket {
  const digest = sha256Digest(unbound);
  return { ...unbound, packet_id: `handoff-${digest.slice(0, 16)}`, content_digest_sha256: digest };
}

function askOf(gate: HandoffGate, decision: QueenDecision): string {
  return gate === 'human-gate'
    ? 'Review the prepared action and commit it yourself, or reject it. The swarm has verified and gated it; ' +
        'it will not commit this class of action under any approval.'
    : `Pressure-test this with the board and rule on it. Reason: ${decision.classification.reason}`;
}

export interface HandoffOrigin {
  queen: string;
  worker: string;
  stream: string;
  taskId: string;
  /** Human-readable description of the work the proposal came from. */
  task: string;
}

/**
 * issueHandoff() — turn a queen's ruling into a packet, or decline to.
 *
 * Returns null in the two cases where a packet would be wrong: an `act` verdict
 * (nobody is being asked for anything) and a `refuse` verdict (there is nothing
 * approvable). Callers therefore cannot manufacture an approval request for a
 * refused action even by accident.
 */
export function issueHandoff(
  decision: QueenDecision,
  proposal: Action,
  origin: HandoffOrigin,
  ledgerEntry: LedgerEntry,
  createdAt: string,
): HandoffPacket | null {
  if (decision.verdict === 'act' || decision.verdict === 'refuse') return null;
  if (decision.effective !== 'founder-board' && decision.effective !== 'human-gate') return null;

  return bind({
    schema_version: HANDOFF_SCHEMA_VERSION,
    created_at: createdAt,
    gate: decision.effective,
    requested_of_human: askOf(decision.effective, decision),
    origin: {
      queen: origin.queen,
      worker: origin.worker,
      stream: origin.stream,
      task_id: origin.taskId,
      task: origin.task,
    },
    proposal: { ...proposal },
    classification: { decision: decision.classification.decision, reason: decision.classification.reason },
    charter: { floor: decision.charter.floor, breaches: decision.charter.breaches },
    outstanding_gates: decision.classification.gates.slice(),
    ledger: { seq: ledgerEntry.seq, entry_sha256: ledgerEntry.sha256 },
  });
}

/**
 * verifyHandoff() — decide whether a packet is genuinely what the swarm ruled.
 *
 * Reports every defect rather than the first: whoever is holding the gate
 * should see the whole picture before deciding whether to trust the document.
 * A packet the verifier cannot bind to the ledger it names is invalid even if
 * its contents are otherwise perfect — an unrecorded decision is exactly the
 * thing clause 6 exists to prevent.
 */
export function verifyHandoff(
  packet: HandoffPacket,
  ledgerEntries: readonly LedgerEntry[],
  context: CharterContext = {},
): HandoffVerification {
  const defects: HandoffDefect[] = [];

  if (packet.schema_version !== HANDOFF_SCHEMA_VERSION) {
    defects.push({
      code: 'schema',
      reason: `Unknown handoff schema "${packet.schema_version}".`,
      remedy: `Re-issue the packet under ${HANDOFF_SCHEMA_VERSION}. An unrecognised envelope is not read, it is refused.`,
    });
  }

  const { packet_id, content_digest_sha256, ...unbound } = packet;
  const recomputed = sha256Digest(unbound);
  if (recomputed !== content_digest_sha256 || packet_id !== `handoff-${recomputed.slice(0, 16)}`) {
    defects.push({
      code: 'digest',
      reason: 'Packet contents do not match the digest they are bound to — it was edited after issue.',
      remedy: 'Discard this packet and ask the issuing queen to re-issue from the ledger entry.',
    });
  }

  const entry = ledgerEntries.find((candidate) => candidate.sha256 === packet.ledger.entry_sha256);
  if (!entry) {
    defects.push({
      code: 'ledger-binding',
      reason: `No ledger entry hashes to ${packet.ledger.entry_sha256.slice(0, 12)}… — this decision is not on the record.`,
      remedy: 'Refuse the handoff. A decision nobody wrote down is not a decision a human should be asked to commit.',
    });
  } else if (entry.seq !== packet.ledger.seq || entry.subject !== packet.origin.task_id) {
    defects.push({
      code: 'ledger-binding',
      reason: `Packet binds to ledger seq ${packet.ledger.seq}/${packet.origin.task_id}, but that hash sits at seq ${entry.seq}/${entry.subject}.`,
      remedy: 'Refuse the handoff and re-issue from the correct entry.',
    });
  }

  // Re-derive from the proposal the packet carries. This is the check a forged
  // or stale packet fails, and it is the reason the packet carries a proposal.
  const derivedClassification = classify(packet.proposal);
  const derivedCharter = checkCharter(packet.proposal, context);
  const derivedEffective = raiseTo(derivedClassification.decision, derivedCharter.floor);

  if (rank(packet.gate) < rank(derivedEffective)) {
    defects.push({
      code: 'gate-downgrade',
      reason: `Packet asks for ${packet.gate}, but the proposal it carries assesses at ${derivedEffective}.`,
      remedy: `Re-issue at ${derivedEffective}. A handoff may raise a gate and may never lower one.`,
    });
  }

  if (derivedCharter.refused) {
    defects.push({
      code: 'refusal-not-approvable',
      reason:
        'The proposal breaches a clause that refuses outright: ' +
        derivedCharter.breaches.filter((b) => b.disposition === 'refuse').map((b) => b.clause).join(', ') + '.',
      remedy: 'Fix the ledger defect. No approval, at any tier, converts a refusal into a permission.',
    });
  }

  if (packet.outstanding_gates.length === 0) {
    defects.push({
      code: 'gates-missing',
      reason: 'Packet names no outstanding gates, so it cannot say what satisfying it would require.',
      remedy: 'Re-issue with the gate list from the classification.',
    });
  }

  return { valid: defects.length === 0, defects };
}

/** Render a packet for a human reading a terminal or an escalation channel. */
export function formatHandoff(packet: HandoffPacket): string {
  const lines = [
    `HANDOFF ${packet.packet_id} → ${packet.gate.toUpperCase()}`,
    `  from     ${packet.origin.queen} / ${packet.origin.worker} (${packet.origin.stream})`,
    `  task     ${packet.origin.task_id} — ${packet.origin.task}`,
    `  proposal ${packet.proposal.kind} · irreversible=${packet.proposal.irreversible} · movesMoney=${packet.proposal.movesMoney}`,
    `  ruling   ${packet.classification.decision} — ${packet.classification.reason}`,
    `  gates    ${packet.outstanding_gates.join(' → ')}`,
    `  ledger   seq ${packet.ledger.seq} · ${packet.ledger.entry_sha256.slice(0, 12)}…`,
    `  asks     ${packet.requested_of_human}`,
  ];
  for (const breach of packet.charter.breaches) {
    lines.push(`  charter  [${breach.clause}] ${breach.reason} FIX: ${breach.remedy}`);
  }
  return lines.join('\n');
}
