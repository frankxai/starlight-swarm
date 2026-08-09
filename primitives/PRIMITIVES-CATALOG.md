# Starlight Swarm Primitives Catalog (God Mode v2)

**Purpose**: Reusable, composable building blocks for sophisticated swarms. Every primitive is designed to be **taken and tailored** by anyone for their own businesses.

Each entry includes:
- Contract
- Recommended topologies
- Model router guidance (primary + fallbacks)
- Evaluation / verification
- Tailoring notes

---

## Core Topologies

### Hierarchical
- **Description**: Clear command structure (Queen/General directs, specialists execute).
- **When to use**: Most governance-heavy or high-stakes work.
- **Compose with**: Any other.

### Mesh
- **Description**: Peer-to-peer collaboration inside a stream or team.
- **When to use**: Creative or research work where multiple perspectives add value.

### Pipeline (Maker-Checker-Verifier)
- **Description**: Sequential stages with independent verification.
- **When to use**: Safety, revenue, health, code — anything where false positives are expensive.
- **Example from history**: Recent overnight campaign (Fable maker + Opus checker).

### Star / Hub-Spoke
- **Description**: Central coordinator with specialized spokes.
- **When to use**: When one strong router needs to delegate to narrow experts.

### Adaptive
- **Description**: Topology can change at runtime based on signals.
- **When to use**: Long-running or uncertain work.

### Ruflow (Relentless Unit Flow)
- **Description**: Persistent bounded units that cycle on a goal with progress tracking (SIS). Keep flowing until objective, budget, or explicit stop.
- **Best for**: Research sweeps, content engines, optimization loops, backlog clearing.
- **Router note**: Often benefits from creative or research-strong models (Fable, Gemini, Grok).
- **Safety**: Hard time/token/cost caps + human gate on crossing thresholds.

### Paperclip (Objective Maximizer)
- **Description**: Narrow, relentless optimization toward one measurable objective with **strict** caps and safety valves.
- **Best for**: Pricing experiments, conversion optimization, specific metric pushes.
- **Router note**: High-precision models + strong checker (Opus/GPT-5.6).
- **Warning**: Extremely powerful — always pair with hard escalation and human approval for any external effect.

### GStack Council
- **Description**: Multi-review design/devex council pattern (CEO review, engineering review, visual QA, devex, etc.).
- **Best for**: Product pages, architecture decisions, high-visibility launches.
- **Router note**: Mix of synthesis + verification models.

---

## Domain & Functional Primitives

### Revenue Systems / Checkout Integrity
- Evidence review → claims audit → code path verification → server authority proof → test-mode smoke → production gate.
- Pipeline + hierarchical.
- Primary: Fable or GPT-5.6; fallbacks include strong reasoning models.

### Funnel Swarm
- Top queries/research → hooks → content → distribution → measurement loop.
- Ruflow or Pipeline.
- Good for traffic → trust → conversion.

### Product Development Swarm
- Discovery → thin artifact → maker → independent checker → acceptance → experiment registration.
- Strong use of GStack for design-heavy.

### Idea Forge / Genius Forge
- Capture → multi-model competition/evolution → quantification → validation → execution plan.
- Mesh + adaptive.
- Creative-strong models primary.

### Research Synthesis Pipeline
- Per-domain scanning → cross-source synthesis → evidence ledger → actionable recommendations.
- Ruflow or Pipeline.

### Control Plane Sentinel
- Routing, fallback, quota, sandbox, receipts review.
- Hierarchical + pipeline with Opus/GPT-5.6 class checkers.

### Safety / Health Architecture Auditor
- Boundary enforcement, refusal behavior, emergency routing, misleading claims detection.
- Pipeline (maker Fable + checker Opus/GPT).

### Token Tracker + Self-Improvement
- Usage accounting → pattern detection → routing policy updates → report.
- Adaptive.

### Swarm Comms Protocol
- Durable bus between machines (Yogabook Queen ↔ C940, etc.).
- Star / reliable mesh.

---

## How to Tailor for Your Business

1. Copy the primitive folder(s) you need.
2. Rename lanes and map to your revenue streams or projects.
3. Edit the model router declaration (primary + fallbacks) to match your subscriptions.
4. Plug your memory/SIS equivalent.
5. Define your human gates and escalation rules.
6. Add your measurement (business metrics that prove "massive action").
7. Run bounded first (dry-run or small campaign), then scale.

**Community rule**: Keep the generalized layer free of private paths, credentials, or Frank-specific dirty work. Put customizations in your own repo or a `your-company/` overlay.

---

**Status**: Catalog v0.1 — core topologies + high-value estate primitives documented. Code implementations and more examples will follow in subsequent phases.

See `docs/GOD-MODE-SWARM-OS-V2.md` and `MODEL-ROUTER-SPEC.md` for the broader system.