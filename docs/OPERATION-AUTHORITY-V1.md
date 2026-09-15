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

`redeemStartAuthorization` presents a distinct 32-byte-format bearer credential and the exact lease, worker identity and binding. The caller can no longer name its broker identity. In the same transaction, the store attests the directly authenticated PostgreSQL session role, its non-superuser/no-membership posture and its exact read/column-update/audit grants, then resolves the broker identity from fresh server-owned evidence keyed by that role and database. The resolved pair must equal the broker identity precommitted in the lease. Under the same database lock and advancing database wall clock, the store repeats expiry, revocation, preparation, host, capability and receipt/window ledger checks. A single conditional transition moves the declared cost from reserved to conservative committed USD and the host slot from reserved to authorized, returning a non-bearer receipt with `execution_observed: false`. Exact retries require the same fresh principal and current authority; invalid retries become `stop-requested` without releasing committed resources. Disabling or changing a principal proactively applies the same quarantine to its issued authority.

`authority-role-contract.ts` is the machine-readable least-privilege contract. It requires a direct-login, `NOINHERIT`, non-superuser broker role with no memberships, effective `CONNECT`/`TEMPORARY` but no current-database `CREATE`, public-schema `USAGE` but no `CREATE`, SELECT only on redemption inputs, column UPDATE only on the five redemption state/ledger surfaces, INSERT only on append-only audit, audit-sequence use, and EXECUTE only on the security-definer control-lock function. Temporary-object creation is tolerated defensively, while redemption pins `search_path` to `pg_catalog,public,pg_temp` so a temp object cannot shadow an authority relation. The generated SQL states the database-grant prerequisite; attestation, rather than the generator, rejects authority inherited through `PUBLIC`. This change does not create a production role, grant a production permission, or configure a credential. The authority migration creates only the fixed-search-path lock function and revokes its default PUBLIC execution.

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
- The unsigned JSON lease and redemption receipts are persisted facts, not bearer or offline authority. Redemption requires both the secret and an attested PostgreSQL broker-service session whose server-owned evidence matches the lease.
- This authenticates the database-connected broker service, not an individual runner or per-request TLS channel. No production role, connection pool, certificate, workload identity or credential was created.
- There is no runner adapter, dispatch, execution observation, heartbeat, terminal evidence, recovery, kill-switch integration or external side effect. The strongest later database boundary is a function-only role; the current exact column-grant contract still assumes arbitrary SQL cannot escape the reviewed authority module.
- Consumption is an internal lifecycle claim, not the capability-broker or worker-dispatch layer tracked in other pull requests.
- Expiry reconciliation is lazy: it occurs on a consume or lease attempt. Explicit cancellation is available, but there is no sweeper for abandoned reservations.
- Consumption and release re-derive each aggregate ledger from all active holds under the authority lock. Each active reservation must have exactly one policy and one daily hold matching its signed policy and cost. Corrupt, unfunded or missing attribution fails closed; a failed terminal transition is rolled back and receives a separate durable integrity-refusal audit attempt.
- Initialization upgrades earlier PR #24 schemas. It cancels non-consumable reservation-only rows, rows without aggregate attribution, and old leases that lack redemption/control bindings; earlier authorized rows without a database principal become `stop-requested` with committed resources retained. Partial attribution or ledger drift blocks migration. Operational migration ownership, rollout and deployment remain unauthorized.
- Committed USD is a conservative authorization amount, not measured usage, an invoice, actual provider spend, revenue or proof of execution. A timeout, cancellation request or loss of contact does not release it or claim remote termination.
- The embedded suite establishes functional contract behavior. CI also provisions an ephemeral PostgreSQL 17 service for concurrent consumption, lease, cancellation and revocation races; only a linked successful CI run is evidence that the real-PostgreSQL lane passed for a particular commit. Neither is evidence of production readiness.

## Authorized integration sequence

1. A trusted preparation service constructs and validates the exact operation binding.
2. The control plane registers its digest and signed receipt ceiling, then registers explicit, non-overlapping `policy` and `daily` USD windows for the binding's budget policy.
3. Server-owned probes write strictly validated host evidence.
4. The Queen session host passes the same binding and signed receipts to `OperationAuthority.admit` immediately before a maker or checker call. It must treat both returned tokens as secrets and never log or persist their plaintext.
5. A trusted internal authority generates a distinct lease-claim secret and submits it with the consume token and exact bound identity to `OperationAuthority.consume`. It must retain the plaintext only in its protected request context; the authority stores and returns only its digest.
6. That authority may claim one bounded `leased-not-started` row by presenting the lease secret, exact consumption ID, a unique start-request ID and TTL while precommitting distinct redemption/control secrets and broker identity metadata. The returned receipt is explicitly not dispatched.
7. A human/infrastructure owner provisions the reviewed broker role and private pool outside this code change. The control plane registers fresh broker-principal evidence for that exact role/database pair.
8. Only that directly authenticated, attested broker-service session may redeem the start credential. It must treat the result as `start-authorized-not-observed`, not running evidence.
9. Do not connect this primitive to a runner before runner/channel authentication, heartbeat/terminal evidence, usage reconciliation, token-unit budgets, independent security review and the issue #15 adversarial evidence exist.

## Verification

Run the repository gates:

```sh
npm run typecheck
npm test
npm run swarm:dry-run
```

Focused adversarial coverage includes signature and token forgery, caller broker forgery, database-role posture and excess-grant rejection, fresh/disabled principal evidence, identity/binding drift, idempotent consumption, leasing and redemption, reserved-to-committed ledger movement, quarantine, migration, immutable aggregate windows, ledger corruption and tombstone retention. When `TEST_DATABASE_URL` is set, the suite also races independent PostgreSQL authorities for consumption, leasing, redemption, principal disablement, cancellation, revocation and shared budget windows.
