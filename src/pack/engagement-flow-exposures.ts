/**
 * Exposures for the EngagementFlowSubsystem.
 *
 * Mounted at `runtime.engagementFlow.*`. Read-only surface — the
 * subsystem's mutations all run from audit subscribers, not from
 * script-facing primitives.
 *
 * Per SA-Engagement-Flow.md the hot session reads `getPrepData(...)`
 * to fetch its first user message context after `prep-complete` fires.
 */

import type { MethodExposure } from 'blur-ai-runtime';

export const engagementFlowExposures: MethodExposure[] = [
  {
    objectPath: 'engagementFlow',
    method: 'getPrepData',
    primitivePath: 'engagementFlow.getPrepData',
    signature: '(engagementId: string): PrepData | null',
    description:
      'Read the PrepData blob the Secretary assembled for an Engagement. Returns null if prep has not run (or did not run — e.g. ai-only shape, or profile.hints.skipSecretaryPrep). The hot session reads this as its first user message after engagements.secretary.prep-complete fires.',
    sideEffect: 'read',
    example: "const ctx = await runtime.engagementFlow.getPrepData('eng_abc123');",
    category: 'primary',
  },
  {
    objectPath: 'engagementFlow',
    method: 'listPrepData',
    primitivePath: 'engagementFlow.listPrepData',
    signature: '(): Array<{ engagementId: string; prepData: PrepData }>',
    description:
      'List all prep entries currently in memory. Diagnostic / inspector primitive — production callers should fetch by engagementId via getPrepData.',
    sideEffect: 'read',
    category: 'support',
  },
  {
    objectPath: 'engagementFlow',
    method: 'listAccumulatedOutputs',
    primitivePath: 'engagementFlow.listAccumulatedOutputs',
    signature: '(engagementId: string): LinkedOutput[]',
    description:
      'List output candidates the linker has accumulated for an Engagement during its window. Diagnostic — under normal flow the linker emits engagements.secretary.linker-complete with the resolved list.',
    sideEffect: 'read',
    category: 'support',
  },
  {
    objectPath: 'engagementFlow',
    method: 'runSecretaryPrep',
    primitivePath: 'engagementFlow.runSecretaryPrep',
    signature: '(engagementId: string): Promise<PrepData>',
    description:
      'Manually run the Secretary auto-prep pipeline for an Engagement. Normally fires automatically on engagements.opened; this primitive is for tests and host-side overrides. Idempotent — returns the existing PrepData if prep already ran.',
    sideEffect: 'write',
    category: 'support',
  },
  {
    objectPath: 'engagementFlow',
    method: 'dispatchTurn',
    primitivePath: 'engagementFlow.dispatchTurn',
    signature:
      "(engagementId: string, opts: { text: string; by?: string; agentId?: string; outcome?: string; pin?: string; activityTable?: Record<string, { mode: 'always'|'auto'|'ai'; default: string | null; outcomes?: Record<string, string> }>; complexity?: 'routine'|'specialized' }): Promise<{ turnId: string; replyHandle: string; agentId: string; ticketId?: string; promptLen: number; prepSpliced: boolean }>",
    description:
      "One-call dispatch façade for a Turn on an Engagement. Resolves the agent (opts.agentId | engagement.preferredAgentId | engagement.boundAgentIds[0]), splices PrepData into the prompt on Turn #1, routes through scheduler.requestTurn (Decision 34 ticket model) when wired, links via engagements.addTurn, emits engagements.turn-queued. Returns { turnId, replyHandle, agentId, ticketId, promptLen, prepSpliced }. Decision 36 step 1: pin, activityTable, complexity are forwarded verbatim to scheduler.requestTurn — recorded on ticket.requestOverrides + audit; routing behavior unchanged in v0.",
    sideEffect: 'external',
    example:
      "const t = await runtime.engagementFlow.dispatchTurn('eng_abc', { text: 'Summarize last 3 commits', by: 'user', pin: 'together/gpt-oss-120b' });",
    category: 'primary',
  },
  {
    objectPath: 'engagementFlow',
    method: 'runSchedulerLease',
    primitivePath: 'engagementFlow.runSchedulerLease',
    signature:
      '(engagementId: string, opts?: { mock?: boolean }): Promise<{ sessionId: string; providerKind: string; agentId: string }>',
    description:
      'Manually run the Scheduler auto-lease for an Engagement. Normally fires automatically on engagements.opened (in parallel with prep); this primitive is for tests. Pass { mock: true } to skip the pool and produce a synthetic mock session (smoke-test convenience).',
    sideEffect: 'write',
    category: 'support',
  },
  {
    objectPath: 'engagementFlow',
    method: 'runLinker',
    primitivePath: 'engagementFlow.runLinker',
    signature: '(engagementId: string): Promise<LinkedOutput[]>',
    description:
      'Manually run the Result-linker for a completed Engagement. Normally fires automatically on engagements.completed; this primitive is for tests and recovery.',
    sideEffect: 'write',
    category: 'support',
  },
  {
    objectPath: 'engagementFlow',
    method: 'recentEmissions',
    primitivePath: 'engagementFlow.recentEmissions',
    signature:
      '(opts?: { kind?: string; engagementId?: string; limit?: number }): Array<{ kind: string; ref?: string; data?: Record<string, unknown>; at: string }>',
    description:
      'Diagnostic — recent audit events emitted by the engagement-flow subsystem. Lets callers verify the contract without subscribing to runtime.audit (script isolates cannot marshal handler closures). Capped at 200 entries; oldest dropped.',
    sideEffect: 'read',
    category: 'support',
  },
  {
    objectPath: 'engagementFlow',
    method: 'emissionStats',
    primitivePath: 'engagementFlow.emissionStats',
    signature: '(): Record<string, number>',
    description:
      'Diagnostic — count of each audit event kind emitted by the engagement-flow subsystem since pack install.',
    sideEffect: 'read',
    category: 'support',
  },
  {
    objectPath: 'engagementFlow',
    method: 'inspectScriptLoopState',
    primitivePath: 'engagementFlow.inspectScriptLoopState',
    signature: '(): { iterationCounts: Record<string, number>; turnToEngagementSize: number; turnToEngagementSample: Array<{turnId, engagementId}>; historyAppendActivities: string[] }',
    description:
      'Diagnostic — read the script-loop subscriber\'s in-memory state. `turnToEngagement` is the turnId→engagementId index populated by `engagements.turn-added`; it\'s an O(1) cache for the per-Turn-completion handler. `iterationCounts` tracks per-engagement iteration depth within a script-loop chain. Note: "live" engagement state is NOT cached here — `engagement.status` is checked on demand against the durable store, no shadow set.',
    sideEffect: 'read',
    category: 'support',
  },
  {
    objectPath: 'engagementFlow',
    method: 'getTurnStats',
    primitivePath: 'engagementFlow.getTurnStats',
    signature: '(turnId: string): TurnStats | null',
    description:
      'Per-Turn timing + size statistics captured by the state-advancement-loop handler (see runtime.library.get("state-advancement-loop")). Returns durationMs, prefixLen, replyLen, tagCount, scriptExecMs, scriptResultBytes, providerKind, agentId, iter, loopRole, terminationReason. Returns null when the Turn hasn\'t completed yet, was opened before this pack started, or was evicted from the in-memory cap (500 most-recent Turns retained).',
    sideEffect: 'read',
    example: "const s = await runtime.engagementFlow.getTurnStats('tur_abc'); // → { durationMs: 18421, scriptExecMs: 12, tagCount: 1, … }",
    category: 'support',
  },
  {
    objectPath: 'engagementFlow',
    method: 'getEngagementStats',
    primitivePath: 'engagementFlow.getEngagementStats',
    signature: '(engagementId: string, opts?: { limit?: number }): EngagementStats',
    description:
      'Aggregate the in-memory TurnStats for an engagement. Returns { totalTurns, totalTagCount, totalScriptExecMs, totalDurationMs, meanDurationMs, recent[] }. Recent is newest-first, capped by opts.limit (default 50, max 500). Counts cover the script-loop chain for each user-initiated Turn (each iteration recorded separately in v1; loopRole field distinguishes user-initiated from script-loop continuations).',
    sideEffect: 'read',
    example: "const s = await runtime.engagementFlow.getEngagementStats('eng_abc', { limit: 10 });",
    category: 'support',
  },
  // engagementFlow.json is auto-exposed by the runtime for Persistable objects (decision 20).
];
