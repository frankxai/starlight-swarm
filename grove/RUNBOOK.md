# Grove pilot runbook

**Author:** Claude Opus 5.5 in Claude Code, for Frank · **Date:** 2026-10-21 · **Revision:** 1
**State:** files ready, nothing deployed, nothing bought. Every step marked **Frank** spends money,
creates a credential or changes an account, so an agent does not do it.

Total time once you start: about 45 minutes, most of it waiting for builds.

---

## Costs

Rates are from third-party summaries of Railway pricing and provider pages as of October 2026.
Check the checkout page before you buy, because both Railway and Hetzner changed prices in 2026.

| Item | Size | Estimate per month | Notes |
|---|---|---|---|
| Railway Hub service | about 0.25 vCPU, 0.5 GB RAM in use | $3 to $10 of usage | Billed per second at about $20 per vCPU-month and $10 per GB-month. Covered by the plan's included usage if you have headroom. |
| Railway volume | 5 GB | about $1 | Hub database, secrets, Tailscale state |
| Railway plan | Hobby $5 or Pro $20 | $0 extra if you already pay it | The CI runner pilot already lives on Railway |
| Broker VM | 4 vCPU, 8 GB, Ubuntu 24.04 | about €15 to €50 | Hetzner is cheapest in the EU; DigitalOcean and Vultr have Amsterdam regions at the top of the range |
| Tailscale | Personal plan | $0 | Check the device and user limits on your plan |
| **Infrastructure total** | | **about €20 to €60** | |
| Model tokens | per agent run | **open** | This is the real cost. Measure the first ten runs before you scale. |

Set a spend limit at each model provider before step 6. Scion limits how many agents run and
for how long (project Settings > Limits), but it has no dollar budget per agent.

---

## Step 1. Tailscale (Frank, 10 minutes)

1. In the Tailscale admin console, **DNS**: turn on MagicDNS and **HTTPS certificates**.
   Note your tailnet name, for example `tail1234.ts.net`. The Hub will live at
   `https://grove-hub.<tailnet>.ts.net`.
2. **Access controls**: merge [`tailscale/policy-snippet.hujson`](tailscale/policy-snippet.hujson)
   into your policy, put your Tailscale login in `group:grove-operators`, and save. It creates
   the `tag:grove-hub` and `tag:grove-broker` tags and allows SSH only as `grove`, re-checked
   every session. Policy rules add up: if your policy still has a rule that lets everyone reach
   everything, these grants restrict nothing, so check for one before you merge.
3. **Settings > Keys > Generate auth key** twice:
   - Hub key: one-off, pre-approved, tag `tag:grove-hub`, expires in 1 day.
   - Broker key: one-off, pre-approved, tag `tag:grove-broker`, expires in 1 day.
   Keep them in your password manager until steps 3 and 4. Each works once.

## Step 2. GitHub OAuth app (Frank, 5 minutes)

GitHub > Settings > Developer settings > OAuth Apps > **New OAuth App**:

| Field | Value |
|---|---|
| Application name | Starlight Grove |
| Homepage URL | `https://grove-hub.<tailnet>.ts.net` |
| Authorization callback URL | `https://grove-hub.<tailnet>.ts.net` |
| Enable Device Flow | **checked** (the broker signs in with it) |

Generate a client secret. You need the client ID and secret in step 3. GitHub accepts any
callback path under the registered URL, so the base URL is enough.

## Step 3. Hub on Railway (Frank approves spend; about 15 minutes)

The IaC file has three phases so it never refers to a variable that doesn't exist yet. From a
terminal on your laptop, in this repository (PowerShell shown; in bash use
`GROVE_IAC_PHASE=bootstrap railway config plan`):

```powershell
cd grove
npm install
railway login
railway link
$env:GROVE_IAC_PHASE = "bootstrap"; railway config plan
```

`railway link` asks for a project. Create one named `starlight-grove`, or pick your existing
Railway project; the file is a named partial, so it only ever touches `grove-hub` and its
volume. Read the plan. It should create one service and one volume and nothing else. Then:

```powershell
$env:GROVE_IAC_PHASE = "bootstrap"; railway config apply
```

The first deploy stops with a clear message about missing variables. That is expected.

**Volume backups.** Railway dashboard > grove-hub-data > Backups: turn on a daily schedule.
After step 7 passes, restore one backup into a scratch volume once to prove it works. A restore
needs all three together: the SQLite file, the Tailscale state folder, and the same
`SCION_SERVER_SESSION_SECRET`.

**Variables** (Railway dashboard > grove-hub > Variables > Raw Editor). Never commit these:

```text
GROVE_PUBLIC_URL=https://grove-hub.<tailnet>.ts.net
GROVE_ADMIN_EMAIL=<the email on your GitHub account>
TS_AUTHKEY=<Hub key from step 1>
SCION_SERVER_SESSION_SECRET=<output of: openssl rand -base64 48>
SCION_SERVER_OAUTH_WEB_GITHUB_CLIENTID=<from step 2>
SCION_SERVER_OAUTH_WEB_GITHUB_CLIENTSECRET=<from step 2>
SCION_SERVER_OAUTH_CLI_GITHUB_CLIENTID=<same client ID>
SCION_SERVER_OAUTH_CLI_GITHUB_CLIENTSECRET=<same client secret>
```

> **Back up `SCION_SERVER_SESSION_SECRET` in Infisical before the first deploy.** It encrypts
> every Hub secret. Losing it makes every stored agent key unreadable. Changing it does too.

**Do not generate a Railway domain** for this service. The Hub listens on loopback and is
served only on the tailnet.

Now declare those variables in IaC without exposing their values, and redeploy:

```powershell
$env:GROVE_IAC_PHASE = "enroll"; railway config plan
$env:GROVE_IAC_PHASE = "enroll"; railway config apply
```

The plan should show only variable declarations, no value changes. Watch the deploy logs for
the Tailscale login, `serve status`, and the Hub start. The container refuses to start if the
volume is not mounted at `/data`. When `grove-hub` shows as connected in the Tailscale console:

1. Delete `TS_AUTHKEY` from the Railway variables, then switch to the steady phase:
   `$env:GROVE_IAC_PHASE = "steady"; railway config plan` should show only that removal.
   The node identity is on the volume now, so later deploys need no key.
2. Open `https://grove-hub.<tailnet>.ts.net` on your laptop or phone (Tailscale on) and sign
   in with GitHub. You are the admin because of `GROVE_ADMIN_EMAIL`.

## Step 4. Broker VM (Frank buys; about 10 minutes)

1. Create a provider firewall that denies all inbound traffic and attach it to the VM at
   creation, so the machine is closed before its own firewall starts.
2. Create a VM: Ubuntu 24.04 LTS, x86_64, 4 vCPU / 8 GB or larger, an EU region near you.
   No SSH key is needed.
3. Open [`broker/cloud-init.yaml`](broker/cloud-init.yaml), replace `__TS_AUTHKEY__` with the
   **one-off** broker key from step 1, and paste the whole file into the provider's **user
   data** field. If this pull request is not merged yet, also change `GROVE_REF=main` to
   `GROVE_REF=agent/claude/grove-infra`.

   The provider keeps a copy of user data, and so does cloud-init. That is why the key must be
   one-off: Tailscale revokes it after first use, so those copies cannot enroll anything. Don't
   paste a reusable key here.
4. Wait about five minutes. `grove-broker-1` appears in the Tailscale console. Provisioning is
   one fail-fast script; if any step fails, nothing after it runs. If the node doesn't appear
   after ten minutes, open the provider's web console and run `cloud-init status --long`, then
   read `/var/log/cloud-init-output.log`.

## Step 5. Register the broker (Frank, 5 minutes with your phone)

```bash
tailscale ssh grove@grove-broker-1
grove-bootstrap https://grove-hub.<tailnet>.ts.net
```

The script prints a GitHub code and link. Approve it on your phone. It then mints a one-time
join token, registers the broker, starts the broker service and signs the VM out again. The
sign-out also runs if anything fails or you press Ctrl-C.

In the Hub dashboard, create a project for a throwaway repository, then link the broker under
**Project > Settings > Resources > Runtime Brokers**. Set limits under **Settings > Limits**:
two agents at once and 30 minutes per run are enough for the pilot.

## Step 6. Agent credentials (Frank)

Add these as **Hub secrets** (dashboard, or `scion hub secret set` from the broker after a
temporary `scion hub auth login --no-browser`). They are encrypted in the Hub database and
injected only into agent containers, never written to the VM's disk.

| Secret | Used by | Recommendation |
|---|---|---|
| `ANTHROPIC_API_KEY` | Claude Code maker | An API key with a monthly spend limit. Unattended agents should not run on your personal subscription login. |
| `OPENAI_API_KEY` | Codex checker | Same: a key with a spend limit. |
| `GITHUB_TOKEN` | git clone and push | Fine-grained token for the throwaway repo only, contents read and write, 30-day expiry. |

## Step 7. Smoke test (agent can run this once you are signed in)

On the broker:

```bash
grove-smoke
```

This checks the Hub, the broker service, rootless Podman (including a real container run),
git 2.48+, inotify limits and that host credentials are off.

For the agent run, the broker needs an operator credential for a few minutes, because it keeps
none of its own. In the dashboard, **Create Token** for the project with scopes
`agent:manage` and `project:read`, expiring in 2 hours. Then:

```bash
GROVE_RUN_AGENTS=1 grove-smoke <project-name>
```

Paste the token when asked; it is not echoed or saved. The run starts a Claude Code maker,
waits for it to finish, starts a Codex checker on the maker's branch, then stops and deletes
both. It passes only with evidence: both agents finished, they ran in distinct containers, the
maker's `SMOKE.md` holds the expected line, and the checker said PASS. Revoke the token after.

Each run writes `~/grove-smoke/<timestamp>/receipt.json`. The pilot passes when both runs exit 0.

---

## Connecting Claude Code, Codex and Hermes

| From | Today | Next |
|---|---|---|
| Browser on laptop or phone | Hub dashboard over Tailscale | Starlight living interface reads the same Hub API |
| Claude Code on Windows | `tailscale ssh grove@grove-broker-1`, then the `scion` CLI there | Grove MCP adapter: start, list, stop agents and read receipts from Claude Code, using a scoped Hub token |
| Codex | Runs inside Grove as the checker (`--type codex`) | Same adapter, from Codex on the laptop |
| Hermes | Scion ships a `hermes` harness, so Hermes can run as a Grove agent (`--type hermes`) with an API key | Hermes desktop as an operator through the same adapter |

The Scion CLI does not build for Windows, so the laptop talks to the Hub over its REST API,
not the CLI. That is the adapter's job, and it is the next pull request.

## Security model

- **No public surface.** The Hub binds to loopback inside its container and is served only on
  the tailnet. The VM firewall denies all inbound traffic except Tailscale.
- **No user login on the broker.** The broker holds only its own join credential. The
  bootstrap signs out after registering.
- **Host credentials off.** `use_host_credentials: false`. Agents get keys only from Hub secrets.
- **Pinned and verified.** Scion is pinned to `nightly-20261021` (commit `a44a186`) and checked
  against GitHub's published SHA-256 digest. Tailscale is pinned to 1.104.1.
- **Gates stay outside.** Scion lifecycle hooks only notify, so merges go through `pr-gate`
  and anything that publishes or spends goes through the approval relay. Agents get no merge
  rights.

### Known risks to decide on before real repositories

| Risk | Why it matters | Proposed fix |
|---|---|---|
| Agent images come from `ghcr.io/homebrew-scion` | A community registry, not Google. You would run its images with your keys inside. | Build the harness images from Scion's `image-build/` into our own GHCR before any real repository. |
| Scion is pre-1.0 | Nightlies change terms and flags | Bump the digest on purpose, run the smoke test, keep the previous digest for rollback |
| No dollar budget per agent | A runaway loop spends tokens | Provider spend limits plus Hub concurrency and duration limits |
| Podman 4.9 on Ubuntu 24.04 | Scion docs don't state a minimum Podman version | The smoke test proves it; if it fails, move the broker to a distro with Podman 5 and git 2.48+ |

## Teardown (stops all charges)

1. Railway: delete the `grove-hub` service and the `grove-hub-data` volume.
2. Provider: destroy the VM.
3. Tailscale: remove both nodes.
4. Revoke the GitHub OAuth app, the GitHub token and both model API keys.

## Things to verify on the first real run

- Hub secret writes with `secrets.backend: local`. Scion's published docs say the local backend
  rejects writes, but the source at both `v0.3.0-preview.2` and the October nightlies
  implements encrypted writes (`pkg/secret/localbackend.go`, AES-256-GCM keyed from the
  session secret). Step 6 proves which is true for this build. If writes fail, the fallback is
  GCP Secret Manager (`gcpsm`), which needs a GCP project.
- `tailscale serve` works inside the Railway container in userspace mode.
- Agent containers on the broker can reach the Hub's tailnet name. If they can't, set
  `server.broker.container_hub_endpoint`.
- The exact template names for `--type` on this Scion build (`scion start --help` is saved in
  every smoke receipt folder).
- Whether `railway config apply` deletes variables it doesn't declare. The three phases are
  written so the plan output tells you either way before anything is applied.
