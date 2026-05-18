/**
 * SchedulerSubsystem — central work queue and dispatcher.
 *
 * Mounted at `runtime.scheduler`. Three responsibilities:
 *
 *   1. **Queue** — WorkItem records, persistable, with priority
 *      ordering and lifecycle (queued → assigned → running →
 *      completed/failed/cancelled).
 *
 *   2. **String algorithm** — pick an idle agent for a queued item.
 *      v0: priority desc, then submittedAt asc; honor preferredAgentId
 *      when idle + eligible; else LRU among eligible idle agents.
 *      Pluggable: callers can swap the algorithm via `setAlgorithm`.
 *
 *   3. **Routing policy** — kind → preferred provider table.
 *      Consulted by the algorithm when no preferredAgentId is set
 *      AND no preferredProviderKind is supplied on the WorkItem.
 *
 * Tick behavior: when `start()` is called, a tick runs every
 * `SCHEDULER_TICK_MS` (default 5s). The tick scans queued items and
 * attempts assignment. Event-driven assignment also happens on
 * `submit()` (immediate attempt before the next tick).
 *
 * Resourcing the algorithm needs:
 *   - AgentsSubsystem.list({ status: 'active' }) — candidate pool
 *   - Internal busy-set — which agents are currently assigned to
 *     running WorkItems
 *
 * Assignment is communicated via audit emit (`agents.scheduler.work-
 * assigned`); consumers subscribe to act on assignments. The Scheduler
 * does NOT run the work itself — it only decides who.
 *
 * Audit emit:
 *   agents.scheduler.work-submitted
 *   agents.scheduler.work-assigned     — { workItemId, agentId, reason }
 *   agents.scheduler.work-started      — consumer reports work is running
 *   agents.scheduler.work-completed
 *   agents.scheduler.work-failed
 *   agents.scheduler.work-cancelled
 *   agents.scheduler.routing-policy-set
 */

import { randomUUID } from 'crypto';
import type { BlurAIRuntime, Persistable } from 'blur-ai-runtime';
import type { Agent } from './types';
import type { AgentsSubsystem } from './agents-subsystem';
import type {
  AssignmentResult,
  ListWorkItemsOpts,
  RoutingPolicyEntry,
  SetRoutingPolicyOpts,
  SubmitWorkItemOpts,
  WorkItem,
  WorkItemStatus,
} from './scheduler-types';
import {
  TICKET_TTL_MS,
  TICKET_HISTORY_CAP_PER_ENG,
  type ListTicketsOpts,
  type RequestOverrides,
  type RequestTurnOpts,
  type RequestTurnResult,
  type Ticket,
  type TicketHistory,
  type TicketHistoryEvent,
  type TicketTerminalReason,
} from './ticket-types';

interface Snapshot {
  schemaVersion: number;
  workItems: WorkItem[];
  routingPolicy: RoutingPolicyEntry[];
  // Decision 34 — only active tickets are persisted; history is rebuilt
  // from audit on restart (or lost on fresh boots, by design — terminal
  // tickets are read-only artifacts that don't drive behavior).
  activeTickets?: Ticket[];
}

const SCHEMA_VERSION = 1;
const SCHEDULER_TICK_MS = 5_000;

/**
 * Algorithm interface. Returns the agentId to assign + reason, or null
 * if no eligible candidate is currently idle.
 */
export interface SchedulerAlgorithm {
  pickAgent(
    workItem: WorkItem,
    candidates: Agent[],
    busyAgentIds: Set<string>,
    routingPolicy: ReadonlyMap<string, RoutingPolicyEntry>,
  ): { agentId: string; reason: string } | null;
}

export class SchedulerSubsystem implements Persistable {
  private workItems = new Map<string, WorkItem>();
  private routingPolicy = new Map<string, RoutingPolicyEntry>();
  /**
   * Decision 31 Phase A — self-tracked dirty flag. Set true on every
   * state-mutating call (incl. the private tryAssign which mutates
   * item status from the tick timer); `consumeDirty()` returns + resets.
   */
  private _dirty = false;

  /**
   * Backref to AgentsSubsystem — set by the pack install. Needed so the
   * tick can query candidate agents.
   */
  agentsRef: AgentsSubsystem | null = null;

  private tickTimer: NodeJS.Timeout | null = null;
  private algorithm: SchedulerAlgorithm = defaultAlgorithm();

  /** LRU tracking: agentId → last assignment timestamp (ms). */
  private lastAssignedAtByAgent = new Map<string, number>();

  // -------------------------------------------------------------------
  // Decision 34 — ticket store
  // -------------------------------------------------------------------
  /** Active tickets keyed by ticketId (issued | active). */
  private activeByTicketId = new Map<string, Ticket>();
  /**
   * Terminal tickets keyed by ticketId. Capped per-engagement; ring
   * eviction on overflow. Persisted only for active tickets — history
   * is in-memory only.
   */
  private historyByTicketId = new Map<string, Ticket>();
  /** Per-ticket lifecycle event log. Same retention as historyByTicketId. */
  private historyEventsByTicketId = new Map<string, TicketHistoryEvent[]>();
  /** Per-engagement FIFO of historical ticket ids for ring eviction. */
  private historyTicketIdsByEngagement = new Map<string, string[]>();

  private auditUnsubs: Array<() => void> = [];

  constructor(public readonly runtime: BlurAIRuntime) {}

  // ===================================================================
  // Lifecycle
  // ===================================================================

  start(): void {
    if (this.tickTimer) return;
    this.tickTimer = setInterval(() => this.tick(), SCHEDULER_TICK_MS);
    if (typeof this.tickTimer.unref === 'function') this.tickTimer.unref();

    // Decision 34 — subscribe to Turn lifecycle so tickets auto-release
    // on turn completion / error. Sweep handles TTL-expiry separately.
    const audit = (this.runtime as { audit?: { subscribe?: (p: string, h: (e: unknown) => void) => () => void } }).audit;
    if (audit?.subscribe) {
      this.auditUnsubs.push(
        audit.subscribe('agents.turn.completed', (e) => this.onTurnTerminal(e, 'completed')),
      );
      this.auditUnsubs.push(
        audit.subscribe('agents.turn.errored', (e) => this.onTurnTerminal(e, 'cancelled')),
      );
    }
  }

  stop(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    for (const u of this.auditUnsubs) {
      try { u(); } catch { /* swallow */ }
    }
    this.auditUnsubs = [];
  }

  setAlgorithm(algorithm: SchedulerAlgorithm): void {
    this.algorithm = algorithm;
  }

  /** Read-only access to the current algorithm (used by the AI wrapper). */
  getAlgorithm(): SchedulerAlgorithm {
    return this.algorithm;
  }

  /**
   * Convenience: wrap the current algorithm in an AI-augmented version
   * that consults a leased Scheduler agent for review of each decision.
   * Observation-only — never overrides the deterministic decision.
   *
   * Requires the agents subsystem to be wired (it is, by pack install).
   * Pass `disable: true` to revert to the base algorithm; this restores
   * a fresh `defaultAlgorithm()` unless you previously stashed your own.
   *
   * See ai-scheduler.ts for the full design rationale and v1+ direction.
   */
  useAIOptimizer(
    opts?: import('./ai-scheduler').AIAlgorithmOpts & { disable?: boolean },
  ): SchedulerAlgorithm {
    if (opts?.disable) {
      this.algorithm = defaultAlgorithm();
      return this.algorithm;
    }
    if (!this.agentsRef) {
      throw new Error('scheduler.useAIOptimizer: agentsRef not wired');
    }
    // Lazy import — avoid a hard dependency from the subsystem on the
    // wrapper module so tree-shakers can drop it when unused.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { aiSchedulerAlgorithm } = require('./ai-scheduler') as typeof import('./ai-scheduler');
    this.algorithm = aiSchedulerAlgorithm(this.algorithm, this.agentsRef, this.runtime, opts);
    return this.algorithm;
  }

  // ===================================================================
  // Submit
  // ===================================================================

  submit(opts: SubmitWorkItemOpts): WorkItem {
    if (!opts || !opts.workRef || typeof opts.workRef.kind !== 'string' || typeof opts.workRef.ref !== 'string') {
      throw new Error('scheduler.submit: workRef.kind + workRef.ref required');
    }
    if (typeof opts.submittedBy !== 'string' || !opts.submittedBy) {
      throw new Error('scheduler.submit: submittedBy required');
    }
    const id = `wi_${randomUUID()}`;
    const now = new Date().toISOString();
    const item: WorkItem = {
      id,
      workRef: { ...opts.workRef },
      priority: typeof opts.priority === 'number' ? opts.priority : 50,
      submittedAt: now,
      submittedBy: opts.submittedBy,
      preferredAgentId: opts.preferredAgentId,
      preferredProviderKind: opts.preferredProviderKind,
      requiredRole: opts.requiredRole,
      requiredCapabilities: opts.requiredCapabilities ? { ...opts.requiredCapabilities } : undefined,
      contextScope: opts.contextScope ? { ...opts.contextScope } : undefined,
      status: 'queued',
    };
    this.workItems.set(id, item);
    this._dirty = true;
    this.emit('agents.scheduler.work-submitted', `item:agents.scheduler.workItems[${id}]`, {
      workItemId: id,
      priority: item.priority,
      submittedBy: opts.submittedBy,
      workRef: item.workRef,
    });
    // Event-driven: attempt immediate assignment.
    this.tryAssign(item);
    return cloneWorkItem(item);
  }

  // ===================================================================
  // Assignment lifecycle
  // ===================================================================

  /**
   * Consumer reports work has actually started (after picking up the
   * assignment from the audit event).
   */
  reportStarted(workItemId: string): WorkItem {
    const item = this.require(workItemId);
    if (item.status !== 'assigned') {
      throw new Error(
        `scheduler.reportStarted: workItem '${workItemId}' is '${item.status}', expected 'assigned'`,
      );
    }
    item.status = 'running';
    item.startedAt = new Date().toISOString();
    this._dirty = true;
    this.emit('agents.scheduler.work-started', `item:agents.scheduler.workItems[${workItemId}]`, {
      workItemId,
      agentId: item.assignedAgentId,
    });
    return cloneWorkItem(item);
  }

  reportCompleted(workItemId: string): WorkItem {
    const item = this.require(workItemId);
    if (item.status === 'completed') return cloneWorkItem(item);
    if (item.status === 'failed' || item.status === 'cancelled') {
      throw new Error(
        `scheduler.reportCompleted: workItem '${workItemId}' is terminal '${item.status}'`,
      );
    }
    item.status = 'completed';
    item.completedAt = new Date().toISOString();
    this._dirty = true;
    this.emit('agents.scheduler.work-completed', `item:agents.scheduler.workItems[${workItemId}]`, {
      workItemId,
      agentId: item.assignedAgentId,
    });
    // Free-up event: try assigning a new item to this agent.
    if (item.assignedAgentId) {
      this.tryAssignAllQueued();
    }
    return cloneWorkItem(item);
  }

  reportFailed(workItemId: string, errorMessage: string): WorkItem {
    const item = this.require(workItemId);
    if (item.status === 'failed') return cloneWorkItem(item);
    item.status = 'failed';
    item.completedAt = new Date().toISOString();
    item.errorMessage = errorMessage;
    this._dirty = true;
    this.emit('agents.scheduler.work-failed', `item:agents.scheduler.workItems[${workItemId}]`, {
      workItemId,
      agentId: item.assignedAgentId,
      errorMessage,
    });
    if (item.assignedAgentId) {
      this.tryAssignAllQueued();
    }
    return cloneWorkItem(item);
  }

  cancel(workItemId: string, reason?: string): WorkItem {
    const item = this.require(workItemId);
    if (item.status === 'cancelled' || item.status === 'completed' || item.status === 'failed') {
      return cloneWorkItem(item);
    }
    item.status = 'cancelled';
    item.completedAt = new Date().toISOString();
    if (reason) item.errorMessage = reason;
    this._dirty = true;
    this.emit('agents.scheduler.work-cancelled', `item:agents.scheduler.workItems[${workItemId}]`, {
      workItemId,
      reason,
    });
    return cloneWorkItem(item);
  }

  // ===================================================================
  // Reads
  // ===================================================================

  get(workItemId: string): WorkItem | null {
    const item = this.workItems.get(workItemId);
    return item ? cloneWorkItem(item) : null;
  }

  list(opts: ListWorkItemsOpts = {}): WorkItem[] {
    const statuses: WorkItemStatus[] | null = opts.status
      ? Array.isArray(opts.status)
        ? [...opts.status]
        : [opts.status]
      : null;
    const out: WorkItem[] = [];
    for (const item of this.workItems.values()) {
      if (statuses && !statuses.includes(item.status)) continue;
      if (opts.workRefKind && item.workRef.kind !== opts.workRefKind) continue;
      if (opts.workRefRef && item.workRef.ref !== opts.workRefRef) continue;
      if (opts.assignedAgentId && item.assignedAgentId !== opts.assignedAgentId) continue;
      out.push(cloneWorkItem(item));
    }
    // Default sort: priority desc, then submittedAt asc.
    out.sort((a, b) => {
      if (a.priority !== b.priority) return b.priority - a.priority;
      return Date.parse(a.submittedAt) - Date.parse(b.submittedAt);
    });
    return typeof opts.limit === 'number' && opts.limit > 0 ? out.slice(0, opts.limit) : out;
  }

  count(opts: ListWorkItemsOpts = {}): number {
    return this.list({ ...opts, limit: undefined }).length;
  }

  // ===================================================================
  // Routing policy
  // ===================================================================

  setRoutingPolicy(opts: SetRoutingPolicyOpts): RoutingPolicyEntry {
    if (!opts?.entry?.kind || typeof opts.entry.kind !== 'string') {
      throw new Error('scheduler.routing.set: entry.kind required');
    }
    const now = new Date().toISOString();
    const entry: RoutingPolicyEntry = {
      ...opts.entry,
      registeredAt: now,
      registeredBy: opts.by,
    };
    this.routingPolicy.set(entry.kind, entry);
    this._dirty = true;
    this.emit('agents.scheduler.routing-policy-set', `item:agents.scheduler.routingPolicy[${entry.kind}]`, {
      kind: entry.kind,
      defaultProviderKind: entry.defaultProviderKind,
      sticky: !!entry.sticky,
      by: opts.by,
    });
    return { ...entry };
  }

  getRoutingPolicy(kind: string): RoutingPolicyEntry | null {
    const e = this.routingPolicy.get(kind);
    return e ? { ...e } : null;
  }

  listRoutingPolicy(): RoutingPolicyEntry[] {
    return [...this.routingPolicy.values()].map(e => ({ ...e }));
  }

  // ===================================================================
  // Persistable
  // ===================================================================

  saveJson(): string {
    const snap: Snapshot = {
      schemaVersion: SCHEMA_VERSION,
      workItems: [...this.workItems.values()],
      routingPolicy: [...this.routingPolicy.values()],
      activeTickets: [...this.activeByTicketId.values()],
    };
    return JSON.stringify(snap);
  }

  loadJson(s: string): void {
    if (!s) return;
    let parsed: Snapshot;
    try {
      parsed = JSON.parse(s) as Snapshot;
    } catch (e) {
      console.warn(
        `[scheduler] loadJson: parse failed — ${(e as Error).message}; starting empty`,
      );
      return;
    }
    if (!parsed || parsed.schemaVersion !== SCHEMA_VERSION) return;
    this.workItems.clear();
    this.routingPolicy.clear();
    this.activeByTicketId.clear();
    if (Array.isArray(parsed.workItems)) {
      for (const item of parsed.workItems) {
        if (item && typeof item.id === 'string') this.workItems.set(item.id, item);
      }
    }
    if (Array.isArray(parsed.routingPolicy)) {
      for (const e of parsed.routingPolicy) {
        if (e && typeof e.kind === 'string') this.routingPolicy.set(e.kind, e);
      }
    }
    if (Array.isArray(parsed.activeTickets)) {
      for (const t of parsed.activeTickets) {
        if (t && typeof t.ticketId === 'string') this.activeByTicketId.set(t.ticketId, t);
      }
    }
    // Restore is not a mutation.
    this._dirty = false;
  }

  /**
   * Decision 31 Phase A — Persistable.consumeDirty. Returns true iff
   * scheduler state changed since the last call, and atomically resets.
   */
  consumeDirty(): boolean {
    const d = this._dirty;
    this._dirty = false;
    return d;
  }

  // ===================================================================
  // Tickets (Decision 34)
  // ===================================================================

  /**
   * Request a Turn against an Engagement. Issues a ticket, dispatches
   * via `agents.sendMessage(agentId, { text, ticketId, by })`, stamps
   * the ticket as active, and returns the four identifiers the caller
   * needs to follow the dispatch:
   *
   *   { ticketId, agentId, turnId, replyHandle }
   *
   * Agent resolution: `opts.preferredAgentId` wins (when present + active);
   * otherwise picks `engagement.boundAgentIds[0]`; otherwise throws (the
   * caller must run engagementFlow.runSchedulerLease first to seed a
   * bound agent — or supply a preferredAgentId).
   *
   * Ticket TTL defaults to `TICKET_TTL_MS` (5 min). Expired tickets are
   * released on the next scheduler tick.
   */
  async requestTurn(opts: RequestTurnOpts): Promise<RequestTurnResult> {
    if (!opts || typeof opts.engagementId !== 'string' || !opts.engagementId) {
      throw new Error('scheduler.requestTurn: opts.engagementId required');
    }
    if (typeof opts.prompt !== 'string' || !opts.prompt) {
      throw new Error('scheduler.requestTurn: opts.prompt required (non-empty)');
    }
    if (!this.agentsRef) {
      throw new Error('scheduler.requestTurn: agents subsystem not wired');
    }

    // Resolve engagement + pick agent.
    const engagementsApi = this.resolveEngagementsApi();
    const engagement = engagementsApi?.get
      ? (engagementsApi.get(opts.engagementId) as
          | { id: string; boundAgentIds?: string[]; preferredAgentId?: string }
          | null)
      : null;
    if (!engagement) {
      throw new Error(`scheduler.requestTurn: unknown engagement '${opts.engagementId}'`);
    }

    const candidateAgentId =
      opts.preferredAgentId ??
      engagement.preferredAgentId ??
      engagement.boundAgentIds?.[0] ??
      null;
    if (!candidateAgentId) {
      throw new Error(
        `scheduler.requestTurn: no agent bound to engagement '${opts.engagementId}'. ` +
          'Run engagementFlow.runSchedulerLease first or supply opts.preferredAgentId.',
      );
    }

    const agent = this.agentsRef.get(candidateAgentId);
    if (!agent) {
      throw new Error(
        `scheduler.requestTurn: agentId '${candidateAgentId}' not found in agents registry`,
      );
    }
    if (agent.status !== 'active') {
      throw new Error(
        `scheduler.requestTurn: agentId '${candidateAgentId}' is '${agent.status}'; cannot dispatch`,
      );
    }

    // Decision 36 step 1 — capture caller-supplied routing overrides
    // onto the ticket and audit payload. Recorded only; v0 routing
    // (above) still uses the boundAgentIds[0]/preferredAgentId path.
    // Later D36 steps will consult these for AI-Choose / Activity-Table
    // -driven dispatch.
    const requestOverrides: RequestOverrides | undefined =
      opts.pin !== undefined || opts.activityTable !== undefined || opts.complexity !== undefined
        ? {
            ...(opts.pin !== undefined ? { pin: opts.pin } : {}),
            ...(opts.activityTable !== undefined ? { activityTable: opts.activityTable } : {}),
            ...(opts.complexity !== undefined ? { complexity: opts.complexity } : {}),
          }
        : undefined;

    // Issue the ticket.
    const ticket = this.issueTicket({
      engagementId: opts.engagementId,
      agentId: candidateAgentId,
      providerKind: agent.provider?.kind ?? 'unknown',
      outcome: opts.outcome,
      by: opts.by,
      ttlMs: opts.ttlMs ?? TICKET_TTL_MS,
      requestOverrides,
    });

    // Dispatch through the AgentsSubsystem. sendMessage threads the
    // ticketId through to the Turn record (Decision 34).
    let sent: { replyHandle: string; turnId?: string };
    try {
      sent = await this.agentsRef.sendMessage(candidateAgentId, {
        text: opts.prompt,
        by: opts.by ?? 'scheduler.requestTurn',
        ticketId: ticket.ticketId,
      });
    } catch (err: unknown) {
      // Dispatch failed → release the ticket immediately.
      this.releaseTicket(ticket.ticketId, 'cancelled');
      throw err;
    }

    const turnId = sent.turnId ?? `tur_unstamped_${Date.now()}`;
    this.markTicketActive(ticket.ticketId, turnId);

    return {
      ticketId: ticket.ticketId,
      agentId: candidateAgentId,
      turnId,
      replyHandle: sent.replyHandle,
    };
  }

  /**
   * Release a ticket. Idempotent — releasing an already-terminal ticket
   * is a no-op. Reason defaults to 'cancelled' when callers don't
   * specify; the Turn-completion subscriber uses 'completed', the TTL
   * sweep uses 'expired'.
   */
  releaseTicket(ticketId: string, reason: TicketTerminalReason = 'cancelled'): void {
    const ticket = this.activeByTicketId.get(ticketId);
    if (!ticket) return;
    ticket.status = reason;
    ticket.endedAt = new Date().toISOString();
    ticket.releaseReason = reason;
    this.activeByTicketId.delete(ticketId);
    this.recordHistoryEvent(ticketId, reason);
    this.archiveToHistory(ticket);
    this._dirty = true;
    this.emit('agents.scheduler.ticket-released', `item:agents.scheduler.tickets[${ticketId}]`, {
      ticketId,
      engagementId: ticket.engagementId,
      agentId: ticket.agentId,
      turnId: ticket.turnId,
      reason,
    });
  }

  /**
   * List tickets, optional filters. By default returns active only;
   * pass `includeHistory: true` to merge terminal tickets in.
   */
  listTickets(opts: ListTicketsOpts = {}): Ticket[] {
    const wantStatuses = opts.status
      ? Array.isArray(opts.status)
        ? new Set(opts.status)
        : new Set([opts.status])
      : null;

    let pool: Ticket[] = [...this.activeByTicketId.values()];
    if (opts.includeHistory) {
      pool = pool.concat([...this.historyByTicketId.values()]);
    }

    let list = pool;
    if (opts.engagementId) list = list.filter(t => t.engagementId === opts.engagementId);
    if (opts.agentId) list = list.filter(t => t.agentId === opts.agentId);
    if (opts.outcome) list = list.filter(t => t.outcome === opts.outcome);
    if (wantStatuses) list = list.filter(t => wantStatuses.has(t.status));

    // Newest first.
    list.sort((a, b) => (a.issuedAt < b.issuedAt ? 1 : -1));
    if (typeof opts.limit === 'number') list = list.slice(0, opts.limit);
    return list.map(cloneTicket);
  }

  /**
   * Lifecycle history for one ticket. Returns null when the ticket has
   * never existed (or was evicted from the per-engagement ring).
   */
  ticketHistory(ticketId: string): TicketHistory | null {
    const events = this.historyEventsByTicketId.get(ticketId);
    const terminal = this.historyByTicketId.get(ticketId);
    const active = this.activeByTicketId.get(ticketId);
    const ticket = terminal ?? active;
    if (!ticket) return null;
    return {
      ticketId,
      events: (events ?? []).map(e => ({ ...e })),
      ticket: cloneTicket(ticket),
    };
  }

  // -------------------------------------------------------------------
  // Ticket internals
  // -------------------------------------------------------------------

  private issueTicket(opts: {
    engagementId: string;
    agentId: string;
    providerKind: string;
    outcome?: string;
    by?: string;
    ttlMs: number;
    /** Decision 36 step 1 — recorded only in v0. */
    requestOverrides?: RequestOverrides;
  }): Ticket {
    const ticketId = `tkt_${randomUUID()}`;
    const now = new Date();
    const ticket: Ticket = {
      ticketId,
      engagementId: opts.engagementId,
      agentId: opts.agentId,
      providerKind: opts.providerKind,
      outcome: opts.outcome,
      status: 'issued',
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + opts.ttlMs).toISOString(),
      by: opts.by,
      ...(opts.requestOverrides ? { requestOverrides: opts.requestOverrides } : {}),
    };
    this.activeByTicketId.set(ticketId, ticket);
    this.recordHistoryEvent(ticketId, 'issued');
    this._dirty = true;
    this.emit('agents.scheduler.ticket-issued', `item:agents.scheduler.tickets[${ticketId}]`, {
      ticketId,
      engagementId: ticket.engagementId,
      agentId: ticket.agentId,
      providerKind: ticket.providerKind,
      outcome: ticket.outcome,
      expiresAt: ticket.expiresAt,
      by: opts.by,
      // Decision 36 step 1 — include the snapshot in audit so dispatch
      // lineage is reproducible from the audit log alone.
      ...(opts.requestOverrides ? { requestOverrides: opts.requestOverrides } : {}),
    });
    return ticket;
  }

  private markTicketActive(ticketId: string, turnId: string): void {
    const ticket = this.activeByTicketId.get(ticketId);
    if (!ticket) return;
    if (ticket.status !== 'issued') return;
    ticket.status = 'active';
    ticket.turnId = turnId;
    ticket.startedAt = new Date().toISOString();
    this.recordHistoryEvent(ticketId, 'used', `turnId=${turnId}`);
    this._dirty = true;
  }

  /**
   * Audit subscriber callback: when an `agents.turn.completed` or
   * `agents.turn.errored` fires, find the matching active ticket (via
   * `data.turnId` or `data.ticketId`) and release it.
   */
  private onTurnTerminal(e: unknown, reason: TicketTerminalReason): void {
    const evt = e as { data?: { turnId?: string; ticketId?: string } } | null;
    const turnId = evt?.data?.turnId;
    const stampedTicketId = evt?.data?.ticketId;
    if (!turnId && !stampedTicketId) return;
    // Prefer ticketId from the audit payload when present.
    let ticket: Ticket | undefined;
    if (stampedTicketId) ticket = this.activeByTicketId.get(stampedTicketId);
    if (!ticket && turnId) {
      for (const t of this.activeByTicketId.values()) {
        if (t.turnId === turnId) { ticket = t; break; }
      }
    }
    if (!ticket) return;
    this.releaseTicket(ticket.ticketId, reason);
  }

  /** TTL sweep — called from the existing `tick()` loop. */
  private sweepTickets(): void {
    const now = Date.now();
    const expired: string[] = [];
    for (const t of this.activeByTicketId.values()) {
      if (new Date(t.expiresAt).getTime() <= now) expired.push(t.ticketId);
    }
    for (const ticketId of expired) {
      this.releaseTicket(ticketId, 'expired');
    }
  }

  private recordHistoryEvent(ticketId: string, kind: TicketHistoryEvent['kind'], detail?: string): void {
    const events = this.historyEventsByTicketId.get(ticketId) ?? [];
    events.push({ at: new Date().toISOString(), kind, detail });
    this.historyEventsByTicketId.set(ticketId, events);
  }

  private archiveToHistory(ticket: Ticket): void {
    this.historyByTicketId.set(ticket.ticketId, ticket);
    const ring = this.historyTicketIdsByEngagement.get(ticket.engagementId) ?? [];
    ring.push(ticket.ticketId);
    while (ring.length > TICKET_HISTORY_CAP_PER_ENG) {
      const evicted = ring.shift();
      if (evicted) {
        this.historyByTicketId.delete(evicted);
        this.historyEventsByTicketId.delete(evicted);
      }
    }
    this.historyTicketIdsByEngagement.set(ticket.engagementId, ring);
  }

  private resolveEngagementsApi(): { get?: (id: string) => unknown } | null {
    const rt = this.runtime as { extensions?: { get(name: string): unknown } };
    const exts = rt.extensions;
    if (!exts || typeof exts.get !== 'function') return null;
    return (exts.get('engagements') as { get?: (id: string) => unknown } | null) ?? null;
  }

  // ===================================================================
  // Internals
  // ===================================================================

  private require(workItemId: string): WorkItem {
    const item = this.workItems.get(workItemId);
    if (!item) throw new Error(`scheduler: no workItem with id '${workItemId}'`);
    return item;
  }

  /**
   * Attempt to assign a single queued WorkItem to an idle agent.
   */
  private tryAssign(item: WorkItem): AssignmentResult {
    if (item.status !== 'queued') {
      return { workItemId: item.id, assigned: false, reason: `not queued: ${item.status}` };
    }
    if (!this.agentsRef) {
      return { workItemId: item.id, assigned: false, reason: 'agents subsystem not wired' };
    }

    // Build candidate pool: active agents matching requiredRole.
    let candidates = this.agentsRef.list({ status: 'active' });
    if (item.requiredRole) {
      candidates = candidates.filter(a => a.role === item.requiredRole);
    }
    if (item.requiredCapabilities) {
      const req = item.requiredCapabilities;
      candidates = candidates.filter(a => {
        // Without a ProviderRegistry capability lookup, we can only check
        // if the agent has the capability declared on its provider. v0:
        // accept all (capability declarations live on ProviderImpl, not
        // Agent — future enhancement to resolve them via providerRegistry).
        return true;
      });
    }

    if (candidates.length === 0) {
      return {
        workItemId: item.id,
        assigned: false,
        reason: `no candidates matching requiredRole='${item.requiredRole ?? '<any>'}'`,
      };
    }

    const busy = this.busySet();
    const decision = this.algorithm.pickAgent(item, candidates, busy, this.routingPolicy);
    if (!decision) {
      return {
        workItemId: item.id,
        assigned: false,
        reason: 'no idle eligible agent',
      };
    }

    item.status = 'assigned';
    item.assignedAgentId = decision.agentId;
    item.assignedAt = new Date().toISOString();
    item.reasonAssigned = decision.reason;
    this.lastAssignedAtByAgent.set(decision.agentId, Date.now());
    // tryAssign mutates state from the tick timer (not via a public
    // primitive call), so the persist subsystem won't see this in the
    // run's dirtyByRun set. Self-track here so end-of-tick snapshots
    // still happen.
    this._dirty = true;
    this.emit('agents.scheduler.work-assigned', `item:agents.scheduler.workItems[${item.id}]`, {
      workItemId: item.id,
      agentId: decision.agentId,
      reason: decision.reason,
      workRef: item.workRef,
    });
    return {
      workItemId: item.id,
      assigned: true,
      agentId: decision.agentId,
      reason: decision.reason,
    };
  }

  private tryAssignAllQueued(): void {
    const queued = this.list({ status: 'queued' });
    for (const item of queued) {
      // Re-read live ref since tryAssign mutates.
      const live = this.workItems.get(item.id);
      if (live && live.status === 'queued') this.tryAssign(live);
    }
  }

  private tick(): void {
    try {
      this.tryAssignAllQueued();
    } catch (e) {
      // Tick errors must not crash the timer.
      console.warn(`[scheduler] tick error: ${(e as Error)?.message ?? String(e)}`);
    }
    // Decision 34 — sweep expired tickets every tick.
    try {
      this.sweepTickets();
    } catch (e) {
      console.warn(`[scheduler] ticket sweep error: ${(e as Error)?.message ?? String(e)}`);
    }
  }

  /** Agents currently 'assigned' or 'running' to a WorkItem. */
  private busySet(): Set<string> {
    const busy = new Set<string>();
    for (const item of this.workItems.values()) {
      if ((item.status === 'assigned' || item.status === 'running') && item.assignedAgentId) {
        busy.add(item.assignedAgentId);
      }
    }
    return busy;
  }

  /** Exposed for the algorithm — read-only access. */
  getLastAssignedAt(agentId: string): number | undefined {
    return this.lastAssignedAtByAgent.get(agentId);
  }

  private emit(kind: string, ref: string, data: Record<string, unknown>): void {
    try {
      const audit = (this.runtime as { audit?: { emit?: (e: unknown) => void } }).audit;
      if (audit?.emit) audit.emit({ kind, ref, data });
    } catch {
      /* swallow */
    }
  }
}

function cloneTicket(t: Ticket): Ticket {
  return { ...t };
}

function cloneWorkItem(w: WorkItem): WorkItem {
  return {
    ...w,
    workRef: { ...w.workRef },
    requiredCapabilities: w.requiredCapabilities ? { ...w.requiredCapabilities } : undefined,
    contextScope: w.contextScope ? { ...w.contextScope } : undefined,
  };
}

// ===========================================================================
// Default algorithm
//
// v0:
//   1. requiredRole + requiredCapabilities filter out non-candidates
//      (done by caller, candidates list is pre-filtered).
//   2. If preferredAgentId is in candidates AND idle → use it.
//   3. Else: among idle candidates, prefer those whose provider matches
//      preferredProviderKind (or routing-policy default for the
//      contextScope.activityKind). LRU tiebreak.
//   4. Else: leave queued.
// ===========================================================================

export function defaultAlgorithm(): SchedulerAlgorithm {
  return {
    pickAgent(workItem, candidates, busy, routingPolicy) {
      // Idle filter.
      const idle = candidates.filter(c => !busy.has(c.id));
      if (idle.length === 0) return null;

      // 1. Preferred agent if idle + eligible.
      if (workItem.preferredAgentId) {
        const preferred = idle.find(c => c.id === workItem.preferredAgentId);
        if (preferred) {
          return { agentId: preferred.id, reason: 'preferredAgentId-idle' };
        }
      }

      // 2. Determine effective provider preference.
      let preferredProviderKind = workItem.preferredProviderKind;
      if (!preferredProviderKind && workItem.contextScope?.activityKind) {
        const policy = routingPolicy.get(workItem.contextScope.activityKind);
        if (policy?.defaultProviderKind) preferredProviderKind = policy.defaultProviderKind;
      }

      // 3. Prefer matching provider; LRU among matches.
      const matching = preferredProviderKind
        ? idle.filter(c => c.provider?.kind === preferredProviderKind)
        : idle;
      const pool = matching.length > 0 ? matching : idle;

      // LRU: oldest leasedAt wins (proxy until we track actual lastAssignedAt
      // across ticks — TODO: thread the SchedulerSubsystem ref to read
      // getLastAssignedAt).
      pool.sort((a, b) => Date.parse(a.leasedAt) - Date.parse(b.leasedAt));
      const pick = pool[0];
      const reason = matching.length > 0
        ? `provider-match-${preferredProviderKind}/lru`
        : 'lru-fallback';
      return { agentId: pick.id, reason };
    },
  };
}
