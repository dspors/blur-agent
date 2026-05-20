/**
 * Exposures for the ChatCompletionsSubsystem.
 *
 * Mounted at `runtime.chat.completions.*` (Decision 34 — OpenAI-aligned
 * namespace). Plus `runtime.context.*` for the BlurContext factories.
 *
 * The `create` method is the main primitive: takes a model spec, a
 * BlurContext (or snapshot), a prompt, returns a ChainResult.
 */

import type { MethodExposure } from 'blur-ai-runtime';

export const chatCompletionsExposures: MethodExposure[] = [
  {
    objectPath: 'chat.completions',
    method: 'create',
    primitivePath: 'chat.completions.create',
    signature:
      "(opts: { model: { providerKind: string; modelId: string; options?: Record<string, unknown> }; context: BlurContext | BlurContextSnapshot; prompt: string | ChatMessage[]; tools?: ToolDef[]; options?: { cap?: number; timeoutMs?: number; abortSignal?: AbortSignal; chainId?: string } }): Promise<ChainResult>",
    description:
      'Run a chat-completion chain. Decision 34. Self-contained — no engagement, no agent, no shared state. Safe to call concurrently for parallel-fan-out (workbench compare-models). Each call holds its loop state in a function-scoped closure. Returns the full conversation including b:tag execution results, plus per-iteration stats and a termination reason. v1 flattens messages to opts.text at the provider boundary; native tool-calling and provider-native messages-array are future work but the primitive shape is forward-compatible.',
    sideEffect: 'external',
    example:
      "const ctx = await runtime.context.fromActivity({ activityId: 'compare-models' });\nconst result = await runtime.chat.completions.create({\n  model: { providerKind: 'together', modelId: 'llama-3-3-70b-instruct-turbo' },\n  context: ctx,\n  prompt: 'Reply with the answer.',\n});",
    category: 'primary',
  },
  {
    objectPath: 'chat.completions',
    method: 'recentEmissions',
    primitivePath: 'chat.completions.recentEmissions',
    signature:
      "(opts?: { kind?: string; chainId?: string; limit?: number }): Array<{ kind: string; data: Record<string, unknown>; at: string }>",
    description:
      "Diagnostic — recent audit events from chat.completions chains. Capped at 200. Mirrors engagementFlow.recentEmissions; lets script-isolate callers verify chain progress without subscribing to runtime.audit.",
    sideEffect: 'read',
    category: 'support',
  },
];

/**
 * Context-builder exposures. Mounted at `runtime.context.*`.
 *
 * The factories return `BlurContextSnapshot` (plain data) to scripts —
 * the class instance doesn't round-trip through V8 isolates. The
 * chat.completions.create call accepts either the live instance OR a
 * snapshot, so this round-trips cleanly.
 */
export const contextExposures: MethodExposure[] = [
  {
    objectPath: 'context',
    method: 'fromActivity',
    primitivePath: 'context.fromActivity',
    signature:
      "(opts: { activityId: string; agentId?: string; projectId?: string; snapshotText?: string; snapshotAt?: string; surface?: { include?: '*' | string[]; exclude?: string[] }; syntheticEngagementId?: string }): Promise<BlurContextSnapshot>",
    description:
      'Compose a BlurContext from an Activity (+ optional agent / project). Wraps composePrefix; each layer is slotted into a named map (intro / activity / catalog / role / state). Returns a plain-data snapshot; pass it directly to chat.completions.create. Activity not found → graceful degradation (placeholder layer).',
    sideEffect: 'read',
    example:
      "const ctx = await runtime.context.fromActivity({ activityId: 'compare-models' });",
    category: 'primary',
  },
  {
    objectPath: 'context',
    method: 'fromScratch',
    primitivePath: 'context.fromScratch',
    signature: '(): BlurContextSnapshot',
    description:
      'Empty BlurContext. Caller adds layers via withLayer (call from a substrate runner, or build the snapshot directly in a script).',
    sideEffect: 'read',
    category: 'support',
  },
  {
    objectPath: 'context',
    method: 'fromComposed',
    primitivePath: 'context.fromComposed',
    signature: '(rawText: string): BlurContextSnapshot',
    description:
      "Wrap a pre-composed prefix string in a BlurContext (single 'custom-composed' layer). Convenience for callers that already have a prefix and want to route through chat.completions.",
    sideEffect: 'read',
    category: 'support',
  },
  {
    objectPath: 'context',
    method: 'describe',
    primitivePath: 'context.describe',
    signature: '(snapshot: BlurContextSnapshot): { totalBytes: number; layerCount: number; historyCount: number; layerSizes: Record<string, number>; layerHashes: Record<string, string>; hash: string }',
    description:
      'Per-layer byte sizes + SHA-256 hashes + overall hash for a snapshot. Used by tuning UIs (show layer breakdown) and cache-discipline audits (verify byte-stability).',
    sideEffect: 'read',
    category: 'support',
  },
];
