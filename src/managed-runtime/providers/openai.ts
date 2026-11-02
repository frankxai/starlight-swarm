/**
 * providers/openai.ts — the OpenAI Agents SDK behind the port.
 *
 * The Agents SDK supplies the harness (loop, handoffs, guardrails, tracing)
 * over the Responses API; we host it. There is no server-side stored agent,
 * so `provision` builds the `Agent` in memory and keeps it in a local
 * registry keyed by the id we return. `run` calls `run(agent, input, {
 * maxTurns })` and reads `result.state.usage` for the receipt.
 *
 * Custom tools from the spec are exposed through `tool()` with the spec's
 * JSON schema as parameters and executed by the injected executor.
 *
 * AgentKit's Agent Builder and Evals are scheduled to stop on 30 November
 * 2026 per OpenAI's notice; nothing here depends on them.
 *
 * `runFn` is injected so tests run with a fake and no network.
 */

import { Agent, run, tool } from '@openai/agents';

import type { AgentSpec, ManagedAgentRuntime, ProvisionedAgent, RunReceipt, RunRequest } from '../contract';
import { sealReceipt } from '../receipts';

export type ToolExecutor = (name: string, input: unknown) => Promise<string>;

/** Mirrors the SDK's `JsonObjectSchemaNonStrict`, which is not re-exported from the package root. */
type NonStrictJsonSchema = {
  type: 'object';
  properties: Record<string, Record<string, unknown>>;
  required: string[];
  additionalProperties: true;
  description?: string;
};

/** The usage fields this adapter reads from `result.state.usage`. */
export interface UsageLike {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  inputTokensDetails: Array<Record<string, number>>;
}

/** The subset of a run result this adapter reads. The SDK's `RunResult` satisfies it. */
export interface RunResultLike {
  finalOutput?: unknown;
  state: { usage: UsageLike };
  rawResponses: Array<{ responseId?: string }>;
}

/** The subset of `run()` this adapter depends on. The real `run` satisfies it. */
export type RunFn = (agent: Agent, input: string, options: { maxTurns: number }) => Promise<RunResultLike>;

export interface OpenAIRuntimeOptions {
  tools?: ToolExecutor;
  runFn?: RunFn;
  clock?: () => Date;
}

export class OpenAIAgentsRuntime implements ManagedAgentRuntime {
  readonly provider = 'openai' as const;
  private readonly agents = new Map<string, Agent>();
  private counter = 0;

  constructor(private readonly options: OpenAIRuntimeOptions = {}) {}

  async provision(spec: AgentSpec, model: string): Promise<ProvisionedAgent> {
    const executor = this.options.tools;
    const tools = spec.tools.map((definition) =>
      tool({
        name: definition.name,
        description: definition.description,
        // Non-strict JSON schema: the spec supplies plain JSON Schema; the SDK validates shape at run time.
        parameters: definition.inputSchema as unknown as NonStrictJsonSchema,
        strict: false,
        async execute(input: unknown) {
          if (!executor) return `No executor configured for tool ${definition.name}.`;
          return executor(definition.name, input);
        },
      }),
    );

    // An empty or placeholder model lets the SDK apply its own default.
    const modelOption = model && model !== 'default' ? { model } : {};
    const agent = new Agent({
      name: spec.name,
      instructions: spec.instructions,
      tools,
      ...modelOption,
    });

    this.counter += 1;
    const agentId = `openai_agent_${this.counter}`;
    this.agents.set(agentId, agent);
    return { provider: this.provider, agentId, version: null };
  }

  async run(request: RunRequest, spec: AgentSpec): Promise<RunReceipt> {
    const clock = this.options.clock ?? (() => new Date());
    const startedAt = clock().toISOString();
    const agent = this.agents.get(request.agent.agentId);
    if (!agent) {
      throw new Error(`Agent ${request.agent.agentId} was not provisioned by this runtime.`);
    }

    const runFn: RunFn = this.options.runFn ?? ((a, input, options) => run(a, input, options));
    let status: RunReceipt['status'] = 'completed';
    let outputText = '';
    const usage = { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
    let externalId = `openai_run_${request.runId}`;

    try {
      const result = await runFn(agent, request.input, { maxTurns: request.maxTurns });
      const final = result.finalOutput;
      outputText = typeof final === 'string' ? final : final === undefined ? '' : JSON.stringify(final);
      const measured = result.state.usage;
      usage.requests = measured.requests;
      usage.inputTokens = measured.inputTokens;
      usage.outputTokens = measured.outputTokens;
      usage.cacheReadTokens = measured.inputTokensDetails.reduce(
        (sum, detail) => sum + (detail.cached_tokens ?? 0),
        0,
      );
      const lastResponse = result.rawResponses[result.rawResponses.length - 1];
      if (lastResponse?.responseId) externalId = lastResponse.responseId;
    } catch (error) {
      status = 'error';
      outputText = error instanceof Error ? error.message : String(error);
    }

    return sealReceipt({
      runId: request.runId,
      provider: this.provider,
      model: request.model,
      agentId: request.agent.agentId,
      externalId,
      status,
      usage,
      // The Agents SDK reports tokens, not list cost. Zero means "not reported", never "free".
      costMicroUsd: 0,
      completed: status === 'completed',
      outputText,
      startedAt,
      finishedAt: clock().toISOString(),
      composed: [`OpenAI Agents SDK run (${spec.workloadClass})`],
    });
  }
}
