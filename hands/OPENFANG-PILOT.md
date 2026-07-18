# OpenFang Sidecar Pilot

Status: **compiled and blocked by default**. No model-backed OpenFang run, daemon, recurrence, credential import, or SIS write is authorized by this document.

## Decision

Absorb the Hand packaging pattern and evaluate OpenFang only as a subordinate, reactive sidecar. Do not make OpenFang another Queen, scheduler, gateway, canonical-memory authority, or unrestricted coding runtime.

## Evidence from OpenFang v0.6.9

The pilot compiler accounts for two upstream behaviors:

1. A Hand with `agent.max_iterations` is converted to an hourly `ScheduleMode::Continuous` agent. See [`kernel.rs` lines 3824–3841](https://github.com/RightNow-AI/openfang/blob/v0.6.9/crates/openfang-kernel/src/kernel.rs#L3824-L3841).
2. Hand-owned agents are treated as curated packages and tool requests are auto-approved. See [`kernel.rs` lines 7582–7591](https://github.com/RightNow-AI/openfang/blob/v0.6.9/crates/openfang-kernel/src/kernel.rs#L7582-L7591).

Consequences:

- The compiled pilot omits `max_iterations`, keeping the Hand reactive.
- Safety comes from a strict tool allowlist plus external admission—not OpenFang approval prompts.
- Empty OpenFang skill/MCP allowlists are not used because upstream documents empty as all. Sentinel allowlist entries prevent accidental broad discovery.
- The bundled Collector is not activated because it declares shell, file-write, scheduling, event-publish, and graph-write capabilities beyond this pilot.

## Supply-chain and smoke evidence

OpenFang v0.6.9 was inspected in an isolated temporary home rather than installed globally.

- Release archive: `openfang-x86_64-pc-windows-msvc.zip`
- SHA-256: `18f5a8f6b563304749ce07444de8ca901fccb45e06a2e5a074fbbfbec037dc9f`
- Release checksum comparison: matched
- Archive paths: one safe entry, `openfang.exe`
- Authenticode: not signed
- Microsoft Defender matching detections: zero
- CLI/version/help/init/status smoke: completed with isolated environment variables
- Model-backed work: not executed

The unsigned binary remains a warning. A matching checksum proves correspondence with the published release asset, not publisher identity.

The smoke test also observed a lifecycle-truth problem: after quick initialization, the daemon was not running while 30 persisted sample agents were displayed as `Running`. Starlight therefore never accepts an OpenFang status label as execution proof without a live owned process, current lease/heartbeat, and artifact receipt.

## Threat model

The pilot assumes the worker, model output, public webpages, generated graph, and runtime labels may be wrong or hostile.

Protected assets:

- personal and production credentials;
- Starlight/Arcanea/FrankX repositories;
- SIS canonical memory;
- Queen and Hermes schedules/queues;
- Telegram and other external-send gateways;
- production, billing, DNS, deployment, and publishing surfaces.

The worker receives only:

- a bounded public-research objective;
- an allowlisted public source set;
- isolated provider access or a dedicated local model;
- a temporary OpenFang home;
- one Queen-owned invocation;
- a response channel that stages output into the pilot inbox.

## Admission gate

A single run is admitted only when all of these are true:

- the Hand contract has been explicitly changed to `enabled=true` for the reviewed run;
- compiled mode is `reactive`;
- compiled Hand ID matches the source contract;
- free disk is at least 80 GiB;
- available memory is at least 8 GiB;
- release checksum is verified;
- Defender reports no detection;
- credentials are dedicated to the isolated pilot—not the primary user profile or Codex OAuth state;
- the wrapper owns the runtime process;
- the selected loopback port is available;
- there is no equivalent schedule;
- the adapter preserves every denial;
- OpenFang cannot write canonical memory.

A recurring pilot additionally requires a daily-or-slower cadence. Hermes/Queen owns the cadence; the OpenFang Hand never creates its own schedule.

## Credential policy

Preferred order:

1. A dedicated, revocable provider credential with a hard low spend cap and no other scope.
2. A dedicated local model if its quality is sufficient and the hardware gate passes.
3. No run.

Forbidden:

- primary ChatGPT/Codex OAuth state;
- broad business provider keys;
- credentials inherited from the normal desktop profile;
- copying `.env`, browser storage, or CLI authentication directories into the sandbox.

## A/B protocol

Run the same bounded collection objective through:

- Hermes: `hermes-cron`
- OpenFang: `openfang-sidecar`

Use the same source cutoff, source allowlist, output schema, maximum source count, wall-time budget, and verifier. Alternate execution order to reduce freshness bias.

Each run emits `starlight.hand.pilot-receipt.v1` with:

- accepted artifacts;
- citation coverage;
- graph acceptance rate;
- operator minutes;
- model cost;
- failures;
- forbidden attempts;
- unexpected schedules;
- credential-exposure signal;
- evidence references.

Minimum decision sample: seven completed runs per runtime. Preferred sample: fourteen paired daily runs.

OpenFang promotion requires:

- zero credential exposure, forbidden attempts, and unexpected schedules;
- more accepted artifacts than Hermes;
- better graph acceptance;
- at least 90% citation coverage;
- at least 80% graph acceptance;
- less operator effort;
- no higher failure count.

Otherwise retain Hermes. Any safety signal returns `stop-openfang` immediately.

## One-run sequence

1. Generate a fresh environment envelope from live system checks; never reuse the example as evidence.
2. Validate and compile the Hand.
3. Run admission and retain its JSON output.
4. Create a fresh temporary OpenFang home and inbox.
5. Expose only the dedicated pilot credential.
6. Start one loopback-only, wrapper-owned process with a hard timeout.
7. Install the custom reactive Hand package, not the bundled Collector.
8. Invoke exactly once.
9. Capture stdout/stderr, process identity, listeners, artifact response, and policy events.
10. Deactivate the Hand, stop the daemon, and verify no child process/listener remains.
11. Convert output into the pilot receipt and run independent verification.
12. Promote accepted projections to SIS through a separate explicit import; otherwise quarantine them.

## Automatic stop conditions

Stop and quarantine the sidecar on:

- any secret or private-path access;
- any forbidden capability request;
- any schedule not created by Queen/Hermes;
- any external send or publish attempt;
- any canonical-memory write attempt;
- checksum or Defender failure;
- unowned child process or residual listener;
- timeout, budget breach, or repeated malformed receipt;
- evidence that the adapter exposed additional tools, skills, or MCP servers.

## Promotion choices after the trial

- **Promote bounded sidecar:** keep OpenFang only for the measured specialist role.
- **Absorb only:** remove OpenFang but keep the Starlight Hand contract, compiler model, receipts, and Hermes implementation.
- **Reject runtime:** remove OpenFang-specific assets while retaining the general admission and evidence improvements.
