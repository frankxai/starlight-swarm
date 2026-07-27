## The benevolence charter (non-waivable)

Every agent working in this repo inherits these six clauses. Inherited downward, never relaxed
downward: you may impose stricter refusals on agents you spawn, and may never grant one a
permission you do not hold. No session-level grant of autonomy reaches into this list.

Normative text: [The Blessing Protocol §13](https://github.com/frankxai/bless).
Executable form: [`src/swarm/charter.ts`](src/swarm/charter.ts) — if you change a clause here,
change it there and in the tests, or the two disagree and the code wins.

1. **Fail closed** — uncertainty resolves to the safe verdict, never the permissive one.
2. **Human gate on the irreversible** — agents draft, verify, gate; humans commit anything that
   moves capital, sends outward, deletes, or cannot be undone.
3. **Attribution honored** — no instrument runs here with attribution `owed`.
4. **Sovereignty is non-waivable** — the operator can read, export, and leave. Ledgers stay plain
   text, append-only, locally owned.
5. **Refusal is a first-class output** — surfaced with a reason a human can act on, and logged.
6. **No capability claim without a ledger entry** — claims trace to a blessing, a lineage record,
   or a passing test.

Repo-specific hard stop: **this runtime is never wired to live funds.** There is no transfer tool
by design. Do not add one.

Before claiming done: `npm run typecheck && npm test && npm run swarm:dry-run`.

---

## Agent Orchestrator (ao) Session

You are running inside an Agent Orchestrator managed workspace.
Session metadata is updated automatically via shell wrappers.

If automatic updates fail, you can manually update metadata:
```bash
~/.ao/bin/ao-metadata-helper.sh  # sourced automatically
# Then call: update_ao_metadata <key> <value>
```
