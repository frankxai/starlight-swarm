# Quality

## Acceptance doctrine

Quality means a useful artifact plus reproduced evidence, not fluent prose or agent consensus. The independent verifier cannot be the maker and cannot accept self-certified receipts.

## Required evidence

- Exact source and artifact identities or hashes.
- Commands actually executed with exit status.
- Contract/schema validation where applicable.
- Adversarial probes for approvals, budgets, duplicate IDs, path traversal, stale evidence, and malformed input.
- Browser/device evidence for user-facing work.
- Security and secret scan for executable or deployable work.
- Actual model, provider ingress, tokens, cost, latency, retries, and policy denials.

## Eval suites

- "repo-contract-integrity"
- "release-evidence-integrity"

## Promotion bar

A specialist runtime or framework is promoted only after at least seven bounded paired runs with zero safety violations and a material win in accepted quality, elapsed time, cost, or operator effort against the plain durable-worker baseline.

## Verdict vocabulary

- **PASS** — all required gates reproduced on the exact current artifact.
- **REVISE** — bounded defects with a clear regression test and owner.
- **HOLD** — missing authority, capacity, evidence, or external dependency.
- **REJECT** — unsafe, deceptive, duplicative, or economically unjustified.
