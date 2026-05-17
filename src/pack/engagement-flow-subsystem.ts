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

import type { AgentsSubsystem } from './agents-subsystem';
import type { SchedulerSubsystem } from './scheduler-subsystem';
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
      try {
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
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        this.emit('engagements.scheduler.lease-failed', `item:engagements[${engagementId}]`, {
          engagementId,
          error: message,
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
   *   2. Splice the assembled PrepData blob into the prompt on Turn #1
   *      (`engagement.turnIds.length === 0`). Subsequent Turns skip the
   *      splice — context lives in the provider's session (Claude) or
   *      in the Turn history readable from `agents.turns.list(...)`
   *      (stateless providers).
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
    opts: { text: string; by?: string; agentId?: string; outcome?: string } = { text: '' },
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

    // PrepData splice on Turn #1. After this, context lives in the
    // provider session (Claude) or in the Turn record history (Together).
    const isFirstTurn = (engagement.turnIds?.length ?? 0) === 0;
    const prepData = isFirstTurn ? this.prepDataByEng.get(engagementId) ?? null : null;
    const finalText =
      prepData !== null
        ? formatPrepPreamble(engagementId, prepData) + '\n\n──\n\n' + opts.text
        : opts.text;

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
      prepSpliced: prepData !== null,
    };
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
 * the first chunk of the Turn #1 prompt. Markdown-flavored prose; Claude
 * and Together both read this well. Kept terse — large structured data
 * (full charter, recursive hierarchy) is omitted; the model can ask
 * follow-up questions via runtime primitives if it wants more.
 */
function formatPrepPreamble(engagementId: string, prep: PrepData): string {
  const lines: string[] = [];
  lines.push(`[Engagement context — assembled ${prep.assembledAt}]`);
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

function cloneLinkedOutput(o: LinkedOutput): LinkedOutput {
  return { ...o };
}
