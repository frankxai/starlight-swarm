# Quality-first orchestration reference kit

Candidate version 1.0.0. Node 22+, no installation or API key required for the demo.
This directory is covered by the repository MIT license. All implementation is
original; official documents are attributed in `sources.json`, not copied.

```sh
node --test src/swarm/orchestration/*.test.mjs
node src/swarm/orchestration/demo.mjs
```

The demo uses fixture adapters. It proves control flow, not model quality or
provider availability. GPT-6 presets are provisional and do not alter any live
default. `ultra` is never enabled implicitly. No funds, process launch, publishing,
or merging is exposed by this library.

## Interfaces

`selectModel(request, catalog, presets)` selects an exact supported model/effort
in one runtime. Requests name `taskClass`, `runtime`, `tools`, optional `model`
and `effort`. Fallback requires `allowFallback: true` and ordered `fallbacks`.
`independentOf` excludes the maker's provider when selecting a reviewer.
Capability rows require `model`, `provider`, `runtime`, `available`, `verifiedAt`,
`efforts`, `tools`, and `evidenceRef`. Probe evidence expires after 24 hours.
An installed model list alone must not set `available: true`.

`runPlan(plan, options)` supports single, sequential, parallel, manager and
refinement patterns. Each task names objective, repo, access, risk, owned paths,
input references, dependencies, artifact, stop condition, verification and request.
Manager means up to two independent workers followed by synthesis. Refinement
means an implementer and verifier, with one correction attempt. Reads may overlap;
writer scopes must be disjoint, including parent/child and case aliases.

The caller provides admission, catalog, an execution `adapter`, a `verify`
callback and a required `onCheckpoint` writer. The writer must durably persist
each snapshot before acknowledging it; the included demo deliberately uses a
volatile fixture callback. A dispatch-intent checkpoint precedes every adapter
call. The adapter receives a stable `idempotencyKey` for each task attempt and
must bind it to external effects or reconcile those effects before retrying.
The adapter must honor AbortSignal and stop its own work; the library cannot
forcibly stop remote jobs. A timeout or unverified post-dispatch error returns
`unknown`, retains the task's capacity claim in the receipt, and blocks checkpoint
resume until an integration reconciles the effect. The adapter must enforce
actual filesystem scopes, permissions and tool grants; contract validation is
not an OS sandbox.

Adapters report actual model/provider/runtime, artifact references and optional
usage. Verifiers return `passed`, `evidenceRefs`, and failure `feedback`.
Consequential work also requires a different `reviewerProvider`. These callbacks
are trusted integration boundaries; provider strings are not cryptographic proof.
Hosts must bind them to actual invocation receipts before production use.

Checkpoints bind the exact plan and policy. Resume re-verifies artifact existence
and validity through the verifier before skipping work. An unresolved dispatch
cannot be resumed as a new invocation. Callers persist receipts privately and
redact them before sharing. Missing usage stays null. Capability failure returns
hold; execution failure preserves verified work for diagnosis.

Recovery validates checkpoint ownership, unresolved execution and cached task/artifact
shape before a capability hold can hide them. A valid hold preserves a cloned copy
of prior results and events; it grants no execution or verification acceptance.
With a current capability selection, resume checks cached output identity, passes
the caller's AbortSignal to verification and checks cancellation before and after
each callback. Verification receives a copy of the cached output, and a successful
resume records the fresh verification evidence without dispatching completed work.
If resume rejects, the caller keeps its original checkpoint and capacity state.
Hosts must bound an uncooperative resumed verifier; this library's task timeout
does not cancel remote work or impose a deadline on the resume callback.

The eleven recovery regressions and exact runtime repair come from
[the original private-source task's integration packet](https://github.com/frankxai/starlight-swarm/issues/15#issuecomment-5938322059),
against base `286b618b0d1124c9798eedcd9f2b0fc46a6fc9bc`.
The recovered runtime SHA256 is
`8a5d14bc20d45f8778097608d6b59ec5e5ca4cd62ecb4e09c5d072b165220dbe`.
These fixture tests establish recovery behavior in this reference library. Durable
SIS/Postgres authority, operation-time grants, authenticated provider/host receipts,
external cancellation and a separately approved live pilot remain integration gates.

## Leadership and adoption

The CEO selects outcomes; one coordinator owns dependencies and integration;
domain queens own acceptance; specialists own bounded artifacts. Role names do
not create agents. Machine limits cap concurrency at two workers or fewer.

Use a single owner for coupled edits, a sequence for dependent steps, parallel
workers for independent evidence, and independent provider review for consequential
results. Compare these patterns on the frozen `starlight-evals` pilot before
promoting defaults. Cost and time break quality ties, never replace correctness.

Integration is opt-in. Existing Swarm admission, charter and human approval gates
remain authoritative. Hosted API delegation, Codex subagents and SDK handoffs
need different adapters and independent capability probes.

## Measured quality and cost routing

Author: Codex. Created 31 October 2026, revision 1. Review state: candidate;
fixture checks establish routing behavior, not live model quality or savings.

Requests may opt into `selectionPolicy` version 1. Existing requests keep their
explicit ordered model selection. Supply evaluation records through the trusted
host's `selectModel` options or `runPlan(..., { evaluations })`, never task text.
The host must verify their source; hashes identify records but do not authenticate
an evaluator. A public model catalog establishes neither quota nor tool access.

```js
const selectionPolicy = {
  version: 1, mode: 'frontier',
  datasetId: 'repair-suite-v1',
  datasetHash: '<64 lowercase hex characters>',
  rubricHash: '<64 lowercase hex characters>',
  caseCount: 100, minimumLowerBound: 0.9,
  maxCostPerAcceptedMicroUsd: 25_000,
};
```

Each evaluation binds exact model, provider, runtime, effort, task class, dataset
and rubric hashes, `caseCount`, `acceptedCases`, `attempts`, `criticalFailures`,
`verifiedAt`, `evidenceRef` and `costEvidenceRef`. `totalCostMicroUsd` is a safe
nonnegative integer. Require `costBasis: 'all-attempts-measured'` and
`costScope: 'execution-repair-and-verification'`: retries, failed attempts,
repair and independent checking belong in the cost. Unknown cost cannot be zero.
Hosts reconcile duplicate records before calling this selector. A suite must
contain at least 20 frozen cases; every candidate runs the same full suite.
Evaluations expire after seven days, capabilities after 24 hours. Critical
failures, future/stale evidence, missing costs or a failed quality floor hold.

`frontier` maximizes the Wilson 95% lower bound of the observed accepted-case
proportion; measured cost breaks exact ties. If the best qualified quality
exceeds the ceiling, return hold. `efficient` is explicit and only permitted for
ordinary tasks; `qualityTolerance` is zero by default and at most 0.02 in lower
bound units. It picks the least measured cost among candidates within that
tolerance of the observed best quality. Architecture and security always require
frontier mode. `runPlan` takes risk from the containing task, so request fields
cannot downgrade it; standalone selection defaults to consequential risk.
Existing exact-model, explicit fallback, tool and reviewer independence checks
still apply. This score compares one frozen suite only; benchmark design,
independence of cases and reviewer accuracy remain host responsibilities.

Selection receipts include observed quality, measured cost per accepted case,
source references and record hash. `executionAuthorityGranted: false` is explicit.
These metrics do not reserve a budget, spend credits or qualify production use.
Record real accepted product outcomes before promoting a default. Candidate
pricing, provider marketing and synthetic fixtures cannot establish superiority.

## Runtime lifecycle and deployment ownership

For aliases `jules` and `jules-cloud`, selection refuses new execution at or after
`2026-11-11T00:00:00.000Z`. This is a conservative operator cutoff: Google's
[29 October turndown notice](https://jules.google/docs/changelog/2026-10-29)
names a date, not an exact timezone. The notice permits finishing sessions until
11 November, then makes the service read-only, with winddown on 31 December.
Export/recovery is the remaining use; keep secret-bearing exports private.
Capability probes can provide an earlier `executionNotAfter`; invalid dates fail
closed. This library checks selection admission. It does not cancel running
remote jobs or modify estate dispatchers that do not call it.

The proposed split reuses the existing estate architecture, rather than adding
an orchestrator:

| Boundary | Preferred host | Durable owner and evidence |
| --- | --- | --- |
| Product UI, previews and app-local agent journeys | Vercel, existing Next.js apps; eve/AI SDK where already adopted | Product workflow owns its request; trace, preview and verified journey |
| Persistent cross-service coordination | Cloudflare Workers with Durable Objects and Workflows | One object/lease owns a job; stable operation id and durable receipt |
| Bounded coding | Existing subscription Codex Cloud; separately admitted isolated execution | Exact repo/base/paths, artifact and independent review |
| PR extraction and cheap bounded classification | Cloudflare Workers AI only after qualification | Exact-head decision, scoped grants and measured usage |
| Product research and R&D | Admitted subscription harness first | Source-backed findings, dated evaluation, draft issue or patch |

Persistent means recoverable state and event-driven wakeups, not an infinite
polling/model loop. Queues handle bounded delivery and a dead-letter path; R2
holds immutable evidence; existing trusted operation authority must still bind
tenant, repository, lease, cancellation, budget reservation and credential scope.
GitHub Issues/PRs remain the work and review surface. Each request has one durable
owner even when its execution crosses hosts.

A single-host Vercel design would simplify product-local work, but would move
existing cross-service coordination. A Cloudflare-only design would use the
available infrastructure credit while migrating accepted product experiences
and their preview/release workflows. The split preserves those implementations;
its extra boundary requires authenticated handoff and reconciled operation ids.
The [existing execution proposal](https://github.com/frankxai/agentic-ops/pull/395)
and [isolated CI evidence candidate](https://github.com/frankxai/railway-ci-runners/pull/32)
retain their own review and activation gates. This selector deploys neither.

Official runtime references inspected 31 October 2026:
[Vercel agent stack](https://vercel.com/agents),
[Cloudflare Agents with Workflows](https://developers.cloudflare.com/agents/concepts/workflows/).
Gemini 3.6 Flash remains production-available but is a previous-generation model
according to [Google's model documentation](https://ai.google.dev/gemini-api/docs/models/gemini-3.6-flash).
Compare it with current available candidates on the same suite before selecting
it by price or reputation. No live provider default changes in this candidate.
