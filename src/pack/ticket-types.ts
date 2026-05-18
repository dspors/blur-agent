/**
 * blur-agent — ticket types (Decision 34).
 *
 * A Ticket authorizes a caller to dispatch one Turn through a specific
 * Agent. The Scheduler issues tickets in response to `requestTurn(...)`;
 * `agents.sendMessage(agentId, { ticketId })` validates and consumes the
 * ticket on dispatch. Tickets carry caller intent (`outcome`) so the
 * scheduler can do model-tier routing in v2.
 *
 * Lifecycle:
 *   issued    — minted, not yet used
 *   active    — sendMessage stamped it; Turn is in flight
 *   completed — Turn ended normally; ticket released
 *   expired   — TTL exceeded before completion; auto-released by sweep
 *   cancelled — explicit releaseTicket(ticketId, 'cancelled')
 *
 * Stored in two collections:
 *   activeByTicketId  — non-terminal tickets, hot-path
 *   historyByTicketId — terminal tickets, append-only audit trail
 *
 * v1 (Decision 34) — gate is fail-soft: sendMessage without a ticket
 *   emits `agents.send-without-ticket` and proceeds. v2 (separate
 *   Decision) tightens to fail-closed.
 */

export type TicketStatus = 'issued' | 'active' | 'completed' | 'expired' | 'cancelled';

export type TicketTerminalReason = 'completed' | 'expired' | 'cancelled';

export interface Ticket {
  /** 'tkt_<uuid>'. */
  ticketId: string;
  engagementId: string;
  agentId: string;
  /** Stamped on first sendMessage that consumes this ticket. */
  turnId?: string;
  /** Copied from the agent's provider.kind for filterable reads. */
  providerKind: string;
  /**
   * Optional model name when known. v1 records what the agent already
   * had; v2 the scheduler may pick based on `outcome` and stamp here.
   */
  model?: string;
  /**
   * Free-form caller intent label — 'risk-check' | 'code-gen' |
   * 'summary' | etc. Recorded for v2 routing intelligence.
   */
  outcome?: string;
  status: TicketStatus;
  issuedAt: string;
  /** issuedAt + TTL_MS. After this the sweep marks the ticket expired. */
  expiresAt: string;
  /** When sendMessage stamped the ticket (status: issued → active). */
  startedAt?: string;
  /** When the ticket transitioned to a terminal state. */
  endedAt?: string;
  releaseReason?: TicketTerminalReason;
  /** Caller identity (sessionId or agentId). */
  by?: string;
  /**
   * Decision 36 — snapshot of caller-supplied routing overrides at
   * issuance. v0: recorded only (routing does not consult). Allows
   * later analytics and replay to reproduce dispatch lineage from
   * Ticket records alone.
   */
  requestOverrides?: RequestOverrides;
}

/**
 * One lifecycle event for a ticket. Recorded into the per-ticket
 * history at every transition; exposed via
 * `runtime.scheduler.tickets.history(ticketId)`.
 */
export interface TicketHistoryEvent {
  at: string;
  kind: 'issued' | 'used' | 'completed' | 'expired' | 'cancelled' | 'reassigned';
  /** Free-text rationale or context. */
  detail?: string;
}

export interface TicketHistory {
  ticketId: string;
  events: TicketHistoryEvent[];
  /** Mirror of the final Ticket record for convenience. */
  ticket: Ticket;
}

// ===========================================================================
// Defaults / constants
// ===========================================================================

/** Default ticket TTL in ms (5 minutes). See Decision 34 §TTL. */
export const TICKET_TTL_MS = 5 * 60 * 1000;

/**
 * Soft cap on the per-engagement history retained in memory. Beyond
 * this, oldest terminal tickets fall off the in-memory ring; the audit
 * log still has their `agents.scheduler.ticket-issued` /
 * `ticket-released` events for replay.
 */
export const TICKET_HISTORY_CAP_PER_ENG = 100;

// ===========================================================================
// Decision 36 — routing-contract types (step 1: recorded only, not consulted)
// ===========================================================================

/**
 * Canonical reference for a (provider, model) pair. Format:
 * `<providerKind>/<model>` — e.g. `'claude/sonnet'`,
 * `'together/gpt-oss-120b'`, `'local/llama-3.1-8b'`.
 *
 * Decision 36 §Decision: this is the substrate-stable selection unit.
 * v0 records strings opaquely; v2+ parses them into a discriminated
 * union when AI-Choose / Activity-Table consultation goes live.
 */
export type ProviderModelRef = string;

/**
 * Per-Activity routing mode. See Decision 36 §Decision.
 *
 *   - 'always' → use the Table's default; never escalate.
 *   - 'auto'   → use the default unless caller flags
 *                `complexity: 'specialized'`; then AI-Choose.
 *   - 'ai'     → skip the Table; AI-Choose every time.
 */
export type RoutingMode = 'always' | 'auto' | 'ai';

/**
 * One entry in an Activity Table.
 */
export interface ActivityRouting {
  mode: RoutingMode;
  /** Default model when Mode resolves to "use the Table". */
  default: ProviderModelRef | null;
  /** Per-outcome refinements within this Activity. */
  outcomes?: Record<string, ProviderModelRef>;
}

/**
 * Activity Table — keyed by activityId. See Decision 36.
 *
 * The system Table is a configuration artifact; callers may supply a
 * partial Table on `requestTurn` to override (caller-wins per
 * Activity; system fills gaps). Step 1 (this contract) records the
 * caller-supplied Table on the Ticket; later steps will consult it.
 */
export type ActivityTable = Record<string /* activityId */, ActivityRouting>;

/**
 * Caller complexity hint for Mode=Auto. When omitted, Auto defaults
 * to 'routine' (use Activity default). When 'specialized', Auto
 * escalates to AI-Choose.
 */
export type ComplexityHint = 'routine' | 'specialized';

/**
 * Snapshot of caller-supplied routing overrides at ticket-issuance
 * time. Recorded on every Ticket so dispatch lineage is reproducible
 * from the audit log. v0: recorded only; routing does not consult.
 */
export interface RequestOverrides {
  pin?: ProviderModelRef;
  activityTable?: ActivityTable;
  complexity?: ComplexityHint;
}

// ===========================================================================
// Request / response shapes
// ===========================================================================

export interface RequestTurnOpts {
  engagementId: string;
  prompt: string;
  /**
   * Caller hint: reuse this agent if available + idle + bound to the
   * engagement. Omit to let the scheduler pick (or to require fresh).
   */
  preferredAgentId?: string;
  /**
   * Caller intent label. Recorded on the ticket; v2 may consult it for
   * model-tier routing.
   */
  outcome?: string;
  /** Caller identity. */
  by?: string;
  /**
   * Override the default TTL for this ticket (ms). Used for long-running
   * Turns that are expected to exceed the 5-min default.
   */
  ttlMs?: number;

  // -------------------------------------------------------------------------
  // Decision 36 — routing overrides (step 1: recorded only, not consulted)
  // -------------------------------------------------------------------------

  /**
   * Per-call hard pin to a specific (provider, model). Highest
   * precedence in the D36 layered policy. v0: recorded on the ticket
   * + audited; routing still uses the v0 agent-selection path.
   *
   * Example: `pin: 'together/gpt-oss-120b'` for benchmark dispatches.
   */
  pin?: ProviderModelRef;

  /**
   * Caller-supplied Activity Table. Merge rule (v1+): caller-wins per
   * Activity; system Table fills gaps. v0: recorded on the ticket +
   * audited; routing does not consult.
   *
   * Example:
   *   activityTable: {
   *     general: { mode: 'always', default: 'together/gpt-oss-120b' },
   *   }
   */
  activityTable?: ActivityTable;

  /**
   * Caller-tagged complexity hint. Used by Mode=Auto in v1+ to decide
   * whether to escalate from Activity default to AI-Choose. v0:
   * recorded only.
   */
  complexity?: ComplexityHint;
}

export interface RequestTurnResult {
  ticketId: string;
  agentId: string;
  turnId: string;
  replyHandle: string;
}

export interface ListTicketsOpts {
  engagementId?: string;
  agentId?: string;
  status?: TicketStatus | TicketStatus[];
  outcome?: string;
  /** Include terminal tickets from history. Default false (active only). */
  includeHistory?: boolean;
  limit?: number;
}
