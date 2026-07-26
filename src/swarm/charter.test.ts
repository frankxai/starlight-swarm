/**
 * charter.test.ts — unit tests for the benevolence charter gate.
 *
 * Run:  node --test --import tsx src/swarm/charter.test.ts
 *
 * The charter (Blessing Protocol §13) is the second, independent read on every
 * proposed action. These tests lock four properties, in order of how badly a
 * regression in each would hurt:
 *
 *   1. MONOTONICITY — the charter can only RAISE a gate, never lower one. This
 *      is the whole safety argument for wiring it in at all. Asserted across the
 *      full action matrix, not just a happy path.
 *   2. FAIL-CLOSED — a null action, or one with undeclared safety fields, floors
 *      at human-gate. Doubt never resolves toward action.
 *   3. LEDGER REFUSALS — owed attribution, lost sovereignty, and unbacked claims
 *      refuse outright, at any tier.
 *   4. ACTIONABILITY — every breach carries a non-empty reason AND remedy, which
 *      is clause 5 ("refusal is a first-class output") enforced structurally.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BENEVOLENCE_CHARTER, checkCharter, explain, raiseTo } from './charter';
import type { CharterContext } from './charter';
import { classify } from './escalation';
import type { Action, ActionKind, Decision, StreamId } from './escalation';

const SEVERITY: Decision[] = ['autonomous', 'queen-gate', 'founder-board', 'human-gate'];
const rank = (d: Decision) => SEVERITY.indexOf(d);

/** Build an action with reversible / no-money defaults (mirrors escalation.test.ts). */
function action(stream: StreamId, partial: Partial<Action> & Pick<Action, 'kind'>): Action {
  return { stream, irreversible: false, movesMoney: false, crossStream: false, ...partial };
}

const ALL_KINDS: ActionKind[] = [
  'research', 'draft', 'bind-link', 'schedule-post', 'build-page', 'payment',
  'new-rail', 'new-vendor', 'spend', 'delete', 'rename-url', 'rotate-key',
  'send-blast', 'move-funds',
];
const ALL_STREAMS: StreamId[] = ['affiliate', 'products', 'content', 'payments'];

// ── 1. Monotonicity — the load-bearing property ─────────────────────────────

/** Quantified and unquantified money variants — the charter differs on the second. */
const MONEY_SHAPES: Array<Partial<Action>> = [{ amount: 10, cap: 100 }, {}];

test('MONOTONICITY: the charter never lowers a gate, across the full action matrix', () => {
  let raisedSomewhere = false;
  for (const kind of ALL_KINDS) {
    for (const stream of ALL_STREAMS) {
      for (const irreversible of [false, true]) {
        for (const movesMoney of [false, true]) {
          for (const crossStream of [false, true]) {
            for (const money of MONEY_SHAPES) {
              const a = action(stream, { kind, irreversible, movesMoney, crossStream, ...money });
              const base = classify(a).decision;
              const effective = raiseTo(base, checkCharter(a).floor);
              assert.ok(
                rank(effective) >= rank(base),
                `charter lowered the gate for ${stream}/${kind} (${base} → ${effective})`,
              );
              if (rank(effective) > rank(base)) raisedSomewhere = true;
            }
          }
        }
      }
    }
  }
  // Guard against a vacuous pass: if the charter never raised anything anywhere,
  // the property above would hold trivially and prove nothing.
  assert.ok(raisedSomewhere, 'charter never raised any gate — the monotonicity test would be vacuous');
});

test('AGREEMENT: on quantified actions the two spines never disagree', () => {
  // A reassuring property, and a canary. classify() and checkCharter() are written
  // independently; if a future edit to either makes them diverge on a quantified
  // action, that divergence shows up here rather than in production behaviour.
  for (const kind of ALL_KINDS) {
    for (const irreversible of [false, true]) {
      for (const crossStream of [false, true]) {
        const a = action('payments', { kind, irreversible, movesMoney: true, crossStream, amount: 10, cap: 100 });
        const base = classify(a).decision;
        assert.equal(
          raiseTo(base, checkCharter(a).floor),
          base,
          `spines diverged on a quantified ${kind} (irreversible=${irreversible})`,
        );
      }
    }
  }
});

test('raiseTo() takes the harder of the two tiers, in both argument orders', () => {
  assert.equal(raiseTo('autonomous', 'human-gate'), 'human-gate');
  assert.equal(raiseTo('human-gate', 'autonomous'), 'human-gate');
  assert.equal(raiseTo('queen-gate', 'founder-board'), 'founder-board');
  assert.equal(raiseTo('founder-board', 'queen-gate'), 'founder-board');
  assert.equal(raiseTo('queen-gate', null), 'queen-gate', 'a null floor must not change the base');
});

test('raiseTo() treats an unrecognised floor as maximally severe (fail-closed)', () => {
  // A future Decision member that this module has not been taught about must not
  // silently rank as 'autonomous' and permit an action.
  assert.equal(raiseTo('autonomous', 'not-a-real-tier' as unknown as Decision), 'not-a-real-tier');
});

// ── 2. Fail-closed ──────────────────────────────────────────────────────────

test('null action → fail-closed breach, floored at human-gate', () => {
  const v = checkCharter(null);
  assert.equal(v.conforms, false);
  assert.equal(v.floor, 'human-gate');
  assert.ok(v.breaches.some((b) => b.clause === 'fail-closed'));
});

test('undefined action → fail-closed breach, floored at human-gate', () => {
  assert.equal(checkCharter(undefined).floor, 'human-gate');
});

test('undeclared safety field → fail-closed breach naming the field', () => {
  const a = { kind: 'draft', stream: 'content', crossStream: false } as unknown as Action;
  const v = checkCharter(a);
  const breach = v.breaches.find((b) => b.clause === 'fail-closed');
  assert.ok(breach, 'expected a fail-closed breach for undeclared booleans');
  assert.match(breach.reason, /irreversible/);
  assert.match(breach.reason, /movesMoney/);
  assert.equal(v.floor, 'human-gate');
});

test('a truthy non-boolean does NOT satisfy a safety field', () => {
  // 'false' as a string is truthy — the exact bug a `!action.irreversible` check
  // would wave through. Only a real boolean counts as declared.
  const a = { kind: 'draft', stream: 'content', irreversible: 'false', movesMoney: false, crossStream: false } as unknown as Action;
  assert.equal(checkCharter(a).floor, 'human-gate');
});

// ── 3. Clause 2 — human gate on the irreversible ────────────────────────────

test('irreversible action → human-gate floor (independent of classify)', () => {
  const v = checkCharter(action('content', { kind: 'draft', irreversible: true }));
  assert.equal(v.floor, 'human-gate');
  assert.ok(v.breaches.some((b) => b.clause === 'human-gate'));
});

test('every commit-class kind floors at human-gate, even with flags cleared', () => {
  // Defense in depth: a proposal claiming to be reversible while naming a kind
  // that commits is still floored. The flags are a claim; the kind is a fact.
  for (const kind of ['move-funds', 'delete', 'rename-url', 'rotate-key', 'send-blast'] as ActionKind[]) {
    const v = checkCharter(action('payments', { kind }));
    assert.equal(v.floor, 'human-gate', `${kind} must floor at human-gate`);
  }
});

test('SCOPE: a quantified in-cap payment is left to the spend-cap ladder', () => {
  // Clause 2 is about *committing*, not about touching money. This repo lets the
  // Payments Queen authorize an in-cap charge behind verify + cap + audit, and
  // there is no transfer tool to settle with. If the charter floored this at
  // human-gate it would silently delete the cap ladder rather than enforce it.
  const v = checkCharter(action('payments', { kind: 'payment', movesMoney: true, amount: 40, cap: 100 }));
  assert.equal(v.conforms, true);
  assert.equal(v.floor, null);
});

test('money with no quantified amount/cap floors at human-gate (fail-closed)', () => {
  // The hole the cap ladder alone leaves: it fails an unquantified charge closed
  // to founder-board. "How much?" having no answer deserves one tier more.
  assert.equal(checkCharter(action('payments', { kind: 'payment', movesMoney: true })).floor, 'human-gate');
  assert.equal(
    checkCharter(action('payments', { kind: 'payment', movesMoney: true, amount: 40 })).floor,
    'human-gate',
    'an amount with no cap is still unquantified risk',
  );
  assert.equal(
    checkCharter(action('payments', { kind: 'payment', movesMoney: true, amount: Number.NaN, cap: 100 })).floor,
    'human-gate',
    'NaN must not slip past a naive comparison',
  );
});

test('an ordinary reversible in-stream draft conforms', () => {
  const v = checkCharter(action('content', { kind: 'draft' }));
  assert.equal(v.conforms, true);
  assert.equal(v.refused, false);
  assert.equal(v.floor, null);
  assert.equal(explain(v), 'CHARTER OK — all six clauses hold.');
});

// ── 4. Ledger clauses — refuse outright ─────────────────────────────────────

test('clause 3: attribution owed refuses, and no gate clears it', () => {
  const ctx: CharterContext = { attributionOwed: ['mind-palace-agent-skills'] };
  const v = checkCharter(action('content', { kind: 'draft' }), ctx);
  assert.equal(v.refused, true);
  const breach = v.breaches.find((b) => b.clause === 'attribution');
  assert.ok(breach, 'expected an attribution breach');
  assert.equal(breach.disposition, 'refuse');
  assert.match(breach.reason, /mind-palace-agent-skills/);
  // Refusal is about the ledger, not the tier: even a harmless action is refused.
  assert.equal(v.floor, null, 'attribution refusal raises no floor — it blocks outright');
});

test('clause 4: non-exportable state refuses', () => {
  const v = checkCharter(action('products', { kind: 'draft' }), { exportable: false });
  assert.equal(v.refused, true);
  assert.ok(v.breaches.some((b) => b.clause === 'sovereignty'));
});

test('clause 6: a capability claim with no ledger backing refuses', () => {
  const v = checkCharter(action('content', { kind: 'schedule-post' }), {
    claims: [{ statement: 'Fully autonomous revenue', backedBy: [] }],
  });
  assert.equal(v.refused, true);
  const breach = v.breaches.find((b) => b.clause === 'no-unbacked-claim');
  assert.ok(breach, 'expected an unbacked-claim breach');
  assert.match(breach.reason, /Fully autonomous revenue/);
});

test('clause 6: a backed claim conforms', () => {
  const v = checkCharter(action('content', { kind: 'schedule-post' }), {
    claims: [{ statement: 'Queen-gated publishing', backedBy: ['bless_1718352000_acos'] }],
  });
  assert.equal(v.conforms, true);
});

test('an omitted context asserts nothing and blocks nothing', () => {
  // Absent evidence must not be treated as evidence of absence — otherwise every
  // adopter without a lineage ledger is refused on day one and disables the gate.
  assert.equal(checkCharter(action('content', { kind: 'draft' }), {}).conforms, true);
  assert.equal(checkCharter(action('content', { kind: 'draft' }), { attributionOwed: [] }).conforms, true);
});

test('multiple breaches are all reported in one pass', () => {
  const v = checkCharter(action('payments', { kind: 'move-funds', irreversible: true, movesMoney: true }), {
    attributionOwed: ['some-skill'],
    claims: [{ statement: 'unbacked', backedBy: [] }],
    exportable: false,
  });
  const clauses = v.breaches.map((b) => b.clause).sort();
  // fail-closed fires too: the move-funds proposal carries no amount/cap.
  assert.deepEqual(clauses, ['attribution', 'fail-closed', 'human-gate', 'no-unbacked-claim', 'sovereignty']);
  assert.equal(v.refused, true);
  assert.equal(v.floor, 'human-gate');
});

// ── 5. Clause 5 — refusals must be actionable ───────────────────────────────

test('every breach carries a non-empty reason AND remedy (clause 5)', () => {
  const cases: Array<[Action | null, CharterContext]> = [
    [null, {}],
    [action('payments', { kind: 'move-funds', irreversible: true, movesMoney: true }), {}],
    [action('content', { kind: 'draft' }), { attributionOwed: ['x'] }],
    [action('content', { kind: 'draft' }), { exportable: false }],
    [action('content', { kind: 'draft' }), { claims: [{ statement: 's', backedBy: [] }] }],
  ];
  for (const [a, ctx] of cases) {
    for (const b of checkCharter(a, ctx).breaches) {
      assert.ok(b.reason.trim().length > 0, `clause ${b.clause} has an empty reason`);
      assert.ok(b.remedy.trim().length > 0, `clause ${b.clause} has an empty remedy`);
      assert.ok(!/^review/i.test(b.remedy), `clause ${b.clause} remedy must be concrete, not "review this"`);
    }
  }
});

test('explain() renders every breach with its disposition', () => {
  const text = explain(
    checkCharter(action('payments', { kind: 'move-funds' }), { attributionOwed: ['x'] }),
  );
  assert.match(text, /CHARTER REFUSE \[attribution\]/);
  assert.match(text, /CHARTER RAISE→human-gate \[human-gate\]/);
  assert.match(text, /FIX:/);
});

// ── 6. The charter itself ───────────────────────────────────────────────────

test('the charter is frozen — it cannot be relaxed at runtime (§13.2)', () => {
  assert.throws(() => {
    // @ts-expect-error — deliberately attempting the mutation the freeze prevents
    BENEVOLENCE_CHARTER.clauses = [];
  }, TypeError);
  assert.throws(() => {
    // Each clause is frozen individually, so a deep mutation throws too. The type
    // system permits this line (Clause fields are not `readonly`); the freeze is
    // what actually stops it, which is exactly why this test exists.
    BENEVOLENCE_CHARTER.clauses[0].text = '';
  }, TypeError);
});

test('all six clauses are present, unique, and non-empty', () => {
  const ids = BENEVOLENCE_CHARTER.clauses.map((c) => c.id);
  assert.equal(ids.length, 6);
  assert.equal(new Set(ids).size, 6, 'clause ids must be unique');
  for (const c of BENEVOLENCE_CHARTER.clauses) {
    assert.ok(c.text.trim().length > 0, `clause ${c.id} has empty text`);
    assert.ok(c.rationale.trim().length > 0, `clause ${c.id} has empty rationale`);
  }
});
