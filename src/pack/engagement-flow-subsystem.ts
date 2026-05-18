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
 * liveEngagements or the global cap rolls oldest entries off.
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

  /** Active engagements we've seen `opened` for and not yet `completed`. */
  private liveEngagements = new Set<string>();

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
   * exits liveEngagements OR the cap (TURN_STATS_CAP) is hit, after
   * which oldest entries are dropped.
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
        // didn't opt in). Original v1 path: preamble + delimiter + user text.
        const prepData = this.prepDataByEng.get(engagementId) ?? null;
        finalText =
          prepData !== null
            ? formatPrepPreamble(engagementId, prepData) + '\n\n──\n\n' + opts.text
            : opts.text;
        prepSplicedThisTurn = prepData !== null;
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
      if (!this.liveEngagements.has(engagementId)) return;

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

      // Locate the script runner. Cast through any: BlurAIRuntime's typed
      // surface may not declare `script.run`, but the host runtime exposes it.
      const scriptRunner = (this.runtime as unknown as {
        script?: { run?: (src: string) => Promise<{ value?: unknown; ok?: boolean; error?: string }> };
      }).script?.run;
      if (typeof scriptRunner !== 'function') {
        stats.terminationReason = 'error';
        this.recordTurnStats(stats);
        this.emit('turns.tag-executed', `item:turns[${turnId}]`, {
          turnId,
          engagementId,
          iter,
          error: 'runtime.script.run unavailable on host',
          at: new Date().toISOString(),
        });
        return;
      }

      this.emit('turns.iteration-started', `item:engagements[${engagementId}]`, {
        engagementId,
        turnId,
        iter,
        tagCount: tags.length,
        at: new Date().toISOString(),
      });

      // Execute each tag in source order; accumulate timing + size into stats.
      const resultBlocks: string[] = [];
      for (const tag of tags) {
        const t0 = Date.now();
        try {
          const r = await scriptRunner(tag.body);
          const execMs = Date.now() - t0;
          stats.scriptExecMs += execMs;
          if (r && r.ok === false) {
            const msg = r.error ?? 'script run failed';
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
    return priorRequestText + (priorReplyText ? '\n\n' + priorReplyText : '');
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
    this.liveEngagements.add(engagementId);

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
    } finally {
      this.liveEngagements.delete(engagementId);
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
    if (!engagementId || !this.liveEngagements.has(engagementId)) return;

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
  'You operate inside the Blur runtime. To advance project state, emit',
  'JavaScript snippets inside `<b:s>…</b:s>` tags in your reply. The',
  'substrate parses every `<b:s>` block, executes it via',
  '`runtime.script.run` against the Blur runtime, and appends each',
  'result as `<b:s-result for="$N">…</b:s-result>` (or',
  '`<b:s-error for="$N">…</b:s-error>` on failure) to a follow-up',
  'message. You can read those results and decide what to do next.',
  '',
  'Rules:',
  '  - Each `<b:s>` body is one async TypeScript/JavaScript snippet.',
  '    You can `await` and you can `return` a value to be reported.',
  '    The runtime object is in scope as `runtime`. Example primitives:',
  '    `runtime.projects.get(id)`, `runtime.tickets.list({…})`,',
  '    `runtime.audit.recentEvents({…})`.',
  '  - Multiple `<b:s>` blocks in one reply run in source order and',
  '    share scope (variables declared in block 1 are visible in block 2).',
  '    To opt out of shared scope, write `<b:s isolate="hermetic">…</b:s>`.',
  '  - A reply with **zero** `<b:s>` tags ends the Turn. The substrate',
  '    treats your reply as the final answer to the user.',
  '  - The substrate caps the loop at 64 iterations per Turn; emit a',
  '    script-free reply when you have what you need.',
  '  - You may wrap `<b:s>…</b:s>` in markdown ``` fences or not — both',
  '    forms execute. Tags are matched anywhere in your reply.',
  '',
  'Workflow you typically follow:',
  '  1. Read whatever state matters: `<b:s>return await runtime.projects.get("…");</b:s>`',
  '  2. The substrate executes it; you see a `<b:s-result>` block.',
  '  3. Reason about the result. If you need more, emit another `<b:s>`.',
  '  4. When you have enough to answer the user, write the answer as',
  '     plain prose with **no** `<b:s>` tags. Turn ends.',
  '',
  'A common first-Turn move is to inspect state before answering:',
  '  user: "what is the north star of this project?"',
  '  you:  `<b:s>return (await runtime.projects.get("blur-project-framework")).direction?.northStar;</b:s>`',
  '  (substrate runs it, appends the result)',
  '  you again: "The north star is: …" (no tags — Turn ends.)',
  '',
].join('\n');

function cloneLinkedOutput(o: LinkedOutput): LinkedOutput {
  return { ...o };
}
