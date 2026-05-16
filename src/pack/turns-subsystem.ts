/**
 * TurnsSubsystem — durable Turn records.
 *
 * A Turn is the atomic unit of state evolution: one prompt-reply pair
 * captured at the "request to reply" granularity, with assembled text,
 * tool calls, side-effects observed during dispatch, and inbound
 * references from domain records (Activities, North Star transcripts,
 * Decisions, etc.). Turns persist independently of the volatile
 * ReplyRecord (which TTLs out at 24h).
 *
 * Architecture:
 *
 *   - Records persist via Persistable (Decision 20). Unlike ReplyRecord,
 *     Turns persist FULLY — assembledText, toolCalls, sideEffects, all
 *     of it. The Turn is the canonical "what happened" record; it's
 *     never lossy.
 *
 *   - Lifecycle: AgentsSubsystem.sendMessage opens a Turn before
 *     dispatching to the provider. The provider feeds chunks into the
 *     ReplyRecord; a poll loop in this subsystem mirrors those chunks
 *     into the Turn (assembledText accumulates, tool-call chunks become
 *     TurnToolCall entries). On reply complete/error, the Turn is
 *     sealed with its final summary and persisted.
 *
 *   - Side-effect collection: this subsystem subscribes to all audit
 *     events. When an event fires:
 *       1. If the event's frame carries `turnId`, attribute directly.
 *       2. Else if the event's `aiSessionId` is mapped to an active
 *          Turn (via the activeBySession index), attribute via mapping.
 *     This gives us two attribution channels — direct (host-side
 *     Turn-scoped emits) and indirect (async tool-call side effects
 *     from the agent's own session).
 *
 *   - References: Activities, North Star transcripts, Decision logs
 *     point at Turns via `addReference`. The Turn record carries the
 *     inbound refs so we can do reverse lookups ("who points at me?")
 *     without scanning the entire runtime.
 *
 *   - Audit emit (Decision 21): every transition fires a semantic event:
 *       agents.turn.opened    — Turn record minted
 *       agents.turn.chunk     — chunks mirrored from the reply
 *       agents.turn.completed — status → 'complete'
 *       agents.turn.errored   — status → 'error'
 *       agents.turn.referenced — addReference called
 */

import { randomUUID } from 'crypto';
import type { BlurAIRuntime, Persistable } from 'blur-ai-runtime';
import type {
  AddTurnReferenceOpts,
  ListTurnsOpts,
  OpenTurnOpts,
  ReplyChunk,
  ReplySummary,
  Turn,
  TurnReference,
  TurnSideEffect,
  TurnStatus,
  TurnToolCall,
} from './types';

interface PersistedShape {
  version: number;
  turns: Turn[];
}

const SCHEMA_VERSION = 1;

/** Map an audit event kind to a TurnSideEffect.op lens. */
function deriveOp(eventKind: string): TurnSideEffect['op'] {
  if (
    eventKind.endsWith('.created') ||
    eventKind.endsWith('.opened') ||
    eventKind.endsWith('.leased') ||
    eventKind.endsWith('.bound')
  ) {
    return 'create';
  }
  if (
    eventKind.endsWith('.updated') ||
    eventKind.endsWith('.changed') ||
    eventKind.endsWith('.set') ||
    eventKind.endsWith('.session-swapped')
  ) {
    return 'set';
  }
  if (eventKind.endsWith('.appended') || eventKind.endsWith('.added') || eventKind.endsWith('.note-added')) {
    return 'append';
  }
  if (
    eventKind.endsWith('.deleted') ||
    eventKind.endsWith('.removed') ||
    eventKind.endsWith('.released') ||
    eventKind.endsWith('.unbound')
  ) {
    return 'delete';
  }
  if (eventKind.endsWith('.registered') || eventKind.endsWith('.role-registered')) {
    return 'register';
  }
  return 'other';
}

export class TurnsSubsystem implements Persistable {
  /** All Turn records keyed by id. */
  private byId = new Map<string, Turn>();

  /**
   * Map of aiSessionId → turnId for the currently-streaming Turn on
   * that session. Used by the audit subscriber to attribute side
   * effects emitted by the agent's session-side work to the originating
   * Turn when the audit frame doesn't carry turnId directly.
   *
   * Cleared when the Turn seals (status leaves 'streaming').
   */
  private activeBySession = new Map<string, string>();

  /** Unsubscribe function from the audit subscription. */
  private unsubAudit: (() => void) | null = null;

  /** Audit events to ignore — Turn lifecycle events that would loop. */
  private static IGNORED_EVENT_PREFIXES = ['agents.turn.', 'agents.reply.'];

  constructor(public readonly runtime: BlurAIRuntime) {}

  // -------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------

  start(): void {
    if (this.unsubAudit) return;
    const audit = (this.runtime as { audit?: { subscribe?: (pattern: string, handler: (e: unknown) => void) => () => void } }).audit;
    if (audit?.subscribe) {
      this.unsubAudit = audit.subscribe('*', (entry: unknown) =>
        this.onAuditEvent(entry as { eventKind: string; ref?: string; at: string; data?: Record<string, unknown> }),
      );
    }
  }

  stop(): void {
    if (this.unsubAudit) {
      this.unsubAudit();
      this.unsubAudit = null;
    }
  }

  // -------------------------------------------------------------------
  // Mutations (called by AgentsSubsystem dispatch)
  // -------------------------------------------------------------------

  openTurn(opts: OpenTurnOpts): Turn {
    return this.openTurnWithId(`tur_${randomUUID()}`, opts);
  }

  /**
   * Variant of openTurn that uses a caller-supplied id. The
   * AgentsSubsystem dispatch path uses this so the id stamped on the
   * audit frame (BEFORE the Turn record exists) matches the persisted
   * Turn.id. The id MUST be unique and prefix-conformant (`tur_<...>`);
   * caller is responsible for both.
   */
  openTurnWithId(id: string, opts: OpenTurnOpts): Turn {
    if (!opts || !opts.agentId) throw new Error('turns.openTurn: agentId is required');
    if (!opts.providerKind) throw new Error('turns.openTurn: providerKind is required');
    if (!opts.replyHandle) throw new Error('turns.openTurn: replyHandle is required');
    if (!opts.request?.text) throw new Error('turns.openTurn: request.text is required');
    if (typeof id !== 'string' || !id) throw new Error('turns.openTurnWithId: id is required');
    if (this.byId.has(id)) {
      throw new Error(`turns.openTurnWithId: id '${id}' is already in use`);
    }
    const now = new Date().toISOString();
    const turn: Turn = {
      id,
      agentId: opts.agentId,
      providerKind: opts.providerKind,
      agentSessionId: opts.agentSessionId ?? null,
      request: { ...opts.request, at: opts.request.at || now },
      contextSent: opts.contextSent ?? null,
      replyHandle: opts.replyHandle,
      assembledText: '',
      toolCalls: [],
      sideEffects: [],
      references: [],
      status: 'streaming',
      startedAt: now,
    };
    this.byId.set(id, turn);
    if (opts.agentSessionId) {
      this.activeBySession.set(opts.agentSessionId, id);
    }
    this.emitAudit('agents.turn.opened', `item:agents.turns[${id}]`, {
      turnId: id,
      agentId: opts.agentId,
      providerKind: opts.providerKind,
      replyHandle: opts.replyHandle,
    });
    return cloneTurn(turn);
  }

  /**
   * Mirror reply chunks into the Turn: extract text, collect tool
   * calls. Called by the AgentsSubsystem polling loop (or directly by
   * test code). Idempotent on chunk offsets.
   */
  ingestChunks(turnId: string, chunks: ReplyChunk[]): void {
    const turn = this.byId.get(turnId);
    if (!turn) return;
    if (turn.status !== 'streaming') return;
    if (!Array.isArray(chunks) || chunks.length === 0) return;

    for (const chunk of chunks) {
      if (chunk.kind === 'text') {
        const text = extractText(chunk.data);
        if (text) turn.assembledText += text;
      } else if (chunk.kind === 'tool-call') {
        const tc = normalizeToolCall(chunk);
        if (tc) turn.toolCalls.push(tc);
      }
      // tool-result, event, meta — captured by ReplyRecord, not mirrored
      // into the Turn for now. Available via Turn.replyHandle lookup.
    }
    this.emitAudit('agents.turn.chunk', `item:agents.turns[${turnId}]`, {
      turnId,
      ingestedKinds: chunks.map(c => c.kind),
      assembledLen: turn.assembledText.length,
      toolCallCount: turn.toolCalls.length,
    });
  }

  completeTurn(turnId: string, summary: ReplySummary): void {
    const turn = this.byId.get(turnId);
    if (!turn) return;
    if (turn.status !== 'streaming') return;
    turn.status = 'complete';
    turn.endedAt = summary.endedAt || new Date().toISOString();
    turn.finalSummary = { ...summary };
    if (turn.agentSessionId) this.activeBySession.delete(turn.agentSessionId);
    this.emitAudit('agents.turn.completed', `item:agents.turns[${turnId}]`, {
      turnId,
      durationMs: summary.durationMs,
      assembledLen: turn.assembledText.length,
      toolCallCount: turn.toolCalls.length,
      sideEffectCount: turn.sideEffects.length,
    });
  }

  failTurn(turnId: string, errorMessage: string): void {
    const turn = this.byId.get(turnId);
    if (!turn) return;
    if (turn.status !== 'streaming') return;
    turn.status = 'error';
    turn.endedAt = new Date().toISOString();
    turn.errorMessage = errorMessage;
    if (turn.agentSessionId) this.activeBySession.delete(turn.agentSessionId);
    this.emitAudit('agents.turn.errored', `item:agents.turns[${turnId}]`, {
      turnId,
      errorMessage,
    });
  }

  /**
   * Attach an inbound reference (Activity, NorthStar, Decision, …
   * declares it references this Turn). Idempotent on (kind, ref) pair.
   */
  addReference(opts: AddTurnReferenceOpts): Turn | null {
    const turn = this.byId.get(opts.turnId);
    if (!turn) return null;
    const ref: TurnReference = {
      kind: opts.reference.kind,
      ref: opts.reference.ref,
      position: opts.reference.position,
      attachedAt: new Date().toISOString(),
    };
    const exists = turn.references.some(
      r => r.kind === ref.kind && r.ref === ref.ref && r.position === ref.position,
    );
    if (!exists) {
      turn.references.push(ref);
      this.emitAudit('agents.turn.referenced', `item:agents.turns[${opts.turnId}]`, {
        turnId: opts.turnId,
        referenceKind: ref.kind,
        referenceRef: ref.ref,
        position: ref.position ?? null,
      });
    }
    return cloneTurn(turn);
  }

  // -------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------

  get(id: string): Turn | null {
    const t = this.byId.get(id);
    return t ? cloneTurn(t) : null;
  }

  list(opts: ListTurnsOpts = {}): Turn[] {
    const statuses: TurnStatus[] | null = opts.status
      ? Array.isArray(opts.status)
        ? [...opts.status]
        : [opts.status]
      : null;
    const sinceMs = opts.since ? Date.parse(opts.since) : null;
    const untilMs = opts.until ? Date.parse(opts.until) : null;
    const out: Turn[] = [];
    for (const t of this.byId.values()) {
      if (opts.agentId && t.agentId !== opts.agentId) continue;
      if (statuses && !statuses.includes(t.status)) continue;
      if (sinceMs !== null && Date.parse(t.startedAt) < sinceMs) continue;
      if (untilMs !== null && Date.parse(t.startedAt) > untilMs) continue;
      if (opts.referencedBy) {
        const wanted = opts.referencedBy;
        const matches = t.references.some(r => r.kind === wanted.kind && r.ref === wanted.ref);
        if (!matches) continue;
      }
      out.push(cloneTurn(t));
    }
    // Newest first.
    out.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
    return typeof opts.limit === 'number' && opts.limit > 0 ? out.slice(0, opts.limit) : out;
  }

  count(opts: ListTurnsOpts = {}): number {
    return this.list({ ...opts, limit: undefined }).length;
  }

  /** Look up the currently-streaming Turn for an agent's session. */
  turnForSession(sessionId: string): Turn | null {
    if (!sessionId) return null;
    const id = this.activeBySession.get(sessionId);
    if (!id) return null;
    const t = this.byId.get(id);
    return t ? cloneTurn(t) : null;
  }

  // -------------------------------------------------------------------
  // Audit subscription — side-effect collection
  // -------------------------------------------------------------------

  private onAuditEvent(entry: {
    eventKind: string;
    ref?: string;
    at: string;
    data?: Record<string, unknown>;
  }): void {
    if (!entry || typeof entry.eventKind !== 'string') return;
    // Don't loop on our own emissions.
    for (const prefix of TurnsSubsystem.IGNORED_EVENT_PREFIXES) {
      if (entry.eventKind.startsWith(prefix)) return;
    }

    let attributedTurnId: string | undefined;

    // Channel 1: direct via current frame's turnId.
    const audit = (this.runtime as { audit?: { currentFrame?: () => { turnId?: string; aiSessionId?: string } | undefined } }).audit;
    const frame = audit?.currentFrame?.();
    if (frame?.turnId && this.byId.has(frame.turnId)) {
      attributedTurnId = frame.turnId;
    }

    // Channel 2: indirect via aiSessionId → active Turn lookup.
    if (!attributedTurnId) {
      const sid = frame?.aiSessionId;
      if (sid && this.activeBySession.has(sid)) {
        attributedTurnId = this.activeBySession.get(sid);
      }
    }

    if (!attributedTurnId) return;

    const turn = this.byId.get(attributedTurnId);
    if (!turn || turn.status !== 'streaming') return;

    turn.sideEffects.push({
      at: entry.at,
      eventKind: entry.eventKind,
      ref: entry.ref,
      op: deriveOp(entry.eventKind),
      data: entry.data,
    });
  }

  // -------------------------------------------------------------------
  // Persistable
  // -------------------------------------------------------------------

  saveJson(): string {
    const payload: PersistedShape = {
      version: SCHEMA_VERSION,
      turns: [...this.byId.values()],
    };
    return JSON.stringify(payload);
  }

  loadJson(s: string): void {
    if (!s || typeof s !== 'string') {
      this.byId.clear();
      this.activeBySession.clear();
      return;
    }
    let parsed: PersistedShape;
    try {
      parsed = JSON.parse(s) as PersistedShape;
    } catch (e) {
      console.warn(
        `[agents.turns] loadJson: parse failed — ${(e as Error).message}; starting empty`,
      );
      return;
    }
    if (!parsed || parsed.version !== SCHEMA_VERSION || !Array.isArray(parsed.turns)) {
      return;
    }
    this.byId.clear();
    this.activeBySession.clear();
    for (const t of parsed.turns) {
      if (!t || typeof t.id !== 'string') continue;
      this.byId.set(t.id, t);
      // Streaming Turns at load time: rebuild the session index so a
      // resumed reply continues to attribute side effects. (Practically,
      // if the runtime restarted mid-Turn, the provider likely lost the
      // reply too — but the index is cheap to rebuild and harmless if
      // unused.)
      if (t.status === 'streaming' && t.agentSessionId) {
        this.activeBySession.set(t.agentSessionId, t.id);
      }
    }
  }

  // -------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------

  private emitAudit(kind: string, ref: string, data: Record<string, unknown>): void {
    try {
      const audit = (this.runtime as { audit?: { emit?: (e: unknown) => void } }).audit;
      if (audit?.emit) audit.emit({ kind, ref, data });
    } catch {
      /* swallow */
    }
  }
}

function cloneTurn(t: Turn): Turn {
  return {
    ...t,
    request: { ...t.request },
    toolCalls: t.toolCalls.map(tc => ({ ...tc })),
    sideEffects: t.sideEffects.map(se => ({ ...se })),
    references: t.references.map(r => ({ ...r })),
    finalSummary: t.finalSummary ? { ...t.finalSummary } : undefined,
  };
}

/** Extract a string from a text chunk's `data` field — handles both shapes. */
function extractText(data: unknown): string {
  if (typeof data === 'string') return data;
  if (data && typeof (data as { text?: unknown }).text === 'string') {
    return (data as { text: string }).text;
  }
  return '';
}

/** Normalize a tool-call chunk's `data` into a TurnToolCall. */
function normalizeToolCall(chunk: ReplyChunk): TurnToolCall | null {
  const d = chunk.data as { id?: string; name?: string; input?: unknown } | null;
  if (!d || typeof d.name !== 'string') return null;
  return {
    id: d.id,
    name: d.name,
    input: d.input,
    at: chunk.at,
  };
}
