/**
 * escalation.ts — the safety spine of the hybrid queens-per-stream model.
 *
 * Encodes the escalation contract from agentic-ops-hub/docs/AGENT-STACK.md
 * ("The escalation contract (load-bearing)") and the seven protection layers
 * from PROTECTION-LAYERS.md (L4 escalation + L5 payment governance + L7 human gate).
 *
 * THE STANDING RULE (inherited from agentic-business-os):
 *   agents draft, gate, and commit; humans deploy, post, and send.
 *   Money and irreversibility are never delegated to autonomy.
 *
 * v0.1 scaffold: classify() is a pure function. It decides *who* must approve an
 * action. It NEVER performs the action. Nothing in this module moves money,
 * publishes, or fires a real side effect.
 */

/**
 * The four decision tiers, in order of increasing gravity.
 * Maps to the "Who decides" column of the AGENT-STACK.md escalation table.
 */
export type Decision =
  | 'autonomous' //  worker → queen review, queen may act within scope/below caps
  | 'queen-gate' //  queen acts behind a brand/claims gate (@integrity-guard etc.)
  | 'founder-board' // founder + /starlight-board pressure-test (over-cap, new rail/vendor)
  | 'human-gate'; // irreversible OR money movement → human approval, always

/** The broad classes of action a swarm can take. */
export type ActionKind =
  | 'research' //  read-only intelligence gathering
  | 'draft' //  produce content/spec/audit — not yet public
  | 'bind-link' //  bind an affiliate link
  | 'schedule-post' //  schedule (not send) a post
  | 'build-page' //  build a product/landing page
  | 'payment' //  authorize/settle money
  | 'new-rail' //  add a new payment rail
  | 'new-vendor' //  sign a new vendor contract
  | 'spend' //  spend capital
  | 'delete' //  delete data
  | 'rename-url' //  rename a live URL
  | 'rotate-key' //  rotate an API key/secret
  | 'send-blast' //  send a newsletter/social blast
  | 'move-funds'; //  move funds

/** Which stream an action belongs to (queens never command across streams). */
export type StreamId = 'affiliate' | 'products' | 'content' | 'payments';

/**
 * An action proposed by a worker or queen. Caps are denominated abstractly
 * (no real currency, no real metrics) — they are the contract shape only.
 */
export interface Action {
  kind: ActionKind;
  /** Originating stream. */
  stream: StreamId;
  /** True if the action's effect cannot be undone (delete/rename/send/move). */
  irreversible: boolean;
  /** True if the action touches money (authorize or settle). */
  movesMoney: boolean;
  /** True if the action's target lives in another stream. */
  crossStream: boolean;
  /** Abstract spend amount for the action (unitless v0.1 placeholder). */
  amount?: number;
  /** The per-stream / per-transaction cap (unitless v0.1 placeholder). */
  cap?: number;
}

/** Result of classification: the required decision tier + the gates to satisfy. */
export interface Classification {
  decision: Decision;
  /** Human-readable reason, traceable to the AGENT-STACK.md contract row. */
  reason: string;
  /**
   * Ordered gates that must pass before the action proceeds. Names mirror the
   * real gates referenced in the contract (verify-only — none move money here).
   */
  gates: string[];
}

/** Actions that are always irreversible per FrankX hard-stops (L7). */
const ALWAYS_IRREVERSIBLE: ActionKind[] = ['delete', 'rename-url', 'rotate-key', 'send-blast', 'move-funds'];

/** Actions that always reach the founder/board even below any cap. */
const ALWAYS_FOUNDER: ActionKind[] = ['new-rail', 'new-vendor'];

/** Actions that must pass Payments MCP governance even if `movesMoney` is mislabeled. */
const PAYMENT_GOVERNED: ActionKind[] = ['payment', 'spend', 'move-funds'];

/**
 * classify() — the single source of truth for "who decides".
 *
 * Evaluated top-down; the FIRST matching rule wins, hardest-stop first.
 * This ordering is the safety property: irreversibility and money can never be
 * downgraded by a more permissive later rule.
 */
export function classify(action: Action): Classification {
  // Defensive guard: a null/undefined action fails closed to the highest tier.
  // Never let a missing action slip past the safety spine.
  if (!action) {
    return {
      decision: 'human-gate',
      reason: 'Invalid or missing action. Defaulting to highest safety tier (fail-closed).',
      gates: ['founder.review', 'starlight-board.pressure-test', 'human.approval'],
    };
  }

  const irreversible = action.irreversible || ALWAYS_IRREVERSIBLE.includes(action.kind);

  // L7 — irreversible OR money movement → human, always. Highest stop.
  if (irreversible || action.kind === 'move-funds') {
    const gates = requiresPaymentGovernance(action)
      ? [
          'payments-mcp.verify_mandate',
          'payments-mcp.check_spend_cap',
          'founder.review',
          'starlight-board.pressure-test',
          'human.approval',
        ]
      : ['founder.review', 'starlight-board.pressure-test', 'human.approval'];

    return {
      decision: 'human-gate',
      reason:
        'Irreversible or fund-moving action (FrankX hard-stop). Agents prepare; humans commit. ' +
        'No autonomous money movement, ever.',
      gates,
    };
  }

  // Any payment / spend / settlement → Payments MCP governance (verify-only, fail-closed).
  if (requiresPaymentGovernance(action)) {
    // Over-cap payment escalates past the queen to the founder.
    if (overCap(action)) {
      return {
        decision: 'founder-board',
        reason: 'Payment-governed action exceeds spend-cap. Over-cap spend escalates to founder + board, never auto-approve.',
        gates: [
          'payments-mcp.verify_mandate',
          'payments-mcp.check_spend_cap', // returns over-cap → escalate
          'founder.review',
          'starlight-board.pressure-test',
          'human.approval',
        ],
      };
    }
    return {
      decision: 'queen-gate',
      reason:
        'Payment-governed action within cap. Payments Queen authorizes behind AP2 mandate verify + spend-cap + audit (fail-closed).',
      gates: [
        'payments-mcp.verify_mandate',
        'payments-mcp.check_spend_cap',
        'payments-mcp.record_audit_entry',
      ],
    };
  }

  // New rail / new vendor → founder + board, regardless of amount.
  if (ALWAYS_FOUNDER.includes(action.kind)) {
    return {
      decision: 'founder-board',
      reason: 'New payment rail or vendor contract. Structural change — founder owns it, board pressure-tests it.',
      gates: ['founder.review', 'starlight-board.pressure-test', 'human.approval'],
    };
  }

  // Crossing a stream boundary forces escalation to the founder (queens never
  // command across streams — they coordinate through the founder).
  if (action.crossStream) {
    return {
      decision: 'founder-board',
      reason: 'Action crosses a stream boundary. Queens do not command across streams; the founder coordinates.',
      gates: ['founder.review'],
    };
  }

  // Queen-gated public/binding actions (brand/claims gate).
  if (action.kind === 'bind-link' || action.kind === 'schedule-post' || action.kind === 'build-page') {
    return {
      decision: 'queen-gate',
      reason: 'Binding/public action within stream. Queen gates it behind brand + claims checks.',
      gates: ['integrity-guard', 'claims-guard'],
    };
  }

  // Worker task within stream (draft, audit, research) → queen review.
  return {
    decision: 'autonomous',
    reason: 'Worker task within stream and below caps. Worker executes, queen reviews. Reversible, no money.',
    gates: ['queen.review'],
  };
}

/**
 * True when a quantified spend exceeds its declared cap.
 * Fail-closed: a missing, non-numeric, or NaN amount/cap is treated as over-cap
 * so the action is forced up the escalation ladder rather than silently passing.
 * NaN is `typeof 'number'` but `NaN > x` is always false, so it would slip past a
 * naive comparison — Number.isFinite closes that hole. Money never rides on doubt.
 */
function overCap(action: Action): boolean {
  if (!Number.isFinite(action.amount) || !Number.isFinite(action.cap)) return true;
  return (action.amount as number) > (action.cap as number);
}

/** Convenience predicate — does this action require a human in the loop? */
export function requiresHuman(action: Action): boolean {
  return classify(action).gates.includes('human.approval');
}

/** True when an action must be checked by the verify-only Payments MCP gate. */
export function requiresPaymentGovernance(action: Action): boolean {
  if (!action) return false;
  return PAYMENT_GOVERNED.includes(action.kind) || action.movesMoney;
}
