# Starlight Team Runtime ADR

**Date:** 2026-08-06
**Status:** Proposed, implemented as a dry-run planner; deployment admission blocked
**Canonical repository:** `frankxai/starlight-swarm`
**Decision owner:** Starlight Queen with explicit founder gates

## Decision

Starlight will use a small layered runtime, not a new all-in-one agent platform:

1. **Hermes / Starlight Queen** owns admission, schedule requests, policy, leases, team composition, and human gates.
2. **Temporal on Railway** owns durable mission execution, retries, timers, checkpoints, and activity history.
3. **Railway services** host replaceable brand-isolated workers polling distinct Temporal task queues.
4. **Vercel Eve** is admitted only as a bounded interactive specialist implementation. Its schedules and memory are subordinate to Queen and SIS.
5. **SIS/Postgres** is canonical business memory. Runtime memory is disposable execution state.
6. **OpenTelemetry to Langfuse** is the primary LLM trace/evaluation path. Business receipts remain separate.
7. **n8n** is deterministic connector glue, never mission or approval authority.
8. **Provider selection is lane-specific under Queen policy.** Critical Railway lanes use direct provider contracts initially; Eve may use Vercel AI Gateway; local Hermes uses its governed provider profile. LiteLLM, OpenRouter, and AI Gateway must not simultaneously route the same production lane.

## Evidence labels

- **[O] Observed:** inspected in the current Starlight estate.
- **[D] Documented:** supported by the cited primary source.
- **[P] Proposed:** an architecture or rollout decision, not a verified deployment.

## Existing-estate truth map

| Concern | Existing authority or asset | Decision |
|---|---|---|
| Queen and worker semantics | `src/swarm/queen.ts`, `worker.ts`, `streams.ts`, `escalation.ts` | Reuse. |
| Runtime-neutral work envelope | `starlight.hand.v1` and Hand adapters | Extend through reviewed versioning; do not create a competing envelope. |
| Teams and roles | `starlight.team_profile.v2`, role catalog, compositions, existing domain profiles in `starlight-agent-config` | Import and validate; configuration remains in `starlight-agent-config`. |
| Scheduling | Hermes cron and Queen job contracts | Queen remains sole schedule authority. Workers are reactive. |
| Durable execution | Existing Railway Temporal services [O] | Adopt after live health, budget, credential, and recovery gates pass. |
| Integrations | Existing n8n queue-mode estate [O] | Deterministic connector and webhook activities only. |
| Model routing | Existing LiteLLM plus direct/Vercel/Hermes provider paths [O] | Queen chooses exactly one provider ingress per lane. LiteLLM is optional until governance and health are verified. |
| Observability | Existing Langfuse services and Observatory candidate [O] | OTel to Langfuse; operator projection can later feed Observatory. |
| Canonical memory | SIS/Postgres policy | Preserve. Temporal history, Eve memory, framework memory, and Redis are not canonical business truth. |
| Local operation | Hermes on Yogabook | Control-plane pilot and bounded private runs, not an HA promise. |
| Cross-machine work | Swarm bus and C940 backend role | Use durable peer envelopes; do not coordinate backend work by chat alone. |

## Runtime decisions

| Surface | Fit | Decision |
|---|---|---|
| Hermes / Queen | Admission, policy, desktop/operator actions, bounded local work | **Adopt as control plane.** |
| Railway + Temporal | Durable missions, waits, retries, task queues, long-running workers | **Adopt as durable backbone and worker host.** |
| Vercel Eve | Interactive TypeScript agent service with tools, skills, channels, connections, sandbox, subagents, schedules, and evals | **Narrow pilot.** Disable independent schedules and canonical writes. |
| Vercel AI SDK | TypeScript model/tool abstraction inside a worker or app | **Adopt selectively.** Not an orchestrator. |
| Vercel AI Gateway | Managed multi-provider gateway, budgets, fallbacks, observability | **Narrow pilot for Eve.** Never dual-route a lane. |
| Vercel Workflow | Vercel-native workflow persistence | **Reject as Queen backbone.** Existing Temporal is the durable authority. |
| Vercel Sandbox | Ephemeral isolated execution | **Narrow pilot for hazardous code/artifact tasks.** Not always-on hosting. |
| n8n | Queue-mode connectors and deterministic integrations | **Adopt narrowly.** Reject as agent authority. |
| OpenHands | Bounded coding specialist in isolated workspaces | **Narrow pilot.** No broad desktop or production credentials. |
| OpenClaw | Parallel scheduler, tools, plugins, browser, subagents | **Reject as durable core.** It duplicates Queen authority. |
| LangGraph | Graph-heavy reasoning agent with persistence and interrupts | **Narrow pilot only when measured need exists.** |
| Mastra | Overlapping agents/workflows/memory/evals | **Watch.** Avoid framework soup. |
| Dify | Visual workflow/knowledge application platform | **Reject for core.** It creates another prompt/memory/auth source of truth. |
| Composio | Managed OAuth/connectors | **Narrow pilot for one non-critical scoped integration.** |
| Cloudflare Agents | Edge stateful/realtime sessions | **Watch until a measured edge need exists.** |
| Direct providers | Production-critical lanes and model-specific capabilities | **Adopt initially.** |
| OpenRouter | Discovery, evaluation, overflow, non-critical research | **Narrow pilot.** Not primary production routing. |
| Langfuse + OTel | Vendor-neutral traces, evaluation, metrics | **Adopt as primary.** |
| LangSmith | Strong LangGraph pairing | **Watch.** Do not run dual-primary trace systems. |

## Team operating model

A domain team is a governed **3–5 role cell**, not a dozen permanently hot model loops.

### Mandatory roles

1. **Coordinator** — receives Queen-issued missions, decomposes bounded work, owns no final verification.
2. **Maker** — performs the domain task and emits an artifact plus receipt.
3. **Independent verifier** — checks evidence, policy, budget, quality, and duplication; cannot be the maker.

### Optional fourth and fifth roles

- **Channel or domain specialist** — for example content, social, data, integrations, or customer research.
- **Security/SRE specialist** — for credentials, production runtime, recovery, or infrastructure-sensitive work.

Chief roles such as CEO, CTO, CMO, COO, CFO, CSO, legal, and ethics are **governance lenses or scheduled review roles**, not automatically separate always-on agents. A team adds one only when its decision rights and measurable work justify the cost.

### Required team-pack context

Each admitted domain team must resolve these concepts from existing governed files or explicit references:

| Concept | Required content |
|---|---|
| `SYSTEM` | Mission, identity, decision rights, non-goals, escalation path. |
| Brand context | Audience, offers, vocabulary, canonical facts, claims boundaries. |
| `QUALITY` | Definition of done, evidence thresholds, evaluator rubric. |
| `TASTE` | Brand and design taste references where the domain produces creative work. |
| `WORKFLOWS` | Inputs, steps, handoffs, receipts, retry and recovery behavior. |
| Tools | Explicit allowlist, scopes, credentials domain, MCP filters. |
| Memory policy | Canonical read/write namespaces, retention, redaction, projection-only rules. |
| Evals | Deterministic checks, independent checker policy, promotion criteria. |
| Budget | Per-run and daily token/tool/cost/time ceilings. |

The canonical team-profile files remain in `starlight-agent-config/core/teams`. This repository validates and plans their execution; it does not fork their definitions.

The implemented `runtime:pack` compiler now materializes that context as a content-addressed,
dry-run pack containing `SYSTEM.md`, `WORKFLOWS.md`, `QUALITY.md`, `GUARDRAILS.md`,
`TASTE.md`, `MODEL-ROUTING.md`, `CAPABILITIES.md`, `MEMORY.md`, a synthetic ICP testing
contract, one bounded prompt per admitted role, and the exact Queen-owned runtime-policy
snapshot. The pack manifest binds every file to the source-profile, runtime-plan, and
runtime-policy digests. `runtime:pack:verify` independently receives those three canonical
sources and rejects tampering, source drift, undeclared files, missing files, byte drift,
path escape, and symlinks. A verified pack is still not an activation approval.

Pack-verification results are frozen and recorded in a process-local issuance registry before
`runtime:prepare` accepts them. A caller-created object with identical fields is rejected. This
removes an accidental object-forging path inside the preparation process; it is not a substitute
for a future signed, revocable, server-owned admission receipt.

## Initial three-lane proof

The checked-in `starlight-platform-pilot.plan.json` is a deliberately blocked integration
proof that exercises the first two preferred hosted surfaces without pretending the
Yogabook is highly available:

| Lane | Mission | Runtime | Permissions |
|---|---|---|---|
| Operator intelligence / coordinator | Interactive intake, routing, and bounded decision support | Vercel Eve through Vercel AI Gateway; Temporal remains mission authority | Explicit Eve allowlist; no independent schedule, canonical writes, deployment, send, or approval authority. |
| Durable builder | Typed backend/data implementation with checkpoints and approval waits | Railway worker under Temporal using one direct-provider ingress | Owned paths only; production, secrets, migration, spend, and destructive operations remain gated. |
| Independent verifier | Reproduce tests, security, release, rollback, and evidence checks | Local Hermes pilot under Temporal authority; move to an isolated Railway checker before HA claims | Read/audit by default; cannot certify its own work or mutate the source artifact. |

These are event-driven lanes, not continuous token-burning loops. The local verifier is not
24/7 while the Yogabook sleeps, is offline, or fails its capacity gate. No checked-in lane is
currently activated.

## Prepared scheduling, identity, and recovery invariants

These remain rollout requirements. The non-activating `runtime:prepare` layer now emits
deterministic deployment IDs, Temporal task queues and workflow-ID prefixes, concurrency-one
limits, lease TTLs, heartbeat timeouts, required secret *names*, and kill-switch names. It
does not start a process, create a lease, execute a side effect, reconcile recovery state, or
grant deployment authority. Operational enforcement therefore remains a Phase-1 gate.

Derived deployment, queue, workflow, and kill-switch identifiers include a digest suffix of the
original governed ID, so normalization-equivalent IDs cannot collide. Prepared bundles have a
strict adapter-specific runtime parser and must be recomputed from the exact plan plus an issued
pack-verification result before consumption. JSON Schemas remain structural export contracts;
their `$comment` and `x-starlight-validation-authority` annotations explicitly prohibit treating
schema-only validation as admission.

The Phase-0 health probe is fail-closed: only loopback HTTP(S) on exact `/health` is accepted.
All remote hosts—including metadata and private addresses—are rejected before fetch. Remote
health checks remain blocked until a server-owned endpoint registry, DNS resolution controls,
address pinning, and rebinding defenses are implemented.

1. Queen is the only scheduler. Temporal, Railway cron, Eve, OpenClaw, n8n, and workers must not create independent recurring mission schedules.
2. Temporal workflow ID is the durable run identity; each concrete run must carry `hand_id`, `brand_id`, `lease_id`, and `attempt` beyond the prepared prefix.
3. Every side effect requires an idempotency key.
4. Workers heartbeat leases and stop on expiry, revocation, budget breach, forbidden action, or credential-scope error.
5. Retries are bounded by wall time, attempt count, token/tool/cost ceilings, and side-effect safety.
6. Recovery must reconcile Temporal history, SIS projection, receipt state, and duplicate keys before resuming.
7. Framework state can be rebuilt. SIS/Postgres and signed receipts remain authoritative.
8. Sends, publication, payment, deployment, DNS, credentials, destructive changes, and new standing cost remain human-gated.

## Model and token policy

Queen chooses a quality tier and exactly one provider ingress for each lane:

| Route | Intended use | Gate |
|---|---|---|
| `economy` | Extraction, classification, deterministic transformations | Escalate when confidence or evaluator threshold fails. |
| `balanced` | Coordination and routine drafting | Bounded tool loops and daily caps. |
| `frontier` | High-value synthesis or difficult implementation | Requires value justification and strict per-run ceiling. |
| `checker-independent` | Independent verification | Must not reuse the maker's exact model/provider path where independence matters. |

Initial provider routes:

- **Railway Temporal critical lane:** direct provider contract.
- **Vercel Eve specialist:** Vercel AI Gateway, scoped to the Eve lane.
- **Hermes local lane:** governed Hermes provider profile and subscription-aware limits.
- **OpenRouter:** evaluation/overflow only until data-processing, logging, and budget policy are approved.
- **LiteLLM:** existing estate asset, but optional rather than canonical until health, governance, and routing ownership are proven.

The current example team ceiling is **$25/day**, with lane caps totaling **$19/day**. These are planner limits, not authorized spend.

## Admission result on 2026-08-09

The planner and assessor were rerun against the governed Starlight platform team, Queen-owned runtime policy, and checked-in workload example. The committed evidence snapshot was observed at `2026-08-09T04:28:06.000Z`.

**Result:** `admitted: false`

Blockers preserved in `runtime/generated/starlight-platform-pilot.assessment.json`:

1. Vercel Eve runtime health is `unknown`.
2. Railway Temporal runtime health is `unknown`.
3. The isolated Hermes runtime health is `unknown`.
4. Production admission authority is intentionally not implemented; caller-authored receipts remain non-authoritative even when digest-bound.

The snapshot records 9.85 GiB of available Yogabook memory. That point-in-time local observation is report-only and does not establish live runtime capacity or activation authority. The dry-run therefore did not mutate Railway or Vercel and did not arm the Hermes lane.

## Rollout gates

### Phase 0 — dry-run planner

- Contract parsing, runtime selection, provider routing, budgets, admission, and evidence artifacts.
- Full repository test gate.
- No deployment.

### Phase 1 — three-worker proof

- One named task queue per lane.
- Concurrency one.
- Read-only or draft-only permissions.
- Seven completed bounded runs per lane before promotion.
- Measure accepted outputs, citation coverage, evaluator agreement, cost/run, retries, elapsed time, operator minutes, policy denials, and duplicate execution.

### Phase 2 — 8–15 workers

- Queues split by `brand × risk class`.
- Explicit leases, heartbeat, backpressure, circuit breakers, and per-brand budgets.
- Separate credentials and services for higher-risk brands.

### Phase 3 — 20–50 workers

- Versioned worker catalog: image, Hand versions, tools/MCP, model policy, resource envelope, risk tier, and deprecation date.
- Horizontal worker replicas behind stable task queues.
- Specialist frameworks promoted only after paired evidence against the plain Temporal-worker baseline.

## Verification evidence

The canonical test and release checks were refreshed on 2026-08-09 after compiler-v2,
profile-provenance, verifier-capability, loopback, and identity hardening:

```text
npm test
153 tests, 153 passed, 0 failed

npm run build
Next.js production build compiled successfully

gitleaks detect --source . --redact --config .gitleaks.toml
no leaks found
```

Four JSON Schemas cover the policy, plan, pack manifest, and prepared runtime bundle. They are
explicitly structural/export-only because JSON Schema cannot encode all uniqueness, routing,
and canonical-source semantics. Runtime Zod parsers and exact external source/digest verification
remain mandatory. The prepared-bundle schema now has adapter-specific configuration branches,
and its runtime parser additionally enforces cross-lane authority bindings. No production
deployment was claimed.

The standalone assessor cannot return `admitted: true`: a production integration must inject
a trusted authority that verifies both receipts against the canonical plan SHA-256 digest,
receipt expiry, approval scope, and budget policy. Caller-authored JSON is evidence input, not
an authority source.

## Primary sources

- Hermes Kanban: <https://hermes-agent.nousresearch.com/docs/user-guide/features/kanban>
- Hermes MCP: <https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp>
- Temporal Workflows: <https://docs.temporal.io/workflows>
- Temporal self-hosting: <https://docs.temporal.io/self-hosted-guide>
- Railway services: <https://docs.railway.com/reference/services>
- Railway cron: <https://docs.railway.com/cron-jobs>
- Railway volumes: <https://docs.railway.com/volumes>
- Railway health checks: <https://docs.railway.com/deployments/healthchecks>
- Vercel Eve: <https://eve.dev/docs/getting-started>
- Vercel Eve repository: <https://github.com/vercel/eve>
- Vercel AI SDK: <https://ai-sdk.dev/docs/introduction>
- Vercel AI Gateway: <https://vercel.com/docs/ai-gateway>
- Vercel Workflow: <https://vercel.com/docs/workflow>
- Vercel Sandbox: <https://vercel.com/docs/vercel-sandbox>
- n8n queue mode: <https://docs.n8n.io/hosting/scaling/queue-mode/>
- OpenHands MCP: <https://docs.openhands.dev/sdk/guides/mcp>
- LangGraph: <https://docs.langchain.com/oss/javascript/langgraph/overview>
- Mastra workflows: <https://mastra.ai/docs/workflows/overview>
- Composio: <https://docs.composio.dev/docs>
- OpenRouter routing: <https://openrouter.ai/docs/guides/routing/provider-selection>
- Langfuse evaluation: <https://langfuse.com/docs/evaluation/overview>
- OpenTelemetry GenAI conventions: <https://opentelemetry.io/docs/specs/semconv/gen-ai/>
