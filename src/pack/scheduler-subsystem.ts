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

interface Snapshot {
  schemaVersion: number;
  workItems: WorkItem[];
  routingPolicy: RoutingPolicyEntry[];
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
   * Backref to AgentsSubsystem — set by the pack install. Needed so the
   * tick can query candidate agents.
   */
  agentsRef: AgentsSubsystem | null = null;

  private tickTimer: NodeJS.Timeout | null = null;
  private algorithm: SchedulerAlgorithm = defaultAlgorithm();

  /** LRU tracking: agentId → last assignment timestamp (ms). */
  private lastAssignedAtByAgent = new Map<string, number>();

  constructor(public readonly runtime: BlurAIRuntime) {}

  // ===================================================================
  // Lifecycle
  // ===================================================================

  start(): void {
    if (this.tickTimer) return;
    this.tickTimer = setInterval(() => this.tick(), SCHEDULER_TICK_MS);
    if (typeof this.tickTimer.unref === 'function') this.tickTimer.unref();
  }

  stop(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
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
