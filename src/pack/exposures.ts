/**
 * Method exposure manifest for the agents pack.
 *
 * Mounts at `runtime.agents.*`. Primary primitives surface in the
 * .d.ts index without drill-in. Role-catalog primitives nest under
 * `runtime.agents.roles.*`; notes under `runtime.agents.notes.*`.
 */

import type { MethodExposure } from 'blur-ai-runtime';

const SRC = 'blur-agent@0.1.0';

export const exposures: MethodExposure[] = [
  // ===================================================================
  // Lifecycle
  // ===================================================================
  {
    objectPath: 'agents',
    method: 'lease',
    primitivePath: 'agents.lease',
    signature:
      "(opts: { role: string; label?: string; bindings?: Array<{ scope: 'cross-project'|'project'|'track'|'arc'|'move'|'pack'|'runtime'; ref?: string; note?: string }>; handoff?: { promptRef?: string; cwd?: string }; pool?: { host?: string; role?: string; ttlSec?: number }; leasedFrom?: 'pool'|'external'|'manual'; sessionId?: string; notes?: Array<{ kind: string; text: string; by?: string }>; by?: string }): Promise<Agent>",
    description:
      'Lease a new Agent. Default takes a pool session via runtime.pool.lease and wraps it; pass leasedFrom:"manual" + sessionId to bind to an existing session. Role must be registered in the role catalog. Emits agents.leased.',
    sideEffect: 'write',
    example:
      "await runtime.agents.lease({ role: 'conductor', label: 'qb Conductor', bindings: [{ scope: 'project', ref: 'qb' }], handoff: { cwd: 'C:\\\\Users\\\\dspors\\\\.blur\\\\projects\\\\qb\\\\handoffs\\\\conductor' } });",
    source: SRC,
    category: 'primary',
  },
  {
    objectPath: 'agents',
    method: 'release',
    primitivePath: 'agents.release',
    signature: '(id: string, opts?: { by?: string; reason?: string; keepSession?: boolean }): Promise<Agent>',
    description:
      "Release an Agent. Releases the underlying pool session (unless keepSession) and marks status='released'. Record is preserved. Emits agents.released.",
    sideEffect: 'write',
    source: SRC,
    category: 'primary',
  },
  {
    objectPath: 'agents',
    method: 'pause',
    primitivePath: 'agents.pause',
    signature: '(id: string, opts?: { by?: string; reason?: string; keepSession?: boolean }): Promise<Agent>',
    description:
      "Pause an Agent — releases the bridge session, keeps the record at status='paused'. Use when work is mid-flight and you want to cold-resume later via attachSession. Emits agents.released (with paused:true in data).",
    sideEffect: 'write',
    source: SRC,
    category: 'primary',
  },
  {
    objectPath: 'agents',
    method: 'attachSession',
    primitivePath: 'agents.attachSession',
    signature: '(id: string, sessionId: string, leaseToken?: string | null, by?: string): Agent',
    description:
      'Swap the bridge session for an existing Agent (rotation, manual re-bind). Does NOT change agent.id — that is the durability invariant. Emits agents.session-swapped.',
    sideEffect: 'write',
    source: SRC,
    category: 'primary',
  },

  // ===================================================================
  // Bindings
  // ===================================================================
  {
    objectPath: 'agents',
    method: 'bind',
    primitivePath: 'agents.bind',
    signature:
      "(id: string, opts: { binding: { scope: 'cross-project'|'project'|'track'|'arc'|'move'|'pack'|'runtime'; ref?: string; note?: string }; by?: string }): Agent",
    description:
      'Attach a scope binding to an Agent. Idempotent on (scope, ref) — re-binding the same target replaces. Emits agents.bound.',
    sideEffect: 'write',
    source: SRC,
    category: 'primary',
  },
  {
    objectPath: 'agents',
    method: 'unbind',
    primitivePath: 'agents.unbind',
    signature: "(id: string, opts: { scope: 'cross-project'|'project'|'track'|'arc'|'move'|'pack'|'runtime'; ref?: string; by?: string }): Agent",
    description: 'Detach a scope binding. Emits agents.unbound if a binding was removed.',
    sideEffect: 'write',
    source: SRC,
    category: 'primary',
  },

  // ===================================================================
  // Self-reflection (THE killer primitive)
  // ===================================================================
  {
    objectPath: 'agents',
    method: 'whoAmI',
    primitivePath: 'agents.whoAmI',
    signature: '(opts?: { sessionId?: string }): Agent | null',
    description:
      "Self-reflection — returns the Agent for the calling session. By default resolves the caller's session via the audit frame's aiSessionId; override with opts.sessionId for testing or to introspect another agent. Returns null when no Agent matches.",
    sideEffect: 'read',
    example: 'const me = await runtime.agents.whoAmI(); // → my role, bindings, handoff, notes',
    source: SRC,
    category: 'primary',
  },

  // ===================================================================
  // Notes
  // ===================================================================
  {
    objectPath: 'agents',
    method: 'addNote',
    primitivePath: 'agents.notes.add',
    signature: "(id: string, opts: { kind: 'self-assessment'|'handoff-summary'|'role-clarification'|'session-swap'|'observation'|string; text: string; by?: string }): Agent",
    description:
      'Append a structured note to an Agent. Used for handoff summaries, self-assessments, observations the next agent should see. Emits agents.note-added.',
    sideEffect: 'write',
    source: SRC,
    category: 'primary',
  },
  {
    objectPath: 'agents',
    method: 'listNotes',
    primitivePath: 'agents.notes.list',
    signature: '(id: string): AgentNote[]',
    description: 'List all notes on an Agent in append order.',
    sideEffect: 'read',
    source: SRC,
    category: 'primary',
  },

  // ===================================================================
  // Readers
  // ===================================================================
  {
    objectPath: 'agents',
    method: 'get',
    primitivePath: 'agents.get',
    signature: '(id: string): Agent | null',
    description: 'Return one Agent by id. Null if not found.',
    sideEffect: 'read',
    source: SRC,
    category: 'primary',
  },
  {
    objectPath: 'agents',
    method: 'bySession',
    primitivePath: 'agents.bySession',
    signature: '(sessionId: string): Agent | null',
    description: 'Find the Agent currently inhabiting a given bridge sessionId.',
    sideEffect: 'read',
    source: SRC,
    category: 'primary',
  },
  {
    objectPath: 'agents',
    method: 'list',
    primitivePath: 'agents.list',
    signature:
      "(opts?: { role?: string; status?: 'active'|'paused'|'released' | Array<'active'|'paused'|'released'>; bindingScope?: 'cross-project'|'project'|'track'|'arc'|'move'|'pack'|'runtime'; bindingRef?: string; project?: string; since?: string; until?: string }): Agent[]",
    description: 'List Agents with optional filters. project shorthand matches any binding whose ref starts with that projectId.',
    sideEffect: 'read',
    source: SRC,
    category: 'primary',
  },
  {
    objectPath: 'agents',
    method: 'count',
    primitivePath: 'agents.count',
    signature: '(opts?: ListOpts): number',
    description: 'Count matching agents.',
    sideEffect: 'read',
    source: SRC,
    category: 'support',
  },

  // ===================================================================
  // Role catalog
  // ===================================================================
  {
    objectPath: 'agents',
    method: 'registerRole',
    primitivePath: 'agents.roles.register',
    signature:
      "(opts: { role: { id: string; label: string; description: string; defaultBindingScopes?: Array<'cross-project'|'project'|'track'|'arc'|'move'|'pack'|'runtime'>; defaultHandoffCwdTemplate?: string; docs?: string }; by?: string }): AgentRoleDef",
    description: 'Register a new Agent role in the open catalog. Emits agents.role-registered.',
    sideEffect: 'write',
    source: SRC,
    category: 'primary',
  },
  {
    objectPath: 'agents',
    method: 'unregisterRole',
    primitivePath: 'agents.roles.unregister',
    signature: '(opts: { id: string; by?: string }): boolean',
    description: 'Unregister a role from the catalog. Returns true if it existed. Emits agents.role-unregistered.',
    sideEffect: 'write',
    source: SRC,
    category: 'support',
  },
  {
    objectPath: 'agents',
    method: 'listRoles',
    primitivePath: 'agents.roles.list',
    signature: '(): AgentRoleDef[]',
    description: 'List all registered roles.',
    sideEffect: 'read',
    source: SRC,
    category: 'primary',
  },
  {
    objectPath: 'agents',
    method: 'getRole',
    primitivePath: 'agents.roles.get',
    signature: '(id: string): AgentRoleDef | null',
    description: 'Look up one role by id.',
    sideEffect: 'read',
    source: SRC,
    category: 'support',
  },

  // -------------------------------------------------------------------
  // sendMessage / getReply / sendMessageAndAwait — Decision 29 contract
  // -------------------------------------------------------------------
  {
    objectPath: 'agents',
    method: 'sendMessage',
    primitivePath: 'agents.sendMessage',
    signature:
      '(agentId: string, opts: { text: string; attachments?: unknown[]; toolPolicy?: "auto"|"restricted"|"none"; by?: string; forceDuplicate?: boolean; idempotencyKey?: string }): Promise<{ replyHandle: string }>',
    description:
      'Fire a message AS the agent and return a replyHandle. Pull-mode: ' +
      'use agents.getReply(handle) to poll chunks. Dispatch by ' +
      'agent.provider.kind; bridge agents delegate to ' +
      'runtime.bridge.sessions.requestReply (cowork-web-bridge >=0.3.0). ' +
      'For non-blocking-poll use cases see agents.sendMessageAndAwait.',
    sideEffect: 'write',
    example:
      "const { replyHandle } = await runtime.agents.sendMessage(agentId, { text: 'Summarize last 3 commits' });",
    source: SRC,
    category: 'primary',
  },
  {
    objectPath: 'agents',
    method: 'getReply',
    primitivePath: 'agents.getReply',
    signature:
      "(replyHandle: string, opts?: { sinceOffset?: number; wait?: 'none'|'long-poll'; timeoutMs?: number }): Promise<ReplyPoll>",
    description:
      'Pull-mode poll the ReplyRecord. Long-poll suspends until new ' +
      'chunks land or status leaves "streaming" or timeoutMs (default ' +
      '25000) elapses. Loop while result.more === true. nextOffset from ' +
      'the prior poll resumes seamlessly across calls — record state ' +
      'survives script.run boundaries.',
    sideEffect: 'read',
    example:
      "let sinceOffset = 0;\nwhile (true) {\n  const p = await runtime.agents.getReply(handle, { sinceOffset, wait: 'long-poll' });\n  for (const c of p.chunks) log(c.kind, c.data);\n  sinceOffset = p.nextOffset;\n  if (p.status !== 'streaming') break;\n}",
    source: SRC,
    category: 'primary',
  },
  {
    objectPath: 'agents',
    method: 'sendMessageAndAwait',
    primitivePath: 'agents.sendMessageAndAwait',
    signature:
      '(agentId: string, opts: { text: string; attachments?: unknown[]; toolPolicy?: "auto"|"restricted"|"none"; by?: string; forceDuplicate?: boolean; idempotencyKey?: string; timeoutMs?: number }): Promise<Reply>',
    description:
      'Convenience wrapper: sendMessage + loop getReply until non-' +
      'streaming. Returns the assembled Reply (text concatenated, ' +
      'toolCalls collected, finalSummary attached). NEVER use for ' +
      'bridge-driven Claude turns — the timeout assumption breaks. ' +
      'Use for short-reply HTTP providers (oversight checks etc.).',
    sideEffect: 'write',
    example:
      "const r = await runtime.agents.sendMessageAndAwait(oversightId, { text: 'Review this Charter change', timeoutMs: 30000 });",
    source: SRC,
    category: 'primary',
  },

  // -------------------------------------------------------------------
  // Replies subsystem read-side
  // -------------------------------------------------------------------
  {
    objectPath: 'replies',
    method: 'get',
    primitivePath: 'agents.replies.get',
    signature: '(handle: string): Promise<ReplyRecord | null>',
    description: 'Return a ReplyRecord by handle (cloned). Null if unknown.',
    sideEffect: 'read',
    source: SRC,
    category: 'support',
  },
  {
    objectPath: 'replies',
    method: 'list',
    primitivePath: 'agents.replies.list',
    signature:
      "(filter?: { agentId?: string; status?: 'streaming'|'complete'|'error'; since?: string }): Promise<ReplyRecord[]>",
    description: 'List ReplyRecords (newest first). Optional filter by agent / status / since.',
    sideEffect: 'read',
    source: SRC,
    category: 'support',
  },
  {
    objectPath: 'replies',
    method: 'count',
    primitivePath: 'agents.replies.count',
    signature:
      "(filter?: { agentId?: string; status?: 'streaming'|'complete'|'error' }): Promise<number>",
    description: 'Count ReplyRecords, optionally filtered.',
    sideEffect: 'read',
    source: SRC,
    category: 'support',
  },

  // -------------------------------------------------------------------
  // Provider registry
  // -------------------------------------------------------------------
  {
    objectPath: 'providers',
    method: 'register',
    primitivePath: 'agents.providers.register',
    signature: '(impl: ProviderImpl): Promise<ProviderInfo>',
    description:
      'Register (or replace) a provider impl. The registry routes ' +
      "agents.sendMessage by agent.provider.kind. Built-ins seeded: " +
      "'bridge' (Claude via cowork-web-bridge) and 'mock' (tests).",
    sideEffect: 'write',
    source: SRC,
    category: 'primary',
  },
  {
    objectPath: 'providers',
    method: 'get',
    primitivePath: 'agents.providers.get',
    signature: '(kind: string): Promise<ProviderInfo | null>',
    description: 'Public info for one registered provider, or null.',
    sideEffect: 'read',
    source: SRC,
    category: 'support',
  },
  {
    objectPath: 'providers',
    method: 'list',
    primitivePath: 'agents.providers.list',
    signature: '(): Promise<ProviderInfo[]>',
    description: 'List all registered providers (sanitized info view).',
    sideEffect: 'read',
    source: SRC,
    category: 'support',
  },
];
