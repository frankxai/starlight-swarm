# System

## Purpose

Control plane, schemas, infrastructure, tooling, MCP, and agent governance.

This deterministic team contract is dry-run only. It grants no deployment, worker capability, approval or workflow start.

## Durable ownership

- Workflow `creator-engineering`: `cloudflare-workflows`, agent-centric, identity/state owned by cloudflare.

Each workflow has one durable engine. Railway workers, local Hermes and n8n connectors are replaceable executors. Cloudflare owns agent/cross-service workflows with identity/state there; Vercel owns app-local workflows. Queen coordinates without a second scheduler. SIS/Postgres owns canonical business state; workflow history and telemetry are separate records.

## Enforcement

Bind the exact profile, policy, plan, compiler and pack before any admission. Prompts cannot grant tools or satisfy approval. Reconcile already committed effects before retries or cancellation. Keep the independent verifier separate, budgets cumulative and stop authority outside worker control. Missing or stale evidence blocks activation.
