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

export class ProviderRegistry {
  private byKind = new Map<string, ProviderImpl>();
  private registeredAtByKind = new Map<string, string>();

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

  /** Get the impl for a kind, or null. */
  get(kind: string): ProviderImpl | null {
    return this.byKind.get(kind) ?? null;
  }

  /** Public info view of one provider. */
  info(kind: string): ProviderInfo | null {
    const impl = this.byKind.get(kind);
    if (!impl) return null;
    return this.toInfo(impl, this.registeredAtByKind.get(kind) ?? new Date().toISOString());
  }

  /** Listing — sanitized view of all registered providers. */
  list(): ProviderInfo[] {
    const out: ProviderInfo[] = [];
    for (const [kind, impl] of this.byKind) {
      out.push(this.toInfo(impl, this.registeredAtByKind.get(kind) ?? new Date().toISOString()));
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
