# Starlight Hands

`starlight.hand.v1` is the runtime-neutral contract for bounded autonomous workers owned by Starlight Queen.

## Authority boundary

- **Hermes** remains the primary human interface, scheduler, and existing Codex runtime.
- **Starlight Queen / Agentic Ops** owns admission, leases, routing, verification, receipts, and termination.
- **SIS** is the only canonical memory and knowledge authority.
- Runtime adapters such as OpenFang are replaceable workers. They cannot weaken contract denials.

## Files

- `schema/starlight.hand.v1.schema.json` — runtime-neutral Hand contract.
- `schema/starlight.hand.pilot-receipt.v1.schema.json` — comparable A/B run receipt.
- `examples/collector-openfang-pilot.hand.json` — disabled OpenFang Collector contract.
- `examples/collector-hermes-pilot.hand.json` — equivalent disabled Hermes baseline contract.
- `examples/openfang-single-run.admission.example.json` — deterministic admission-envelope example.
- `openfang/collector-openfang-pilot/` — compiled reactive OpenFang package.
- `hermes/collector-hermes-pilot/job.json` — compiled local-delivery Hermes job specification.
- `OPENFANG-PILOT.md` — threat model, evidence, rollout, stop conditions, and scoring.

## Commands

```bash
npm run hand:pilot -- validate hands/examples/collector-openfang-pilot.hand.json
npm run hand:pilot -- compile-openfang hands/examples/collector-openfang-pilot.hand.json
npm run hand:pilot -- compile-hermes hands/examples/collector-hermes-pilot.hand.json
npm run hand:pilot -- compare \
  hands/examples/collector-hermes-pilot.hand.json \
  hands/examples/collector-openfang-pilot.hand.json
npm run hand:pilot -- admit-openfang \
  hands/examples/collector-openfang-pilot.hand.json \
  hands/examples/openfang-single-run.admission.example.json
npm run hand:pilot -- score hermes-receipts.json openfang-receipts.json
```

Exit codes:

- `0` — valid, admitted, or scored without a safety stop.
- `1` — malformed input or validation failure.
- `2` — invalid CLI usage.
- `3` — admission blocked or OpenFang safety stop.

## Fail-closed compilation

The OpenFang compiler accepts only a small public-research tool allowlist. It deliberately omits `max_iterations`: OpenFang v0.6.9 turns Hands with that field into hourly Continuous agents. The compiled Hand is reactive and may run only after an explicit Queen-owned invocation.

The checked-in `HAND.toml` must exactly match compiler output; the test suite enforces this to prevent manual drift.

A contract with `enabled=false` may be validated and compiled but cannot pass admission. Compilation is not activation.
