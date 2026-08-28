# Success criteria — highest demands

Starlight Swarm is the **best swarm repo** only if these hold in code. A README
claim without a test or a ledger row is a charter clause-6 failure.

Status is computed from [`src/swarm/success-criteria.ts`](../src/swarm/success-criteria.ts).

| ID | Demand | Status | Proof |
|---|---|---|---|
| SC-01 | Exactly one canonical L6: this repo | **met** | `kernel.test.ts` |
| SC-02 | No estate monorepo. Adjacent products stay pinned | **met** | `kernel.test.ts` |
| SC-03 | No transfer / pay / settle / move_funds tool | **met** | `integrations.test.ts` |
| SC-04 | Charter may only raise a gate | **met** | `charter.test.ts` |
| SC-05 | Team profiles are Git-pinned; working-tree drift fails closed | **met** | `runtime-provenance.test.ts` |
| SC-06 | Admission is report-only | **met** | `runtime-admission.test.ts` |
| SC-07 | Absorbed research is attributed and has a refuse line | **met** | `absorption.test.ts` |
| SC-08 | Hands compile and stay blocked until explicit enable | **met** | `hand-adapter.test.ts` |
| SC-09 | Eve is never mission authority | **met** | `runtime-security.test.ts` |
| SC-10 | SIS Gateway enforces worker append-only / queen bounds | **open** | issue #10 |
| SC-11 | Trusted activation authority (signed, revocable receipts) | **open** | issue #15 |
| SC-12 | Actualization: Reality Diff → Evidence Receipt | **open** | issue #18 |
| SC-13 | Visual overview shows kernel + hold state without inferring readiness | **met** | `observatory.test.ts` |
| SC-14 | Unknown health stays unknown | **met** | checked-in assessment |

## What “best” means here

Not the most agents. Not the most stars. Not a 50-repo merge.

Best means: **the contracts other swarm systems wish they had published** —
escalation, charter, Hands, team-profile provenance, absorption with
attribution, and an operator view that will not lie about admission.

## Done for this wave

- Kernel pin exists and is tested.
- Ruflo, oh-my-openagent, OpenAI Swarm, OpenFang, Hermes, Temporal, and Eve
  are absorbed or refused in the ledger — not silently copied.
- `/swarm` is the Kernel Observatory.
- Phase 1 activation is still **open**. That is success, not a gap to paper over.
