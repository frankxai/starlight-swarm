/**
 * queen.ts — Stream Queen tier (Tier 2 of the agent stack).
 *
 * Each queen reuses the `queen-coordinator` + `hierarchical-coordinator` harness
 * patterns (claude-flow), scoped to ONE income stream. A queen:
 *   - owns a mesh of stateless workers,
 *   - runs a self-improving loop step,
 *   - decides act-vs-escalate for every proposed action via classify(),
 *   - NEVER commands across streams (coordinates through the founder),
 *   - NEVER moves money autonomously.
 *
 * v0.1 scaffold: stepLoop() drives workers to PROPOSE actions, then classifies
 * each proposal. It executes nothing gated. Money + irreversibility always route
 * up the escalation ladder. No real side effects.
 */

import { classify } from './escalation';
import type { Classification, Decision, StreamId } from './escalation';
import { checkCharter, raiseTo } from './charter';
import type { CharterContext, CharterVerdict } from './charter';
import { brokerPayments, brokerVault, ledgerAudit, queenGrant } from './capabilities';
import type { CapabilityGrant } from './capabilities';
import { issueHandoff } from './handoff';
import type { HandoffPacket } from './handoff';
import type { SisVaultMcp, PaymentsMcp } from './integrations';
import { SwarmLedger } from './ledger';
import type { LedgerEntry } from './ledger';
import type { Worker, Task, WorkerReport } from './worker';
import { makeWorker } from './worker';
import type { StreamSpec } from './streams';

/** What a queen decided about a single worker proposal during a loop step. */
export interface QueenDecision {
  worker: string;
  taskId: string;
  classification: Classification;
  /**
   * The queen's verdict:
   *  - 'act'      → autonomous/queen-gate within scope and below caps; queen proceeds behind its gate.
   *  - 'escalate' → founder-board (cross-stream, over-cap, new rail/vendor).
   *  - 'human'    → human-gate (irreversible or money movement). Agents prepare; humans commit.
   *  - 'refuse'   → a charter clause refuses outright; no gate lets this through (charter.ts).
   */
  verdict: 'act' | 'escalate' | 'human' | 'refuse';
  /** The benevolence charter's independent read on the same action (Blessing Protocol §13). */
  charter: CharterVerdict;
  /**
   * The decision tier actually applied, after the charter floor is combined with
   * the classification. Always >= classification.decision in severity.
   */
  effective: Decision;
}

/** Outcome of one queen loop step. */
export interface QueenLoopResult {
  queen: string;
  stream: StreamId;
  /** The self-improving-loop step label this run represents. */
  loopStep: string;
  decisions: QueenDecision[];
  /**
   * Verifiable packets for everything this step could not settle itself. A
   * refusal never produces one — there is nothing for a human to approve.
   */
  handoffs: HandoffPacket[];
}

/** MCP handles available to a queen (Payments only for the Payments Queen). */
export interface QueenMcp {
  vault: SisVaultMcp;
  /** Present only on the Payments Queen (IAM L3 scoping). Verify-only. */
  payments?: PaymentsMcp;
}

/** Governance wiring a queen carries beyond its stream config. */
export interface QueenGovernance {
  /**
   * Where decisions are written down. Omitted → the queen keeps its own, so
   * `queen.ledger` is never absent: clause 6 cannot hold if a decision can
   * happen with nowhere to record it.
   */
  ledger?: SwarmLedger;
  /**
   * The queen's tool grant. Defaults to the stream's seat — money tools only on
   * the Payments seat. Passing a narrower grant is always allowed; a wider one
   * is a deliberate act the caller has to write down.
   */
  grant?: CapabilityGrant;
  /** Injectable clock, so a dry-run can be reproduced byte-for-byte. */
  clock?: () => string;
}

/**
 * Queen — the sovereign of one stream's hive. Centralized decision, decentralized
 * (mesh) worker execution.
 */
export class Queen {
  readonly name: string;
  readonly stream: StreamId;
  readonly loop: string[];
  /**
   * The ledger-shaped facts this queen's charter checks run against (attribution
   * owed, capability claims, sovereignty). Defaults to `{}` — which asserts
   * nothing and therefore blocks nothing. Populate it from the operator's
   * lineage ledger to give clauses 3, 4 and 6 something to bite on.
   */
  readonly charterContext: CharterContext;
  /** Append-only record of everything this queen ruled on (clauses 4 + 6). */
  readonly ledger: SwarmLedger;
  /** The tool capabilities this queen holds. Workers inherit a narrowing of it. */
  readonly grant: CapabilityGrant;
  private readonly workers: Worker[];
  private readonly log: (m: string) => void;
  private readonly clock: () => string;

  constructor(
    spec: StreamSpec,
    log: (m: string) => void = () => {},
    charterContext: CharterContext = {},
    governance: QueenGovernance = {},
  ) {
    this.name = spec.queen.name;
    this.stream = spec.id;
    this.loop = spec.queen.selfImprovingLoop;
    this.log = log;
    this.charterContext = charterContext;
    this.clock = governance.clock ?? (() => new Date().toISOString());
    this.ledger = governance.ledger ?? new SwarmLedger({ clock: governance.clock });
    this.grant = governance.grant ?? queenGrant(spec.id, spec.queen.name);
    // Build the worker mesh from config. Each worker is stateless + single-skill.
    this.workers = spec.workers.map((w) => makeWorker(w.name, spec.id, w.skill, governance.clock));
  }

  /** The worker roster (read-only view). */
  roster(): ReadonlyArray<Worker> {
    return this.workers;
  }

  /**
   * decide() — the act-vs-escalate gate. Pure mapping from a classification to a
   * queen verdict. This is where the escalation contract becomes the queen's
   * discipline: anything beyond scope/caps leaves the queen's hands.
   *
   * Two independent reads run on every proposal:
   *   1. classify()     — who decides (the escalation spine),
   *   2. checkCharter() — whether it may proceed at all, and at what floor
   *                       (the benevolence charter, Blessing Protocol §13).
   *
   * They are combined with raiseTo(), which takes the HARDER of the two. The
   * charter can tighten a verdict and can never loosen one — so a queen holding
   * the charter is never more permissive than a queen without it. That property
   * is asserted directly in charter.test.ts.
   */
  decide(report: WorkerReport, ctx: CharterContext = this.charterContext): QueenDecision {
    const classification = classify(report.proposed);
    const charter = checkCharter(report.proposed, ctx);
    const effective = raiseTo(classification.decision, charter.floor);

    let verdict: QueenDecision['verdict'];
    if (charter.refused) {
      // A ledger defect (uncredited instrument, unbacked claim, lost sovereignty).
      // No approval tier clears it — the remedy is to fix the ledger, not to ask.
      verdict = 'refuse';
    } else {
      switch (effective) {
        case 'autonomous':
        case 'queen-gate':
          verdict = 'act';
          break;
        case 'founder-board':
          verdict = 'escalate';
          break;
        case 'human-gate':
          verdict = 'human';
          break;
        default:
          // Fail closed (charter clause 1). Only the two tiers named above earn
          // 'act'; anything this switch does not recognise — a Decision member
          // added later and not taught here — routes to a human. `raiseTo()`
          // already ranks an unknown tier as maximally severe, and a permissive
          // default would throw that away at the last step.
          verdict = 'human';
          break;
      }
    }
    return { worker: report.worker, taskId: report.taskId, classification, verdict, charter, effective };
  }

  /**
   * record() — write one decision into the append-only ledger.
   *
   * Every ruling lands here, not only the interesting ones. A ledger that holds
   * refusals but not approvals answers "what did it block?" and cannot answer
   * "what did it do?", and clause 6 needs the second question answerable too.
   */
  private record(decision: QueenDecision, report: WorkerReport): LedgerEntry {
    return this.ledger.append({
      kind: decision.verdict === 'refuse' ? 'refusal' : 'decision',
      actor: this.name,
      stream: this.stream,
      subject: decision.taskId,
      summary:
        `${decision.verdict.toUpperCase()} at ${decision.effective} — ` +
        (decision.verdict === 'refuse'
          ? decision.charter.breaches.map((b) => b.reason).join(' ')
          : decision.classification.reason),
      detail: {
        worker: decision.worker,
        action_kind: report.proposed?.kind ?? null,
        classified: decision.classification.decision,
        effective: decision.effective,
        gates: decision.classification.gates,
        breaches: decision.charter.breaches.map((b) => ({
          clause: b.clause,
          disposition: b.disposition,
          reason: b.reason,
          remedy: b.remedy,
        })),
      },
    });
  }

  /**
   * stepLoop() — run one self-improving-loop step across the worker mesh.
   *
   * Workers PROPOSE (read/draft only + append to vault); the queen CLASSIFIES and
   * decides. Nothing gated is executed here. This is the dry-run heartbeat.
   *
   * Both MCP handles are brokered before use. The worker mesh receives a grant
   * narrowed to append-only memory — so the IAM boundary that streams.ts states
   * in prose is enforced by the object the worker actually holds — and the
   * queen's own payments calls are checked against its seat's grant.
   */
  async stepLoop(tasks: Task[], mcp: QueenMcp, loopStep = this.loop[0]): Promise<QueenLoopResult> {
    this.log(`\n  [${this.name}] loop step: "${loopStep}" — dispatching ${tasks.length} worker task(s)`);
    const decisions: QueenDecision[] = [];
    const handoffs: HandoffPacket[] = [];
    const audit = ledgerAudit(this.ledger, this.stream);
    const payments = mcp.payments ? brokerPayments(mcp.payments, this.grant, audit) : undefined;

    for (const task of tasks) {
      const worker = task.worker ? this.workers.find((w) => w.name === task.worker) : undefined;
      const chosen = worker ?? this.workers[0];
      if (!chosen) {
        throw new Error('No worker available to execute task: ' + task.id);
      }
      const workerVault = brokerVault(mcp.vault, this.grant.restrict(chosen.name, ['vault.append']), audit);
      const report = await chosen.run(task, workerVault);
      const decision = this.decide(report);
      decisions.push(decision);
      const entry = this.record(decision, report);

      // Anything the queen cannot settle leaves as a document, not a log line:
      // whoever holds the gate can verify it against the ledger and the spine.
      const packet = issueHandoff(
        decision,
        report.proposed,
        { queen: this.name, worker: decision.worker, stream: this.stream, taskId: task.id, task: task.description },
        entry,
        this.clock(),
      );
      if (packet) {
        handoffs.push(packet);
        this.ledger.append({
          kind: 'note',
          actor: this.name,
          stream: this.stream,
          subject: packet.packet_id,
          summary: `Handoff issued to ${packet.gate} for ${task.id}.`,
          detail: { bound_to_ledger_seq: entry.seq, outstanding_gates: packet.outstanding_gates },
        });
      }

      this.log(
        `    • ${decision.worker} → ${decision.effective.toUpperCase()} ` +
          `(verdict: ${decision.verdict}) — ${decision.classification.reason}`,
      );
      // Clause 5: a refusal is surfaced with a reason a human can act on, never swallowed.
      for (const b of decision.charter.breaches) {
        this.log(`      ↳ charter [${b.clause}] ${b.reason} FIX: ${b.remedy}`);
      }

      // A charter refusal stops here: no MCP touch, no gate, no further work on
      // this proposal until the underlying ledger defect is fixed.
      if (decision.verdict === 'refuse') continue;

      // Demonstrate the verify-only Payments MCP touch WITHOUT moving money.
      if (this.stream === 'payments' && payments && report.proposed.movesMoney) {
        this.log('    ↳ Payments Queen runs verify-only governance (fail-closed):');
        await payments.verify_mandate({
          signature: 'dry-run',
          amount: report.proposed.amount ?? 0,
          purpose: task.description,
        });
        await payments.check_spend_cap(this.stream, report.proposed.amount ?? 0);
        if (decision.verdict !== 'act') {
          await payments.require_human_approval(decision.classification.reason);
        }
      }
    }

    return { queen: this.name, stream: this.stream, loopStep, decisions, handoffs };
  }
}
