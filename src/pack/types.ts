/**
 * blur-agent — type surface.
 *
 * An `Agent` is a durable identity wrapping a bridge session. The
 * sessionId can rotate (pool releases and replaces); agent.id stays
 * the same. This lets us hang scope/bindings/memory off something
 * that outlives the volatile pool layer.
 */

// ===========================================================================
// Agent record
// ===========================================================================

export type AgentStatus = 'active' | 'paused' | 'released';

/** Where the agent was sourced from. */
export type AgentLeasedFrom = 'pool' | 'external' | 'manual';

/**
 * Scope of an Agent's responsibility. An agent can have multiple
 * bindings (e.g. a Conductor bound at project AND at one Arc).
 */
export type AgentBindingScope =
  | 'cross-project'
  | 'project'
  | 'track'
  | 'arc'
  | 'move'
  | 'pack'
  | 'runtime';

export interface AgentBinding {
  scope: AgentBindingScope;
  /**
   * Canonical ref for the scope. By convention:
   *   - 'cross-project'  → no ref (omitted)
   *   - 'project'        → projectId
   *   - 'track'          → 'projectId/trackId'
   *   - 'arc'            → arcId
   *   - 'move'           → 'arcId/moveId'
   *   - 'pack'           → packId
   *   - 'runtime'        → runtimeId or 'global'
   */
  ref?: string;
  /** Free-text note about why the binding exists. */
  note?: string;
  /** ISO timestamp when this binding was attached. */
  attachedAt: string;
}

export type AgentNoteKind =
  | 'self-assessment'
  | 'handoff-summary'
  | 'role-clarification'
  | 'session-swap'
  | 'observation'
  | string;

export interface AgentNote {
  at: string;
  kind: AgentNoteKind;
  text: string;
  /** Agent id that authored the note. Usually the agent itself. */
  by?: string;
}

/**
 * Pointer to where the agent reads its charter / handoff instructions.
 * Replaces path-by-convention CLAUDE.md lookups with a typed reference.
 *
 * Exactly one of `promptRef` / `cwd` should be set in practice:
 *   - `promptRef` — opaque pointer the agent resolves via runtime
 *     primitives (e.g. Library artifact, Charter Step). Reserved for
 *     future when blur-project's Library exposes a fetch primitive.
 *   - `cwd`       — absolute filesystem directory containing CLAUDE.md
 *     and any sibling docs. Today this is the operative form.
 */
export interface AgentHandoff {
  promptRef?: string;
  cwd?: string;
}

export interface Agent {
  /** 'agt_<uuid>' — durable, outlives sessionId rotations. */
  id: string;

  /** Role catalog id. */
  role: string;

  /** Human-readable; "qb COA RunAgent". */
  label: string;

  status: AgentStatus;

  /**
   * Current bridge session this agent inhabits. NULL when status is
   * 'paused' (agent record persists, session is released back to pool).
   */
  sessionId: string | null;

  /**
   * Pool lease token if the agent's session was acquired via
   * runtime.pool.lease(). Held so agents.release() can hand it back.
   * Null for 'external' or 'manual' agents (no underlying pool lease).
   */
  leaseToken?: string | null;

  /** What this agent is responsible for. May be empty for a fresh lease. */
  bindings: AgentBinding[];

  /** Resolved instructions location (no path-by-convention). */
  handoff?: AgentHandoff;

  /** Structured, append-only memory the agent leaves about itself. */
  notes: AgentNote[];

  /** ISO timestamps. */
  leasedAt: string;
  leasedFrom: AgentLeasedFrom;
  releasedAt?: string;
  updatedAt?: string;
}

// ===========================================================================
// Role catalog (open registry)
// ===========================================================================

export interface AgentRoleDef {
  /** Short id; convention: lowercase, dash-separated. */
  id: string;
  label: string;
  description: string;
  /** Suggested default binding scopes for this role. Informational only. */
  defaultBindingScopes?: AgentBindingScope[];
  /**
   * Template path with `{projectId}` / `{trackId}` placeholders. Resolved
   * by callers at bind time; the catalog does not interpolate.
   * Example: '~/.blur/projects/{projectId}/handoffs/conductor/'
   */
  defaultHandoffCwdTemplate?: string;
  /** Free-text guidance / link to docs. */
  docs?: string;
  registeredAt?: string;
  registeredBy?: string;
}

// ===========================================================================
// Opts shapes
// ===========================================================================

export interface LeaseOpts {
  /** Required — must reference a registered role. */
  role: string;
  /** Human-readable label. Defaults to `${role} on ${primary binding ref}`. */
  label?: string;
  /**
   * Initial bindings the agent should carry. May be empty; bind later via
   * agents.bind().
   */
  bindings?: Array<Omit<AgentBinding, 'attachedAt'>>;
  /** Resolved handoff location. */
  handoff?: AgentHandoff;
  /**
   * Pool lease passthrough. When omitted, no pool lease is taken — the
   * caller may set sessionId via update() (rare; mostly tests).
   */
  pool?: {
    host?: string;
    role?: string;
    ttlSec?: number;
  };
  /** Overrides 'pool' as the leasedFrom value. */
  leasedFrom?: AgentLeasedFrom;
  /** Pre-set sessionId for 'external' / 'manual' leases. */
  sessionId?: string;
  /** Initial notes; commonly the handoff summary. */
  notes?: Array<Omit<AgentNote, 'at'>>;
  /** Author of the lease — usually the calling agent id. */
  by?: string;
}

export interface ReleaseOpts {
  by?: string;
  /** Reason recorded as a note before release. */
  reason?: string;
  /** When true, keep the underlying pool session (caller will manage it). */
  keepSession?: boolean;
}

export interface BindOpts {
  binding: Omit<AgentBinding, 'attachedAt'>;
  by?: string;
}

export interface UnbindOpts {
  /** Match by scope+ref. */
  scope: AgentBindingScope;
  ref?: string;
  by?: string;
}

export interface AddNoteOpts {
  kind: AgentNoteKind;
  text: string;
  by?: string;
}

export interface ListOpts {
  role?: string;
  status?: AgentStatus | AgentStatus[];
  /** Filter by binding scope. */
  bindingScope?: AgentBindingScope;
  /** Filter by binding ref (combine with bindingScope for precision). */
  bindingRef?: string;
  /** Filter by exact projectId across any binding form. */
  project?: string;
  since?: string;
  until?: string;
}

export interface WhoAmIOpts {
  /**
   * Override the auto-resolved sessionId. Useful in tests and when
   * the caller wants to introspect a different agent. In normal use
   * the calling AI script's mcpSessionId is resolved automatically
   * by the primitive layer.
   */
  sessionId?: string;
}

export interface RegisterRoleOpts {
  /** All fields of AgentRoleDef except the auto-stamped ones. */
  role: Omit<AgentRoleDef, 'registeredAt'>;
  by?: string;
}

export interface UnregisterRoleOpts {
  id: string;
  by?: string;
}
