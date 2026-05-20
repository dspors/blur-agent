/**
 * ChatCompletionsSubsystem — OpenAI-aligned `runtime.chat.completions.create`.
 *
 * Decision 34. The first substrate primitive that runs the b:tag loop
 * **without engagement coupling**. Each invocation holds its loop state
 * in a function-scoped closure — N parallel calls have N independent
 * closures, eliminating the cross-contamination bug that hit
 * dispatchToModels (`tkt_7de641e6` and the workbench-2026-05-20b
 * checkpoint).
 *
 * Pipeline per invocation:
 *
 *   1. Reconstitute BlurContext from snapshot if passed across the
 *      script-engine boundary.
 *   2. Build initial messages array = `context.composeMessages()` +
 *      normalize(prompt).
 *   3. Loop:
 *        a. Synthesize a transient Agent record (no registration,
 *           no persistence). Call providerImpl.sendMessage via the
 *           existing ReplyRecord path; poll getReply until complete.
 *        b. Parse `<b:*>` tags from the assembled reply.
 *        c. If no tags → terminate `script-free`. Record iteration.
 *           Return.
 *        d. Execute tags inline (runtime.script.run for b:script /
 *           b:s; resolveBPTag for b:p; runtime.tagWalker resolver
 *           map for descriptive kinds).
 *        e. Build the next iteration's messages (assistant reply +
 *           synthetic tool message holding rendered tag results).
 *        f. iter++. If iter > cap → terminate `cap-reached`.
 *   4. Return ChainResult.
 *
 * Provider invocation in v1 still flattens the messages array to a
 * single string at the boundary (the existing provider.sendMessage
 * interface takes `opts.text`). The internal messages-array shape is
 * maintained so the eventual native-tool-calling switch is a
 * provider-side change, not a primitive-shape change.
 *
 * See also:
 *   - decisions/34-chat-completions-and-blur-context.md
 *   - blur-context.ts
 *   - engagement-flow-subsystem.ts (parallel script-loop; kept until
 *     engagement personality is refactored to consume this primitive)
 */

import { randomUUID } from 'node:crypto';

import type { BlurAIRuntime } from 'blur-ai-runtime';

import {
  parseBTags,
  renderTagResult,
  stringifyScriptReturn,
  type BTag,
} from './b-tags';
import {
  BlurContext,
  type BlurContextSnapshot,
  type ChatMessage,
} from './blur-context';
import type { AgentRepliesSubsystem } from './replies-subsystem';
import type { ProviderRegistry } from './provider-registry';
import type { Agent } from './types';

// ============================================================================
// Public types
// ============================================================================

export interface ModelSpec {
  /** Provider kind — must be registered in the ProviderRegistry. */
  providerKind: string;
  /** Provider-specific model id (e.g. 'llama-3-3-70b-instruct-turbo'). */
  modelId: string;
  /** Provider-specific sampling / generation parameters. */
  options?: Record<string, unknown>;
}

/** Reserved for future native-tool-calling. v1 ignores `tools`. */
export interface ToolDef {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

export interface CreateOpts {
  model: ModelSpec;
  context: BlurContext | BlurContextSnapshot;
  /**
   * Either a raw user-prompt string, or a fully-formed messages array
   * to splice after the context. When a string is passed, it becomes
   * a single `{ role: 'user', content: prompt }` entry.
   */
  prompt: string | ChatMessage[];
  /** Reserved — v1 ignores. */
  tools?: ToolDef[];
  options?: {
    /** Max iterations; defaults to 16. Cap-reached short-circuits. */
    cap?: number;
    /** Per-iteration wall-time. Defaults to 60_000 ms. */
    timeoutMs?: number;
    /** Optional abort signal — caller may cancel. */
    abortSignal?: AbortSignal;
    /** Optional chain id; auto-minted if absent. */
    chainId?: string;
  };
}

export interface IterationRecord {
  iter: number;
  /** Bytes sent to the provider on this iteration (input prompt). */
  inputBytes: number;
  /** Bytes received back (assistant reply text). */
  replyBytes: number;
  /** Tags parsed from the reply. */
  tags: BTag[];
  /** Per-tag execution results. Empty when reply was script-free. */
  tagResults: Array<{ position: number; kind: string; status: 'ok' | 'error'; resultLen: number; error?: string; execMs: number }>;
  /** Provider wall-clock latency for this iteration. */
  latencyMs: number;
  /** Reply text from the model. */
  replyText: string;
}

export interface ChainResult {
  /** Unique id for this invocation. */
  chainId: string;
  /** Full conversation including assistant messages + tool results. */
  messages: ChatMessage[];
  /** Convenience: last assistant message content. */
  finalReply: string;
  /** Per-iteration breakdown. */
  iterations: IterationRecord[];
  /** Why the chain ended. */
  terminationReason:
    | 'script-free'
    | 'cap-reached'
    | 'tag-error'
    | 'provider-error'
    | 'aborted';
  /** Wall-clock total. */
  totalDurationMs: number;
  /** Final BlurContext hash AFTER all iterations (for cache audits). */
  finalContextHash: string;
  /** Set when terminationReason indicates a problem. */
  error?: string;
}

// ============================================================================
// Subsystem
// ============================================================================

export class ChatCompletionsSubsystem {
  // Wired in pack install (like AgentsSubsystem). Not constructor-injected
  // because of circular-dependency ordering between subsystems.
  providerRegistry: ProviderRegistry | null = null;
  repliesRef: AgentRepliesSubsystem | null = null;

  // Recent emissions buffer — diagnostic surface mirroring the
  // engagement-flow pattern. Capped at 200; oldest dropped.
  private recentEvents: Array<{ kind: string; data: Record<string, unknown>; at: string }> = [];
  private static EVENTS_CAP = 200;

  constructor(private readonly runtime: BlurAIRuntime) {}

  // ---------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------

  /**
   * Run a chat-completion chain. Each call is fully self-contained;
   * safe to invoke concurrently across many models/contexts. See
   * Decision 34 for the rationale.
   */
  async create(opts: CreateOpts): Promise<ChainResult> {
    const chainId = opts.options?.chainId ?? `chn_${randomUUID()}`;
    const cap = opts.options?.cap ?? 16;
    const perIterationTimeoutMs = opts.options?.timeoutMs ?? 60_000;
    const abortSignal = opts.options?.abortSignal;
    const startedAt = Date.now();

    // Reconstitute BlurContext from snapshot if needed (script-isolate
    // callers pass plain-data snapshots; in-substrate callers pass the
    // class instance directly).
    const baseContext: BlurContext =
      opts.context instanceof BlurContext
        ? opts.context
        : BlurContext.isSnapshot(opts.context)
          ? BlurContext.fromSnapshot(opts.context as BlurContextSnapshot)
          : BlurContext.fromScratch();

    // Build initial messages: system message (composed layers) + history
    // (already in context) + new prompt (normalized to message[]).
    const promptMessages: ChatMessage[] = normalizePrompt(opts.prompt);
    const messages: ChatMessage[] = baseContext.composeMessages().concat(promptMessages);

    const iterations: IterationRecord[] = [];
    let terminationReason: ChainResult['terminationReason'] = 'script-free';
    let error: string | undefined;
    let iter = 0;

    this.emit('chat.completions.started', {
      chainId,
      providerKind: opts.model.providerKind,
      modelId: opts.model.modelId,
      contextLayers: baseContext.layers.size,
      contextBytes: baseContext.describe().totalBytes,
      promptBytes: messages.reduce((a, m) => a + Buffer.byteLength(m.content, 'utf8'), 0),
    });

    try {
      // Loop. Each iteration calls the provider, parses the reply,
      // either terminates (script-free) or executes tags + dispatches
      // the next iteration.
      while (true) {
        if (abortSignal?.aborted) {
          terminationReason = 'aborted';
          break;
        }

        iter += 1;
        if (iter > cap) {
          terminationReason = 'cap-reached';
          iter -= 1; // record the last completed iter, not the over-cap one
          break;
        }

        this.emit('chat.completions.iteration-started', { chainId, iter });

        const iterStartedAt = Date.now();
        const flattenedText = flattenMessages(messages);
        const inputBytes = Buffer.byteLength(flattenedText, 'utf8');

        // Call the provider. Throws on hard error; we capture and
        // terminate with provider-error.
        let replyText: string;
        try {
          replyText = await this.invokeProvider({
            model: opts.model,
            promptText: flattenedText,
            chainId,
            iter,
            timeoutMs: perIterationTimeoutMs,
          });
        } catch (err) {
          terminationReason = 'provider-error';
          error = (err as Error)?.message ?? String(err);
          this.emit('chat.completions.provider-error', { chainId, iter, error });
          break;
        }

        const replyBytes = Buffer.byteLength(replyText, 'utf8');
        const latencyMs = Date.now() - iterStartedAt;

        // Push assistant reply onto messages.
        messages.push({ role: 'assistant', content: replyText });

        // Parse tags.
        const tags = replyText ? parseBTags(replyText) : [];

        // Terminate naturally if no tags.
        if (tags.length === 0) {
          iterations.push({
            iter,
            inputBytes,
            replyBytes,
            tags: [],
            tagResults: [],
            latencyMs,
            replyText,
          });
          this.emit('chat.completions.iteration-completed', {
            chainId,
            iter,
            tagCount: 0,
            terminationReason: 'script-free',
          });
          terminationReason = 'script-free';
          break;
        }

        // Execute tags. Each tag's result is captured for the iteration
        // record AND spliced into a synthetic tool message for the next
        // iteration's input.
        const tagResults: IterationRecord['tagResults'] = [];
        const renderedBlocks: string[] = [];
        let chainBroke = false;

        for (const tag of tags) {
          if (abortSignal?.aborted) {
            chainBroke = true;
            terminationReason = 'aborted';
            break;
          }
          const tagStartedAt = Date.now();
          let resultText: string;
          let status: 'ok' | 'error' = 'ok';
          let tagError: string | undefined;
          try {
            const r = await this.executeTag(tag);
            if (r.ok === false) {
              status = 'error';
              tagError = r.error ?? 'tag run failed';
              resultText = renderTagResult(tag, 'error', tagError);
            } else {
              const body = stringifyScriptReturn(r.value);
              resultText = renderTagResult(tag, 'ok', body);
            }
          } catch (err) {
            status = 'error';
            tagError = (err as Error)?.message ?? String(err);
            resultText = renderTagResult(tag, 'error', tagError);
          }
          const execMs = Date.now() - tagStartedAt;
          tagResults.push({
            position: tag.position,
            kind: tag.kind,
            status,
            resultLen: resultText.length,
            error: tagError,
            execMs,
          });
          renderedBlocks.push(resultText);
          this.emit('chat.completions.tag-executed', {
            chainId, iter, position: tag.position, kind: tag.kind, status, error: tagError, execMs,
          });
        }

        iterations.push({ iter, inputBytes, replyBytes, tags, tagResults, latencyMs, replyText });
        this.emit('chat.completions.iteration-completed', {
          chainId,
          iter,
          tagCount: tags.length,
          terminationReason: chainBroke ? terminationReason : undefined,
        });

        if (chainBroke) break;

        // Splice tag results into the conversation as a single
        // synthetic 'tool' message. (We use a single message because
        // multiple tag results conceptually belong to one model turn;
        // representing them as separate tool messages would require
        // tool_call_ids which we don't have in the b:tag path.)
        messages.push({
          role: 'tool',
          content: renderedBlocks.join('\n\n'),
          name: 'b-tag-results',
        });
      }
    } finally {
      // Always emit completed so subscribers can clean up.
      this.emit('chat.completions.completed', {
        chainId,
        terminationReason,
        iterations: iterations.length,
        totalDurationMs: Date.now() - startedAt,
        error,
      });
    }

    // finalReply = last assistant message content (or empty if no
    // iteration ran).
    let finalReply = '';
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant') {
        finalReply = messages[i].content;
        break;
      }
    }

    const finalCtx = baseContext.withHistoryAppended(...messages.filter(m => m.role !== 'system'));
    return {
      chainId,
      messages,
      finalReply,
      iterations,
      terminationReason,
      totalDurationMs: Date.now() - startedAt,
      finalContextHash: finalCtx.describe().hash,
      error,
    };
  }

  /**
   * Diagnostic — recent audit events from chat.completions chains.
   * Mirrors `engagementFlow.recentEmissions`. Capped at 200 entries.
   */
  recentEmissions(opts?: { kind?: string; chainId?: string; limit?: number }):
    Array<{ kind: string; data: Record<string, unknown>; at: string }>
  {
    const limit = opts?.limit ?? 80;
    let events = this.recentEvents.slice();
    if (opts?.kind) events = events.filter(e => e.kind === opts.kind);
    if (opts?.chainId) events = events.filter(e => (e.data as { chainId?: string }).chainId === opts.chainId);
    return events.slice(-limit);
  }

  // ---------------------------------------------------------------------
  // Private — provider invocation
  // ---------------------------------------------------------------------

  /**
   * Synthesize a transient Agent record and dispatch directly through
   * the provider registry. The agent is NEVER registered, NEVER
   * persisted — it exists only for the duration of this provider call
   * so the existing provider.sendMessage(agent, opts, replies) shape
   * works.
   *
   * Returns the assembled reply text. Throws on provider error.
   */
  private async invokeProvider(opts: {
    model: ModelSpec;
    promptText: string;
    chainId: string;
    iter: number;
    timeoutMs: number;
  }): Promise<string> {
    if (!this.providerRegistry || !this.repliesRef) {
      throw new Error(
        'chat.completions: providerRegistry or replies subsystem not wired. ' +
        'Pack install may be incomplete.',
      );
    }
    const impl = this.providerRegistry.get(opts.model.providerKind);
    if (!impl) {
      throw new Error(
        `chat.completions: no provider impl registered for kind '${opts.model.providerKind}'. ` +
        `Known: ${this.providerRegistry.list().map(p => p.kind).join(', ') || '<none>'}`,
      );
    }

    // Synthetic Agent for the provider call. Provider impls read
    // .id / .label / .provider.{kind,model} — that's all. We deliberately
    // pass agent.id = 'agt_chain_*' so any audit downstream can attribute
    // back to this chain rather than a real agent.
    const syntheticAgent = {
      id: `agt_chain_${opts.chainId.slice(4, 12)}`,
      label: `chat.completions/${opts.chainId.slice(4, 12)}`,
      status: 'active' as const,
      provider: {
        kind: opts.model.providerKind,
        model: opts.model.modelId,
      },
      createdAt: new Date().toISOString(),
      sessionRotations: [],
      notes: [],
      bindings: [],
    } as unknown as Agent;

    // Dispatch. impl.sendMessage opens a ReplyRecord; we long-poll it.
    // SendMessageOpts.model is a STRING (modelId) used by D29-style
    // providers as a per-dispatch override. modelId is already set on
    // the synthetic agent's provider; we pass it again here so D29
    // adapters that prefer opts.model over agent.provider.model pick
    // it up. Provider-specific options (sampling, etc.) ride on the
    // agent's provider record.
    const sendResult = await impl.sendMessage(
      syntheticAgent,
      {
        text: opts.promptText,
        model: opts.model.modelId,
      },
      this.repliesRef,
    );
    if (!sendResult?.replyHandle) {
      throw new Error(
        `chat.completions: provider '${opts.model.providerKind}' returned no replyHandle`,
      );
    }

    // Accumulate streaming chunks until status leaves 'streaming'.
    const replyHandle = sendResult.replyHandle;
    const deadline = Date.now() + opts.timeoutMs;
    const textParts: string[] = [];
    let sinceOffset = 0;
    let finalStatus = 'streaming';
    let errorMessage: string | undefined;

    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      const pollTimeout = Math.min(remaining, 25_000);
      if (pollTimeout <= 0) break;
      const poll = await this.repliesRef.getReply(replyHandle, {
        sinceOffset,
        wait: 'long-poll',
        timeoutMs: pollTimeout,
      });
      for (const c of poll.chunks) {
        if (c.kind === 'text') {
          if (typeof c.data === 'string') {
            textParts.push(c.data);
          } else if (c.data && typeof (c.data as { text?: unknown }).text === 'string') {
            textParts.push((c.data as { text: string }).text);
          }
        }
        // tool-call chunks ignored in v1 (no native-tools yet)
      }
      sinceOffset = poll.nextOffset;
      finalStatus = String(poll.status);
      errorMessage = poll.errorMessage;
      if (poll.status !== 'streaming') break;
    }

    if (finalStatus === 'error') {
      throw new Error(`chat.completions: reply errored — ${errorMessage ?? 'unknown'}`);
    }
    if (finalStatus !== 'complete') {
      throw new Error(`chat.completions: reply did not complete within ${opts.timeoutMs}ms`);
    }
    return textParts.join('');
  }

  // ---------------------------------------------------------------------
  // Private — tag execution (mirrors engagement-flow's loop body)
  // ---------------------------------------------------------------------

  /**
   * Run a single tag. Dispatches by kind:
   *   - b:script / b:s — runtime.script.run (escape hatch)
   *   - b:p            — legacy property read (unsupported here in v1;
   *                      caller can use b:script as workaround)
   *   - b:<word>       — walker resolver (Decision 37)
   *
   * Returns `{ ok, value, error }`.
   */
  private async executeTag(tag: BTag): Promise<{ ok?: boolean; value?: unknown; error?: string }> {
    const runtime = this.runtime as unknown as {
      script?: { run?: (src: string) => Promise<{ ok?: boolean; value?: unknown; error?: string }> };
      tagWalker?: {
        resolvers?: () => Record<string, (tag: BTag) => Promise<{ ok?: boolean; value?: unknown; error?: string }>>;
      };
    };

    if (tag.kind === 'b:script' || tag.kind === 'b:s') {
      const scriptHost = runtime.script;
      if (!scriptHost || typeof scriptHost.run !== 'function') {
        return { ok: false, error: 'runtime.script.run unavailable on host' };
      }
      return scriptHost.run(tag.body);
    }

    // Descriptive tag — look up resolver via the walker.
    const resolvers = runtime.tagWalker?.resolvers?.();
    if (resolvers && resolvers[tag.kind]) {
      return resolvers[tag.kind](tag);
    }

    return { ok: false, error: `chat.completions: no resolver for tag kind '${tag.kind}'` };
  }

  // ---------------------------------------------------------------------
  // Private — emissions
  // ---------------------------------------------------------------------

  private emit(kind: string, data: Record<string, unknown>): void {
    const event = { kind, data: { ...data }, at: new Date().toISOString() };
    this.recentEvents.push(event);
    if (this.recentEvents.length > ChatCompletionsSubsystem.EVENTS_CAP) {
      this.recentEvents.shift();
    }
    // Best-effort audit emit — degrade gracefully if not available.
    try {
      const audit = (this.runtime as unknown as { audit?: { emit?: (kind: string, ref: string, data: Record<string, unknown>) => void } }).audit;
      const chainId = (data as { chainId?: string }).chainId;
      const ref = chainId ? `item:chains[${chainId}]` : 'item:chat.completions';
      if (audit && typeof audit.emit === 'function') {
        audit.emit(kind, ref, data);
      }
    } catch {
      /* swallow */
    }
  }
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Normalize the `prompt` arg to a ChatMessage array. Strings become a
 * single user message; arrays pass through unchanged (defensive copy).
 */
function normalizePrompt(prompt: string | ChatMessage[]): ChatMessage[] {
  if (typeof prompt === 'string') {
    return [{ role: 'user', content: prompt }];
  }
  if (Array.isArray(prompt)) {
    return prompt.slice();
  }
  throw new Error('chat.completions: prompt must be a string or ChatMessage[]');
}

/**
 * Flatten a messages array into a single text blob for v1 providers
 * that take `opts.text` (string). The system message becomes the
 * top-level prefix; subsequent messages are role-tagged with a simple
 * delimiter so the model can see speaker boundaries.
 *
 * Format:
 *   <system content>
 *   \n──\n
 *   user: <text>
 *   \n──\n
 *   assistant: <text>
 *   \n──\n
 *   tool: <results>
 *   \n──\n
 *   user: <new prompt>
 *
 * Byte-deterministic given identical messages.
 */
function flattenMessages(messages: ChatMessage[]): string {
  const parts: string[] = [];
  for (const m of messages) {
    if (m.role === 'system') {
      // System content goes verbatim at the top; no role prefix.
      parts.push(m.content);
    } else {
      parts.push(`${m.role}: ${m.content}`);
    }
  }
  return parts.join('\n──\n');
}
