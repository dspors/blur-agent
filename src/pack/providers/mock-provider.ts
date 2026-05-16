/**
 * Mock provider — in-process scripted replies for tests + smoke checks.
 *
 * Two modes:
 *
 *   1. `script` omitted (default) — emits a single text chunk
 *      "[mock reply for <agent.label>] <request text>" then completes
 *      after a small delay. Sufficient for verifying the
 *      sendMessage → getReply → complete loop.
 *
 *   2. `script: '<keyword>'` — looks up a canned sequence keyed by
 *      keyword. Today only 'echo' (single-text repeat) and 'multi'
 *      (3 text chunks then complete). Open-ended; tests register more
 *      via MockScripts.register('<keyword>', ScriptFn) if they need
 *      richer canned sequences.
 *
 * Importantly: this provider does NOT depend on the bridge daemon, on
 * MCP, on the network, on time of day. It's pure-in-process so unit
 * tests for the dispatcher / replies-subsystem can exercise the full
 * sendMessage → getReply → complete loop with zero external deps.
 */

import type { Agent, MockProvider, SendMessageOpts } from '../types';
import type { AgentRepliesSink, ProviderImpl } from '../provider-registry';

type ScriptFn = (
  agent: Agent,
  opts: SendMessageOpts,
  replies: AgentRepliesSink,
  handle: string,
) => Promise<void> | void;

/**
 * Registry of canned scripts. Tests can extend via `register()` to
 * exercise specific timing / chunk-shape scenarios.
 */
const SCRIPTS = new Map<string, ScriptFn>();

function defaultScript(
  agent: Agent,
  opts: SendMessageOpts,
  replies: AgentRepliesSink,
  handle: string,
): void {
  const now = new Date().toISOString();
  const startedAtMs = Date.now();
  const text = `[mock reply for ${agent.label || agent.id}] ${opts.text}`;
  // Emit one text chunk immediately.
  replies.appendChunk(handle, [{ kind: 'text', data: text, at: now }]);
  // Complete on next tick.
  setTimeout(() => {
    const endedAt = new Date().toISOString();
    replies.complete(handle, {
      startedAt: now,
      endedAt,
      durationMs: Date.now() - startedAtMs,
      textTotalLen: text.length,
      toolCallCount: 0,
    });
  }, 5);
}

function echoScript(
  agent: Agent,
  opts: SendMessageOpts,
  replies: AgentRepliesSink,
  handle: string,
): void {
  const now = new Date().toISOString();
  const startedAtMs = Date.now();
  replies.appendChunk(handle, [{ kind: 'text', data: opts.text, at: now }]);
  setTimeout(() => {
    replies.complete(handle, {
      startedAt: now,
      endedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAtMs,
      textTotalLen: opts.text.length,
      toolCallCount: 0,
    });
  }, 5);
}

function multiScript(
  agent: Agent,
  opts: SendMessageOpts,
  replies: AgentRepliesSink,
  handle: string,
): void {
  const start = new Date().toISOString();
  const startedAtMs = Date.now();
  const parts = ['first chunk', 'second chunk', 'third chunk'];
  let textTotalLen = 0;
  parts.forEach((p, i) => {
    setTimeout(() => {
      replies.appendChunk(handle, [
        { kind: 'text', data: p, at: new Date().toISOString() },
      ]);
      textTotalLen += p.length;
      if (i === parts.length - 1) {
        setTimeout(() => {
          replies.complete(handle, {
            startedAt: start,
            endedAt: new Date().toISOString(),
            durationMs: Date.now() - startedAtMs,
            textTotalLen,
            toolCallCount: 0,
          });
        }, 5);
      }
    }, 5 * (i + 1));
  });
}

SCRIPTS.set('echo', echoScript);
SCRIPTS.set('multi', multiScript);

export const MockScripts = {
  register(key: string, fn: ScriptFn): void {
    SCRIPTS.set(key, fn);
  },
  list(): string[] {
    return [...SCRIPTS.keys()];
  },
};

export function mockProviderImpl(): ProviderImpl {
  return {
    kind: 'mock',
    label: 'Mock provider',
    description:
      'In-process scripted replies for tests and smoke checks. No external deps. ' +
      "MockProvider.script chooses the canned sequence (default: 'reply to request'; " +
      "'echo': echo the request; 'multi': 3 text chunks then complete).",
    capabilities: {
      contextLength: Number.MAX_SAFE_INTEGER, // pretend unlimited
      toolUse: 'unsupported',
      vision: false,
    },
    sendMessage(agent, opts, replies) {
      const provider = agent.provider;
      if (!provider || provider.kind !== 'mock') {
        throw new Error(
          `mock provider invoked for agent ${agent.id} but provider.kind='${provider?.kind ?? '<none>'}'`,
        );
      }
      const scriptKey = (provider as MockProvider).script;
      const fn = scriptKey ? (SCRIPTS.get(scriptKey) ?? defaultScript) : defaultScript;
      const record = replies.createReply({
        agentId: agent.id,
        request: { text: opts.text, at: new Date().toISOString(), by: opts.by },
        providerKind: 'mock',
      });
      // Kick off async; errors from the script become reply failures.
      Promise.resolve()
        .then(() => fn(agent, opts, replies, record.handle))
        .catch(err => {
          replies.fail(record.handle, (err as Error)?.message ?? String(err));
        });
      return { replyHandle: record.handle };
    },
  };
}
