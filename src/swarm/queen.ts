/**
 * queen.ts — the Starlight Queen's stream seat (Tier 2 of the agent stack).
 *
 * One Queen per stream, one governance mode (generals.ts), one worker mesh.
 * A queen:
 *   - owns a mesh of stateless workers,
 *   - runs a self-improving loop step,
 *   - decides act-vs-escalate for every proposed action via classify(),
 *   - NEVER commands across streams (coordinates through the founder),
 *   - NEVER moves money autonomously.
 *
 * stepLoop() drives workers to PROPOSE actions, then classifies each
 * proposal. It executes nothing gated. Money + irreversibility always route
 * up the escalation ladder. On the payments stream the verify-only MCP is
 * consulted audit-first, and its answers can only tighten a verdict.
 */

import { classify } from './escalation';
import type { Classification, Decision, StreamId } from './escalation';
import { checkCharter, raiseTo } from './charter';
import type { CharterContext, CharterVerdict } from './charter';
import type { SisVaultMcp, PaymentsMcp } from './integrations';
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
  /**
   * What the verify-only payments governance said, when it ran. Each answer
   * can only tighten the verdict: a failed audit write fails the action, an
   * invalid mandate or an over-cap answer takes 'act' away. Absent on streams
   * that never touch the Payments MCP.
   */
  governance?: PaymentsGovernance;
}

/** The verify-only payments read, recorded per decision. */
export interface PaymentsGovernance {
  /** record_audit_entry ran FIRST. 'failed' means the action failed with it. */
  audit: 'ok' | 'failed';
  mandate: 'valid' | 'invalid' | 'skipped';
  cap: 'within' | 'over' | 'skipped';
  /** The verdict before governance tightened it, when it did. */
  downgradedFrom?: QueenDecision['verdict'];
  reason?: string;
}

/** Outcome of one queen loop step. */
export interface QueenLoopResult {
  queen: string;
  stream: StreamId;
  /** The self-improving-loop step label this run represents. */
  loopStep: string;
  decisions: QueenDecision[];
}

/** MCP handles available to a queen (Payments only for the Payments Queen). */
export interface QueenMcp {
  vault: SisVaultMcp;
  /** Present only on the Payments Queen (IAM L3 scoping). Verify-only. */
  payments?: PaymentsMcp;
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
  private readonly workers: Worker[];
  private readonly log: (m: string) => void;

  constructor(spec: StreamSpec, log: (m: string) => void = () => {}, charterContext: CharterContext = {}) {
    this.name = spec.queen.name;
    this.stream = spec.id;
    this.loop = spec.queen.selfImprovingLoop;
    this.log = log;
    this.charterContext = charterContext;
    // Build the worker mesh from config. Each worker is stateless + single-skill.
    this.workers = spec.workers.map((w) => makeWorker(w.name, spec.id, w.skill));
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
   * stepLoop() — run one self-improving-loop step across the worker mesh.
   *
   * Workers PROPOSE (read/draft only + append to vault); the queen CLASSIFIES and
   * decides. Nothing gated is executed here. This is the dry-run heartbeat.
   */
  async stepLoop(tasks: Task[], mcp: QueenMcp, loopStep = this.loop[0]): Promise<QueenLoopResult> {
    this.log(`\n  [${this.name}] loop step: "${loopStep}" — dispatching ${tasks.length} worker task(s)`);
    const decisions: QueenDecision[] = [];

    for (const task of tasks) {
      const worker = task.worker ? this.workers.find((w) => w.name === task.worker) : undefined;
      const chosen = worker ?? this.workers[0];
      if (!chosen) {
        throw new Error('No worker available to execute task: ' + task.id);
      }
      const report = await chosen.run(task, mcp.vault);
      const decision = this.decide(report);

      // Payments governance runs BEFORE the decision is recorded, so what the
      // ledger sees is the verdict after verification, never before it.
      if (decision.verdict !== 'refuse' && this.stream === 'payments' && mcp.payments && report.proposed.movesMoney) {
        await this.governPayment(decision, report, task, mcp.payments);
      }
      decisions.push(decision);

      this.log(
        `    • ${decision.worker} → ${decision.effective.toUpperCase()} ` +
          `(verdict: ${decision.verdict}) — ${decision.classification.reason}`,
      );
      // Clause 5: a refusal is surfaced with a reason a human can act on, never swallowed.
      for (const b of decision.charter.breaches) {
        this.log(`      ↳ charter [${b.clause}] ${b.reason} FIX: ${b.remedy}`);
      }
      if (decision.governance?.downgradedFrom) {
        this.log(`      ↳ governance tightened ${decision.governance.downgradedFrom} → ${decision.verdict}: ${decision.governance.reason}`);
      }
    }

    return { queen: this.name, stream: this.stream, loopStep, decisions };
  }

  /**
   * governPayment() — the verify-only Payments MCP touch, WITHOUT moving money.
   *
   * Order is the contract:
   *   1. record_audit_entry FIRST. If the audit write fails, the action fails:
   *      verdict → 'human', effective → 'human-gate'. No money action exists
   *      without a prior audit entry (L1), so there is nothing to approve yet.
   *   2. verify_mandate + check_spend_cap. An invalid mandate or an over-cap
   *      answer takes 'act' away: verdict → 'escalate', effective raised to
   *      'founder-board'. Governance can only tighten; it never loosens.
   *   3. Anything that is not 'act' after that is handed to the human gate.
   */
  private async governPayment(decision: QueenDecision, report: WorkerReport, task: Task, payments: PaymentsMcp): Promise<void> {
    const amount = report.proposed.amount ?? 0;
    const governance: PaymentsGovernance = { audit: 'ok', mandate: 'skipped', cap: 'skipped' };
    decision.governance = governance;
    this.log('    ↳ Payments Queen runs verify-only governance (audit-first, fail-closed):');

    const audit = await payments.record_audit_entry({
      agent: this.name,
      stream: this.stream,
      task: task.id,
      note: `proposed ${report.proposed.kind} amount=${amount} verdict=${decision.verdict}`,
      timestamp: new Date().toISOString(),
    });
    if (!audit.ok) {
      governance.audit = 'failed';
      governance.downgradedFrom = decision.verdict;
      governance.reason = 'audit entry could not be written; no money action without a prior audit entry';
      decision.verdict = 'human';
      decision.effective = raiseTo(decision.effective, 'human-gate');
      await payments.require_human_approval(governance.reason);
      return;
    }

    const mandate = await payments.verify_mandate({ signature: 'dry-run', amount, purpose: task.description });
    governance.mandate = mandate.valid ? 'valid' : 'invalid';
    const cap = await payments.check_spend_cap(this.stream, amount);
    governance.cap = cap.withinCap ? 'within' : 'over';

    if (decision.verdict === 'act' && (!mandate.valid || !cap.withinCap)) {
      governance.downgradedFrom = 'act';
      governance.reason = !mandate.valid
        ? `mandate not verified: ${mandate.reason}`
        : `spend cap exceeded (amount=${amount} cap=${cap.cap})`;
      decision.verdict = 'escalate';
      decision.effective = raiseTo(decision.effective, 'founder-board');
    }

    if (decision.verdict !== 'act') {
      await payments.require_human_approval(governance.reason ?? decision.classification.reason);
    }
  }
}
