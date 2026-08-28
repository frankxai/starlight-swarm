<!-- GITHUB_VISUALS_START -->
<p align="center">
  <img src="assets/github/header.svg" alt="Starlight Swarm - Queen-worker runtime for governed income streams." width="100%">
</p>

<details open>
<summary><strong>How this repo works</strong></summary>
<p align="center">
  <img src="assets/github/how-it-works.svg" alt="Starlight Swarm operating map" width="100%">
</p>
</details>

<details>
<summary><strong>Build, deploy, verify path</strong></summary>
<p align="center">
  <img src="assets/github/build-deploy-verify.svg" alt="Starlight Swarm build deploy verify path" width="100%">
</p>
</details>

<!-- GITHUB_VISUALS_END -->

<div align="center">

# 🐝 Starlight Swarm

### Queen-led, fail-closed orchestration for AI income streams

> **L6 — Swarm Runtime** of the agentic-income ecosystem. Queens run the streams,
> workers do the work, the founder owns capital and the irreversible gate, and a
> human holds the last line. The orchestration *contract*, in typed TypeScript —
> never wired to live funds.

![Status](https://img.shields.io/badge/status-v0.3_dry--run_only-f59e0b?style=for-the-badge&labelColor=0d1117)
![Layer](https://img.shields.io/badge/layer-L6_Swarm_Runtime-7fffd4?style=for-the-badge&labelColor=0d1117)
![Safety](https://img.shields.io/badge/money_movement-none_by_design-c084fc?style=for-the-badge&labelColor=0d1117)
[![Built on SIP](https://img.shields.io/badge/Built_on-SIP-78a6ff?style=for-the-badge&labelColor=0d1117)](https://github.com/frankxai/Starlight-Intelligence-System)
[![License: MIT](https://img.shields.io/badge/license-MIT-white?style=for-the-badge&labelColor=0d1117)](https://opensource.org/licenses/MIT)

[**⚡ Run the dry-run**](#run-the-dry-run) · [**🧬 The model**](#the-model) · [**🪜 Escalation spine**](#escalation-spine) · [**🛡️ Benevolence charter**](#benevolence-charter) · [**🗺️ Where it sits**](#where-it-sits)

</div>

---

> [!WARNING]
> **No live action fires. No real money moves.** This repo models the orchestration
> *contract* — config, a `Queen` class, a pure escalation classifier, and the MCP
> integration layer. It must never be wired to live funds. Agents draft, verify, and
> gate. Humans deploy, post, send, and approve capital.

---

## ⚠️ Status

**v0.3 — benevolence charter wired into the queen tier (still dry-run only).**

What v0.3 adds: an executable [benevolence charter](#benevolence-charter) — six non-waivable
clauses that run as a second, independent read on every proposal. It can raise a gate and never
lower one, so a Queen holding the charter is never more permissive than one without it. Ledger
clauses (attribution owed, lost sovereignty, unbacked capability claims) refuse outright.
[`docs/QUEEN-CHARTER.md`](docs/QUEEN-CHARTER.md) is the spawn recipe for a Queen over any
vertical, business, or team.

What v0.2 hardened over the v0.1 scaffold (the model is unchanged; the *confidence* is higher):

- **The escalation spine is unit-tested.** `classify()` + `overCap()` — the load-bearing
  safety code — have full-branch coverage, including the fail-closed invariants: a
  `null`/`undefined` action → `human-gate`, and a missing / `NaN` amount or cap → treated
  as over-cap (never silently passes).
- **The Payments Queen speaks to a real payments-MCP adapter.** Its verify step calls an
  actual MCP client (`paymentsMcpFromClient`) bridging to the `@frankx-ai/payments-mcp`
  server over stdio (`connectRealPayments`). It is **verify-only** (`verify_mandate` /
  `check_spend_cap` / `record_audit_entry` / `require_human_approval` — there is no transfer
  tool, by design) and **fail-closed**: any transport error, MCP error, or garbled result
  resolves to the SAFE verdict (invalid / over-cap / not-recorded / pending), never a pass.
  If the server isn't built or reachable, the adapter degrades cleanly to the fail-closed dry-run.

This hardens the model; it does **not** make the swarm autonomously act.

---

## Governed team runtime planner

The dry-run team planner compiles existing `starlight.team_profile.v2` definitions into
bounded runtime plans across Railway Temporal, Vercel Eve, local Hermes, n8n, and the
deferred Cloudflare edge route. Plans include independent verification, provider routing,
token/cost ceilings, human gates, and a separate fail-closed admission assessment. The CLI
is report-only: it cannot admit a plan because it has no trusted approval/budget verifier.

```bash
npm run runtime:plan -- \
  ../starlight-agent-config/core/teams/starlight-platform-team.team-profile.json \
  runtime/examples/starlight-platform-pilot.workloads.json \
  runtime/policies/starlight-platform-pilot.runtime-policy.json \
  --output runtime/generated/starlight-platform-pilot.plan.json \
  --force

npm run runtime:assess -- \
  runtime/generated/starlight-platform-pilot.plan.json \
  runtime/generated/starlight-platform-pilot.evidence.json \
  --output runtime/generated/starlight-platform-pilot.assessment.json \
  --force

npm run runtime:pack -- \
  ../starlight-agent-config/core/teams/starlight-platform-team.team-profile.json \
  runtime/generated/starlight-platform-pilot.plan.json \
  runtime/policies/starlight-platform-pilot.runtime-policy.json

npm run runtime:pack:verify -- \
  runtime/generated/packs/<content-addressed-pack-directory> \
  runtime/generated/starlight-platform-pilot.plan.json \
  ../starlight-agent-config/core/teams/starlight-platform-team.team-profile.json \
  runtime/policies/starlight-platform-pilot.runtime-policy.json

npm run runtime:prepare -- \
  runtime/generated/packs/<content-addressed-pack-directory> \
  runtime/generated/starlight-platform-pilot.plan.json \
  ../starlight-agent-config/core/teams/starlight-platform-team.team-profile.json \
  runtime/policies/starlight-platform-pilot.runtime-policy.json \
  --output runtime/generated/starlight-platform-pilot.prepared-runtime.json \
  --force
```

See [`docs/TEAM-RUNTIME-ADR-2026-08-06.md`](docs/TEAM-RUNTIME-ADR-2026-08-06.md) for the
evidence-backed runtime matrix, team-pack contract, three-lane proof, admission blockers,
and scale path. The pack compiler emits content-addressed `SYSTEM.md`, `WORKFLOWS.md`,
`QUALITY.md`, `GUARDRAILS.md`, `TASTE.md`, memory, capability, economics, synthetic-ICP,
and role-prompt contracts with a hash manifest plus the exact Queen-owned runtime-policy
snapshot. Verification requires the canonical profile, plan, and policy sources and rejects
tampering, source drift, undeclared files, and symlinks. `runtime:prepare` emits bounded,
non-activating runtime descriptors with leases, heartbeat timeouts, kill-switch names, and
runtime-specific targets. Preparation accepts only a frozen verification result issued by the
in-process pack verifier. Its strict runtime parser rejects adapter-shape confusion, duplicate
identities, and source/digest drift; the checked-in JSON Schemas are structural export aids, not
admission authority. Remote health probing is disabled until a server-owned endpoint registry
and DNS pinning exist; the Phase-0 probe accepts only loopback HTTP(S) on exact `/health`.
All profile-consuming runtime CLIs also verify the declared GitHub origin, repository-relative
path, canonical JSON content, and that the declared commit is reachable from a fetched `origin`
ref before planning, compiling, verifying, or preparing. Working-tree profile drift and
unpublished or dangling commits fail closed instead of being mislabeled as governed provenance.
These commands do not deploy or activate workers.

---

<a id="the-model"></a>

## 🧬 The model: hybrid queens-per-stream

Topology: **queen-led per stream, mesh within a stream.** Queens never command across
streams — they coordinate through the founder.

```mermaid
flowchart TD
    Human["🛡️ HUMAN — the last line"]
    Founder["👑 FOUNDER<br/>starlight-orchestrator + /starlight-board gate<br/>capital + irreversible actions"]
    Affiliate["AFFILIATE QUEEN"]
    Products["PRODUCTS QUEEN"]
    Content["CONTENT QUEEN"]
    Payments["PAYMENTS QUEEN"]

    Human --- Founder
    Founder --> Affiliate
    Founder --> Products
    Founder --> Content
    Founder --> Payments

    Affiliate --> A1["catalog-auditor · link-binder<br/>disclosure-checker · ranker"]
    Products --> P1["product-architect · packager<br/>pricer · launch-coordinator"]
    Content --> C1["researcher · writer<br/>hook-engineer · distributor"]
    Payments --> Pay1["mandate-verifier · spend-cap-enforcer<br/>settlement-auditor · fraud-sentinel"]
```

---

<a id="escalation-spine"></a>

## 🪜 The escalation spine

`classify(action)` routes every action to exactly one tier. No autonomous money movement, ever.

```mermaid
flowchart LR
    Worker["worker<br/>does the job<br/>never self-gates"] -->|reports finding| Queen
    Queen["queen<br/>runs the stream"] -->|act or escalate| Founder
    Founder["founder<br/>capital + board gate"] -->|irreversible / over-cap| Human["human<br/>approves"]

    classDef gate fill:#241B0F,stroke:#f59e0b,color:#fff;
    class Human gate;
```

Payments go through the Payments MCP (AP2 mandate verify + spend-cap, verify-only,
fail-closed). See [`docs/SWARM-ARCHITECTURE.md`](docs/SWARM-ARCHITECTURE.md).

---

<a id="benevolence-charter"></a>

## 🛡️ The benevolence charter

"Benevolent" is an unfalsifiable adjective until you say what the system **will not do**.
`checkCharter(action, ctx)` is that list made executable — six non-waivable clauses from
[The Blessing Protocol §13](https://github.com/frankxai/bless), inherited downward and never
relaxed downward.

| # | Clause | Disposition |
|---|---|---|
| 1 | **Fail closed** — uncertainty takes the safe verdict | raises the gate |
| 2 | **Human gate on the irreversible** — agents prepare, humans commit | raises to `human-gate` |
| 3 | **Attribution honored** — nothing runs with credit outstanding | **refuses** |
| 4 | **Sovereignty non-waivable** — read, export, leave | **refuses** |
| 5 | **Refusal is first-class** — reasoned and logged | structural |
| 6 | **No unbacked capability claim** — claims trace to a ledger entry | **refuses** |

It is a **second, independent read** on every action, deliberately overlapping `classify()`.
That redundancy is the point: if a future edit downgrades the irreversible-or-money rule in one
spine, the other still catches it. The two are combined with `raiseTo()`, which takes the harder
answer, so:

> **The charter may only raise a gate. It may never lower one.**

That property is asserted across the full action matrix in `charter.test.ts`, with an
anti-vacuity guard so the assertion cannot pass trivially — plus an *agreement* test that fires
if the two spines ever diverge on a quantified action.

Clauses 3, 4 and 6 are ledger defects: they refuse outright at any tier, because no approval
makes uncredited work credited or an unbacked claim backed. The remedy is a one-line append to
`palace/lineage.jsonl`, not a signature.

To spawn a Queen for your own vertical, business, or team, follow
[`docs/QUEEN-CHARTER.md`](docs/QUEEN-CHARTER.md).

---

## 📂 Layout

```
src/swarm/
  streams.ts       4 income streams + queens + workers as typed config
  queen.ts         Queen class — owns workers, runs a loop step, act-vs-escalate
  worker.ts        Worker interface — one job, append-only memory, never self-gates
  escalation.ts    classify(action) → autonomous | queen-gate | founder-board | human-gate
  charter.ts       checkCharter(action, ctx) → the six benevolence clauses, raise-only
  integrations.ts  MCP integration: SIS sis_* stubs + REAL payments-MCP adapter (verify-only, fail-closed)
  index.ts         the dry-run: prints the tree + escalation path + charter reads + a real payments-MCP round-trip
  escalation.test.ts    full-branch tests for the safety spine (incl. fail-closed)
  queen.test.ts         worker-guard + act-vs-escalate routing tests
  charter.test.ts       monotonicity + fail-closed + ledger refusals + actionability
  integrations.test.ts  payments-MCP adapter wire shape + fail-closed + queen↔adapter tests
src/pages/
  swarm.tsx        cockpit page rendering the stream → queen → worker tree + legend
docs/SWARM-ARCHITECTURE.md   the architecture narrative
docs/QUEEN-CHARTER.md        how to spawn a Queen for a vertical, business, or team
local-cockpit.html           static operator console (now includes the swarm tree)
```

---

<a id="run-the-dry-run"></a>

## ⚡ Run the dry-run

```bash
npm install
npm run swarm:dry-run    # founder→queen→worker tree + escalation ladder + per-queen loop step + real payments-MCP round-trip
npm run swarm:eval       # governance suite: golden scenarios + invariants swept over every action the types admit
npm run typecheck        # tsc --noEmit
npm test                 # tsc --noEmit && node --test --import tsx src/swarm/*.test.ts
npm run build            # next build (cockpit)
npm run dev              # next dev -p 3007  →  http://localhost:3007/swarm
```

The dry-run walks every escalation tier through `classify()`, runs one self-improving-loop
step per queen (including an over-cap payment that escalates worker → queen → founder →
human), and connects the **real** payments-MCP adapter for one verify-only round-trip.
It then shows the capability broker refusing three real calls, issues the handoff packets
the founder and human gates receive, verifies the run's hash-chained ledger against its own
plain-text export, and runs the governance suite. Nothing fires; no money moves.

The run uses a fixed clock, so two runs are byte-identical and diffable. Re-base it with
`SWARM_CLOCK`, and mirror the ledger to a local append-only file with `SWARM_LEDGER_PATH`.

To exercise the real adapter against your own checkout, point it at the built server
(defaults to `../payment-intelligence-system/mcp/dist/index.js`):

```bash
PAYMENTS_MCP_PATH=/abs/path/to/payments-mcp/dist/index.js npm run swarm:dry-run
```

If the server isn't built, the adapter degrades to the fail-closed dry-run.

---

<a id="where-it-sits"></a>

## 🗺️ Where this sits in the stack

```
L7 ASSURANCE        starlight-evals — wraps everything
L6 SWARM RUNTIME    ◀ this repo
L5 PAYMENTS         payment-intelligence-system
L4 INCOME ENGINE
L3 OS FAMILY
L2 CONFIG           agentic-ops-hub
L1 CAPABILITY
L0 SUBSTRATE        Starlight-Intelligence-System
```

> Layer model + contract: [`agentic-ops-hub/ECOSYSTEM.md`](https://github.com/frankxai/agentic-ops-hub/blob/main/ECOSYSTEM.md)
> · Agent stack + escalation contract: [`agentic-ops-hub/docs/AGENT-STACK.md`](https://github.com/frankxai/agentic-ops-hub/blob/main/docs/AGENT-STACK.md)
> · Protection layers: [`agentic-ops-hub/PROTECTION-LAYERS.md`](https://github.com/frankxai/agentic-ops-hub/blob/main/PROTECTION-LAYERS.md)

---

<div align="center">

**Built on SIP** · Starlight Intelligence Protocol · MIT · _No autonomous money movement, ever._

</div>
