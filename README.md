# starlight-swarm

**L6 — Swarm Runtime** of the agentic-income ecosystem. The queen/worker
orchestration model for income streams: queens run the streams, workers do the
work, the founder owns capital and the irreversible gate, and a human holds the
last line.

> Layer model + contract: `agentic-ops-hub/ECOSYSTEM.md`
> · Agent stack + escalation contract: `agentic-ops-hub/docs/AGENT-STACK.md`
> · Protection layers: `agentic-ops-hub/PROTECTION-LAYERS.md`

---

## ⚠️ Status: v0.1 scaffold — dry-run only

**No live action fires. No real money moves.** This repo models the orchestration
*contract* in typed TypeScript — config, a Queen class, a pure escalation
classifier, and MCP integration *interfaces* (stubbed for the dry-run). It is not
wired to live MCP servers, and it must never be wired to live funds in this state.

## The model: hybrid queens-per-stream

```
FOUNDER  starlight-orchestrator  (+ /starlight-board gate)   <- capital + irreversible
   |-- AFFILIATE QUEEN  -> catalog-auditor . link-binder . disclosure-checker . ranker
   |-- PRODUCTS  QUEEN  -> product-architect . packager . pricer . launch-coordinator
   |-- CONTENT   QUEEN  -> researcher . writer . hook-engineer . distributor
   `-- PAYMENTS  QUEEN  -> mandate-verifier . spend-cap-enforcer . settlement-auditor . fraud-sentinel
```

Topology: **queen-led per stream, mesh within a stream.** Queens never command
across streams — they coordinate through the founder.

**Escalation ladder (the safety spine):** worker -> queen -> founder -> human.
No autonomous money movement, ever. Payments go through the Payments MCP
(AP2 mandate verify + spend-cap, verify-only, fail-closed). See
`docs/SWARM-ARCHITECTURE.md`.

## Layout

```
src/swarm/
  streams.ts       4 income streams + queens + workers as typed config
  queen.ts         Queen class - owns workers, runs a loop step, act-vs-escalate
  worker.ts        Worker interface - one job, append-only memory, never self-gates
  escalation.ts    classify(action) -> autonomous | queen-gate | founder-board | human-gate
  integrations.ts  typed MCP integration points (SIS sis_* + Payments verify-only) - stubs
  index.ts         the dry-run: prints the tree + demonstrates the escalation path
src/pages/
  swarm.tsx        cockpit page rendering the stream -> queen -> worker tree + legend
docs/SWARM-ARCHITECTURE.md   the architecture narrative
local-cockpit.html           static operator console (now includes the swarm tree)
```

## Run the dry-run

```bash
npm install
npm run swarm:dry-run    # founder->queen->worker tree + escalation ladder + per-queen loop step
npm run typecheck        # tsc --noEmit
npm run build            # next build (cockpit)
npm run dev              # next dev -p 3007  ->  http://localhost:3007/swarm
```

The dry-run walks every escalation tier through `classify()` and runs one
self-improving-loop step per queen, including an over-cap payment that escalates
worker -> queen -> founder -> human. Nothing fires.

## Where this sits in the stack

L7 ASSURANCE (`starlight-evals`) wraps everything · **L6 SWARM RUNTIME (this repo)** ·
L5 PAYMENTS (`payment-intelligence-system`) · L4 INCOME ENGINE · L3 OS FAMILY ·
L2 CONFIG (`agentic-ops-hub`) · L1 CAPABILITY · L0 SUBSTRATE (`Starlight-Intelligence-System`).
