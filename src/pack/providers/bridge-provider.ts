/**
 * BridgeProvider — Claude session via the bridge daemon.
 *
 * Implements the Decision 29 provider contract by delegating to
 * `runtime.bridge.sessions.requestReply` and `getReply`, which the
 * cowork-web-bridge runtime-pack (v0.3.0+) exposes for blur-runtime
 * scripts. Identity stamping defaults to `bk_<agent.provider.sessionId>`
 * — the BridgeProvider's `sessionId` is the agent's caller identity on
 * the bridge wire.
 *
 * Architecture:
 *
 *   - sendMessage() fires `bridge.sessions.requestReply(targetSession,
 *     text, { bridgeKey, forceDuplicate, idempotencyKey })`.
 *     IMPORTANT: the BridgeProvider's `sessionId` field is the agent's
 *     OWN session — the identity it speaks AS. The TARGET session
 *     (whom the agent is sending TO) comes from `opts.toSessionId` or
 *     from the agent's bindings (when bound to a session-scope ref).
 *
 *   - Once the upstream `bridge.replyHandle` is in hand, we mint a
 *     local ReplyRecord (so blur-agent callers get a stable handle
 *     in our own namespace) and start a polling loop that calls
 *     `bridge.sessions.getReply(upstreamHandle, { wait: 'long-poll' })`
 *     in a background async iterator, feeding chunks into the local
 *     record via `replies.appendChunk` and eventually `replies.complete`.
 *
 *   - On provider error (network drop, daemon unreachable, etc.), we
 *     fail the local record with the error message and stop polling.
 *
 *   - On daemon-bounce: the bridge daemon's persistence survives, so
 *     the upstream handle remains valid. Our polling loop simply
 *     receives an error on the in-flight long-poll, retries once after
 *     a short backoff, and resumes if the handle is still streaming.
 *     (Implementation: simple 3-strikes retry before giving up.)
 *
 *   - sendMessage opts:
 *       - `text` is the message to send
 *       - `by` is recorded on the local ReplyRecord
 *       - `forceDuplicate` / `idempotencyKey` pass through to the
 *         daemon's dedupe layer
 *       - `toSessionId` (extension beyond SendMessageOpts) lets the
 *         caller explicitly target a different bridge session — useful
 *         when an agent is sending TO another session, not echoing
 *         to its own. Defaults to the agent's own provider.sessionId
 *         (agent sends to itself — useful for re-prompting / probes).
 */

import type { Agent, BridgeProvider, SendMessageOpts } from '../types';
import type { AgentRepliesSink, ProviderImpl } from '../provider-registry';
import type { BlurAIRuntime } from 'blur-ai-runtime';

/**
 * Minimal shape of the stateless BridgeProvider host-object (registered by
 * blur-providers-bridge) we reach via runtime.extensions.get('bridgeProvider').
 * Used by the auto-anon-lease path below when no sessionId is bound on the
 * agent. The exposed methods are `acquireForChain` (single-opts shape) and
 * `releaseChain` — NOT the raw acquireThread/releaseThread on the underlying
 * BridgeProvider class. See blur-providers/packages/bridge/src/pack/index.ts.
 */
interface StatelessBridgeProviderShape {
  acquireForChain(opts: {
    chainId: string;
    host?: string | null;
    model?: string;
    role?: string;
    preamble?: string;
    callerLabel?: string;
  }): Promise<{ sessionId: string; model?: string; role?: string }>;
  releaseChain(chainId: string): boolean;
}

interface BridgeRuntimeShape {
  sessions: {
    requestReply: (
      id: string,
      text: string,
      opts?: {
        host?: string;
        bridgeKey?: string;
        originLabel?: string;
        suppressOrigin?: boolean;
        forceDuplicate?: boolean;
        idempotencyKey?: string;
      },
    ) => Promise<{
      success: boolean;
      sessionId?: string;
      sessionTitle?: string;
      verifiedVia?: string;
      preSendJsonlOffset?: number | null;
      replyHandle: string | null;
      dedupedFromReqId?: string;
    }>;
    getReply: (
      handle: string,
      opts?: {
        sinceOffset?: number;
        wait?: 'none' | 'long-poll';
        timeoutMs?: number;
        host?: string;
      },
    ) => Promise<{
      chunks: Array<{
        offset: number;
        kind: 'text' | 'tool-call' | 'tool-result' | 'event' | 'meta';
        data: unknown;
        at: string;
      }>;
      nextOffset: number;
      status: 'streaming' | 'complete' | 'error';
      more: boolean;
      finalSummary?: {
        startedAt: string;
        endedAt: string;
        durationMs: number;
        textTotalLen: number | null;
        toolCallCount: number | null;
        truncatedByTimeout: boolean;
      };
      errorMessage?: string;
    }>;
  };
}

/** BridgeProvider-specific extension to SendMessageOpts. */
export interface BridgeSendMessageOpts extends SendMessageOpts {
  /**
   * Explicit target session. Defaults to the agent's own
   * provider.sessionId — useful for self-probes. For agent-to-agent
   * delegation, pass the target's sessionId here.
   */
  toSessionId?: string;
  /** Optional bridge mesh host override. */
  host?: string;
}

const LONG_POLL_MS = 25_000;
const MAX_POLL_RETRIES = 3;
const POLL_RETRY_BACKOFF_MS = 1500;

export function bridgeProviderImpl(runtime: BlurAIRuntime): ProviderImpl {
  return {
    kind: 'bridge',
    label: 'Bridge (Claude session)',
    description:
      'Routes through the bridge daemon to a Claude session. ' +
      'sendMessage delegates to runtime.bridge.sessions.requestReply; ' +
      'reply chunks are polled via getReply and fed into the local ' +
      'ReplyRecord. Identity stamped via bridgeKey=bk_<agent.provider.sessionId>.',
    capabilities: {
      // Inherits whatever Claude session model is on the other end;
      // we don't enforce contextLength here.
      toolUse: 'native',
      vision: true,
    },
    async sendMessage(agent, opts, replies) {
      const provider = agent.provider;
      if (!provider || provider.kind !== 'bridge') {
        throw new Error(
          `bridge provider invoked for agent ${agent.id} but provider.kind='${provider?.kind ?? '<none>'}'`,
        );
      }
      const bp = provider as BridgeProvider;

      // Pack-to-pack reach via the runtime extensions registry (same
      // pattern AgentsSubsystem uses for pool). Decision 17 + 18 —
      // pack code does NOT assume direct property access via
      // `runtime.<other-pack>`; the extensions Map is the canonical
      // way to find another pack's host-side objects.
      const extensions = (runtime as unknown as { extensions: { get(name: string): unknown } }).extensions;
      const bridgeApi = extensions?.get('bridge') as BridgeRuntimeShape | undefined;
      if (!bridgeApi?.sessions?.requestReply || !bridgeApi.sessions.getReply) {
        throw new Error(
          'bridge provider: runtime.extensions.get("bridge").sessions.requestReply / getReply not available. ' +
          'Ensure the cowork-web-bridge runtime-pack (>=0.3.0) is loaded.',
        );
      }

      // Auto-anon-lease path (Phase B.6.1 — 2026-06-01):
      // When the agent has no provider.sessionId bound, mirror the
      // stateless BridgeProvider.sendMessage behavior and acquire an
      // anon lease via the stateless impl. This unlocks chat.completions
      // → bridge for Proceedings + any other agent-bound caller that
      // doesn't pre-lease (e.g. synthetic chat-completions agents have
      // no upstream owner to assign a session).
      //
      // Pattern: acquireThread (anon when no role context) → use the
      // returned sessionId as targetSessionId → existing streaming path
      // → releaseThread on completion (anon persists; the lease is just
      // an acquire/release accounting handle).
      let leasedChainId: string | null = null;
      let effectiveSessionId: string;
      if (bp.sessionId) {
        effectiveSessionId = bp.sessionId;
      } else {
        const statelessBridge = extensions?.get('bridgeProvider') as
          | StatelessBridgeProviderShape
          | undefined;
        if (!statelessBridge?.acquireForChain) {
          throw new Error(
            `bridge provider for agent ${agent.id}: provider.sessionId is missing AND ` +
            `runtime.extensions.get("bridgeProvider").acquireForChain is unavailable. ` +
            'Either bind a sessionId on the agent (real-runner workflows) or ensure ' +
            'the blur-providers-bridge pack is loaded (auto-anon-lease workflows).',
          );
        }
        leasedChainId = `agent-bound::${agent.id}::${Date.now().toString(36)}`;
        // `provider.model` lives on synthetic chat.completions agents
        // (chat-completions-subsystem stamps it) but isn't declared on
        // the BridgeProvider type. Read it via a structural cast.
        const modelHint =
          (provider as unknown as { model?: string }).model ?? 'sonnet';
        const lease = await statelessBridge.acquireForChain({
          chainId: leasedChainId,
          host: null,
          model: modelHint,
          callerLabel: `chat.completions/${agent.id}`,
        });
        effectiveSessionId = lease.sessionId;
      }

      const bOpts = opts as BridgeSendMessageOpts;
      const targetSessionId = bOpts.toSessionId || effectiveSessionId;
      const bridgeKey = `bk_${effectiveSessionId}`;
      const requestAt = new Date().toISOString();

      // Mint the LOCAL record first so we have a handle to return even
      // if the upstream call hangs briefly. We then attach the upstream
      // handle once we have it.
      const localRecord = replies.createReply({
        agentId: agent.id,
        request: { text: opts.text, at: requestAt, by: opts.by },
        providerKind: 'bridge',
      });

      // Fire the upstream requestReply asynchronously so this function
      // returns the local handle promptly. Chunks arrive via the poll
      // loop below. If we acquired an auto-anon lease above, release it
      // after the upstream poll terminates (success OR failure path)
      // so the BridgeProvider's accounting stays correct.
      (async () => {
        let upstreamHandle: string | null = null;
        try {
          const envelope = await bridgeApi.sessions.requestReply(targetSessionId, opts.text, {
            host: bOpts.host,
            bridgeKey,
            originLabel: `blur-agent:${agent.id}`,
            forceDuplicate: opts.forceDuplicate,
            idempotencyKey: opts.idempotencyKey,
          });
          if (!envelope.replyHandle) {
            throw new Error(
              `bridge.requestReply returned no replyHandle (success=${envelope.success}, verifiedVia=${envelope.verifiedVia})`,
            );
          }
          upstreamHandle = envelope.replyHandle;
          replies.appendChunk(localRecord.handle, [
            {
              kind: 'meta',
              data: {
                upstreamHandle,
                dedupedFromReqId: envelope.dedupedFromReqId ?? null,
                verifiedVia: envelope.verifiedVia ?? null,
                preSendJsonlOffset: envelope.preSendJsonlOffset ?? null,
              },
              at: new Date().toISOString(),
            },
          ]);
          await pollUpstream(bridgeApi, upstreamHandle, localRecord.handle, replies, bOpts.host);
        } catch (err) {
          const msg = (err as Error)?.message ?? String(err);
          replies.fail(localRecord.handle, msg);
        } finally {
          // Release the auto-anon lease (no-op for caller-bound sessions).
          if (leasedChainId) {
            try {
              const statelessBridge = extensions?.get('bridgeProvider') as
                | StatelessBridgeProviderShape
                | undefined;
              statelessBridge?.releaseChain?.(leasedChainId);
            } catch (releaseErr) {
              // eslint-disable-next-line no-console
              console.warn(
                `[bridge-adapter] releaseThread failed for ${leasedChainId}: ${(releaseErr as Error)?.message ?? releaseErr}`,
              );
            }
          }
        }
      })();

      return { replyHandle: localRecord.handle };
    },
  };
}

/**
 * Long-poll the upstream bridge replyHandle, feeding chunks into the
 * local record. Resumes seamlessly across daemon hiccups via a small
 * retry budget. Stops when the upstream reports complete or error, or
 * when the retry budget is exhausted.
 */
async function pollUpstream(
  bridgeApi: BridgeRuntimeShape,
  upstreamHandle: string,
  localHandle: string,
  replies: AgentRepliesSink,
  host?: string,
): Promise<void> {
  let sinceOffset = 0;
  let retries = 0;

  while (true) {
    let poll;
    try {
      poll = await bridgeApi.sessions.getReply(upstreamHandle, {
        sinceOffset,
        wait: 'long-poll',
        timeoutMs: LONG_POLL_MS,
        host,
      });
      retries = 0;
    } catch (err) {
      retries++;
      if (retries > MAX_POLL_RETRIES) {
        replies.fail(
          localHandle,
          `upstream poll failed after ${MAX_POLL_RETRIES} retries: ${(err as Error)?.message ?? String(err)}`,
        );
        return;
      }
      await sleep(POLL_RETRY_BACKOFF_MS);
      continue;
    }

    if (poll.chunks.length > 0) {
      // Translate upstream chunk shape (with `offset`) into the local
      // sink shape (offset is assigned by the sink).
      replies.appendChunk(
        localHandle,
        poll.chunks.map(c => ({
          kind: c.kind,
          data: c.data,
          at: c.at,
        })),
      );
    }

    sinceOffset = poll.nextOffset;

    if (poll.status === 'complete') {
      const fs = poll.finalSummary;
      if (fs) {
        replies.complete(localHandle, {
          startedAt: fs.startedAt,
          endedAt: fs.endedAt,
          durationMs: fs.durationMs,
          textTotalLen: fs.textTotalLen ?? 0,
          toolCallCount: fs.toolCallCount ?? 0,
          truncatedByTimeout: fs.truncatedByTimeout,
        });
      } else {
        // Defensive — daemon should always send finalSummary on complete.
        replies.complete(localHandle, {
          startedAt: new Date().toISOString(),
          endedAt: new Date().toISOString(),
          durationMs: 0,
          textTotalLen: 0,
          toolCallCount: 0,
        });
      }
      return;
    }

    if (poll.status === 'error') {
      replies.fail(localHandle, poll.errorMessage ?? 'upstream errored');
      return;
    }

    if (!poll.more) return; // Defensive: nothing left to wait for.
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
