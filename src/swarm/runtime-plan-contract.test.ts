import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseTeamRuntimePlan } from './runtime-plan-contract';
import { testRuntimePlan } from './runtime-test-fixtures';

test('parseTeamRuntimePlan accepts valid plan from fixtures', () => {
  const plan = testRuntimePlan();
  const parsed = parseTeamRuntimePlan(plan);
  assert.equal(parsed.team_id, plan.team_id);
});

test('parseTeamRuntimePlan throws on invalid schema version', () => {
  const plan = testRuntimePlan() as any;
  plan.schema_version = 'invalid-version';
  assert.throws(() => parseTeamRuntimePlan(plan), /Invalid team runtime plan/);
});

test('parseTeamRuntimePlan throws on missing independent verifier', () => {
  const plan = testRuntimePlan() as any;
  plan.lanes.forEach((lane: any) => {
    lane.independent_verifier = false;
    lane.model_route = 'economy';
  });
  assert.throws(() => parseTeamRuntimePlan(plan), /Exactly one independent verifier lane is required/);
});

test('parseTeamRuntimePlan throws when daily cost exceeds limit', () => {
  const plan = testRuntimePlan() as any;
  plan.budget.planned_daily_cost_usd = 1000;
  plan.lanes[0].budget.daily_cost_cap_usd += 1000 - plan.lanes.reduce((total: number, lane: any) => total + lane.budget.daily_cost_cap_usd, 0);
  plan.budget.max_daily_cost_usd = 100;
  assert.throws(() => parseTeamRuntimePlan(plan), /Planned daily cost exceeds the team hard limit/);
});

test('parseTeamRuntimePlan throws when daily cost sum is incorrect', () => {
  const plan = testRuntimePlan() as any;
  plan.lanes[0].budget.daily_cost_cap_usd += 1;
  assert.throws(() => parseTeamRuntimePlan(plan), /Planned daily cost must equal the sum of lane cost caps/);
});

test('parseTeamRuntimePlan throws when lane ids are not unique', () => {
  const plan = testRuntimePlan() as any;
  plan.lanes[1].id = plan.lanes[0].id;
  assert.throws(() => parseTeamRuntimePlan(plan), /Lane ids must be unique/);
});

test('parseTeamRuntimePlan throws when role ids are not unique', () => {
  const plan = testRuntimePlan() as any;
  plan.lanes[1].role_id = plan.lanes[0].role_id;
  assert.throws(() => parseTeamRuntimePlan(plan), /Lane role assignments must be unique/);
});
