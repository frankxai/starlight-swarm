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
   *  - 'act'      → autonomous/queen-gate within scope and below caps; queen proceeds behind its gate.
   *  - 'escalate' → founder-board (cross-stream, over-cap, new rail/vendor).
   *  - 'human'    → human-gate (irreversible or money movement). Agents prepare; humans commit.
   */
  verdict: 'act' | 'escalate' | 'human';
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
   * decide() — the act-vs-escalate gate. Pure mapping from a classification to a
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
        verdict = 'act';
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
      const report = await chosen.run(task, mcp.vault);
      const decision = this.decide(report);
      decisions.push(decision);

      this.log(
        `    • ${decision.worker} → ${decision.classification.decision.toUpperCase()} ` +
          `(verdict: ${decision.verdict}) — ${decision.classification.reason}`,
      );

      // Demonstrate the verify-only Payments MCP touch WITHOUT moving money.
      if (this.stream === 'payments' && mcp.payments && report.proposed.movesMoney) {
        this.log('    ↳ Payments Queen runs verify-only governance (fail-closed):');
        await mcp.payments.verify_mandate({
          signature: 'dry-run',
          amount: report.proposed.amount ?? 0,
          purpose: task.description,
        });
        await mcp.payments.check_spend_cap(this.stream, report.proposed.amount ?? 0);
        if (decision.verdict !== 'act') {
          await mcp.payments.require_human_approval(decision.classification.reason);
        }
      }
    }

    return { queen: this.name, stream: this.stream, loopStep, decisions };
  }
}
