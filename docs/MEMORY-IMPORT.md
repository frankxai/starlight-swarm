# Memory import for swarm apps

Starlight mirrors Cursor’s **Import from Claude Code** surface so swarm apps can
ingest local agent memories — without making Claude Code or Cursor a second
canonical memory authority.

## Contract

```
scan (read-only) → candidate → human gate → promote (SIS / dry-run vault)
```

| Cursor bucket | Starlight mapping | Default |
|---|---|---|
| Plugins & skills | `.claude/skills/**/SKILL.md`, `.claude/plugins/**` | Selected, promotable when clean |
| (extra) Rules & contracts | `.cursor/rules`, `AGENTS.md`, `CLAUDE.md`, hooks | Selected when clean |
| (extra) Memory notes | `.cursor/memories` | Unselected |
| Chats | Chat / transcript paths | Visible when requested; **never promotable** |

Schema: `starlight.memory_import.v1` (`src/swarm/memory-import.ts`).

Fail-closed rules (charter + pack `MEMORY.md`):

1. No promote without explicit human approval.
2. Secret patterns → `needs-redaction`, not promotable.
3. Raw transcripts stay `refused`.
4. Promotion appends a compact provenance note to `SisVaultMcp` (dry-run by default). Live SIS is not wired here.

## Sync inventory

`assessSwarmSync()` checks that swarm tech is coherent before you claim “synced”:

- `AGENTS.md` carries all six benevolence clauses
- `charter.ts` exposes six frozen clauses
- Claude skills + worker skill IDs present
- Pack `MEMORY.md` policy on disk
- Live-funds hard stop documented
- Memory import scan finds ready candidates

## CLI

```bash
npm run swarm:sync                 # inventory only
npm run swarm:import               # inventory + scan
npm run swarm:import -- --json     # machine-readable
npm run swarm:import -- --promote --approve   # human-gated dry-run promote
```

## Cockpit / API

- UI: `/swarm` → **Import memories** dialog (Cursor-shaped buckets + Sync).
- `GET /api/memory-import` — scan + sync report.
- `POST /api/memory-import` with `{ "humanApproved": true }` — promote selected ready candidates.

## What “as good as Cursor” means here

Cursor syncs IDE context. Starlight syncs **governed swarm memory**: same discoverability
for skills/plugins, plus charter gates, redaction, provenance hashes, and SIS-bound
promotion so swarm apps do not silently inherit chat dumps or secrets.
