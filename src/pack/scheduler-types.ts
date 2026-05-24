/**
 * Scheduler — types.
 *
 * The Scheduler is the central queue for ALL work that needs an Agent.
 * AI/UI work (user opens a chat → high-priority WorkItem) goes through
 * the same queue as AI-only work (audit-triggered Secretary pass →
 * low-priority WorkItem). Priority differentiates; the mechanism is
 * one primitive.
 *
 * Structural placement (which project / engagement / domain) is
 * orthogonal to resourcing (which agent runs it, when). Structural
 * placement is encoded in the domain records (Engagement scope,
 * project directory). Resourcing is the Scheduler's job.
 */

import type { AgentProvider } from './types';

/**
 * Single source of truth for the provider-kind union — re-exported from
 * AgentProvider so this file and types.ts can never drift. Adding a new
 * provider (e.g. 'azure-foundry') happens in types.ts; everything that
 * references SchedulerProviderKind picks it up automatically.
 */
export type SchedulerProviderKind = AgentProvider['kind'];

// ===========================================================================
// WorkItem
// ===========================================================================

export type WorkItemStatus = 'queued' | 'assigned' | 'running' | 'completed' | 'failed' | 'cancelled';

/** What the WorkItem points at. Most commonly an Engagement; also Turn, custom. */
export interface WorkItemRef {
  /**
   * 'engagement' | 'turn' | 'custom' — the kind of the referenced object.
   * Scheduler treats all kinds opaquely; consumers dereference by id.
   */
  kind: string;
  /** Stable id of the referenced object. */
  ref: string;
}

/**
 * Required capabilities — a hard filter on candidate agents. Scheduler
 * REFUSES to assign a WorkItem to an agent that doesn't satisfy these.
 */
export interface RequiredCapabilities {
  vision?: boolean;
  toolUse?: 'native' | 'unsupported' | 'limited';
}

/** Context-scope hints for routing / observability. Not enforced. */
export interface ContextScope {
  projectId?: string;
  engagementId?: string;
  activityKind?: string;
}

export interface WorkItem {
  /** 'wi_<uuid>' — durable id. */
  id: string;

  /** What this item is work-for. */
  workRef: WorkItemRef;

  /** Higher = sooner. Default 50. UI-driven typically 100; secretary typically 10. */
  priority: number;

  /** ISO timestamps. */
  submittedAt: string;
  /** sessionId / agentId / 'user' / 'audit-trigger' / cron-id … */
  submittedBy: string;

  // ----- Scheduler hints (considered, not bound by) -----

  /** Sticky-session continuity hint. */
  preferredAgentId?: string;

  /**
   * Provider-kind preference. The scheduler uses this when there's no
   * preferredAgentId — e.g., route secretary-pass to 'together' agents.
   */
  preferredProviderKind?: SchedulerProviderKind;

  // ----- Scheduler constraints (MUST honor) -----

  /** Agent role required. Hard filter. */
  requiredRole?: string;

  /** Capability filter. Hard filter. */
  requiredCapabilities?: RequiredCapabilities;

  /** Context tags for observability + routing-policy lookups. */
  contextScope?: ContextScope;

  // ----- Lifecycle -----

  status: WorkItemStatus;
  assignedAgentId?: string;
  assignedAt?: string;
  startedAt?: string;
  completedAt?: string;

  /** Free-text describing why the scheduler chose the assigned agent. Auditable. */
  reasonAssigned?: string;

  /** Populated when status === 'failed'. */
  errorMessage?: string;
}

// ===========================================================================
// Opts shapes
// ===========================================================================

export interface SubmitWorkItemOpts {
  workRef: WorkItemRef;
  priority?: number;
  submittedBy: string;
  preferredAgentId?: string;
  preferredProviderKind?: WorkItem['preferredProviderKind'];
  requiredRole?: string;
  requiredCapabilities?: RequiredCapabilities;
  contextScope?: ContextScope;
}

export interface ListWorkItemsOpts {
  status?: WorkItemStatus | WorkItemStatus[];
  workRefKind?: string;
  /** Filter by workRef.ref (combine with workRefKind for precision). */
  workRefRef?: string;
  assignedAgentId?: string;
  /** Default 100. */
  limit?: number;
}

// ===========================================================================
// Routing policy
// ===========================================================================

/**
 * Routing policy entry — keyed by engagement-kind (or generally
 * `contextScope.activityKind`). Tells the scheduler which provider /
 * stickiness profile this kind prefers.
 */
export interface RoutingPolicyEntry {
  /** The kind this entry applies to. */
  kind: string;
  /** Preferred provider. */
  defaultProviderKind?: WorkItem['preferredProviderKind'];
  /**
   * Strongly prefer the same agent across re-runs. Used for sessions
   * where context continuity is part of the value (Claude same-session
   * for general / coding / project-interview).
   */
  sticky?: boolean;
  /** Fallback when defaultProviderKind isn't available. */
  fallbackProviderKind?: WorkItem['preferredProviderKind'];
  /** Free-form metadata for kind-specific policies. */
  hints?: Record<string, unknown>;
  registeredAt?: string;
  registeredBy?: string;
}

export interface SetRoutingPolicyOpts {
  entry: Omit<RoutingPolicyEntry, 'registeredAt'>;
  by?: string;
}

// ===========================================================================
// Assignment result
// ===========================================================================

/** Returned by the scheduler when it makes (or fails to make) an assignment. */
export interface AssignmentResult {
  workItemId: string;
  assigned: boolean;
  agentId?: string;
  reason: string;
}
