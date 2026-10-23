# Model routing and economics

| Role | Executor | Provider ingress | Quality route | Daily token cap | Daily cost cap |
|---|---|---|---|---:|---:|
| coordinator | cloudflare-workflows | vercel-ai-gateway | balanced | 120,000 | $4.00 |
| backend-data-engineer | railway-worker | vercel-ai-gateway | frontier | 250,000 | $12.00 |
| qa-release-sre-verifier | hermes-local | hermes-profile | checker-independent | 80,000 | $3.00 |

Each lane has one provider ingress. Vercel Workflow uses its declared gateway route; local Hermes uses its profile; connectors do not gain model authority. Maker and checker routes remain separate. These are planning ceilings, not observed invoices, subscription grants or accepted-outcome costs. Measure output quality, repair, elapsed time, cancellation/recovery and actual billed usage on the same job.
