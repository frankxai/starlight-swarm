# God Mode Starlight Swarm OS v2 — Intelligent, Fallback-Rich, Domain-Scale

**Status**: Design + initial artifacts. Builds directly on the v0.1/v0.2 foundation in this repo (Queen-led streams, hierarchical + mesh, escalation spine, SO/Queen/AO/SIS layers).

**Core Mandate** (Frank's requirement):
- Never blocked by a single model/provider (Claude Fable/Opus, GPT-5.6 Sol/Terra/Luna, Gemini 3.6, Grok 4.5, future frontiers).
- "Intelligent and big and good enough": dynamic routing by capability, quota, cost, latency.
- Full org structure: dedicated Queens + Generals per major domain/business with real "massive action" that advances revenue, products, ops, creative output.
- Generalized, complete, ultra-advanced primitives and topologies that **anyone** can take from this official repo and tailor to their own businesses.
- Preserve (and harden) all existing safety: escalation, human gates, no autonomous money, receipts, exact model-route certification.

This document + the sibling specs in `/docs` and `/primitives` are the canonical starting point.

## 1. What Was Wrong (Current State Summary, 2026-08)

From estate research (starlight-swarm + starlight-agent-config + recent campaigns):

- Strong governance skeleton: SO routes → Queen plans/evaluates → AO executes in worktrees → SIS remembers.
- Good for income streams (4 queens: Affiliate, Products, Content, Payments) with hierarchical command + mesh worker collab + hard escalation ladder (worker → queen → founder → human).
- **Critical gaps**:
  - Model assignment was mostly static or single-primary with ad-hoc fallback (e.g., recent overnight campaign requested Fable 5 on Health lane but got Opus; 3/4 routes certified).
  - No unified "God Mode" router that queries live quota (tokscale), capability match, and multiple providers.
  - Swarm size and structure were narrow (income-focused) rather than full-empire domain orgs.
  - Primitives and topologies were implicit or scattered across skills/docs rather than a reusable, community-extractable library.
  - "Massive action" existed in campaigns but lacked systematic linkage from intent → routed models → measurable business progress with fallbacks.

Result: Powerful but not yet "intelligent and big and good enough" for god-mode across the entire estate (FrankX + Arcanea + GenCreator + SIS + Ops + Wealth + community).

## 2. God Mode Principles

1. **Router-First**: Every Queen/lane declares primary model + ≥2 fallbacks. The system chooses at runtime.
2. **Capability + Constraint Aware**: Route by task class (creative synthesis, code/safety audit, research, planning, execution, verification) + live signals (quota headroom, latency, cost, availability).
3. **Domain Scale with Containment**: Dedicated full-org Queens per major business. Cross-domain only via Chief Queen or explicit escalation.
4. **Composable Topologies**: Primitives are Lego. Compose (e.g., hierarchical outer + ruflow inner + gstack review council).
5. **Massive Action, Not Just Analysis**: Campaigns produce verifiable forward motion (PRs landed with gates, systems improved, revenue paths enabled, content shipped, ops hardened) measured in business outcomes.
6. **Generalized for Community**: Everything extractable. Official repo = the reference implementation + tailoring guide. No FrankX-specific lock-in in the primitives layer.
7. **Safety Is Non-Negotiable**: All prior escalation, human gates, receipts, exact-route reporting, and no-autonomous-irreversible rules remain and are enforced harder.

## 3. God Mode Model Fabric (the Router)

### Goals
- Eliminate single-point model outages or quota blocks.
- Always report exact model used (primary vs fallback) in every receipt/state.
- Prefer exact requested model; fall back intelligently without silent degradation.

### Core Components
- `ModelRouter` (TypeScript in this repo; portable spec for other harnesses).
- Capability registry: map task classes → suitable models.
- Live signals: tokscale (or equivalent), provider health, per-provider quotas/caps.
- Policy: exact-match first → capability score → quota floor → cost/latency tiebreak → explicit reserve.
- Enforcement: critical lanes refuse to start (or escalate) if no viable fallback path meets policy.

### Example Lane Declaration (config)
```json
{
  "lane": "FABLE-HEALTH-ARCHITECTURE-QUEEN",
  "primary": "claude-fable-5",
  "fallbacks": ["gpt-5.6-sol", "gemini-3.6-pro", "grok-4.5"],
  "capabilities": ["safety-audit", "health-boundary", "research-synthesis"],
  "minQuota": { "session": 15, "weekly": 5 },
  "costTier": "high",
  "escalationOnMismatch": true
}
```

### Routing Algorithm (pseudocode)
1. Score candidates = (exact match ? 100 : capability_match_score) * quota_factor * (1 / cost) * availability.
2. Filter by minQuota and declared fallbacks.
3. Pick highest score; record "usedModel", "wasFallback", "reason".
4. If nothing meets bar → HOLD + escalate to Chief Queen / human.

### Providers to Wire (initial)
- Claude family (Fable 5, Opus 4.x, Sonnet variants)
- OpenAI / Codex (GPT-5.6 Sol, Terra, Luna, etc.)
- Gemini (3.6+)
- Grok / xAI (4.5+)
- Future: local fallbacks or additional when headroom/price justifies.

**Implementation note**: Start with a pure config + reporting layer that existing runners (claude-night style, AO, etc.) can call. Later wire real provider clients.

See companion: `MODEL-ROUTER-SPEC.md`

## 4. Org Structure — Dedicated Queens + Generals + Full Domain Orgs

### Top Level
- **Chief Queen / Empire Orchestrator** (or "Luminor Queen"): Sets empire thesis, allocates across domains, resolves cross-domain conflicts, owns ultimate escalation to human/founder. Does **not** do per-domain execution.

### Domain Queens (each gets a mini-org)
Each domain Queen behaves like a "CEO" of that business line with its own Generals + Swarms.

| Domain Queen | Primary Businesses | Example Generals | Specialist Swarms / Teams |
|--------------|--------------------|------------------|---------------------------|
| **FrankX Queen** | Creator revenue, products, distribution, content engine | Revenue General, Product General, Growth General, Distribution General | Revenue Systems, Checkout Integrity, Content Hooks, Funnel, Creator Kit Packaging |
| **Arcanea Queen** | Lore, creative worlds, media, games, on-chain, studio | Creative General, World Engine General, Media General | Lore Keeper, Character Forge, Visual Intelligence, Game Dev Swarm, NFT Forge |
| **GenCreator / ACOS Queen** | Agentic Creator OS, 6-Pillar, Studio, templates | Product OS General, Studio General | 6-Pillar Guardian, Idea Forge, Content Repurposing, Skill Builder |
| **SIS / Intelligence Queen** | Memory, research, vertical systems, knowledge architecture | Research General, Vertical Systems General | Research Synthesis, Vertical Intelligence, Starlight Second Brain, Evidence Pipelines |
| **Control / Ops Queen** | Fleet, GitOps, security, storage, comms, runtime health | Ops General, Security General, Storage General | Control Plane Sentinel, GitOps Hygiene, Swarm Comms, Storage Intelligence, Safety Auditor |
| **Wealth / Passive Queen** | Investor OS, income streams, capital allocation | Revenue Streams General, Capital General | Income Stream Optimizer, Token Tracker, Wealth OS, Funnel Economics |

### Generals
- VP-level. Coordinate multiple specialist swarms.
- Can be cross-domain for shared functions (e.g., Chief Revenue General spans FrankX + GenCreator).
- Own routing of work to the right topology + model(s) via the God Mode router.
- Escalate to their Domain Queen on boundary/cost/risk.

### Specialist Swarms / Teams (the "Queens" of the recent campaign become these)
- Bounded, composable units.
- Examples from recent work: Revenue Systems Queen → Revenue Systems Swarm; Health Architecture Queen → Health/Safety Architecture Swarm; Control-Plane Sentinel → Control Plane Swarm; Empire Chief Judge → Reconciliation / Chief Judge Swarm (often run by Opus or equivalent checker).

**Containment rule**: A swarm in one domain never commands resources in another without Chief Queen routing.

## 5. Swarm Topologies & Primitives Library (Generalized for Community)

### Base Topologies (composable)
- **Hierarchical**: Queen/General commands, workers execute (current foundation).
- **Mesh**: Peer collaboration within a stream/team.
- **Pipeline**: Sequential maker → checker → verifier (strong for safety/revenue reviews).
- **Star / Hub-Spoke**: Central coordinator with spokes.
- **Adaptive**: Runtime can reconfigure topology based on signals.
- **Ruflow (Relentless Unit Flow)**: Persistent bounded units that cycle on a goal (progress tracked in SIS). Keep flowing until objective met, budget exhausted, or explicit stop. Excellent for research, content, optimization.
- **Paperclip (Objective Maximizer)**: Narrow, relentless optimization toward a single measurable objective with **hard** caps (tokens, time, cost, human approval thresholds). Safety valves required.
- **GStack**: Multi-review council pattern (CEO review, eng review, design/visual QA, devex). From the gstack skill family — formalize as a reusable topology.

### Higher-Level / Domain Primitives (extracted & generalized from estate)
- Funnel Swarm
- Product Development Swarm (evidence → thin artifact → maker-checker → acceptance)
- Idea Forge / Genius Forge
- Starlight Autonomous Ops (overnight/daily bounded campaigns)
- Swarm Comms Protocol (Yogabook ↔ C940 durable bus)
- Token Tracker + Self-Improvement
- Events / Attendance OS patterns
- Multi-brand Content Repurposing
- Per-domain Research Pipeline

**Each primitive in the library must have**:
- Contract (inputs, outputs, gates, rollback).
- Topology diagram(s).
- Prompt / instruction modules (portable).
- Evaluation rubric + verification steps.
- Model router declaration (primary + fallbacks).
- Tailoring guide ("How to map this to your 3 revenue streams").
- Example receipt/state shape.

See: `primitives/PRIMITIVES-CATALOG.md` (to be populated).

## 6. Massive Action Framework

"Run them all" should produce forward motion, not just analysis.

**Campaign Contract** (first-class artifact):
- Objective (business outcome, not just "review").
- Admission gates (RAM, quota, router availability, human if needed).
- Evidence packet (frozen at start).
- Execution (routed models + chosen topology).
- Verification (exact route, hashes, independent checker).
- Measurement (what business metric moved? PRs landed? revenue path enabled? system hardened?).
- Rollback / archive plan.
- Handoff to founder / next lane.

**Cadences**:
- Overnight / multi-hour (bounded, supervisor).
- Daily close (ops hygiene, receipts).
- Weekly palace / strategy.
- On-demand (idea → execution).

Link every campaign to the God Mode router and a declared primitive/topology.

## 7. Community Generalized Library — Official Repo Contract

This repo (`starlight-swarm`) becomes the **reference home** for ultra-advanced, take-and-tailor swarms.

**Structure to add**:
```
primitives/
  catalog.md
  ruflow/
  paperclip/
  gstack-council/
  hierarchical/
  pipeline-maker-checker/
  ...
topologies/
  diagrams/
  composability.md
generalized/
  templates/
    domain-queen/
    revenue-general/
    specialist-swarm/
  examples/
    generic-creator-business/
    saas-startup/
docs/
  adopt-for-your-business.md
  MODEL-ROUTER-SPEC.md
  ORG-CHART.md
  GOD-MODE-SWARM-OS-V2.md (this file)
```

**Adopt Guide (high level)**:
1. Fork or copy the primitives you need.
2. Map your domains to Domain Queens.
3. Wire your model providers into the router config.
4. Choose topologies per stream.
5. Plug your SIS/memory layer.
6. Add your human gates and escalation rules.
7. Run bounded campaigns with measurement.

The generalized layer must be **sanitized** (no private FrankX paths, credentials, or specific dirty worktrees).

## 8. Safety & Governance Hardening (v2)

- Router must surface "exact model used" and "wasFallback" in every receipt.
- Critical lanes (payments, health, irreversible) require at least one non-primary fallback available or escalate.
- All campaigns remain finite + supervised unless explicitly human-authorized for longer.
- Preserve the existing escalation spine and "agents draft/gate, humans deploy/post/send".
- No new autonomous spend or publish paths.

## 9. Phased Implementation Roadmap

**Phase 0 (Now)**: This design + first artifacts (router spec, org chart, primitives catalog skeleton, doctrine updates).

**Phase 1**: Implement ModelRouter (config + reporting first, live signals second). Update one existing runner (e.g., a night campaign script or AO integration) to use it.

**Phase 2**: Expand org chart into runnable configs. Add 2–3 new Domain Queens as bounded experiments.

**Phase 3**: Extract 5–7 core primitives into reusable form with tailoring guides.

**Phase 4**: Full community packaging + docs + examples. Dry-runs that demonstrate fallback routing + ruflow/paperclip/gstack.

**Phase 5**: Wire into live Starlight Queen / AO / swarm-comms for god-mode operation across machines.

## 10. Success Metrics (for Frank)

- Zero "blocked on single model" incidents for admitted campaigns.
- Every major lane reports exact route + fallback usage with evidence.
- Measurable business forward motion from campaigns (tracked in SIS + reports).
- At least one external/community adoption or fork using the generalized primitives.
- All existing safety properties hold or improve.

---

**Next concrete steps** (from this plan):
1. Create MODEL-ROUTER-SPEC.md + skeleton.
2. Create ORG-CHART + domain-queens.json.
3. Populate primitives catalog with at least Ruflow, Paperclip, GStack, Pipeline, Hierarchical.
4. Update starlight-swarm-doctrine.md and SWARM-ARCHITECTURE.md with v2 references.
5. Write adopt-for-your-business.md.

This is the foundation for the most sophisticated, fallback-rich, community-portable swarm system in the estate — and the official template for anyone else.

(End of design doc. See sibling files for specs and scaffolds.)