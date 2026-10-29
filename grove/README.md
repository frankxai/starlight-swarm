# Starlight Grove

Grove is where Starlight agents run when they leave the laptop. It uses Google Scion's
runtime shape (one Hub, many runtime brokers, one container, worktree and credential set per
agent) and keeps Starlight's own rules on top: named roles, receipts, a checker from a
different provider, and human gates for merge, publish and spend.

**Author:** Claude Opus 5.5 in Claude Code, for Frank · **Date:** 2026-10-21 · **Status:** pilot
setup, not deployed · **Decisions:** ADR-007 (Grove on the Scion shape, accepted 2026-10-20) and
ADR-011 below.

## Pilot topology (option B, ruled by Frank on 2026-10-21)

```text
 Frank's laptop / phone ──┐
   (browser, Claude Code, │  Tailscale (private network, HTTPS)
    Hermes, Codex)        │
                          ▼
 ┌──────────────────────────────────┐        ┌───────────────────────────────────────┐
 │ Railway · service grove-hub      │◀──────▶│ Linux VM · grove-broker-1              │
 │  Scion Hub + dashboard           │  WSS   │  Scion runtime broker (systemd, user)  │
 │  SQLite + secrets on /data volume│ tailnet│  rootless Podman                       │
 │  no public domain, loopback only │        │   ├─ agent: maker   (Claude Code)      │
 │  Tailscale userspace + serve     │        │   └─ agent: checker (Codex)            │
 └──────────────────────────────────┘        │  each: own container, worktree, creds  │
                                             └───────────────────────────────────────┘
                                                       │ git push to agent branches
                                                       ▼
                                                 GitHub (draft PRs, pr-gate)
```

- **Hub on Railway** keeps the control plane managed and off the laptop, which is RAM-bound.
  Railway cannot run containers inside containers, so agents cannot live there.
- **Broker on a Linux VM** runs the agent containers. Scion has no Windows build, and neither
  Windows machine has WSL2, so the broker needs Linux.
- **Tailscale** joins them. The Hub has no public URL at all, and the VM accepts no inbound
  traffic except over the tailnet.

## Files

| Path | What it is |
|---|---|
| [`RUNBOOK.md`](RUNBOOK.md) | Step-by-step setup, costs, security and teardown. Start here. |
| [`hub/Dockerfile`](hub/Dockerfile) | Hub image: pinned Scion release (digest-checked) plus Tailscale |
| [`hub/entrypoint.sh`](hub/entrypoint.sh) | Joins the tailnet, serves HTTPS on the tailnet, starts the Hub on loopback |
| [`.railway/railway.ts`](.railway/railway.ts) | Railway IaC for the Hub service and its volume (named partial `grove-hub`) |
| [`broker/cloud-init.yaml`](broker/cloud-init.yaml) | Ubuntu 24.04 VM setup: Podman, git 2.48+, Tailscale, firewall, Scion |
| [`broker/bootstrap-broker.sh`](broker/bootstrap-broker.sh) | One-time broker registration with GitHub device flow |
| [`broker/scion-broker.service`](broker/scion-broker.service) | systemd user unit for the broker |
| [`smoke/smoke-test.sh`](smoke/smoke-test.sh) | Infra checks plus an optional maker and checker run, with a JSON receipt |
| [`tailscale/policy-snippet.hujson`](tailscale/policy-snippet.hujson) | Tags, grants and SSH rules for the tailnet policy |

## ADR-011: Grove pilot topology

**Status:** accepted by Frank, 2026-10-21 ("Go with option B").

**Context.** The Scion spike (2026-10-20) found that Scion cannot run on Frank's Windows
machines and that Railway cannot host per-agent containers. Frank asked for the Hub on
Railway and agents on a small Linux VM over Tailscale.

**Decision.** Run the Scion Hub on Railway, reachable only through Tailscale. Run one runtime
broker on a Linux VM. Agent credentials live as Hub secrets, encrypted with the Hub's session
secret. Pin Scion by release digest. Keep merges, publishing and spend outside Scion.

**Consequences.** Two small monthly bills instead of one, and two places to patch. In return
the laptop stops being the ceiling and the Hub survives VM rebuilds. Scion is pre-1.0, so a
pinned nightly can break on upgrade; upgrades are a deliberate digest bump with a smoke test.
