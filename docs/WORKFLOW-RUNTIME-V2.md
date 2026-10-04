# Workflow ownership migration

The accepted [Ops registry](https://github.com/frankxai/agentic-ops/blob/68bc808de3a3b8e33043e59ec43979dde5488623/registry/architecture_decisions.yaml)
assigns Cloudflare Workflows to agent/cross-service work whose identity/state is
in Cloudflare, and Vercel Workflows to app-local work. Each workflow has one
durable owner. Railway hosts replaceable executors; n8n handles connectors.

The v2 path carries that rule through planning, pack compilation, verification
and preparation. It produces inspectable, recoverable files. It cannot start a
workflow, deploy an executor, grant tools or authorize a pilot. Actual useful
remote work and the full creator outcome remain open in
[issue #15](https://github.com/frankxai/starlight-swarm/issues/15).

## Contracts

| Artifact | Current path | Existing recovery path |
|---|---|---|
| Planning policy | `starlight.runtime_planning_policy.v2` | v1 unchanged |
| Team runtime plan | `starlight.team_runtime_plan.v2` | v1 unchanged |
| Pack manifest | `starlight.team_pack.v2` | v1 unchanged |
| Compiler | `starlight.team_pack.compiler.v3` | v2 unchanged |
| Prepared bundle | `starlight.prepared_runtime_bundle.v2` | v1 unchanged |

Every workload names a `workflow_id`. The exact policy supplies each workflow's
scope, identity/state owner and durable engine. The parser rejects conflicting,
missing or unused owners. Different workflows can use different engines; lanes
in the same workflow cannot split durable authority. Engine choice is distinct
from executor placement. Code work uses a Railway worker; bounded private local
work uses Hermes. An always-available private job is refused instead of silently
moving its data into a cloud executor. This placement does not certify residency
or grant access to private data.

Compiler v3 binds the full profile, immutable profile source, policy digest,
owner map, lane contracts, cost ceilings and independent verifier. It adds
`WORKFLOW-OWNERSHIP.json` to the existing team pack and renders current ownership
in its system/lifecycle/model instructions. The verifier reads actual files,
checks declared bytes and hashes, and recompiles the canonical pack. A copied
verification object cannot prepare a bundle. Prepared workflows have separate
instance/deployment identities; executor lanes reference their one bound owner.

JSON Schemas are structural exports. Ownership, profile, role, policy and budget
checks run in the semantic parser and canonical verifier. An imported descriptor
must equal the bundle derived from the exact plan and issued pack receipt.

## Reproduce the preparation path

Use the existing dependency toolchain and an unchanged profile from its declared
Git source. The included v2 example pins the current read/search verifier profile
at `frankxai/starlight-agent-config` commit
`b878eca0eb1367debfa6e52ead75c4f1213259a2`. The older b12e904 profile has different
verifier tools and metadata. Substituting the current file into that old source
reference is correctly refused by the Git provenance check.

```powershell
$profilePath = 'C:/Users/frank/starlight/repos/starlight-agent-config/core/teams/starlight-platform-team.team-profile.json'
$policyPath = 'runtime/policies/starlight-platform-workflow-v2.runtime-policy.json'
$planPath = 'runtime/generated/starlight-platform-workflow-v2.plan.json'
$packPath = 'runtime/generated/packs/starlight-platform-workflow-v2'

npm run runtime:plan -- $profilePath runtime/examples/starlight-platform-workflow-v2.workloads.json $policyPath --output $planPath --generated-at 2026-10-04T03:00:00Z
npm run runtime:pack -- $profilePath $planPath $policyPath --output $packPath
npm run runtime:pack:verify -- $packPath $planPath $profilePath $policyPath
npm run runtime:prepare -- $packPath $planPath $profilePath $policyPath --output runtime/generated/starlight-platform-workflow-v2.prepared-runtime.json
```

Use a new output path for another revision. Existing output protection and pack
writer checks apply. Preserve old files and receipts for export/recovery; do not
replace engine names inside an old generated pack or relabel a v1 receipt. The
legacy admission parser rejects v2 plans. Current v2 preparation requires a
compiler-v3 receipt, exact hashes and explicit owner bindings; those checks still
do not implement operation-time activation authority.

## Evidence and remaining work

The focused tests exercise both owners, mixed distinct workflows, duplicate
ownership, policy/engine substitution, role independence, private-data placement,
hard planning ceilings, real pack write/verify/prepare, tampering and fabricated
receipts. Legacy tests and full repository CI remain required. A synthetic team
test is distinct from the immutable profile example and from a live mission.

The serious alternative is the existing v1 Temporal planner/compiler on the same
team/profile inputs. It retains its export/recovery contract. V2 addresses the
accepted ownership rule and prevents unbound engine substitution. These are
planning/compiler comparisons; they do not measure useful output, hardware
throughput, live reliability, billed cost or commercial demand.

Next implement authenticated operation-time adapters against the existing durable
authority registry, with exact engine/instance/operation binding, cumulative
budget reservations, external revocation/kill authority and destination readback
after uncertain dispatch. Verify against the current
[Cloudflare Workers API](https://developers.cloudflare.com/workflows/build/workers-api/),
[trigger API](https://developers.cloudflare.com/workflows/build/trigger-workflows/)
and [Vercel Workflows documentation](https://vercel.com/docs/workflows).
Fresh tenant/binding/access/health evidence, independent security review and the
named human-approved reversible pilot remain required. A provider's termination
API does not prove that an executor stopped or an external effect was undone.

No live funds, recurring schedule, paid fallback, worker activation or production
release follows from this migration. The existing EUR100 pilot ceiling and the
held npm cache are unchanged. Product design, buyer acceptance and measured
creator outcomes remain part of the wider AI factory objective.
