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
  /**
   * record_audit_entry — every settlement writes to L1 audit first.
   * Audit-first: a failed write (`ok:false`) must fail the action, so the
   * verdict is `boolean`, not the literal `true` — fail-closed needs the false case.
   */
  record_audit_entry(entry: VaultEntry): Promise<{ ok: boolean }>;
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

/* ------------------------------------------------------------------ *
 * Real Payments-MCP adapter (v0.2).
 *
 * The payment-intelligence-system ships a real stdio MCP server
 * (`@frankx-ai/payments-mcp`) exposing four VERIFY-ONLY tools:
 *   verify_mandate · check_spend_cap · record_audit_entry · require_human_approval
 *
 * Its tool surface is richer than this runtime's simplified `PaymentsMcp`
 * interface (full AP2 mandate + charge + caps shapes vs. amount/purpose). This
 * adapter bridges the two: it speaks the real MCP protocol over stdio but
 * presents the same `PaymentsMcp` shape the Queen already consumes.
 *
 * Still verify-only. Still fail-closed. Still moves NO money — the server has no
 * transfer tool, and this adapter never invents one. If the server isn't built
 * or can't be reached, the adapter degrades to the fail-closed dry-run rather
 * than crashing the runtime (a connection failure must never read as "approved").
 * ------------------------------------------------------------------ */

/**
 * The minimal MCP client surface this adapter needs. Lets unit tests inject a
 * MOCK transport-free client without spawning a real subprocess, and lets the
 * real path depend only on what it uses.
 */
export interface PaymentsMcpClient {
  callTool(args: {
    name: string;
    arguments: Record<string, unknown>;
  }): Promise<{ structuredContent?: Record<string, unknown>; isError?: boolean }>;
  close?(): Promise<void>;
}

/** Config for the real (stdio-spawned) Payments MCP server. */
export interface RealPaymentsConfig {
  /** Path to the built server entry (e.g. payment-intelligence-system/mcp/dist/index.js). */
  serverPath: string;
  /** node binary to spawn the server with. Defaults to process.execPath. */
  command?: string;
  /** Per-call caps handed to check_spend_cap. Sane fail-closed defaults. */
  caps?: { perTransaction: number; perDay: number; perStream: number };
  /** Stable currency for the dry-run charge shape. */
  currency?: string;
}

const DEFAULT_CAPS = { perTransaction: 100, perDay: 1000, perStream: 5000 };

/**
 * Wrap a connected MCP client in the runtime's `PaymentsMcp` interface.
 *
 * Exposed separately from the spawn path so unit tests can pass a mock client.
 * Every method is fail-closed: a missing/garbled structured result, an MCP-level
 * error, or a thrown transport error resolves to the SAFE verdict (invalid /
 * over-cap / not-recorded / pending), never to a pass.
 */
export function paymentsMcpFromClient(
  client: PaymentsMcpClient,
  cfg: { caps?: RealPaymentsConfig['caps']; currency?: string } = {},
): PaymentsMcp {
  const caps = cfg.caps ?? DEFAULT_CAPS;
  const currency = cfg.currency ?? 'EUR';
  // A synthetic mandate id keeps the charge/mandate ids matched for the
  // verify-only round-trip. No real money rides on it.
  const mandateId = 'swarm-dry-run';

  return {
    async verify_mandate(proof) {
      try {
        const res = await client.callTool({
          name: 'verify_mandate',
          arguments: {
            mandate: {
              mandateId,
              subject: proof.purpose || 'swarm',
              amount: proof.amount,
              currency,
              expiresAt: Date.now() + 60 * 60 * 1000,
              issuerKeyId: 'swarm-dev',
              signature: proof.signature || 'unsigned',
            },
            charge: { mandateId, amount: proof.amount, currency, stream: 'payments' },
          },
        });
        const verdict = res.structuredContent?.verdict;
        const reason = String(res.structuredContent?.reason ?? 'no reason returned');
        return { valid: !res.isError && verdict === 'verified', reason };
      } catch (err) {
        // Fail-closed: a transport error is never a valid mandate.
        return { valid: false, reason: `payments-mcp unreachable (fail-closed): ${(err as Error).message}` };
      }
    },

    async check_spend_cap(stream, amount) {
      try {
        const res = await client.callTool({
          name: 'check_spend_cap',
          arguments: {
            charge: { mandateId, amount, currency, stream },
            caps,
          },
        });
        const verdict = res.structuredContent?.verdict;
        return { withinCap: !res.isError && verdict === 'within-cap', cap: caps.perTransaction };
      } catch {
        // Fail-closed: unknown cap state is treated as over-cap.
        return { withinCap: false, cap: caps.perTransaction };
      }
    },

    async record_audit_entry(entry) {
      try {
        const res = await client.callTool({
          name: 'record_audit_entry',
          arguments: { action: entry.task, actor: entry.agent, reason: entry.note },
        });
        // Audit-first: a failed write must fail the action.
        return { ok: !res.isError && res.structuredContent?.recorded === true };
      } catch {
        return { ok: false };
      }
    },

    async require_human_approval(reason) {
      // The server's require_human_approval needs a charge; we only have a reason
      // at this layer, so we record the escalation intent and always return
      // pending — escalation must never resolve to "approved" here.
      try {
        await client.callTool({
          name: 'record_audit_entry',
          arguments: { action: 'require_human_approval', reason, verdict: 'escalate' },
        });
      } catch {
        // Even if the audit note fails, the escalation still stands as pending.
      }
      return { pending: true };
    },
  };
}

/**
 * Spawn the real Payments MCP server over stdio and return a connected
 * `PaymentsMcp` adapter. Degrades cleanly: if the SDK can't load, the server
 * path is missing, or the connection fails, it logs and falls back to the
 * fail-closed dry-run adapter — the swarm dry-run never crashes on a missing MCP.
 *
 * Returns `{ payments, close }`. Call `close()` to tear down the subprocess.
 */
export async function connectRealPayments(
  cfg: RealPaymentsConfig,
  log: (m: string) => void = () => {},
): Promise<{ payments: PaymentsMcp; close: () => Promise<void> }> {
  try {
    const { existsSync } = await import('node:fs');
    if (!existsSync(cfg.serverPath)) {
      log(`  ↳ [payments-mcp] server not built at ${cfg.serverPath} — falling back to fail-closed dry-run`);
      return { payments: makeDryRunPayments(log), close: async () => {} };
    }

    // Dynamic import keeps the SDK off the hot path of the pure dry-run, and lets
    // the fallback engage if the dependency is absent.
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');

    const transport = new StdioClientTransport({
      command: cfg.command ?? process.execPath,
      args: [cfg.serverPath],
    });
    const client = new Client({ name: 'starlight-swarm', version: '0.2.0' }, { capabilities: {} });
    await client.connect(transport);
    log(`  ↳ [payments-mcp] connected (verify-only, fail-closed) via ${cfg.serverPath}`);

    const adapter: PaymentsMcpClient = {
      callTool: (args) => client.callTool(args) as ReturnType<PaymentsMcpClient['callTool']>,
      close: () => client.close(),
    };
    return {
      payments: paymentsMcpFromClient(adapter, { caps: cfg.caps, currency: cfg.currency }),
      close: () => client.close(),
    };
  } catch (err) {
    // Never crash the runtime on a wiring failure — degrade to fail-closed.
    log(`  ↳ [payments-mcp] connect failed (${(err as Error).message}) — falling back to fail-closed dry-run`);
    return { payments: makeDryRunPayments(log), close: async () => {} };
  }
}
