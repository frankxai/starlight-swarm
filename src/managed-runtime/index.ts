/**
 * index.ts — managed-runtime dry-run.
 *
 * Validates the revenue portfolio, routes each stream's first workload class,
 * reserves a budget through the swarm's escalation spine, runs it on the
 * dry-run provider, settles the reservation, and prints the sealed receipts.
 *
 * No model is called. No money moves. No side effect fires.
 *
 * Run:  npm run runtime:managed:dry-run
 */

import { parseAgentSpec, parseRunRequest, RUN_REQUEST_SCHEMA_VERSION } from './contract';
import { routeWorkload } from './router';
import { reserveBudget, settleBudget } from './budget';
import { verifyReceipt } from './receipts';
import { validatePortfolio } from './revenue-streams';
import { canPromote } from './experiments';
import { DryRunRuntime } from './providers/dry-run';

const out = (line = '') => console.log(line);

async function main(): Promise<void> {
  out('═══════════════════════════════════════════════════════════════');
  out('  STARLIGHT MANAGED RUNTIME — dry-run  ·  one port, three providers');
  out('═══════════════════════════════════════════════════════════════');

  const portfolio = validatePortfolio();
  out(`portfolio: ${portfolio.ok ? 'valid' : 'INVALID'} · ${portfolio.streams.length} streams · pilots: ${portfolio.pilots.join(', ') || 'none'}`);
  for (const problem of portfolio.problems) out(`  ! ${problem}`);
  out();

  const runtime = new DryRunRuntime();
  let spent = 0;
  const policy = { limitMicroUsd: 50_000_000, perRunCapMicroUsd: 5_000_000 }; // $50 period, $5 per run

  for (const stream of portfolio.streams) {
    const workloadClass = stream.workloads[0];
    const realRoute = routeWorkload(workloadClass, { reversible: true });
    const route = routeWorkload(workloadClass, { reversible: true }, { dryRun: true });

    const spec = parseAgentSpec({
      name: `${stream.id} ${stream.name}`,
      instructions: `You operate revenue stream ${stream.id}. Mechanism: ${stream.mechanism}`,
      workloadClass,
      metadata: { stream: stream.id, owner: stream.owner },
    });
    const provisioned = await runtime.provision(spec, route.model ?? 'dry-run');

    const reserve = reserveBudget(
      { stream: stream.swarmStream, ...policy },
      spent,
      2_000_000,
      { reservationId: `res-${stream.id}`, runId: `run-${stream.id}`, workspaceId: 'estate' },
    );
    if (!reserve.ok) {
      out(`${stream.id} ${stream.name}: budget ${reserve.classification.decision} — ${reserve.reason}`);
      continue;
    }

    const request = parseRunRequest({
      schemaVersion: RUN_REQUEST_SCHEMA_VERSION,
      runId: `run-${stream.id}`,
      workspaceId: 'estate',
      actorId: stream.owner,
      agent: provisioned,
      model: route.model ?? 'dry-run',
      input: `Advance ${stream.name} toward its gate: ${stream.promotionGate}`,
      budget: reserve.reservation,
    });

    const receipt = await runtime.run(request, spec);
    const settlement = settleBudget(reserve.reservation, receipt.costMicroUsd);
    spent = settlement.spentMicroUsdAfter;
    const promotion = canPromote(stream.stage, []);

    out(`${stream.id} ${stream.name}`);
    out(`  stage ${stream.stage} → ${promotion.ok ? promotion.to : 'hold'} (${promotion.because})`);
    out(`  route  ${realRoute.provider}/${realRoute.modelClass}${realRoute.model ? ` (${realRoute.model})` : ' (provider default)'}`);
    out(`  budget reserved ${reserve.reservation.reservedMicroUsd} µ$ · settled ${settlement.actualMicroUsd} µ$ · overrun ${settlement.overrunMicroUsd}`);
    out(`  receipt ${receipt.status} · verified ${verifyReceipt(receipt)} · ${receipt.digest.slice(0, 16)}…`);
    out(`  gate   ${stream.promotionGate}`);
    out(`  kill   ${stream.killCriterion}`);
    out();
  }

  out('No model was called. No money moved. Receipts are the only output.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
