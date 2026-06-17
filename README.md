# starlight-swarm

**L6 - Swarm Runtime** of the agentic-income ecosystem. The queen/worker
orchestration model for income streams: queens run the streams, workers do the
work, the founder owns capital and the irreversible gate, and a human holds the
last line.

> Layer model + contract: `agentic-ops-hub/ECOSYSTEM.md`
> . Agent stack + escalation contract: `agentic-ops-hub/docs/AGENT-STACK.md`
> . Protection layers: `agentic-ops-hub/PROTECTION-LAYERS.md`

---

## Status: v0.2 - unit-tested safety spine + real payments-MCP adapter (still dry-run only)

**No live action fires. No real money moves.** This repo models the orchestration
*contract* in typed TypeScript: config, a Queen class, a pure escalation
classifier, and the MCP integration layer. It must never be wired to live funds.

What v0.2 hardens over the v0.1 scaffold (the model is the same; the
*confidence* is higher):

- **The escalation spine is now unit-tested.** `classify()` + `overCap()` - the
  load-bearing safety code - have full-branch coverage, including fail-closed
  invariants: a `null`/`undefined` action -> `human-gate`, and a missing / `NaN`
  amount or cap -> treated as over-cap.
- **The Payments Queen now speaks to a real payments-MCP adapter.** Instead of a
  pure stub, the Payments Queen's verify step calls an MCP client
  (`paymentsMcpFromClient`) that bridges to the `@frankx-ai/payments-mcp` server
  over stdio (`connectRealPayments`). It is **verify-only**
  (`verify_mandate` / `check_spend_cap` / `record_audit_entry` /
  `require_human_approval`) and **fail-closed**: a transport error, MCP error,
  or garbled result resolves to the safe verdict, never to a pass. If the server
  is not built or cannot be reached, the adapter degrades cleanly to the
  fail-closed dry-run.

This hardens the model; it does **not** make the swarm autonomously act. Agents
draft, verify, and gate. Humans deploy, post, send, and approve capital.

## The model: hybrid queens-per-stream

```text
FOUNDER  starlight-orchestrator  (+ /starlight-board gate)   <- capital + irreversible
   |-- AFFILIATE QUEEN  -> catalog-auditor . link-binder . disclosure-checker . ranker
   |-- PRODUCTS  QUEEN  -> product-architect . packager . pricer . launch-coordinator
   |-- CONTENT   QUEEN  -> researcher . writer . hook-engineer . distributor
   `-- PAYMENTS  QUEEN  -> mandate-verifier . spend-cap-enforcer . settlement-auditor . fraud-sentinel
```

Topology: **queen-led per stream, mesh within a stream.** Queens never command
across streams; they coordinate through the founder.

**Escalation ladder (the safety spine):** worker -> queen -> founder -> human.
No autonomous money movement, ever. Payments go through the Payments MCP
(AP2 mandate verify + spend-cap, verify-only, fail-closed). See
`docs/SWARM-ARCHITECTURE.md`.

## Layout

```text
src/swarm/
  streams.ts       4 income streams + queens + workers as typed config
  queen.ts         Queen class - owns workers, runs a loop step, act-vs-escalate
  worker.ts        Worker interface - one job, append-only memory, never self-gates
  escalation.ts    classify(action) -> autonomous | queen-gate | founder-board | human-gate
  integrations.ts  MCP integration: SIS sis_* stubs + payments-MCP adapter
  index.ts         dry-run tree + escalation path + payments-MCP round-trip
  escalation.test.ts
  queen.test.ts
  integrations.test.ts
src/pages/
  index.tsx        local cockpit: daemons, repo audit, event log
  swarm.tsx        cockpit page rendering the stream -> queen -> worker tree
  api/audit.ts     local registry audit endpoint
  api/recover.ts   simulated recovery endpoint
docs/SWARM-ARCHITECTURE.md
local-cockpit.html
```

## Run the dry-run

```bash
npm install
npm run swarm:dry-run    # founder->queen->worker tree + escalation ladder + payments-MCP round-trip
npm run typecheck        # tsc --noEmit
npm test                 # tsc --noEmit && node --test --import tsx src/swarm/*.test.ts
npm run build            # next build (cockpit)
npm run dev              # next dev -p 3007
```

The dry-run walks every escalation tier through `classify()`, runs one
self-improving-loop step per queen (including an over-cap payment that escalates
worker -> queen -> founder -> human), and connects the payments-MCP adapter for
one verify-only round-trip. Nothing fires; no money moves.

To exercise the real adapter against your own checkout, point it at the built
server (defaults to `../payment-intelligence-system/mcp/dist/index.js`):

```bash
PAYMENTS_MCP_PATH=/abs/path/to/payments-mcp/dist/index.js npm run swarm:dry-run
```

If the server is not built, the adapter degrades to the fail-closed dry-run.

## Local cockpit and audit API

The local cockpit runs at:

```text
http://localhost:3007
```

The `/api/audit` endpoint reads the Starlight Intelligence System MCP registry
from disk and matches registry rows to local Git repositories. It does not mutate
repositories. It only reads registry rows and runs:

```text
git branch --show-current
git status --short
```

Registry resolution order:

1. `STARLIGHT_MCP_REGISTRY` - exact path to `mcp-registry.csv`.
2. `STARLIGHT_INTELLIGENCE_SYSTEM_ROOT` - repo root containing `tools/mcp-registry.csv`.
3. Known local fallbacks, including `C:\Users\frank\starlight\repos\Starlight-Intelligence-System`.

Optional Windows configuration:

```powershell
$env:STARLIGHT_MCP_REGISTRY = "C:\Users\frank\starlight\repos\Starlight-Intelligence-System\tools\mcp-registry.csv"
$env:STARLIGHT_REPO_ROOTS = "C:\Users\frank\starlight\repos;C:\Users\frank"
```

`STARLIGHT_REPO_ROOTS` is a semicolon-delimited list of directories to search
when matching registry entries to local Git repositories.

The cockpit is local-first. Do not expose it publicly without authentication.

## Where this sits in the stack

L7 ASSURANCE (`starlight-evals`) wraps everything . **L6 SWARM RUNTIME (this repo)** .
L5 PAYMENTS (`payment-intelligence-system`) . L4 INCOME ENGINE . L3 OS FAMILY .
L2 CONFIG (`agentic-ops-hub`) . L1 CAPABILITY . L0 SUBSTRATE
(`Starlight-Intelligence-System`).
