# The Queen Charter

> How to spawn a Queen for a vertical, a business, an organization, or a team — and what she inherits that she may never relax.

This document is the spawn recipe. It composes three things that already exist and are already tested:

| Layer | What it supplies | Where |
|---|---|---|
| The escalation spine | *Who decides* — the four-tier ladder, fail-closed | [`src/swarm/escalation.ts`](../src/swarm/escalation.ts) |
| The benevolence charter | *Whether it may proceed at all* — six non-waivable clauses | [`src/swarm/charter.ts`](../src/swarm/charter.ts) |
| The witnessing cadence | *What stands, and what became whole* | [The Blessing Protocol](https://github.com/frankxai/bless) |

A Queen without all three is a task-runner with a crown.

---

## 1. What a Queen is

One Queen owns **one** domain: a revenue stream, a product line, a client engagement, a functional team. She holds a mesh of stateless single-skill workers, runs a self-improving loop over them, and decides act-vs-escalate on every proposal her workers hand up.

Three properties define the seat, and all three are enforced in code:

1. **Scoped.** A Queen never commands across domains. Cross-domain actions escalate to the founder, who coordinates. `classify()` routes `crossStream: true` to `founder-board` — there is no Queen-to-Queen channel to abuse.
2. **Gated.** Every proposal passes two independent reads: `classify()` for the tier, `checkCharter()` for conformance. They are combined with `raiseTo()`, which takes the harder of the two. The charter can tighten a verdict and can never loosen one.
3. **Witnessing.** A Queen opens her day with the standing inventory and closes her week with the blessing. Both are invoked, never auto-fired.

---

## 2. What a Queen inherits

Inheritance is **downward-only and never relaxing** (Blessing Protocol §13.2). A Queen may impose stricter refusals on the workers she spawns. She may never grant a worker a permission she does not herself hold, and no session-level grant of autonomy — however broad, however explicit — reaches into the charter. `BENEVOLENCE_CHARTER` is frozen at module scope so that "relax it at runtime" is a `TypeError` rather than a bug.

| # | Clause | What it stops in practice |
|---|---|---|
| 1 | **Fail closed** | A missing amount, an undeclared safety flag, an unreachable MCP — each takes the higher gate, never a silent pass. |
| 2 | **Human gate on the irreversible** | `move-funds`, `delete`, `rename-url`, `rotate-key`, `send-blast`. Agents prepare; humans commit. |
| 3 | **Attribution honored** | Nothing runs with credit outstanding. Refuses outright — no tier clears it. |
| 4 | **Sovereignty non-waivable** | Operator state stays readable, exportable, and leavable. |
| 5 | **Refusal is first-class** | Every refusal carries a reason and a concrete remedy, and is logged. |
| 6 | **No unbacked capability claim** | Claims trace to a blessing, a lineage record, or a passing test. |

Clauses 1, 2 and 5 are **action-shaped** — checkable from the proposal alone. Clauses 3, 4 and 6 are **ledger-shaped** — they need the operator's lineage state, supplied as `CharterContext`.

### Scope note — why clause 2 does not fire on every money action

Clause 2 says humans *commit* what moves capital. Committing is not authorizing. This repo's spend-cap ladder deliberately lets the Payments Queen authorize a quantified, in-cap charge behind mandate-verify + cap-check + audit, and there is no transfer tool anywhere in the system to settle with. If the charter floored every money-adjacent action at `human-gate`, the cap ladder would become dead code and the charter would be rewriting doctrine under the banner of enforcing it.

What the charter *does* independently assert is irreversibility, plus one hole the cap ladder alone leaves: **money moving with no quantified cap**. `overCap()` fails that closed to `founder-board`; the charter takes it one tier further, because "how much?" has no answer yet.

---

## 3. Spawning a Queen

### 3.1 Declare the domain

Add the domain to `StreamId` in [`escalation.ts`](../src/swarm/escalation.ts). This is deliberately a type-level edit rather than a config string: adding a domain should fail the typecheck everywhere a decision is made about domains, so no switch silently falls through to a permissive default.

```ts
export type StreamId = 'affiliate' | 'products' | 'content' | 'payments' | 'advisory';
```

### 3.2 Write the spec

A `StreamSpec` in [`streams.ts`](../src/swarm/streams.ts) — the Queen's seat, her loop, her worker mesh, and the MCP servers her agents may touch. Two rules for the roster:

- **One worker, one skill.** IAM L3 scoping. A worker that can do two things can be talked into a third.
- **Workers never hold the money-adjacent MCP.** Only the Queen calls it, and only its verify-only tools. A worker reports a finding; the Queen runs the tool.

```ts
{
  id: 'advisory',
  label: 'Advisory',
  purpose: 'Client engagements — scoping, delivery, retro.',
  queen: {
    name: 'Advisory Queen',
    harness: ['queen-coordinator', 'hierarchical-coordinator'],
    selfImprovingLoop: ['intake', 'scope', 'deliver', 'debrief', 'retro'],
  },
  workers: [
    { name: 'scoper',   skill: 'product-engine', does: 'turn an intake into a scoped brief' },
    { name: 'deliverer', skill: 'factory',       does: 'produce the engagement artifacts' },
    { name: 'debriefer', skill: 'research',      does: 'capture what actually happened' },
  ],
  mcp: ['SIS Vault (append-only for workers, rw for queen)', 'Slack (escalation channel)'],
}
```

### 3.3 Supply the charter context

The ledger clauses are inert without it. An **omitted context asserts nothing and blocks nothing** — that default is deliberate, so an adopter without a lineage ledger is not refused on day one and does not respond by disabling the gate. But a Queen running on borrowed instruments with an empty context is running clauses 3 and 6 switched off.

```ts
const queen = new Queen(spec, log, {
  attributionOwed: lineage.filter((l) => l.attribution === 'owed').map((l) => l.name),
  claims: publicClaims,          // each with backedBy: [blessing id | lineage id | test name]
  exportable: true,
});
```

Read `attributionOwed` from `palace/lineage.jsonl`. That is the wire between the Blessing Protocol's ledger and this runtime: an instrument you have not yet credited stops the Queen that depends on it, and the remedy is a one-line append.

### 3.4 Verify before you run

```bash
npm run typecheck
npm test            # 64 tests — escalation spine, queen tier, charter, payments adapter
npm run swarm:dry-run
```

The charter's own suite locks four properties: **monotonicity** (across the full action matrix the charter never lowers a gate — with an anti-vacuity guard so the assertion cannot pass trivially), **fail-closed**, **ledger refusals**, and **actionability** (every breach carries a non-empty reason and a remedy that is not "review this"). There is also an **agreement** test asserting the two spines never diverge on a quantified action — a canary for future edits to either.

---

## 4. The Queen's cadences

A Queen that only executes accumulates capability she never uses and instruments she never credits. Two invoked cadences fix that, and neither is a cron.

**Daily — the orientation** (Blessing Protocol §10). Before the loop proposes anything, enumerate what stands: systems running, instruments on hand with their origin, work already whole, and the human judgment no instrument supplies. Then one path the inventory can actually support. Bounded to a few minutes; it never blesses.

The failure it prevents is specific and expensive: a Queen that does not enumerate her instruments rebuilds capability she already has, and re-derives decisions already made.

**Weekly — the blessing** (Blessing Protocol §3). What became whole this week, what is load-bearing but unfinished, what to ignore for seven days, and the one highest-leverage path. Blessed work appends to the ledger; it never auto-fires and a skipped week is silent.

A Queen's instruments can themselves be blessed (`scope: instrument`) once they have done real work for seven days with attribution honored and a known licence. That is the loop closing: the ledger that gates her actions is also the ledger she witnesses.

---

## 5. Anti-patterns

| Anti-pattern | Why it fails |
|---|---|
| A Queen spanning two domains | Removes the founder from cross-domain coordination — the only place conflicts get resolved. |
| Workers holding the payments MCP | Collapses IAM L3. A worker that can verify can be induced to assert. |
| Empty `CharterContext` on a Queen running borrowed instruments | Clauses 3 and 6 silently switched off; the charter looks present and enforces nothing. |
| A charter clause "relaxed just for this run" | §13.2. If a run needs a clause off, the run is wrong, not the clause. |
| Auto-firing the cadences on a hook | Both rituals are invoked. An auto-fired witness generates work instead of orientation, and a streak mechanic turns a skipped day into debt. |
| Claiming a capability in a README with nothing behind it | Clause 6. Trimming an overclaim is always cheaper than defending one. |

---

## 6. What this does not do

No Queen in this repo moves money, publishes, or fires a real side effect. The runtime models the orchestration *contract* — typed config, a `Queen` class, two independent pure gates, and a verify-only MCP adapter. It must never be wired to live funds.

The charter does not make a system benevolent. It makes a specific set of refusals **checkable**, which is the only part of benevolence an agent can be held to. The rest is the operator's judgment, and clause 2 exists precisely because that judgment is not delegable.

---

Built on SIP · Charter: [The Blessing Protocol §13](https://github.com/frankxai/bless) · Dry-run only, no live funds
