/**
 * blur-agent — engagement-flow types.
 *
 * Backend half of the Engagement Flow contract
 * (`blur-ai-runtime/library/architecture/SA-Engagement-Flow.md`).
 *
 * The Engagement Flow wires three behaviors on top of the existing
 * `runtime.engagements.*` surface:
 *
 *   1. Secretary auto-prep — on `engagements.opened`, assembles a
 *      `PrepData` JSON the hot session reads as its first user message.
 *   2. Scheduler auto-lease — on `engagements.opened` (parallel with
 *      Secretary), leases a hot session bound to the Engagement scope.
 *   3. Result-linker — on `engagements.completed`, scans the Engagement
 *      window for outputs (Steps, Tickets, Decisions, …) and persists
 *      them via `engagements.addOutput`.
 *
 * Event names + payload shapes are the **contract**; if you propose any
 * deviation, REVIEW gate first.
 */

// ===========================================================================
// PrepData — v1 context the Secretary assembles for the hot session
// ===========================================================================

/**
 * One entry in PrepData.project.tracks — a compact Track summary.
 * Matches the Track surface in `runtime.projects.tracks.list(...)`
 * with the noisy fields stripped.
 */
export interface PrepDataTrackSummary {
  id: string;
  label: string;
  status: string;
  stepCount: number;
}

export interface PrepDataProject {
  id: string;
  label: string;
  /** Charter.definition.purpose — shape is intentionally `unknown`. */
  purpose?: unknown;
  /** Charter.definition.direction.northStar — string or structured. */
  northStar?: unknown;
  /** Charter.definition.direction.target. */
  target?: string;
  tracks: PrepDataTrackSummary[];
}

export interface PrepDataAgent {
  /** Agent record id. May be the empty string when no agent is bound yet. */
  id: string;
  /** Role id from the agent role catalog. */
  role: string;
  /** Path to the role's CLAUDE.md / charter, when known. */
  roleDoc?: string;
  /** Current bindings on this agent (passthrough — shape lives in blur-agent). */
  bindings: Array<unknown>;
}

export interface PrepDataRuntime {
  version: string;
  packsLoaded: string[];
}

/**
 * v1 prep-data JSON shape — see SA-Engagement-Flow.md § "Prep-data JSON shape".
 *
 * Opaque to the workspace UI; pinned by `prepDataRef` from the
 * `engagements.secretary.prep-complete` event. The hot session reads it
 * via `runtime.engagementFlow.getPrepData(engagementId)` and includes
 * the (typically serialized) value as its first user message.
 */
export interface PrepData {
  project: PrepDataProject;
  agent: PrepDataAgent;
  runtime: PrepDataRuntime;
  /**
   * Recursive dump of project + tracks + (future: arcs, charters). v1
   * keeps the shape `unknown` — consumers should treat it as advisory
   * context, not load-bearing structure.
   */
  projectHierarchy: unknown;
  /** ISO 8601 — when this PrepData was assembled. */
  assembledAt: string;
}

// ===========================================================================
// Prep-step manifest
// ===========================================================================

/**
 * Declared prep work the Secretary plans to do for one Engagement.
 * Total count is `steps.length`; UI bases the progress bar on
 * `(stepIndex / totalSteps)` from `engagements.secretary.prep-progress`.
 */
export interface PrepStepDescriptor {
  key: string;
  label: string;
}

export const DEFAULT_PREP_STEPS: PrepStepDescriptor[] = [
  { key: 'gather-project-state', label: 'Gather project state' },
  { key: 'gather-tracks', label: 'Gather tracks' },
  { key: 'gather-recent-engagements', label: 'Gather recent engagements' },
  { key: 'assemble-json', label: 'Assemble prep-data JSON' },
  { key: 'register-with-engagement', label: 'Register prep-data ref with engagement' },
];

// ===========================================================================
// Linker — output kinds the Result-linker recognizes
// ===========================================================================

/**
 * One candidate output the linker found in the Engagement window.
 * Mirror of the `linkedOutputs[]` payload in
 * `engagements.secretary.linker-complete`.
 */
export interface LinkedOutput {
  kind: 'step' | 'ticket' | 'decision' | 'charter-update' | 'event';
  /** Typed ref into the appropriate registry. */
  ref: string;
  label?: string;
  confidence?: 'high' | 'medium' | 'low';
}

/**
 * Audit-event kinds the linker treats as output-producing. Subscribed
 * during `start()` so each Engagement window can accumulate refs by
 * `engagementId` from the audit frame.
 */
export const LINKER_OUTPUT_KINDS = [
  // Charter / Track steps
  'projects.charter.step.added',
  'projects.charter.step.completed',
  'projects.tracks.step.added',
  'projects.tracks.step.completed',
  // Tickets
  'tickets.filed',
  'tickets.opened',
  'tickets.resolved',
  // Decisions
  'decisions.opened',
  'decisions.resolved',
  // Already-explicit outputs (record-keeping passthrough)
  'engagements.output-added',
];

// ===========================================================================
// Subsystem options
// ===========================================================================

export interface EngagementFlowOptions {
  /**
   * Default Agent role used by the Scheduler auto-lease subscriber when
   * the Engagement profile does not pin one. Defaults to `'run'`.
   */
  defaultLeaseRole?: string;
  /**
   * If true, the Scheduler auto-lease subscriber will NOT actually call
   * `runtime.agents.lease`; instead it emits `lease-started` and
   * `session-ready` with a synthetic mock sessionId. Useful for tests
   * (and the smoke test) that don't have a pool extension loaded.
   */
  mockLease?: boolean;
  /**
   * Optional override for the prep-step list. Defaults to
   * DEFAULT_PREP_STEPS. Length is the `totalSteps` reported in
   * `prep-progress`.
   */
  prepSteps?: PrepStepDescriptor[];
}
