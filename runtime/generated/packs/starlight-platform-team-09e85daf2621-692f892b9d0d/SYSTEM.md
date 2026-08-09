# System

## Purpose

Control plane, schemas, infrastructure, tooling, MCP, and agent governance.

This pack is a deterministic operating contract for a bounded Starlight Agentic Team. It is not a daemon, approval, deployment, or permission grant.

## Authority map

- **Starlight Queen / Hermes** owns admission, schedule requests, team composition, policy, leases, and human gates.
- **Railway Temporal** owns durable mission history, retries, timers, checkpoints, and cancellation.
- **SIS / Postgres** owns canonical business state and promoted memory.
- **Langfuse + OpenTelemetry** owns model and tool telemetry projections.
- **Workers, Vercel Eve, n8n, models, MCP servers, and Composio** are replaceable executors or connectors. They do not own mission or approval authority.

## Operating constraints

- Event-driven readiness, never hot token-burning loops.
- One active lease and one idempotency key per side effect.
- Coordinator, maker, and independent verifier remain separate.
- No worker creates a competing scheduler or canonical memory store.
- Missing, stale, malformed, expired, mismatched, or unverified evidence blocks activation.
- Human-gated operations are never inferred from a role title, prompt, model confidence, or caller-authored receipt.

## Team

- Coordinator: `coordinator`
- Independent verifier: `qa-release-sre-verifier`
- Required roles: `coordinator`, `backend-data-engineer`, `qa-release-sre-verifier`
- Optional roles: `ai-evaluation-engineer`, `security-privacy-reviewer`, `frontend-experience-engineer`
