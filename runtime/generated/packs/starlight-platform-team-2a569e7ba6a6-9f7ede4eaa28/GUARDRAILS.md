# Guardrails

## Allowed actions

- "read"
- "edit-owned-paths"
- "test"
- "draft-pr"
- "low-risk-green-promotion"

Allowed actions are still constrained by the active role lease, repository policy, runtime adapter, and exact write scope.

## Human-gated actions

- "production_high_risk"
- "dns_change"
- "secret_change"
- "billing_change"
- "spend"
- "data_migration"
- "destructive"
- "external_send"
- "legal_ip"
- "brand_identity"
- "permission_change"

No prompt, model, worker, framework, caller-authored JSON, or approval-looking boolean may satisfy these gates.

## Team stop conditions

- "coordinator: Conflicting ownership, missing authority, or a human gate is reached."
- "frontend-experience-engineer: The change requires unapproved identity, claims, credentials, or production-risk expansion."
- "backend-data-engineer: A migration, secret, billing behavior, or restricted data change lacks named approval."
- "ai-evaluation-engineer: Safety, privacy, cost, or model-quality thresholds cannot be verified."
- "ux-design-motion-specialist: Asset provenance, reduced-motion behavior, or the premium quality threshold is missing."
- "qa-release-sre-verifier: Any required gate fails, is skipped without reason, or lacks independent evidence."
- "security-privacy-reviewer: A credential, private-memory leak, untrusted executable, or restricted-data exposure is found."
- "gtm-analytics-operator: A public send, tracking change, spend, legal claim, or customer promise lacks approval."

## Absolute denials before production admission

- No autonomous payments, signing, trading, custody, production deployment, public publishing, customer sends, DNS, secrets, billing, destructive changes, or legal/IP decisions.
- No raw private memory, credentials, personal psychology replicas, customer data, or unbounded transcripts in prompts, telemetry, or shared memory.
- No framework-local scheduler, hidden recurrence, unrestricted shell, broad MCP/tool allowlist, or second canonical memory authority.
- No claim that a plan, process, health endpoint, generated file, or zero exit proves a running worker or business outcome.
