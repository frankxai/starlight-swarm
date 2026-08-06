import { parseHandContract } from './hand-contract';
import type { HandContract } from './hand-contract';

export interface CompiledHermesHandJob {
  schema_version: 'starlight.hermes-hand-job.v1';
  hand_id: string;
  name: string;
  enabled: false;
  schedule: string;
  repeat: number;
  deliver: 'local';
  attach_to_session: false;
  enabled_toolsets: ['web'];
  prompt: string;
}

function stable(value: unknown): string {
  return JSON.stringify(value, (_key, nested) => {
    if (Array.isArray(nested) && nested.every((entry) => typeof entry === 'string')) {
      return [...nested].sort();
    }
    return nested;
  });
}

function comparableProjection(hand: HandContract): unknown {
  return {
    mode: hand.mode,
    enabled: hand.enabled,
    mission: hand.mission,
    schedule: hand.schedule,
    capabilities: hand.capabilities,
    memory: hand.memory,
    execution: {
      max_minutes: hand.execution.max_minutes,
      max_model_cost_usd: hand.execution.max_model_cost_usd,
      max_tool_calls: hand.execution.max_tool_calls,
    },
    phases: hand.phases,
    human_gates: hand.human_gates,
    receipt: hand.receipt,
  };
}

export function assertComparableHands(hermesInput: unknown, openfangInput: unknown): void {
  const hermes = parseHandContract(hermesInput);
  const openfang = parseHandContract(openfangInput);
  if (hermes.runtime !== 'hermes-cron') {
    throw new Error(`Hermes comparison contract has runtime ${hermes.runtime}`);
  }
  if (openfang.runtime !== 'openfang-sidecar') {
    throw new Error(`OpenFang comparison contract has runtime ${openfang.runtime}`);
  }

  const fields: Array<[string, unknown, unknown]> = [
    ['mission', hermes.mission, openfang.mission],
    ['schedule', hermes.schedule, openfang.schedule],
    ['capabilities', hermes.capabilities, openfang.capabilities],
    ['memory', hermes.memory, openfang.memory],
    ['max_minutes', hermes.execution.max_minutes, openfang.execution.max_minutes],
    [
      'max_model_cost_usd',
      hermes.execution.max_model_cost_usd,
      openfang.execution.max_model_cost_usd,
    ],
    ['max_tool_calls', hermes.execution.max_tool_calls, openfang.execution.max_tool_calls],
    ['phases', hermes.phases, openfang.phases],
    ['human_gates', hermes.human_gates, openfang.human_gates],
    ['receipt', hermes.receipt, openfang.receipt],
  ];

  for (const [name, left, right] of fields) {
    if (stable(left) !== stable(right)) {
      throw new Error(`Pilot contracts differ at ${name}`);
    }
  }

  if (stable(comparableProjection(hermes)) !== stable(comparableProjection(openfang))) {
    throw new Error('Pilot contracts contain unclassified drift');
  }
}

function buildPrompt(hand: HandContract): string {
  const doneWhen = hand.mission.done_when.map((condition) => `- ${condition}`).join('\n');
  return [
    `Execute Starlight Hand ${hand.id} exactly once.`,
    `Objective: ${hand.mission.outcome}`,
    `Budgets: ${hand.execution.max_minutes} minutes, ${hand.execution.max_tool_calls} tool calls, and USD ${hand.execution.max_model_cost_usd} estimated model cost.`,
    'Use only public web search and extraction tools. Do not use shell, files, memory writes, messaging, publishing, spending, credentials, or repository tools.',
    'SIS remains the only canonical memory authority. Produce a sourced graph projection for independent review; never write directly to SIS.',
    'Follow these phases in order: recover, plan, collect, cross-check, graph, verify, receipt.',
    'Return the report and one starlight.hand.pilot-receipt.v1 JSON object in the final response. Do not schedule another run. The Queen wrapper will stage accepted output into the isolated inbox.',
    'Done conditions:',
    doneWhen,
  ].join('\n\n');
}

export function compileHermesHand(input: unknown): CompiledHermesHandJob {
  const hand = parseHandContract(input);
  if (hand.runtime !== 'hermes-cron') {
    throw new Error(`runtime must be hermes-cron, received ${hand.runtime}`);
  }

  return {
    schema_version: 'starlight.hermes-hand-job.v1',
    hand_id: hand.id,
    name: `Starlight Hand: ${hand.id}`,
    enabled: false,
    schedule: `every ${hand.schedule.every_minutes}m`,
    repeat: hand.schedule.max_runs,
    deliver: 'local',
    attach_to_session: false,
    enabled_toolsets: ['web'],
    prompt: buildPrompt(hand),
  };
}
