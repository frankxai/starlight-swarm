# Operation authority v1

Status: isolated authority primitive; **not wired to a runner or production activation**.

This slice closes one part of [runtime activation authority issue #15](https://github.com/frankxai/starlight-swarm/issues/15): a trusted service can convert two signed, operation-bound approvals into a durable, single-issuance reservation. The only successful state is `reserved-not-started`. Receiving a reservation does not authorize a runner, start a worker, call a model, mutate a repository, or prove that a deployment exists. There is deliberately no consume API.

## Trust boundary

`OperationAuthority` verifies the signed approval and budget receipts. `PostgresOperationAuthorityStore` is the concurrency and freshness boundary. In one transaction it verifies:

- the operation, exact target and parameter digest, external effect, maker/checker call and runtime lineage are bound by one SHA-256 digest;
- the operation digest was registered by the server-owned preparation path;
- neither receipt, issuer, key, operation nor effect was revoked;
- server-owned host evidence is fresh, ready, access-reviewed, secret-ready and has capacity;
- the host and approval permit every requested capability;
- the signed per-receipt budget matches the immutable durable registry entry and has remaining capacity;
- neither the operation ID nor external effect ID has received a previous reservation.

The transaction reserves cost and a host slot, inserts the reservation, and appends an audit event. A denial is also appended. Prepared-operation cancellation is durable and audited. Admission and revocation/cancellation take the same database control lock, then admission rechecks revocations and receipt expiry against database transaction time.

HMAC secrets are server-side material. Callers receive signed receipts, never signing keys. Issuers and key IDs are explicitly allowlisted; rotation is enforced by revoking `key:<issuer>:<key_id>` before removing the key from the configured keyring.

## Queen session binding

The operation binding includes the full subordinate call identity expected by the bounded maker/checker Queen session:

- mission ID, call ID, role, actor ID, execution identity and identity-evidence reference;
- context digest, prompt SHA-256 and timeout;
- profile repository, commit, path and digest;
- policy, plan and pack digests plus compiler version;
- lane, workload, runtime and host IDs;
- requested operation, exact resource identifier, effect-parameters digest, capabilities, budget policy, cost and unique operation/effect IDs.

The integration contract was checked against `frankxai/Starlight-Intelligence-System` commit `dfbb339727943c4fc3833c5ca90e471bb155ec17`, which contains the bounded one-maker/one-checker Queen session. Package version `8.3.0` alone is not evidence for that commit.

## Deliberate limits

- `src/swarm/runtime-adapters.ts` retains `activation_authority: trusted-server-internal-authority-not-implemented`.
- No runner, queue, scheduler, retry loop, external mutation, credential path or deployment wiring is added.
- The budget is an immutable ceiling per signed budget receipt. Aggregate policy-window, daily and cross-receipt accounting remain open work.
- A reservation is not a lease, runner grant or usage record. Atomic consume, expiry/revocation checks at consume time, completion, cancellation after reservation, refund/reconciliation, recovery and kill-switch enforcement remain open work.
- The database migration is additive but operational rollout and migration ownership are not authorized here.
- A passing test establishes contract behavior in an embedded PostgreSQL-compatible test database; it is not evidence of production readiness.
- The embedded test pool serializes connections. The shared control-row lock is reviewable and exercised functionally, but a real PostgreSQL concurrency harness is still required before claiming race-test evidence.

## Authorized integration sequence

1. A trusted preparation service constructs and validates the exact operation binding.
2. The control plane registers its digest with `putPreparedOperation` and registers the signed budget receipt ceiling once.
3. Server-owned probes write strictly validated host evidence.
4. The Queen session host passes the same binding and signed receipts to `OperationAuthority.admit` immediately before a maker or checker call.
5. Do not hand the reservation to a runner. No consume contract or runner exists in this slice.
6. Before any pilot, add aggregate budget accounting, post-reservation cancellation/reconciliation, an opaque atomic consume API with fresh expiry/revocation checks, independent security review and the issue #15 adversarial run evidence.

## Verification

Run the repository gates:

```sh
npm run typecheck
npm test
npm run swarm:dry-run
```

Focused adversarial coverage includes signature forgery, exact-call drift, capability escalation, key revocation, prepared-operation cancellation, missing server preparation, malformed host evidence, duplicate operation/effect denial, atomic budget reservation and denial audit evidence.
