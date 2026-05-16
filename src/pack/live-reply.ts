/**
 * LiveReply — host-side ergonomic wrapper around a ReplyRecord handle.
 *
 * Hides the handle-string + sinceOffset polling pattern behind a live
 * object that accumulates state as chunks arrive. Designed for host
 * code (other packs, the workspace chat tool, mcp tool handlers) where
 * the developer wants to write:
 *
 *     const reply = await agents.sendText(agentId, 'hello');
 *     while (!reply.finished) response += await reply.get();
 *
 * NOT designed for use across the script.run boundary — the methods
 * are closures over the AgentsSubsystem and don't survive
 * serialization. Scripts continue to use the plain-data
 * sendMessage / getReply pair.
 *
 * Internally a LiveReply holds:
 *   - the replyHandle (durable identifier)
 *   - a sinceOffset cursor (advances on each .get())
 *   - accumulated state (text, toolCalls, status, etc.)
 *   - a reference to the AgentsSubsystem for the actual polls
 *
 * `.get()` returns the text delta since the last call. `.pull()` is
 * the escape hatch — returns raw ReplyChunks for callers who need
 * tool-call / tool-result / event / meta visibility.
 */

import type {
  GetReplyOpts,
  ReplyChunk,
  ReplyPoll,
  ReplySummary,
} from './types';

/** Backref to the AgentsSubsystem methods LiveReply needs. */
export interface LiveReplyBackend {
  getReply(replyHandle: string, opts?: GetReplyOpts): Promise<ReplyPoll>;
}

export class LiveReply {
  /** Durable handle on the underlying ReplyRecord. */
  readonly handle: string;
  /** Agent the reply is FROM. */
  readonly agentId: string;
  /** Turn id this reply belongs to (linked by sendMessage). */
  readonly turnId?: string;

  /** Accumulated text from text-kind chunks. */
  text = '';
  /** Tool-call payloads, in arrival order. */
  toolCalls: unknown[] = [];
  /** Current status — flips to 'complete' / 'error' when reply finishes. */
  status: 'streaming' | 'complete' | 'error' = 'streaming';
  /** Final summary, populated when status === 'complete'. */
  summary?: ReplySummary;
  /** Error message, populated when status === 'error'. */
  errorMessage?: string;
  /** All chunks ever seen, in order. Available via .pull(); kept for escape-hatch access. */
  readonly chunks: ReplyChunk[] = [];

  /** Current offset cursor — next .get() pulls from here onward. */
  private sinceOffset = 0;

  constructor(
    private readonly backend: LiveReplyBackend,
    opts: { handle: string; agentId: string; turnId?: string },
  ) {
    this.handle = opts.handle;
    this.agentId = opts.agentId;
    this.turnId = opts.turnId;
  }

  /** True once status leaves 'streaming'. */
  get finished(): boolean {
    return this.status !== 'streaming';
  }

  /**
   * Pull the next batch of chunks via long-poll. Returns the text
   * delta since the last call (concatenated text-chunk content).
   *
   * Side-effect: updates `this.text`, `this.toolCalls`, `this.chunks`,
   * `this.status`, `this.summary`, `this.errorMessage` and advances
   * the internal cursor.
   *
   * Loop until `finished` is true:
   *
   *     while (!reply.finished) text += await reply.get();
   */
  async get(opts?: { wait?: 'none' | 'long-poll'; timeoutMs?: number }): Promise<string> {
    if (this.finished) return '';
    const poll = await this.backend.getReply(this.handle, {
      sinceOffset: this.sinceOffset,
      wait: opts?.wait ?? 'long-poll',
      timeoutMs: opts?.timeoutMs,
    });
    return this.consumePoll(poll);
  }

  /**
   * Escape hatch — return the raw chunks accumulated since the last
   * .get() call. Useful when the caller needs tool-call / tool-result
   * / event / meta visibility that `.get()` hides.
   *
   * Unlike `.get()`, `.pull()` does NOT long-poll by default — it
   * returns whatever is already available. Pass `wait: 'long-poll'`
   * to block for new chunks.
   */
  async pull(opts?: { wait?: 'none' | 'long-poll'; timeoutMs?: number }): Promise<ReplyChunk[]> {
    if (this.finished) return [];
    const poll = await this.backend.getReply(this.handle, {
      sinceOffset: this.sinceOffset,
      wait: opts?.wait ?? 'none',
      timeoutMs: opts?.timeoutMs,
    });
    this.consumePoll(poll);
    return poll.chunks.map(c => ({ ...c }));
  }

  /**
   * Convenience: pump `.get()` until finished, return self. Equivalent
   * to looping but reads better at the call site:
   *
   *     const final = await reply.await();
   *     log(final.text, final.toolCalls, final.summary);
   *
   * Total timeout `timeoutMs` defaults to 60_000 ms.
   */
  async await(opts?: { timeoutMs?: number }): Promise<this> {
    const totalTimeoutMs = opts?.timeoutMs ?? 60_000;
    const deadline = Date.now() + totalTimeoutMs;
    while (!this.finished) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await this.get({ wait: 'long-poll', timeoutMs: Math.min(remaining, 25_000) });
    }
    if (!this.finished) {
      throw new Error(
        `LiveReply.await: reply did not finish within ${totalTimeoutMs}ms (handle=${this.handle})`,
      );
    }
    if (this.status === 'error') {
      throw new Error(
        `LiveReply.await: reply errored — ${this.errorMessage ?? 'unknown'} (handle=${this.handle})`,
      );
    }
    return this;
  }

  /**
   * AsyncIterable — yield each text delta as chunks arrive:
   *
   *     for await (const delta of reply) process.stdout.write(delta);
   */
  async *[Symbol.asyncIterator](): AsyncIterator<string> {
    while (!this.finished) {
      const delta = await this.get({ wait: 'long-poll' });
      if (delta.length > 0) yield delta;
    }
  }

  /** Snapshot view — plain object copy of live state (no methods). */
  snapshot(): {
    handle: string;
    agentId: string;
    turnId?: string;
    text: string;
    toolCalls: unknown[];
    status: 'streaming' | 'complete' | 'error';
    finished: boolean;
    summary?: ReplySummary;
    errorMessage?: string;
  } {
    return {
      handle: this.handle,
      agentId: this.agentId,
      turnId: this.turnId,
      text: this.text,
      toolCalls: [...this.toolCalls],
      status: this.status,
      finished: this.finished,
      summary: this.summary ? { ...this.summary } : undefined,
      errorMessage: this.errorMessage,
    };
  }

  // -------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------

  /** Consume a ReplyPoll, update state, return text delta. */
  private consumePoll(poll: ReplyPoll): string {
    let textDelta = '';
    for (const c of poll.chunks) {
      this.chunks.push({ ...c });
      if (c.kind === 'text') {
        const t = extractText(c.data);
        if (t) {
          this.text += t;
          textDelta += t;
        }
      } else if (c.kind === 'tool-call') {
        this.toolCalls.push(c.data);
      }
    }
    this.sinceOffset = poll.nextOffset;
    this.status = poll.status;
    if (poll.status === 'complete' && poll.finalSummary) {
      this.summary = { ...poll.finalSummary };
    }
    if (poll.status === 'error') {
      this.errorMessage = poll.errorMessage;
    }
    return textDelta;
  }
}

function extractText(data: unknown): string {
  if (typeof data === 'string') return data;
  if (data && typeof (data as { text?: unknown }).text === 'string') {
    return (data as { text: string }).text;
  }
  return '';
}
