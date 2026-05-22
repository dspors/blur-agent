/**
 * ProviderRegistry — open registry of AgentProvider implementations.
 *
 * Decision 29 establishes providers as a parallel-axis to roles: roles
 * say WHAT an agent is responsible for; providers say HOW we reach the
 * inference target backing that agent. Providers register themselves
 * at install time (built-ins) or at runtime via
 * `runtime.agents.providers.register(...)`. The registry is keyed on
 * `AgentProvider['kind']` and enforces single-impl-per-kind (last
 * register wins; warns on replace).
 *
 * The actual send/reply mechanics live in each provider's
 * `ProviderImpl.sendMessage` — invoked by the AgentsSubsystem's
 * `sendMessage` dispatcher. The registry only routes.
 *
 * Escape hatches: providers MAY contribute their own primitive
 * exposures (e.g. `runtime.agents.providers.openai.responses(...)`
 * for structured outputs, or
 * `runtime.agents.providers.bridge.execute(...)` for raw bridge calls).
 * The pack install picks them up via the optional `exposures` field.
 */

import type { MethodExposure } from 'blur-ai-runtime';
import type { Agent, AgentProvider, SendMessageOpts } from './types';

/**
 * Forward-declared opaque shape for the AgentRepliesSubsystem the
 * provider calls into. Defined as an interface here so this module
 * stays decoupled from the subsystem's implementation file (avoids
 * a circular import path).
 */
export interface AgentRepliesSink {
  /**
   * Mint a new ReplyRecord and return its handle. The provider then
   * appends chunks and ultimately calls complete() / fail().
   */
  createReply(opts: {
    agentId: string;
    request: { text: string; at: string; by?: string };
    providerKind: AgentProvider['kind'];
    upstreamHandle?: string;
  }): { handle: string };

  /** Append chunks to an existing record. */
  appendChunk(
    handle: string,
    chunks: Array<{
      kind: 'text' | 'tool-call' | 'tool-result' | 'event' | 'meta';
      data: unknown;
      at: string;
    }>,
  ): void;

  /** Mark complete with final summary. */
  complete(
    handle: string,
    summary: {
      startedAt: string;
      endedAt: string;
      durationMs: number;
      textTotalLen: number;
      toolCallCount: number;
      truncatedByTimeout?: boolean;
    },
  ): void;

  /** Mark error. */
  fail(handle: string, errorMessage: string): void;
}

/**
 * Capability declaration — provider-side hints to callers. Treated as
 * advisory; surface mismatches as errors at the call site rather than
 * silently degrading.
 */
export interface ProviderCapabilities {
  contextLength?: number;
  toolUse?: 'native' | 'unsupported' | 'limited';
  vision?: boolean;
  /** Cost dimension hints, in USD per 1k tokens. Informational only. */
  costPer1kInput?: number;
  costPer1kOutput?: number;
}

/**
 * Contract every provider implementation satisfies. The registry
 * dispatches to `sendMessage` based on `AgentProvider.kind`.
 */
export interface ProviderImpl {
  /** Which AgentProvider['kind'] this implementation handles. */
  kind: AgentProvider['kind'];
  /** Human-readable label for diagnostics. */
  label: string;
  /** One-line description. */
  description: string;

  /**
   * Fire the message. Mint a ReplyRecord via the `replies` sink, kick
   * off whatever the provider's mechanics require (HTTP call begin,
   * bridge.execute, mock script), and return the new handle. Chunks
   * arrive asynchronously and are pushed via replies.appendChunk();
   * completion via replies.complete(); errors via replies.fail().
   */
  sendMessage(
    agent: Agent,
    opts: SendMessageOpts,
    replies: AgentRepliesSink,
  ): Promise<{ replyHandle: string }> | { replyHandle: string };

  /**
   * Optional capability declaration. Used by the registry's `list()`
   * for diagnostics and by future routing helpers.
   */
  capabilities?: ProviderCapabilities;

  /**
   * Optional provider-specific exposures (the named-escape-hatch
   * pattern from Decision 29). These mount at
   * `runtime.agents.providers.<kind>.*` when the pack installs.
   */
  exposures?: MethodExposure[];
}

/** What `list()` surfaces — a sanitized view, not the live impl. */
export interface ProviderInfo {
  kind: string;
  label: string;
  description: string;
  capabilities?: ProviderCapabilities;
  hasExposures: boolean;
  registeredAt: string;
}

/**
 * Lazy-resolution hook for provider kinds NOT explicitly registered on
 * this registry. tkt_633d0117 follow-up — replaces the prior "install-
 * time pre-registration of D29 adapters" pattern, which was load-order
 * sensitive (blur-agent loaded before blur-providers-core meant the
 * adapter installer saw an empty inner registry and silently skipped).
 *
 * Lazy resolution makes load order irrelevant: `get(kind)` consults the
 * resolver on miss; the resolver re-inspects the inner registry on every
 * call, so a provider that registers AFTER the outer fallback was set
 * is picked up by the very next dispatch.
 *
 * Convention: one fallback at a time. Setting a new fallback replaces
 * any prior one (the prior dispose is a no-op after replacement — by
 * design, the latest installer wins).
 */
export interface ProviderFallback {
  /**
   * Look up an impl by kind. Returns null when the fallback source
   * doesn't know about this kind. The returned impl is used for one
   * dispatch — implementations may return a fresh wrapper each call
   * (cheap closure) or cache internally if expensive to mint.
   */
  resolve: (kind: string) => ProviderImpl | null;
  /**
   * Enumerate the kinds the fallback CAN resolve right now. Used by
   * `list()` / `info()` so the surface reflects every reachable
   * provider, not just the explicitly-registered ones. Order is
   * advisory; the registry de-duplicates against explicit kinds.
   */
  enumerate: () => string[];
}

export class ProviderRegistry {
  private byKind = new Map<string, ProviderImpl>();
  private registeredAtByKind = new Map<string, string>();
  /**
   * tkt_633d0117 follow-up — optional fallback resolver consulted on
   * `get(kind)` miss. See ProviderFallback. Single-slot; setFallback
   * replaces.
   */
  private fallback_: ProviderFallback | null = null;

  /**
   * Register (or replace) a provider implementation. Returns the
   * ProviderInfo for diagnostic confirmation. Replaces silently —
   * caller is responsible for noticing if they didn't expect a replace.
   */
  register(impl: ProviderImpl): ProviderInfo {
    if (!impl || typeof impl !== 'object') {
      throw new Error('agents.providers.register: impl must be a ProviderImpl object');
    }
    if (typeof impl.kind !== 'string' || !impl.kind) {
      throw new Error('agents.providers.register: impl.kind is required (non-empty string)');
    }
    if (typeof impl.sendMessage !== 'function') {
      throw new Error('agents.providers.register: impl.sendMessage must be a function');
    }
    const now = new Date().toISOString();
    this.byKind.set(impl.kind, impl);
    this.registeredAtByKind.set(impl.kind, now);
    return this.toInfo(impl, now);
  }

  /**
   * Remove the provider implementation for `kind`. Returns true if it
   * was registered (and is now removed), false otherwise. tkt_633d0117
   * follow-up — added so the D29 adapter installer can drop the outer
   * adapter when the inner vendor provider unregisters (vendor pack
   * uninstall / hot-reload). Without this, the outer adapter would
   * survive as a stale shell that fails downstream at the inner layer
   * with a confusing "no inner provider" error; better to make the
   * kind disappear from `Known` cleanly so the failure surface is
   * "unknown providerKind", which is the truthful state.
   */
  unregister(kind: string): boolean {
    const had = this.byKind.delete(kind);
    this.registeredAtByKind.delete(kind);
    return had;
  }

  /**
   * Set (or replace) the fallback resolver. Returns a disposer that
   * clears the fallback IFF the same instance is still installed when
   * called — installing a newer fallback first makes the disposer a
   * no-op, so callers can't accidentally tear down someone else's
   * registration. tkt_633d0117 follow-up.
   */
  setFallback(fb: ProviderFallback | null): () => void {
    this.fallback_ = fb;
    const installed = fb;
    return () => {
      if (this.fallback_ === installed) this.fallback_ = null;
    };
  }

  /**
   * Get the impl for a kind. Checks explicit registrations first; then
   * consults the fallback resolver if present. Returns null when no
   * source knows the kind.
   */
  get(kind: string): ProviderImpl | null {
    const explicit = this.byKind.get(kind);
    if (explicit) return explicit;
    if (this.fallback_) {
      try {
        return this.fallback_.resolve(kind) ?? null;
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
          `[ProviderRegistry] fallback resolver threw for kind '${kind}':`,
          err,
        );
        return null;
      }
    }
    return null;
  }

  /** Public info view of one provider. Explicit registrations first, then fallback. */
  info(kind: string): ProviderInfo | null {
    const explicit = this.byKind.get(kind);
    if (explicit) {
      return this.toInfo(explicit, this.registeredAtByKind.get(kind) ?? new Date().toISOString());
    }
    if (this.fallback_) {
      try {
        const impl = this.fallback_.resolve(kind);
        if (impl) return this.toInfo(impl, new Date().toISOString());
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(`[ProviderRegistry.info] fallback resolver threw for kind '${kind}':`, err);
      }
    }
    return null;
  }

  /**
   * Listing — sanitized view of all reachable providers. Explicit
   * registrations are listed in registration order; fallback-resolved
   * kinds are appended (de-duplicated against explicit). tkt_633d0117
   * follow-up — without this, `runtime.agents.providers.list()` would
   * understate the surface ("only mock + bridge") even though dispatch
   * works for fallback-resolved kinds, leaving operators confused
   * about why their `local` / `together` provider is "missing" from
   * the listing but functional in chat.completions.
   */
  list(): ProviderInfo[] {
    const out: ProviderInfo[] = [];
    for (const [kind, impl] of this.byKind) {
      out.push(this.toInfo(impl, this.registeredAtByKind.get(kind) ?? new Date().toISOString()));
    }
    if (this.fallback_) {
      let kinds: string[] = [];
      try {
        kinds = this.fallback_.enumerate() ?? [];
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[ProviderRegistry.list] fallback.enumerate threw:', err);
      }
      const seen = new Set(this.byKind.keys());
      for (const kind of kinds) {
        if (seen.has(kind)) continue;
        let impl: ProviderImpl | null = null;
        try {
          impl = this.fallback_.resolve(kind);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn(`[ProviderRegistry.list] fallback.resolve threw for '${kind}':`, err);
        }
        if (impl) {
          out.push(this.toInfo(impl, new Date().toISOString()));
          seen.add(kind);
        }
      }
    }
    return out;
  }

  /**
   * Collect exposures contributed by registered providers. Called at
   * pack install to mount the per-provider sub-namespaces. Caller
   * deduplicates if necessary.
   */
  collectExposures(): MethodExposure[] {
    const out: MethodExposure[] = [];
    for (const impl of this.byKind.values()) {
      if (Array.isArray(impl.exposures)) {
        for (const e of impl.exposures) out.push(e);
      }
    }
    return out;
  }

  private toInfo(impl: ProviderImpl, registeredAt: string): ProviderInfo {
    return {
      kind: impl.kind,
      label: impl.label,
      description: impl.description,
      capabilities: impl.capabilities ? { ...impl.capabilities } : undefined,
      hasExposures: Array.isArray(impl.exposures) && impl.exposures.length > 0,
      registeredAt,
    };
  }
}
