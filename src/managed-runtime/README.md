# Managed runtime — one port, three providers

Reference implementation for §4 of the proposal in `Starlight-Intelligence-System/docs/strategic/2026-10-08-agentic-estate-production-architecture.md`.

**Status:** v0 — dry-run only. Adapters are written against the documented SDK shapes and take an injected client; the suite runs with no network and no keys. Nothing here has run against a live provider yet. Nothing here moves money.

## What is here

| File | Role |
|---|---|
| `contract.ts` | The `ManagedAgentRuntime` port, zod schemas for agent specs, run requests, budget reservations, sealed receipts |
| `router.ts` | Workload class → provider and model class, with reversible-only fallback |
| `budget.ts` | Reserve before, settle after; over-cap escalates through the swarm's `classify()` |
| `receipts.ts` | Canonical-JSON sha256 receipts with the SIP attestation block |
| `experiments.ts` | Hypotheses with kill criteria; the only path up the `dry-run → shadow → pilot → standing` ladder |
| `revenue-streams.ts` | The ten-stream portfolio as typed data; at most three pilots; no figure without a source |
| `providers/anthropic.ts` | Anthropic Managed Agents: `agents.create` once, `sessions.create` with a hard budget, event stream, deny-when-unattended |
| `providers/openai.ts` | OpenAI Agents SDK: in-memory `Agent`, `run()` with `maxTurns`, usage from run state |
| `providers/gemini.ts` | Gemini managed agents: Interactions API with the Antigravity agent, function-call round trips |
| `providers/dry-run.ts` | The in-process fake |
| `index.ts` | The dry-run that ties it together |

## Run

```bash
npm run runtime:managed:test      # typecheck + unit tests, no network
npm run runtime:managed:dry-run   # route, reserve, run on the fake, settle, print receipts
```

## Rules the code enforces

- Agent first, then session. `provision` is a setup step; `run` references the stored id.
- Every run carries an integer micro-USD reservation. Over cap → `founder-board`, never auto-approve.
- Irreversible work never degrades to a fallback provider. It waits.
- Unattended tool confirmations are denied.
- Web search and fetch are off unless the spec asks.
- A receipt's `completed` is true only when the provider said so.
- `costMicroUsd: 0` means "not reported", never "free". Only Anthropic sessions report list cost on the object.
- At most three streams in pilot. A stream with a number and no source fails validation.

## What is not here yet

- Live provider runs and the receipts they produce. The first shadow run is day 8–30 of the plan.
- Durable execution binding (Cloudflare Workflows / Vercel Workflows). The port is designed to be called from a workflow step; the binding lives with the existing `runtime:prepare` bundles.
- Signed receipts. The attestation block is a declared label until the SIP graph extension signs it.

Built on SIP.
