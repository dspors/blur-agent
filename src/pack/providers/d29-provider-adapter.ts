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
import type { AgentRepliesSink, ProviderFallback, ProviderImpl } from '../provider-registry';

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
  /**
   * S4: optional audit.skipReason. When present, we route unexpected
   * `extensions.get` throws through here instead of silently swallowing.
   * Optional so the back-compat path works on older host runtimes.
   */
  audit?: {
    skipReason?: (opts: {
      source: string;
      intended: string;
      error?: unknown;
      detail?: Record<string, unknown>;
    }) => void;
  };
}

/**
 * Back-compat wrapper around runtime.audit.skipReason. Prefers the host
 * helper when available; otherwise console.warn with the same wire shape.
 * Identical pattern to blur-document/src/pack/index.ts reportSkip. See
 * PACK-AUTHORS §1.6 and the staged-plan Brief S4 entry.
 */
function reportSkip(
  runtime: RuntimeShape,
  opts: { source: string; intended: string; error?: unknown; detail?: Record<string, unknown> },
): void {
  const skipReason = runtime.audit?.skipReason;
  if (typeof skipReason === 'function') {
    skipReason(opts);
    return;
  }
  const msg =
    opts.error instanceof Error
      ? opts.error.message
      : typeof opts.error === 'string'
        ? opts.error
        : opts.error !== undefined
          ? JSON.stringify(opts.error)
          : '(no error supplied)';
  // eslint-disable-next-line no-console
  console.warn(`[skip] ${opts.source}: ${opts.intended} — ${msg}`);
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

      // tkt_fbd9c979 — caller-side layer-1 fallback ladder. Built from
      // SendMessageOpts.fallbackList / .disableCuratedFallback; passed
      // to inner.send() which threads it into the registry walker.
      // Empty array on fallbackList is preserved (semantic: explicit
      // no-fallback); only `undefined` is dropped.
      const innerOpts: { fallbackList?: unknown[]; disableCuratedFallback?: boolean } = {};
      if (sendOpts.fallbackList !== undefined) {
        innerOpts.fallbackList = sendOpts.fallbackList;
      }
      if (sendOpts.disableCuratedFallback !== undefined) {
        innerOpts.disableCuratedFallback = sendOpts.disableCuratedFallback;
      }
      const hasInnerOpts =
        innerOpts.fallbackList !== undefined ||
        innerOpts.disableCuratedFallback !== undefined;

      // Dispatch async; failures land on the reply, not the synchronous
      // return path.
      Promise.resolve()
        .then(async () => {
          let res: InnerProviderResponse;
          if (typeof inner.send === 'function') {
            res = hasInnerOpts
              ? await inner.send(opts.kind, req, innerOpts as unknown)
              : await inner.send(opts.kind, req);
          } else if (typeof inner.get === 'function') {
            const ip = inner.get(opts.kind);
            if (!ip || typeof ip.sendMessage !== 'function') {
              throw new Error(
                `d29ProviderAdapter[${opts.kind}]: inner provider has no sendMessage`,
              );
            }
            // Note: when we fall back to the per-provider .sendMessage path
            // (no .send on the inner registry), the registry's fallback
            // walker is bypassed entirely — so caller-side fallbackList
            // has no consumer. Mirrors the existing behavior; should be
            // unreachable in normal operation (core's registry exposes .send).
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
// Install helper — installs a LAZY FALLBACK RESOLVER on the outer registry
// so any inner-registry provider becomes reachable on demand, regardless of
// pack load order. tkt_633d0117 follow-up.
//
// Why lazy resolution (and not pre-registration or event subscription):
//   - Pre-registration at install time (the original approach) silently
//     skipped any inner provider that registered AFTER blur-agent's install
//     ran. Pack load order became load-bearing — and in practice, blur-agent
//     loads before blur-providers-core under PackManager's current order,
//     so `Known: mock, bridge` was the steady-state failure.
//   - Subscribing to the inner registry's `onRegister` (the 1af481d /
//     b9b7c70 iteration) closed the WITHIN-PRESENCE race (inner present,
//     providers register later) — but didn't fix the outer race (inner
//     extension not mounted yet at our install time). We still returned
//     dispose=null and no listener attached.
//   - This lazy-fallback design eliminates BOTH races: on every outer
//     get(kind) miss, we re-look-up the inner registry via
//     runtime.extensions.get('providerRegistry') and mint a d29-adapter
//     wrapper on the fly. If the inner registry only mounts at provider
//     dispatch time, that's fine — the first dispatch finds it.
//
// Result: no pre-registration, no event subscription, no replay loop.
// One function, no state. The outer registry's list() reflects the inner
// providers because the fallback enumerates them via inner.list().
// ---------------------------------------------------------------------------

export interface InstallD29AdaptersOpts {
  /**
   * Outer registry to install the fallback resolver on. The previous
   * register / unregister members are no longer needed — the lazy
   * resolver minted on every outer.get() miss makes pre-registration
   * obsolete, and inner-side unregister is naturally observed by the
   * next get() failing to resolve.
   */
  outer: {
    setFallback: (fb: ProviderFallback | null) => () => void;
  };
  /**
   * Provider kinds to bridge. Defaults to ['local', 'together', 'anthropic', 'azure-foundry'].
   * Acts as an allowlist on resolve() — even if the inner registry has
   * additional providers (e.g. an experimental 'openai-direct'), we
   * only adapt the kinds blur-agent's AgentProvider['kind'] union
   * accepts, to keep the outer registry type-safe. When adding a new
   * blur-providers-core ProviderImpl, also add its kind here AND add
   * a matching interface to the AgentProvider union in types.ts.
   */
  kinds?: string[];
}

export interface InstallD29AdaptersResult {
  /**
   * Always present — disposer that uninstalls the fallback resolver
   * (idempotent and safe against later overwrites). Non-nullable now
   * because the fallback install never fails; older callers checking
   * `if (dispose !== null)` still work, they just always take the
   * truthy branch.
   */
  dispose: () => void;
}

export function installD29Adapters(
  runtime: RuntimeShape,
  opts: InstallD29AdaptersOpts,
): InstallD29AdaptersResult {
  const kinds = opts.kinds ?? ['local', 'together', 'anthropic', 'azure-foundry'];
  const allowed = new Set(kinds);

  // Lazy resolver — re-inspects the inner registry every call. No
  // captured registry reference: getInnerRegistry() re-resolves via
  // runtime.extensions.get('providerRegistry') so a registry that
  // mounts AFTER this installer ran is picked up automatically.
  const fallback: ProviderFallback = {
    resolve(kind: string): ProviderImpl | null {
      if (!allowed.has(kind)) return null;
      const inner = getInnerRegistry(runtime);
      if (!inner) return null;
      // Inner-side presence check. We only mint an adapter when the
      // inner provider is actually there — minting a stub adapter that
      // would fail at sendMessage would surface a confusing "no inner
      // provider" instead of the truthful "no provider for kind".
      const innerProvider =
        typeof inner.get === 'function'
          ? inner.get(kind)
          : (typeof inner.has === 'function' && inner.has(kind) ? { name: kind } : null);
      if (!innerProvider) return null;
      return d29ProviderAdapter(runtime, {
        kind,
        label: innerProvider.label,
        description: innerProvider.description,
      });
    },
    enumerate(): string[] {
      const inner = getInnerRegistry(runtime);
      if (!inner) return [];
      const list = typeof inner.list === 'function' ? (inner.list() ?? []) : [];
      const out: string[] = [];
      for (const p of list) if (p && allowed.has(p.name)) out.push(p.name);
      return out;
    },
  };

  const dispose = opts.outer.setFallback(fallback);
  return { dispose };
}

// ---------------------------------------------------------------------------
// Inner-registry getter — narrow the unknown extension shape.
// ---------------------------------------------------------------------------

function getInnerRegistry(runtime: RuntimeShape): InnerProviderRegistry | null {
  try {
    const ext = runtime?.extensions?.get?.('providerRegistry');
    // Soft nulls — registry not loaded yet or extension has the wrong
    // shape. These are EXPECTED in the lazy-resolver design (we re-check
    // on every call). Returning null silently is correct here; logging
    // each miss would flood the audit log.
    if (!ext || typeof ext !== 'object') return null;
    const r = ext as InnerProviderRegistry;
    if (typeof r.send !== 'function' && typeof r.get !== 'function') return null;
    return r;
  } catch (err) {
    // Unexpected throw from `extensions.get` itself — that's a real
    // surprise (the extensions surface has a bug). Surface it so the
    // operator can debug rather than silently treat it as "registry
    // missing". S4 in runtime-critical-issues-staged-plan; the keystone
    // tkt_5faf0c33 originally pointed at THIS catch-and-swallow as a
    // canonical instance of Root B (silent skips at cross-surface seams).
    reportSkip(runtime, {
      source: 'blur-agent/d29-provider-adapter/getInnerRegistry',
      intended: "resolve runtime.extensions.get('providerRegistry') for D29 fallback dispatch",
      error: err,
    });
    return null;
  }
}
