# Swarm Architecture — the L6 Runtime

> `starlight-swarm` is **L6 — Swarm Runtime** in the agentic-income layer model
> (`agentic-ops-hub/ECOSYSTEM.md`). It executes the income streams under
> governance: queens run the streams, workers do the work, the founder owns
> capital and the irreversible gate, and a human holds the last line.
>
> **Status: v0.1 scaffold — dry-run only. No real action fires. No money moves.**

This document is the architectural narrative. The code is the contract:
`src/swarm/streams.ts` (config), `src/swarm/queen.ts` (Tier 2), `src/swarm/worker.ts`
(Tier 3), `src/swarm/escalation.ts` (the safety spine), `src/swarm/integrations.ts`
(MCP integration points), `src/swarm/index.ts` (the dry-run).

---

## The hybrid model: queens-per-stream

Decided 2026-06-14 (`agentic-ops-hub/docs/AGENT-STACK.md`). Three tiers:

```
                       ┌─────────────────────────────┐
                       │      FOUNDER AGENT          │
                       │  starlight-orchestrator     │
                       │  + /starlight-board gate    │
                       │  thesis · capital · gate    │
                       └──────────────┬──────────────┘
                                      │ escalation contract
              ┌───────────────┬───────┴───────┬───────────────┐
              ▼               ▼               ▼               ▼
        ┌──────────┐   ┌───────────┐   ┌───────────┐   ┌────────────┐
        │ AFFILIATE│   │ PRODUCTS  │   │  CONTENT  │   │  PAYMENTS  │
        │  QUEEN   │   │  QUEEN    │   │  QUEEN    │   │   QUEEN    │
        └────┬─────┘   └─────┬─────┘   └─────┬─────┘   └─────┬──────┘
             │ mesh          │ mesh          │ mesh          │ mesh
        ┌────┴────┐     ┌────┴────┐     ┌────┴────┐     ┌────┴─────┐
        │ workers │     │ workers │     │ workers │     │ workers  │
        └─────────┘     └─────────┘     └─────────┘     └──────────┘
```

- **Founder (Tier 1)** — `starlight-orchestrator` (SIS). Sets the income thesis
  (sourced from SIS **Wealth IS**), owns all capital allocation and every
  irreversible action, resolves conflicts between queens. Holds the
  `/starlight-board` gate. Never does the per-stream work.
- **Stream Queens (Tier 2)** — four queens, one per income stream. Each reuses the
  Starlight Queen seat under one governance mode (`generals.ts`), runs a
  self-improving loop, and acts autonomously **within its scope and below its
  caps**. The moment an action crosses a stream boundary, exceeds a cap, or
  becomes irreversible, the queen escalates.
- **Workers (Tier 3)** — `worker-specialist`. One job each, stateless between
  tasks (all state lives in the SIS vault), append-only memory. A worker **never
  moves money or publishes** without its queen's gate, and never self-gates.

## Topology: queen-led per stream, mesh within

Each queen runs a **hierarchical** swarm of workers. Workers collaborate
**peer-to-peer (mesh)** inside their own stream. Queens do **not** command across
streams — cross-stream coordination always routes through the founder. This is
both a coordination choice and a containment property: a compromised stream is
contained by IAM + the no-cross-stream-command rule.

The four streams (mirrors `AGENT-STACK.md`):

| Queen | Stream | Workers | Self-improving loop |
|---|---|---|---|
| Affiliate Queen | Recurring affiliate revenue | catalog-auditor · link-binder · disclosure-checker · ranker | audit → join → bind → measure → re-rank |
| Products Queen | Digital products / templates / courses | product-architect · packager · pricer · launch-coordinator | gap-scan → build → price → launch → retro |
| Content Queen | Traffic → trust → routing | researcher · writer · hook-engineer · distributor | top-queries → draft → gate → publish → learn |
| Payments Queen | Authorization (verify-only, never settles) | mandate-verifier · spend-cap-enforcer · settlement-auditor · fraud-sentinel | propose-charge → verify → check cap → audit → verdict to a human |

---

## The escalation contract (the safety spine)

Encoded as code in `src/swarm/escalation.ts` — `classify(action) → Decision`.
This is load-bearing: **no autonomous money movement, ever.** Rules are evaluated
hardest-stop-first, so irreversibility and money can never be downgraded by a
later, more permissive rule.

| Action class | Who decides | Gate required |
|---|---|---|
| Worker task within stream (draft, audit, research) | Worker → Queen | queen review |
| Bind a link, schedule a post, build a page | Queen | brand/claims gate (`@integrity-guard`, `@claims-guard`) |
| Authorize a payment (verdict only) | Payments Queen | **AP2 mandate verified + spend-cap check + audit entry** (Payments MCP, fail-closed) |
| Settle a payment on any rail | Founder | **human approval, always**; the swarm holds no rail credential |
| Spend above cap, new rail, new vendor | Founder | `/starlight-board` pressure-test + **human approval** |
| Irreversible (delete, rename live URL, rotate key, send blast, move funds) | Founder | **human approval, always** |

Maps to the four `Decision` tiers: `autonomous` → `queen-gate` → `founder-board`
→ `human-gate`. The ladder is **worker → queen → founder → human**.

**The standing rule (from `agentic-business-os`):** *agents draft, gate, and
commit; humans deploy, post, and send.*

This implements **L4 (escalation)**, **L5 (payment governance)**, and **L7
(human gate)** of `agentic-ops-hub/docs/PROTECTION-LAYERS.md`.

---

## How it consumes the MCP substrate

Integration points are typed interfaces in `src/swarm/integrations.ts`. v0.1
references them via dry-run stubs — it does **not** hard-require a live MCP server.

### SIS Vault MCP (`sis_*`) — memory + attestation

- `sis_append_entry` — append-only memory write (the only side effect a worker is
  allowed). Workers get **append-only**; queens get **read-write within their
  stream** (IAM L3).
- `sis_vault_search` — read prior context before acting (memory-first).
- `sis_confirm` — strengthen a confirmed pattern (queen rw).

State lives in the vault, not in the worker — workers are stateless between tasks.

### Payments MCP (`payment-intelligence-system/mcp`) — verify-only, fail-closed

**Only the Payments Queen** can call the Payments MCP, and only **verify-only**
tools (IAM L3). There is no `transfer` / `pay` / `settle` / `move_funds` tool —
none exists, by design.

- `verify_mandate` — was THIS purchase for THIS amount authorized? (AP2)
- `check_spend_cap` — per-transaction / per-day / per-stream caps; over cap →
  escalate, never auto-approve.
- `record_audit_entry` — every payment verdict is written to the L1 audit log before it
  is acted on; if the write fails, the action fails. The Payments Queen sequences this;
  the MCP does not require a prior audit entry.
- `require_human_approval` — hand off to the L7 human gate. Never auto-approves.

---

## The Queen kernel

The runtime's coordination model is its own, not borrowed from an external
orchestrator. One Starlight Queen per stream; Domain Generals (architect,
weaver, sentinel, sage, hermes — `generals.ts`, vendored from the Starlight
Intelligence System with the source commit recorded) lead Specialists, who
dispatch stateless Workers. Dispatch flows down only.

Five modules make that enforceable rather than descriptive:

| Module | What it fixes in place |
|---|---|
| `brief.ts` | Nothing is dispatched without a complete Brief: objective, acceptance, output contract, tool allowlist, boundaries, micro-USD + wall-time budget, maker, and an **independent** verifier (Maker ≠ Checker by id and by model). |
| `router.ts` | `ModelRouter` v0 reads the model matrix as data and writes `usedModel` / `wasFallback` / `reason` onto every result. Critical lanes (council tier, high-risk, or flagged) never fall back silently — they refuse and escalate to the founder board. |
| `verify-contract.ts` | Completion credit comes only from checks the verifier re-runs: exact-match `allowedChecks`, no globs, no shell metacharacters, evidence re-digested and fresh, a commit named for code. Ported from the private Queen runtime's verifier contract. |
| `receipts.ts` + `run-receipt.ts` | One signed `starlight.run-receipt.v1` per dispatch (DSSE v1, in-toto Statement v1, Ed25519), byte-identical to the estate's issuer and public verifier. PASS is refused without evidence. |
| `escalation.ts` | The same ladder, now readable in the SIS risk-tier vocabulary (`riskTierOf` / `decisionFromRiskTier`; a round trip can only tighten). |

The `Queen` class (`queen.ts`) consults the verify-only Payments MCP
**audit-first**: `record_audit_entry` runs before anything else and a failed
write fails the action; an invalid mandate or an over-cap answer takes `act`
away. Governance can tighten a verdict and never loosen one.

The `starlight-queen` bin (`bin/starlight-queen.mjs` → `src/swarm/queen-cli.ts`)
exposes `brief check`, `route`, `classify`, `receipt verify`, `keygen`, `init`.
It runs nothing; dispatch belongs to the hooks pack and the private controller.

---

## Where each protection layer lives

| Layer | Implemented in |
|---|---|
| L1 Audit | `agentic-creator-os` hooks · Payments MCP `record_audit_entry` |
| L2 Circuit breaker | `agentic-creator-os` hooks |
| L3 Agent IAM | Worker = append-only vault, no Payments MCP; only Payments Queen gets verify-only Payments MCP |
| L4 Escalation | `src/swarm/escalation.ts` (this runtime) |
| L5 Payment governance | `payment-intelligence-system` MCP (verify-only, fail-closed) |
| L6 Red/blue | `starlight-evals` Income & Payments Safety lane |
| L7 Human gate | doctrine hard-stops — enforced by `classify()` returning `human-gate` |

---

## Running the dry-run

```bash
npm install
npm run swarm:dry-run    # prints the tree + escalation ladder + per-queen loop step
npm run typecheck        # tsc --noEmit
```

The dry-run prints the founder → queen → worker tree, walks every tier of the
escalation ladder via `classify()`, and runs one self-improving-loop step per
queen — including a demonstrated over-cap payment that escalates
worker → queen → founder → human. **Nothing fires. No money moves.**

Cockpit views of the same shape: the `/swarm` Next.js page and `local-cockpit.html`.
