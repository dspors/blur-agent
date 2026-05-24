/**
 * Scheduler exposures.
 *
 * Mounted at `runtime.scheduler.*`. The Scheduler is the central queue
 * for all work that needs an Agent. Priority differentiates UI-driven
 * (high) from background AI-only (low); the mechanism is one primitive.
 */

import type { MethodExposure } from 'blur-ai-runtime';


export const schedulerExposures: MethodExposure[] = [
  // ===================================================================
  // Submit + lifecycle
  // ===================================================================
  {
    objectPath: 'scheduler',
    method: 'submit',
    primitivePath: 'agents.scheduler.submit',
    signature:
      "(opts: { workRef: { kind: string; ref: string }; priority?: number; submittedBy: string; preferredAgentId?: string; preferredProviderKind?: 'bridge'|'together'|'openai'|'local'|'mock'|'anthropic'|'azure-foundry'; requiredRole?: string; requiredCapabilities?: { vision?: boolean; toolUse?: 'native'|'unsupported'|'limited' }; contextScope?: { projectId?: string; engagementId?: string; activityKind?: string } }): WorkItem",
    description:
      'Submit a WorkItem to the scheduler. Default priority=50. The scheduler ' +
      'immediately attempts assignment; if no eligible idle agent, the item ' +
      'waits in the queue and is reconsidered on the next tick (5s) or when ' +
      'an agent completes existing work. Emits agents.scheduler.work-submitted ' +
      'plus agents.scheduler.work-assigned if assignment succeeded.',
    sideEffect: 'write',
    example:
      "await runtime.scheduler.submit({ workRef: { kind: 'engagement', ref: 'eng_…' }, priority: 100, submittedBy: 'user', requiredRole: 'configuration', contextScope: { projectId: 'qb', engagementId: 'eng_…', activityKind: 'general' } });",
    category: 'primary',
  },
  {
    objectPath: 'scheduler',
    method: 'reportStarted',
    primitivePath: 'agents.scheduler.reportStarted',
    signature: '(workItemId: string): WorkItem',
    description:
      'Consumer reports work has actually begun (post-assignment). Flips status assigned → running. Emits agents.scheduler.work-started.',
    sideEffect: 'write',
    category: 'primary',
  },
  {
    objectPath: 'scheduler',
    method: 'reportCompleted',
    primitivePath: 'agents.scheduler.reportCompleted',
    signature: '(workItemId: string): WorkItem',
    description:
      'Consumer reports work finished successfully. Frees the agent and triggers a re-scan of the queue.',
    sideEffect: 'write',
    category: 'primary',
  },
  {
    objectPath: 'scheduler',
    method: 'reportFailed',
    primitivePath: 'agents.scheduler.reportFailed',
    signature: '(workItemId: string, errorMessage: string): WorkItem',
    description: 'Consumer reports work failed. Frees the agent and triggers a re-scan.',
    sideEffect: 'write',
    category: 'primary',
  },
  {
    objectPath: 'scheduler',
    method: 'cancel',
    primitivePath: 'agents.scheduler.cancel',
    signature: '(workItemId: string, reason?: string): WorkItem',
    description: 'Cancel a queued or in-flight WorkItem.',
    sideEffect: 'write',
    category: 'primary',
  },

  // ===================================================================
  // Reads
  // ===================================================================
  {
    objectPath: 'scheduler',
    method: 'get',
    primitivePath: 'agents.scheduler.get',
    signature: '(workItemId: string): WorkItem | null',
    description: 'Return a WorkItem by id (cloned). Null if unknown.',
    sideEffect: 'read',
    category: 'primary',
  },
  {
    objectPath: 'scheduler',
    method: 'list',
    primitivePath: 'agents.scheduler.list',
    signature:
      "(opts?: { status?: 'queued'|'assigned'|'running'|'completed'|'failed'|'cancelled' | Array<...>; workRefKind?: string; workRefRef?: string; assignedAgentId?: string; limit?: number }): WorkItem[]",
    description: 'List WorkItems with optional filters. Priority-desc then submittedAt-asc order.',
    sideEffect: 'read',
    category: 'primary',
  },
  {
    objectPath: 'scheduler',
    method: 'count',
    primitivePath: 'agents.scheduler.count',
    signature: '(opts?: ListWorkItemsOpts): number',
    description: 'Count WorkItems.',
    sideEffect: 'read',
    category: 'support',
  },

  // ===================================================================
  // Routing policy
  // ===================================================================
  {
    objectPath: 'scheduler',
    method: 'setRoutingPolicy',
    primitivePath: 'agents.scheduler.routing.set',
    signature:
      "(opts: { entry: { kind: string; defaultProviderKind?: 'bridge'|'together'|'openai'|'local'|'mock'|'anthropic'|'azure-foundry'; sticky?: boolean; fallbackProviderKind?: 'bridge'|'together'|'openai'|'local'|'mock'|'anthropic'|'azure-foundry'; hints?: Record<string, unknown> }; by?: string }): RoutingPolicyEntry",
    description:
      'Set the routing policy for an activity kind. Tells the scheduler which provider ' +
      'to prefer when no preferredAgentId / preferredProviderKind is on the WorkItem. ' +
      'Emits agents.scheduler.routing-policy-set.',
    sideEffect: 'write',
    example:
      "await runtime.scheduler.setRoutingPolicy({ entry: { kind: 'secretary-pass', defaultProviderKind: 'together' } });",
    category: 'primary',
  },
  {
    objectPath: 'scheduler',
    method: 'getRoutingPolicy',
    primitivePath: 'agents.scheduler.routing.get',
    signature: '(kind: string): RoutingPolicyEntry | null',
    description: 'Look up a routing policy entry by activity kind.',
    sideEffect: 'read',
    category: 'support',
  },
  {
    objectPath: 'scheduler',
    method: 'listRoutingPolicy',
    primitivePath: 'agents.scheduler.routing.list',
    signature: '(): RoutingPolicyEntry[]',
    description: 'List all routing policy entries.',
    sideEffect: 'read',
    category: 'support',
  },

  // ===================================================================
  // Tickets (Decision 34 — engagement Turn dispatch)
  // ===================================================================
  {
    objectPath: 'scheduler',
    method: 'requestTurn',
    primitivePath: 'agents.scheduler.requestTurn',
    signature:
      "(opts: { engagementId: string; prompt: string; preferredAgentId?: string; outcome?: string; by?: string; ttlMs?: number; pin?: string; activityTable?: Record<string, { mode: 'always'|'auto'|'ai'; default: string | null; outcomes?: Record<string, string> }>; complexity?: 'routine'|'specialized' }): Promise<{ ticketId: string; agentId: string; turnId: string; replyHandle: string }>",
    description:
      'Issue a Ticket authorizing one Turn on an Engagement, dispatch via agents.sendMessage, and return the four identifiers needed to follow the dispatch. Agent resolution: opts.preferredAgentId > engagement.preferredAgentId > engagement.boundAgentIds[0]. Ticket TTL default 5min; sweep on the scheduler tick releases expired tickets. Emits agents.scheduler.ticket-issued (with requestOverrides when caller supplied any); agents.scheduler.ticket-released fires on turn-completed / turn-errored / TTL-expiry / explicit releaseTicket. v1 (Decision 34): fail-soft gate — sendMessage without ticketId proceeds with an agents.send-without-ticket warning; v2 makes it fail-closed. Decision 36 step 1 (this version): pin, activityTable, complexity are accepted, recorded on the Ticket (ticket.requestOverrides) and audit payload, but routing still uses the v0 path — opts are captured for later AI-Choose / Activity-Table consultation.',
    sideEffect: 'external',
    example:
      "const t = await runtime.scheduler.requestTurn({ engagementId: 'eng_abc', prompt: 'Summarize last 3 commits', outcome: 'summary', by: 'user', pin: 'together/gpt-oss-120b' });",
    category: 'primary',
  },
  {
    objectPath: 'scheduler',
    method: 'releaseTicket',
    primitivePath: 'agents.scheduler.releaseTicket',
    signature: "(ticketId: string, reason?: 'completed'|'expired'|'cancelled'): void",
    description:
      'Release a ticket. Idempotent — releasing an already-terminal ticket is a no-op. Default reason: "cancelled". The Turn-completion subscriber uses "completed"; the TTL sweep uses "expired". Emits agents.scheduler.ticket-released.',
    sideEffect: 'write',
    category: 'primary',
  },
  {
    objectPath: 'scheduler',
    method: 'listTickets',
    primitivePath: 'agents.scheduler.listTickets',
    signature:
      "(opts?: { engagementId?: string; agentId?: string; status?: 'issued'|'active'|'completed'|'expired'|'cancelled' | Array<...>; outcome?: string; includeHistory?: boolean; limit?: number }): Ticket[]",
    description:
      'List tickets; active-only by default. Pass { includeHistory: true } to merge terminal tickets from the per-engagement history ring. Newest first.',
    sideEffect: 'read',
    category: 'primary',
  },
  {
    objectPath: 'scheduler',
    method: 'ticketHistory',
    primitivePath: 'agents.scheduler.tickets.history',
    signature: '(ticketId: string): { ticketId: string; events: Array<{ at: string; kind: string; detail?: string }>; ticket: Ticket } | null',
    description:
      'Lifecycle history for one ticket — { issued, used, completed | expired | cancelled, ... }. Returns null when the ticket has never existed (or was evicted from the per-engagement history ring).',
    sideEffect: 'read',
    category: 'primary',
  },

  // ===================================================================
  // AI optimizer (observation-v0)
  // ===================================================================
  {
    objectPath: 'scheduler',
    method: 'useAIOptimizer',
    primitivePath: 'agents.scheduler.useAIOptimizer',
    signature:
      "(opts?: { consultPriorityCeiling?: number; skipActivityKinds?: string[]; consultTimeoutMs?: number; schedulerAgentId?: string; disable?: boolean }): SchedulerAlgorithm",
    description:
      'Wrap the current algorithm in an AI-augmented version that consults ' +
      'a leased Scheduler agent for review of each decision. Observation-' +
      'only in v0 — never overrides the deterministic decision. Verdicts ' +
      'fire as audit events (kind: agents.scheduler.ai-verdict). Default ' +
      "skips priority >= 90 (UI-driven) and activityKind 'scheduler-tick' " +
      '(recursion). Pass `disable: true` to revert to the deterministic ' +
      'algorithm.',
    sideEffect: 'write',
    example:
      "// Enable AI oversight on the scheduler:\n" +
      "await runtime.agents.lease({ role: 'scheduler', label: 'live scheduler agent', leasedFrom: 'manual', sessionId: '...', provider: { kind: 'together', model: '...' } });\n" +
      "await runtime.scheduler.useAIOptimizer({ consultTimeoutMs: 8000 });\n" +
      "// Now every below-priority-90 assignment fires an async consultation.",
    category: 'support',
  },
];
