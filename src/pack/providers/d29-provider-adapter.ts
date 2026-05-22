/**
 * D29 provider adapter — bridges blur-providers-core's INNER
 * `(req: ProviderRequest) => Promise<ProviderResponse>` shape onto
 * blur-agent's OUTER Decision 29 `({agent, opts, replies}) → {replyHandle}`
 * shape.
 *
 * Why two layers exist:
 *
 *   - blur-providers-core ships provider implementations (`local`,
 *     `together`) against its own ProviderRegistry. Their contract is
 *     synchronous-return (`Promise<ProviderResponse>` with text +
 *     usage), reachable via
 *     `runtime.extensions.get('providerRegistry')` and the
 *     `runtime.providers.{list,get,send}` primitives.
 *
 *   - blur-agent's `runtime.agents.providers.register({kind,
 *     sendMessage})` (Decision 29) expects a streaming-shape sender
 *     that takes an Agent + opts and pushes chunks onto a ReplyRecord
 *     via the AgentRepliesSink, then calls `replies.complete()` /
 *     `.fail()`.
 *
 *   - This adapter is the substrate-owned bridge. For each known
 *     blur-providers-core provider, it registers a wrapper in the
 *     outer registry that:
 *       1. Mints a ReplyRecord
 *       2. Builds a ProviderRequest from agent.provider.model + opts.text
 *       3. Awaits inner provider.sendMessage(req) → text + usage
 *       4. appendChunks the text + completes the reply
 *
 * v1 (this commit): non-streaming — the full text lands as a single
 * chunk after the inner call resolves. v2 will switch to true
 * streaming once blur-providers-core exposes a streaming variant or
 * we tap an underlying SSE / chunked-HTTP source.
 *
 * Per general-activity-multi-provider-v1 §9 ("Blur AI Runtime" owns
 * the adapter) + blur-providers' contract reply (2026-05-18).
 */

import type { Agent, SendMessageOpts } from '../types';
import type { AgentRepliesSink, ProviderImpl } from '../provider-registry';

// ---------------------------------------------------------------------------
// Inner-registry shape (from blur-providers-core; not imported as a type to
// avoid a hard dependency — the adapter degrades gracefully if the inner
// registry isn't present).
// ---------------------------------------------------------------------------

interface InnerProviderRequest {
  messages: Array<{ role: string; content: string }>;
  model?: string;
  params?: Record<string, unknown>;
}

interface InnerProviderResponse {
  text: string;
  usage?: { promptTokens?: number; completionTokens?: number; costEstimate?: number };
  raw?: unknown;
}

interface InnerProviderRegistry {
  /** True if a provider with this name is registered. */
  has?: (name: string) => boolean;
  /** Look up by name. */
  get?: (name: string) => InnerProvider | null | undefined;
  /** Shortcut: dispatch by name. */
  send?: (
    name: string,
    req: InnerProviderRequest,
    opts?: unknown,
  ) => Promise<InnerProviderResponse>;
  /** List all registered providers. */
  list?: () => InnerProvider[];
  /**
   * tkt_633d0117 — subscribe to register/unregister events so the D29
   * adapter installer can wire adapters as providers appear. Optional:
   * older blur-providers-core builds don't expose this, in which case
   * installD29Adapters falls back to the legacy one-shot scan.
   */
  onRegister?: (
    fn: (provider: InnerProvider, phase: 'register' | 'unregister') => void,
  ) => () => void;
}

interface InnerProvider {
  name: string;
  label?: string;
  description?: string;
  sendMessage?: (req: InnerProviderRequest, opts?: unknown) => Promise<InnerProviderResponse>;
}

// ---------------------------------------------------------------------------
// Runtime shape — minimal, just what the adapter touches.
// ---------------------------------------------------------------------------

interface RuntimeShape {
  extensions?: { get?: (name: string) => unknown };
}

// ---------------------------------------------------------------------------
// Factory — build a D29 ProviderImpl wrapping one inner provider by name.
// ---------------------------------------------------------------------------

export interface D29AdapterOptions {
  /** Provider kind on the outer (D29) side — typically the same as the inner name. */
  kind: string;
  /** Human-readable label for runtime.agents.providers.list. */
  label?: string;
  /** Description shown in primitive descriptions / inspectors. */
  description?: string;
}

/**
 * Build a D29 ProviderImpl that adapts one inner-registry provider.
 *
 * The returned impl is registered into the OUTER registry via
 * `runtime.agents.providers.register(impl)`. At dispatch time it:
 *   1. Reads agent.provider.{kind, model} to identify what to call
 *   2. Reaches the inner registry via runtime.extensions.get('providerRegistry')
 *   3. Calls inner.send(kind, req) — a single Promise<ProviderResponse>
 *   4. Pushes the response text as one chunk + completes the reply
 *
 * Fails the reply (not the dispatch) if the inner provider is missing
 * or throws. The outer ProviderImpl.sendMessage still returns the
 * replyHandle so the caller can observe the failure via getReply.
 */
export function d29ProviderAdapter(
  runtime: RuntimeShape,
  opts: D29AdapterOptions,
): ProviderImpl {
  return {
    // Cast: kind is typed as a discriminated union in ProviderImpl; the
    // adapter accepts any string because inner-registry providers can
    // register any name. The valid set (per the typed union today:
    // 'bridge' | 'mock' | 'local' | 'together' | 'openai') already
    // covers everything blur-providers-core ships.
    kind: opts.kind as ProviderImpl['kind'],
    label: opts.label ?? `${opts.kind} (via D29 adapter)`,
    description:
      opts.description ??
      `D29 adapter wrapping blur-providers-core's '${opts.kind}' inner provider. ` +
        'Synchronous-return shape; the full response lands as one text chunk.',
    capabilities: {
      // Conservative until the inner provider declares its own (v1 hand-curates
      // in the Model Table; capability propagation is a future hop).
      toolUse: 'unsupported',
      vision: false,
    },

    sendMessage(agent: Agent, sendOpts: SendMessageOpts, replies: AgentRepliesSink) {
      const inner = getInnerRegistry(runtime);
      if (!inner) {
        throw new Error(
          `d29ProviderAdapter[${opts.kind}]: providerRegistry extension not present — ` +
            "blur-providers-core's pack isn't loaded. Load it first.",
        );
      }
      const provider = agent.provider;
      if (!provider || provider.kind !== opts.kind) {
        throw new Error(
          `d29ProviderAdapter[${opts.kind}]: invoked for agent ${agent.id} but agent.provider.kind='${provider?.kind ?? '<none>'}'`,
        );
      }

      // Mint a ReplyRecord first; the inner call runs async and pushes
      // chunks against this handle.
      const startedAt = new Date().toISOString();
      const startedAtMs = Date.now();
      const record = replies.createReply({
        agentId: agent.id,
        request: { text: sendOpts.text, at: startedAt, by: sendOpts.by },
        providerKind: opts.kind,
      });

      // Build the ProviderRequest. v1 sends one user message; conversational
      // history threading is left to the caller / future ticket-context work.
      //
      // Decision 36 step 2 — sendOpts.model wins over agent.provider.model
      // when set. The Scheduler populates sendOpts.model from the resolved
      // selection (providerModelId from the Model Table lookup), so per-call
      // pins / engagement.runtimeModel / Activity Table defaults actually
      // change what runs at dispatch time — not just what's recorded.
      const model = sendOpts.model ?? (provider as { model?: string }).model;

      // KV-cache-aware params for local (Ollama / llama.cpp) provider.
      // See `runtime.library.get('blur-inference-paradigm')` §11.
      //
      //   keep_alive: -1  → model + KV cache stay resident indefinitely.
      //                     Without this, Ollama unloads after 5 min of
      //                     silence and the next Turn pays full cold-start.
      //   num_ctx:    8192 → fixed context window. Ollama auto-sizes
      //                     `num_ctx` per request by default; auto-sizing
      //                     re-allocates the KV buffer on every call and
      //                     destroys the cache. Pinning at a constant
      //                     keeps the cache reusable across Turns.
      //
      // The inner Ollama provider (blur-providers) must forward
      // `params.keep_alive` / `params.num_ctx` to its Ollama HTTP body
      // for these to take effect. Pre-forwarding makes this edit a
      // no-op until the inner side lands — see companion ticket.
      const params: Record<string, unknown> | undefined =
        opts.kind === 'local'
          ? { keep_alive: -1, num_ctx: 8192 }
          : undefined;

      const req: InnerProviderRequest = {
        messages: [{ role: 'user', content: sendOpts.text }],
        ...(model !== undefined ? { model } : {}),
        ...(params !== undefined ? { params } : {}),
      };

      // Dispatch async; failures land on the reply, not the synchronous
      // return path.
      Promise.resolve()
        .then(async () => {
          let res: InnerProviderResponse;
          if (typeof inner.send === 'function') {
            res = await inner.send(opts.kind, req);
          } else if (typeof inner.get === 'function') {
            const ip = inner.get(opts.kind);
            if (!ip || typeof ip.sendMessage !== 'function') {
              throw new Error(
                `d29ProviderAdapter[${opts.kind}]: inner provider has no sendMessage`,
              );
            }
            res = await ip.sendMessage(req);
          } else {
            throw new Error(
              `d29ProviderAdapter[${opts.kind}]: inner registry has neither .send nor .get`,
            );
          }

          const text = typeof res?.text === 'string' ? res.text : '';
          const endedAt = new Date().toISOString();
          replies.appendChunk(record.handle, [{ kind: 'text', data: text, at: endedAt }]);

          // Optional: surface usage as a meta chunk so consumers can see token/cost
          // without having to thread it through a new contract field.
          if (res?.usage) {
            replies.appendChunk(record.handle, [
              { kind: 'meta', data: { usage: res.usage }, at: endedAt },
            ]);
          }

          replies.complete(record.handle, {
            startedAt,
            endedAt,
            durationMs: Date.now() - startedAtMs,
            textTotalLen: text.length,
            toolCallCount: 0,
          });
        })
        .catch(err => {
          replies.fail(record.handle, (err as Error)?.message ?? String(err));
        });

      return { replyHandle: record.handle };
    },
  };
}

// ---------------------------------------------------------------------------
// Install helper — registers adapters for known inner provider names that are
// present at install time. Skips silently when the inner registry isn't loaded
// (e.g. running blur-agent against the mock-only test fixture).
// ---------------------------------------------------------------------------

export interface InstallD29AdaptersOpts {
  /** Outer registry to register adapters into. `unregister` is optional
   *  for backwards compat — when present (post-tkt_633d0117 blur-agent),
   *  the installer drops the outer adapter on inner-provider unregister
   *  so vendor-pack uninstall results in a clean "unknown kind" failure
   *  instead of a stale-adapter "no inner provider" failure. */
  outer: {
    register: (impl: ProviderImpl) => unknown;
    unregister?: (kind: string) => boolean;
  };
  /** Provider kinds to bridge. Defaults to ['local', 'together']. */
  kinds?: string[];
}

export interface InstallD29AdaptersResult {
  registered: string[];
  skipped: Array<{ kind: string; reason: string }>;
  /**
   * tkt_633d0117 — disposer for the register-event subscription that
   * wires adapters incrementally when inner providers load AFTER this
   * call. null when the inner registry doesn't expose `onRegister`
   * (older blur-providers-core) — in that case behavior is the legacy
   * one-shot scan and pack-load-order matters again.
   */
  dispose: (() => void) | null;
}

export function installD29Adapters(
  runtime: RuntimeShape,
  opts: InstallD29AdaptersOpts,
): InstallD29AdaptersResult {
  const kinds = opts.kinds ?? ['local', 'together'];
  const inner = getInnerRegistry(runtime);
  const result: InstallD29AdaptersResult = { registered: [], skipped: [], dispose: null };

  if (!inner) {
    for (const k of kinds) result.skipped.push({ kind: k, reason: 'no inner providerRegistry extension' });
    return result;
  }

  // Single shared install path: synchronous one-shot scan happens via
  // the listener after we subscribe (we replay the current list through
  // it ourselves below — see "Replay" comment). This keeps the wiring
  // logic in exactly one place.
  const targetSet = new Set(kinds);
  const wired = new Set<string>();
  const wireOne = (innerProvider: InnerProvider): boolean => {
    try {
      opts.outer.register(
        d29ProviderAdapter(runtime, {
          kind: innerProvider.name,
          label: innerProvider.label,
          description: innerProvider.description,
        }),
      );
      wired.add(innerProvider.name);
      return true;
    } catch (err) {
      result.skipped.push({
        kind: innerProvider.name,
        reason: `outer register failed: ${(err as Error)?.message ?? String(err)}`,
      });
      return false;
    }
  };

  // tkt_633d0117 — subscribe FIRST, then replay the current list through
  // the same callback. Subscribing first closes the register-during-replay
  // race window: a provider that registers between our list() and our
  // listener attachment still gets picked up because the listener was
  // attached before the register() call lands.
  let dispose: (() => void) | null = null;
  if (typeof inner.onRegister === 'function') {
    dispose = inner.onRegister((p, phase) => {
      if (!p || !targetSet.has(p.name)) return;
      if (phase === 'unregister') {
        // tkt_633d0117 follow-up — when the inner provider goes away
        // (vendor pack uninstall / hot-reload), drop the outer adapter
        // too. Stale adapter would surface a confusing "no inner
        // provider" downstream; clean unregister surfaces a truthful
        // "unknown providerKind". Hot-reload then re-fires the
        // register-phase below to re-wire the adapter against the
        // freshly-loaded inner provider.
        //
        // Feature-detect outer.unregister: callers who pass an older
        // outer (no unregister) get the prior leaky behavior, which is
        // strictly no worse than before this fix.
        if (typeof opts.outer.unregister === 'function') {
          try {
            opts.outer.unregister(p.name);
          } catch (err) {
            // eslint-disable-next-line no-console
            console.warn(
              `[d29-adapter] outer.unregister('${p.name}') threw — adapter may persist:`,
              err,
            );
          }
        }
        wired.delete(p.name);
        return;
      }
      if (wired.has(p.name)) return; // idempotent — already wired
      if (wireOne(p)) {
        result.registered.push(p.name);
      }
    });
    result.dispose = dispose;
  }

  // Replay the current list — covers blur-agent-loaded-AFTER-providers.
  // If the inner registry doesn't expose `onRegister`, this is also the
  // ONLY pass (legacy fallback).
  const currentlyRegistered: InnerProvider[] = (() => {
    if (typeof inner.list === 'function') {
      try { return inner.list() ?? []; } catch { return []; }
    }
    // No list() — fall back to per-kind has/get probes (legacy shape).
    const out: InnerProvider[] = [];
    for (const k of kinds) {
      const present = typeof inner.has === 'function' ? inner.has(k) : !!inner.get?.(k);
      if (!present) continue;
      const p = typeof inner.get === 'function' ? inner.get(k) : null;
      if (p) out.push(p);
    }
    return out;
  })();

  for (const p of currentlyRegistered) {
    if (!targetSet.has(p.name)) continue;
    if (wired.has(p.name)) continue;
    if (wireOne(p)) result.registered.push(p.name);
  }

  // For any target kind we still don't have, record why (matches the
  // legacy `skipped` shape so logging in index.ts stays useful).
  for (const k of kinds) {
    if (wired.has(k)) continue;
    // Already pushed if wireOne failed; only push the "not yet registered" reason once.
    if (!result.skipped.some((s) => s.kind === k)) {
      result.skipped.push({
        kind: k,
        reason: dispose
          ? 'inner provider not registered yet — will wire on register event'
          : 'inner provider not registered (no onRegister hook to listen for it)',
      });
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Inner-registry getter — narrow the unknown extension shape.
// ---------------------------------------------------------------------------

function getInnerRegistry(runtime: RuntimeShape): InnerProviderRegistry | null {
  try {
    const ext = runtime?.extensions?.get?.('providerRegistry');
    if (!ext || typeof ext !== 'object') return null;
    const r = ext as InnerProviderRegistry;
    if (typeof r.send !== 'function' && typeof r.get !== 'function') return null;
    return r;
  } catch {
    return null;
  }
}
