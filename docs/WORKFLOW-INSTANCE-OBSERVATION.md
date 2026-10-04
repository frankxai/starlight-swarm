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

The control plane must register this final binding digest in its existing durable
prepared-operation registry and issue exact signed approval/budget receipts.
The existing broker role has read access to prepared operations; a worker cannot
promote this receipt into a prepared operation. This module does not change those
database roles, receipt schemas or authority routines.

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
