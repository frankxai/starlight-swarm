# Workflows

## Durable mission lifecycle

1. **Sense** — collect current source, repository, runtime, budget, and machine evidence.
2. **Compile** — bind objective, roles, plan digest, provider route, budgets, tools, write scopes, denied actions, quality gates, and outputs.
3. **Admit** — verify trusted approval and budget receipts, fresh health, duplicate-lane absence, credentials, and capacity.
4. **Lease** — Queen issues a short-lived role and path lease; Temporal workflow ID becomes the durable run identity.
5. **Execute** — one worker performs idempotent activities, checkpoints progress, heartbeats, and stops at boundaries.
6. **Verify** — the independent verifier reproduces checks using a distinct authority/model route where consequence justifies it.
7. **Decide** — Queen records accept, revise, hold, or escalate. Human gates remain pending until a human acts.
8. **Close** — persist receipts, actual token/cost/time, artifacts, rollback state, and residual risks.
9. **Recover** — reconcile Temporal history, SIS projection, receipts, leases, and idempotency keys before any resume.

## Handoff rules

- "Select only the smallest 3-5 role team needed for the bounded job."
- "The worker that changes a release surface cannot be its independent verifier."
- "Stop and request named approval when any human-gated action is required."

## Failure policy

Bound retries by attempt count, wall time, tokens, cost, tool calls, and side-effect safety. Quarantine on credential exposure, forbidden actions, duplicate execution, canonical-memory writes, external sends, budget breach, unowned child processes, or unverifiable output.
