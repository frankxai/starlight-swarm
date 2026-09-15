# Operation authority v1

Status: isolated authority primitive; **not wired to a runner or production activation**.

This slice closes one part of [runtime activation authority issue #15](https://github.com/frankxai/starlight-swarm/issues/15): a trusted service can convert two signed, operation-bound approvals into a durable reservation, consume it, issue one short-lived `leased-not-started` claim, and redeem its separately bound credential into `start-authorized-not-observed`. The lease remains explicitly undispatched. Redemption proves only that database authority was issued; `execution_observed: false` means it does not claim that a worker started, ran, called a model, changed a repository, or produced customer or spend evidence.

## Trust boundary

`OperationAuthority` verifies the signed approval and budget receipts. `PostgresOperationAuthorityStore` is the concurrency and freshness boundary. In one transaction it verifies:

- the operation, exact target and parameter digest, external effect, maker/checker call and runtime lineage are bound by one SHA-256 digest;
- the operation digest was registered by the server-owned preparation path;
- neither receipt, issuer, key, operation nor effect was revoked;
- server-owned host evidence is fresh, ready, access-reviewed, secret-ready and has capacity;
- the host and approval permit every requested capability;
- the signed per-receipt budget matches the immutable durable registry entry and has remaining capacity;
- exactly one trusted, immutable `policy` window and one `daily` USD window cover database wall time and the full reservation lifetime;
- the requested cost fits both aggregate windows, even when other receipt IDs share the same budget policy;
- neither the operation ID nor external effect ID has received a previous reservation.

The reservation transaction reserves cost and a host slot, inserts the reservation, and appends an audit event. It returns separate high-entropy consume and cancel tokens once; only their SHA-256 digests are persisted, and the plaintext tokens are excluded from audit records. A denial is also appended. Prepared-operation cancellation is durable and audited. Admission, consumption, revocation and cancellation take the same database control lock and use database wall time for terminal decisions.

Budget-window registration uses the same authority lock. Each window has an opaque ID, budget policy, `policy` or `daily` kind, explicit UTC bounds, USD ceiling and reserved amount. Exact registration replay returns an idempotent typed success; changed or overlapping same-kind windows return a typed refusal and commit a denial audit event. Admission records one hold against each selected window. Bounds are supplied by the trusted policy layer rather than deriving a local calendar day in PostgreSQL, so 23- and 25-hour daylight-saving days remain representable.

Consumption presents its token and the exact operation, effect, binding and execution identity. It also precommits a separate, caller-generated lease-claim secret. Only that secret's SHA-256 digest is persisted and audited; the consume credential cannot be promoted into a start credential. Under the same lock, the store rechecks expiry, revocation, prepared-operation state, trusted-host evidence, the signed requested cost and the two durable aggregate holds. Cost and ledger equality remain PostgreSQL `NUMERIC` decisions rather than JavaScript floating-point comparisons. One conditional transition creates a durable, retry-stable `consumed-not-started` receipt. Existing consumed rows that lack a separately bound lease digest remain start-ineligible.

`leaseStart` presents the precommitted lease-claim secret, exact consumption and binding identity, a unique start-request ID and a bounded TTL. The store repeats the freshness, revocation, preparation, host, capability and aggregate-hold checks under the authority lock. One conditional transition issues a retry-stable `leased-not-started` receipt while the lease and current authority evidence remain valid. A different request ID, credential, identity, consumption, duration or binding fails closed. Expiry, revocation, prepared-operation cancellation and explicit cancellation terminalize an unredeemed lease and release its per-receipt budget, both aggregate holds and host slot exactly once. This is safe only because the lease remains unredeemed and no runner accepts it.

`redeemStartAuthorization` presents a distinct 32-byte-format bearer credential and the exact lease, worker identity, broker identity metadata and binding. Cryptographic entropy is a trusted-caller obligation; format and length alone do not prove it. Under the same database lock and advancing database wall clock, the store repeats expiry, revocation, preparation, host, capability and receipt/window ledger checks. A single conditional transition moves the declared cost from reserved to conservative committed USD and the host slot from reserved to authorized, returning a non-bearer receipt with `execution_observed: false`. Exact retries return the same positive receipt only while the lease, revocation, preparation, host and ledger evidence all remain current; otherwise the row becomes `stop-requested`, the retry is denied, and committed cost plus authorized capacity remain quarantined. Any competing request or tuple drift fails closed. Cancellation, revocation or preparation cancellation after redemption follows the same quarantine rule until a future authenticated terminal/non-start evidence contract can settle it.

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
- Budget enforcement reserves declared USD cost; it does not measure tokens, provider usage, invoices, refunds, actual spend or foreign exchange. Those require a separate authenticated usage/reconciliation contract.
- The unsigned JSON lease and redemption receipts are persisted facts, not bearer or offline authority. The redemption token is the only authentication currently implemented. Broker identity fields remain caller-bound metadata until validated against an authenticated transport principal and fresh server-owned broker evidence.
- There is no runner adapter, dispatch, execution observation, heartbeat, terminal evidence, recovery, kill-switch integration or external side effect. Shared database-writer privilege must be replaced by a restricted authority role before deployment.
- Consumption is an internal lifecycle claim, not the capability-broker or worker-dispatch layer tracked in other pull requests.
- Expiry reconciliation is lazy: it occurs on a consume or lease attempt. Explicit cancellation is available, but there is no sweeper for abandoned reservations.
- Consumption and release re-derive each aggregate ledger from all active holds under the authority lock. Each active reservation must have exactly one policy and one daily hold matching its signed policy and cost. Corrupt, unfunded or missing attribution fails closed; a failed terminal transition is rolled back and receives a separate durable integrity-refusal audit attempt.
- Initialization upgrades earlier PR #24 schemas. It cancels non-consumable reservation-only rows, rows without aggregate attribution, and old leases that lack redemption/control bindings; it releases their existing reserved holds and retains replay tombstones. Partial attribution or ledger drift blocks migration. Operational migration ownership, rollout and deployment remain unauthorized.
- Committed USD is a conservative authorization amount, not measured usage, an invoice, actual provider spend, revenue or proof of execution. A timeout, cancellation request or loss of contact does not release it or claim remote termination.
- The embedded suite establishes functional contract behavior. CI also provisions an ephemeral PostgreSQL 17 service for concurrent consumption, lease, cancellation and revocation races; only a linked successful CI run is evidence that the real-PostgreSQL lane passed for a particular commit. Neither is evidence of production readiness.

## Authorized integration sequence

1. A trusted preparation service constructs and validates the exact operation binding.
2. The control plane registers its digest and signed receipt ceiling, then registers explicit, non-overlapping `policy` and `daily` USD windows for the binding's budget policy.
3. Server-owned probes write strictly validated host evidence.
4. The Queen session host passes the same binding and signed receipts to `OperationAuthority.admit` immediately before a maker or checker call. It must treat both returned tokens as secrets and never log or persist their plaintext.
5. A trusted internal authority generates a distinct lease-claim secret and submits it with the consume token and exact bound identity to `OperationAuthority.consume`. It must retain the plaintext only in its protected request context; the authority stores and returns only its digest.
6. That authority may claim one bounded `leased-not-started` row by presenting the lease secret, exact consumption ID, a unique start-request ID and TTL while precommitting distinct redemption/control secrets and broker identity metadata. The returned receipt is explicitly not dispatched.
7. The trusted online boundary may redeem the start credential once. It must treat the result as `start-authorized-not-observed`, not running evidence.
8. Do not connect this primitive to a runner before transport-authenticated broker identity, restricted database authority, heartbeat/terminal evidence, usage reconciliation, token-unit budgets, independent security review and the issue #15 adversarial evidence exist.

## Verification

Run the repository gates:

```sh
npm run typecheck
npm test
npm run swarm:dry-run
```

Focused adversarial coverage includes signature and token forgery, identity/binding drift, idempotent consumption, leasing and redemption, competing request IDs, reserved-to-committed ledger movement, post-authorization stop quarantine, migration of old leases, immutable aggregate windows, ledger corruption and tombstone retention. When `TEST_DATABASE_URL` is set, the suite also races independent PostgreSQL authorities for consumption, leasing, redemption, cancellation, revocation and shared budget windows.
