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
      "(opts: { workRef: { kind: string; ref: string }; priority?: number; submittedBy: string; preferredAgentId?: string; preferredProviderKind?: 'bridge'|'together'|'openai'|'local'|'mock'; requiredRole?: string; requiredCapabilities?: { vision?: boolean; toolUse?: 'native'|'unsupported'|'limited' }; contextScope?: { projectId?: string; engagementId?: string; activityKind?: string } }): WorkItem",
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
      "(opts: { entry: { kind: string; defaultProviderKind?: 'bridge'|'together'|'openai'|'local'|'mock'; sticky?: boolean; fallbackProviderKind?: 'bridge'|'together'|'openai'|'local'|'mock'; hints?: Record<string, unknown> }; by?: string }): RoutingPolicyEntry",
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
