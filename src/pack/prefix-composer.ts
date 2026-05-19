/**
 * Prefix composer — builds the six-layer model-facing prefix per
 * Decision 37 §1.
 *
 *   Layer 1A — BLUR INTRO (cross-session, byte-stable forever)
 *   Layer 1B — ACTIVITY DEFINITION (per-Activity, byte-stable)
 *   Layer 1C — ENTITY CATALOG + TAGS (Activity-surface-scoped)
 *   Layer 2  — PROJECT + ROLE (per-project + role, byte-stable)
 *   Layer 3  — STATE SNAPSHOT (per-engagement, byte-stable at open)
 *              + NOTE block teaching snapshot+delta=current
 *   Layer 4  — CHRONOLOGICAL TAIL (grows; Turn pairs + delta lines)
 *
 * Layers 1–3 are computed once at engagement-open (or first Turn) and
 * cached — byte-stable for the lifetime of the engagement. Layer 4
 * grows but its incremental cost stays bounded by the delta-tail
 * mechanism. Cross-engagement cache discipline rides on the strict
 * byte-stability of Layers 1–2.
 *
 * v1 of this composer ships Layers 1A/1B/1C/2/3 fully; Layer 4 keeps
 * today's Path 2 history-append shape (Turn pairs only). The delta
 * projection lands in a follow-on once the Secretary delta subscriber
 * is built (deferred — see Decision 37 §9).
 */

import type { BlurAIRuntime } from 'blur-ai-runtime';

// Local shape — the composer doesn't depend on the substrate's full
// runtime type. Only the bits it actually reads.
interface RuntimeShape {
  tagWalker?: {
    catalogText: (surface?: ActivitySurfaceLike) => string;
    entityList: (surface?: ActivitySurfaceLike) => unknown[];
  };
  extensions?: { get?: (name: string) => unknown };
  packs?: { entityDeclarations?: () => unknown[] };
}

interface ActivitySurfaceLike {
  include?: '*' | string[];
  exclude?: string[];
}

interface ActivityLike {
  id: string;
  label?: string;
  purpose?: string;
  responsibilities?: string;
  objective?: string;
  exitCriteria?: string;
  aiInstructions?: string;
  surface?: ActivitySurfaceLike;
  contextProjection?: { include?: unknown[] };
}

interface ProjectLike {
  id: string;
  label?: string;
  direction?: {
    northStar?: string;
    target?: string;
  };
}

interface AgentLike {
  id: string;
  role?: string;
  roleDoc?: string;
}

interface EngagementLike {
  id: string;
  activityId?: string;
  scope?: { kind?: string; ref?: string };
}

export interface ComposePrefixOpts {
  runtime: BlurAIRuntime;
  engagement: EngagementLike;
  activity?: ActivityLike | null;
  project?: ProjectLike | null;
  agent?: AgentLike | null;
  /**
   * Layer 3 snapshot — already-rendered prep block. The composer
   * doesn't re-render the prep data; it just lays it in Layer 3 and
   * appends the snapshot-NOTE block.
   *
   * When omitted, Layer 3 is skipped (engagement-open hasn't completed
   * prep yet).
   */
  snapshotText?: string | null;
  /**
   * Time the snapshot was taken (ISO). Used in Layer 3's NOTE block.
   * Today's value is used if omitted but discouraged — cache stability
   * wants this to be stable across Turns within an engagement.
   */
  snapshotAt?: string | null;
}

// ============================================================================
// Layer 1A — BLUR INTRO (cross-session, byte-stable forever)
// ============================================================================

/**
 * What Blur is. This text is byte-identical on EVERY engagement of EVERY
 * Activity on EVERY session, ever. Provider KV caches hit it as long as
 * the model + endpoint stay the same.
 *
 * Keep it short — every model that sees this Activity pays its token cost.
 * The goal is purpose-orientation, not exhaustive teaching.
 */
const LAYER_1A_BLUR_INTRO = [
  '[Blur — read once, applies for the lifetime of this engagement]',
  '',
  'You are operating inside the Blur runtime. Blur is a state-advancement',
  'engine — not a chat tool. Projects, Tracks, Decisions, Tickets,',
  'Library docs, Engagements, and Turns are durable runtime entities.',
  'Each Turn you read the current runtime state and propose what changes',
  'bring the project closer to its north star.',
  '',
  'The runtime maintains an audit log of every change. You see a snapshot',
  'of relevant state below, plus a chronological tail of what has happened',
  'since the snapshot was taken. Your job is to read the state, respond to',
  "the user's prompt with concrete proposals or questions, and capture new",
  'facts via runtime entity tags when the user agrees they should land.',
  '',
].join('\n');

// ============================================================================
// Layer 1B — ACTIVITY DEFINITION (per-Activity, byte-stable)
// ============================================================================

function renderLayer1B(activity?: ActivityLike | null): string {
  if (!activity) {
    return '[Activity context unavailable]\n\n';
  }
  const lines: string[] = [];
  lines.push(`[Activity: ${activity.id}${activity.label ? ` — ${activity.label}` : ''}]`);
  lines.push('');

  if (activity.purpose) {
    lines.push('**Purpose:** ' + activity.purpose);
    lines.push('');
  }
  if (activity.responsibilities) {
    lines.push('**Your responsibilities each Turn:** ' + activity.responsibilities);
    lines.push('');
  }
  if (activity.objective) {
    lines.push('**Objective:** ' + activity.objective);
    lines.push('');
  }
  if (activity.exitCriteria) {
    lines.push('**Exit criteria:** ' + activity.exitCriteria);
    lines.push('');
  }
  if (activity.aiInstructions) {
    lines.push('**Standing instructions:**');
    lines.push(activity.aiInstructions);
    lines.push('');
  }
  return lines.join('\n');
}

// ============================================================================
// Layer 1C — ENTITY CATALOG + TAGS (Activity-surface-scoped)
// ============================================================================

function renderLayer1C(
  runtime: RuntimeShape,
  surface?: ActivitySurfaceLike,
): string {
  const walker = runtime.tagWalker;
  if (!walker || typeof walker.catalogText !== 'function') {
    return [
      '[Entity catalog unavailable — runtime.tagWalker not present.',
      ' Fall back to <b:script>...</b:script> for runtime access.]',
      '',
    ].join('\n');
  }
  try {
    const text = walker.catalogText(surface);
    return text + '\n';
  } catch (err) {
    return `[Entity catalog render failed: ${(err as Error).message}]\n\n`;
  }
}

// ============================================================================
// Layer 2 — PROJECT + ROLE (per-project + role, byte-stable)
// ============================================================================

function renderLayer2(
  project?: ProjectLike | null,
  agent?: AgentLike | null,
): string {
  const lines: string[] = [];

  if (project) {
    lines.push(`[Project: ${project.id}${project.label ? ` — ${project.label}` : ''}]`);
    lines.push('');
    if (project.direction?.northStar) {
      lines.push('**North star:** ' + truncate(String(project.direction.northStar), 240));
      lines.push('');
    }
    if (project.direction?.target) {
      lines.push('**Current target:** ' + project.direction.target);
      lines.push('');
    }
  } else {
    lines.push('[No project bound to this engagement]');
    lines.push('');
  }

  if (agent) {
    lines.push(`[Agent: role=${agent.role ?? 'unknown'}]`);
    lines.push('');
    if (agent.roleDoc) {
      lines.push(agent.roleDoc);
      lines.push('');
    }
  }
  return lines.join('\n');
}

// ============================================================================
// Layer 3 — STATE SNAPSHOT + snapshot-delta NOTE
// ============================================================================

/**
 * Byte-stable NOTE block teaching the model how snapshot + delta tail
 * reconcile to current state. Decision 37 §8.
 *
 * One sentence, stable position, taught once at the top of the snapshot.
 * Answers "how does the model know snapshot + delta = current state?"
 * without per-Δ annotation cost.
 */
const SNAPSHOT_NOTE_BLOCK = [
  '',
  '---',
  'NOTE: The snapshot above was taken at engagement-open. Any change to',
  'these values since then is recorded chronologically below as a Δ line.',
  'The current value of any field is its snapshot value OR the most recent',
  'Δ for that field, whichever is later. New entities that did not exist',
  'at engagement-open appear as + lines.',
  '',
].join('\n');

function renderLayer3(snapshotText?: string | null): string {
  if (!snapshotText) {
    return '[State snapshot deferred — engagement-open prep not yet complete]\n\n';
  }
  return [
    '[State snapshot — current as of engagement-open]',
    '',
    snapshotText,
    SNAPSHOT_NOTE_BLOCK,
  ].join('\n');
}

// ============================================================================
// Public composer
// ============================================================================

/**
 * Per-layer breakdown returned by composePrefix. The full rendered
 * prefix is `prefix` (already joined); `layers` carries each layer's
 * text separately so consumers can inspect byte counts per layer or
 * render diffs by layer.
 *
 * Used by previewPrefix (tuning workbench) to surface per-layer
 * lengths; production dispatchers just read `.prefix`.
 */
export interface ComposedPrefix {
  prefix: string;
  layers: {
    layer1A_blurIntro: string;
    layer1B_activityDefinition: string;
    layer1C_entityCatalog: string;
    layer2_projectRole: string;
    layer3_stateSnapshot: string;
  };
}

/**
 * Build the full layered prefix (Layers 1A through 3) per Decision 37 §1.
 *
 * Layer 4 (chronological tail) is appended by the dispatch path
 * (`dispatchTurn`) which knows about prior Turn pairs and the delta
 * tail. The composer returns everything up to but not including
 * Layer 4 — the delimiter and the new user prompt are also appended
 * by `dispatchTurn`.
 *
 * Returns the rendered prefix string PLUS a per-layer breakdown for
 * inspection (Decision 37 § Tuning workbench — used by previewPrefix).
 * Production callers can read `.prefix` directly.
 *
 * Byte-deterministic given the same inputs.
 */
export function composePrefix(opts: ComposePrefixOpts): ComposedPrefix {
  const surface = opts.activity?.surface;
  const layer1A = LAYER_1A_BLUR_INTRO;
  const layer1B = renderLayer1B(opts.activity);
  const layer1C = renderLayer1C(opts.runtime as RuntimeShape, surface);
  const layer2 = renderLayer2(opts.project, opts.agent);
  const layer3 = renderLayer3(opts.snapshotText);
  const prefix = [layer1A, layer1B, layer1C, layer2, layer3].join('\n');
  return {
    prefix,
    layers: {
      layer1A_blurIntro: layer1A,
      layer1B_activityDefinition: layer1B,
      layer1C_entityCatalog: layer1C,
      layer2_projectRole: layer2,
      layer3_stateSnapshot: layer3,
    },
  };
}

// ============================================================================
// Helpers
// ============================================================================

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}
