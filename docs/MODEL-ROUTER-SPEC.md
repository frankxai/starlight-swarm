# God Mode Model Router Spec v1

**Purpose**: Eliminate single-model fragility. Every Queen/lane must declare primary + fallbacks. Runtime selects intelligently and reports exactly what ran.

**Location in architecture**: Called by SO / Queen coordinators before launching any specialist swarm or campaign lane. Output is recorded in receipts and state.

## 1. Core Interface

```ts
interface ModelRequest {
  laneId: string;
  taskClass: 'creative-synthesis' | 'code-review' | 'safety-audit' | 'research' | 'planning' | 'execution' | 'verification' | 'synthesis';
  primary: string;                    // e.g. "claude-fable-5"
  fallbacks: string[];                // ordered preference
  minQuota?: { session?: number; weekly?: number };
  costTier?: 'low' | 'medium' | 'high';
  maxLatencyMs?: number;
}

interface ModelSelection {
  selected: string;
  wasFallback: boolean;
  reason: string;
  score: number;
  quotaSnapshot: Record<string, any>;
  timestamp: string;
}
```

## 2. Providers & Aliases (initial)

- `claude-fable-5`, `claude-opus-4-8`, `claude-sonnet-5`
- `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `codex-gpt-5.6`
- `gemini-3.6-pro`, `gemini-3.6-flash`
- `grok-4.5`, `grok-4.5-vision`
- Future: add with capability tags

## 3. Capability Matrix (example)

| Task Class          | Strong Matches                  | Acceptable Fallbacks          |
|---------------------|---------------------------------|-------------------------------|
| creative-synthesis  | claude-fable-5, gemini-3.6-pro, grok-4.5 | gpt-5.6 variants             |
| safety-audit        | claude-opus, gpt-5.6, gemini   | Any high-reasoning           |
| code-review         | gpt-5.6, claude-sonnet/opus, grok | claude-fable for synthesis  |
| research            | gemini, gpt-5.6, claude        | All                          |

(Full matrix lives in `config/capability-matrix.json` — start minimal.)

## 4. Routing Logic (deterministic, auditable)

1. Collect candidates = [primary, ...fallbacks].
2. For each candidate:
   - Fetch live signals (tokscale quota, provider status if available, estimated cost/latency).
   - Compute score = exactMatchBonus + capabilityScore(taskClass, model) + quotaFactor + (1 / normalizedCost) + availability.
3. Filter those meeting minQuota (if declared).
4. Pick highest score.
5. If none qualify → return HOLD + escalate.

**Exact-match bonus** is high so requested model is strongly preferred.

## 5. Enforcement & Reporting

- Router result is **mandatory** in every lane receipt/state.
- Must include: `selected`, `wasFallback`, `reason`, `reportedModels` from the actual invocation.
- Critical lanes (health, payments, irreversible) refuse start if router cannot supply a viable path.
- All selection events are logged to SIS (append-only).

## 6. Fallback Policy Examples

- Health/Safety lane: primary Fable 5 → fallbacks must include at least one strong reasoning model (Opus/GPT-5.6/Gemini).
- Revenue review: primary Fable or GPT-5.6 → visual/creative fallbacks allowed if synthesis heavy.
- Control-plane: prefer Opus or GPT-5.6 for deep reasoning.

## 7. Implementation Phases

**v1 (this spec)**: Config-driven selection + reporting only. No live provider calls yet. Used by campaign runners and dry-runs.

**v2**: Wire tokscale + simple provider health probes.

**v3**: Cost/latency estimators + adaptive scoring.

**Portable spec**: This Markdown + JSON schemas can be implemented in Hermes, AO, Claude Code wrappers, etc.

## 8. Example Usage in a Runner

```ts
const selection = await router.select({
  laneId: "FABLE-HEALTH-ARCHITECTURE-QUEEN",
  taskClass: "safety-audit",
  primary: "claude-fable-5",
  fallbacks: ["gpt-5.6-sol", "gemini-3.6-pro", "grok-4.5"]
});

if (!selection || selection.wasFallback && !policy.allowsFallbackForLane(laneId)) {
  // escalate or hold
}
```

Record:
```json
{
  "modelSelection": {
    "selected": "claude-opus-4-8",
    "wasFallback": true,
    "reason": "primary unavailable or quota below floor",
    ...
  }
}
```

---

This spec directly addresses the "not intelligent enough" feedback and the concrete Fable-vs-Opus mismatch from the July 18–19 campaign.