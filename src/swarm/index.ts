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
import { BENEVOLENCE_CHARTER, checkCharter, explain, raiseTo } from './charter';
import type { CharterContext } from './charter';
import { makeDryRunVault, makeDryRunPayments, connectRealPayments } from './integrations';
import { resolve } from 'node:path';

const out = (m = '') => console.log(m);

/**
 * Where the built Payments MCP server lives. Configurable via env so CI / other
 * machines can point at their own checkout. Defaults to the sibling repo's
 * built entry. If it isn't there, connectRealPayments degrades to the
 * fail-closed dry-run — the swarm dry-run never crashes on a missing MCP.
 */
const PAYMENTS_MCP_PATH =
  process.env.PAYMENTS_MCP_PATH ??
  resolve(process.cwd(), '..', 'payment-intelligence-system', 'mcp', 'dist', 'index.js');

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

/**
 * Show the benevolence charter as a second, independent read on the same actions
 * (Blessing Protocol §13). The charter can raise a gate and never lower one.
 */
function demoCharter(): void {
  out('───────────────────────────────────────────────────────────────');
  out('  BENEVOLENCE CHARTER (checkCharter() — the second, independent read)');
  out('───────────────────────────────────────────────────────────────');
  out(`  ${BENEVOLENCE_CHARTER.protocol} · ${BENEVOLENCE_CHARTER.version} — six non-waivable clauses:`);
  BENEVOLENCE_CHARTER.clauses.forEach((c, i) => out(`    ${i + 1}. [${c.id}] ${c.text}`));
  out('');
  out('  The charter may only RAISE a gate, never lower one. Clauses 3/4/6 are');
  out('  ledger defects — they refuse outright, because no approval tier makes');
  out('  uncredited work credited or an unbacked claim backed.');

  const samples: Array<{ label: string; a: Action | null; ctx: CharterContext }> = [
    { label: 'Quantified in-cap payment — left to the spend-cap ladder', a: action('payments', { kind: 'payment', movesMoney: true, amount: 40, cap: 100 }), ctx: {} },
    { label: 'Charge with no quantified cap — "how much?" has no answer yet', a: action('payments', { kind: 'payment', movesMoney: true }), ctx: {} },
    { label: 'A null proposal reaches the gate', a: null, ctx: {} },
    { label: 'Draft, but an instrument in use has attribution owed', a: action('content', { kind: 'draft' }), ctx: { attributionOwed: ['mind-palace-agent-skills'] } },
    { label: 'Scheduled post asserting a capability nothing backs', a: action('content', { kind: 'schedule-post' }), ctx: { claims: [{ statement: 'Fully autonomous revenue', backedBy: [] }] } },
  ];

  for (const { label, a, ctx } of samples) {
    const v = checkCharter(a, ctx);
    const base = a ? classify(a).decision : 'human-gate';
    out('');
    out(`  ▸ ${label}`);
    out(`      classify  : ${base}`);
    out(`      effective : ${v.refused ? 'REFUSED (no gate clears it)' : raiseTo(base, v.floor)}`);
    for (const line of explain(v).split('\n')) out(`      ${line}`);
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

/**
 * Connect the REAL Payments MCP adapter (verify-only) and run ONE in-cap
 * round-trip through it. This is the v0.2 addition: a real MCP client, spawned
 * over stdio against the built payment-intelligence-system server — still
 * verify-only, still fail-closed, still moving NO money. If the server isn't
 * built, the adapter degrades to the fail-closed dry-run and we say so.
 */
async function demoRealPaymentsMcp(): Promise<void> {
  out('───────────────────────────────────────────────────────────────');
  out('  REAL PAYMENTS-MCP ADAPTER (v0.2 — verify-only, fail-closed)');
  out('───────────────────────────────────────────────────────────────');
  out(`  server: ${PAYMENTS_MCP_PATH}`);

  const { payments, close } = await connectRealPayments({ serverPath: PAYMENTS_MCP_PATH }, out);
  try {
    // A within-cap proposal. The real server verifies the (dev) mandate + caps.
    // Either way no money moves — the server has no transfer tool.
    const verify = await payments.verify_mandate({ signature: 'dev', amount: 40, purpose: 'swarm dry-run charge' });
    out(`    • verify_mandate  → valid=${verify.valid}  (${verify.reason})`);
    const cap = await payments.check_spend_cap('payments', 40);
    out(`    • check_spend_cap → withinCap=${cap.withinCap}  cap=${cap.cap}`);
    out('    (verify-only: a dry-run mandate is not validly signed → fail-closed reject is correct)');
  } finally {
    await close();
  }
  out('');
}

async function main(): Promise<void> {
  printTree();
  demoEscalationLadder();
  demoCharter();
  await runLoopSteps();
  await demoRealPaymentsMcp();

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
