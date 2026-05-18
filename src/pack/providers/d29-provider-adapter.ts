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
      const model = (provider as { model?: string }).model;
      const req: InnerProviderRequest = {
        messages: [{ role: 'user', content: sendOpts.text }],
        ...(model !== undefined ? { model } : {}),
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
  /** Outer registry to register adapters into. */
  outer: { register: (impl: ProviderImpl) => unknown };
  /** Provider kinds to bridge. Defaults to ['local', 'together']. */
  kinds?: string[];
}

export interface InstallD29AdaptersResult {
  registered: string[];
  skipped: Array<{ kind: string; reason: string }>;
}

export function installD29Adapters(
  runtime: RuntimeShape,
  opts: InstallD29AdaptersOpts,
): InstallD29AdaptersResult {
  const kinds = opts.kinds ?? ['local', 'together'];
  const inner = getInnerRegistry(runtime);
  const result: InstallD29AdaptersResult = { registered: [], skipped: [] };

  if (!inner) {
    for (const k of kinds) result.skipped.push({ kind: k, reason: 'no inner providerRegistry extension' });
    return result;
  }

  for (const k of kinds) {
    const present = typeof inner.has === 'function' ? inner.has(k) : !!inner.get?.(k);
    if (!present) {
      result.skipped.push({ kind: k, reason: 'inner provider not registered' });
      continue;
    }
    const inner_p = typeof inner.get === 'function' ? inner.get(k) : null;
    try {
      opts.outer.register(
        d29ProviderAdapter(runtime, {
          kind: k,
          label: inner_p?.label,
          description: inner_p?.description,
        }),
      );
      result.registered.push(k);
    } catch (err) {
      result.skipped.push({
        kind: k,
        reason: `outer register failed: ${(err as Error)?.message ?? String(err)}`,
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
