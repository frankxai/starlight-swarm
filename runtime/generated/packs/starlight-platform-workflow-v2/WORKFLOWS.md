# Workflows

## Bound lifecycle

1. Bind the exact profile, policy, workflow owner, plan and compiled pack.
2. Obtain fresh server-owned access, health, capacity, cumulative budget and signed approval evidence.
3. Reserve an operation and one durable lease before dispatch. The bound engine's instance ID records workflow history; executor identity is separate.
4. Execute one idempotent activity with bounded retries and independent cancellation.
5. Reconcile observed destination effects and uncertain acknowledgements before any redispatch.
6. Submit the exact artifact to the independent verifier, then record outcome, cost, repair effort and recovery evidence.

## Handoff rules

- "Select only the smallest 3-5 role team needed for the bounded job."
- "The worker that changes a release surface cannot be its independent verifier."
- "Stop and request named approval when any human-gated action is required."

Compilation and prepared bundles do not perform these live operations. No parallel scheduler or connector can acquire mission authority from a role prompt.
