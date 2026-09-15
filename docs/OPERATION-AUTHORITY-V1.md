# Operation authority v1

Status: isolated authority primitive; **not wired to a runner or production activation**.

This slice closes one part of [runtime activation authority issue #15](https://github.com/frankxai/starlight-swarm/issues/15): a trusted service can convert two signed, operation-bound approvals into a durable, single-issuance reservation and atomically claim that reservation as `consumed-not-started`. Neither state authorizes a runner, starts a worker, calls a model, mutates a repository, or proves that a deployment exists.

## Trust boundary

`OperationAuthority` verifies the signed approval and budget receipts. `PostgresOperationAuthorityStore` is the concurrency and freshness boundary. In one transaction it verifies:

- the operation, exact target and parameter digest, external effect, maker/checker call and runtime lineage are bound by one SHA-256 digest;
- the operation digest was registered by the server-owned preparation path;
- neither receipt, issuer, key, operation nor effect was revoked;
- server-owned host evidence is fresh, ready, access-reviewed, secret-ready and has capacity;
- the host and approval permit every requested capability;
- the signed per-receipt budget matches the immutable durable registry entry and has remaining capacity;
- neither the operation ID nor external effect ID has received a previous reservation.

The reservation transaction reserves cost and a host slot, inserts the reservation, and appends an audit event. It returns separate high-entropy consume and cancel tokens once; only their SHA-256 digests are persisted, and the plaintext tokens are excluded from audit records. A denial is also appended. Prepared-operation cancellation is durable and audited. Admission, consumption, revocation and cancellation take the same database control lock and use database wall time for terminal decisions.

Consumption presents its token and the exact operation, effect, binding and execution identity. Under the same lock, the store rechecks expiry, revocation, prepared-operation state and trusted-host evidence. One conditional transition creates a durable, retry-stable `consumed-not-started` receipt. Revocation immediately cancels every matching non-started reservation under that lock; expiry or a consume-time prepared-operation cancellation also creates a terminal tombstone. Each path releases the reservation's budget and host slot exactly once. Explicit cancellation requires its separate token, is idempotent for either non-started state and performs the same exact resource release.

HMAC secrets are server-side material. Callers receive signed receipts, never signing keys. Issuers and key IDs are explicitly allowlisted; rotation is enforced by revoking `key:<issuer>:<key_id>` before removing the key from the configured keyring.

## Queen session binding

The operation binding includes the full subordinate call identity expected by the bounded maker/checker Queen session:

- mission ID, call ID, role, actor ID, execution identity and identity-evidence reference;
- context digest, prompt SHA-256 and timeout;
- profile repository, commit, path and digest;
- policy, plan and pack digests plus compiler version;
- lane, workload, runtime and host IDs;
- requested operation, exact resource identifier, effect-parameters digest, capabilities, budget policy, cost and unique operation/effect IDs.

The integration contract was rechecked against current `frankxai/Starlight-Intelligence-System` head `5ea67efd685a38617a47a80408fa77cb3e5983a8`; the bounded one-maker/one-checker Queen session was introduced at `dfbb339727943c4fc3833c5ca90e471bb155ec17` and is unchanged by the intervening memory-only commits. Package version `8.3.0` alone is not evidence for either commit.

## Deliberate limits

- `src/swarm/runtime-adapters.ts` retains `activation_authority: trusted-server-internal-authority-not-implemented`.
- No runner, queue, scheduler, retry loop, external mutation, credential path or deployment wiring is added.
- The budget is an immutable ceiling per signed budget receipt. Aggregate policy-window, daily and cross-receipt accounting remain open work.
- A reservation or consumption receipt is not a lease, runner grant, start grant or usage record. There is no runner/start transition, heartbeat, completion, recovery, kill-switch integration or external side effect.
- Consumption is an internal lifecycle claim, not the capability-broker or worker-dispatch layer tracked in other pull requests.
- Expiry reconciliation is lazy: it occurs on a consume attempt. Explicit cancellation is available, but there is no sweeper for abandoned reservations.
- Resource release reconciles the exact per-receipt cost and host slot. Aggregate policy-window, daily and cross-receipt accounting remain open work.
- Initialization upgrades the earlier PR #24 reservation-only schema by cancelling its non-consumable legacy holds, releasing their per-receipt budget, restoring host capacity and retaining replay tombstones. Operational migration ownership, rollout and deployment remain unauthorized.
- The embedded suite establishes functional contract behavior. CI also provisions an ephemeral PostgreSQL 17 service for concurrent consume/cancel/revoke races; only a linked successful CI run is evidence that the real-PostgreSQL lane passed for a particular commit. Neither is evidence of production readiness.

## Authorized integration sequence

1. A trusted preparation service constructs and validates the exact operation binding.
2. The control plane registers its digest with `putPreparedOperation` and registers the signed budget receipt ceiling once.
3. Server-owned probes write strictly validated host evidence.
4. The Queen session host passes the same binding and signed receipts to `OperationAuthority.admit` immediately before a maker or checker call. It must treat both returned tokens as secrets and never log or persist their plaintext.
5. A trusted internal authority may present that token and the exact bound identity to `OperationAuthority.consume`. This only claims the reservation and returns a durable non-started receipt.
6. Do not hand the reservation or consumption receipt to a runner. No worker-start authority exists in this slice.
7. Before any pilot, add aggregate budget accounting, bounded abandoned-reservation reconciliation, a separate atomic start/lease contract, independent security review and the issue #15 adversarial run evidence.

## Verification

Run the repository gates:

```sh
npm run typecheck
npm test
npm run swarm:dry-run
```

Focused adversarial coverage includes signature forgery, exact-call drift, capability escalation, key revocation, prepared-operation cancellation, missing server preparation, malformed host evidence, duplicate operation/effect denial, token forgery, identity mismatch, idempotent consumption, expiry/revocation release, exact-once cancellation, tombstone retention and denial audit evidence. When `TEST_DATABASE_URL` is set, the suite also races concurrent consumers, cancellation and revocation on real PostgreSQL.
