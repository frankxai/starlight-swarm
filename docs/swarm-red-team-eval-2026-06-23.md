# Starlight Swarm Red-Team Eval - 2026-06-23

## Target

Target artifact: `starlight-swarm` L6 swarm runtime, with adjacent SIS Proving
Ground eval surface.

Eval objective:

- Re-test the current local swarm runtime.
- Red-team payment safety, eval sufficiency, cockpit/recovery posture, and
  architecture foundation.
- Compare the Starlight approach against current orchestration alternatives.

Working-tree caveat:

- `starlight-swarm` was dirty before this eval and was tested as-is.
- Branch state: `main...origin/main [behind 5]`.
- SIS was also dirty before this eval. Existing changes were treated as external
  work and were not reverted.

## Executive Verdict

Verdict: REVISE BEFORE STRONG CLAIMS.

The system is materially better than the June 18 run on the main payment
governance path. The earlier weakness, where `verify_mandate` and
`check_spend_cap` were observed but not enforced, has been largely patched.

It is not yet better than mature orchestration frameworks as a runtime. It is
better only in one narrow, valuable dimension: domain-specific governance
language around founder/human gates, no autonomous money movement, and
fail-closed payment thinking.

The best next foundation is: keep the Starlight governance taxonomy, but run it
on a proven durable workflow, queue, tracing, and policy substrate.

## Evidence Run

Commands run in `C:\Users\frank\starlight\repos\starlight-swarm`:

```powershell
npm run swarm:dry-run
npm run typecheck
npm test
npm run build
```

Results:

- `npm run swarm:dry-run`: passed. No action fired. No money moved.
- Dry-run is stricter than before: in-cap dry-run payment now becomes
  `human-gate` because mandate verification is not live.
- `npm run typecheck`: passed.
- `npm test`: passed, 45 tests, 0 failures.
- `npm run build`: passed. Next.js built `/`, `/swarm`, `/api/audit`, and
  `/api/recover`.

Cockpit smoke:

- Built app started locally on `http://localhost:3007`, then was shut down.
- `/swarm`: loaded.
- `/api/audit`: `ok=true`, 6 registry entries.
- `/api/recover`: `status=nominal`.

SIS eval/test commands:

```powershell
npm run eval:retrieval
node tools/run-v01-evals.mjs
npm run test:substrate
npm run test:operational
```

Results:

- `npm run eval:retrieval`: passed. 1 test, 0 failures. 10-query corpus,
  recall@1/3/5 all 100%.
- `node tools/run-v01-evals.mjs`: passed. 34 pass, 0 fail, 7 todo.
- `npm run test:operational`: passed.
- `npm run test:substrate`: failed at `v80-platform-prompts`.

Substrate failure:

- `CLAUDE.md` and `AGENTS.md` claim skills=83 while canonical count is 84.
- Platform adapter prompts also claim skills=83 while canonical count is 84.
- This is a real foundation drift, not a runtime swarm failure.

## What Is Better Now

The main payment-governance path is stronger.

Current `Queen.enforcePaymentGovernance()` blocks in-cap payments when:

- Payments MCP is missing.
- Mandate verification fails.
- Spend cap check fails.
- Audit write fails.
- Payments MCP throws.

The suite now includes tests for those cases, growing swarm tests from 41 to 45.
This is a meaningful improvement over the June 18 state.

The dry-run behavior is also more honest. With only the dry-run payment adapter,
even an in-cap payment is human-gated because the mandate is not validly signed.

## Pre-Patch Red-Team Findings

The findings in this section describe the state observed before the blue-team
closure at the end of this report.

### High: Payment-like actions can bypass MCP enforcement by false labeling

Reproduction:

```powershell
npx tsx -e "import { classify } from './src/swarm/escalation.ts'; const cases = [{name:'payment-kind-without-movesMoney', action:{stream:'payments', kind:'payment', movesMoney:false, irreversible:false, crossStream:false, amount:40, cap:100}}, {name:'spend-kind-without-movesMoney', action:{stream:'payments', kind:'spend', movesMoney:false, irreversible:false, crossStream:false, amount:40, cap:100}}]; for (const c of cases) console.log(c.name + ': ' + JSON.stringify(classify(c.action as any)));"
```

Observed:

- `kind: payment`, `movesMoney: false` classified as `queen-gate`.
- `kind: spend`, `movesMoney: false` classified as `autonomous`.

Queen-path reproduction:

```powershell
npx tsx -e "...mislabeled payment task..."
```

Observed:

```json
{
  "decision": {
    "classification": {
      "decision": "queen-gate"
    },
    "verdict": "act"
  },
  "calls": []
}
```

Meaning:

- `classify()` treats `kind === 'payment' || movesMoney` as payment governance.
- `Queen.enforcePaymentGovernance()` only triggers on `report.proposed.movesMoney`.
- Therefore a `kind: payment` action can receive payment gates in classification
  while making zero Payments MCP calls if `movesMoney` is false.

Fix direction:

- Define one canonical `isPaymentLike(action)` predicate and use it in both
  `classify()` and `Queen.enforcePaymentGovernance()`.
- Treat `payment`, `spend`, `settlement`, and any amount/cap-bearing payment-stream
  proposal as payment-like unless explicitly marked read-only.

### High: `spend` semantics are unsafe

`ActionKind` says `spend` means capital spend. Yet in-cap `spend` with
`movesMoney: false` can be autonomous. This is too easy to misuse.

Fix direction:

- Make `spend` founder-board by default.
- Require a separate `budget-research` or `pricing-analysis` kind for reversible,
  non-money planning.

### Medium: `act` is the wrong word for gated payment decisions

For `queen-gate`, `Queen.decide()` returns `verdict: act`. That is safe while the
runtime is dry-run only, but dangerous vocabulary if any live executor is added.

Fix direction:

- Rename `act` to `approved_for_next_gate`, `gate_passed`, or `ready_for_review`.
- Never use the same enum value for "draft/reversible action" and "payment passed
  verification".

### Medium: `require_human_approval()` is a soft placeholder

The adapter records an escalation audit note and returns pending. That is safe as
a fail-closed local signal, but it is not a real human approval workflow.

Fix direction:

- Rename to `record_human_approval_required()` until it is actually wired.
- Add an approval ticket/receipt interface before any live rail.

### Medium: `requiresHuman()` can mislead future callers

`requiresHuman()` returns true only for `human-gate`. Over-cap payments return
`founder-board` but include `human.approval` in gates.

Fix direction:

- Add `requiresHumanApproval(decision)` based on gates, not decision tier alone.
- Keep `decision` tier and required approvals as separate concepts.

### Medium: No durable queue or recovery foundation

`Queen.stepLoop()` is a synchronous dry-run heartbeat over passed-in tasks. There
is no persisted job state, idempotency key, lease, retry policy, dead-letter
queue, or worker recovery path.

Fix direction:

- Use Temporal for durable long-running orchestration.
- Or use BullMQ/Redis for a lighter bounded Node queue.
- Keep the Queen as a coordinator/policy layer, not the queue substrate.

### Medium: Traceability is not production-grade

Once SO, Queen, AO, SIS, workers, and MCP servers become separate processes,
console logs will not prove causality.

Fix direction:

- Add `swarm.run_id`, `task_id`, `decision_id`, and `audit_id`.
- Use OpenTelemetry spans for route, plan, enqueue, worker, MCP call, policy,
  audit write, and human gate.

### Medium: Eval evidence is too narrow for broad quality claims

The evals support the narrow claim:

> The dry-run safety spine is unit-tested and currently fails closed around
> payment governance.

They do not yet support:

> This is a high-quality production multi-agent system.

Missing proof:

- Dedicated `starlight-swarm` Proving Ground lane.
- Repeated adversarial payment fixtures.
- Multi-turn recovery runs.
- Real MCP adapter smoke against built `payment-intelligence-system`.
- Queue throughput/latency/cost tests.
- Worker-output quality rubrics.
- Cross-stream conflict scenarios.
- Human approval receipt lifecycle.
- PII/private-memory leakage tests.

## External Comparison

Current official sources checked on 2026-06-23:

- LangGraph: `https://docs.langchain.com/oss/python/langgraph/overview`
- LangGraph persistence: `https://docs.langchain.com/oss/python/langgraph/persistence`
- Microsoft Agent Framework: `https://learn.microsoft.com/en-us/agent-framework/overview/`
- Microsoft Agent Framework orchestrations: `https://learn.microsoft.com/en-us/agent-framework/workflows/orchestrations/`
- OpenAI Agents SDK tracing: `https://openai.github.io/openai-agents-python/tracing/`
- OpenAI Agents SDK guardrails: `https://openai.github.io/openai-agents-python/guardrails/`
- OpenAI Agents SDK handoffs: `https://openai.github.io/openai-agents-python/handoffs/`
- CrewAI docs: `https://docs.crewai.com/`
- Temporal durable execution: `https://temporal.io/blog/what-is-durable-execution`
- AutoGen repo: `https://github.com/microsoft/autogen`

Comparison:

- LangGraph is ahead as a low-level orchestration runtime: durable execution,
  persistence, human-in-the-loop, streaming, and tracing/eval ecosystem via
  LangSmith.
- Microsoft Agent Framework is ahead for enterprise workflow foundations:
  graph workflows, type-safe routing, checkpointing, human-in-the-loop support,
  and built-in orchestration patterns.
- CrewAI is ahead for packaged multi-agent developer experience: crews, flows,
  guardrails, memory, knowledge, observability, human-in-the-loop triggers, and
  long-running flow concepts.
- OpenAI Agents SDK is ahead for handoffs, guardrails, sessions, and built-in
  tracing around LLM/tool/handoff events.
- Temporal is ahead as a reliability foundation: crash-proof, long-running,
  durable execution with automatic state preservation.
- AutoGen should not be the default new foundation; official GitHub now says it
  is in maintenance mode and points new users to Microsoft Agent Framework.

Where Starlight is better:

- Domain-specific governance language is sharper than generic frameworks:
  founder/human gates, no autonomous money movement, stream containment,
  fail-closed payment intent, and red/blue eval posture.
- The Starlight model is stronger as a doctrine/eval/policy overlay than as a
  runtime.

Where Starlight is not better:

- Durable execution.
- Queueing.
- State recovery.
- Production observability.
- Typed workflow graph/runtime.
- Human approval lifecycle.
- Proven policy engine.
- Eval sample size and repeatability.

## Recommended Foundation

Use Starlight as the governance and eval layer, not the base runtime.

Recommended stack:

1. Temporal for durable Queen/AO workflows.
2. OpenTelemetry for traces across SO, Queen, AO, workers, MCP, SIS, and audits.
3. A policy layer, preferably OPA/Rego or an equivalent versioned decision table,
   for non-waivable gate logic.
4. SIS Proving Ground with a new `starlight-swarm` lane.
5. Existing `starlight-swarm` TypeScript classifier as a reference adapter and
   fast local test harness.

Lighter alternative:

- If Temporal is too heavy for the next step, use BullMQ/Redis first for queues,
  retries, leases, priorities, repeatable jobs, and dead-letter handling. Still
  add trace IDs and policy tests.

## Next Gate

Before calling this "best-in-class":

1. Patch payment-like predicate consistency.
2. Make `spend` non-autonomous by default.
3. Rename `act` so gated payment readiness cannot be confused with execution.
4. Add first-class `starlight-swarm` Proving Ground lane.
5. Add trace IDs and a minimal decision/audit receipt schema.
6. Choose durable foundation: Temporal for serious production, BullMQ for near-term
   local queue hardening.

Next exact engineering packet:

```markdown
Objective:
Close payment semantic bypasses and harden gate vocabulary.

Allowed files:
- src/swarm/escalation.ts
- src/swarm/queen.ts
- src/swarm/escalation.test.ts
- src/swarm/queen.test.ts
- docs/SWARM-ARCHITECTURE.md

Acceptance:
- `kind: payment` always triggers Payment MCP governance, even if `movesMoney` is false.
- `kind: spend` is never autonomous unless represented by a separate read-only planning kind.
- `requiresHumanApproval()` checks gates or explicit approval requirement, not only decision tier.
- Payment readiness does not use `verdict: act`.
- `npm run swarm:dry-run`
- `npm run typecheck`
- `npm test`
```

## Blue-Team Closure - 2026-06-23

Blue-team objective:

- Close the payment semantic bypasses found above.
- Make payment/spend governance use one shared predicate.
- Replace ambiguous `verdict: act` wording with a non-execution verdict.
- Add regression coverage so false labels cannot silently downgrade payment
  governance.

Changes made:

- Added `requiresPaymentGovernance(action)` in `src/swarm/escalation.ts`.
- Treated `payment`, `spend`, and any `movesMoney` action as
  payment-governed.
- Changed in-cap `spend` from autonomous to `queen-gate` behind Payments MCP
  verify, cap, and audit gates.
- Changed `requiresHuman(action)` to follow the presence of
  `human.approval`, so over-cap founder-board payments are no longer reported
  as "no human required".
- Updated `Queen.stepLoop()` to enforce payment governance through the same
  predicate used by classification, including mislabeled `payment` actions and
  non-payments queens proposing capital spend.
- Added Payments MCP gates to `move-funds` classification output even though it
  already remains a human hard-stop.
- Renamed the Queen verdict from `act` to `gate-ready` to avoid implying live
  execution.

Regression coverage added:

- `kind: payment` with `movesMoney: false` still receives payment gates.
- `kind: spend` with `movesMoney: false` still receives payment gates.
- Queen loop calls `verify_mandate`, `check_spend_cap`, and
  `record_audit_entry` for mislabeled in-cap payment/spend proposals.
- A non-payments queen proposing capital spend without a Payments MCP handle
  fails closed to `human-gate`.
- Over-cap payments now satisfy `requiresHuman(action)`.
- `move-funds` now remains `human-gate` while also advertising
  `payments-mcp.verify_mandate` and `payments-mcp.check_spend_cap` gates.

Verification after blue-team patch:

```text
npm run typecheck  -> passed
npm test           -> passed, 49 tests, 0 failures
npm run swarm:dry-run -> passed, no action fired, no money moved
npm run build      -> passed
```

Remaining foundation gaps:

- Human approval is still a pending/audit signal, not a live approval workflow.
- There is still no durable queue, lease, retry, dead-letter queue, or persisted
  job state.
- There is still no first-class `starlight-swarm` SIS Proving Ground lane.
- The stronger runtime foundation recommendation remains: Temporal or
  BullMQ/Redis, OpenTelemetry traces, and a versioned policy layer.
