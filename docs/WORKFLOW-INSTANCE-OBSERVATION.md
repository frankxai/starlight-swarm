# Exact workflow operations and authenticated instance readback

This slice connects a verified v2 plan/pack to the existing operation-binding
format and implements actual Cloudflare HTTPS observation. It does not dispatch
or activate a worker. No live provider calls are part of the unit tests.

## Operation binding

`bindCloudflareWorkflowOperation(plan, profile, verification, binding, target)`
requires an in-process receipt issued by the actual pack verifier. It derives the
canonical prepared owner again and checks the profile, policy, plan, pack,
compiler, lane, workload, executor, maker/checker role, role capabilities and
budget policy. The requested amount must fit its lane and exact micro-USD
precision. This per-operation ceiling does not replace durable cumulative budget
reservations.

Server bootstrap supplies the exact account, workflow UUID/name, deployment
version and instance ID. These enter the existing signed operation's
`context_digest_sha256` alongside the original input-context digest. Tenant,
version or instance substitution therefore changes the binding signed by
`OperationAuthority`. The returned receipt is immutable request data with
`activation_authority_granted: false`. It cannot register itself, sign its own
approval, reserve a budget, receive a lease or authorize an effect.

## Durable registration and signed admission

`CloudflareWorkflowOperationAdmission` is a server bootstrap capability for one
externally selected operation. Strict configuration pins its full final binding
digest, operation ID, exact target and expiry. It requires the issued verified
binding, actual PostgreSQL store adapters and a private snapshot of the existing
issuer keyring. Workload requests can supply signed approval/budget receipts and a
bounded reservation duration. They cannot replace the binding or bootstrap keys.
The object, pools and keyring must stay in server bootstrap; no production route
or deployment bootstrap is installed by this library.

`register()` uses the bootstrap/admin database pool. Registration now transacts
under the existing authority serialization lock, uses database wall time, inserts
without replacing an existing identity, reads back exactly one matching ready row
under lock, appends its registration audit and commits before returning. A retry
preserves the original registration time and emits no duplicate registration
event. A conflicting binding, cancelled tombstone, invalid/future persisted time,
expired deadline or failed persistence cannot return a successful registration.
Registration failures carry no execution authority. The legacy
`putPreparedOperation(id, digest, callerTime)` call shape remains; caller time is
validated but database time owns new registration, and collisions now throw.

`admit()` does not register the operation or cache readiness. It delegates to the
existing `OperationAuthority` with the sealed binding. Its reservation expiry is
capped by bootstrap and signed-receipt expiry. PostgreSQL checks the prepared row
again, revocation, fresh host/access/capabilities, durable receipt budget, both
cumulative windows, capacity and duplicate operation/effect under its authority
lock. A cancellation between registration and admission therefore still denies.
Registration never signs its own approval, creates host evidence, registers a
budget, issues a runner lease or dispatches an effect.

## Durable instance ownership and recovery

Workflow registration also persists `starlight.workflow_instance_ownership.v1`
in the same transaction. It derives this data from the issued verified operation;
copied receipts and caller-authored ownership JSON cannot register. The stored
record contains the final binding digest, complete non-secret workflow context,
exact target and correlation-envelope digest. Strict recovery parsing checks the
context, target and envelope against their hashes. It returns immutable data with
execution authority explicitly false.

The database uniquely owns `(account_id, workflow_name, instance_id)`, the actual
Cloudflare API identity. Workflow UUID and version are part of the approved
binding, but changing them cannot reuse that API identity. An operation cannot
rebind to another instance. Cancellation retains the original ownership as a
permanent tombstone. No ownership deletion or reuse API is provided.

Prepared registration and ownership use the existing authority lock. A savepoint
after that lock rolls back candidate rows on a target conflict while retaining
the lock for the denial audit. The ownership row has a composite foreign key to
the exact prepared binding, generated target columns and a unique API identity.
Registration marks the prepared row as requiring ownership and checks that the
mark was persisted before committing. Existing generic prepared rows remain
compatible. An exact legacy parent can acquire ownership; `already_registered`
then describes the existing parent, rather than prior instance ownership.

`ownership()` reads the authenticated control-plane database after bootstrap
expiry or cancellation. It recovers the original target without refreshing
approval, registration or admission. If a commit response is lost, the caller
receives no registration receipt. A fresh store can read the committed identity
and retry the exact registration without duplicating ownership or its audit.
Database loss, invalid persisted data and a missing parent fail closed.

Before signed admission, the bootstrap reads back its exact ownership. The SQL
reservation transaction independently rechecks required ownership and compares
its recomputed context digest with the signed operation context. A self-consistent
record for another target cannot pass that comparison. The existing broker role
receives no new access to the ownership table. Real PostgreSQL tests exercise
competing owners, orphan prevention, cancelled tombstones, lost commit responses,
legacy upgrades, repeated migration, role permissions and reservation-time
identity corruption. Local transport-fault tests do not establish SQL behavior.

This is durable identity recovery. Durable create intent, authenticated dispatch,
uncertain provider-create reconciliation and executor effect deduplication remain
required. Ownership alone cannot prove that a provider instance was created or
prevent every duplicate external effect.

The existing broker role has SELECT access to prepared operations and cannot
insert, refresh or cancel them. Bootstrap registration requires the existing
privileged control-plane pool. Admission retains its existing database privilege
requirements; this slice adds no grants or deployed role configuration. The
existing migration extends the audit event constraint with prepared registration,
registration denial and workflow ownership events for both fresh and upgraded
databases; existing event names and rows remain
valid. A failed rollback preserves the original persistence error and attempts an
integrity audit; a disconnected database cannot promise audit persistence. Real
PostgreSQL CI checks registration races, broker insertion denial, exact signed
workflow admission, duplicate prevention and pre-start cancellation with release.
These test inputs are fixtures, not fresh live host or human approval evidence.

Next: trusted deployment bootstrap and exact-ID engine/executor dispatch,
authenticated runner session/start/stop/usage and
external-effect reconciliation. A Cloudflare instance is not an OS process.
Named pilot security acceptance, fresh live access/capacity and explicit human
approval remain required before a live create call. No live provider operation,
deployment, worker, spend or schedule is enabled here.

## Authenticated readback

Construct `CloudflareWorkflowObserver` only in server bootstrap. Its strict
configuration fixes the target, credential reference, access-review expiry and a
1–15 second total deadline. The account-scoped token belongs in
`STARLIGHT_CLOUDFLARE_OBSERVER_TOKEN`; the operator must verify its read permissions
and scope separately. Credentials are held in module-private state, never in
operation JSON or observation output. Reconstruct the observer after rotation.

The observer verifies the workflow UUID/name through the authenticated workflow
metadata endpoint, then reads the one exact instance with `simple=true`. Both
requests share one deadline. Every request resolves only the fixed Cloudflare API
hostname, rejects private/special IPv4 destinations, pins the selected address,
checks TLS authentication and the connected address, and disables connection
reuse. There are no supplied URL, proxy or transport callbacks. Responses must
be complete, uncompressed JSON, valid UTF-8 and at most 64 KiB each. Only one
observation may be in flight per observer.

The instance's actual `versionId` and exact correlation payload must match the
bound operation. Correlation carries binding/context digests and target identity;
resource paths, actor identifiers, prompt text and private workload inputs stay
at the authority. Provider timestamps are checked for order and future values.
The receipt records actual metadata/instance raw-response byte hashes and expires within 60 seconds
or sooner when its access review expires. Copies cannot pass the issuing
observer's in-process receipt check. That check establishes this observer's
readback evidence only; it grants no execution authority.

HTTP failures, 404, redirection, DNS failures, incomplete bodies and timeouts are
inconclusive. They neither prove absence nor trigger a create/retry. Recovery
must retain the same registered instance ID and reconcile it through readback.
An engine terminal state cannot attest executor descendants, completed external
effects, usage settlement or budget release. `rollingBack` remains non-terminal.
Deleted-script metadata remains visible as an observation and grants no health
or dispatch permission.

## Alternative and remaining work

Cloudflare's native Workers binding is the alternative for a control plane hosted
inside Cloudflare. The REST observer lets the existing external Queen inspect an
instance without hosting a second scheduler. Vercel app-local workflows still
need their own authenticated SDK adapter; this observer refuses their ownership.

Actual workflow creation, executor transport/session attestation, independently
observed process start and shutdown, usage evidence, live host capacity, access
review and the named human-approved reversible pilot remain required. A workflow
instance is not an OS process and its API status must not be relabelled as the
existing runner process/descendant evidence. Production activation stays disabled.

## Official API references checked 4 October 2026

- [Workflow metadata](https://developers.cloudflare.com/api/resources/workflows/methods/get/)
- [Instance status and params](https://developers.cloudflare.com/api/resources/workflows/subresources/instances/methods/get/)
- [Instance creation](https://developers.cloudflare.com/api/resources/workflows/subresources/instances/methods/create/)
- [Instance status changes](https://developers.cloudflare.com/api/resources/workflows/subresources/instances/subresources/status/methods/edit/)
- [Workers binding API](https://developers.cloudflare.com/workflows/build/workers-api/)

Creation accepts JSON-encoded `params` and an explicit `instance_id`; its returned
`version_id` differs in spelling from readback's `versionId`. The prepared
instance prefix is a correlation hint, not evidence of a provider-owned instance.
No restart, delete, scheduling or termination endpoint is implemented here.

Neither the documented REST create body nor Workers
`WorkflowInstanceCreateOptions` provides a version selector. Creation starts the
instance and returns its version afterwards. We therefore cannot use a response
version check to guarantee that only the approved version ran. Before executor
effects, a trusted workflow entrypoint and authenticated executor must enforce the
approved deployment identity. No undocumented `version_id` request field is used.

SQL references: [generated columns](https://www.postgresql.org/docs/17/ddl-generated-columns.html),
[constraints](https://www.postgresql.org/docs/17/ddl-constraints.html) and
[savepoint lock behavior](https://www.postgresql.org/docs/17/explicit-locking.html).
