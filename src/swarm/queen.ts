/**
 * queen.ts — Stream Queen tier (Tier 2 of the agent stack).
 *
 * Each queen reuses the `queen-coordinator` + `hierarchical-coordinator` harness
 * patterns (claude-flow), scoped to ONE income stream. A queen:
 *   - owns a mesh of stateless workers,
 *   - runs a self-improving loop step,
 *   - decides gate-ready-vs-escalate for every proposed action via classify(),
 *   - NEVER commands across streams (coordinates through the founder),
 *   - NEVER moves money autonomously.
 *
 * v0.1 scaffold: stepLoop() drives workers to PROPOSE actions, then classifies
 * each proposal. It executes nothing gated. Money + irreversibility always route
 * up the escalation ladder. No real side effects.
 */

import { classify, requiresPaymentGovernance } from './escalation';
import type { Classification, StreamId } from './escalation';
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
   *  - 'gate-ready' → proposal may continue to its local gate/review; this is not live execution.
   *  - 'escalate'   → founder-board (cross-stream, over-cap, new rail/vendor).
   *  - 'human'      → human-gate (irreversible or money movement). Agents prepare; humans commit.
   */
  verdict: 'gate-ready' | 'escalate' | 'human';
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
  /** Required for any payment-governed proposal. Verify-only; missing handle fails closed. */
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
  private readonly workers: Worker[];
  private readonly log: (m: string) => void;

  constructor(spec: StreamSpec, log: (m: string) => void = () => {}) {
    this.name = spec.queen.name;
    this.stream = spec.id;
    this.loop = spec.queen.selfImprovingLoop;
    this.log = log;
    // Build the worker mesh from config. Each worker is stateless + single-skill.
    this.workers = spec.workers.map((w) => makeWorker(w.name, spec.id, w.skill));
  }

  /** The worker roster (read-only view). */
  roster(): ReadonlyArray<Worker> {
    return this.workers;
  }

  /**
   * decide() — the gate-ready-vs-escalate gate. Pure mapping from a classification to a
   * queen verdict. This is where the escalation contract becomes the queen's
   * discipline: anything beyond scope/caps leaves the queen's hands.
   */
  decide(report: WorkerReport): QueenDecision {
    const classification = classify(report.proposed);
    let verdict: QueenDecision['verdict'];
    switch (classification.decision) {
      case 'human-gate':
        verdict = 'human';
        break;
      case 'founder-board':
        verdict = 'escalate';
        break;
      case 'autonomous':
      case 'queen-gate':
      default:
        verdict = 'gate-ready';
        break;
    }
    return { worker: report.worker, taskId: report.taskId, classification, verdict };
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
      const decision = await this.enforcePaymentGovernance(report, task, mcp, this.decide(report));
      decisions.push(decision);

      this.log(
        `    • ${decision.worker} → ${decision.classification.decision.toUpperCase()} ` +
          `(verdict: ${decision.verdict}) — ${decision.classification.reason}`,
      );
    }

    return { queen: this.name, stream: this.stream, loopStep, decisions };
  }

  private async enforcePaymentGovernance(
    report: WorkerReport,
    task: Task,
    mcp: QueenMcp,
    decision: QueenDecision,
  ): Promise<QueenDecision> {
    if (!requiresPaymentGovernance(report.proposed)) {
      return decision;
    }

    this.log('    ↳ Payment governance runs verify-only checks (fail-closed):');

    if (!mcp.payments) {
      return this.blockPayment(decision, 'Payments MCP unavailable; payment governance cannot be proven.');
    }

    try {
      const amount = report.proposed.amount ?? 0;
      const proof = {
        signature: 'dry-run',
        amount,
        purpose: task.description,
      };

      const mandate = await mcp.payments.verify_mandate(proof);
      const cap = await mcp.payments.check_spend_cap(this.stream, amount);

      if (!mandate.valid) {
        await mcp.payments.require_human_approval(mandate.reason);
        return this.blockPayment(decision, `Mandate verification failed: ${mandate.reason}`);
      }

      if (!cap.withinCap) {
        await mcp.payments.require_human_approval(`Spend cap failed for amount ${amount}; cap is ${cap.cap}.`);
        return this.escalatePayment(decision, `Spend cap failed for amount ${amount}; cap is ${cap.cap}.`);
      }

      if (decision.verdict !== 'gate-ready') {
        await mcp.payments.require_human_approval(decision.classification.reason);
        return decision;
      }

      const audit = await mcp.payments.record_audit_entry({
        agent: this.name,
        stream: this.stream,
        task: task.id,
        note: `payment governance passed for ${report.worker}: ${task.description}`,
        timestamp: new Date().toISOString(),
      });

      if (!audit.ok) {
        await mcp.payments.require_human_approval('Payment audit entry failed; action cannot remain autonomous.');
        return this.blockPayment(decision, 'Payment audit entry failed; action cannot remain autonomous.');
      }
    } catch (err) {
      const reason = `Payments MCP threw during governance: ${(err as Error).message}`;
      try {
        await mcp.payments.require_human_approval(reason);
      } catch {
        // If the escalation note itself fails, the local verdict still fails closed.
      }
      return this.blockPayment(decision, reason);
    }

    return decision;
  }

  private blockPayment(decision: QueenDecision, reason: string): QueenDecision {
    return {
      ...decision,
      verdict: 'human',
      classification: {
        decision: 'human-gate',
        reason: `Payment governance failed closed. ${reason}`,
        gates: [...decision.classification.gates, 'human.approval'],
      },
    };
  }

  private escalatePayment(decision: QueenDecision, reason: string): QueenDecision {
    return {
      ...decision,
      verdict: 'escalate',
      classification: {
        decision: 'founder-board',
        reason: `Payment governance failed closed. ${reason}`,
        gates: [
          'payments-mcp.verify_mandate',
          'payments-mcp.check_spend_cap',
          'founder.review',
          'starlight-board.pressure-test',
          'human.approval',
        ],
      },
    };
  }
}
