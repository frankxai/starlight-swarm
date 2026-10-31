/**
 * providers/anthropic.ts — Anthropic Managed Agents behind the port.
 *
 * Shapes follow the SDK's Managed Agents surface (`client.beta.agents`,
 * `client.beta.sessions`, `client.beta.sessions.events`; beta header
 * `managed-agents-2026-04-01`, set by the SDK):
 *
 *   provision → agents.create (once; model, system, tools live here)
 *   run       → sessions.create with a hard `budget` and `initial_events`
 *               (user.define_outcome when a rubric is set, else user.message),
 *               then events.stream until idle or terminated.
 *
 * Unattended posture: any tool_use paused for confirmation is DENIED. Web
 * search and fetch are off unless the spec asks for them. Custom tool calls
 * run through the injected `tools` executor; the sandbox never sees our keys.
 *
 * The client is injected so tests run with a fake and no network.
 */

import type Anthropic from '@anthropic-ai/sdk';
import type {
  AgentCreateParams,
  BetaManagedAgentsAgentToolset20260401Params,
  BetaManagedAgentsCustomToolParams,
} from '@anthropic-ai/sdk/resources/beta/agents/agents';
import type { SessionCreateParams } from '@anthropic-ai/sdk/resources/beta/sessions/sessions';
import type {
  BetaManagedAgentsEventParams,
  BetaManagedAgentsStreamSessionEvents,
} from '@anthropic-ai/sdk/resources/beta/sessions/events';

import type { AgentSpec, ManagedAgentRuntime, ProvisionedAgent, RunReceipt, RunRequest, RunStatus } from '../contract';
import { microUsdToCentsString, centsStringToMicroUsd } from '../budget';
import { sealReceipt } from '../receipts';

/** Executes a custom tool call on our side. Return text; throw to report an error. */
export type ToolExecutor = (name: string, input: unknown) => Promise<string>;

export interface AnthropicRuntimeOptions {
  environmentId: string;
  /** Vault ids holding credentials the agent may use. Never raw secrets. */
  vaultIds?: string[];
  tools?: ToolExecutor;
  clock?: () => Date;
}

export class AnthropicManagedAgentsRuntime implements ManagedAgentRuntime {
  readonly provider = 'anthropic' as const;

  constructor(
    private readonly client: Anthropic,
    private readonly options: AnthropicRuntimeOptions,
  ) {}

  async provision(spec: AgentSpec, model: string): Promise<ProvisionedAgent> {
    const toolset: BetaManagedAgentsAgentToolset20260401Params = {
      type: 'agent_toolset_20260401',
      default_config: { enabled: true, permission_policy: { type: 'auto' } },
      configs: [
        { name: 'web_fetch', enabled: spec.web },
        { name: 'web_search', enabled: spec.web },
      ],
    };
    const customTools: BetaManagedAgentsCustomToolParams[] = spec.tools.map((tool) => ({
      type: 'custom',
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema as BetaManagedAgentsCustomToolParams['input_schema'],
    }));

    const params: AgentCreateParams = {
      name: spec.name,
      model,
      system: spec.instructions,
      tools: [toolset, ...customTools],
      metadata: { ...spec.metadata, workload_class: spec.workloadClass },
    };
    const agent = await this.client.beta.agents.create(params);
    return { provider: this.provider, agentId: agent.id, version: agent.version };
  }

  async run(request: RunRequest, spec: AgentSpec): Promise<RunReceipt> {
    const clock = this.options.clock ?? (() => new Date());
    const startedAt = clock().toISOString();

    const kickoff: SessionCreateParams['initial_events'] = spec.outcomeRubric
      ? [
          {
            type: 'user.define_outcome',
            description: request.input,
            rubric: { type: 'text', content: spec.outcomeRubric },
          },
        ]
      : [{ type: 'user.message', content: [{ type: 'text', text: request.input }] }];

    const params: SessionCreateParams = {
      agent:
        request.agent.version === null
          ? request.agent.agentId
          : { type: 'agent', id: request.agent.agentId, version: request.agent.version },
      environment_id: this.options.environmentId,
      budget: {
        type: 'limit',
        max_list_cost: { amount: microUsdToCentsString(request.budget.reservedMicroUsd), currency: 'USD' },
      },
      initial_events: kickoff,
      metadata: { ...request.metadata, run_id: request.runId, workspace_id: request.workspaceId },
      title: `${spec.name} · ${request.runId}`,
      ...(this.options.vaultIds?.length ? { vault_ids: this.options.vaultIds } : {}),
    };

    const session = await this.client.beta.sessions.create(params);

    let status: RunStatus = 'error';
    let completed = false;
    const output: string[] = [];
    const usage = { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
    let costMicroUsd = 0;

    const stream = await this.client.beta.sessions.events.stream(session.id);
    const iterator = stream[Symbol.asyncIterator]();
    for (;;) {
      const step = await iterator.next();
      if (step.done) break;
      const event = step.value as BetaManagedAgentsStreamSessionEvents;

      if (event.type === 'agent.message') {
        for (const block of event.content) {
          if (block.type === 'text') output.push(block.text);
        }
      } else if (event.type === 'span.model_request_end') {
        usage.requests += 1;
      } else if (event.type === 'session.usage') {
        const snapshot = event.usage;
        usage.inputTokens = snapshot.input_tokens ?? usage.inputTokens;
        usage.outputTokens = snapshot.output_tokens ?? usage.outputTokens;
        usage.cacheReadTokens = snapshot.cache_read_input_tokens ?? usage.cacheReadTokens;
        if (snapshot.list_cost) costMicroUsd = centsStringToMicroUsd(snapshot.list_cost.amount);
      } else if (event.type === 'agent.tool_use' || event.type === 'agent.mcp_tool_use') {
        if (event.evaluated_permission === 'ask') {
          await this.send(session.id, [{ type: 'user.tool_confirmation', tool_use_id: event.id, result: 'deny' }]);
        }
      } else if (event.type === 'agent.custom_tool_use') {
        const result = await this.executeTool(event.name, event.input);
        await this.send(session.id, [
          {
            type: 'user.custom_tool_result',
            custom_tool_use_id: event.id,
            content: [{ type: 'text', text: result.text }],
            ...(result.isError ? { is_error: true } : {}),
          },
        ]);
      } else if (event.type === 'session.status_idle') {
        const reason = event.stop_reason.type;
        if (reason === 'requires_action') {
          // Something we did not resolve above is still pending; the loop continues.
          continue;
        }
        status =
          reason === 'end_turn'
            ? 'completed'
            : reason === 'budget_reached'
              ? 'budget_reached'
              : reason === 'refusal'
                ? 'refused'
                : 'error';
        completed = reason === 'end_turn';
        break;
      } else if (event.type === 'session.status_terminated') {
        status = completed ? 'completed' : 'error';
        break;
      } else if (event.type === 'session.error') {
        status = 'error';
        break;
      }
    }

    return sealReceipt({
      runId: request.runId,
      provider: this.provider,
      model: request.model,
      agentId: request.agent.agentId,
      externalId: session.id,
      status,
      usage,
      costMicroUsd,
      completed,
      outputText: output.join(''),
      startedAt,
      finishedAt: clock().toISOString(),
      composed: ['Anthropic Managed Agents session with hard list-cost budget'],
    });
  }

  private async send(sessionId: string, events: BetaManagedAgentsEventParams[]): Promise<void> {
    await this.client.beta.sessions.events.send(sessionId, { events });
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
