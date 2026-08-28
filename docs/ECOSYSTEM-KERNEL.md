# Ecosystem kernel — 2026-08-28

The June 2026 `agentic-ops-hub/ECOSYSTEM.md` map is still the layer story.
This file is the **current wiring**, after the team factory, Hands, and
charter landed.

## Policy

- **Monorepo: rejected.** Distinct public/private, licenses, and activation
  authority. Merge the *contracts*, not the checkouts.
- **Live funds: never.** There is no transfer tool.
- **Activation: report-only.** Plans, packs, and prepared bundles are artifacts.

## Kernel ring (must stay in sync)

| Layer | Repo | Posture | Next honest move |
|---|---|---|---|
| L0 | `Starlight-Intelligence-System` | stub | SIS Gateway client (issues #10 / SIS #49 #84) |
| L0 | `bless` | canonical | Keep charter dual-sourced |
| L2 | `starlight-agent-config` | pinned-git | Keep profiles out of this repo |
| L2 | `agentic-ops-hub` | cited | Refresh the June map |
| L5 | `payment-intelligence-system` | mcp-stdio | Pin the published MCP package |
| L6 | **`starlight-swarm`** | **canonical** | Stay the runtime |
| L7 | `starlight-evals` | satellite | One income/payments CI lane |
| L7 | `starlight-command-center` | projection | Read-only Observatory (#4) |

## Satellites (consume, do not merge)

`starlight-agent-skills` · `agentic-income-skills` · `hermes-cockpit` ·
`starlight-token-tracker` (swarm-bus home) · brand surfaces (FrankX, Arcanea, …)

## Deprecated

`frankxai/starlight-swarm-bus` — created by mistake. Do not import.

## Name collision

SIS `/starlight-swarm` is a multi-CLI *packet planner*. This repository is the
L6 Queen runtime. They are not the same product. Prefer `/starlight-dispatch`
for the SIS command when that rename is safe.

## How other repos should take this

```ts
import {
  classify,
  checkCharter,
  KERNEL_PIN,
  observatorySnapshot,
} from 'starlight-swarm/src/swarm/contracts';
```

Until a published package exists, pin this commit. Do not copy the ladder
into markdown and drift.
