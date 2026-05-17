/**
 * AgentsSubsystem — durable AI-session identity layer.
 *
 * Mounted at the short name `agents`. Implements Persistable
 * (decision 20) so Agent records survive runtime restart at
 * ~/.blur/persist/blur-agent/.
 *
 * State shape:
 *   in-memory:
 *     - byId: Map<agentId, Agent>            (single source of truth)
 *     - sessionIndex: Map<sessionId, agentId> (whoAmI fast-path)
 *     - rolesById: Map<roleId, AgentRoleDef>  (open registry)
 *   on disk:
 *     - { agents: Agent[], roles: AgentRoleDef[] } via Persistable.saveJson
 *
 * pool interaction:
 *   The subsystem holds no hard import on blur-session-pool. It resolves
 *   the pool node lazily via `runtime.extensions.get('pool')` — same
 *   pattern blur-arc uses to reach blur-decisions. Lease/release degrade
 *   gracefully when pool is absent (leasedFrom='manual' agents still
 *   work; only 'pool' leases require the extension).
 *
 * audit-emit (decision 21) — every transition fires a semantic event so
 * downstream packs (Conductor, project subsystem, audit-frame stamper)
 * can subscribe. Kinds: agents.leased, agents.released, agents.bound,
 * agents.unbound, agents.note-added, agents.session-swapped,
 * agents.role-registered, agents.role-unregistered.
 */

import { randomUUID } from 'crypto';
import type { BlurAIRuntime, Persistable } from 'blur-ai-runtime';
import type {
  AddNoteOpts,
  Agent,
  AgentBinding,
  AgentNote,
  AgentProvider,
  AgentRoleDef,
  AgentStatus,
  BindOpts,
  GetReplyOpts,
  LeaseOpts,
  ListOpts,
  RegisterRoleOpts,
  ReleaseOpts,
  Reply,
  ReplyPoll,
  SendMessageAndAwaitOpts,
  SendMessageOpts,
  UnbindOpts,
  UnregisterRoleOpts,
  WhoAmIOpts,
} from './types';
import { synthesizeProvider } from './types';
import type { AgentRepliesSubsystem } from './replies-subsystem';
import type { ProviderRegistry } from './provider-registry';
import type { TurnsSubsystem } from './turns-subsystem';
import { LiveReply } from './live-reply';

interface PersistedShape {
  agents: Agent[];
  roles: AgentRoleDef[];
}

type SemanticKind =
  | 'agents.leased'
  | 'agents.released'
  | 'agents.bound'
  | 'agents.unbound'
  | 'agents.note-added'
  | 'agents.session-swapped'
  | 'agents.role-registered'
  | 'agents.role-unregistered';

/** Minimal pool API we use. Resolved lazily via runtime.extensions.get('pool'). */
interface PoolBridge {
  lease(opts?: { host?: string; role?: string; ttlSec?: number }): Promise<{
    host: string;
    sessionId: string;
    sessionTitle: string;
    leaseToken: string;
  }>;
  release(leaseToken: string): Promise<{ released: true }>;
}

export class AgentsSubsystem implements Persistable {
  private byId = new Map<string, Agent>();
  private sessionIndex = new Map<string, string>(); // sessionId → agentId
  private rolesById = new Map<string, AgentRoleDef>();
  /**
   * Decision 31 Phase A — self-tracked dirty flag. Set true on every
   * agent/role/session mutation; `consumeDirty()` returns + resets.
   * Formalizing the previously-duck-typed Persistable shape — the
   * subsystem always had saveJson/loadJson, the interface assertion
   * just wasn't declared.
   */
  private _dirty = false;

  /**
   * Backref to the replies subsystem. Set by the pack install (avoids
   * a circular import). Required for sendMessage / getReply.
   */
  repliesRef: AgentRepliesSubsystem | null = null;

  /**
   * Backref to the provider registry. Set by the pack install.
   * Required for sendMessage dispatch.
   */
  providerRegistry: ProviderRegistry | null = null;

  /**
   * Backref to the Turns subsystem. Set by the pack install.
   * When present, sendMessage opens a Turn for each dispatch and
   * mirrors reply chunks into it (assembledText, toolCalls,
   * sideEffects). When absent (older wiring), dispatch still works —
   * the Turn record is just skipped.
   */
  turnsRef: TurnsSubsystem | null = null;

  constructor(public readonly runtime: BlurAIRuntime) {}

  // ===================================================================
  // Role catalog
  // ===================================================================

  registerRole(opts: RegisterRoleOpts): AgentRoleDef {
    if (!opts || !opts.role || typeof opts.role.id !== 'string' || !opts.role.id.trim()) {
      throw new Error('agents.roles.register: role.id is required');
    }
    if (typeof opts.role.label !== 'string' || !opts.role.label) {
      throw new Error('agents.roles.register: role.label is required');
    }
    if (typeof opts.role.description !== 'string') {
      throw new Error('agents.roles.register: role.description is required');
    }
    const id = opts.role.id.trim();
    const now = new Date().toISOString();
    const def: AgentRoleDef = {
      ...opts.role,
      id,
      registeredAt: now,
      registeredBy: opts.by,
    };
    this.rolesById.set(id, def);
    this._dirty = true;
    this.emitEvent('agents.role-registered', {
      ref: `item:agents.roles[${id}]`,
      data: { roleId: id, by: opts.by },
    });
    return { ...def };
  }

  unregisterRole(opts: UnregisterRoleOpts): boolean {
    if (!opts || typeof opts.id !== 'string' || !opts.id) {
      throw new Error('agents.roles.unregister: id is required');
    }
    const existed = this.rolesById.delete(opts.id);
    if (existed) {
      this._dirty = true;
      this.emitEvent('agents.role-unregistered', {
        ref: `item:agents.roles[${opts.id}]`,
        data: { roleId: opts.id, by: opts.by },
      });
    }
    return existed;
  }

  listRoles(): AgentRoleDef[] {
    return [...this.rolesById.values()].map((r) => ({ ...r }));
  }

  getRole(id: string): AgentRoleDef | null {
    const r = this.rolesById.get(id);
    return r ? { ...r } : null;
  }

  // ===================================================================
  // Lease / release lifecycle
  // ===================================================================

  /**
   * Lease an Agent. Default path: takes a pool session via
   * runtime.extensions.get('pool').lease() and wraps it. Pool absence
   * is a hard error when leasedFrom defaults to 'pool'; pass
   * leasedFrom: 'manual' + sessionId to skip pool.
   */
  async lease(opts: LeaseOpts): Promise<Agent> {
    if (!opts || typeof opts.role !== 'string' || !opts.role.trim()) {
      throw new Error('agents.lease: opts.role is required');
    }
    if (!this.rolesById.has(opts.role)) {
      throw new Error(
        `agents.lease: role '${opts.role}' is not registered. Call agents.roles.register first or use one of: ${[...this.rolesById.keys()].join(', ')}`,
      );
    }
    const leasedFrom = opts.leasedFrom ?? 'pool';

    let sessionId: string | null = null;
    let leaseToken: string | null = null;

    if (leasedFrom === 'pool') {
      const pool = this.resolvePool();
      if (!pool) {
        throw new Error(
          "agents.lease: leasedFrom='pool' but the pool extension is not available. " +
            "Either load blur-session-pool, or pass leasedFrom:'manual' with an explicit sessionId.",
        );
      }
      const lease = await pool.lease(opts.pool ?? {});
      sessionId = lease.sessionId;
      leaseToken = lease.leaseToken;
    } else if (leasedFrom === 'external' || leasedFrom === 'manual') {
      if (typeof opts.sessionId === 'string' && opts.sessionId.length > 0) {
        sessionId = opts.sessionId;
      } else {
        // sessionId may be set later via attachSession (e.g. when the
        // operator manually binds an already-running Claude Code session).
        sessionId = null;
      }
    }

    const id = `agt_${randomUUID()}`;
    const now = new Date().toISOString();
    const bindings: AgentBinding[] = (opts.bindings ?? []).map((b) => ({
      scope: b.scope,
      ref: b.ref,
      note: b.note,
      attachedAt: now,
    }));
    const label = opts.label ?? this.defaultLabel(opts.role, bindings);
    const notes: AgentNote[] = (opts.notes ?? []).map((n) => ({
      at: now,
      kind: n.kind,
      text: n.text,
      by: n.by,
    }));

    const agent: Agent = {
      id,
      role: opts.role,
      label,
      status: 'active',
      sessionId,
      leaseToken,
      provider: opts.provider ? { ...opts.provider } as typeof opts.provider : undefined,
      bindings,
      handoff: opts.handoff ? { ...opts.handoff } : undefined,
      notes,
      leasedAt: now,
      leasedFrom,
      updatedAt: now,
    };
    this.byId.set(id, agent);
    if (sessionId) this.sessionIndex.set(sessionId, id);
    this._dirty = true;
    this.emit('agents.leased', agent, {
      role: agent.role,
      leasedFrom: agent.leasedFrom,
      sessionId: agent.sessionId,
      by: opts.by,
    });
    return this.snapshot(agent);
  }

  /**
   * Release an Agent. By default this releases the underlying pool
   * session (if any) and marks the agent's status='released'. Record
   * is preserved for audit. Idempotent for already-released agents.
   */
  async release(id: string, opts: ReleaseOpts = {}): Promise<Agent> {
    const a = this.require(id);
    if (a.status === 'released') return this.snapshot(a);

    if (opts.reason) {
      this.addNoteInternal(a, {
        kind: 'session-swap',
        text: `release: ${opts.reason}`,
        by: opts.by ?? a.id,
      });
    }

    if (a.leaseToken && !opts.keepSession) {
      const pool = this.resolvePool();
      if (pool) {
        try {
          await pool.release(a.leaseToken);
        } catch (e) {
          // Pool release failure shouldn't strand the agent record.
          // Emit a note so it's auditable.
          this.addNoteInternal(a, {
            kind: 'observation',
            text: `pool.release failed: ${(e as Error).message}`,
            by: a.id,
          });
        }
      }
    }
    const now = new Date().toISOString();
    if (a.sessionId) this.sessionIndex.delete(a.sessionId);
    a.status = 'released';
    a.sessionId = null;
    a.leaseToken = null;
    a.releasedAt = now;
    a.updatedAt = now;
    this._dirty = true;
    this.emit('agents.released', a, { reason: opts.reason, by: opts.by });
    return this.snapshot(a);
  }

  /**
   * Swap the bridge session for an existing Agent. Use when the pool
   * recycles or when an operator manually re-binds a fresh session.
   * Does NOT change agent.id — that's the durability invariant.
   */
  attachSession(id: string, sessionId: string, leaseToken?: string | null, by?: string): Agent {
    const a = this.require(id);
    if (a.status === 'released') {
      throw new Error(`agents.attachSession: agent ${id} is released; lease a new one`);
    }
    if (typeof sessionId !== 'string' || !sessionId) {
      throw new Error('agents.attachSession: sessionId required');
    }
    const oldSession = a.sessionId;
    if (a.sessionId === sessionId) return this.snapshot(a);
    if (a.sessionId) this.sessionIndex.delete(a.sessionId);
    a.sessionId = sessionId;
    a.leaseToken = leaseToken ?? a.leaseToken ?? null;
    a.status = 'active';
    a.updatedAt = new Date().toISOString();
    this.sessionIndex.set(sessionId, id);
    this._dirty = true;
    this.addNoteInternal(a, {
      kind: 'session-swap',
      text: `session swapped: ${oldSession ?? '<none>'} → ${sessionId}`,
      by: by ?? a.id,
    });
    this.emit('agents.session-swapped', a, { oldSession, newSession: sessionId, by });
    return this.snapshot(a);
  }

  /**
   * Pause an Agent — releases the bridge session but keeps the record
   * with status='paused'. Use when work is mid-flight and you want to
   * cold-resume later with attachSession.
   */
  async pause(id: string, opts: ReleaseOpts = {}): Promise<Agent> {
    const a = this.require(id);
    if (a.status === 'paused' || a.status === 'released') return this.snapshot(a);
    if (a.leaseToken && !opts.keepSession) {
      const pool = this.resolvePool();
      if (pool) {
        try {
          await pool.release(a.leaseToken);
        } catch (e) {
          this.addNoteInternal(a, {
            kind: 'observation',
            text: `pause: pool.release failed: ${(e as Error).message}`,
            by: a.id,
          });
        }
      }
    }
    const now = new Date().toISOString();
    if (a.sessionId) this.sessionIndex.delete(a.sessionId);
    a.status = 'paused';
    a.sessionId = null;
    a.leaseToken = null;
    a.updatedAt = now;
    this._dirty = true;
    this.addNoteInternal(a, {
      kind: 'session-swap',
      text: `paused${opts.reason ? `: ${opts.reason}` : ''}`,
      by: opts.by ?? a.id,
    });
    this.emit('agents.released', a, { paused: true, reason: opts.reason, by: opts.by });
    return this.snapshot(a);
  }

  // ===================================================================
  // Bindings
  // ===================================================================

  bind(id: string, opts: BindOpts): Agent {
    const a = this.require(id);
    if (a.status === 'released') {
      throw new Error(`agents.bind: agent ${id} is released`);
    }
    if (!opts || !opts.binding || typeof opts.binding.scope !== 'string') {
      throw new Error('agents.bind: { binding: { scope, ref? } } required');
    }
    const now = new Date().toISOString();
    const binding: AgentBinding = {
      scope: opts.binding.scope,
      ref: opts.binding.ref,
      note: opts.binding.note,
      attachedAt: now,
    };
    // Dedup: replace any existing binding with same scope+ref.
    a.bindings = a.bindings.filter(
      (b) => !(b.scope === binding.scope && (b.ref ?? '') === (binding.ref ?? '')),
    );
    a.bindings.push(binding);
    a.updatedAt = now;
    this._dirty = true;
    this.emit('agents.bound', a, { binding, by: opts.by });
    return this.snapshot(a);
  }

  unbind(id: string, opts: UnbindOpts): Agent {
    const a = this.require(id);
    if (!opts || typeof opts.scope !== 'string') {
      throw new Error('agents.unbind: { scope, ref? } required');
    }
    const before = a.bindings.length;
    a.bindings = a.bindings.filter(
      (b) => !(b.scope === opts.scope && (b.ref ?? '') === (opts.ref ?? '')),
    );
    if (a.bindings.length !== before) {
      a.updatedAt = new Date().toISOString();
      this._dirty = true;
      this.emit('agents.unbound', a, { scope: opts.scope, ref: opts.ref, by: opts.by });
    }
    return this.snapshot(a);
  }

  // ===================================================================
  // Notes
  // ===================================================================

  addNote(id: string, opts: AddNoteOpts): Agent {
    const a = this.require(id);
    if (!opts || typeof opts.kind !== 'string' || typeof opts.text !== 'string') {
      throw new Error('agents.notes.add: { kind, text } required');
    }
    this.addNoteInternal(a, opts);
    return this.snapshot(a);
  }

  listNotes(id: string): AgentNote[] {
    const a = this.require(id);
    return a.notes.map((n) => ({ ...n }));
  }

  // ===================================================================
  // Readers
  // ===================================================================

  /**
   * Self-reflection — find the Agent record for the calling session.
   * Resolves sessionId from `opts.sessionId` if provided, else from
   * the audit frame's aiSessionId. Returns null if no match.
   */
  whoAmI(opts: WhoAmIOpts = {}): Agent | null {
    const sid = opts.sessionId ?? this.resolveCallerSessionId();
    if (!sid) return null;
    const aid = this.sessionIndex.get(sid);
    if (!aid) return null;
    const a = this.byId.get(aid);
    return a ? this.snapshot(a) : null;
  }

  get(id: string): Agent | null {
    const a = this.byId.get(id);
    return a ? this.snapshot(a) : null;
  }

  /** Find an agent by its current sessionId. */
  bySession(sessionId: string): Agent | null {
    if (!sessionId) return null;
    const aid = this.sessionIndex.get(sessionId);
    if (!aid) return null;
    const a = this.byId.get(aid);
    return a ? this.snapshot(a) : null;
  }

  list(opts: ListOpts = {}): Agent[] {
    const statuses: AgentStatus[] | null = opts.status
      ? Array.isArray(opts.status)
        ? [...opts.status]
        : [opts.status]
      : null;
    const out: Agent[] = [];
    for (const a of this.byId.values()) {
      if (opts.role && a.role !== opts.role) continue;
      if (statuses && !statuses.includes(a.status)) continue;
      if (opts.bindingScope || opts.bindingRef || opts.project) {
        const match = a.bindings.some((b) => {
          if (opts.bindingScope && b.scope !== opts.bindingScope) return false;
          if (opts.bindingRef && (b.ref ?? '') !== opts.bindingRef) return false;
          if (opts.project) {
            // project match: scope='project' ref===project, OR scope='track'/'arc'/'move'
            // with ref starting with `${project}/` or matching project on a known path.
            // Simple convention: project bindings have ref===projectId; track has
            // 'projectId/trackId'. Match if either case applies.
            if (b.scope === 'project' && b.ref === opts.project) return true;
            if (
              (b.scope === 'track' || b.scope === 'arc' || b.scope === 'move') &&
              typeof b.ref === 'string' &&
              (b.ref === opts.project || b.ref.startsWith(opts.project + '/'))
            )
              return true;
            return false;
          }
          return true;
        });
        if (!match) continue;
      }
      if (opts.since && a.leasedAt < opts.since) continue;
      if (opts.until && a.leasedAt > opts.until) continue;
      out.push(this.snapshot(a));
    }
    out.sort((a, b) => (a.leasedAt < b.leasedAt ? -1 : a.leasedAt > b.leasedAt ? 1 : 0));
    return out;
  }

  count(opts: ListOpts = {}): number {
    return this.list(opts).length;
  }

  // ===================================================================
  // Persistable (decision 20)
  // ===================================================================

  saveJson(): string {
    const payload: PersistedShape = {
      agents: Array.from(this.byId.values()),
      roles: Array.from(this.rolesById.values()),
    };
    return JSON.stringify(payload);
  }

  loadJson(json: string): void {
    if (!json) {
      this.byId.clear();
      this.sessionIndex.clear();
      this.rolesById.clear();
      return;
    }
    let payload: PersistedShape;
    try {
      payload = JSON.parse(json) as PersistedShape;
    } catch (e) {
      throw new Error(`agents.loadJson: failed to parse snapshot — ${(e as Error).message}`);
    }
    this.byId.clear();
    this.sessionIndex.clear();
    this.rolesById.clear();
    if (Array.isArray(payload.roles)) {
      for (const r of payload.roles) {
        if (!r || typeof r.id !== 'string') continue;
        this.rolesById.set(r.id, r);
      }
    }
    if (Array.isArray(payload.agents)) {
      for (const a of payload.agents) {
        if (!a || typeof a.id !== 'string') continue;
        this.byId.set(a.id, a);
        if (a.status === 'active' && a.sessionId) {
          this.sessionIndex.set(a.sessionId, a.id);
        }
      }
    }
    // Restore is not a mutation.
    this._dirty = false;
  }

  /**
   * Decision 31 Phase A — Persistable.consumeDirty. Returns true iff
   * agent/role/session state changed since the last call, and
   * atomically resets.
   */
  consumeDirty(): boolean {
    const d = this._dirty;
    this._dirty = false;
    return d;
  }

  // ===================================================================
  // Internal
  // ===================================================================

  private require(id: string): Agent {
    const a = this.byId.get(id);
    if (!a) throw new Error(`agents: no agent with id '${id}'`);
    return a;
  }

  private defaultLabel(role: string, bindings: AgentBinding[]): string {
    const primary = bindings.find((b) => b.ref);
    return primary ? `${role} on ${primary.scope}:${primary.ref}` : role;
  }

  private addNoteInternal(a: Agent, n: { kind: string; text: string; by?: string }): void {
    const note: AgentNote = {
      at: new Date().toISOString(),
      kind: n.kind,
      text: n.text,
      by: n.by,
    };
    a.notes.push(note);
    a.updatedAt = note.at;
    // Note + updatedAt mutates persisted Agent state. Single flag covers
    // every caller (release/pause/attachSession/addNote).
    this._dirty = true;
    this.emit('agents.note-added', a, { kind: note.kind, by: note.by });
  }

  private resolvePool(): PoolBridge | null {
    const rt = this.runtime as { extensions?: Map<string, object> } | { extensions?: { get(name: string): unknown } };
    const exts = (rt as { extensions?: unknown }).extensions;
    if (!exts) return null;
    const candidate =
      typeof (exts as { get?: (k: string) => unknown }).get === 'function'
        ? (exts as { get: (k: string) => unknown }).get('pool')
        : null;
    if (!candidate) return null;
    const c = candidate as Partial<PoolBridge>;
    if (typeof c.lease !== 'function' || typeof c.release !== 'function') return null;
    return c as PoolBridge;
  }

  private resolveCallerSessionId(): string | null {
    const frame = this.runtime.audit.currentFrame?.();
    return frame?.aiSessionId ?? null;
  }

  private snapshot(a: Agent): Agent {
    return {
      ...a,
      bindings: a.bindings.map((b) => ({ ...b })),
      notes: a.notes.map((n) => ({ ...n })),
      handoff: a.handoff ? { ...a.handoff } : undefined,
    };
  }

  private emit(kind: SemanticKind, a: Agent, extra: Record<string, unknown> = {}): void {
    this.runtime.audit.emit({
      kind,
      ref: `item:agents[${a.id}]`,
      data: {
        agentId: a.id,
        role: a.role,
        status: a.status,
        sessionId: a.sessionId,
        ...extra,
      },
    });
  }

  private emitEvent(kind: SemanticKind, opts: { ref?: string; data?: Record<string, unknown> }): void {
    this.runtime.audit.emit({ kind, ref: opts.ref, data: opts.data });
  }

  // ===================================================================
  // sendMessage / getReply / sendMessageAndAwait — Decision 29 contract
  //
  // sendMessage:        fire; returns { replyHandle } in ms
  // getReply:           pull; long-poll the ReplyRecord by handle
  // sendMessageAndAwait: convenience wrapper — fire + loop getReply until
  //                      status leaves 'streaming', return assembled Reply
  //
  // Dispatch is by agent.provider.kind (or synthesized BridgeProvider
  // for back-compat agents). The ProviderRegistry must have an impl
  // registered for the agent's provider kind.
  // ===================================================================

  async sendMessage(
    agentId: string,
    opts: SendMessageOpts,
  ): Promise<{ replyHandle: string; turnId?: string }> {
    if (typeof agentId !== 'string' || !agentId.trim()) {
      throw new Error('agents.sendMessage: agentId is required (non-empty string)');
    }
    if (!opts || typeof opts !== 'object') {
      throw new Error('agents.sendMessage: opts is required');
    }
    if (typeof opts.text !== 'string' || !opts.text) {
      throw new Error('agents.sendMessage: opts.text is required (non-empty string)');
    }

    const agent = this.byId.get(agentId);
    if (!agent) throw new Error(`agents.sendMessage: no such agentId '${agentId}'`);

    if (agent.status !== 'active') {
      throw new Error(
        `agents.sendMessage: agent ${agentId} is '${agent.status}'; cannot send`,
      );
    }

    if (!this.repliesRef || !this.providerRegistry) {
      throw new Error(
        'agents.sendMessage: replies subsystem and provider registry not wired. ' +
        'Pack install may be incomplete.',
      );
    }

    // Materialize provider — synthesized BridgeProvider for back-compat.
    const resolvedProvider = synthesizeProvider(agent);
    if (!resolvedProvider) {
      throw new Error(
        `agents.sendMessage: agent ${agentId} has no provider and no sessionId; cannot dispatch`,
      );
    }
    // Ensure the agent's record carries the (possibly synthesized)
    // provider so downstream ReplyRecord.providerKind etc. are honest.
    const agentForDispatch: Agent =
      agent.provider === resolvedProvider ? agent : { ...agent, provider: resolvedProvider };

    const impl = this.providerRegistry.get(resolvedProvider.kind);
    if (!impl) {
      throw new Error(
        `agents.sendMessage: no provider impl registered for kind '${resolvedProvider.kind}'. ` +
        `Known: ${this.providerRegistry.list().map(p => p.kind).join(', ') || '<none>'}`,
      );
    }

    // Dispatch path. If a TurnsSubsystem is wired, we:
    //   1. open a Turn FIRST (mint a turnId)
    //   2. wrap provider.sendMessage in audit.withTurn so events
    //      emitted during the synchronous dispatch carry frame.turnId
    //   3. start a background chunk-mirror loop that ingests reply
    //      chunks into the Turn and seals it on complete/error
    //
    // Without TurnsSubsystem, dispatch still works — back-compat.

    let turnId: string | undefined;
    let result: { replyHandle: string };

    const doDispatch = async (): Promise<{ replyHandle: string }> => {
      const r = await impl.sendMessage(agentForDispatch, opts, this.repliesRef!);
      if (!r?.replyHandle) {
        throw new Error(
          `agents.sendMessage: provider '${resolvedProvider.kind}' returned no replyHandle`,
        );
      }
      return r;
    };

    if (this.turnsRef) {
      // Open Turn with a placeholder replyHandle; we'll learn the real
      // one from provider.sendMessage's return. To keep Turn.replyHandle
      // truthful, we open AFTER dispatch but BEFORE returning — see
      // below. But the audit frame needs the turnId to exist DURING
      // dispatch. Compromise: mint the id first (cheap), dispatch
      // inside withTurn, then construct the actual Turn record using
      // the minted id + real replyHandle.
      const provisionalTurnId = `tur_${randomUUID()}`;
      const audit = this.runtime.audit as { withTurn?: <T>(seed: { agentId: string; turnId: string }, fn: () => Promise<T>) => Promise<T> };
      const runDispatch = async (): Promise<{ replyHandle: string }> => doDispatch();
      if (audit?.withTurn) {
        result = await audit.withTurn({ agentId, turnId: provisionalTurnId }, runDispatch);
      } else {
        result = await runDispatch();
      }
      // Now open the Turn for real with the actual replyHandle. The
      // provisional id is preserved as the Turn id.
      this.openTurnRecord({
        provisionalTurnId,
        agentId,
        providerKind: resolvedProvider.kind,
        agentSessionId: extractSessionId(resolvedProvider),
        request: { text: opts.text, at: new Date().toISOString(), by: opts.by },
        replyHandle: result.replyHandle,
      });
      turnId = provisionalTurnId;
      // Spawn the chunk-mirror loop (background).
      this.spawnTurnMirror(turnId, result.replyHandle);
    } else {
      result = await doDispatch();
    }

    return { replyHandle: result.replyHandle, turnId };
  }

  /**
   * Sugar variant of sendMessage that returns a LiveReply — host-side
   * ergonomic wrapper. Pump with .get() / .pull() / .await() or iterate
   * with for-await. NOT for use across script.run boundaries.
   */
  async sendText(
    agentId: string,
    textOrOpts: string | SendMessageOpts,
    extra?: Omit<SendMessageOpts, 'text'>,
  ): Promise<LiveReply> {
    const opts: SendMessageOpts =
      typeof textOrOpts === 'string'
        ? { text: textOrOpts, ...extra }
        : { ...textOrOpts, ...extra };
    const { replyHandle, turnId } = await this.sendMessage(agentId, opts);
    return new LiveReply(
      { getReply: (h, o) => this.getReply(h, o) },
      { handle: replyHandle, agentId, turnId },
    );
  }

  /**
   * Construct a LiveReply for an existing replyHandle. Useful for
   * resuming a reply from a known handle (e.g. UI component re-
   * mounting against a known Turn).
   */
  openReply(opts: { replyHandle: string; agentId: string; turnId?: string }): LiveReply {
    return new LiveReply(
      { getReply: (h, o) => this.getReply(h, o) },
      { handle: opts.replyHandle, agentId: opts.agentId, turnId: opts.turnId },
    );
  }

  async getReply(replyHandle: string, opts?: GetReplyOpts): Promise<ReplyPoll> {
    if (typeof replyHandle !== 'string' || !replyHandle.trim()) {
      throw new Error('agents.getReply: replyHandle is required (non-empty string)');
    }
    if (!this.repliesRef) {
      throw new Error('agents.getReply: replies subsystem not wired');
    }
    return this.repliesRef.getReply(replyHandle, opts);
  }

  /**
   * Convenience: fire + loop getReply until non-streaming, return the
   * assembled Reply. NEVER use for bridge-driven Claude turns — the
   * timeout assumption breaks. Use sendMessage + getReply long-poll
   * directly for those.
   */
  async sendMessageAndAwait(agentId: string, opts: SendMessageAndAwaitOpts): Promise<Reply> {
    const totalTimeoutMs = opts.timeoutMs ?? 60_000;
    const deadline = Date.now() + totalTimeoutMs;
    const { replyHandle } = await this.sendMessage(agentId, opts);

    const textParts: string[] = [];
    const toolCalls: unknown[] = [];
    let sinceOffset = 0;
    let finalStatus: ReplyPoll['status'] = 'streaming';
    let finalSummary: ReplyPoll['finalSummary'];
    let errorMessage: string | undefined;

    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      const pollTimeout = Math.min(remaining, 25_000);
      if (pollTimeout <= 0) break;
      const poll = await this.getReply(replyHandle, {
        sinceOffset,
        wait: 'long-poll',
        timeoutMs: pollTimeout,
      });
      for (const c of poll.chunks) {
        if (c.kind === 'text') {
          // Providers may emit text data as a raw string (mock) or as
          // an object like { text: "..." } (bridge daemon's chunk
          // shape from readSession). Accept both defensively.
          if (typeof c.data === 'string') {
            textParts.push(c.data);
          } else if (c.data && typeof (c.data as { text?: unknown }).text === 'string') {
            textParts.push((c.data as { text: string }).text);
          }
        } else if (c.kind === 'tool-call') {
          toolCalls.push(c.data);
        }
      }
      sinceOffset = poll.nextOffset;
      finalStatus = poll.status;
      finalSummary = poll.finalSummary;
      errorMessage = poll.errorMessage;
      if (poll.status !== 'streaming') break;
    }

    if (finalStatus === 'error') {
      throw new Error(`agents.sendMessageAndAwait: reply errored — ${errorMessage ?? 'unknown'}`);
    }
    if (finalStatus !== 'complete') {
      throw new Error(
        `agents.sendMessageAndAwait: reply did not complete within ${totalTimeoutMs}ms`,
      );
    }
    if (!finalSummary) {
      throw new Error('agents.sendMessageAndAwait: reply complete but no finalSummary present');
    }

    return {
      replyHandle,
      agentId,
      text: textParts.join(''),
      toolCalls,
      summary: { ...finalSummary },
    };
  }

  // ===================================================================
  // Turn lifecycle helpers (called by sendMessage when turnsRef is set)
  // ===================================================================

  private openTurnRecord(opts: {
    provisionalTurnId: string;
    agentId: string;
    providerKind: AgentProvider['kind'];
    agentSessionId?: string | null;
    request: { text: string; at: string; by?: string };
    replyHandle: string;
  }): void {
    if (!this.turnsRef) return;
    // Use the internal mint path: pass the pre-generated id through
    // openTurn by patching it onto the subsystem AFTER. The Turn record
    // is created with a fresh id by openTurn; we need to align them.
    // Simplest path: call openTurn and then re-key the result. Cleaner:
    // expose a `openTurnWithId` on TurnsSubsystem. We use openTurn
    // here and accept that the audit frame's turnId may differ from
    // the persisted Turn.id in the rare race — addressable in a future
    // pass. For correctness today, the alignment is critical for
    // side-effect attribution, so use openTurnWithId.
    this.turnsRef.openTurnWithId(opts.provisionalTurnId, {
      agentId: opts.agentId,
      providerKind: opts.providerKind,
      agentSessionId: opts.agentSessionId,
      request: opts.request,
      replyHandle: opts.replyHandle,
    });
  }

  /**
   * Background poll loop: mirror reply chunks into the Turn and seal
   * the Turn on reply complete/error. Runs as a fire-and-forget
   * promise; errors are swallowed after attempting to fail the Turn.
   */
  private spawnTurnMirror(turnId: string, replyHandle: string): void {
    if (!this.turnsRef || !this.repliesRef) return;
    const turnsRef = this.turnsRef;
    const repliesRef = this.repliesRef;
    (async () => {
      let sinceOffset = 0;
      while (true) {
        let poll: ReplyPoll;
        try {
          poll = await repliesRef.getReply(replyHandle, {
            sinceOffset,
            wait: 'long-poll',
            timeoutMs: 25_000,
          });
        } catch (e) {
          turnsRef.failTurn(turnId, `mirror loop poll failed: ${(e as Error)?.message ?? String(e)}`);
          return;
        }
        if (poll.chunks.length > 0) {
          turnsRef.ingestChunks(turnId, poll.chunks);
        }
        sinceOffset = poll.nextOffset;
        if (poll.status === 'complete' && poll.finalSummary) {
          turnsRef.completeTurn(turnId, poll.finalSummary);
          return;
        }
        if (poll.status === 'error') {
          turnsRef.failTurn(turnId, poll.errorMessage ?? 'reply errored');
          return;
        }
        if (poll.status !== 'streaming') return;
      }
    })().catch(e => {
      // Ultimate fallback — the loop itself blew up.
      try {
        turnsRef.failTurn(turnId, `mirror loop crashed: ${(e as Error)?.message ?? String(e)}`);
      } catch {
        /* nothing more to do */
      }
    });
  }
}

/** Extract the agent's session id from a provider, when applicable. */
function extractSessionId(provider: AgentProvider): string | null {
  if (provider.kind === 'bridge') return provider.sessionId ?? null;
  return null;
}
