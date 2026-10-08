/**
 * providers/dry-run.ts — the in-process provider.
 *
 * Runs nothing. Produces a receipt with `status: 'dry-run'`, `completed:
 * false`, zero usage, zero cost. Exists so the router, budget, receipt, and
 * portfolio code can be exercised end to end with no network and no keys.
 */

import type { AgentSpec, ManagedAgentRuntime, ProvisionedAgent, RunReceipt, RunRequest } from '../contract';
import { sealReceipt } from '../receipts';

export class DryRunRuntime implements ManagedAgentRuntime {
  readonly provider = 'dry-run' as const;
  private counter = 0;

  constructor(private readonly clock: () => Date = () => new Date()) {}

  async provision(spec: AgentSpec, _model?: string): Promise<ProvisionedAgent> {
    this.counter += 1;
    return { provider: this.provider, agentId: `dryrun_agent_${this.counter}_${slug(spec.name)}`, version: 0 };
  }

  async run(request: RunRequest, spec: AgentSpec): Promise<RunReceipt> {
    const at = this.clock().toISOString();
    return sealReceipt({
      runId: request.runId,
      provider: this.provider,
      model: request.model,
      agentId: request.agent.agentId,
      externalId: `dryrun_${request.runId}`,
      status: 'dry-run',
      usage: { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 },
      costMicroUsd: 0,
      completed: false,
      outputText: `[dry-run] would run "${spec.name}" (${spec.workloadClass}) with input: ${request.input.slice(0, 80)}`,
      startedAt: at,
      finishedAt: at,
      composed: ['dry-run provider (no model called)'],
    });
  }
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'agent';
}
