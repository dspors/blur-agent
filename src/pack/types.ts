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
   *
   * Back-compat field. Forward-compat path: this value will move into
   * `provider` (as `BridgeProvider.sessionId`) when blur-agent's
   * persistence layer migrates. New writers SHOULD set `provider`;
   * readers SHOULD prefer `provider` and fall back to `sessionId` for
   * older records. See `synthesizeProvider()` helper below.
   */
  sessionId: string | null;

  /**
   * Pool lease token if the agent's session was acquired via
   * runtime.pool.lease(). Held so agents.release() can hand it back.
   * Null for 'external' or 'manual' agents (no underlying pool lease).
   *
   * Back-compat field; see `sessionId` note above.
   */
  leaseToken?: string | null;

  /**
   * Provider that backs this agent — the inference target. New field
   * (Decision 29 Phase A migration). Optional today; for records
   * without it, `synthesizeProvider(agent)` materializes a
   * BridgeProvider from `sessionId` / `leaseToken` so callers can
   * always reach a provider record.
   *
   * Going forward, `provider` is the source of truth and top-level
   * `sessionId` / `leaseToken` are deprecated. Phase E (Decision 29)
   * eventually drops the top-level fields.
   */
  provider?: AgentProvider;

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
// AgentProvider — the inference target backing an Agent
//
// Decision 29's central abstraction. An Agent's identity (id, role,
// bindings, notes) is separable from the inference target. The provider
// tagged union covers the targets we plan to support:
//
//   bridge   — Claude session via the bridge daemon (today: only mode)
//   together — together.ai HTTP inference for non-Claude models
//   openai   — OpenAI's API (incl. structured outputs, prompt cache)
//   local    — locally-hosted inference server (OpenAI-compatible HTTP)
//   mock     — in-process scripted replies (for tests)
//
// `leasedFrom` (pool / external / manual) stays on Agent; it answers
// "where the capacity came from," orthogonal to "what model is on the
// other end" (which is `provider.kind`).
// ===========================================================================

export type AgentProvider =
  | BridgeProvider
  | TogetherProvider
  | OpenAIProvider
  | LocalProvider
  | MockProvider;

/**
 * Bridge-backed provider — a Claude session reached via the bridge
 * daemon's request_reply / get_reply primitives. `sessionId` is the
 * raw bridge session id; `leaseToken` (if present) was issued by the
 * pool when the underlying session was acquired.
 */
export interface BridgeProvider {
  kind: 'bridge';
  /** Bridge session id, e.g. 'local_<uuid>'. */
  sessionId: string;
  /** Pool lease token; null/undefined for external/manual bridge sessions. */
  leaseToken?: string | null;
}

/**
 * Together.ai HTTP inference for Llama / Mistral / similar open models.
 * Cost-efficient for oversight / lightweight roles.
 */
export interface TogetherProvider {
  kind: 'together';
  /** Together-side model id, e.g. 'meta-llama/Llama-3.1-8B-Instruct'. */
  model: string;
  /** Secret-store reference, e.g. 'env:TOGETHER_API_KEY'. */
  apiKeyRef: string;
  sampling?: SamplingParams;
}

/**
 * OpenAI HTTP inference. Carries the API key reference plus sampling
 * defaults; provider-native features (structured outputs, prompt cache,
 * batch endpoints) are reached via the named escape hatch primitives at
 * `runtime.agents.providers.openai.*` (Decision 29).
 */
export interface OpenAIProvider {
  kind: 'openai';
  /** OpenAI model id, e.g. 'gpt-4o-mini'. */
  model: string;
  /** Secret-store reference. */
  apiKeyRef: string;
  sampling?: SamplingParams;
}

/**
 * Locally-hosted inference server speaking the OpenAI-compatible HTTP
 * shape (llama.cpp server, vllm, ollama, etc.). The `endpoint` is the
 * full base URL.
 */
export interface LocalProvider {
  kind: 'local';
  /** Local model id (server's own identifier). */
  model: string;
  /** HTTP endpoint, e.g. 'http://127.0.0.1:8080'. */
  endpoint: string;
  sampling?: SamplingParams;
}

/**
 * In-process scripted provider for tests. `script` is an opaque key the
 * mock implementation interprets — could be a canned reply identifier,
 * a path to a scripted sequence, etc.
 */
export interface MockProvider {
  kind: 'mock';
  script?: string;
}

/**
 * Sampling parameters common to HTTP-based providers. Not all providers
 * honor all fields; unset means "use the provider's default."
 */
export interface SamplingParams {
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  stop?: string[];
}

/**
 * Build a BridgeProvider from an Agent's legacy top-level `sessionId` /
 * `leaseToken` fields. Used by readers to materialize a provider record
 * for agents persisted before the Decision 29 Phase A migration. New
 * writers SHOULD set `Agent.provider` directly.
 *
 * Returns null when the agent has no sessionId AND no provider — there
 * is nothing to synthesize against.
 */
export function synthesizeProvider(agent: Agent): AgentProvider | null {
  if (agent.provider) return agent.provider;
  if (!agent.sessionId) return null;
  return {
    kind: 'bridge',
    sessionId: agent.sessionId,
    leaseToken: agent.leaseToken ?? null,
  };
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
  /**
   * Explicit inference target. Decision 29 Phase A: optional today, but
   * the canonical place to put provider config going forward. When set,
   * supersedes the synthesized BridgeProvider from `sessionId` /
   * `leaseToken`. Required for non-bridge providers (together, openai,
   * local, mock).
   */
  provider?: AgentProvider;
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

// ===========================================================================
// Reply types — the request/reply contract (Decision 29)
//
// Two-call shape:
//   1. agents.sendMessage(agentId, opts) -> { replyHandle } — fires
//      immediately; record minted; provider begins producing chunks.
//   2. agents.getReply(replyHandle, opts?) -> ReplyPoll — long-poll
//      pulls accumulated chunks plus a completion summary when the
//      assistant-turn ends.
//
// A convenience wrapper `agents.sendMessageAndAwait(agentId, opts)`
// loops getReply internally and returns the assembled `Reply` for
// short-reply use cases (oversight checks against fast HTTP providers).
// NEVER use the await wrapper for bridge-driven Claude turns — the
// timeout assumption breaks.
//
// The realm-fragility caveat from Decision 29: subscribers don't
// survive script.run boundaries, so PULL via getReply is the script
// caller's path. Push-style streaming (audit.subscribe on
// `agents.reply.chunk`) is available for long-lived consumers like UI
// surfaces.
// ===========================================================================

/** One chunk of a streaming reply. Provider-side classification. */
export interface ReplyChunk {
  /** Monotonic per-record index. Pass back as `sinceOffset` to resume. */
  offset: number;
  /**
   * Chunk taxonomy:
   *   - 'text'         — assistant text
   *   - 'tool-call'    — assistant tool_use
   *   - 'tool-result'  — tool execution result
   *   - 'event'        — provider-native metadata not in the standard
   *                      kinds (Decision 29 doc note; opaque payload)
   *   - 'meta'         — interruption markers etc.
   */
  kind: 'text' | 'tool-call' | 'tool-result' | 'event' | 'meta';
  /** Shape varies by kind; recipients treat unknown payloads as opaque. */
  data: unknown;
  /** ISO 8601 timestamp the chunk landed. */
  at: string;
}

/** Final-state summary attached to a completed ReplyRecord. */
export interface ReplySummary {
  startedAt: string;
  endedAt: string;
  durationMs: number;
  /** Total length of all text chunks concatenated. */
  textTotalLen: number;
  /** Count of `tool-call` chunks observed in this reply. */
  toolCallCount: number;
  /** True iff the reply was cut short by timeout rather than naturally completing. */
  truncatedByTimeout?: boolean;
}

/**
 * Result of `agents.getReply()`. Callers loop while `more === true`,
 * passing `nextOffset` back as `sinceOffset` on the following call.
 */
export interface ReplyPoll {
  /** Chunks newer than the caller's `sinceOffset`. */
  chunks: ReplyChunk[];
  /** Pass as `sinceOffset` on the next poll to continue without re-fetching. */
  nextOffset: number;
  /** Current state of the reply. */
  status: 'streaming' | 'complete' | 'error';
  /** True iff more chunks may still arrive. */
  more: boolean;
  /** Present only when `status === 'complete'`. */
  finalSummary?: ReplySummary;
  /** Present only when `status === 'error'`. */
  errorMessage?: string;
}

/**
 * Assembled reply returned by `agents.sendMessageAndAwait()`. The
 * convenience wrapper loops `getReply` internally and concatenates the
 * text chunks into `text`, collects tool calls into `toolCalls`, and
 * returns once status leaves 'streaming'. Throws on error or timeout.
 */
export interface Reply {
  replyHandle: string;
  agentId: string;
  /** Concatenated text from all 'text'-kind chunks, in offset order. */
  text: string;
  /** Tool-call chunk payloads as observed. */
  toolCalls: unknown[];
  summary: ReplySummary;
  /**
   * Provider-native escape hatch. When the caller needs richer access
   * than the standardized fields above (e.g. raw provider response for
   * a non-portable feature), the provider may populate `raw`.
   */
  raw?: unknown;
}

/**
 * The first-class record minted by `agents.sendMessage()`. Lives in
 * the AgentRepliesSubsystem; persists across runtime restart via the
 * Persistable interface (chunks NOT persisted — reconstructible from
 * the upstream provider handle on load when supported by the provider).
 */
export interface ReplyRecord {
  /** 'rep_<uuid>' — caller's handle for polling. */
  handle: string;
  /** Agent the reply is FROM. */
  agentId: string;
  /** Snapshot of the original request — text + timestamp + author. */
  request: {
    text: string;
    at: string;
    /** sessionId / agentId of the caller, if known. */
    by?: string;
  };
  /** Provider kind, denormalized for fast filtering without dereferencing the agent. */
  providerKind: AgentProvider['kind'];
  status: 'streaming' | 'complete' | 'error';
  startedAt: string;
  endedAt?: string;
  /**
   * Append-only chunks. NOT persisted (Decision 29 — reconstructible).
   * Materialized on load from the upstream provider when supported.
   */
  chunks: ReplyChunk[];
  /** Final summary; populated when status transitions to 'complete'. */
  finalSummary?: ReplySummary;
  truncatedByTimeout?: boolean;
  errorMessage?: string;
  /**
   * Upstream handle the provider returned (when applicable). For
   * BridgeProvider, this is the bridge daemon's replyHandle. The
   * AgentRepliesSubsystem polls the upstream handle to fill `chunks`
   * after a runtime-restart-induced reload.
   */
  upstreamHandle?: string;
}

// ===========================================================================
// SendMessage / GetReply opts
// ===========================================================================

/**
 * Options for `agents.sendMessage()`. Free-form attachments and tool
 * policy are provider-dependent — providers that don't support a given
 * feature should fail loudly rather than silently degrade.
 */
export interface SendMessageOpts {
  /** The message text. Required. */
  text: string;
  /** Optional attachments — provider-dependent support. */
  attachments?: unknown[];
  /** 'auto' lets the agent use tools; 'restricted' / 'none' disable them. */
  toolPolicy?: 'auto' | 'restricted' | 'none';
  /** sessionId / agentId of the caller, recorded on the ReplyRecord. */
  by?: string;
  /**
   * Bypass deduplication. Default false. When false, an identical send
   * within the provider's dedupe window returns the SAME replyHandle —
   * idempotency for retries.
   */
  forceDuplicate?: boolean;
  /**
   * Caller-controlled dedupe key. When set, overrides the provider's
   * default fingerprint input. Use for workflow-scoped dedupe, time-
   * bucketed retries, or replay protection on a per-step basis.
   */
  idempotencyKey?: string;
}

/** Options for `agents.getReply()`. */
export interface GetReplyOpts {
  /** Last chunk offset already seen. Default 0 (start from the beginning). */
  sinceOffset?: number;
  /**
   * 'none'      — return whatever's accumulated immediately.
   * 'long-poll' — server holds the call until new chunks arrive or
   *               `timeoutMs` elapses.
   */
  wait?: 'none' | 'long-poll';
  /** Default 25_000 ms; capped well under MCP request timeout. */
  timeoutMs?: number;
}

/** Options for `agents.sendMessageAndAwait()`. */
export interface SendMessageAndAwaitOpts extends SendMessageOpts {
  /** Total await timeout across all internal long-polls. Default 60_000 ms. */
  timeoutMs?: number;
}

// ===========================================================================
// Turn — the atomic unit of state evolution
//
// A Turn is the durable record of one prompt-reply pair, captured at the
// "request to reply" granularity. It's reference-able from many places
// (Activities, North Star transcripts, Decision logs) and persists
// independently of the volatile ReplyRecord (which TTLs out at 24h).
//
// Two distinct uses of Turn data motivate the shape:
//
//   1. tuning the system — save *everything*. Full assembled text, raw
//      ReplyRecord linkage, observed side-effects, optional contextSent
//      when the provider can give it. This record is canonical and never
//      lossy.
//
//   2. seeding the next turn — derived artifact (a "seed" built by a
//      Secretary pass) is separate, not stored on the Turn itself.
//
// Side-effect attribution: while a Turn is active, audit events emitted
// in a frame carrying its `turnId` (and/or events emitted from the
// agent's aiSessionId during the Turn window) are collected as
// `sideEffects`. The TurnsSubsystem owns this collection passively via
// audit.subscribe — no dedicated tools required for the common case.
// ===========================================================================

/**
 * One observed mutation while a Turn was active. Captured by the
 * TurnsSubsystem's audit subscriber when frame.turnId matches the Turn.
 *
 * The shape mirrors the SemanticEventEntry audit log entry, plus the
 * `op` lens — derived when possible from the eventKind taxonomy.
 */
export interface TurnSideEffect {
  /** ISO 8601 — when the audit event fired. */
  at: string;
  /** Audit event kind, e.g. 'agents.note-added', 'projects.charter.updated'. */
  eventKind: string;
  /** Audit ref pointing at the mutated item, when available. */
  ref?: string;
  /**
   * Operation lens. Derived from eventKind where the taxonomy is known
   * (e.g. '*.created' → 'create', '*.updated' → 'set', '*.removed' →
   * 'delete'). 'other' when the eventKind doesn't map cleanly.
   */
  op: 'create' | 'set' | 'append' | 'delete' | 'register' | 'other';
  /** Event payload — typed unknown to keep shape provider-agnostic. */
  data?: unknown;
}

/**
 * A reference TO this Turn FROM somewhere else. Activities point at the
 * Turns they contain; Decision logs point at the Turn that birthed them;
 * North Star transcripts can include selected Turns. The Turn itself
 * carries the inbound refs so we can do reverse lookups ("who points
 * at me?") without scanning the entire runtime.
 */
export interface TurnReference {
  /** Domain identifier of the referrer, e.g. 'activity', 'north-star', 'decision'. */
  kind: string;
  /** Stable id of the referrer record. */
  ref: string;
  /** Optional position / order within the referrer (e.g. activity turn index). */
  position?: number;
  /** When the reference was attached. */
  attachedAt: string;
}

/** Tool-call payload as observed in the reply. */
export interface TurnToolCall {
  /** Provider's tool_use id (Bridge's `{ id }`, OpenAI tool_call.id, …). */
  id?: string;
  /** Tool name as the model invoked it. */
  name: string;
  /** Input args the model sent. May be depth-1 truncated by the provider. */
  input: unknown;
  /** When the tool-call chunk arrived. */
  at: string;
}

export type TurnStatus = 'streaming' | 'complete' | 'error';

/**
 * The first-class Turn record. Persisted by the TurnsSubsystem; durable
 * across runtime restart. Lives in blur-agent so any provider/agent
 * interaction produces a Turn regardless of which domain (project,
 * supervisory, secretary) anchors it.
 */
export interface Turn {
  /** 'tur_<uuid>' — durable id. */
  id: string;

  /** Agent that produced this Turn. */
  agentId: string;

  /** Provider kind at time of dispatch. Denormalized for filtering. */
  providerKind: AgentProvider['kind'];

  /**
   * The agent's session id at time of dispatch (when known). For
   * BridgeProvider this is the Claude session id; for HTTP providers
   * it may be null (no persistent session concept).
   */
  agentSessionId?: string | null;

  /** Snapshot of the original request. */
  request: {
    text: string;
    at: string;
    /** Caller identity — usually a sessionId or agentId. */
    by?: string;
  };

  /**
   * Full context delivered to the model on this Turn, when the provider
   * can surface it. Bridge today does NOT expose this; HTTP providers
   * (Together, OpenAI) trivially can. Lazy / optional. Used for tuning
   * analysis — "what did we actually send?"
   */
  contextSent?: string | null;

  /** Linkage to the volatile ReplyRecord. May 404 after the ReplyRecord TTLs. */
  replyHandle: string;

  /** Concatenated text from text-kind chunks in offset order. */
  assembledText: string;

  /** Tool-call payloads observed in this Turn. */
  toolCalls: TurnToolCall[];

  /**
   * Audit events observed while this Turn was active. Populated
   * passively by the TurnsSubsystem's audit subscriber. Never edited
   * directly by callers.
   */
  sideEffects: TurnSideEffect[];

  /** Inbound references — who points at this Turn. */
  references: TurnReference[];

  status: TurnStatus;
  startedAt: string;
  endedAt?: string;

  /** Mirror of ReplyRecord.finalSummary when status === 'complete'. */
  finalSummary?: ReplySummary;
  errorMessage?: string;
}

// ===========================================================================
// Turn opts shapes
// ===========================================================================

export interface OpenTurnOpts {
  agentId: string;
  providerKind: AgentProvider['kind'];
  agentSessionId?: string | null;
  request: { text: string; at: string; by?: string };
  replyHandle: string;
  contextSent?: string | null;
}

export interface ListTurnsOpts {
  agentId?: string;
  status?: TurnStatus | TurnStatus[];
  /** Filter by inbound reference — e.g. all Turns referenced by an activity. */
  referencedBy?: { kind: string; ref: string };
  /** ISO 8601 lower bound (inclusive). */
  since?: string;
  /** ISO 8601 upper bound (inclusive). */
  until?: string;
  /** Default 100. */
  limit?: number;
}

export interface AddTurnReferenceOpts {
  turnId: string;
  reference: Omit<TurnReference, 'attachedAt'>;
}
