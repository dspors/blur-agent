/**
 * EngagementFlowSubsystem — the glue that turns
 * `engagements.opened` / `engagements.completed` into the three
 * orchestration behaviors specified by SA-Engagement-Flow.md:
 *
 *   1. Secretary auto-prep   (engagements.opened   → prep-started / prep-progress / prep-complete)
 *   2. Scheduler auto-lease  (engagements.opened   → lease-started / session-ready)
 *   3. Result-linker         (engagements.completed → linker-started / linker-complete)
 *
 * Subscribers fire in parallel; UI waits for BOTH `prep-complete` AND
 * `session-ready` before enabling dispatch (per the SA contract).
 *
 * Mounted at `runtime.engagementFlow.*` with a read-only surface:
 *   getPrepData(engagementId)  → assembled PrepData for the hot session
 *   listPrepData()             → all known prep entries (debug / inspector)
 *
 * Persistable (Decision 20): the PrepData store survives runtime restart
 * so a session resuming an Engagement can still read its prep blob.
 */

import type { BlurAIRuntime, Persistable } from 'blur-ai-runtime';
import { parseBTags, renderTagResult, stringifyScriptReturn } from './b-tags';

import type { AgentsSubsystem } from './agents-subsystem';
import type { SchedulerSubsystem } from './scheduler-subsystem';
import { resolveDispatch } from './scheduler-routing';
import { composePrefix } from './prefix-composer';
import {
  DEFAULT_PREP_STEPS,
  LINKER_OUTPUT_KINDS,
  type EngagementFlowOptions,
  type LinkedOutput,
  type PrepData,
  type PrepDataTrackSummary,
  type PrepStepDescriptor,
} from './engagement-flow-types';

interface SemanticEventLike {
  eventKind: string;
  ref?: string;
  at: string;
  data?: Record<string, unknown>;
}

interface RuntimeShape {
  audit?: {
    subscribe?: (pattern: string, handler: (entry: SemanticEventLike) => void) => () => void;
    emit?: (e: { kind: string; ref?: string; data?: Record<string, unknown> }) => void;
    currentFrame?: () => { engagementId?: string; turnId?: string } | undefined;
  };
  extensions?: { get(name: string): unknown };
  packs?: { list?: () => unknown };
}

/**
 * Local mirror of the walker's ResolverSpec shape so the generic tag
 * dispatcher doesn't take a hard type dependency on blur-ai-runtime's
 * internal type. Field shape per Decision 37 §3 +
 * `src/subsystems/tag-walker.ts`.
 */
interface GenericResolverSpec {
  kind: string;
  tagName: string;
  read?: { method: string };
  list?: { method: string; filters?: string[] };
  count?: { method: string; filters?: string[] };
  write?: { method: string };
  invoke?: Array<{
    method: string;
    primitivePath: string;
    description?: string;
    requiresId?: boolean;
  }>;
}

/**
 * One delta entry buffered for inclusion in Layer 4 of the layered
 * prefix. Decision 37 §9.
 *
 * - `Δ` form: a snapshot field's value changed
 * - `+` form: a new entity appeared (filed, opened, created)
 *
 * Rendered as a single line; chronologically interleaved with Turn
 * pairs in the chronological tail.
 */
interface DeltaEntry {
  /** Microsecond-precision timestamp (ISO + tail) for chronological ordering. */
  at: string;
  /** 'Δ' for value-diff; '+' for new-entity-append. */
  marker: 'Δ' | '+';
  /** Pre-rendered line body, e.g. "ticket.status[tkt_abc]: open → resolved". */
  body: string;
}

/**
 * Parse a comma-separated `filter="key:value,key:value"` attribute into
 * an opts object. Keys outside the optional `allowedKeys` whitelist are
 * dropped (the walker declares allowed filters per entity).
 *
 * Values are returned as strings; the underlying list primitive can
 * coerce as needed. v1 doesn't try to type-resolve values from the
 * attribute string.
 */
function parseFilterAttr(
  s: string,
  allowedKeys?: string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!s) return out;
  for (const pair of s.split(',')) {
    const idx = pair.indexOf(':');
    if (idx < 1) continue;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    if (!k) continue;
    if (allowedKeys && !allowedKeys.includes(k)) continue;
    out[k] = v;
  }
  return out;
}

interface EngagementsBridge {
  get?: (id: string) => unknown;
  addOutput?: (opts: { engagementId: string; output: { kind: string; ref: string; label?: string } }) => unknown;
  profiles?: { get?: (activityId: string) => unknown };
}

interface ProjectsBridge {
  get?: (id: string) => Promise<unknown> | unknown;
  charter?: { get?: (id: string) => Promise<unknown> | unknown };
  tracks?: { list?: (id: string) => Promise<unknown> | unknown };
}

interface Snapshot {
  schemaVersion: number;
  prepData: Array<{ engagementId: string; prepData: PrepData }>;
  outputsByEngagement: Array<{ engagementId: string; outputs: LinkedOutput[] }>;
}

/**
 * Narrow projection of a Turn record's fields the script-loop handler
 * cares about. Avoids importing the full TurnsSubsystem type and lets
 * us read with a single shape.
 */
interface TurnRecordView {
  assembledText?: string;
  startedAt?: string;
  endedAt?: string;
  providerKind?: string;
  agentId?: string;
  request?: { text?: string };
}

/**
 * Per-Turn timing + size statistics. One record per Turn record (each
 * iteration of a script-loop chain is its own Turn in v1, so each
 * iteration gets its own TurnStats entry). Populated when the Turn
 * completes; survives in-memory until the engagement leaves
 * the global cap rolls oldest entries off.
 */
export interface TurnStats {
  /** The Turn this stats record belongs to. */
  turnId: string;
  /** Engagement the Turn was dispatched against. */
  engagementId: string;
  /**
   * Iteration index within the script-loop chain. 1 for a user-initiated
   * Turn (or the first non-script-loop Turn after a chain ends); 2+ for
   * follow-up Turns dispatched by the script-loop subscriber.
   */
  iter: number;
  /** Role within the chain — distinguishes user prompts from script-loop continuations. */
  loopRole: 'user-initiated' | 'script-loop';
  /** ISO timestamps from the Turn record. */
  startedAt: string;
  endedAt: string;
  /** End-to-end wall clock for this Turn (model call + chunk arrival). */
  durationMs: number;
  /** Bytes of the prompt sent to the provider (request.text length). */
  prefixLen: number;
  /** Bytes of the model's reply (assembledText length). */
  replyLen: number;
  /** Number of `<b:s>` tags extracted from the reply. 0 = chain-terminating. */
  tagCount: number;
  /** Sum of `runtime.script.run` wall-clock time for all tags this iteration. */
  scriptExecMs: number;
  /** Sum of `<b:s-result>` body bytes (pre-truncation) for all tags. */
  scriptResultBytes: number;
  /** Provider kind that handled this Turn (from Turn.providerKind). */
  providerKind?: string;
  /** Agent id (from Turn.agentId). */
  agentId?: string;
  /**
   * `'script-free'` — reply had no tags; chain terminated naturally.
   * `'has-tags'` — reply had tags; follow-up was dispatched.
   * `'cap-reached'` — reply had tags but iteration cap exceeded; chain terminated.
   * `'error'` — handler threw before completing.
   */
  terminationReason: 'script-free' | 'has-tags' | 'cap-reached' | 'error';
}

/**
 * Aggregate view over an engagement's recent Turn stats. Returned by
 * `engagementFlow.getEngagementStats`.
 */
export interface EngagementStats {
  engagementId: string;
  /** Total Turns recorded in the in-memory store. */
  totalTurns: number;
  /** Sum of every Turn's `<b:s>` tag count. */
  totalTagCount: number;
  /** Sum of every Turn's scriptExecMs. */
  totalScriptExecMs: number;
  /** Sum of every Turn's durationMs. */
  totalDurationMs: number;
  /** Mean Turn duration. */
  meanDurationMs: number;
  /** Most recent N Turn stats (newest first). */
  recent: TurnStats[];
}

const SCHEMA_VERSION = 1;

export class EngagementFlowSubsystem implements Persistable {
  /** Backref to AgentsSubsystem — set by the pack install. */
  agentsRef: AgentsSubsystem | null = null;
  /**
   * Backref to SchedulerSubsystem — set by the pack install. Used by
   * dispatchTurn to route through scheduler.requestTurn (Decision 34
   * ticket model). When unset, dispatchTurn falls back to direct
   * agents.sendMessage (no ticket; v0 path).
   */
  schedulerRef: SchedulerSubsystem | null = null;

  private readonly opts: Required<EngagementFlowOptions>;

  /** Assembled PrepData, keyed by engagementId. */
  private prepDataByEng = new Map<string, PrepData>();

  /**
   * Accumulator of output candidates observed during each Engagement
   * window. Populated by the audit-output subscriber; consumed by the
   * linker on `engagements.completed`.
   */
  private outputsByEng = new Map<string, LinkedOutput[]>();

  // -------------------------------------------------------------------------
  // Script-loop state (state-advancement-loop §1).
  //
  // The substrate's reaction to `agents.turn.completed` decides whether the
  // model's reply contains `<b:s>` script tags. If so, each tag is executed
  // via `runtime.script.run`, the results are appended to the prompt as
  // `<b:s-result>` blocks, and a follow-up Turn is dispatched. The loop
  // continues until a reply is script-free OR the per-engagement iteration
  // cap is reached.
  //
  // See `runtime.library.get('state-advancement-loop')` for the full spec.
  // -------------------------------------------------------------------------

  /** Iteration count per engagement; reset when a script-free reply arrives. */
  private scriptLoopIterations = new Map<string, number>();
  /** Map turnId → engagementId, populated by subscribing to `engagements.turn-added`. */
  private turnToEngagement = new Map<string, string>();
  /** Per-engagement remembered prior-iteration prompt — feeds the next iter's prefix. */
  private lastDispatchedPromptByEng = new Map<string, string>();
  /** Hard cap on iterations per script-loop chain. */
  private static SCRIPT_LOOP_CAP = 64;

  // -------------------------------------------------------------------------
  // Delta-tail projection (Decision 37 §9 + design conversation)
  //
  // Per-engagement buffer of entity-mutation deltas observed since the
  // last user-initiated Turn. Subscribers on `tickets.*`, `decisions.*`,
  // `projects.*` etc. classify each event as Δ (value-diff for a snapshot
  // field) or + (new entity creation). On the next user-initiated
  // dispatch, accumulated deltas are spliced into Layer 4 (chronological
  // tail) chronologically alongside the prior Turn pair, then drained.
  //
  // Cache discipline: each Turn's tail grows by the new delta block AND
  // the new Turn pair. The byte-stable upper prefix (Layers 1A-3) doesn't
  // rebuild — providers' KV cache hits everything above the new tail.
  // -------------------------------------------------------------------------
  /** Per-engagement buffered deltas, awaiting the next user-initiated dispatch. */
  private deltasByEng = new Map<string, DeltaEntry[]>();
  /** Hard cap on per-engagement buffer so a runaway mutation stream doesn't OOM. */
  private static DELTA_BUFFER_CAP = 200;

  /**
   * Audit kinds the delta-tail subscriber listens to. Curated set —
   * pack authors that want their entity's mutations to surface as deltas
   * for the model add their kinds here (or, future, via a pack-declared
   * delta-projection hook).
   */
  private static DELTA_AUDIT_KINDS: string[] = [
    // Tickets
    'tickets.filed',
    'tickets.updated',
    'tickets.resolved',
    'tickets.closed',
    'tickets.wont-fix',
    'tickets.reopened',
    // Decisions
    'decisions.opened',
    'decisions.resolved',
    'decisions.deferred',
    'decisions.dropped',
    // Projects
    'projects.directionSet',
    'projects.charterDefinitionSet',
    'projects.updated',
    // Engagements (self-referential — the engagement seeing its own
    // status changes is useful context for restart/resume)
    'engagements.runtime-model-set',
    'engagements.runtime-model-cleared',
    'engagements.output-added',
  ];

  /**
   * Activities whose user-initiated Turns get prior-Turn history appended
   * to the prefix on dispatch. See `assemblePriorChainPrefix` for the
   * append shape.
   *
   * Why opt-in per Activity: history-append is a tradeoff. For chat-style
   * Activities (general), it preserves cross-Turn memory and keeps the
   * KV cache warm across the user's whole conversation. For Activities
   * that are explicitly stateless or per-Turn (e.g. a one-shot Activity
   * that always reads fresh state and answers without conversational
   * context), the history is wasted budget. v1 starts with general only;
   * other Activities opt in via this set as we tune them. v2 will move
   * this to `Activity.contextProjection.historyMode`.
   */
  private static HISTORY_APPEND_ACTIVITIES = new Set<string>(['general']);

  /**
   * Per-Turn statistics, keyed by turnId. Populated by the script-loop
   * subscriber as each Turn completes. Survives until the engagement
   * the cap (TURN_STATS_CAP) is hit, after which oldest entries are
   * dropped.
   *
   * Surfaced via `engagementFlow.getTurnStats(turnId)` and
   * `engagementFlow.getEngagementStats(engId)`. The audit log is the
   * eventual-consistent truth; this map is the cheap O(1) view.
   */
  private turnStats = new Map<string, TurnStats>();
  private turnStatsOrder: string[] = [];
  private static TURN_STATS_CAP = 500;

  /**
   * In-memory tally of emitted audit events, by kind. Diagnostic only —
   * exposed via `recentEmissions()` so the smoke test (and any inspector)
   * can verify what the subsystem emitted without having to subscribe
   * to audit (script isolates can't marshal handler closures across
   * the primitive boundary).
   */
  private emissionCounts = new Map<string, number>();
  private emissionsLog: Array<{ kind: string; ref?: string; data?: Record<string, unknown>; at: string }> = [];
  private static EMISSIONS_LOG_CAP = 200;

  private unsubs: Array<() => void> = [];
  private _dirty = false;

  constructor(public readonly runtime: BlurAIRuntime, options: EngagementFlowOptions = {}) {
    this.opts = {
      defaultLeaseRole: options.defaultLeaseRole ?? 'run',
      mockLease: options.mockLease ?? false,
      prepSteps: options.prepSteps ?? DEFAULT_PREP_STEPS,
    };
  }

  // ===================================================================
  // Lifecycle
  // ===================================================================

  start(): void {
    if (this.unsubs.length > 0) return;
    const audit = (this.runtime as RuntimeShape).audit;
    if (!audit?.subscribe) return;

    // Two parallel paths off `engagements.opened`.
    this.unsubs.push(
      audit.subscribe('engagements.opened', (e) => {
        void this.onEngagementOpened(e);
      }),
    );
    // Linker trigger.
    this.unsubs.push(
      audit.subscribe('engagements.completed', (e) => {
        void this.onEngagementCompleted(e);
      }),
    );
    // Output accumulator — one subscription per relevant kind so the
    // ref pattern matcher stays simple (exact match, no regex).
    for (const kind of LINKER_OUTPUT_KINDS) {
      this.unsubs.push(
        audit.subscribe(kind, (e) => this.onOutputCandidate(e)),
      );
    }

    // Script-loop wiring — see state-advancement-loop §1, §3.
    this.unsubs.push(
      audit.subscribe('engagements.turn-added', (e) => {
        const turnId = (e.data as { turnId?: string } | undefined)?.turnId;
        const engId = (e.data as { engagementId?: string } | undefined)?.engagementId;
        if (turnId && engId) this.turnToEngagement.set(turnId, engId);
      }),
    );
    this.unsubs.push(
      audit.subscribe('agents.turn.completed', (e) => {
        void this.onTurnCompletedForScriptLoop(e);
      }),
    );

    // Decision 37 — delta-tail projection (Layer 4 of the layered prefix).
    // Subscribe to entity-mutation audits and classify each into Δ/+ lines
    // buffered per-engagement, awaiting the next user-initiated dispatch.
    // Scope filter inside onMutationForDelta narrows to entities that
    // intersect each active engagement's snapshot scope.
    for (const kind of EngagementFlowSubsystem.DELTA_AUDIT_KINDS) {
      this.unsubs.push(
        audit.subscribe(kind, (e) => this.onMutationForDelta(kind, e)),
      );
    }

    // Rebuild the turnId→engagementId index from the durable store so
    // pack reloads don't drop the cache. The script-loop subscriber
    // consults this index when `agents.turn.completed` fires; without
    // rehydration, Turns whose `engagements.turn-added` audit fired
    // during a prior subsystem lifetime would be invisible. Active
    // engagement status itself is NOT cached — checked on demand.
    void this.rehydrateScriptLoopState();
  }

  // ===========================================================================
  // <b:p> property-read tag — host-side entity lookup + dot-path walk
  // ===========================================================================

  /**
   * v1 entity-kind resolver map. Each entry says: to resolve
   * `<b:p e="<kind>:<id>">…</b:p>`, look up the extension at `extName`
   * and call `<id>` through its `getMethod`.
   *
   * Lives host-side — bypasses the script-isolate proxy entirely, so
   * it's immune to the `this`-binding issues that bite
   * `runtime.script.run(...)` when the proxy strips the original method
   * binding.
   *
   * v2 will auto-derive this map from the registered `MethodExposure`
   * records (any exposure matching `<pack>.get(id)` becomes a tag),
   * plus optional pack-declared overrides for non-standard shapes.
   */
  private static B_P_RESOLVERS: Record<string, { extName: string; getMethod: string }> = {
    project: { extName: 'projects', getMethod: 'get' },
    ticket: { extName: 'tickets', getMethod: 'get' },
    decision: { extName: 'decisions', getMethod: 'get' },
    engagement: { extName: 'engagements', getMethod: 'get' },
    agent: { extName: 'agents', getMethod: 'get' },
    turn: { extName: 'turns', getMethod: 'get' },
  };

  /**
   * Resolve a `<b:p>` tag: parse `e="<kind>:<id>"`, fetch the entity,
   * walk the dot-path in the tag body. Returns `{ ok, value, error }`
   * shaped like a script result so the script-loop handler can splice
   * it the same way.
   */
  private async resolveBPTag(tag: import('./b-tags').BTag): Promise<{
    ok: boolean;
    value?: unknown;
    error?: string;
  }> {
    const e = tag.attrs.e;
    if (!e) return { ok: false, error: '<b:p> requires e="<kind>:<id>" attribute' };
    const sep = e.indexOf(':');
    if (sep <= 0) {
      return { ok: false, error: `<b:p e="${e}"> — expected "<kind>:<id>" form` };
    }
    const kind = e.slice(0, sep);
    const id = e.slice(sep + 1);
    const spec = EngagementFlowSubsystem.B_P_RESOLVERS[kind];
    if (!spec) {
      const known = Object.keys(EngagementFlowSubsystem.B_P_RESOLVERS).join(', ');
      return {
        ok: false,
        error: `<b:p> unknown entity kind "${kind}". Known: ${known}.`,
      };
    }
    const ext = (this.runtime as RuntimeShape).extensions?.get?.(spec.extName) as
      | Record<string, unknown>
      | null
      | undefined;
    const getter = ext && (ext[spec.getMethod] as unknown);
    if (typeof getter !== 'function') {
      return {
        ok: false,
        error: `<b:p e="${e}"> — ${spec.extName}.${spec.getMethod} not available`,
      };
    }
    let entity: unknown;
    try {
      // Invoke as a method so `this` is bound to the extension instance.
      // Same gotcha the engagements.bindAgent call had — destructured
      // method references lose `this`.
      entity = await Promise.resolve((getter as (id: string) => unknown).call(ext, id));
    } catch (err) {
      return { ok: false, error: (err as Error)?.message ?? String(err) };
    }
    if (entity === null || entity === undefined) {
      return { ok: false, error: `<b:p e="${e}"> — entity not found` };
    }
    // Walk the dot-path against the entity record.
    const path = (tag.body ?? '').trim();
    const value = path ? walkDotPath(entity, path) : entity;
    return { ok: true, value };
  }

  /**
   * Resolve a Decision 37 descriptive entity tag (`<b:project>`,
   * `<b:ticket>`, `<b:library>`, etc.) by consulting `runtime.tags.resolvers()`
   * and dispatching by action attribute.
   *
   * Action defaults to `read`. Supported actions per declaration: read,
   * list, count, update, invoke. Missing declarations for a given action
   * return a structured error so the model sees what's available.
   *
   * Resolves entity references / methods host-side via
   * `runtime.extensions.get(extName)`. Same `getter.call(ext, ...)` pattern
   * as `resolveBPTag` to sidestep the script-isolate this-binding edge
   * cases that bite `<b:script>` for primitives with backref state.
   */
  private async resolveGenericTag(tag: import('./b-tags').BTag): Promise<{
    ok: boolean;
    value?: unknown;
    error?: string;
  }> {
    const tagName = tag.kind.startsWith('b:') ? tag.kind.slice(2) : tag.kind;
    const walker = (this.runtime as RuntimeShape & {
      tagWalker?: {
        resolvers: (surface?: unknown) => Map<string, GenericResolverSpec>;
      };
    }).tagWalker;
    if (!walker || typeof walker.resolvers !== 'function') {
      return {
        ok: false,
        error: `<b:${tagName}>: runtime.tagWalker not available — substrate predates Decision 37 or walker subsystem failed to load.`,
      };
    }

    let resolvers: Map<string, GenericResolverSpec>;
    try {
      resolvers = walker.resolvers();
    } catch (err) {
      return { ok: false, error: `walker.resolvers() failed: ${(err as Error).message}` };
    }
    const spec = resolvers.get(tagName);
    if (!spec) {
      const known = [...resolvers.keys()].sort().join(', ');
      return {
        ok: false,
        error: `<b:${tagName}> unknown entity tag. Known tags: ${known}. (Use <b:script> for irregular operations.)`,
      };
    }

    const action = (tag.attrs.action ?? 'read').toLowerCase();

    switch (action) {
      case 'read':
        return this.runGenericRead(tagName, tag, spec);
      case 'list':
        return this.runGenericList(tagName, tag, spec);
      case 'count':
        return this.runGenericCount(tagName, tag, spec);
      case 'update':
        return this.runGenericUpdate(tagName, tag, spec);
      case 'invoke':
        return this.runGenericInvoke(tagName, tag, spec);
      default:
        return {
          ok: false,
          error: `<b:${tagName} action="${action}">: unsupported action. Supported: read, list, count, update, invoke.`,
        };
    }
  }

  /** Read one field via dot-path on an entity fetched by id. */
  private async runGenericRead(
    tagName: string,
    tag: import('./b-tags').BTag,
    spec: GenericResolverSpec,
  ): Promise<{ ok: boolean; value?: unknown; error?: string }> {
    if (!spec.read) {
      return { ok: false, error: `<b:${tagName}>: 'read' action not supported for this entity.` };
    }
    const id = tag.attrs.id;
    if (!id) {
      return { ok: false, error: `<b:${tagName}>: read requires id="..."` };
    }
    const r = await this.invokePrimitive(spec.read.method, [id]);
    if (!r.ok) return r;
    if (r.value === null || r.value === undefined) {
      return { ok: false, error: `<b:${tagName} id="${id}">: entity not found` };
    }
    const path = (tag.body ?? '').trim();
    const value = path ? walkDotPath(r.value, path) : r.value;
    return { ok: true, value };
  }

  /** List entities with optional filter attribute (comma-separated key:value). */
  private async runGenericList(
    tagName: string,
    tag: import('./b-tags').BTag,
    spec: GenericResolverSpec,
  ): Promise<{ ok: boolean; value?: unknown; error?: string }> {
    if (!spec.list) {
      return { ok: false, error: `<b:${tagName}>: 'list' action not supported for this entity.` };
    }
    const filters = parseFilterAttr(tag.attrs.filter ?? '', spec.list.filters);
    return this.invokePrimitive(spec.list.method, [filters]);
  }

  /** Count entities with optional filter attribute. */
  private async runGenericCount(
    tagName: string,
    tag: import('./b-tags').BTag,
    spec: GenericResolverSpec,
  ): Promise<{ ok: boolean; value?: unknown; error?: string }> {
    if (!spec.count) {
      return { ok: false, error: `<b:${tagName}>: 'count' action not supported for this entity.` };
    }
    const filters = parseFilterAttr(tag.attrs.filter ?? '', spec.count.filters);
    return this.invokePrimitive(spec.count.method, [filters]);
  }

  /** Update one field — body is the new value, path attribute is the field. */
  private async runGenericUpdate(
    tagName: string,
    tag: import('./b-tags').BTag,
    spec: GenericResolverSpec,
  ): Promise<{ ok: boolean; value?: unknown; error?: string }> {
    if (!spec.write) {
      return { ok: false, error: `<b:${tagName}>: 'update' action not supported for this entity.` };
    }
    const id = tag.attrs.id;
    if (!id) {
      return { ok: false, error: `<b:${tagName} action="update">: requires id="..."` };
    }
    const path = tag.attrs.path;
    if (!path) {
      return { ok: false, error: `<b:${tagName} action="update">: requires path="<field>"` };
    }
    // Parse body — try JSON first, fall back to raw string.
    const raw = tag.body.trim();
    let parsedValue: unknown = raw;
    try {
      parsedValue = JSON.parse(raw);
    } catch {
      /* leave as string */
    }
    const patch: Record<string, unknown> = { [path]: parsedValue };
    return this.invokePrimitive(spec.write.method, [id, patch]);
  }

  /** Invoke a method-style write declared in spec.invoke[]. */
  private async runGenericInvoke(
    tagName: string,
    tag: import('./b-tags').BTag,
    spec: GenericResolverSpec,
  ): Promise<{ ok: boolean; value?: unknown; error?: string }> {
    if (!spec.invoke?.length) {
      return { ok: false, error: `<b:${tagName}>: 'invoke' action not supported for this entity.` };
    }
    const method = tag.attrs.method;
    if (!method) {
      return {
        ok: false,
        error: `<b:${tagName} action="invoke">: requires method="..." (available: ${spec.invoke.map(m => m.method).join(', ')})`,
      };
    }
    const decl = spec.invoke.find(m => m.method === method);
    if (!decl) {
      return {
        ok: false,
        error: `<b:${tagName} action="invoke" method="${method}">: method not declared. Available: ${spec.invoke.map(m => m.method).join(', ')}`,
      };
    }
    // Parse body — JSON expected for the payload.
    const raw = tag.body.trim();
    let payload: unknown = {};
    if (raw.length) {
      try {
        payload = JSON.parse(raw);
      } catch (err) {
        return {
          ok: false,
          error: `<b:${tagName} action="invoke" method="${method}">: body must be valid JSON. Parse error: ${(err as Error).message}`,
        };
      }
    }
    const args: unknown[] = decl.requiresId
      ? [tag.attrs.id, payload]
      : [payload];
    if (decl.requiresId && !tag.attrs.id) {
      return {
        ok: false,
        error: `<b:${tagName} action="invoke" method="${method}">: this method requires id="..."`,
      };
    }
    return this.invokePrimitive(decl.primitivePath, args);
  }

  /**
   * Resolve a primitivePath (`<ext>.<method>` or deeper) to a callable on
   * a registered extension object and invoke it with `getter.call(ext, ...)`.
   * Sidesteps the script-isolate proxy `this`-binding issue.
   *
   * Returns the standard `{ok, value, error}` shape.
   */
  private async invokePrimitive(
    primitivePath: string,
    args: unknown[],
  ): Promise<{ ok: boolean; value?: unknown; error?: string }> {
    // primitivePath: 'tickets.get' → extName='tickets', methodPath=['get']
    // primitivePath: 'workspaces.tools.add' → extName='workspaces', methodPath=['tools','add']
    const segments = primitivePath.split('.');
    if (segments.length < 2) {
      return { ok: false, error: `invokePrimitive: invalid primitivePath '${primitivePath}'` };
    }
    const extName = segments[0]!;
    const methodPath = segments.slice(1);
    const ext = (this.runtime as RuntimeShape).extensions?.get?.(extName);
    if (!ext || typeof ext !== 'object') {
      return { ok: false, error: `invokePrimitive: extension '${extName}' not loaded` };
    }
    // Walk the methodPath; resolve the receiver for the final call so
    // `this` binds to the right intermediate object.
    let receiver: Record<string, unknown> = ext as Record<string, unknown>;
    for (let i = 0; i < methodPath.length - 1; i++) {
      const next = receiver[methodPath[i]!];
      if (!next || typeof next !== 'object') {
        return { ok: false, error: `invokePrimitive: '${primitivePath}' — '${methodPath.slice(0, i + 1).join('.')}' missing or not an object` };
      }
      receiver = next as Record<string, unknown>;
    }
    const methodName = methodPath[methodPath.length - 1]!;
    const fn = receiver[methodName];
    if (typeof fn !== 'function') {
      return { ok: false, error: `invokePrimitive: '${primitivePath}' not callable` };
    }
    try {
      const value = await Promise.resolve((fn as (...a: unknown[]) => unknown).call(receiver, ...args));
      return { ok: true, value };
    } catch (err) {
      return { ok: false, error: (err as Error)?.message ?? String(err) };
    }
  }

  /**
   * Audit subscriber for entity-mutation events (Decision 37 §9 delta
   * tail). Classifies each event as Δ (value-diff) or + (new entity)
   * and appends to the per-engagement buffer for every currently-active
   * engagement whose snapshot scope intersects the mutation's entity.
   *
   * Scope filter (v1, conservative): match if the affected entity's
   * `project` / `projectId` carries an engagement's scope.ref. Project-
   * scoped engagements see only their own project's mutations; cross-
   * project engagements (future PM agent) see everything.
   */
  private onMutationForDelta(kind: string, event: SemanticEventLike): void {
    try {
      const data = (event.data ?? {}) as Record<string, unknown>;
      const at = event.at ?? new Date().toISOString();
      const projectRef = this.extractProjectFromMutation(kind, data);
      const classified = this.classifyMutation(kind, data);
      if (!classified) return;
      const entry: DeltaEntry = { at, marker: classified.marker, body: classified.body };

      // Fan out to every active engagement whose scope matches.
      const engagementsApi = this.resolveEngagements() as
        | { list?: (opts: { status?: string }) => unknown }
        | null;
      const active = engagementsApi?.list?.({ status: 'active' });
      if (!Array.isArray(active)) return;
      for (const engRaw of active) {
        const eng = engRaw as { id?: string; scope?: { kind?: string; ref?: string } };
        if (!eng.id) continue;
        if (!this.engagementMatchesScope(eng, projectRef)) continue;
        this.bufferDelta(eng.id, entry);
      }
    } catch (err) {
      // Never let a delta-classifier exception crash the audit pipeline.
      this.runtime.audit?.appendEvent?.('engagement_flow_delta_error', {
        kind,
        error: (err as Error)?.message ?? String(err),
      });
    }
  }

  /**
   * Try to extract the project id this mutation belongs to. Returns null
   * if the event isn't project-scoped (then the scope filter falls back
   * to looser matching). v1 inspects common field names; pack-declared
   * scope rules are a v2 surface.
   */
  private extractProjectFromMutation(
    kind: string,
    data: Record<string, unknown>,
  ): string | null {
    // Direct fields packs use today
    const candidates: Array<unknown> = [
      data.project,
      data.projectId,
      (data.scope as { ref?: unknown } | undefined)?.ref,
    ];
    for (const c of candidates) {
      if (typeof c === 'string' && c.length > 0) return c;
    }
    // For projects.* events, the entity ref itself is the project id
    if (kind.startsWith('projects.')) {
      const id = data.id ?? data.projectId;
      if (typeof id === 'string') return id;
    }
    return null;
  }

  /**
   * Map a mutation event to a rendered delta line. Returns null for
   * events that don't warrant a tail entry (already-handled fan-out,
   * informational-only events, etc.).
   */
  private classifyMutation(
    kind: string,
    data: Record<string, unknown>,
  ): { marker: 'Δ' | '+'; body: string } | null {
    // Tickets
    if (kind === 'tickets.filed') {
      const id = String(data.id ?? data.ticketId ?? '?');
      const title = truncate(String(data.title ?? ''), 60);
      return { marker: '+', body: `ticket.filed: ${id}${title ? ` "${title}"` : ''}` };
    }
    if (kind === 'tickets.updated') {
      const id = String(data.id ?? data.ticketId ?? '?');
      const patch = data.patch as Record<string, unknown> | undefined;
      const fields = patch ? Object.keys(patch).join(', ') : 'fields';
      return { marker: 'Δ', body: `ticket.${fields}[${id}]: updated` };
    }
    if (
      kind === 'tickets.resolved' || kind === 'tickets.closed' ||
      kind === 'tickets.wont-fix' || kind === 'tickets.reopened'
    ) {
      const id = String(data.id ?? data.ticketId ?? '?');
      const status = kind.slice('tickets.'.length);  // 'resolved' / 'closed' / 'wont-fix' / 'reopened'
      const newStatus = status === 'reopened' ? 'open' : status;
      return { marker: 'Δ', body: `ticket.status[${id}]: → ${newStatus}` };
    }
    // Decisions
    if (kind === 'decisions.opened') {
      const id = String(data.id ?? data.decisionId ?? '?');
      const question = truncate(String(data.question ?? ''), 60);
      return { marker: '+', body: `decision.opened: ${id}${question ? ` "${question}"` : ''}` };
    }
    if (
      kind === 'decisions.resolved' || kind === 'decisions.deferred' ||
      kind === 'decisions.dropped'
    ) {
      const id = String(data.id ?? data.decisionId ?? '?');
      const status = kind.slice('decisions.'.length);
      return { marker: 'Δ', body: `decision.status[${id}]: → ${status}` };
    }
    // Projects
    if (kind === 'projects.directionSet') {
      const id = String(data.id ?? data.projectId ?? '?');
      const direction = data.direction as { northStar?: unknown; target?: unknown } | undefined;
      const ns = direction?.northStar ? truncate(String(direction.northStar), 80) : null;
      return {
        marker: 'Δ',
        body: ns
          ? `project.direction.northStar[${id}]: → "${ns}"`
          : `project.direction[${id}]: updated`,
      };
    }
    if (kind === 'projects.charterDefinitionSet') {
      const id = String(data.id ?? data.projectId ?? '?');
      return { marker: 'Δ', body: `project.charter.definition[${id}]: updated` };
    }
    if (kind === 'projects.updated') {
      const id = String(data.id ?? data.projectId ?? '?');
      const patch = data.patch as Record<string, unknown> | undefined;
      const fields = patch ? Object.keys(patch).join(', ') : 'fields';
      return { marker: 'Δ', body: `project.${fields}[${id}]: updated` };
    }
    // Engagements (self-referential)
    if (kind === 'engagements.runtime-model-set') {
      const id = String(data.id ?? data.engagementId ?? '?');
      const model = truncate(String(data.modelRef ?? ''), 40);
      return { marker: 'Δ', body: `engagement.runtimeModel[${id}]: → ${model}` };
    }
    if (kind === 'engagements.runtime-model-cleared') {
      const id = String(data.id ?? data.engagementId ?? '?');
      return { marker: 'Δ', body: `engagement.runtimeModel[${id}]: cleared` };
    }
    if (kind === 'engagements.output-added') {
      const out = data.output as { kind?: string; ref?: string; label?: string } | undefined;
      if (!out) return null;
      const label = out.label ? ` "${truncate(out.label, 50)}"` : '';
      return { marker: '+', body: `engagement.output: ${out.kind}:${out.ref}${label}` };
    }
    return null;
  }

  /**
   * Does this engagement's snapshot scope include the mutation's project?
   * v1: project-scoped engagements match same-project mutations; other
   * scopes match nothing (until cross-project engagements ship in v1.5).
   *
   * Returns true also when projectRef is null AND engagement scope is
   * 'none' — both unbound; safe to include.
   */
  private engagementMatchesScope(
    engagement: { scope?: { kind?: string; ref?: string } },
    projectRef: string | null,
  ): boolean {
    const scope = engagement.scope;
    if (!scope) return false;
    if (scope.kind === 'project') {
      return !!projectRef && scope.ref === projectRef;
    }
    if (scope.kind === 'none') {
      return projectRef === null;
    }
    // Other scopes (tool, workspace, future portfolio) — v1 conservative skip.
    return false;
  }

  /** Append a delta to the per-engagement buffer with cap enforcement. */
  private bufferDelta(engagementId: string, entry: DeltaEntry): void {
    const list = this.deltasByEng.get(engagementId) ?? [];
    list.push(entry);
    // Cap by trimming the oldest — runaway mutation streams can't OOM.
    if (list.length > EngagementFlowSubsystem.DELTA_BUFFER_CAP) {
      list.splice(0, list.length - EngagementFlowSubsystem.DELTA_BUFFER_CAP);
    }
    this.deltasByEng.set(engagementId, list);
    this._dirty = true;
  }

  /**
   * Drain the per-engagement delta buffer, returning a rendered text
   * block of all accumulated entries (or null when empty). Called by
   * `assemblePriorChainPrefix` when stitching the chronological tail
   * for a user-initiated Turn. Deltas become part of the byte-stable
   * prior chain on the next Turn, so they aren't repeated.
   */
  private drainDeltas(engagementId: string): string | null {
    const list = this.deltasByEng.get(engagementId);
    if (!list || list.length === 0) return null;
    this.deltasByEng.delete(engagementId);
    this._dirty = true;
    // Sort by timestamp (defensive — events should arrive in order but
    // out-of-order is possible if multiple sources fire near-simultaneously).
    list.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
    const lines = list.map(d => `${d.marker} ${d.body} at ${d.at}`);
    return lines.join('\n');
  }

  /**
   * Snapshot of currently-buffered deltas across all engagements. Read-
   * only diagnostic — exposed via inspectScriptLoopState() in spirit
   * (the analogous "look at what's accumulated" surface).
   */
  inspectDeltaBuffers(): Record<string, { count: number; sample: DeltaEntry[] }> {
    const out: Record<string, { count: number; sample: DeltaEntry[] }> = {};
    for (const [engId, list] of this.deltasByEng) {
      out[engId] = {
        count: list.length,
        sample: list.slice(0, 5).map(d => ({ ...d })),
      };
    }
    return out;
  }

  /**
   * Compose the six-layer prefix from Decision 37 when the substrate's
   * `runtime.tagWalker` subsystem is present. Returns the rendered
   * prefix (without the user prompt or delimiter — caller appends those)
   * or `null` when the walker isn't available (substrate predates D37).
   *
   * Layers built here:
   *   1A — Blur intro (constant in prefix-composer)
   *   1B — Activity definition (from runtime.activities.get(activityId))
   *   1C — Entity catalog (from runtime.tagWalker.catalogText(surface))
   *   2  — Project + role (from runtime.projects.get + agent record)
   *   3  — State snapshot (formatPrepSnapshot of PrepData) + NOTE block
   *
   * Best-effort lookups: missing project / agent / activity each render
   * a [-] stub line; the prefix still composes. Cache stability rides
   * on the byte-identical output for the same inputs — every lookup is
   * deterministic given the durable runtime store.
   */
  private composeLayeredPrefixIfAvailable(
    engagementId: string,
    engagement: {
      id: string;
      activityId?: string;
      scope?: { kind?: string; ref?: string };
      preferredAgentId?: string;
      boundAgentIds?: string[];
    },
    prepData: PrepData | null,
  ): string | null {
    const runtime = this.runtime as RuntimeShape & {
      tagWalker?: {
        catalogText: (surface?: { include?: '*' | string[]; exclude?: string[] }) => string;
        entityList: (surface?: unknown) => unknown[];
      };
    };
    if (!runtime.tagWalker || typeof runtime.tagWalker.catalogText !== 'function') {
      return null;
    }

    // Look up Activity by id. Activities pack exposes runtime.activities.get.
    let activity: {
      id: string;
      label?: string;
      purpose?: string;
      responsibilities?: string;
      objective?: string;
      exitCriteria?: string;
      aiInstructions?: string;
      surface?: { include?: '*' | string[]; exclude?: string[] };
    } | null = null;
    try {
      const activitiesExt = runtime.extensions?.get?.('activities') as
        | { get?: (id: string) => unknown }
        | undefined;
      if (activitiesExt?.get && engagement.activityId) {
        const got = activitiesExt.get.call(activitiesExt, engagement.activityId);
        if (got && typeof got === 'object') activity = got as unknown as typeof activity;
      }
    } catch {
      /* swallow — best-effort */
    }

    // Look up Project when engagement.scope.kind === 'project'.
    let project: {
      id: string;
      label?: string;
      direction?: { northStar?: string; target?: string };
    } | null = null;
    if (engagement.scope?.kind === 'project' && engagement.scope.ref) {
      try {
        const projectsExt = runtime.extensions?.get?.('projects') as
          | { get?: (id: string) => unknown }
          | undefined;
        if (projectsExt?.get) {
          const got = projectsExt.get.call(projectsExt, engagement.scope.ref);
          if (got && typeof got === 'object') project = got as unknown as typeof project;
        }
      } catch {
        /* swallow */
      }
    }

    // Look up Agent — preferred bound agent, fall back to first bound.
    let agent: { id: string; role?: string; roleDoc?: string } | null = null;
    const agentId = engagement.preferredAgentId ?? engagement.boundAgentIds?.[0];
    if (agentId && this.agentsRef) {
      try {
        const got = this.agentsRef.get?.(agentId);
        if (got && typeof got === 'object') agent = got as unknown as typeof agent;
      } catch {
        /* swallow */
      }
    }

    // Render the snapshot from PrepData (when available).
    const snapshotText = prepData
      ? formatPrepSnapshot(engagementId, prepData)
      : null;

    return composePrefix({
      runtime: this.runtime,
      engagement,
      activity,
      project,
      agent,
      snapshotText,
      snapshotAt: prepData?.assembledAt,
    });
  }

  /**
   * Rebuild the `turnToEngagement` index from the durable engagement
   * store. The index maps `turnId → engagementId` for O(1) lookup when
   * `agents.turn.completed` audits arrive — there's no
   * `turn.engagementId` field on the Turn record, so without this
   * index we'd have to iterate all engagements per Turn.
   *
   * Pack reloads drop this in-memory map; on start() we rebuild from
   * `engagements.list({status:'active'})`. Live audits
   * (`engagements.turn-added`) keep it current after that.
   *
   * Notes:
   *   - "Active" engagement state is NOT cached separately —
   *     `engagement.status === 'active'` is checked on demand in the
   *     script-loop handler. Single source of truth, no rehydration
   *     ceremony, no drift.
   *   - Uses the in-process extension shim (`resolveEngagements`)
   *     rather than the script-side `runtime.engagements.*` surface —
   *     subsystem code runs in-host, not via the script isolate.
   */
  private async rehydrateScriptLoopState(): Promise<void> {
    try {
      const api = this.resolveEngagements() as
        | {
            list?: (opts: { status?: string | string[]; limit?: number }) => unknown;
          }
        | null;
      if (!api?.list) return;
      const raw = await Promise.resolve(api.list({ status: 'active', limit: 500 }));
      const active = (Array.isArray(raw) ? raw : []) as Array<{
        id: string;
        turnIds?: string[];
      }>;
      for (const e of active) {
        if (!e?.id) continue;
        for (const tid of e.turnIds ?? []) {
          this.turnToEngagement.set(tid, e.id);
        }
      }
    } catch {
      /* swallow — rehydration is best-effort; missing entries will be
         picked up by the next live `engagements.turn-added` audit */
    }
  }

  stop(): void {
    for (const u of this.unsubs) {
      try {
        u();
      } catch {
        /* swallow */
      }
    }
    this.unsubs = [];
  }

  // ===================================================================
  // Read surface
  // ===================================================================

  getPrepData(engagementId: string): PrepData | null {
    const v = this.prepDataByEng.get(engagementId);
    return v ? clonePrepData(v) : null;
  }

  listPrepData(): Array<{ engagementId: string; prepData: PrepData }> {
    return Array.from(this.prepDataByEng.entries()).map(([engagementId, prepData]) => ({
      engagementId,
      prepData: clonePrepData(prepData),
    }));
  }

  /**
   * Diagnostic — outputs accumulated during an Engagement window
   * before the linker emits `linker-complete`. Exposed for the smoke
   * test; in production the linker is the consumer.
   */
  listAccumulatedOutputs(engagementId: string): LinkedOutput[] {
    return (this.outputsByEng.get(engagementId) ?? []).map(cloneLinkedOutput);
  }

  /**
   * Diagnostic — recent audit events the subsystem has emitted. Lets
   * the smoke test verify the contract without subscribing to audit
   * (script isolates can't pass handler closures across the primitive
   * boundary). Capped at EMISSIONS_LOG_CAP entries; oldest dropped.
   *
   * Optional filter: `kind` exact-matches the event kind; `engagementId`
   * matches `data.engagementId` when present.
   */
  recentEmissions(opts: { kind?: string; engagementId?: string; limit?: number } = {}): Array<{
    kind: string;
    ref?: string;
    data?: Record<string, unknown>;
    at: string;
  }> {
    const limit = typeof opts.limit === 'number' ? opts.limit : EngagementFlowSubsystem.EMISSIONS_LOG_CAP;
    let list = this.emissionsLog.slice();
    if (opts.kind) list = list.filter(e => e.kind === opts.kind);
    if (opts.engagementId) {
      list = list.filter(e => e.data && (e.data as { engagementId?: unknown }).engagementId === opts.engagementId);
    }
    return list.slice(-limit);
  }

  /** Diagnostic — emission counts by kind since pack install. */
  emissionStats(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [kind, n] of this.emissionCounts.entries()) out[kind] = n;
    return out;
  }

  // ===================================================================
  // Triggering — manual entry points (used by the smoke test and any
  // host code that wants to bypass the audit subscription)
  // ===================================================================

  /**
   * Run the Secretary auto-prep pipeline for a given engagement. Idempotent
   * on engagementId — if prep already ran, returns the existing PrepData
   * without re-emitting events.
   */
  async runSecretaryPrep(engagementId: string): Promise<PrepData> {
    const cached = this.prepDataByEng.get(engagementId);
    if (cached) return clonePrepData(cached);

    const engagement = await this.resolveEngagement(engagementId);
    if (!engagement) {
      throw new Error(`engagementFlow.runSecretaryPrep: unknown engagement '${engagementId}'`);
    }

    const steps = this.opts.prepSteps;
    const startedAt = new Date().toISOString();
    this.emit('engagements.secretary.prep-started', `item:engagements[${engagementId}]`, {
      engagementId,
      steps: steps.map(s => ({ key: s.key, label: s.label })),
      at: startedAt,
    });

    const projectId = pickProjectId(engagement);
    const partial: Partial<PrepData> = { assembledAt: startedAt };

    // Step 1 — gather-project-state
    await this.runPrepStep(engagementId, steps, 0, async () => {
      partial.project = await this.assembleProjectSummary(projectId);
    });

    // Step 2 — gather-tracks (folded into projectHierarchy)
    await this.runPrepStep(engagementId, steps, 1, async () => {
      partial.projectHierarchy = await this.assembleProjectHierarchy(projectId);
    });

    // Step 3 — gather-recent-engagements (no-op v1 — scaffolded for future)
    await this.runPrepStep(engagementId, steps, 2, async () => {
      // intentional v1 stub: SA doc lists recent-engagements as a step;
      // assembling them is out-of-scope for v1 and tracked as a retro item.
    });

    // Step 4 — assemble-json
    await this.runPrepStep(engagementId, steps, 3, async () => {
      partial.agent = this.assembleAgentSummary(engagement);
      partial.runtime = await this.assembleRuntimeSummary();
    });

    // Step 5 — register-with-engagement
    await this.runPrepStep(engagementId, steps, 4, async () => {
      // Persist in-subsystem; engagement.metadata is not writable from
      // here (no `engagements.setMetadata` primitive exists), so the
      // hot session reads via `runtime.engagementFlow.getPrepData(...)`.
    });

    const prepData: PrepData = {
      project: partial.project ?? emptyProjectSummary(projectId),
      agent: partial.agent ?? emptyAgentSummary(),
      runtime: partial.runtime ?? { version: 'unknown', packsLoaded: [] },
      projectHierarchy: partial.projectHierarchy ?? null,
      assembledAt: startedAt,
    };
    this.prepDataByEng.set(engagementId, prepData);
    this._dirty = true;

    this.emit('engagements.secretary.prep-complete', `item:engagements[${engagementId}]`, {
      engagementId,
      prepDataRef: prepDataRefFor(engagementId),
      at: new Date().toISOString(),
    });

    return clonePrepData(prepData);
  }

  /**
   * Run the Scheduler auto-lease for an engagement. Idempotent only via
   * external coordination — callers should not invoke twice for the
   * same engagementId. Emits `lease-started` and `session-ready`.
   *
   * Pass `{ mock: true }` to skip the pool and produce a synthetic
   * `mock` session — used by the smoke test (and any host code that
   * needs a deterministic, pool-free lease).
   */
  async runSchedulerLease(
    engagementId: string,
    opts: { mock?: boolean } = {},
  ): Promise<{ sessionId: string; providerKind: string; agentId: string }> {
    const engagement = await this.resolveEngagement(engagementId);
    if (!engagement) {
      throw new Error(`engagementFlow.runSchedulerLease: unknown engagement '${engagementId}'`);
    }

    this.emit('engagements.scheduler.lease-started', `item:engagements[${engagementId}]`, {
      engagementId,
      at: new Date().toISOString(),
    });

    let sessionId: string;
    let providerKind: string;
    let agentId: string;

    const agents = this.agentsRef;
    const useMock = opts.mock === true || this.opts.mockLease || !agents;
    if (useMock) {
      // Mock-lease: still mint a REAL Agent record (so subsequent
      // dispatchTurn / sendMessage calls can find it via agents.get).
      // Provider is the 'mock' kind seeded at install — it returns
      // scripted replies without hitting the bridge.
      const sid = `mock-sess_${engagementId}`;
      const projectId = pickProjectId(engagement);
      const bindings = projectId
        ? [{ scope: 'project' as const, ref: projectId }]
        : [{ scope: 'runtime' as const, ref: 'global' }];
      if (!agents) {
        // Fall back to fabricated ids if no agents subsystem at all
        // (defensive — should never happen post-install).
        sessionId = sid;
        providerKind = 'mock';
        agentId = `mock-agent_${engagementId}`;
      } else {
        const agent = await agents.lease({
          role: pickLeaseRole(engagement, this.opts.defaultLeaseRole),
          label: `mock auto-lease for ${engagementId}`,
          bindings,
          leasedFrom: 'manual',
          sessionId: sid,
          // `provider` is an internal LeaseOpts field — passed through to
          // the Agent record verbatim, bypassing synthesizeProvider (which
          // would default to 'bridge' kind given a non-null sessionId).
          provider: { kind: 'mock', sessionId: sid },
          by: 'engagementFlow.auto-lease(mock)',
        } as Parameters<typeof agents.lease>[0]);
        sessionId = sid;
        providerKind = 'mock';
        agentId = agent.id;
      }
    } else {
      const role = pickLeaseRole(engagement, this.opts.defaultLeaseRole);
      const projectId = pickProjectId(engagement);
      const bindings = projectId
        ? [{ scope: 'project' as const, ref: projectId }]
        : [{ scope: 'runtime' as const, ref: 'global' }];

      // Consult the routing chain (same resolver scheduler.requestTurn uses)
      // BEFORE deciding how to lease. The resolver walks
      //   opts.pin → opts.activityTable → engagement.runtimeModel
      //     → runtime.activityRouting → baseline
      // For non-bridge providers we mint an Agent directly via
      // leasedFrom='manual' with a provider hint, skipping the Claude
      // pool (which has no meaning for stateless HTTP providers like
      // local Ollama or together).
      //
      // The Config Tables (system Activity Table + Model Table) are read
      // from this.schedulerRef when wired. When not yet wired (substrate
      // boot before pack install / table reload), resolveDispatch falls
      // through to the engagement.runtimeModel layer — sufficient for
      // engagements that have a per-engagement pin set.
      const resolved = resolveDispatch({
        opts: {},
        engagement: {
          activityId: (engagement as { activityId?: string }).activityId ?? 'unknown',
          runtimeModel: (engagement as { runtimeModel?: string }).runtimeModel,
        },
        systemActivityTable: null,
        modelTable: null,
      });

      // Provider routing: bridge keeps pool semantics; everything else
      // (local / together / mock / future stateless) leases manually
      // with the resolved provider hint.
      const resolvedKind = resolved.providerKind;
      // For non-table-resolved cases, derive providerModelId from the
      // modelRef tail. ModelTable lookup is the canonical path once
      // tables are live; this is the fallback during the rollout.
      const inferredModelId =
        resolved.providerModelId
        ?? (resolved.modelRef.includes('/')
          ? resolved.modelRef.slice(resolved.modelRef.indexOf('/') + 1)
          : null);

      try {
        if (resolvedKind === 'bridge' || resolvedKind === 'unknown') {
          // Existing pool path — Claude session pool semantics.
          const agent = await agents.lease({
            role,
            label: `auto-lease for ${engagementId}`,
            bindings,
            leasedFrom: 'pool',
            by: 'engagementFlow.auto-lease',
          });
          sessionId = (agent.sessionId as string | undefined) ?? `unknown-sess_${engagementId}`;
          providerKind = (agent.provider as { kind?: string } | undefined)?.kind ?? 'unknown';
          agentId = agent.id;
        } else {
          // Stateless-provider path — no pool. Mint an Agent record
          // directly with the resolved provider info. Works for
          // local / together / mock and any future HTTP-stateless
          // provider that registers via Decision 29's ProviderRegistry.
          const sid = `${resolvedKind}-sess_${engagementId}`;
          const agent = await agents.lease({
            role,
            label: `auto-lease (${resolvedKind}) for ${engagementId} → ${resolved.modelRef}`,
            bindings,
            leasedFrom: 'manual',
            sessionId: sid,
            provider: {
              kind: resolvedKind,
              model: inferredModelId ?? undefined,
            } as { kind: string; model?: string; sessionId?: string },
            by: `engagementFlow.auto-lease (routing: ${resolved.source})`,
          } as Parameters<typeof agents.lease>[0]);
          sessionId = sid;
          providerKind = resolvedKind;
          agentId = agent.id;
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        this.emit('engagements.scheduler.lease-failed', `item:engagements[${engagementId}]`, {
          engagementId,
          error: message,
          resolution: {
            modelRef: resolved.modelRef,
            providerKind: resolved.providerKind,
            source: resolved.source,
          },
          at: new Date().toISOString(),
        });
        throw err;
      }
    }

    // Bind the leased agent to the engagement so callers can pick it
    // up via `engagements.get(id).boundAgentIds[0]`. Without this, the
    // UI has to lease + bind by hand, defeating auto-lease. Idempotent
    // on (engagementId, agentId).
    try {
      const engagementsApi = this.resolveEngagements() as
        | { bindAgent?: (engId: string, agtId: string) => unknown }
        | null;
      // IMPORTANT: must invoke as a METHOD so `this` is bound to the
      // EngagementsSubsystem instance. Destructuring loses the bind
      // (instance methods reference internal state via `this`).
      if (engagementsApi && typeof engagementsApi.bindAgent === 'function') {
        engagementsApi.bindAgent(engagementId, agentId);
      }
    } catch {
      /* swallow — non-fatal; session-ready still fires */
    }

    this.emit('engagements.scheduler.session-ready', `item:engagements[${engagementId}]`, {
      engagementId,
      sessionId,
      providerKind,
      agentId,
      at: new Date().toISOString(),
    });

    return { sessionId, providerKind, agentId };
  }

  /**
   * One-call dispatch façade for a Turn on an Engagement. UI calls this
   * instead of the 3-step pattern (sendMessage + addTurn + manual map).
   *
   * Behavior:
   *   1. Resolve the agent — `opts.agentId` wins; else
   *      `engagement.preferredAgentId`; else `engagement.boundAgentIds[0]`.
   *   2. Splice the assembled PrepData blob into the prompt on **every**
   *      Turn whose engagement has prep data. The preamble is rendered
   *      as a pure function of PrepData (no timestamps, deterministic
   *      ordering) so the static prefix is byte-identical across
   *      Turns — which lets local llama.cpp KV caches reuse the
   *      preamble's attention state on Turn #2+. Stateful providers
   *      (bridge) absorb the duplicate cheaply or mark it cacheable
   *      via their own prompt-cache markers.
   *      See `runtime.library.get('blur-inference-paradigm')` §11.
   *   3. `agents.sendMessage(agentId, { text, by })` — opens the Turn
   *      as a side-effect of dispatch.
   *   4. `engagements.addTurn({ engagementId, turnId })` — links the
   *      Turn to the Engagement record (emits `engagements.turn-added`).
   *   5. Emit `engagements.turn-queued` per SA-Engagement-Flow.md with
   *      `{ engagementId, turnId, prompt, at, by }`.
   *
   * Returns `{ turnId, replyHandle }`; caller polls via
   * `runtime.agents.getReply(replyHandle, { sinceOffset, wait: 'long-poll' })`
   * or subscribes (host-side only) to `agents.reply.chunk` /
   * `agents.turn.completed` audit events.
   *
   * v1: engagement-scoped lease (bound agent, no per-Turn ticket).
   * v2: Stage 3 will refactor this to call `scheduler.requestTurn(...)`
   *     and thread a `ticketId` through `agents.sendMessage`. The UI
   *     contract (this signature + return shape) does NOT change.
   */
  async dispatchTurn(
    engagementId: string,
    opts: {
      text: string;
      by?: string;
      agentId?: string;
      outcome?: string;
      // ---------------------------------------------------------------
      // Decision 36 step 1 — routing-override pass-through (recorded
      // only; no behavior change in v0). Forwarded verbatim to
      // scheduler.requestTurn which stamps them onto ticket.requestOverrides.
      // ---------------------------------------------------------------
      pin?: string;
      activityTable?: Record<string, {
        mode: 'always' | 'auto' | 'ai';
        default: string | null;
        outcomes?: Record<string, string>;
      }>;
      complexity?: 'routine' | 'specialized';
      /**
       * Script-loop continuation flag (state-advancement-loop §1). When
       * true, `opts.text` is already a fully-assembled prompt (prior
       * iteration's prefix + assistant reply + tag results) and should
       * be dispatched verbatim — no prep-preamble splice. Set by the
       * `onTurnCompletedForScriptLoop` handler when continuing a chain.
       */
      skipPrepSplice?: boolean;
    } = { text: '' },
  ): Promise<{
    turnId: string;
    replyHandle: string;
    agentId: string;
    ticketId?: string;
    promptLen: number;
    prepSpliced: boolean;
  }> {
    if (!opts || typeof opts.text !== 'string' || !opts.text.length) {
      throw new Error('engagementFlow.dispatchTurn: opts.text is required (non-empty string)');
    }
    if (!this.agentsRef) {
      throw new Error(
        'engagementFlow.dispatchTurn: AgentsSubsystem not wired. Pack install must set engagementFlow.agentsRef = agents.',
      );
    }

    const engagement = (await this.resolveEngagement(engagementId)) as
      | { id: string; turnIds?: string[]; preferredAgentId?: string; boundAgentIds?: string[] }
      | null;
    if (!engagement) {
      throw new Error(`engagementFlow.dispatchTurn: unknown engagement '${engagementId}'`);
    }

    // PrepData splice on EVERY Turn (not just Turn #1).
    //
    // The original gate (`isFirstTurn`) was designed for stateful
    // providers like Claude/bridge, where prior context lives in the
    // bridge session and re-sending it would be a paid duplicate.
    // For stateless local providers (Ollama, vLLM) it is **actively
    // harmful**: Turn #1 warms llama.cpp's KV cache for the prep
    // preamble; Turn #2 sends a different prefix (just the raw user
    // text) → cache miss → full re-tokenization on every subsequent
    // Turn.
    //
    // The fix is the opposite of the old gate: send the same
    // byte-identical preamble at the top of every dispatch.
    // `formatPrepPreamble` is now a pure function of PrepData, so the
    // serialized block is byte-stable across Turns (no timestamps).
    // Stateful providers (bridge) absorb the duplicate cheaply; their
    // own per-provider cache markers (prompt-cache-2024-09 etc.) can
    // mark the static block as cacheable if needed. Stateless local
    // providers get the warm-cache TTFT win.
    //
    // See `runtime.library.get('blur-inference-paradigm')` §11.
    // ---- Prompt assembly --------------------------------------------------
    //
    // Three paths:
    //
    // (1) Script-loop continuation (skipPrepSplice=true) — opts.text is
    //     already a fully-assembled follow-up the subscriber built. Pass
    //     through verbatim; no preamble, no history append.
    //
    // (2) User-initiated dispatch on an Activity that opted into history
    //     append (HISTORY_APPEND_ACTIVITIES). Stitch the prior Turn chain
    //     into the prefix so the model sees the full conversation. The
    //     prior chain already contains the preamble at its top, so we
    //     skip the preamble splice too.
    //
    // (3) User-initiated dispatch with no history (default Activities, or
    //     the first prompt on a history-enabled Activity). Splice the
    //     prep preamble at the top and append the user prompt. This is
    //     the original v1 behavior.
    //
    // See state-advancement-loop §11 v1 scope table for how this composes
    // with the cache discipline from blur-inference-paradigm §11.
    let finalText: string;
    let prepSplicedThisTurn: boolean;

    if (opts.skipPrepSplice) {
      // Path 1 — script-loop continuation. opts.text is the full follow-up.
      finalText = opts.text;
      prepSplicedThisTurn = false;
    } else {
      const history = await this.assemblePriorChainPrefix(engagementId);
      if (history) {
        // Path 2 — history-append for opted-in Activity. Prior chain ends
        // with the assistant's final reply; we append a delimiter + the
        // new user text. The prior chain already has the preamble at the
        // top → byte-stable across the engagement's lifetime → KV cache
        // hits the entire prior conversation on this dispatch.
        finalText = history + '\n\n──\n\n' + opts.text;
        prepSplicedThisTurn = false;
      } else {
        // Path 3 — fresh user prompt, no history (first prompt OR Activity
        // didn't opt in).
        //
        // Decision 37: when the substrate exposes runtime.tagWalker, build
        // the six-layer prefix (Blur intro → Activity definition → entity
        // catalog → project/role → snapshot + NOTE). Falls back to the
        // legacy formatPrepPreamble otherwise (substrate predates D37).
        const prepData = this.prepDataByEng.get(engagementId) ?? null;
        const layered = this.composeLayeredPrefixIfAvailable(
          engagementId,
          engagement as { id: string; activityId?: string; scope?: { kind?: string; ref?: string }; preferredAgentId?: string; boundAgentIds?: string[] },
          prepData,
        );
        if (layered !== null) {
          finalText = layered + '\n\n──\n\n' + opts.text;
          prepSplicedThisTurn = true;
        } else {
          finalText =
            prepData !== null
              ? formatPrepPreamble(engagementId, prepData) + '\n\n──\n\n' + opts.text
              : opts.text;
          prepSplicedThisTurn = prepData !== null;
        }
      }
    }

    // Remember the assembled prompt so the script-loop subscriber can
    // append iteration results to it without re-rendering the prefix.
    this.lastDispatchedPromptByEng.set(engagementId, finalText);

    // Decision 34 — route through scheduler.requestTurn when wired so
    // we get ticket-based dispatch. Falls back to direct sendMessage
    // when the scheduler ref isn't set (defensive, mostly for unit
    // tests of this subsystem in isolation).
    let turnId: string;
    let replyHandle: string;
    let agentId: string;
    let ticketId: string | undefined;

    if (this.schedulerRef) {
      const issued = await this.schedulerRef.requestTurn({
        engagementId,
        prompt: finalText,
        preferredAgentId: opts.agentId,
        outcome: opts.outcome,
        by: opts.by ?? 'engagementFlow.dispatchTurn',
        // Decision 36 step 1 — forward routing overrides untouched.
        // requestTurn stamps them onto ticket.requestOverrides + emits
        // them in the ticket-issued audit payload. v0 routing unchanged.
        ...(opts.pin !== undefined ? { pin: opts.pin } : {}),
        ...(opts.activityTable !== undefined ? { activityTable: opts.activityTable } : {}),
        ...(opts.complexity !== undefined ? { complexity: opts.complexity } : {}),
      });
      turnId = issued.turnId;
      replyHandle = issued.replyHandle;
      agentId = issued.agentId;
      ticketId = issued.ticketId;
    } else {
      const fallbackAgentId =
        opts.agentId ?? engagement.preferredAgentId ?? engagement.boundAgentIds?.[0] ?? null;
      if (!fallbackAgentId) {
        throw new Error(
          `engagementFlow.dispatchTurn: no agent bound to engagement '${engagementId}' ` +
            'and no schedulerRef wired. Run runSchedulerLease first or supply opts.agentId.',
        );
      }
      const sent = await this.agentsRef.sendMessage(fallbackAgentId, {
        text: finalText,
        by: opts.by ?? 'engagementFlow.dispatchTurn',
      });
      turnId = sent.turnId ?? `tur_unstamped_${Date.now()}`;
      replyHandle = sent.replyHandle;
      agentId = fallbackAgentId;
      ticketId = undefined;
    }

    // Link the Turn to the Engagement (emits engagements.turn-added).
    try {
      const engagementsApi = this.resolveEngagements() as
        | { addTurn?: (o: { engagementId: string; turnId: string }) => unknown }
        | null;
      if (engagementsApi && typeof engagementsApi.addTurn === 'function') {
        engagementsApi.addTurn({ engagementId, turnId });
      }
    } catch {
      /* swallow — non-fatal; the Turn still exists in the agents subsystem */
    }

    this.emit('engagements.turn-queued', `item:engagements[${engagementId}]`, {
      engagementId,
      turnId,
      ticketId,
      prompt: opts.text, // RAW user text, NOT the prep-spliced full prompt
      outcome: opts.outcome,
      at: new Date().toISOString(),
      by: opts.by,
    });

    return {
      turnId,
      replyHandle,
      agentId,
      ticketId,
      promptLen: finalText.length,
      prepSpliced: prepSplicedThisTurn,
    };
  }

  // ===========================================================================
  // Script-loop subscriber — state-advancement-loop §1, §3
  // ===========================================================================

  /**
   * Fired by `audit.subscribe('agents.turn.completed', …)`. Inspects the
   * Turn's `assembledText` for `<b:s>` tags; if any are present, executes
   * them via `runtime.script.run`, appends the results as `<b:s-result>`
   * blocks, and dispatches a follow-up Turn (with prep splice suppressed
   * because the prep is already in the accumulated prompt).
   *
   * No-op when:
   *   - the Turn isn't associated with a tracked engagement
   *   - the model's reply is script-free (loop terminates naturally)
   *   - the iteration cap is reached (emits `turns.iteration-cap-reached`)
   *   - `runtime.script.run` is not available on the host
   *
   * Per-engagement iteration count tracked in `scriptLoopIterations`; reset
   * when a script-free reply lands.
   */
  private async onTurnCompletedForScriptLoop(event: SemanticEventLike): Promise<void> {
    let recordedTurnId: string | null = null;
    let recordedEngagementId: string | null = null;
    try {
      const data = event.data as { turnId?: string } | undefined;
      const turnId = data?.turnId;
      if (!turnId) return;
      recordedTurnId = turnId;

      const engagementId = this.turnToEngagement.get(turnId);
      if (!engagementId) return;
      recordedEngagementId = engagementId;

      // "Live" is just `engagement.status === 'active'` — querying the
      // durable store on demand is the single source of truth. Avoids
      // a redundant in-memory Set that drifts on pack reload and forces
      // rehydration ceremony.
      const liveCheck = (await this.resolveEngagement(engagementId)) as
        | { status?: string }
        | null;
      if (!liveCheck || liveCheck.status !== 'active') return;

      // Fetch the Turn record to read assembledText + timing fields.
      const turn = await this.fetchTurn(turnId);
      if (!turn) return;
      const replyText = typeof turn.assembledText === 'string' ? turn.assembledText : '';

      // Parse tags first so we can record stats whether or not we execute.
      const tags = replyText ? parseBTags(replyText) : [];

      // Determine iteration index — read BEFORE the cap check / decrement so
      // we record stats for this Turn even when the cap is hit.
      const priorIter = this.scriptLoopIterations.get(engagementId) ?? 0;
      const iter = priorIter + 1;
      const loopRole: TurnStats['loopRole'] = priorIter > 0 ? 'script-loop' : 'user-initiated';

      // Stats scaffold — populated as we go. Stored at the end whether or not
      // tags fire so every Turn has a record. Wall-clock comes from Turn record.
      const startedAt = typeof turn.startedAt === 'string' ? turn.startedAt : '';
      const endedAt = typeof turn.endedAt === 'string' ? turn.endedAt : '';
      const durationMs =
        startedAt && endedAt ? Math.max(0, Date.parse(endedAt) - Date.parse(startedAt)) : 0;
      const stats: TurnStats = {
        turnId,
        engagementId,
        iter,
        loopRole,
        startedAt,
        endedAt,
        durationMs,
        prefixLen: typeof turn.request?.text === 'string' ? turn.request.text.length : 0,
        replyLen: replyText.length,
        tagCount: tags.length,
        scriptExecMs: 0,
        scriptResultBytes: 0,
        providerKind: turn.providerKind,
        agentId: turn.agentId,
        terminationReason: 'script-free', // updated below
      };

      // No tags → chain terminates naturally. Record stats + bail.
      if (tags.length === 0) {
        this.scriptLoopIterations.delete(engagementId);
        stats.terminationReason = 'script-free';
        this.recordTurnStats(stats);
        return;
      }

      // Cap enforcement.
      if (iter > EngagementFlowSubsystem.SCRIPT_LOOP_CAP) {
        this.scriptLoopIterations.delete(engagementId);
        stats.terminationReason = 'cap-reached';
        this.recordTurnStats(stats);
        this.emit('turns.iteration-cap-reached', `item:engagements[${engagementId}]`, {
          engagementId,
          turnId,
          iter,
          cap: EngagementFlowSubsystem.SCRIPT_LOOP_CAP,
          at: new Date().toISOString(),
        });
        return;
      }
      this.scriptLoopIterations.set(engagementId, iter);

      // Locate the script runner for `<b:s>` tags. `<b:p>` doesn't need
      // it (host-side resolver bypasses the script isolate). Only bail
      // per-tag if `<b:s>` appears and the runner is missing.
      const scriptRunner = (this.runtime as unknown as {
        script?: { run?: (src: string) => Promise<{ value?: unknown; ok?: boolean; error?: string }> };
      }).script?.run;

      this.emit('turns.iteration-started', `item:engagements[${engagementId}]`, {
        engagementId,
        turnId,
        iter,
        tagCount: tags.length,
        at: new Date().toISOString(),
      });

      // Execute each tag in source order; accumulate timing + size into stats.
      // Dispatch on tag.kind:
      //   b:s / b:script — runtime.script.run(body) (full expressivity, escape hatch)
      //   b:p            — resolveBPTag (legacy property-read shape)
      //   b:<word>       — resolveGenericTag via walker resolver map (Decision 37)
      const resultBlocks: string[] = [];
      for (const tag of tags) {
        const t0 = Date.now();
        try {
          let r: { ok?: boolean; value?: unknown; error?: string };
          if (tag.kind === 'b:script' || tag.kind === 'b:s') {
            // Script escape hatch.
            if (typeof scriptRunner === 'function') {
              r = await scriptRunner(tag.body);
            } else {
              r = { ok: false, error: 'runtime.script.run unavailable on host' };
            }
          } else if (tag.kind === 'b:p') {
            // Legacy property-read tag (Decision 37 says deprecated but
            // keep functional during migration; the catalog won't teach
            // it on new engagements).
            r = await this.resolveBPTag(tag);
          } else {
            // Decision 37 — kind-first descriptive tag. Look up in walker
            // resolver map and dispatch by action attribute.
            r = await this.resolveGenericTag(tag);
          }
          const execMs = Date.now() - t0;
          stats.scriptExecMs += execMs;
          if (r && r.ok === false) {
            const msg = r.error ?? `${tag.kind} run failed`;
            const block = renderTagResult(tag, 'error', msg);
            resultBlocks.push(block);
            this.emit('turns.tag-executed', `item:turns[${turnId}]`, {
              turnId, engagementId, position: tag.position, kind: tag.kind,
              status: 'error', error: msg, execMs, at: new Date().toISOString(),
            });
          } else {
            const body = stringifyScriptReturn(r?.value);
            stats.scriptResultBytes += body.length;
            const block = renderTagResult(tag, 'ok', body);
            resultBlocks.push(block);
            this.emit('turns.tag-executed', `item:turns[${turnId}]`, {
              turnId, engagementId, position: tag.position, kind: tag.kind,
              status: 'ok', resultLen: body.length, execMs, at: new Date().toISOString(),
            });
          }
        } catch (err) {
          const execMs = Date.now() - t0;
          stats.scriptExecMs += execMs;
          const msg = (err as Error)?.message ?? String(err);
          resultBlocks.push(renderTagResult(tag, 'error', msg));
          this.emit('turns.tag-executed', `item:turns[${turnId}]`, {
            turnId, engagementId, position: tag.position, kind: tag.kind,
            status: 'error', error: msg, execMs, at: new Date().toISOString(),
          });
        }
      }

      stats.terminationReason = 'has-tags';
      this.recordTurnStats(stats);

      // Build the follow-up prompt — append-only per state-advancement-loop §9
      //   <prior dispatched prompt>
      //   <model assistant reply with tags>
      //   <b:s-result blocks>
      //
      // The follow-up is dispatched with skipPrepSplice=true so the prep
      // preamble (already at the top of the prior prompt) isn't duplicated.
      const priorPrompt = this.lastDispatchedPromptByEng.get(engagementId) ?? '';
      const followUp =
        priorPrompt +
        '\n\n' + replyText +
        '\n\n' + resultBlocks.join('\n\n');

      await this.dispatchTurn(engagementId, {
        text: followUp,
        by: 'script-loop',
        skipPrepSplice: true,
      });

      this.emit('turns.iteration-completed', `item:engagements[${engagementId}]`, {
        engagementId,
        turnId,
        iter,
        tagCount: tags.length,
        scriptExecMs: stats.scriptExecMs,
        scriptResultBytes: stats.scriptResultBytes,
        durationMs: stats.durationMs,
        at: new Date().toISOString(),
      });
    } catch (err) {
      // Swallow — script-loop must not crash the audit subscriber.
      // Visible via the recentEmissions log if needed.
      const msg = (err as Error)?.message ?? String(err);
      this.emit('turns.iteration-completed', 'item:engagements[?]', {
        turnId: recordedTurnId ?? undefined,
        engagementId: recordedEngagementId ?? undefined,
        error: msg,
        at: new Date().toISOString(),
      });
    }
  }

  /**
   * Insert/replace a TurnStats record. Evicts oldest when the global cap
   * is reached (FIFO across all engagements).
   */
  private recordTurnStats(stats: TurnStats): void {
    if (!this.turnStats.has(stats.turnId)) {
      this.turnStatsOrder.push(stats.turnId);
    }
    this.turnStats.set(stats.turnId, stats);
    while (this.turnStatsOrder.length > EngagementFlowSubsystem.TURN_STATS_CAP) {
      const evict = this.turnStatsOrder.shift();
      if (evict) this.turnStats.delete(evict);
    }
  }

  /**
   * Read the in-memory TurnStats record for a specific Turn. Returns null
   * when the Turn hasn't completed yet or the entry was evicted.
   */
  getTurnStats(turnId: string): TurnStats | null {
    return this.turnStats.get(turnId) ?? null;
  }

  /**
   * Diagnostic primitive exposing the script-loop's in-memory state.
   * Helps debug "why isn't the loop firing for this Turn?" by surfacing
   * the maps the subscriber consults. Read-only.
   */
  inspectScriptLoopState(): {
    iterationCounts: Record<string, number>;
    turnToEngagementSize: number;
    turnToEngagementSample: Array<{ turnId: string; engagementId: string }>;
    historyAppendActivities: string[];
  } {
    return {
      iterationCounts: Object.fromEntries(this.scriptLoopIterations),
      turnToEngagementSize: this.turnToEngagement.size,
      turnToEngagementSample: [...this.turnToEngagement.entries()]
        .slice(-10)
        .map(([turnId, engagementId]) => ({ turnId, engagementId })),
      historyAppendActivities: [...EngagementFlowSubsystem.HISTORY_APPEND_ACTIVITIES],
    };
  }

  /**
   * Aggregate the in-memory TurnStats for an engagement. Returns recent-
   * first ordering, capped by `opts.limit` (default 50).
   */
  getEngagementStats(engagementId: string, opts?: { limit?: number }): EngagementStats {
    const limit = Math.max(1, Math.min(opts?.limit ?? 50, EngagementFlowSubsystem.TURN_STATS_CAP));
    const all = this.turnStatsOrder
      .map((id) => this.turnStats.get(id))
      .filter((s): s is TurnStats => !!s && s.engagementId === engagementId);
    const totalTurns = all.length;
    const totalTagCount = all.reduce((a, s) => a + s.tagCount, 0);
    const totalScriptExecMs = all.reduce((a, s) => a + s.scriptExecMs, 0);
    const totalDurationMs = all.reduce((a, s) => a + s.durationMs, 0);
    const meanDurationMs = totalTurns > 0 ? Math.round(totalDurationMs / totalTurns) : 0;
    // recent-first: reverse a slice from the tail
    const recent = all.slice(-limit).reverse();
    return {
      engagementId,
      totalTurns,
      totalTagCount,
      totalScriptExecMs,
      totalDurationMs,
      meanDurationMs,
      recent,
    };
  }

  /**
   * For Activities in HISTORY_APPEND_ACTIVITIES, stitch the prior Turn
   * chain into a single byte-stable prefix to prepend to the next user
   * prompt. Returns null when:
   *   - the engagement has no Turns yet (first dispatch),
   *   - the Activity isn't in the history-append opt-in set,
   *   - the last Turn can't be fetched (engagement/agents subsystem
   *     unavailable).
   *
   * The shape of the returned prefix is exactly what was last sent +
   * the model's last reply:
   *
   *     <prior dispatched prompt (already has preamble at top)>
   *     <prior assistant reply>
   *
   * Caller appends `\n\n──\n\n<new user text>` to produce the new
   * dispatch. The new dispatch's KV cache hits the entire prior chain.
   */
  private async assemblePriorChainPrefix(engagementId: string): Promise<string | null> {
    const eng = (await this.resolveEngagement(engagementId)) as
      | { activityId?: string; turnIds?: string[] }
      | null;
    if (!eng) return null;
    const activityId = eng.activityId ?? '';
    if (!EngagementFlowSubsystem.HISTORY_APPEND_ACTIVITIES.has(activityId)) {
      return null;
    }
    const turnIds = Array.isArray(eng.turnIds) ? eng.turnIds : [];
    if (!turnIds.length) return null;
    const lastTurnId = turnIds[turnIds.length - 1];
    if (!lastTurnId) return null;
    const lastTurn = await this.fetchTurn(lastTurnId);
    if (!lastTurn) return null;
    const priorRequestText = lastTurn.request?.text ?? '';
    if (!priorRequestText) return null;
    const priorReplyText = lastTurn.assembledText ?? '';

    // Decision 37 §9 — drain any accumulated entity-mutation deltas and
    // append them after the prior Turn pair. Deltas become part of the
    // byte-stable prior chain on the next dispatch so they aren't
    // repeated; KV cache stays warm for the whole accumulated tail.
    const deltaBlock = this.drainDeltas(engagementId);

    const parts: string[] = [priorRequestText];
    if (priorReplyText) parts.push(priorReplyText);
    if (deltaBlock) {
      parts.push('[DELTA — runtime changes since prior Turn]\n' + deltaBlock);
    }
    return parts.join('\n\n');
  }

  /**
   * Fetch a Turn record via the agents subsystem's TurnsSubsystem ref.
   * Returns null if the agents ref isn't wired or the turnId is unknown.
   */
  private async fetchTurn(turnId: string): Promise<TurnRecordView | null> {
    if (!this.agentsRef) return null;
    const turnsRef = (this.agentsRef as unknown as {
      turnsRef?: { get?: (id: string) => unknown };
    }).turnsRef;
    if (!turnsRef || typeof turnsRef.get !== 'function') return null;
    try {
      const t = turnsRef.get(turnId);
      return (t as TurnRecordView | null) ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Run the Result-linker for an engagement that has been completed.
   * Reads accumulated output candidates (subscribed during the window)
   * plus the Engagement's existing `outputs[]` (from explicit
   * `engagements.addOutput` calls), de-dupes, persists each via
   * `engagements.addOutput`, and emits `linker-complete`.
   */
  async runLinker(engagementId: string): Promise<LinkedOutput[]> {
    this.emit('engagements.secretary.linker-started', `item:engagements[${engagementId}]`, {
      engagementId,
      at: new Date().toISOString(),
    });

    const accumulated = this.outputsByEng.get(engagementId) ?? [];
    const engagement = (await this.resolveEngagement(engagementId)) as
      | { outputs?: Array<{ kind: string; ref: string; label?: string }> }
      | null;
    const explicit: LinkedOutput[] = (engagement?.outputs ?? []).map(o => ({
      kind: normalizeOutputKind(o.kind),
      ref: o.ref,
      label: o.label,
      confidence: 'high',
    }));

    const merged = dedupeOutputs([...explicit, ...accumulated]);

    // Persist any newly-discovered outputs back onto the Engagement so
    // the record carries them. Skip refs that were already on the
    // engagement (we keep the original label/position).
    const explicitRefs = new Set(explicit.map(o => `${o.kind}:${o.ref}`));
    const engagementsApi = this.resolveEngagements();
    if (engagementsApi?.addOutput) {
      for (const out of merged) {
        const key = `${out.kind}:${out.ref}`;
        if (explicitRefs.has(key)) continue;
        try {
          engagementsApi.addOutput({
            engagementId,
            output: { kind: out.kind, ref: out.ref, label: out.label },
          });
        } catch {
          /* swallow — non-fatal */
        }
      }
    }

    this.emit('engagements.secretary.linker-complete', `item:engagements[${engagementId}]`, {
      engagementId,
      linkedOutputs: merged,
      at: new Date().toISOString(),
    });

    return merged.map(cloneLinkedOutput);
  }

  // ===================================================================
  // Subscribers
  // ===================================================================

  private async onEngagementOpened(e: SemanticEventLike): Promise<void> {
    const engagementId = e.data?.engagementId as string | undefined;
    if (!engagementId) return;

    const shape = e.data?.shape as string | undefined;
    const activityId = e.data?.activityId as string | undefined;
    const profile = activityId
      ? (this.resolveEngagements()?.profiles?.get?.(activityId) as
          | { hints?: Record<string, unknown> }
          | null
          | undefined)
      : null;

    const skipPrep = shape !== 'ai-ui' || profile?.hints?.skipSecretaryPrep === true;
    const skipLease = shape !== 'ai-ui';

    const tasks: Array<Promise<unknown>> = [];
    if (!skipPrep) tasks.push(this.runSecretaryPrep(engagementId).catch(this.swallow));
    if (!skipLease) tasks.push(this.runSchedulerLease(engagementId).catch(this.swallow));
    await Promise.all(tasks);
  }

  private async onEngagementCompleted(e: SemanticEventLike): Promise<void> {
    const engagementId = e.data?.engagementId as string | undefined;
    if (!engagementId) return;
    try {
      await this.runLinker(engagementId);
    } catch {
      /* swallow — linker failures must not crash the audit loop */
    }
  }

  private onOutputCandidate(e: SemanticEventLike): void {
    // Attribute via the audit frame's engagementId when available. The
    // frame is populated by blur-agent's withTurn window — only inside
    // Turn dispatch — so we fall back to scanning live engagements.
    const audit = (this.runtime as RuntimeShape).audit;
    const frame = audit?.currentFrame?.();
    let engagementId = (frame as { engagementId?: string } | undefined)?.engagementId;

    // Fallback: engagements.output-added carries its own engagementId
    // in `data` so we can attribute even outside a Turn frame.
    if (!engagementId && typeof e.data?.engagementId === 'string') {
      engagementId = e.data.engagementId as string;
    }
    if (!engagementId) return;
    // Only accumulate outputs for engagements that are still active.
    // Status check is against the durable store (single source of truth).
    const eng = this.resolveEngagements()?.get?.(engagementId) as
      | { status?: string }
      | null
      | undefined;
    if (!eng || eng.status !== 'active') return;

    const candidate = classifyOutput(e);
    if (!candidate) return;

    const list = this.outputsByEng.get(engagementId) ?? [];
    list.push(candidate);
    this.outputsByEng.set(engagementId, list);
    this._dirty = true;
  }

  // ===================================================================
  // PrepData assembly helpers
  // ===================================================================

  private async runPrepStep(
    engagementId: string,
    steps: PrepStepDescriptor[],
    idx: number,
    impl: () => Promise<void> | void,
  ): Promise<void> {
    const step = steps[idx];
    if (!step) return;
    try {
      await impl();
      this.emit(
        'engagements.secretary.prep-progress',
        `item:engagements[${engagementId}]`,
        {
          engagementId,
          stepKey: step.key,
          stepIndex: idx + 1,
          totalSteps: steps.length,
          message: step.label,
          at: new Date().toISOString(),
        },
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.emit(
        'engagements.secretary.prep-progress',
        `item:engagements[${engagementId}]`,
        {
          engagementId,
          stepKey: step.key,
          stepIndex: idx + 1,
          totalSteps: steps.length,
          message: `error: ${message}`,
          error: true,
          at: new Date().toISOString(),
        },
      );
    }
  }

  private resolveExtension<T>(name: string): T | null {
    const rt = this.runtime as RuntimeShape;
    const exts = rt.extensions;
    if (!exts || typeof exts.get !== 'function') return null;
    const v = exts.get(name);
    return (v ?? null) as T | null;
  }

  private resolveEngagements(): EngagementsBridge | null {
    return this.resolveExtension<EngagementsBridge>('engagements');
  }

  private resolveProjects(): ProjectsBridge | null {
    return this.resolveExtension<ProjectsBridge>('projects');
  }

  private async resolveEngagement(engagementId: string): Promise<unknown> {
    const engagementsApi = this.resolveEngagements();
    if (!engagementsApi?.get) return null;
    return engagementsApi.get(engagementId);
  }

  private async assembleProjectSummary(projectId: string | undefined): Promise<PrepData['project']> {
    if (!projectId) return emptyProjectSummary(projectId);
    const projectsApi = this.resolveProjects();
    const project = (await projectsApi?.get?.(projectId)) as
      | { id: string; label?: string }
      | null;
    if (!project) return emptyProjectSummary(projectId);

    const charter = (await projectsApi?.charter?.get?.(projectId)) as
      | {
          definition?: {
            purpose?: unknown;
            direction?: { northStar?: unknown; target?: string };
          };
        }
      | null;
    const tracks = ((await projectsApi?.tracks?.list?.(projectId)) ?? []) as Array<{
      id: string;
      label?: string;
      status?: string;
      charter?: { status?: { steps?: unknown[] } };
    }>;

    const trackSummaries: PrepDataTrackSummary[] = tracks.map(t => ({
      id: t.id,
      label: t.label ?? t.id,
      status: t.status ?? 'planned',
      stepCount: Array.isArray(t.charter?.status?.steps) ? t.charter!.status!.steps!.length : 0,
    }));

    return {
      id: project.id,
      label: project.label ?? project.id,
      purpose: charter?.definition?.purpose,
      northStar: charter?.definition?.direction?.northStar,
      target: charter?.definition?.direction?.target,
      tracks: trackSummaries,
    };
  }

  private async assembleProjectHierarchy(projectId: string | undefined): Promise<unknown> {
    if (!projectId) return null;
    const projectsApi = this.resolveProjects();
    const [project, charter, tracks] = await Promise.all([
      projectsApi?.get?.(projectId),
      projectsApi?.charter?.get?.(projectId),
      projectsApi?.tracks?.list?.(projectId),
    ]);
    return { project, charter, tracks };
  }

  private assembleAgentSummary(engagement: unknown): PrepData['agent'] {
    const eng = engagement as
      | { boundAgentIds?: string[]; preferredAgentId?: string }
      | null;
    const candidateId = eng?.preferredAgentId ?? eng?.boundAgentIds?.[0];
    if (!candidateId || !this.agentsRef) return emptyAgentSummary();

    const agent = this.agentsRef.get(candidateId) as
      | { id: string; role?: string; handoff?: { cwd?: string }; bindings?: unknown[] }
      | null;
    if (!agent) return emptyAgentSummary();
    return {
      id: agent.id,
      role: agent.role ?? 'unknown',
      roleDoc: agent.handoff?.cwd,
      bindings: agent.bindings ? [...agent.bindings] : [],
    };
  }

  private async assembleRuntimeSummary(): Promise<PrepData['runtime']> {
    const packsApi = (this.runtime as RuntimeShape).packs;
    let packsLoaded: string[] = [];
    try {
      const list = (await packsApi?.list?.()) as Array<{ id?: string; name?: string }> | undefined;
      if (Array.isArray(list)) {
        packsLoaded = list
          .map(p => p?.id ?? p?.name)
          .filter((v): v is string => typeof v === 'string');
      }
    } catch {
      /* swallow */
    }
    return { version: 'blur-agent@0.4.0', packsLoaded };
  }

  // ===================================================================
  // Persistable
  // ===================================================================

  saveJson(): string {
    const snap: Snapshot = {
      schemaVersion: SCHEMA_VERSION,
      prepData: Array.from(this.prepDataByEng.entries()).map(([engagementId, prepData]) => ({
        engagementId,
        prepData,
      })),
      outputsByEngagement: Array.from(this.outputsByEng.entries()).map(([engagementId, outputs]) => ({
        engagementId,
        outputs,
      })),
    };
    return JSON.stringify(snap);
  }

  loadJson(text: string): void {
    if (!text) return;
    try {
      const snap = JSON.parse(text) as Snapshot;
      if (!snap || snap.schemaVersion !== SCHEMA_VERSION) return;
      this.prepDataByEng = new Map(snap.prepData.map(e => [e.engagementId, e.prepData]));
      this.outputsByEng = new Map(snap.outputsByEngagement.map(e => [e.engagementId, e.outputs]));
    } catch {
      /* swallow — corrupt snapshot leaves us empty */
    }
  }

  consumeDirty(): boolean {
    const d = this._dirty;
    this._dirty = false;
    return d;
  }

  // `engagementFlow.json()` is synthesized by the runtime PackManager
  // for Persistable objects; do not define one here or pack load will
  // refuse with a 'rename or remove' error.

  // ===================================================================
  // Internals
  // ===================================================================

  private emit(kind: string, ref: string, data: Record<string, unknown>): void {
    this.emissionCounts.set(kind, (this.emissionCounts.get(kind) ?? 0) + 1);
    this.emissionsLog.push({ kind, ref, data, at: new Date().toISOString() });
    if (this.emissionsLog.length > EngagementFlowSubsystem.EMISSIONS_LOG_CAP) {
      this.emissionsLog.splice(0, this.emissionsLog.length - EngagementFlowSubsystem.EMISSIONS_LOG_CAP);
    }
    try {
      const audit = (this.runtime as RuntimeShape).audit;
      if (audit?.emit) audit.emit({ kind, ref, data });
    } catch {
      /* swallow */
    }
  }

  private swallow = (_err: unknown): void => {
    /* swallow — subscriber-side errors must not break the audit loop */
  };
}

// ===========================================================================
// Helpers
// ===========================================================================

function prepDataRefFor(engagementId: string): string {
  return `prep:${engagementId}`;
}

function pickProjectId(engagement: unknown): string | undefined {
  const e = engagement as { scope?: { kind?: string; ref?: string } } | null;
  if (!e?.scope) return undefined;
  if (e.scope.kind !== 'project') return undefined;
  return e.scope.ref;
}

function pickLeaseRole(engagement: unknown, fallback: string): string {
  const e = engagement as { activityId?: string } | null;
  // v1 — defer activity → role mapping to the routing policy /
  // engagement profile. For now just use the configured fallback.
  void e;
  return fallback;
}

function emptyProjectSummary(projectId: string | undefined): PrepData['project'] {
  return {
    id: projectId ?? '',
    label: projectId ?? '',
    tracks: [],
  };
}

function emptyAgentSummary(): PrepData['agent'] {
  return { id: '', role: 'unknown', bindings: [] };
}

function classifyOutput(e: SemanticEventLike): LinkedOutput | null {
  const kind = e.eventKind;
  const data = e.data ?? {};
  if (kind === 'engagements.output-added') {
    const k = typeof data.outputKind === 'string' ? data.outputKind : '';
    const r = typeof data.outputRef === 'string' ? data.outputRef : '';
    if (!r) return null;
    return { kind: normalizeOutputKind(k), ref: r, confidence: 'high' };
  }
  if (kind.startsWith('projects.charter.step.') || kind.startsWith('projects.tracks.step.')) {
    const ref = typeof data.stepId === 'string'
      ? data.stepId
      : typeof e.ref === 'string'
      ? e.ref
      : '';
    if (!ref) return null;
    return { kind: 'step', ref, confidence: 'high' };
  }
  if (kind.startsWith('tickets.')) {
    const ref =
      typeof data.ticketId === 'string'
        ? data.ticketId
        : typeof e.ref === 'string'
        ? e.ref
        : '';
    if (!ref) return null;
    return { kind: 'ticket', ref, confidence: 'high' };
  }
  if (kind.startsWith('decisions.')) {
    const ref =
      typeof data.decisionId === 'string'
        ? data.decisionId
        : typeof e.ref === 'string'
        ? e.ref
        : '';
    if (!ref) return null;
    return { kind: 'decision', ref, confidence: 'high' };
  }
  return null;
}

function normalizeOutputKind(k: string): LinkedOutput['kind'] {
  switch (k) {
    case 'step':
    case 'steps':
    case 'charter-step':
    case 'track-step':
      return 'step';
    case 'ticket':
    case 'tickets':
      return 'ticket';
    case 'decision':
    case 'decisions':
      return 'decision';
    case 'charter-update':
      return 'charter-update';
    default:
      return 'event';
  }
}

function dedupeOutputs(list: LinkedOutput[]): LinkedOutput[] {
  const seen = new Set<string>();
  const out: LinkedOutput[] = [];
  for (const item of list) {
    const key = `${item.kind}:${item.ref}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function clonePrepData(p: PrepData): PrepData {
  return JSON.parse(JSON.stringify(p)) as PrepData;
}

/**
 * Render PrepData into a compact human-readable preamble that ships as
 * the static prefix of every Turn's prompt. Markdown-flavored prose;
 * Claude / Together / local Ollama all read it well. Kept terse —
 * large structured data (full charter, recursive hierarchy) is omitted;
 * the model can ask follow-up questions via runtime primitives if it
 * wants more.
 *
 * **Byte-stable across Turns** — this function is a pure function of
 * its inputs. No `Date.now()`, no `prep.assembledAt`, no wall-clock
 * state in the rendered output. The rationale lives in
 * `runtime.library.get('blur-inference-paradigm')` §11:
 *
 *   Local inference engines (llama.cpp via Ollama, vLLM, etc.) use
 *   linear KV caching keyed on the byte-exact prefix. Any drift in
 *   the static block — a changed timestamp, a reordered field —
 *   invalidates the cache for every token below it. Keeping the
 *   preamble deterministic is what lets Turn #2 hit a warm cache from
 *   Turn #1's prep work.
 *
 * `assembledAt` is retained on the PrepData record (audit / debug
 * surface) — it just doesn't appear in the rendered block.
 */
/**
 * Render ONLY the engagement-state snapshot body (no protocol teaching).
 * Used by the new layered prefix composer (Decision 37) as Layer 3.
 * The protocol teaching is handled by Layer 1A (Blur intro) + Layer 1C
 * (walker-generated catalog) instead.
 *
 * Byte-stable across Turns — same pure-function-of-PrepData property as
 * formatPrepPreamble (no timestamps, no wall-clock state).
 */
function formatPrepSnapshot(engagementId: string, prep: PrepData): string {
  const lines: string[] = [];
  lines.push(`engagement: ${engagementId}`);
  lines.push('');
  lines.push('## Project');
  lines.push(`  id:       ${prep.project.id}`);
  lines.push(`  label:    ${prep.project.label}`);
  if (prep.project.northStar) {
    const ns = typeof prep.project.northStar === 'string'
      ? prep.project.northStar
      : JSON.stringify(prep.project.northStar);
    lines.push(`  northStar: ${truncate(ns, 240)}`);
  }
  if (prep.project.target) lines.push(`  target:   ${prep.project.target}`);
  if (prep.project.tracks.length) {
    lines.push('');
    lines.push('## Tracks');
    for (const t of prep.project.tracks) {
      lines.push(`  - ${t.id} (${t.status}, ${t.stepCount} step${t.stepCount === 1 ? '' : 's'}): ${t.label}`);
    }
  }
  lines.push('');
  lines.push('## Agent');
  lines.push(`  role:    ${prep.agent.role}`);
  if (prep.agent.roleDoc) lines.push(`  roleDoc: ${prep.agent.roleDoc}`);
  lines.push('');
  lines.push('## Runtime');
  lines.push(`  version: ${prep.runtime.version}`);
  if (prep.runtime.packsLoaded.length) {
    lines.push(`  packs:   ${prep.runtime.packsLoaded.slice(0, 12).join(', ')}${prep.runtime.packsLoaded.length > 12 ? ', …' : ''}`);
  }
  return lines.join('\n');
}

function formatPrepPreamble(engagementId: string, prep: PrepData): string {
  const lines: string[] = [];
  // Protocol teaching block — byte-stable across all Turns/iterations.
  // Per state-advancement-loop §3, this section tells the model how to
  // emit `<b:s>` tags. v1 covers scripts only; file ops are reserved.
  lines.push(PROTOCOL_TEACHING_BLOCK);
  lines.push('');
  lines.push(`[Engagement context]`);
  lines.push('');
  lines.push(`engagement: ${engagementId}`);
  lines.push('');
  lines.push('## Project');
  lines.push(`  id:       ${prep.project.id}`);
  lines.push(`  label:    ${prep.project.label}`);
  if (prep.project.northStar) {
    const ns = typeof prep.project.northStar === 'string'
      ? prep.project.northStar
      : JSON.stringify(prep.project.northStar);
    lines.push(`  northStar: ${truncate(ns, 240)}`);
  }
  if (prep.project.target) lines.push(`  target:   ${prep.project.target}`);
  if (prep.project.tracks.length) {
    lines.push('');
    lines.push('## Tracks');
    for (const t of prep.project.tracks) {
      lines.push(`  - ${t.id} (${t.status}, ${t.stepCount} step${t.stepCount === 1 ? '' : 's'}): ${t.label}`);
    }
  }
  lines.push('');
  lines.push('## Agent');
  lines.push(`  role:    ${prep.agent.role}`);
  if (prep.agent.roleDoc) lines.push(`  roleDoc: ${prep.agent.roleDoc}`);
  lines.push('');
  lines.push('## Runtime');
  lines.push(`  version: ${prep.runtime.version}`);
  if (prep.runtime.packsLoaded.length) {
    lines.push(`  packs:   ${prep.runtime.packsLoaded.slice(0, 12).join(', ')}${prep.runtime.packsLoaded.length > 12 ? ', …' : ''}`);
  }
  return lines.join('\n');
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/**
 * Walk a dot-path against a JSON-shaped object. Used by the `<b:p>`
 * handler to resolve `direction.northStar`-style paths against an
 * entity record. Behaviour:
 *
 *   - empty / missing path → return the object itself
 *   - any intermediate segment that's null/undefined → return that
 *     (matches the model's `?.` chain expectation: "the path didn't
 *     resolve" returns the nullish, not an error)
 *   - segment resolves against a non-object → return undefined
 *   - segments may use `[0]` or numeric `.0` for array indexing
 */
function walkDotPath(obj: unknown, path: string): unknown {
  if (!path) return obj;
  // Normalize `[i]` → `.i` so we can split on a single delimiter.
  const segments = path.replace(/\[(\w+)\]/g, '.$1').split('.').filter(Boolean);
  let cur: unknown = obj;
  for (const seg of segments) {
    if (cur === null || cur === undefined) return cur;
    if (typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/**
 * Static protocol-teaching block prepended to every dispatch. Byte-stable
 * — never includes timestamps or per-Turn drift. Cache-friendly per
 * state-advancement-loop §9.
 *
 * v1 vocabulary: `<b:s>` only. File-op tags (`<b:f>`, `<b:fu>`, `<b:fc>`,
 * `<b:fw>`) are reserved by the spec but unimplemented in v1; the model
 * is not told about them yet to avoid confusing it with unsupported syntax.
 */
const PROTOCOL_TEACHING_BLOCK = [
  '[Blur protocol — read once, apply each reply]',
  '',
  'You operate inside the Blur runtime. Two tags let you advance state:',
  '',
  '  <b:p e="<kind>:<id>">field.path</b:p>  — READ a field from one',
  '    entity record. Fast, host-side, no script execution. Preferred',
  '    for simple reads. Known kinds:',
  '      project, ticket, decision, engagement, agent, turn',
  '    Examples:',
  '      <b:p e="project:qb">label</b:p>',
  '      <b:p e="project:blur-project-framework">charter.definition.title</b:p>',
  '      <b:p e="ticket:tkt_abc">title</b:p>',
  '    Body is a dot-path (with optional [i] indexing). Empty body =',
  '    return the whole record.',
  '',
  '  <b:s>code</b:s>                         — execute a JavaScript /',
  '    TypeScript snippet via `runtime.script.run`. Use when `<b:p>`',
  '    is insufficient: computed values, multi-step reads, mutations,',
  '    audit-event queries, etc. Async; you may `await` and `return`.',
  '    The runtime object is in scope as `runtime`.',
  '    Example primitives: `runtime.projects.list({...})`,',
  '    `runtime.tickets.list({...})`, `runtime.audit.recentEvents({...})`.',
  '    For mutations, use the write primitives directly inside the script.',
  '',
  'The substrate parses every tag, executes it, and appends each result',
  'as `<b:p-result for="$N">…</b:p-result>` / `<b:s-result for="$N">…</b:s-result>`',
  '(or the matching `-error` variant) to a follow-up message. You can',
  'read those results and decide what to do next.',
  '',
  'Tag syntax (precise — small variations break execution):',
  '  <b:p e="kind:id">path</b:p>              — property read',
  '  <b:s>code</b:s>                          — execute code',
  '  <b:s isolate="hermetic">code</b:s>       — fresh isolate for this block',
  '',
  'Do NOT write `<b:s-isolate=…>`, `<b:script>`, `<bs>`, `<b-p>` or',
  'similar variants — those forms are not recognized. Opening tags',
  'are exactly `<b:s` or `<b:p` optionally followed by attributes,',
  'then `>`.',
  '',
  'You emit ONLY the call tags: `<b:p>` and `<b:s>`. You do NOT write',
  '`<b:p-result>`, `<b:s-result>`, `<b:p-error>`, or `<b:s-error>` —',
  'those are reserved for the substrate. The substrate appends them to',
  'your next prefix after running your call. If you write a result tag',
  'yourself, the substrate ignores it but the model on the next iteration',
  '(you) sees two result tags side by side and gets confused. Don\'t.',
  '',
  'If you already wrote a complete natural-language answer to the user',
  'BEFORE you saw the result of your tag — and the result confirms your',
  'answer — produce a tag-free reply on the next iteration to terminate',
  'the Turn. A brief acknowledgment like "Confirmed." is fine. Do NOT',
  'meta-narrate the protocol ("The Turn ends with your plain prose…");',
  'just answer or acknowledge and stop.',
  '',
  'Rules:',
  '  - Multiple tags in one reply run in source order; positions are',
  '    numbered across all kinds (so `<b:p>` then `<b:s>` means $1 and',
  '    $2). Within a Turn, `<b:s>` blocks share scope (variables in',
  '    block 1 are visible in block 2). Opt out with',
  '    `<b:s isolate="hermetic">…</b:s>`.',
  '  - A reply with **zero** tags ends the Turn. The substrate treats',
  '    your reply as the final answer to the user.',
  '  - The substrate caps the loop at 64 iterations per Turn; emit a',
  '    tag-free reply when you have what you need.',
  '  - You may wrap tags in markdown ``` fences or not — both forms',
  '    execute. Tags are matched anywhere in your reply.',
  '',
  'Interpreting `<b:s-result>` bodies:',
  '  - JSON-shaped content → the script returned an object or array.',
  '  - A bare value (string, number, true/false, null) → that value.',
  '  - `(undefined — script returned no value)` → the script ran',
  '    successfully but returned undefined. NOT an error. Most often',
  '    you read a field that doesn\'t exist (the path was wrong) or you',
  '    forgot to `return` in your snippet. Try a different path or add',
  '    `return`. Do NOT claim "an error occurred" — there was no error.',
  '  - `(empty string)` → the script returned "". Also not an error.',
  '  - A `<b:s-error>` tag is the ONLY error signal. If you don\'t see',
  '    one, the script worked.',
  '',
  'When a field path returns undefined, the right move is to inspect',
  'the record shape, not to guess again. Example:',
  '  <b:s>const p = await runtime.projects.get("blur-project-framework");',
  '       return { keys: Object.keys(p), sample: p };</b:s>',
  'Then read where the field actually lives and try again.',
  '',
  'Workflow you typically follow:',
  '  1. Read whatever state matters. Prefer `<b:p>` for single-field',
  '     reads: `<b:p e="project:qb">label</b:p>`. Use `<b:s>` for',
  '     anything that needs computation, multiple fetches, or writes.',
  '  2. The substrate executes; you see a `<b:p-result>` or',
  '     `<b:s-result>` block with the value.',
  '  3. Reason about the result. If you need more, emit another tag.',
  '  4. When you have enough to answer the user, write the answer as',
  '     plain prose with **no** tags. Turn ends.',
  '',
  'A common first-Turn move:',
  '  user: "what is the label of this project?"',
  '  you:  `<b:p e="project:blur-project-framework">label</b:p>`',
  '  (substrate runs it, appends the result)',
  '  you again: "The label is: …" (no tags — Turn ends.)',
  '',
  'If you read a path that doesn\'t exist, you\'ll see a `<b:p-error>`',
  'telling you what went wrong. To inspect a record\'s shape, read it',
  'with no path: `<b:p e="project:qb"></b:p>` returns the whole record.',
  '',
].join('\n');

function cloneLinkedOutput(o: LinkedOutput): LinkedOutput {
  return { ...o };
}
