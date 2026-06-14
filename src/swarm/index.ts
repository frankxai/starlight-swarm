/**
 * index.ts — the L6 Swarm Runtime dry-run entry point.
 *
 * Wires founder + four stream queens + their worker meshes from streams.ts and
 * runs a DRY-RUN that:
 *   1. prints the founder → queen → worker tree,
 *   2. drives one self-improving-loop step per queen,
 *   3. demonstrates the full escalation ladder (autonomous → queen-gate →
 *      founder-board → human-gate) WITHOUT firing any real action.
 *
 * ⚠️ v0.1 SCAFFOLD — DRY-RUN ONLY. No real action fires. No money moves.
 * MCP integration points are referenced via dry-run stubs (integrations.ts).
 *
 * Run:  npm run swarm:dry-run   (tsx)  ·  or  npx tsx src/swarm/index.ts
 */

import { FOUNDER, STREAMS, swarmTree } from './streams';
import { Queen } from './queen';
import type { Task } from './worker';
import type { Action, StreamId } from './escalation';
import { classify } from './escalation';
import { makeDryRunVault, makeDryRunPayments } from './integrations';

const out = (m = '') => console.log(m);

/** Small helper to build a proposed action with sane reversible defaults. */
function action(stream: StreamId, partial: Partial<Action> & Pick<Action, 'kind'>): Action {
  return {
    stream,
    irreversible: false,
    movesMoney: false,
    crossStream: false,
    ...partial,
  };
}

function printTree(): void {
  const tree = swarmTree();
  out('═══════════════════════════════════════════════════════════════');
  out('  STARLIGHT SWARM — L6 Runtime (dry-run)  ·  hybrid queens-per-stream');
  out('═══════════════════════════════════════════════════════════════');
  out('');
  out(`  FOUNDER  ${tree.founder.name}   [gate: ${tree.founder.gate}]`);
  out(`           thesis ← ${tree.founder.thesisSource}`);
  out('           owns: capital · irreversible actions · cross-queen conflict');
  out('             │');
  for (const s of tree.streams) {
    out('             ├── QUEEN  ' + s.queen + `   (${s.label} stream)`);
    out('             │          loop: ' + s.loop.join(' → '));
    for (const w of s.workers) {
      out(`             │      • ${w.name.padEnd(20)} skill:${w.skill}`);
    }
    out('             │          mesh: workers collaborate peer-to-peer within stream');
  }
  out('');
  out('  Topology: queen-led per stream, mesh within. Queens never command across');
  out('  streams — they coordinate through the founder. No autonomous money movement.');
  out('');
}

/** Show classify() resolving each tier of the escalation contract. */
function demoEscalationLadder(): void {
  out('───────────────────────────────────────────────────────────────');
  out('  ESCALATION LADDER (classify() — the safety spine)');
  out('───────────────────────────────────────────────────────────────');

  const samples: Array<{ label: string; a: Action }> = [
    {
      label: 'Content worker drafts an article (reversible, no money)',
      a: action('content', { kind: 'draft' }),
    },
    {
      label: 'Affiliate queen binds a link (binding, in-stream)',
      a: action('affiliate', { kind: 'bind-link' }),
    },
    {
      label: 'Payments queen settles within cap',
      a: action('payments', { kind: 'payment', movesMoney: true, amount: 40, cap: 100 }),
    },
    {
      label: 'Payments queen settles OVER cap → founder + board',
      a: action('payments', { kind: 'payment', movesMoney: true, amount: 500, cap: 100 }),
    },
    {
      label: 'Action crosses a stream boundary → founder coordinates',
      a: action('content', { kind: 'build-page', crossStream: true }),
    },
    {
      label: 'New payment rail → founder + board',
      a: action('payments', { kind: 'new-rail' }),
    },
    {
      label: 'Move funds / rotate key / send blast → HUMAN, always',
      a: action('payments', { kind: 'move-funds', movesMoney: true, irreversible: true }),
    },
  ];

  for (const { label, a } of samples) {
    const c = classify(a);
    out('');
    out(`  ▸ ${label}`);
    out(`      decision : ${c.decision}`);
    out(`      gates    : ${c.gates.join(' → ')}`);
    out(`      reason   : ${c.reason}`);
  }
  out('');
}

/** Run one loop step per queen, including a demonstrated escalation. */
async function runLoopSteps(): Promise<void> {
  out('───────────────────────────────────────────────────────────────');
  out('  QUEEN LOOP STEPS (one heartbeat per stream — dry-run)');
  out('───────────────────────────────────────────────────────────────');

  const vault = makeDryRunVault(out);
  const payments = makeDryRunPayments(out);

  // Per-stream sample tasks. Reversible/in-stream stay autonomous; the Payments
  // over-cap task demonstrates the worker → queen → founder → human ladder.
  const tasksByStream: Record<StreamId, Task[]> = {
    affiliate: [
      { id: 'aff-1', worker: 'catalog-auditor', description: 'audit program catalog', proposes: action('affiliate', { kind: 'research' }) },
      { id: 'aff-2', worker: 'link-binder', description: 'bind approved link', proposes: action('affiliate', { kind: 'bind-link' }) },
    ],
    products: [
      { id: 'prd-1', worker: 'product-architect', description: 'gap-scan + spec', proposes: action('products', { kind: 'draft' }) },
    ],
    content: [
      { id: 'con-1', worker: 'writer', description: 'draft the article', proposes: action('content', { kind: 'draft' }) },
    ],
    payments: [
      { id: 'pay-1', worker: 'mandate-verifier', description: 'settle within cap', proposes: action('payments', { kind: 'payment', movesMoney: true, amount: 40, cap: 100 }) },
      { id: 'pay-2', worker: 'spend-cap-enforcer', description: 'settle OVER cap', proposes: action('payments', { kind: 'payment', movesMoney: true, amount: 500, cap: 100 }) },
    ],
  };

  for (const spec of STREAMS) {
    const queen = new Queen(spec, out);
    const mcp = spec.id === 'payments' ? { vault, payments } : { vault };
    await queen.stepLoop(tasksByStream[spec.id], mcp);
  }
  out('');
}

async function main(): Promise<void> {
  printTree();
  demoEscalationLadder();
  await runLoopSteps();

  out('═══════════════════════════════════════════════════════════════');
  out('  DRY-RUN COMPLETE — no action fired, no money moved.');
  out(`  Founder: ${FOUNDER.name}  ·  Streams: ${STREAMS.map((s) => s.label).join(', ')}`);
  out('  Standing rule: agents draft, gate, and commit; humans deploy, post, send.');
  out('═══════════════════════════════════════════════════════════════');
}

main().catch((err) => {
  console.error('dry-run failed:', err);
  process.exit(1);
});
