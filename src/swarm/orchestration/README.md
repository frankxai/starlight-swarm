# Quality-first orchestration reference kit

Candidate version 1.0.0. Node 22+, no installation or API key required for the demo.
This directory is covered by the repository MIT license. All implementation is
original; official documents are attributed in `sources.json`, not copied.

```sh
node --test src/swarm/orchestration/orchestration.test.mjs
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
callback and optional AbortSignal/checkpoint callback. The adapter must honor
AbortSignal and stop its own work; the library cannot forcibly stop remote jobs.
Timeout stops scheduling, but is not proof of remote cancellation. The adapter
must enforce actual filesystem scopes, permissions and tool grants; contract
validation is not an OS sandbox. External effects require idempotency controls.

Adapters report actual model/provider/runtime, artifact references and optional
usage. Verifiers return `passed`, `evidenceRefs`, and failure `feedback`.
Consequential work also requires a different `reviewerProvider`. These callbacks
are trusted integration boundaries; provider strings are not cryptographic proof.
Hosts must bind them to actual invocation receipts before production use.

Checkpoints bind the exact plan and policy. Resume re-verifies artifact existence
and validity through the verifier before skipping work. Callers persist receipts
privately and redact them before sharing. Missing usage stays null. Capability
failure returns hold; execution failure preserves verified work for diagnosis.

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
