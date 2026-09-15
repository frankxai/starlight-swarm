# Operation authority v1

Status: isolated authority primitive; **not wired to a runner or production activation**.

This slice closes one part of [runtime activation authority issue #15](https://github.com/frankxai/starlight-swarm/issues/15): a trusted service can convert two signed, operation-bound approvals into a durable reservation, consume it, and issue one short-lived `leased-not-started` claim. The lease receipt says `dispatch_state: not-dispatched` and `runner_activation_authorized: false`. No state in this slice authorizes a runner, starts a worker, calls a model, mutates a repository, or proves that a deployment exists.

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
- The unsigned JSON lease receipt is a persisted pre-start claim, not offline authority. No broker or runner may accept it directly; online authenticated redemption is mandatory and remains unimplemented.
- There is no runner/start transition, heartbeat, completion, recovery, kill-switch integration or external side effect.
- Consumption is an internal lifecycle claim, not the capability-broker or worker-dispatch layer tracked in other pull requests.
- Expiry reconciliation is lazy: it occurs on a consume or lease attempt. Explicit cancellation is available, but there is no sweeper for abandoned reservations.
- Consumption and release re-derive each aggregate ledger from all active holds under the authority lock. Each active reservation must have exactly one policy and one daily hold matching its signed policy and cost. Corrupt, unfunded or missing attribution fails closed; a failed terminal transition is rolled back and receives a separate durable integrity-refusal audit attempt.
- Initialization upgrades both earlier PR #24 schemas. It cancels non-consumable reservation-only rows and non-started lifecycle rows with no aggregate attribution, releases their existing holds, restores capacity and retains replay tombstones. Partial or fabricated attribution and a window ledger that does not exactly equal active holds block migration. Lease columns must be either wholly absent or complete; a consumed row cannot carry lease fields, and a leased row must carry both the complete tuple and its separately bound claim digest. Operational migration ownership, rollout and deployment remain unauthorized.
- At future authenticated runner redemption, the authority must recheck revocation, preparation, host and budget evidence, then atomically convert declared reserved cost into conservative committed cost. A running timeout, cancellation request or local loss of contact must not release committed spend or claim remote termination without authenticated stop/completion evidence.
- The embedded suite establishes functional contract behavior. CI also provisions an ephemeral PostgreSQL 17 service for concurrent consumption, lease, cancellation and revocation races; only a linked successful CI run is evidence that the real-PostgreSQL lane passed for a particular commit. Neither is evidence of production readiness.

## Authorized integration sequence

1. A trusted preparation service constructs and validates the exact operation binding.
2. The control plane registers its digest and signed receipt ceiling, then registers explicit, non-overlapping `policy` and `daily` USD windows for the binding's budget policy.
3. Server-owned probes write strictly validated host evidence.
4. The Queen session host passes the same binding and signed receipts to `OperationAuthority.admit` immediately before a maker or checker call. It must treat both returned tokens as secrets and never log or persist their plaintext.
5. A trusted internal authority generates a distinct lease-claim secret and submits it with the consume token and exact bound identity to `OperationAuthority.consume`. It must retain the plaintext only in its protected request context; the authority stores and returns only its digest.
6. That authority may claim one bounded `leased-not-started` row by presenting the lease secret, exact consumption ID, a unique start-request ID and TTL. The returned receipt is explicitly not dispatched and not runner authority.
7. Do not hand any reservation, consumption or lease receipt to a runner. Before any pilot, add authenticated online redemption that converts reserved cost to committed cost, bounded abandoned-reservation reconciliation, stop/heartbeat/completion evidence, usage/invoice reconciliation, token-unit budgets, independent security review and the issue #15 adversarial run evidence.

## Verification

Run the repository gates:

```sh
npm run typecheck
npm test
npm run swarm:dry-run
```

Focused adversarial coverage includes signature forgery, exact-call drift, capability escalation, key revocation, prepared-operation cancellation, missing server preparation, malformed host evidence, duplicate operation/effect denial, token forgery, identity mismatch, idempotent consumption and leasing, lease-credential separation, request/TTL drift, pre-start lease expiry, expiry/revocation release, exact-once cancellation, immutable/overlapping budget windows, cross-receipt aggregate exhaustion, tighter-daily enforcement, boundary crossing, partial, wrong-policy and unfunded holds, two schema upgrades, tombstone retention and denial audit evidence. When `TEST_DATABASE_URL` is set, the suite also races concurrent consumers, competing lease claims, lease versus preparation cancellation, revocation and independent authorities competing for the same policy/daily windows on real PostgreSQL.
