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

/**
 * Credential reference passed into a chain. The engine resolves these
 * once at chain start; resolved values are substituted into tag bodies
 * at execution time and scrubbed from audit payloads. Values never
 * cross back to the caller — chat.completions is the only place they
 * touch (post-resolution).
 *
 * source='config' refs are dereferenced via runtime.config.getRaw with
 * an auto-generated reason; source='session' refs ship the value
 * inline (caller already resolved it).
 *
 * The substitution syntax is ${alias} inside tag bodies (e.g. b:script
 * source: `runtime.http.fetch('https://x', { auth: '${apiKey}' })`).
 */
export interface ChatCredentialRef {
  source: 'config' | 'session';
  /** Required when source='config'. */
  namespace?: string;
  /** ConfigManager key (when source='config') OR identifier (when source='session'). */
  key: string;
  /** What the LLM sees in tag bodies — substituted by the engine before execution. */
  alias: string;
  /** Inline value when source='session'. Ignored when source='config'. */
  value?: string;
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
  /**
   * Per-chain b:tag allowlist. When set, any tag whose kind isn't in
   * this list short-circuits with a structured "tag not allowed"
   * result; the chain CONTINUES (does not abort). When empty or
   * undefined, no restriction applies (back-compat default).
   *
   * Composed by the intelligence dispatcher from a service's bundle
   * references + explicit tags + caller-supplied extraTools. Passed
   * verbatim here so chat.completions stays bundle-agnostic.
   */
  allowedTags?: string[];
  /**
   * Credential refs the engine resolves at chain start. Aliases
   * substituted into tag bodies before execution; resolved values
   * scrubbed from emit() payloads.
   */
  credentials?: ChatCredentialRef[];
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

    // -------------------------------------------------------------------
    // Phase 3 — resolve credentials ONCE at chain start.
    //
    // alias -> value map drives substitution at tag execution time.
    // Audit scrubbing reverses the map (value -> '<credential:alias>').
    // Values never appear in emit() payloads, ChainResult, or anywhere
    // else that crosses out of the engine.
    //
    // Failures are fatal: a service that declares it needs credential X
    // shouldn't run with X missing. We throw early before any model
    // dispatch happens.
    // -------------------------------------------------------------------
    const credentialMap = new Map<string, string>(); // alias -> resolved value
    const scrubMap: Array<{ value: string; alias: string }> = []; // value -> alias (for audit scrub)
    if (opts.credentials && opts.credentials.length > 0) {
      for (const ref of opts.credentials) {
        if (!ref || typeof ref.alias !== 'string' || !ref.alias) {
          throw new Error(`chat.completions: credential ref missing required 'alias'`);
        }
        if (credentialMap.has(ref.alias)) {
          throw new Error(`chat.completions: duplicate credential alias '${ref.alias}'`);
        }
        let value: string;
        if (ref.source === 'session') {
          if (typeof ref.value !== 'string') {
            throw new Error(`chat.completions: credential alias '${ref.alias}' (source=session) requires inline 'value'`);
          }
          value = ref.value;
        } else if (ref.source === 'config') {
          if (typeof ref.namespace !== 'string' || !ref.namespace) {
            throw new Error(`chat.completions: credential alias '${ref.alias}' (source=config) requires 'namespace'`);
          }
          if (typeof ref.key !== 'string' || !ref.key) {
            throw new Error(`chat.completions: credential alias '${ref.alias}' (source=config) requires 'key'`);
          }
          const config = (this.runtime as unknown as {
            config?: { getRaw?: (ns: string, key: string, o: { reason: string }) => Promise<unknown> };
          }).config;
          if (!config || typeof config.getRaw !== 'function') {
            throw new Error(
              `chat.completions: credential alias '${ref.alias}' requires runtime.config.getRaw — ConfigManager not wired`,
            );
          }
          const raw = await config.getRaw(ref.namespace, ref.key, {
            reason: `chat.completions chainId=${chainId} alias=${ref.alias}`,
          });
          if (raw === null || raw === undefined) {
            throw new Error(
              `chat.completions: credential '${ref.namespace}/${ref.key}' (alias '${ref.alias}') not found in ConfigManager`,
            );
          }
          value = typeof raw === 'string' ? raw : JSON.stringify(raw);
        } else {
          throw new Error(`chat.completions: credential alias '${ref.alias}' has unknown source '${(ref as { source?: unknown }).source}'`);
        }
        credentialMap.set(ref.alias, value);
        // Track for audit-scrub. Skip empty values (would scrub everything).
        if (value.length > 0) {
          scrubMap.push({ value, alias: ref.alias });
        }
      }
      // Longer values must be scrubbed before shorter overlapping ones
      // (e.g. if alias A's value contains alias B's). Sort by descending length.
      scrubMap.sort((a, b) => b.value.length - a.value.length);
      // Register scrub for this chain so emit() can scrub event payloads.
      this.chainScrubs.set(chainId, scrubMap);
    }

    // Normalize allowedTags. Per CreateOpts contract: empty/undefined
    // means "no restriction" (back-compat). Only a non-empty list
    // engages enforcement.
    const allowedTagSet =
      Array.isArray(opts.allowedTags) && opts.allowedTags.length > 0
        ? new Set(opts.allowedTags)
        : null;

    // tkt_633d0117 follow-up — accept BOTH Blur canonical modelRefs
    // (e.g. "qwen-2-1-5b-instruct", the suffix of a Model Table row
    // keyed "together/qwen-2-1-5b-instruct") AND provider-native IDs
    // (e.g. "arize-ai/qwen-2-1.5b-instruct"). If the requested
    // modelId resolves to a Model Table row, swap in the row's
    // providerModelId for dispatch; otherwise pass through unchanged.
    //
    // Why translate here, not in the provider: the Model Table is a
    // substrate concept (Decision 36). Providers shouldn't know about
    // it. Doing the swap once at the chat.completions boundary keeps
    // every dispatch path (scheduler.requestTurn vs chat.completions
    // vs direct agents.sendMessage) using the same resolved value the
    // vendor SDK expects.
    //
    // The translation only fires when the candidate
    // `${providerKind}/${modelId}` matches a modelRef in the table.
    // Provider-native IDs that include vendor prefixes (e.g.
    // "openai/gpt-oss-120b") build candidates like
    // "together/openai/gpt-oss-120b" which never match a modelRef
    // (modelRefs follow `<providerKind>/<single-segment>`), so they
    // pass through untouched.
    const requestedModelId = opts.model.modelId;
    const resolvedModelId = this.resolveProviderModelId(
      opts.model.providerKind,
      requestedModelId,
    );
    const dispatchModel: ModelSpec = resolvedModelId === requestedModelId
      ? opts.model
      : { ...opts.model, modelId: resolvedModelId };


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
      // modelId is the value DISPATCHED to the provider — already
      // Model-Table-resolved when caller passed a Blur modelRef.
      // requestedModelId surfaces the caller's original input so
      // diagnostics can see when a translation occurred.
      modelId: dispatchModel.modelId,
      ...(requestedModelId !== dispatchModel.modelId
        ? { requestedModelId }
        : {}),
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
            model: dispatchModel,
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

          // ---------------- Phase 3 — allowlist enforcement ----------------
          // When allowedTags is set and tag.kind isn't in it, short-circuit
          // with a structured error. Chain CONTINUES (does not abort) — the
          // model sees the deny result and can adjust.
          if (allowedTagSet && !allowedTagSet.has(tag.kind)) {
            status = 'error';
            tagError = `tag kind '${tag.kind}' not in this chain's allowlist`;
            resultText = renderTagResult(tag, 'error', tagError);
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
            this.emit('chat.completions.tag-denied', {
              chainId, iter, position: tag.position, kind: tag.kind, reason: 'allowlist',
            });
            continue;
          }

          try {
            // -------- Phase 3 — credential substitution --------
            // Substitute ${alias} in tag body before dispatch. Tags are
            // immutable by spec; we build a shallow-modified clone so
            // executeTag sees the substituted body. The model never sees
            // the substituted value — only the engine and the dispatched
            // primitive do.
            let execTag: BTag = tag;
            if (credentialMap.size > 0 && typeof tag.body === 'string' && tag.body.includes('${')) {
              const substituted = substituteCredentials(tag.body, credentialMap);
              if (substituted !== tag.body) {
                execTag = { ...tag, body: substituted };
              }
            }

            const r = await this.executeTag(execTag);
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

          // -------- Phase 3 — scrub credential values from result text --------
          // The result text is concatenated into the tool message sent
          // back to the model. If a credential value leaked through (e.g.
          // an HTTP response echoes the credential), replace it with
          // <credential:alias>.
          if (scrubMap.length > 0) {
            resultText = scrubText(resultText, scrubMap);
            if (tagError) tagError = scrubText(tagError, scrubMap);
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
      // Phase 3 — release the per-chain scrub map. Done AFTER the
      // final emit so the completed event still scrubs.
      this.chainScrubs.delete(chainId);
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

    // Engagement-flow owns the b:p (legacy property-read) and
    // descriptive entity-tag resolvers. We delegate to keep walker
    // integration single-source-of-truth there. Decision 34 keeps
    // chat.completions independent of engagement SEMANTICS (no agent,
    // no history, no audit), only borrows the tag-execution machinery.
    // Look up via runtime.extensions (the substrate-side reference
    // doesn't have `runtime.engagementFlow` as a direct property).
    const extensions = (this.runtime as unknown as {
      extensions?: { get?: (name: string) => unknown };
    }).extensions;
    const engagementFlow = extensions?.get?.('engagementFlow') as
      | {
          resolveGenericTag?: (tag: BTag) => Promise<{ ok?: boolean; value?: unknown; error?: string }>;
          resolveBPTag?: (tag: BTag) => Promise<{ ok?: boolean; value?: unknown; error?: string }>;
        }
      | undefined;

    // Legacy b:p — property-read shape (deprecated per Decision 37 but
    // kept functional during migration). Must dispatch BEFORE the
    // generic walker resolver, otherwise b:p falls through to the
    // "unknown entity tag" path.
    if (tag.kind === 'b:p') {
      if (engagementFlow && typeof engagementFlow.resolveBPTag === 'function') {
        return engagementFlow.resolveBPTag(tag);
      }
      return { ok: false, error: 'chat.completions: <b:p> requires runtime.engagementFlow.resolveBPTag (unavailable)' };
    }

    // Descriptive tag (Decision 37) — dispatch by action attribute
    // via walker resolver map.
    if (engagementFlow && typeof engagementFlow.resolveGenericTag === 'function') {
      return engagementFlow.resolveGenericTag(tag);
    }

    return { ok: false, error: `chat.completions: no resolver for tag kind '${tag.kind}' (runtime.engagementFlow.resolveGenericTag unavailable)` };
  }

  // ---------------------------------------------------------------------
  // Private — model resolution
  // ---------------------------------------------------------------------

  /**
   * tkt_633d0117 follow-up. Consult the Model Table (Decision 36) for
   * a row whose `modelRef` matches `${providerKind}/${modelId}`. When
   * found, returns the row's `providerModelId` (what the vendor SDK
   * expects); otherwise returns the input modelId unchanged.
   *
   * Failure modes (all return the input unchanged):
   *   - runtime.tables not wired (older runtime, mock test fixture)
   *   - tables.listModels throws
   *   - no row matches the candidate modelRef
   *
   * This is the ONLY place chat.completions interprets the modelId —
   * downstream uses the resolved value verbatim.
   */
  private resolveProviderModelId(providerKind: string, modelId: string): string {
    if (!modelId || typeof modelId !== 'string') return modelId;
    const candidateRef = `${providerKind}/${modelId}`;
    type ModelRow = { modelRef: string; providerKind: string; providerModelId: string };
    const tables = (this.runtime as unknown as {
      tables?: { listModels?: () => ModelRow[] };
    }).tables;
    if (!tables || typeof tables.listModels !== 'function') return modelId;
    let rows: ModelRow[];
    try {
      rows = tables.listModels() ?? [];
    } catch {
      return modelId;
    }
    for (const row of rows) {
      if (row && row.modelRef === candidateRef) {
        return typeof row.providerModelId === 'string' && row.providerModelId
          ? row.providerModelId
          : modelId;
      }
    }
    return modelId;
  }

  // ---------------------------------------------------------------------
  // Private — emissions
  // ---------------------------------------------------------------------

  private emit(kind: string, data: Record<string, unknown>): void {
    // Phase 3 — defensive scrub on every emit. If this chain has
    // credentials, the scrubMap (stored per-chain) replaces values
    // with alias markers anywhere they appear in stringified payloads.
    // The map is consulted via a thread-local-ish field set by
    // create() at chain start; in JS there's no real TLS, so we use
    // a per-emit lookup keyed on chainId in `data`. To keep emit()
    // pure-additive, the scrub list lives on the instance under
    // a private chainId → scrubMap map populated by create().
    const chainId = (data as { chainId?: string }).chainId;
    const scrub = chainId ? this.chainScrubs.get(chainId) : undefined;
    // scrubDeep preserves shape — when fed Record<string,unknown>, returns
    // Record<string,unknown>. Cast accordingly.
    const scrubbed: Record<string, unknown> =
      scrub && scrub.length > 0
        ? (scrubDeep(data, scrub) as Record<string, unknown>)
        : data;

    const event = { kind, data: { ...scrubbed }, at: new Date().toISOString() };
    this.recentEvents.push(event);
    if (this.recentEvents.length > ChatCompletionsSubsystem.EVENTS_CAP) {
      this.recentEvents.shift();
    }
    // Best-effort audit emit — degrade gracefully if not available.
    try {
      const audit = (this.runtime as unknown as { audit?: { emit?: (kind: string, ref: string, data: Record<string, unknown>) => void } }).audit;
      const ref = chainId ? `item:chains[${chainId}]` : 'item:chat.completions';
      if (audit && typeof audit.emit === 'function') {
        audit.emit(kind, ref, scrubbed);
      }
    } catch {
      /* swallow */
    }
  }

  /** Per-chain scrub maps. Populated in create() at chain start, cleared in `finally`. */
  private chainScrubs: Map<string, Array<{ value: string; alias: string }>> = new Map();
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

// ============================================================================
// Phase 3 — credential substitution + audit-scrub helpers
// ============================================================================

/**
 * Replace ${alias} occurrences in `text` with resolved credential
 * values. Aliases must be ASCII word characters (\w). Unknown aliases
 * are left intact so the calling primitive can surface its own
 * "unknown placeholder" error rather than silently substituting empty.
 */
function substituteCredentials(text: string, creds: Map<string, string>): string {
  if (!text || !text.includes('${')) return text;
  return text.replace(/\$\{(\w+)\}/g, (whole, alias) => {
    const v = creds.get(alias);
    return v === undefined ? whole : v;
  });
}

/**
 * Scrub credential values from a plain string. Replaces each matched
 * value with `<credential:alias>` so reviewers can tell which alias's
 * value was scrubbed without seeing it. Caller is expected to pass the
 * scrubMap sorted by descending value length (longest first) so
 * overlapping values don't leave fragments.
 */
function scrubText(text: string, scrub: Array<{ value: string; alias: string }>): string {
  if (!text || scrub.length === 0) return text;
  let out = text;
  for (const { value, alias } of scrub) {
    if (!value || !out.includes(value)) continue;
    // Plain split-join — avoids regex escaping for arbitrary values.
    out = out.split(value).join(`<credential:${alias}>`);
  }
  return out;
}

/**
 * Deep-scrub helper: walks an event-payload object, scrubbing strings
 * and recursing into plain objects + arrays. Best-effort; non-string
 * leaves pass through unchanged. Cycles are not expected in emit
 * payloads (they're all simple data), but a depth cap protects us.
 */
function scrubDeep(obj: unknown, scrub: Array<{ value: string; alias: string }>, depth = 0): unknown {
  if (depth > 8) return obj;
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') return scrubText(obj, scrub);
  if (Array.isArray(obj)) return obj.map((v) => scrubDeep(v, scrub, depth + 1));
  if (typeof obj === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      out[k] = scrubDeep(v, scrub, depth + 1);
    }
    return out;
  }
  return obj;
}
