# starlight-swarm

> Multi-agent orchestration on the Starlight memory substrate.

> **STATUS: INCUBATING** — this repo is an intent marker. There is no working code yet. The design below is the target, not a description of what exists today.

## What this will become

A coordination layer where frontier models work together as a swarm, rather than as isolated single-agent sessions:

- **Frontier-model swarm coordination** — the best available models cooperating on one objective, with role specialization and handoffs.
- **Open standards** — built on MCP and other portable contracts so the swarm is not locked to one vendor or one CLI.
- **Multi-CLI coding agents** — Claude Code, Codex, Gemini CLI, and peers participating in the same swarm.
- **Memory substrate** — shared state and recall provided by the Starlight Intelligence System (SIS) vaults, so swarm members reason against common memory.
- **Swarm training** — a "Starlight academy" loop to train and evaluate swarm behavior over time.
- **Starlight Queen** — an orchestrator-of-orchestrators that routes objectives across the swarm.

## Where it sits

| Layer | Repo | Role |
|-------|------|------|
| Substrate | [`Starlight-Intelligence-System`](https://github.com/frankxai/Starlight-Intelligence-System) | Memory vaults, SIP contracts, agent definitions |
| Implementation | [`agentic-creator-os`](https://github.com/frankxai/agentic-creator-os) | Claude Code productivity OS, Built on SIP |
| Evaluation | [`starlight-evals`](https://github.com/frankxai/starlight-evals) | The eval harness that would score swarm behavior |
| Orchestration | **starlight-swarm** | This repo — coordinates the swarm (target state) |

## What exists today

This README. Nothing else. See the Incubating tier in the SIS [`ECOSYSTEM_ARCHITECTURE.md`](https://github.com/frankxai/Starlight-Intelligence-System/blob/main/ECOSYSTEM_ARCHITECTURE.md) for how this repo fits the wider constellation.

## Activation criteria

This repo moves out of incubation when:

1. There is a first orchestration spike — one objective driven across ≥2 CLI agents.
2. A memory contract with SIS is defined (how swarm members read/write the vaults).
3. starlight-evals can score at least one swarm-behavior lane.

Until then, treat this as a placeholder for a planned system, not a usable tool.
