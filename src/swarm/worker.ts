/**
 * worker.ts — Worker tier (Tier 3 of the agent stack).
 *
 * Reuses the `worker-specialist` pattern. A worker does exactly one job, reports
 * progress through shared memory (SIS vault, append-only), and NEVER moves money
 * or publishes without its queen's gate. Workers are stateless between tasks —
 * all state lives in the vault.
 *
 * v0.1 scaffold: a worker proposes an Action; it never executes a gated one and
 * never self-gates. The queen decides whether the proposal proceeds.
 */

import type { Action, StreamId } from './escalation';
import type { SisVaultMcp, VaultEntry } from './integrations';

/** A unit of work a worker can carry out. */
export interface Task {
  id: string;
  description: string;
  /** Optional hint: the worker role this task should be routed to. */
  worker?: string;
  /** The action the worker would take to satisfy the task. */
  proposes: Action;
}

/** Outcome of a worker run — a proposal handed up to the queen, never executed. */
export interface WorkerReport {
  worker: string;
  stream: StreamId;
  taskId: string;
  /** The action proposed, for the queen to classify and gate. */
  proposed: Action;
  /** What the worker did (always read/draft only in v0.1). */
  note: string;
}

/**
 * A worker config. `skill` names the single ACOS skill it wraps. The worker has
 * NO payment MCP access by IAM (PROTECTION-LAYERS L3) — only append-only vault.
 */
export interface Worker {
  name: string;
  stream: StreamId;
  /** The single skill this worker is scoped to. */
  skill: string;
  /**
   * run() does the one job. In v0.1 it only drafts/audits/researches and
   * appends to the vault, then returns a proposal. It NEVER gates itself and
   * NEVER fires a money or publish action.
   */
  run(task: Task, vault: SisVaultMcp): Promise<WorkerReport>;
}

/** Factory for a stateless dry-run worker. */
export function makeWorker(name: string, stream: StreamId, skill: string): Worker {
  return {
    name,
    stream,
    skill,
    async run(task, vault) {
      const entry: VaultEntry = {
        agent: name,
        stream,
        task: task.id,
        note: `worker drafted: ${task.description}`,
        timestamp: new Date().toISOString(),
      };
      // Append-only memory write — the only side effect a worker is allowed.
      await vault.sis_append_entry(entry);
      return {
        worker: name,
        stream,
        taskId: task.id,
        proposed: task.proposes,
        note: `Drafted via skill "${skill}". Proposal handed to ${stream} queen for gating.`,
      };
    },
  };
}
