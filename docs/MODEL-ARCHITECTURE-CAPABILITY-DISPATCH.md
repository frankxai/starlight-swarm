# Capability-checked dispatch (Model Architecture absorption)

**Wave 2 · skill/doc only**  
**Source:** [starlight-swarm #27](https://github.com/frankxai/starlight-swarm/pull/27) — capability-checked orchestration reference kit  
**Owner:** Model Architecture (doctrine) · Human gates: Queen / Frank  
**as_of:** 2026-09-26

## Hard bans (this absorption)

- **No live funds**
- **No Arena dump** into routing / PromoteGate priors
- **No spend wiring**
- **No auto-promote** of model presets or RouteBindings
- GPT-6 / any presets in #27 remain **provisional-unranked** until PromoteGate + org golden tasks pass

Pack A honesty still applies: public boards = priors; suggested → shadow → canary → promote; `judge ≠ generator`; `critic ≠ writer` on book/content/critique; Arena n&lt;3 / matching-judge family = refuse as prior.

## What #27 contributes (patterns to keep)

### 1. Capability catalog (not name-inference)

A model is callable only when a catalog row says so:

| Field | Rule |
|---|---|
| `model`, `provider`, `runtime` | Exact identity |
| `available` | Must be `true` from a **harness probe**, never from "model is installed" |
| `verifiedAt` | Probe freshness (kit default **24h**) |
| `efforts`, `tools` | Must cover the request |
| `evidenceRef` | Required; missing → skip candidate |

`selectModel` holds when no fresh available row matches runtime / effort / tools / `independentOf` reviewer exclusion.

### 2. Five bounded plan patterns

| Pattern | Meaning |
|---|---|
| `single` | One bounded task |
| `sequential` | Dependent steps |
| `parallel` | Independent evidence (writers' path scopes must be disjoint) |
| `manager` | ≤2 workers + synthesis |
| `refinement` | Implementer + verifier; one correction attempt |

Plans are small (kit: 1–4 tasks). Role names do not spawn agents.

### 3. Dispatch safety

1. Persist **dispatch-intent checkpoint** before every adapter call  
2. Pass stable **idempotencyKey** per task attempt; adapter binds effects or reconciles before retry  
3. Timeout / unverified post-dispatch → status **`unknown`**, retain capacity claim, **block resume** until reconciled  
4. Serialize concurrent checkpoint writes  
5. Failed intent checkpoint → **no adapter call**  
6. Consequential risk → verifier must use a **different `reviewerProvider`**

### 4. Leadership shape (org, not code)

CEO owns outcomes; one coordinator owns dependencies; domain queens own acceptance; specialists own artifacts. Machine concurrency ≤2 workers. Cost/time break quality ties — never replace correctness.

## Map onto Model Architecture OS

| #27 concept | OS object |
|---|---|
| Capability catalog + probe freshness | `ModelRecord` + `EvidenceRef` + Registry `last_verified` |
| `selectModel` hold | fail-closed router / `status: hold` |
| `independentOf` reviewer | `judge ≠ generator` / non-matching judge family |
| Plan patterns | lane×role work graphs (not auto fleet spawn) |
| Checkpoints / receipts | PromoteGate + trace contract (`eval_run_id`, …) |
| Provisional presets | `RouteBinding(status=suggested)` only |

**Do not** copy #27 GPT-6 route table into Pack A production pins. Re-suggest via Registry; promote only through software / book / agent_planning gates after golden tasks exist.

## Adoption checklist (doc-only)

- [ ] Hosts supply durable `onCheckpoint` (demo fixture is volatile — not production)  
- [ ] Adapters honor AbortSignal and real FS/tool scopes  
- [ ] Capability probes independent of installed-model lists  
- [ ] Arena / frankx `/llm-hub` stay hypothesis until R4+ n≥3 non-matching judge  
- [ ] Human gate Queen/Frank before any merge that activates live spend or production pins  

## References

- Upstream kit: PR #27 orchestration reference (when code lands: `src/swarm/orchestration/README.md`)  
- Pack A: `/workspace/model-architecture/pack-a/` (policy-pack, HONESTY-GATES, PromoteGates)  
- Model Router v1: [`docs/MODEL-ROUTER-SPEC.md`](./MODEL-ROUTER-SPEC.md)  
- System OS: [`docs/GOD-MODE-SWARM-OS-V2.md`](./GOD-MODE-SWARM-OS-V2.md)
