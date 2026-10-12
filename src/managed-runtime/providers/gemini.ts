/**
 * providers/gemini.ts — Gemini managed agents behind the port.
 *
 * Uses the GenAI SDK's Interactions API (`client.interactions.create`) with
 * the Antigravity managed agent, which runs in a Google-hosted Linux sandbox.
 * Managed agents on the Gemini API have no stored-agent object: the agent id
 * and the instructions travel on each interaction, so `provision` records
 * the spec locally and `run` sends it. `previous_interaction_id` carries
 * continuity across function-call round trips.
 *
 * Function calls the agent makes come back as `function_call` outputs; this
 * adapter executes them through the injected executor and replies with
 * `function_result` steps, up to `maxTurns` rounds.
 *
 * Usage fields are read from the interaction's `usage` when present. The
 * Gemini API does not return a list cost on the object, so `costMicroUsd` is
 * zero, which the receipt documents as "not reported".
 *
 * The client is injected so tests run with a fake and no network.
 */

import type { GoogleGenAI } from '@google/genai';

import type { AgentSpec, ManagedAgentRuntime, ProvisionedAgent, RunReceipt, RunRequest } from '../contract';
import { GEMINI_MANAGED_AGENT } from '../router';
import { sealReceipt } from '../receipts';

export type ToolExecutor = (name: string, input: unknown) => Promise<string>;

/** The shape of the interaction fields this adapter reads. Kept local so SDK type churn stays here. */
export interface InteractionLike {
  id: string;
  status?: string;
  output_text?: string;
  outputs?: Array<{
    type: string;
    id?: string;
    name?: string;
    arguments?: Record<string, unknown>;
    text?: string;
  }>;
  usage?: {
    total_input_tokens?: number;
    total_output_tokens?: number;
    total_cached_tokens?: number;
  };
}

/** The subset of the SDK client the adapter calls. `GoogleGenAI` satisfies it structurally. */
export interface GeminiInteractionsClient {
  interactions: {
    create(params: Record<string, unknown>): Promise<unknown>;
  };
}

/** Wrap a real `GoogleGenAI` client in the subset the adapter calls. */
export function fromGoogleGenAI(ai: GoogleGenAI): GeminiInteractionsClient {
  type CreateParams = Parameters<GoogleGenAI['interactions']['create']>[0];
  return {
    interactions: {
      create: (params) => ai.interactions.create(params as unknown as CreateParams) as Promise<unknown>,
    },
  };
}

export interface GeminiRuntimeOptions {
  tools?: ToolExecutor;
  /** Managed agent id. Defaults to the Antigravity agent id from the SDK's `AgentOption` type. */
  agent?: string;
  clock?: () => Date;
}

export class GeminiManagedAgentsRuntime implements ManagedAgentRuntime {
  readonly provider = 'gemini' as const;
  private readonly specs = new Map<string, { spec: AgentSpec; model: string }>();
  private counter = 0;

  constructor(
    private readonly client: GeminiInteractionsClient,
    private readonly options: GeminiRuntimeOptions = {},
  ) {}

  async provision(spec: AgentSpec, model: string): Promise<ProvisionedAgent> {
    this.counter += 1;
    const agentId = `gemini_agent_${this.counter}`;
    this.specs.set(agentId, { spec, model });
    return { provider: this.provider, agentId, version: null };
  }

  async run(request: RunRequest, spec: AgentSpec): Promise<RunReceipt> {
    const clock = this.options.clock ?? (() => new Date());
    const startedAt = clock().toISOString();
    if (!this.specs.has(request.agent.agentId)) {
      throw new Error(`Agent ${request.agent.agentId} was not provisioned by this runtime.`);
    }

    const tools = spec.tools.map((definition) => ({
      type: 'function',
      name: definition.name,
      description: definition.description,
      parameters: definition.inputSchema,
    }));

    const usage = { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
    const output: string[] = [];
    let status: RunReceipt['status'] = 'completed';
    let externalId = `gemini_interaction_${request.runId}`;

    try {
      let interaction = (await this.client.interactions.create({
        agent: this.options.agent ?? GEMINI_MANAGED_AGENT,
        agent_config: { type: 'antigravity', system_instruction: spec.instructions },
        input: request.input,
        tools,
        labels: { run_id: request.runId.toLowerCase().replace(/[^a-z0-9_-]/g, '-') },
      })) as InteractionLike;
      usage.requests += 1;
      externalId = interaction.id;
      this.absorb(interaction, usage, output);

      for (let turn = 0; turn < request.maxTurns; turn += 1) {
        const calls = (interaction.outputs ?? []).filter((item) => item.type === 'function_call');
        if (!calls.length) break;

        const results = [];
        for (const call of calls) {
          const executed = await this.executeTool(call.name ?? '', call.arguments ?? {});
          results.push({
            type: 'function_result',
            name: call.name,
            call_id: call.id,
            result: executed.text,
            ...(executed.isError ? { is_error: true } : {}),
          });
        }

        interaction = (await this.client.interactions.create({
          agent: this.options.agent ?? GEMINI_MANAGED_AGENT,
          previous_interaction_id: interaction.id,
          input: results,
          tools,
        })) as InteractionLike;
        usage.requests += 1;
        externalId = interaction.id;
        this.absorb(interaction, usage, output);
      }

      if ((interaction.outputs ?? []).some((item) => item.type === 'function_call')) {
        status = 'requires_action';
      } else if (interaction.status && !/^(completed|succeeded|done)$/i.test(interaction.status)) {
        status = 'error';
      }
    } catch (error) {
      status = 'error';
      output.push(error instanceof Error ? error.message : String(error));
    }

    return sealReceipt({
      runId: request.runId,
      provider: this.provider,
      model: request.model,
      agentId: request.agent.agentId,
      externalId,
      status,
      usage,
      costMicroUsd: 0,
      completed: status === 'completed',
      outputText: output.join(''),
      startedAt,
      finishedAt: clock().toISOString(),
      composed: ['Gemini managed agent interaction (Antigravity sandbox)'],
    });
  }

  private absorb(interaction: InteractionLike, usage: RunReceipt['usage'], output: string[]): void {
    if (interaction.output_text) output.push(interaction.output_text);
    for (const item of interaction.outputs ?? []) {
      if (item.type === 'text' && item.text && !interaction.output_text) output.push(item.text);
    }
    const measured = interaction.usage;
    if (measured) {
      usage.inputTokens += measured.total_input_tokens ?? 0;
      usage.outputTokens += measured.total_output_tokens ?? 0;
      usage.cacheReadTokens += measured.total_cached_tokens ?? 0;
    }
  }

  private async executeTool(name: string, input: unknown): Promise<{ text: string; isError: boolean }> {
    if (!this.options.tools) {
      return { text: `No executor configured for tool ${name}.`, isError: true };
    }
    try {
      return { text: await this.options.tools(name, input), isError: false };
    } catch (error) {
      return { text: error instanceof Error ? error.message : String(error), isError: true };
    }
  }
}
