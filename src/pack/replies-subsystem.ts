/**
 * AgentRepliesSubsystem — first-class ReplyRecord storage with
 * append-only chunk push, long-poll completion signaling, audit
 * emission, and TTL'd persistence.
 *
 * Mounted at `runtime.agents.replies` (read-side primitives) and used
 * internally by `agents.sendMessage` / `agents.getReply` to back the
 * Decision 29 request/reply contract.
 *
 * Architectural notes:
 *
 *   - Records persist via Persistable (Decision 20). The chunks
 *     themselves are NOT persisted — they're reconstructible from the
 *     upstream provider's handle on demand. Persisting just the
 *     metadata tuple keeps the snapshot small and forward-compatible.
 *
 *   - On `loadJson()`, records arrive with empty `chunks: []`. For
 *     'streaming' records with an `upstreamHandle`, callers may
 *     trigger a re-anchor via the upstream provider; this subsystem
 *     does NOT auto-replay on load (the provider is the source of
 *     truth for chunks). Documented; not a bug.
 *
 *   - Long-poll waiters are realm-local (closure-bound on the host
 *     side). They DO NOT survive a runtime restart; callers re-poll
 *     after restart and the next chunk push wakes them. The persisted
 *     `nextOffset` semantics (caller passes their last seen offset)
 *     make this safe.
 *
 *   - Audit emit (Decision 21) fires on every transition:
 *       agents.reply.created   — new handle minted
 *       agents.reply.chunk     — chunks appended
 *       agents.reply.complete  — status → 'complete'
 *       agents.reply.error     — status → 'error'
 *     Pack-author subscribers (UI surfaces, telemetry sinks) attach
 *     to these via runtime.audit.subscribe(...).
 *
 *   - TTL sweep: completed/errored records expire 24h after
 *     `endedAt`. Streaming records that go silent past a threshold
 *     (default 10min, configurable via REPLIES_MAX_STREAMING_AGE_MS)
 *     are marked errored with timeout — parallels the daemon's
 *     `gap #3 max-streaming-age sweep` so the in-runtime view matches
 *     the daemon's behavior.
 */

import { randomUUID } from 'crypto';
import type { BlurAIRuntime, Persistable } from 'blur-ai-runtime';
import type {
  AgentProvider,
  GetReplyOpts,
  ReplyChunk,
  ReplyPoll,
  ReplyRecord,
  ReplySummary,
} from './types';

interface Waiter {
  resolve: (poll: ReplyPoll) => void;
  sinceOffset: number;
  expiresAt: number;
  timer: NodeJS.Timeout | null;
}

interface PersistedShape {
  /** Schema version — bump on incompatible changes. */
  version: number;
  records: Array<Omit<ReplyRecord, 'chunks'>>;
}

const SCHEMA_VERSION = 1;
const DEFAULT_LONG_POLL_MS = 25_000;
const MAX_LONG_POLL_MS = 60_000;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24h after endedAt
const DEFAULT_MAX_STREAMING_AGE_MS = parseEnvInt(
  process.env.REPLIES_MAX_STREAMING_AGE_MS,
  10 * 60 * 1000, // 10 min
);
const SWEEP_INTERVAL_MS = 60 * 1000; // 1 minute

function parseEnvInt(v: string | undefined, def: number): number {
  if (!v) return def;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}

export class AgentRepliesSubsystem implements Persistable {
  private byHandle = new Map<string, ReplyRecord>();
  private waiters = new Map<string, Waiter[]>();
  private sweepTimer: NodeJS.Timeout | null = null;
  /**
   * Decision 31 Phase A — self-tracked dirty flag. Set true on every
   * ReplyRecord mutation, including the timer-driven sweep that
   * deletes expired records and transitions stale streamers.
   * `consumeDirty()` returns + resets.
   */
  private _dirty = false;

  constructor(public readonly runtime: BlurAIRuntime) {}

  // -------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------

  /** Begin the TTL sweep timer. Called at pack install. */
  start(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    // Don't keep the event loop alive just for the sweep.
    if (typeof this.sweepTimer.unref === 'function') this.sweepTimer.unref();
  }

  /** Stop the sweep, fail any pending waiters cleanly. Called at pack unload. */
  stop(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    // Resolve all pending waiters with whatever they have so far.
    for (const [handle, list] of this.waiters) {
      const record = this.byHandle.get(handle);
      for (const w of list) {
        if (w.timer) clearTimeout(w.timer);
        if (record) w.resolve(this.pollOf(record, w.sinceOffset));
        else w.resolve(this.errorPoll('subsystem stopped'));
      }
    }
    this.waiters.clear();
  }

  // -------------------------------------------------------------------
  // Mutations — called by ProviderImpl.sendMessage and friends
  // -------------------------------------------------------------------

  /** Mint a new ReplyRecord. Returns the live record (not a clone). */
  createReply(opts: {
    agentId: string;
    request: { text: string; at: string; by?: string };
    providerKind: AgentProvider['kind'];
    upstreamHandle?: string;
  }): ReplyRecord {
    if (!opts.agentId) throw new Error('agents.replies.createReply: agentId is required');
    if (!opts.request?.text) throw new Error('agents.replies.createReply: request.text is required');
    const now = new Date().toISOString();
    const handle = `rep_${randomUUID()}`;
    const record: ReplyRecord = {
      handle,
      agentId: opts.agentId,
      request: { ...opts.request, at: opts.request.at || now },
      providerKind: opts.providerKind,
      status: 'streaming',
      startedAt: now,
      chunks: [],
      upstreamHandle: opts.upstreamHandle,
    };
    this.byHandle.set(handle, record);
    this._dirty = true;
    this.emit('agents.reply.created', `item:agents.replies[${handle}]`, {
      handle,
      agentId: opts.agentId,
      providerKind: opts.providerKind,
      upstreamHandle: opts.upstreamHandle ?? null,
    });
    return record;
  }

  /** Append chunks to an existing record. Wakes any waiting long-polls. */
  appendChunk(handle: string, rawChunks: Array<Omit<ReplyChunk, 'offset'>>): void {
    const record = this.byHandle.get(handle);
    if (!record) {
      // Silently drop; the chunk arrived for a handle we don't know.
      // Provider implementations should not be racing with handle deletion.
      return;
    }
    if (record.status !== 'streaming') {
      // Late chunks for a finished record — drop with audit signal.
      this.emit('agents.reply.late-chunk', `item:agents.replies[${handle}]`, {
        handle,
        currentStatus: record.status,
        droppedCount: rawChunks.length,
      });
      return;
    }
    let base = record.chunks.length;
    const normalized: ReplyChunk[] = [];
    for (const c of rawChunks) {
      normalized.push({
        offset: base++,
        kind: c.kind,
        data: c.data,
        at: c.at || new Date().toISOString(),
      });
    }
    record.chunks.push(...normalized);
    // ReplyRecord's chunks are stripped from saveJson (Decision 29), but
    // the record-level metadata (totalChunkCount, lastActivityAt-style
    // fields if any) is what we care about; flag dirty so the
    // streaming-record metadata gets a fresh snapshot.
    this._dirty = true;
    this.emit('agents.reply.chunk', `item:agents.replies[${handle}]`, {
      handle,
      newChunkCount: normalized.length,
      totalChunkCount: record.chunks.length,
      kinds: normalized.map(c => c.kind),
    });
    this.wakeWaiters(handle);
  }

  /** Mark a record complete with the final summary. Idempotent. */
  complete(handle: string, summary: ReplySummary): void {
    const record = this.byHandle.get(handle);
    if (!record) return;
    if (record.status !== 'streaming') return;
    record.status = 'complete';
    record.endedAt = summary.endedAt || new Date().toISOString();
    record.finalSummary = { ...summary };
    if (summary.truncatedByTimeout) record.truncatedByTimeout = true;
    this._dirty = true;
    this.emit('agents.reply.complete', `item:agents.replies[${handle}]`, {
      handle,
      durationMs: summary.durationMs,
      textTotalLen: summary.textTotalLen,
      toolCallCount: summary.toolCallCount,
      truncatedByTimeout: !!summary.truncatedByTimeout,
    });
    this.wakeWaiters(handle);
  }

  /** Mark a record errored. Idempotent for already-finished records. */
  fail(handle: string, errorMessage: string): void {
    const record = this.byHandle.get(handle);
    if (!record) return;
    if (record.status !== 'streaming') return;
    record.status = 'error';
    record.endedAt = new Date().toISOString();
    record.errorMessage = errorMessage;
    this._dirty = true;
    this.emit('agents.reply.error', `item:agents.replies[${handle}]`, {
      handle,
      errorMessage,
    });
    this.wakeWaiters(handle);
  }

  // -------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------

  /** Return a cloned record or null. */
  get(handle: string): ReplyRecord | null {
    const r = this.byHandle.get(handle);
    return r ? cloneRecord(r) : null;
  }

  /**
   * List records (cloned). Filterable by agent / status / since-cutoff.
   * Newest first.
   */
  list(filter?: {
    agentId?: string;
    status?: ReplyRecord['status'];
    since?: string;
  }): ReplyRecord[] {
    const sinceMs = filter?.since ? Date.parse(filter.since) : null;
    const out: ReplyRecord[] = [];
    for (const r of this.byHandle.values()) {
      if (filter?.agentId && r.agentId !== filter.agentId) continue;
      if (filter?.status && r.status !== filter.status) continue;
      if (sinceMs !== null && Date.parse(r.startedAt) < sinceMs) continue;
      out.push(cloneRecord(r));
    }
    out.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
    return out;
  }

  /** Count records, optionally filtered. */
  count(filter?: { agentId?: string; status?: ReplyRecord['status'] }): number {
    let n = 0;
    for (const r of this.byHandle.values()) {
      if (filter?.agentId && r.agentId !== filter.agentId) continue;
      if (filter?.status && r.status !== filter.status) continue;
      n++;
    }
    return n;
  }

  // -------------------------------------------------------------------
  // Long-poll
  // -------------------------------------------------------------------

  /**
   * Pull-mode poll. With `wait: 'long-poll'`, the call suspends until
   * either new chunks land OR status leaves 'streaming' OR `timeoutMs`
   * elapses (default 25_000 ms; capped at MAX_LONG_POLL_MS).
   */
  async getReply(handle: string, opts?: GetReplyOpts): Promise<ReplyPoll> {
    const record = this.byHandle.get(handle);
    if (!record) {
      return this.errorPoll(`no such replyHandle: ${handle}`);
    }
    const sinceOffset = Math.max(0, opts?.sinceOffset ?? 0);
    // Immediate return if we have new chunks, OR not streaming, OR no-wait.
    const wait = opts?.wait ?? 'none';
    if (
      wait === 'none' ||
      record.status !== 'streaming' ||
      record.chunks.length > sinceOffset
    ) {
      return this.pollOf(record, sinceOffset);
    }
    // Long-poll path.
    const timeoutMs = Math.min(opts?.timeoutMs ?? DEFAULT_LONG_POLL_MS, MAX_LONG_POLL_MS);
    return new Promise<ReplyPoll>(resolve => {
      const expiresAt = Date.now() + timeoutMs;
      const waiter: Waiter = {
        resolve,
        sinceOffset,
        expiresAt,
        timer: setTimeout(() => {
          // On timeout, return whatever state we have. Caller loops.
          const cur = this.byHandle.get(handle);
          if (cur) resolve(this.pollOf(cur, sinceOffset));
          else resolve(this.errorPoll(`replyHandle dropped during wait: ${handle}`));
          // Remove this waiter from the list.
          this.dropWaiter(handle, waiter);
        }, timeoutMs),
      };
      this.pushWaiter(handle, waiter);
    });
  }

  // -------------------------------------------------------------------
  // Persistable (Decision 20)
  // -------------------------------------------------------------------

  saveJson(): string {
    const persisted: PersistedShape = {
      version: SCHEMA_VERSION,
      records: [...this.byHandle.values()].map(r => {
        // Strip chunks before persisting (Decision 29 — reconstructible).
        const { chunks: _chunks, ...rest } = r;
        return rest;
      }),
    };
    return JSON.stringify(persisted);
  }

  loadJson(s: string): void {
    if (!s || typeof s !== 'string') return;
    let parsed: PersistedShape;
    try {
      parsed = JSON.parse(s) as PersistedShape;
    } catch (err) {
      console.warn(
        `[agents.replies] loadJson: parse failed — ${(err as Error).message}; starting empty`,
      );
      return;
    }
    if (!parsed || parsed.version !== SCHEMA_VERSION || !Array.isArray(parsed.records)) {
      return;
    }
    this.byHandle.clear();
    for (const stub of parsed.records) {
      this.byHandle.set(stub.handle, { ...stub, chunks: [] });
    }
    // Restore is not a mutation.
    this._dirty = false;
  }

  /**
   * Decision 31 Phase A — Persistable.consumeDirty. Returns true iff
   * ReplyRecord state changed since the last call, and atomically resets.
   */
  consumeDirty(): boolean {
    const d = this._dirty;
    this._dirty = false;
    return d;
  }

  // -------------------------------------------------------------------
  // TTL sweep
  // -------------------------------------------------------------------

  private sweep(): void {
    const now = Date.now();
    const toDelete: string[] = [];
    for (const [handle, record] of this.byHandle) {
      // Streaming records past max age → mark errored.
      if (record.status === 'streaming') {
        const ageMs = now - Date.parse(record.startedAt);
        if (ageMs > DEFAULT_MAX_STREAMING_AGE_MS) {
          this.fail(
            handle,
            `timeout: streaming exceeded REPLIES_MAX_STREAMING_AGE_MS (${DEFAULT_MAX_STREAMING_AGE_MS}ms)`,
          );
          // Don't delete this pass; let the next sweep (after endedAt
          // settles into TTL territory) handle it.
          continue;
        }
      }
      // Finished records past TTL → delete.
      if (record.endedAt) {
        const sinceEndedMs = now - Date.parse(record.endedAt);
        if (sinceEndedMs > DEFAULT_TTL_MS) toDelete.push(handle);
      }
    }
    for (const h of toDelete) this.byHandle.delete(h);
    // sweep mutates byHandle out-of-band (timer-driven, not a script
    // primitive call). The fail() path inside the loop already flips
    // _dirty for any timeouts it transitions; the TTL-delete loop also
    // mutates state, so set the flag if we deleted anything.
    if (toDelete.length > 0) this._dirty = true;
  }

  // -------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------

  private pollOf(record: ReplyRecord, sinceOffset: number): ReplyPoll {
    const newChunks = record.chunks.slice(sinceOffset).map(cloneChunk);
    const nextOffset = record.chunks.length;
    const status = record.status;
    const more = status === 'streaming';
    const poll: ReplyPoll = { chunks: newChunks, nextOffset, status, more };
    if (status === 'complete' && record.finalSummary) {
      poll.finalSummary = { ...record.finalSummary };
    }
    if (status === 'error') poll.errorMessage = record.errorMessage;
    return poll;
  }

  private errorPoll(msg: string): ReplyPoll {
    return {
      chunks: [],
      nextOffset: 0,
      status: 'error',
      more: false,
      errorMessage: msg,
    };
  }

  private pushWaiter(handle: string, w: Waiter): void {
    let list = this.waiters.get(handle);
    if (!list) {
      list = [];
      this.waiters.set(handle, list);
    }
    list.push(w);
  }

  private dropWaiter(handle: string, w: Waiter): void {
    const list = this.waiters.get(handle);
    if (!list) return;
    const idx = list.indexOf(w);
    if (idx >= 0) list.splice(idx, 1);
    if (list.length === 0) this.waiters.delete(handle);
  }

  private wakeWaiters(handle: string): void {
    const list = this.waiters.get(handle);
    if (!list || list.length === 0) return;
    const record = this.byHandle.get(handle);
    if (!record) return;
    // Wake any waiter whose sinceOffset is now satisfied OR whose
    // record has transitioned out of streaming.
    const stillWaiting: Waiter[] = [];
    for (const w of list) {
      if (record.chunks.length > w.sinceOffset || record.status !== 'streaming') {
        if (w.timer) clearTimeout(w.timer);
        w.resolve(this.pollOf(record, w.sinceOffset));
      } else {
        stillWaiting.push(w);
      }
    }
    if (stillWaiting.length > 0) this.waiters.set(handle, stillWaiting);
    else this.waiters.delete(handle);
  }

  private emit(kind: string, ref: string, data: Record<string, unknown>): void {
    try {
      // Audit emit (Decision 21). Tolerate runtime.audit being missing
      // in tests / partial wiring.
      const audit = (this.runtime as { audit?: { emit?: (e: unknown) => void } }).audit;
      if (audit?.emit) audit.emit({ kind, ref, data });
    } catch {
      /* swallow — audit failures must not break the reply flow */
    }
  }
}

function cloneChunk(c: ReplyChunk): ReplyChunk {
  return { ...c };
}

function cloneRecord(r: ReplyRecord): ReplyRecord {
  return {
    ...r,
    request: { ...r.request },
    chunks: r.chunks.map(cloneChunk),
    finalSummary: r.finalSummary ? { ...r.finalSummary } : undefined,
  };
}
