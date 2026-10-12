/**
 * providers.test.ts — the three adapters against fake clients.
 *
 * Each fake mirrors the documented SDK shape the adapter consumes. No network.
 * The tests lock the unattended posture (deny on ask), the agent-first rule,
 * budget conversion at the Anthropic boundary, and honest `completed` flags.
 *
 * Run:  node --test --import tsx src/managed-runtime/providers.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type Anthropic from '@anthropic-ai/sdk';

import { parseAgentSpec, parseRunRequest, RUN_REQUEST_SCHEMA_VERSION } from './contract';
import type { AgentSpec, RunRequest } from './contract';
import { verifyReceipt } from './receipts';
import { AnthropicManagedAgentsRuntime } from './providers/anthropic';
import { OpenAIAgentsRuntime } from './providers/openai';
import { GeminiManagedAgentsRuntime } from './providers/gemini';
import { DryRunRuntime } from './providers/dry-run';

const clock = () => new Date('2026-10-08T12:00:00Z');

const spec: AgentSpec = parseAgentSpec({
  name: 'Repo steward',
  instructions: 'Steward the repository. Leave receipts.',
  workloadClass: 'repo-steward',
  tools: [
    {
      name: 'run_tests',
      description: 'Run the test suite',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: true },
    },
  ],
});

function request(agent: { provider: RunRequest['agent']['provider']; agentId: string; version: number | null }, model = 'test-model'): RunRequest {
  return parseRunRequest({
    schemaVersion: RUN_REQUEST_SCHEMA_VERSION,
    runId: 'run-1',
    workspaceId: 'ws',
    actorId: 'frank',
    agent,
    model,
    input: 'Review the auth module',
    maxTurns: 3,
    budget: {
      reservationId: 'res-1',
      runId: 'run-1',
      workspaceId: 'ws',
      currency: 'USD',
      limitMicroUsd: 10_000_000,
      spentMicroUsdBefore: 0,
      reservedMicroUsd: 2_500_000,
      status: 'reserved',
      reservedAt: '2026-10-08T11:59:00Z',
    },
  });
}

/* ------------------------------------------------------------------ Anthropic */

function fakeAnthropic(events: unknown[]) {
  const calls: { agents: unknown[]; sessions: unknown[]; sent: unknown[] } = { agents: [], sessions: [], sent: [] };
  const client = {
    beta: {
      agents: {
        create: async (params: unknown) => {
          calls.agents.push(params);
          return { id: 'agent_abc', version: 3 };
        },
      },
      sessions: {
        create: async (params: unknown) => {
          calls.sessions.push(params);
          return { id: 'sess_123', status: 'idle' };
        },
        events: {
          send: async (_sessionId: string, params: unknown) => {
            calls.sent.push(params);
            return {};
          },
          stream: async () => ({
            [Symbol.asyncIterator]() {
              let index = 0;
              return {
                next: async () =>
                  index < events.length ? { done: false as const, value: events[index++] } : { done: true as const, value: undefined },
              };
            },
          }),
        },
      },
    },
  };
  return { client: client as unknown as Anthropic, calls };
}

test('anthropic: provision creates the agent once with web off and custom tools; run pins the version and converts the budget to cents', async () => {
  const { client, calls } = fakeAnthropic([
    { type: 'agent.message', content: [{ type: 'text', text: 'Looks good.' }] },
    { type: 'span.model_request_end' },
    {
      type: 'session.usage',
      usage: { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 800, list_cost: { amount: '37', currency: 'USD' } },
    },
    { type: 'session.status_idle', stop_reason: { type: 'end_turn' } },
  ]);
  const runtime = new AnthropicManagedAgentsRuntime(client, { environmentId: 'env_1', vaultIds: ['vault_1'], clock });

  const provisioned = await runtime.provision(spec, 'claude-sonnet-5-5');
  assert.deepEqual(provisioned, { provider: 'anthropic', agentId: 'agent_abc', version: 3 });
  const agentParams = calls.agents[0] as { tools: Array<Record<string, unknown>>; system: string; model: string };
  assert.equal(agentParams.model, 'claude-sonnet-5-5');
  assert.equal(agentParams.system, spec.instructions);
  const toolset = agentParams.tools[0] as { configs: Array<{ name: string; enabled: boolean }> };
  assert.deepEqual(
    toolset.configs.map((config) => [config.name, config.enabled]),
    [
      ['web_fetch', false],
      ['web_search', false],
    ],
  );
  assert.equal((agentParams.tools[1] as { name: string }).name, 'run_tests');

  const receipt = await runtime.run(request(provisioned), spec);
  const sessionParams = calls.sessions[0] as {
    agent: unknown;
    budget: { max_list_cost: { amount: string; currency: string } };
    initial_events: Array<{ type: string }>;
    vault_ids: string[];
  };
  assert.deepEqual(sessionParams.agent, { type: 'agent', id: 'agent_abc', version: 3 });
  assert.deepEqual(sessionParams.budget.max_list_cost, { amount: '250', currency: 'USD' });
  assert.equal(sessionParams.initial_events[0].type, 'user.message');
  assert.deepEqual(sessionParams.vault_ids, ['vault_1']);

  assert.equal(receipt.status, 'completed');
  assert.equal(receipt.completed, true);
  assert.equal(receipt.outputText, 'Looks good.');
  assert.equal(receipt.externalId, 'sess_123');
  assert.deepEqual(receipt.usage, { requests: 1, inputTokens: 1200, outputTokens: 300, cacheReadTokens: 800 });
  assert.equal(receipt.costMicroUsd, 370_000);
  assert.ok(receipt.attestation.composed.some((element) => /Managed Agents/.test(element)));
  assert.equal(verifyReceipt(receipt), true);
});

test('anthropic: an outcome rubric kicks off with user.define_outcome', async () => {
  const { client, calls } = fakeAnthropic([{ type: 'session.status_idle', stop_reason: { type: 'end_turn' } }]);
  const runtime = new AnthropicManagedAgentsRuntime(client, { environmentId: 'env_1', clock });
  const withRubric = parseAgentSpec({ ...spec, outcomeRubric: '- report.md exists' });
  const provisioned = await runtime.provision(withRubric, 'claude-sonnet-5-5');
  await runtime.run(request(provisioned), withRubric);
  const sessionParams = calls.sessions[0] as { initial_events: Array<{ type: string; rubric?: { content: string } }> };
  assert.equal(sessionParams.initial_events[0].type, 'user.define_outcome');
  assert.equal(sessionParams.initial_events[0].rubric?.content, '- report.md exists');
});

test('anthropic: paused tool use is denied when unattended; custom tools run through the executor', async () => {
  const { client, calls } = fakeAnthropic([
    { type: 'agent.tool_use', id: 'evt_tool', evaluated_permission: 'ask' },
    { type: 'agent.custom_tool_use', id: 'evt_custom', name: 'run_tests', input: { path: 'src' } },
    { type: 'session.status_idle', stop_reason: { type: 'requires_action' } },
    { type: 'session.status_idle', stop_reason: { type: 'end_turn' } },
  ]);
  const executed: unknown[] = [];
  const runtime = new AnthropicManagedAgentsRuntime(client, {
    environmentId: 'env_1',
    clock,
    tools: async (name, input) => {
      executed.push([name, input]);
      return '42 passed';
    },
  });
  const provisioned = await runtime.provision(spec, 'claude-sonnet-5-5');
  const receipt = await runtime.run(request(provisioned), spec);

  const sent = calls.sent as Array<{ events: Array<Record<string, unknown>> }>;
  assert.deepEqual(sent[0].events[0], { type: 'user.tool_confirmation', tool_use_id: 'evt_tool', result: 'deny' });
  assert.equal(sent[1].events[0].type, 'user.custom_tool_result');
  assert.equal(sent[1].events[0].custom_tool_use_id, 'evt_custom');
  assert.deepEqual(executed, [['run_tests', { path: 'src' }]]);
  assert.equal(receipt.status, 'completed');
});

test('anthropic: budget_reached and refusal are honest statuses with completed:false', async () => {
  for (const [stop, expected] of [
    ['budget_reached', 'budget_reached'],
    ['refusal', 'refused'],
    ['retries_exhausted', 'error'],
  ] as const) {
    const { client } = fakeAnthropic([{ type: 'session.status_idle', stop_reason: { type: stop } }]);
    const runtime = new AnthropicManagedAgentsRuntime(client, { environmentId: 'env_1', clock });
    const provisioned = await runtime.provision(spec, 'claude-sonnet-5-5');
    const receipt = await runtime.run(request(provisioned), spec);
    assert.equal(receipt.status, expected);
    assert.equal(receipt.completed, false);
  }
});

test('anthropic: a missing executor reports the custom tool call as an error result instead of hanging', async () => {
  const { client, calls } = fakeAnthropic([
    { type: 'agent.custom_tool_use', id: 'evt_custom', name: 'run_tests', input: {} },
    { type: 'session.status_terminated' },
  ]);
  const runtime = new AnthropicManagedAgentsRuntime(client, { environmentId: 'env_1', clock });
  const provisioned = await runtime.provision(spec, 'claude-sonnet-5-5');
  const receipt = await runtime.run(request(provisioned), spec);
  const sent = calls.sent as Array<{ events: Array<Record<string, unknown>> }>;
  assert.equal(sent[0].events[0].is_error, true);
  assert.equal(receipt.status, 'error');
});

/* --------------------------------------------------------------------- OpenAI */

test('openai: provision stores the agent locally; run reads usage from run state and the last response id', async () => {
  const runs: Array<{ name: string; input: string; maxTurns: number }> = [];
  const runtime = new OpenAIAgentsRuntime({
    clock,
    runFn: async (agent, input, options) => {
      runs.push({ name: agent.name, input, maxTurns: options.maxTurns });
      return {
        finalOutput: 'Done.',
        state: { usage: { requests: 2, inputTokens: 500, outputTokens: 120, inputTokensDetails: [{ cached_tokens: 100 }, { cached_tokens: 50 }] } },
        rawResponses: [{ responseId: 'resp_1' }, { responseId: 'resp_2' }],
      };
    },
  });
  const provisioned = await runtime.provision(spec, 'default');
  assert.equal(provisioned.provider, 'openai');
  assert.equal(provisioned.version, null);

  const receipt = await runtime.run(request(provisioned, 'default'), spec);
  assert.deepEqual(runs, [{ name: 'Repo steward', input: 'Review the auth module', maxTurns: 3 }]);
  assert.equal(receipt.status, 'completed');
  assert.equal(receipt.completed, true);
  assert.equal(receipt.outputText, 'Done.');
  assert.equal(receipt.externalId, 'resp_2');
  assert.deepEqual(receipt.usage, { requests: 2, inputTokens: 500, outputTokens: 120, cacheReadTokens: 150 });
  assert.equal(receipt.costMicroUsd, 0);
  assert.equal(verifyReceipt(receipt), true);
});

test('openai: a thrown run becomes an error receipt, never a completed one', async () => {
  const runtime = new OpenAIAgentsRuntime({
    clock,
    runFn: async () => {
      throw new Error('MaxTurnsExceeded');
    },
  });
  const provisioned = await runtime.provision(spec, 'default');
  const receipt = await runtime.run(request(provisioned, 'default'), spec);
  assert.equal(receipt.status, 'error');
  assert.equal(receipt.completed, false);
  assert.match(receipt.outputText, /MaxTurnsExceeded/);
});

test('openai: running an agent this runtime did not provision throws', async () => {
  const runtime = new OpenAIAgentsRuntime({ clock, runFn: async () => ({ state: { usage: { requests: 0, inputTokens: 0, outputTokens: 0, inputTokensDetails: [] } }, rawResponses: [] }) });
  await assert.rejects(
    runtime.run(request({ provider: 'openai', agentId: 'openai_agent_999', version: null }, 'default'), spec),
    /not provisioned/,
  );
});

/* --------------------------------------------------------------------- Gemini */

test('gemini: function calls round-trip through previous_interaction_id until the agent stops calling', async () => {
  const created: Array<Record<string, unknown>> = [];
  const responses = [
    {
      id: 'int_1',
      outputs: [{ type: 'function_call', id: 'call_1', name: 'run_tests', arguments: { path: 'src' } }],
      usage: { total_input_tokens: 100, total_output_tokens: 20 },
    },
    { id: 'int_2', output_text: 'All green.', outputs: [{ type: 'text', text: 'All green.' }], usage: { total_input_tokens: 50, total_output_tokens: 10, total_cached_tokens: 30 } },
  ];
  const client = {
    interactions: {
      create: async (params: Record<string, unknown>) => {
        created.push(params);
        return responses[created.length - 1];
      },
    },
  };
  const executed: unknown[] = [];
  const runtime = new GeminiManagedAgentsRuntime(client, {
    clock,
    tools: async (name, input) => {
      executed.push([name, input]);
      return 'ok';
    },
  });
  const provisioned = await runtime.provision(spec, 'gemini-flash-latest');
  const receipt = await runtime.run(request(provisioned, 'gemini-flash-latest'), spec);

  assert.equal(created.length, 2);
  assert.equal(created[0].agent, 'antigravity-preview-05-2026');
  assert.equal(created[0].input, 'Review the auth module');
  assert.equal(created[1].previous_interaction_id, 'int_1');
  const results = created[1].input as Array<Record<string, unknown>>;
  assert.equal(results[0].type, 'function_result');
  assert.equal(results[0].call_id, 'call_1');
  assert.deepEqual(executed, [['run_tests', { path: 'src' }]]);

  assert.equal(receipt.status, 'completed');
  assert.equal(receipt.completed, true);
  assert.equal(receipt.outputText, 'All green.');
  assert.equal(receipt.externalId, 'int_2');
  assert.deepEqual(receipt.usage, { requests: 2, inputTokens: 150, outputTokens: 30, cacheReadTokens: 30 });
  assert.equal(verifyReceipt(receipt), true);
});

test('gemini: maxTurns caps the round trips and leaves requires_action, not completed', async () => {
  let calls = 0;
  const client = {
    interactions: {
      create: async () => {
        calls += 1;
        return { id: `int_${calls}`, outputs: [{ type: 'function_call', id: `c${calls}`, name: 'run_tests', arguments: {} }] };
      },
    },
  };
  const runtime = new GeminiManagedAgentsRuntime(client, { clock, tools: async () => 'ok' });
  const provisioned = await runtime.provision(spec, 'gemini-flash-latest');
  const receipt = await runtime.run(request(provisioned, 'gemini-flash-latest'), spec);
  assert.equal(calls, 4); // 1 initial + maxTurns (3) round trips
  assert.equal(receipt.status, 'requires_action');
  assert.equal(receipt.completed, false);
});

test('gemini: a thrown create becomes an error receipt', async () => {
  const client = {
    interactions: {
      create: async () => {
        throw new Error('quota');
      },
    },
  };
  const runtime = new GeminiManagedAgentsRuntime(client, { clock });
  const provisioned = await runtime.provision(spec, 'gemini-flash-latest');
  const receipt = await runtime.run(request(provisioned, 'gemini-flash-latest'), spec);
  assert.equal(receipt.status, 'error');
  assert.match(receipt.outputText, /quota/);
});

/* -------------------------------------------------------------------- Dry-run */

test('dry-run: never completes, never costs, always verifies', async () => {
  const runtime = new DryRunRuntime(clock);
  const provisioned = await runtime.provision(spec, 'dry-run');
  const receipt = await runtime.run(request(provisioned, 'dry-run'), spec);
  assert.equal(receipt.status, 'dry-run');
  assert.equal(receipt.completed, false);
  assert.equal(receipt.costMicroUsd, 0);
  assert.equal(verifyReceipt(receipt), true);
});
