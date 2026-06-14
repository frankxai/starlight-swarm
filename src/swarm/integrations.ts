/**
 * integrations.ts — typed integration points for the MCP servers the runtime
 * consumes. These are INTERFACES / STUBS only (v0.1).
 *
 * The runtime references but does NOT hard-require these at runtime. Real wiring
 * lands in a later version. Per agentic-ops-hub/docs/MCP-STRATEGY.md, the income
 * swarm's MCP stack is:  SIS Vault · Payments (verify only) · claude-flow · Slack.
 *
 * Nothing here executes a real call, moves money, or writes to a real vault.
 */

/* ------------------------------------------------------------------ *
 * SIS Vault MCP (Starlight-Intelligence-System) — sis_* tools.
 * Memory substrate + attestation. Workers get append-only; queens rw.
 * ------------------------------------------------------------------ */

export interface VaultEntry {
  agent: string;
  stream: string;
  task: string;
  note: string;
  timestamp: string;
}

/** Subset of the sis_* tool surface this runtime touches. */
export interface SisVaultMcp {
  /** sis_append_entry — append-only memory write (worker-safe). */
  sis_append_entry(entry: VaultEntry): Promise<{ ok: true; id: string }>;
  /** sis_vault_search — read prior context. */
  sis_vault_search(query: string): Promise<VaultEntry[]>;
  /** sis_confirm — strengthen a prior pattern (queen rw). */
  sis_confirm(id: string): Promise<{ ok: true }>;
}

/* ------------------------------------------------------------------ *
 * Payments MCP (payment-intelligence-system/mcp) — VERIFY ONLY.
 * Control surface for money. Fail-closed: reject on ambiguity.
 * ⚠️ v0.1 scaffold, unaudited, not for live funds. NO "transfer" tool exists.
 * ------------------------------------------------------------------ */

export interface MandateProof {
  /** AP2 cryptographically signed mandate (opaque here). */
  signature: string;
  amount: number;
  purpose: string;
}

export interface PaymentsMcp {
  /** verify_mandate — was THIS purchase for THIS amount authorized? */
  verify_mandate(proof: MandateProof): Promise<{ valid: boolean; reason: string }>;
  /** check_spend_cap — per-transaction / per-day / per-stream. */
  check_spend_cap(stream: string, amount: number): Promise<{ withinCap: boolean; cap: number }>;
  /** record_audit_entry — every settlement writes to L1 audit first. */
  record_audit_entry(entry: VaultEntry): Promise<{ ok: true }>;
  /** require_human_approval — hand off to the L7 human gate. */
  require_human_approval(reason: string): Promise<{ pending: true }>;
}

/* ------------------------------------------------------------------ *
 * Dry-run stubs. These print intent and return safe placeholders.
 * They demonstrate the integration shape WITHOUT firing real actions.
 * ------------------------------------------------------------------ */

export function makeDryRunVault(log: (m: string) => void): SisVaultMcp {
  return {
    async sis_append_entry(entry) {
      log(`  ↳ [dry-run] sis_append_entry  ${entry.agent} :: ${entry.task}`);
      return { ok: true, id: 'dry-run-entry' };
    },
    async sis_vault_search(query) {
      log(`  ↳ [dry-run] sis_vault_search  "${query}"`);
      return [];
    },
    async sis_confirm(id) {
      log(`  ↳ [dry-run] sis_confirm  ${id}`);
      return { ok: true };
    },
  };
}

export function makeDryRunPayments(log: (m: string) => void): PaymentsMcp {
  return {
    async verify_mandate(proof) {
      log(`  ↳ [dry-run] payments.verify_mandate  amount=${proof.amount} purpose="${proof.purpose}"`);
      // Fail-closed posture: a dry-run never asserts a valid mandate.
      return { valid: false, reason: 'dry-run: no live mandate verification (verify-only scaffold)' };
    },
    async check_spend_cap(stream, amount) {
      log(`  ↳ [dry-run] payments.check_spend_cap  stream=${stream} amount=${amount}`);
      return { withinCap: false, cap: 0 };
    },
    async record_audit_entry(entry) {
      log(`  ↳ [dry-run] payments.record_audit_entry  ${entry.agent} :: ${entry.task}`);
      return { ok: true };
    },
    async require_human_approval(reason) {
      log(`  ↳ [dry-run] payments.require_human_approval  "${reason}"`);
      return { pending: true };
    },
  };
}
