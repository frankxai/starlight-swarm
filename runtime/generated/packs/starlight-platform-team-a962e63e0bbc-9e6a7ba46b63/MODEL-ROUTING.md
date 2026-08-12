# Model routing and economics

Queen policy chooses one provider ingress per lane. Do not stack direct providers, LiteLLM, OpenRouter, Vercel AI Gateway, and framework-local routing on one production call. Keep maker and verifier routes independent where consequence justifies the cost.

| Role | Runtime | Provider ingress | Quality route | Daily tokens | Daily cost |
|---|---|---|---|---:|---:|
| coordinator | railway-temporal | direct-provider | balanced | 120,000 | $4.00 |
| backend-data-engineer | railway-temporal | direct-provider | frontier | 250,000 | $12.00 |
| qa-release-sre-verifier | hermes-local | hermes-profile | checker-independent | 80,000 | $3.00 |

## Routing policy

- Frontier quality for architecture, consequential engineering, synthesis, and ambiguous decisions.
- Balanced quality for interactive coordination and bounded operator assistance.
- Economy/fast models for deterministic extraction, classification, formatting, and high-volume drafts after eval proof.
- Independent checker route for release, safety, claims, and expensive decisions.
- Direct providers first for Railway workers; Vercel AI Gateway only inside the explicitly allowlisted Eve lane; Hermes profiles for admitted local work.

## ROI accounting

Measure accepted outputs, escaped defects, operator minutes saved, elapsed time, retries, cost per accepted result, revenue/progress attribution, and harm metrics. Token consumption alone is not value.
