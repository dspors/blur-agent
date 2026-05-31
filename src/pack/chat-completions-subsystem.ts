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
import { VERB_TAG_RESOLVERS, isVerbTag } from './verb-tag-resolvers';
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
  /**
   * tkt_fbd9c979 — caller-side fallback ladder (layer 1 of the three-
   * layer resolution in blur-providers-core's ProviderRegistry walker).
   * Each entry is `{providerKind, modelId}` so cross-provider fallback
   * (e.g. azure-foundry/kimi-k2.6 → anthropic/claude-haiku-4-5) is
   * first-class at this layer. Empty array = explicit no-fallback.
   *
   * Propagates through chat.completions → D29 adapter →
   * core SendMessageOptions.fallbackList. When undefined, the walker
   * falls through to layer 2 (runtime.config 'fallbackOverrides') and
   * layer 3 (curator-side default).
   */
  fallbackList?: Array<{ providerKind: string; modelId: string }>;
  /**
   * tkt_fbd9c979 — skip the curator-side default (layer 3) when neither
   * layer 1 nor layer 2 is set. Lets callers force "fail loud"
   * semantics — useful for repro / smoke runs where silent substitution
   * would mask the failure they're trying to observe.
   */
  disableCuratedFallback?: boolean;
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

/**
 * Reserved shape for stateful-session providers. v1 ignores; the
 * future Microsoft Responses-API integration will read it.
 *
 * - kind: a discriminator. Today only 'openai-responses' is anticipated,
 *   but other stateful APIs (Anthropic Sessions, etc.) can register
 *   their own kind without an interface break.
 * - id: an existing session/response handle to thread; omit to mint
 *   a new session (in combination with createIfMissing).
 * - createIfMissing: when true, the provider mints a session if none
 *   exists; the new id is returned in ChainResult.sessionId for the
 *   caller to thread into subsequent invocations.
 *
 * See Anchor 4 (anchor-004-context-placement-single-tier) and ticket
 * tkt_8ab71b9e for the planned implementation.
 */
export interface ChatSessionRef {
  kind: 'openai-responses' | string;
  id?: string;
  createIfMissing?: boolean;
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
  /**
   * Reserved (Anchor 4 — context-placement-single-tier). Optional
   * handle for stateful-session providers (e.g. OpenAI Responses
   * API via the future Microsoft pack). Today: silently ignored.
   *
   * When implemented:
   *   - kind 'openai-responses' → dispatch via the Responses endpoint;
   *     session.id threads conversation state across calls.
   *   - createIfMissing:true mints a new session on first call and
   *     returns its id in the ChainResult for the caller to thread
   *     into subsequent invocations.
   *
   * Layers tagged `placement: 'session'` on the BlurContextSnapshot
   * (via the `placements` side-map) will be uploaded once and NOT
   * resent per call. See ticket tkt_8ab71b9e.
   */
  session?: ChatSessionRef;
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
      promptBytes: messages.reduce(
        (a, m) => a + messageByteLength(m),
        0,
      ),
    });

    // Phase A.5a — open capture_chain row. Best-effort: missing
    // CaptureStore / JobsSubsystem / scriptRunId all silently skip
    // persistence. Provides the chain_id FK target that capture_turn
    // rows reference via AuditFrame.chainContext (set per-iter below).
    const chainCapture = this.openChainCapture_(
      chainId,
      messages,
      opts.allowedTags ?? null,
      Array.from(credentialMap.keys()),
    );
    const perIterTagResults: Array<Record<string, unknown>> = [];

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
        // Phase A.5a — stamp chainContext on the AuditFrame around the
        // dispatch so downstream capture_turn writes pick up chain_id +
        // iter via ALS. Cleared in finally so the frame stays clean
        // between iters.
        const frame = this.audit_()?.currentFrame();
        if (frame) frame.chainContext = { chainId, iter };
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
          if (frame) delete frame.chainContext;
          break;
        } finally {
          if (frame) delete frame.chainContext;
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
            // Substitute ${alias} in tag body AND tag.attrs before
            // dispatch. Tags are immutable by spec; we build a shallow-
            // modified clone so executeTag sees substituted values. The
            // model never sees the substituted value — only the engine
            // and the dispatched primitive do.
            //
            // Phase 4 extension: verb tags (b:http-fetch, b:browser-*)
            // carry credentials in attrs (e.g. headers='{"Authorization":
            // "Bearer ${apiKey}"}'), not just body. Walk both.
            let execTag: BTag = tag;
            if (credentialMap.size > 0) {
              let nextBody = tag.body;
              if (typeof tag.body === 'string' && tag.body.includes('${')) {
                nextBody = substituteCredentials(tag.body, credentialMap);
              }
              let nextAttrs = tag.attrs;
              let attrsChanged = false;
              for (const [k, v] of Object.entries(tag.attrs)) {
                if (typeof v === 'string' && v.includes('${')) {
                  const sub = substituteCredentials(v, credentialMap);
                  if (sub !== v) {
                    if (!attrsChanged) {
                      nextAttrs = { ...tag.attrs };
                      attrsChanged = true;
                    }
                    nextAttrs[k] = sub;
                  }
                }
              }
              if (nextBody !== tag.body || attrsChanged) {
                execTag = { ...tag, body: nextBody, attrs: nextAttrs };
              }
            }

            const r = await this.executeTag(execTag, chainId);
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
      // Phase A.5a — close the capture_chain row.
      this.closeChainCapture_(
        chainCapture,
        iterations,
        terminationReason,
        Date.now() - startedAt,
        error,
        perIterTagResults,
      );
    }

    // finalReply = last assistant message content (or empty if no
    // iteration ran). Assistant messages are always string-content in v1
    // (provider responses arrive as text), but the type widening for
    // multimodal user-input means we must extract text defensively.
    let finalReply = '';
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant') {
        finalReply = extractTextFromContent(messages[i].content);
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
    //
    // tkt_fbd9c979 — forward fallbackList / disableCuratedFallback
    // from ModelSpec so the D29 adapter can thread them into
    // blur-providers-core's ProviderRegistry.send() as the caller-
    // side layer-1 of the three-layer fallback resolution.
    const sendResult = await impl.sendMessage(
      syntheticAgent,
      {
        text: opts.promptText,
        model: opts.model.modelId,
        ...(opts.model.fallbackList !== undefined
          ? { fallbackList: opts.model.fallbackList }
          : {}),
        ...(opts.model.disableCuratedFallback !== undefined
          ? { disableCuratedFallback: opts.model.disableCuratedFallback }
          : {}),
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
   *   - b:script / b:s            — runtime.script.run (escape hatch)
   *   - b:p                       — legacy property read (engagement-flow)
   *   - b:http-fetch / b:browser-* — verb tags (in-pack table, Phase 4)
   *   - b:<entity-word>           — engagement-flow walker resolver (Decision 37)
   *
   * Returns `{ ok, value, error }`.
   */
  private async executeTag(
    tag: BTag,
    chainId: string,
  ): Promise<{ ok?: boolean; value?: unknown; error?: string }> {
    const runtime = this.runtime as unknown as {
      script?: { run?: (src: string) => Promise<{ ok?: boolean; value?: unknown; error?: string }> };
      tagWalker?: {
        resolvers?: () => Record<string, (tag: BTag) => Promise<{ ok?: boolean; value?: unknown; error?: string }>>;
      };
      extensions?: { get?: (name: string) => unknown };
    };

    if (tag.kind === 'b:script' || tag.kind === 'b:s') {
      const scriptHost = runtime.script;
      if (!scriptHost || typeof scriptHost.run !== 'function') {
        return { ok: false, error: 'runtime.script.run unavailable on host' };
      }
      return scriptHost.run(tag.body);
    }

    // Phase 4 — verb-style tags (HTTP, browser, ...). These describe
    // operations, not entities; the entity-resolver tagWalker model
    // doesn't fit them. Resolution path:
    //   1. Consult runtime.extensions.get('verbTagResolvers') — packs
    //      can register real backends (e.g. blur-browser registers
    //      b:browser-* resolvers that drive Stagehand/Playwright).
    //      Extension wins over in-pack stub.
    //   2. Fall back to the in-pack VERB_TAG_RESOLVERS table for kinds
    //      with no extension (b:http-fetch real, b:browser-* stubs).
    // Credential substitution has already replaced ${alias} placeholders
    // in tag.body / tag.attrs upstream — resolvers see real values.
    // chainId is injected into tag.attrs so resolvers can scope
    // chain-bound resources (per Decision dec_75c1587c).
    const extensions = runtime.extensions;
    const extResolversHost = extensions?.get?.('verbTagResolvers') as
      | {
          get?: (k: string) => undefined | ((tag: BTag) => Promise<{ ok?: boolean; value?: unknown; error?: string }>);
          list?: () => string[];
        }
      | undefined;
    const extResolver = extResolversHost?.get?.(tag.kind);
    if (extResolver) {
      const withChain: BTag = { ...tag, attrs: { ...tag.attrs, chainId } };
      return extResolver(withChain);
    }
    if (isVerbTag(tag.kind)) {
      const resolver = VERB_TAG_RESOLVERS[tag.kind];
      const withChain: BTag = { ...tag, attrs: { ...tag.attrs, chainId } };
      return resolver(withChain);
    }

    // Engagement-flow owns the b:p (legacy property-read) and
    // descriptive entity-tag resolvers. We delegate to keep walker
    // integration single-source-of-truth there. Decision 34 keeps
    // chat.completions independent of engagement SEMANTICS (no agent,
    // no history, no audit), only borrows the tag-execution machinery.
    // Look up via runtime.extensions (the substrate-side reference
    // doesn't have `runtime.engagementFlow` as a direct property).
    // (Reusing the `extensions` binding declared at the verb-tag dispatch
    // block above.)
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
   * Namespace note: the pack-side runtime exposes the ConfigTablesSubsystem
   * as `runtime.tables` with SYNCHRONOUS methods (`getModel`, `listModels`,
   * `findModels`). The script-side surface re-exposes it as `runtime.models`
   * with ASYNC wrappers. Inside this pack we must use the pack-side name.
   * Initial 9558ab4 used the right namespace but iterated listModels()
   * instead of using getModel() for O(1) lookup.
   *
   * Failure modes (all return the input unchanged):
   *   - runtime.tables not wired (older runtime, mock test fixture)
   *   - tables.getModel throws
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
      tables?: { getModel?: (modelRef: string) => ModelRow | null };
    }).tables;
    if (!tables || typeof tables.getModel !== 'function') return modelId;
    let row: ModelRow | null;
    try {
      row = tables.getModel(candidateRef);
    } catch {
      return modelId;
    }
    return row && typeof row.providerModelId === 'string' && row.providerModelId
      ? row.providerModelId
      : modelId;
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

  // ---------------------------------------------------------------------
  // Phase A.5a — capture_chain open/close + AuditFrame accessor.
  // ---------------------------------------------------------------------

  /** Defensive runtime.audit accessor for chainContext stamping. */
  private audit_(): {
    currentFrame: () => { chainContext?: { chainId: string; iter: number } } | undefined;
  } | null {
    try {
      const a = (this.runtime as unknown as {
        audit?: {
          currentFrame: () => { chainContext?: { chainId: string; iter: number } } | undefined;
        };
      }).audit;
      return a ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Insert a capture_chain row at chain start. Reads JobContext +
   * scriptRunId via ALS (runtime.jobs.current() + AuditFrame.scriptRunId).
   * Returns null when persistence is unavailable — caller treats
   * everything chain-capture as no-op. Wire failures never block the
   * chain.
   */
  private openChainCapture_(
    chainId: string,
    initialMessages: ChatMessage[],
    allowedTags: string[] | null,
    credentialAliases: string[],
  ): { id: string; startedAtMs: number } | null {
    try {
      const r = this.runtime as unknown as {
        jobs?: {
          captures?: {
            insertChain(row: {
              id: string;
              jobId: string;
              scriptRunId: string;
              startedAt: string;
              callerOrigin: string;
              engagementId: string | null;
              agentId: string | null;
              systemPrefix: string | null;
              systemPrefixHash: string | null;
              allowedTags: string | null;
              credentialAliases: string | null;
              contextLayersHash: string | null;
            }): number;
          };
          current?: () => { id: string } | null;
        };
        audit?: { currentFrame?: () => { scriptRunId?: string } | undefined };
      };
      const captures = r.jobs?.captures;
      const job = r.jobs?.current?.();
      const scriptRunId = r.audit?.currentFrame?.()?.scriptRunId;
      if (!captures || !job || !scriptRunId) return null;

      // Extract the system prefix (first system message) from the
      // initial messages array. Stored ONCE per chain.
      const systemPrefix = initialMessages
        .filter((m) => m.role === 'system')
        .map((m) => (typeof m.content === 'string' ? m.content : ''));
      const systemPrefixText = systemPrefix.length > 0 ? JSON.stringify(systemPrefix) : null;

      captures.insertChain({
        id: chainId,
        jobId: job.id,
        scriptRunId,
        startedAt: new Date().toISOString(),
        callerOrigin: 'chat.completions',
        engagementId: null,
        agentId: null,
        systemPrefix: systemPrefixText,
        systemPrefixHash: null,
        allowedTags: allowedTags && allowedTags.length > 0 ? JSON.stringify(allowedTags) : null,
        credentialAliases:
          credentialAliases.length > 0 ? JSON.stringify(credentialAliases) : null,
        contextLayersHash: null,
      });
      return { id: chainId, startedAtMs: Date.now() };
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[chat.completions] openChainCapture_ failed (continuing):', err);
      return null;
    }
  }

  /**
   * Close the capture_chain row with final iter count + termination
   * reason + per-iter tag results + accumulated usage. Best-effort.
   */
  private closeChainCapture_(
    capture: { id: string; startedAtMs: number } | null,
    iterations: IterationRecord[],
    terminationReason: ChainResult['terminationReason'],
    totalDurationMs: number,
    error: string | undefined,
    perIterTagResults: Array<Record<string, unknown>>,
  ): void {
    if (!capture) return;
    try {
      const r = this.runtime as unknown as {
        jobs?: {
          captures?: {
            endChain(update: {
              id: string;
              endedAt: string;
              iterCount: number;
              terminationReason: string | null;
              finalReply: string | null;
              error: string | null;
              totalDurationMs: number;
              totalPromptTokens: number;
              totalCompletionTokens: number;
              totalCostEstimate: number;
              tagResults: string | null;
            }): void;
          };
        };
      };
      const captures = r.jobs?.captures;
      if (!captures) return;

      // Sum usage across iterations from the tag results / iteration records.
      // Token totals come from capture_turn rows (already aggregated by the
      // accounting triggers on capture_job); chain-level total stays 0 here
      // (consumers can SUM capture_turn.usage WHERE chain_id = ?).
      captures.endChain({
        id: capture.id,
        endedAt: new Date().toISOString(),
        iterCount: iterations.length,
        terminationReason,
        finalReply: null,
        error: error ?? null,
        totalDurationMs,
        totalPromptTokens: 0,
        totalCompletionTokens: 0,
        totalCostEstimate: 0,
        tagResults: perIterTagResults.length > 0 ? JSON.stringify(perIterTagResults) : null,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[chat.completions] closeChainCapture_ failed:', err);
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
 * Multimodal content: when a message's `content` is an array, only its
 * text parts are kept; image/audio/non-text parts are DROPPED with a
 * one-time console warning (see `extractTextFromContent`). Callers
 * needing full multimodal should use `runtime.providers.send` directly.
 *
 * Byte-deterministic given identical messages.
 */
function flattenMessages(messages: ChatMessage[]): string {
  const parts: string[] = [];
  for (const m of messages) {
    const text = extractTextFromContent(m.content);
    if (m.role === 'system') {
      // System content goes verbatim at the top; no role prefix.
      parts.push(text);
    } else {
      parts.push(`${m.role}: ${text}`);
    }
  }
  return parts.join('\n──\n');
}

/** Track whether we've already emitted the multimodal-dropped warning. */
let multimodalWarned = false;

/**
 * Extract text content from a ChatMessage's `content` field. When
 * content is a string, return as-is. When content is an array
 * (multimodal), concatenate text parts and DROP non-text parts.
 * Emits a single deprecation warning on first multimodal encounter so
 * the caller knows their images aren't reaching the provider via the
 * chat.completions path.
 */
function extractTextFromContent(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let droppedNonText = false;
  const textParts: string[] = [];
  for (const part of content) {
    if (part && typeof part === 'object') {
      if (typeof part.text === 'string') {
        textParts.push(part.text);
      } else if (part.type !== 'text') {
        droppedNonText = true;
      }
    }
  }
  if (droppedNonText && !multimodalWarned) {
    multimodalWarned = true;
    // eslint-disable-next-line no-console
    console.warn(
      '[chat.completions] Non-text content parts (image_url / input_audio / etc.) ' +
      'dropped at the v1 dispatcher boundary — only text parts forwarded to the ' +
      'provider. For full multimodal support, call runtime.providers.send directly. ' +
      '(This warning fires once per process.)',
    );
  }
  return textParts.join('');
}

/**
 * Byte length of a single ChatMessage's content. Handles both plain
 * string and array (multimodal) content. For arrays, measures the
 * JSON-serialized form — what gets sent over the wire when multimodal
 * is plumbed through a provider that supports it. (Today the v1
 * dispatcher flattens to text first, so the actual transmitted bytes
 * may be smaller; this byte count remains an UPPER bound suitable for
 * audit / quota purposes.)
 */
function messageByteLength(m: ChatMessage): number {
  if (typeof m.content === 'string') {
    return Buffer.byteLength(m.content, 'utf8');
  }
  return Buffer.byteLength(JSON.stringify(m.content), 'utf8');
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
