/**
 * BlurContext — immutable layer-aware container for everything a model
 * needs to receive on a `chat.completions.create` invocation.
 *
 * Decision 34. Replaces the per-dispatcher prefix composition logic
 * currently embedded in `EngagementFlowSubsystem.dispatchTurn`.
 *
 * Three responsibilities:
 *   1. Hold the layered system prefix as a named `Map<LayerName, string>`
 *      so callers can drop or replace individual layers (testing &
 *      tuning surface).
 *   2. Hold the multi-turn message history (`ChatMessage[]`) so callers
 *      that want conversational context append to the context rather
 *      than re-composing.
 *   3. Render the combined view as either a flattened string
 *      (back-compat) or an OpenAI-style messages array (native).
 *
 * Static factories cover the three creation patterns:
 *   - `fromActivity(opts)`  — looks up an Activity (and optional
 *     project/agent) and wraps `composePrefix` from prefix-composer.ts
 *   - `fromScratch()`       — empty context; caller adds layers manually
 *   - `fromComposed(text)`  — single layer holding raw text; useful when
 *     a caller already has a prefix string and just wants to wrap it
 *
 * Instances are immutable. Mutators (`withLayer`, `withoutLayer`,
 * `withHistoryAppended`) return new instances. This guarantees safe
 * sharing across parallel `chat.completions.create` invocations — the
 * cross-contamination bug from engagement-keyed state (see
 * `tkt_7de641e6` and the workbench-2026-05-20b checkpoint) cannot
 * recur here by construction.
 *
 * See also:
 *   - decisions/34-chat-completions-and-blur-context.md
 *   - prefix-composer.ts (the layer compositor we wrap for fromActivity)
 *   - chat-completions-subsystem.ts (the consumer)
 */

import { createHash } from 'node:crypto';

import type { BlurAIRuntime } from 'blur-ai-runtime';

import { composePrefix } from './prefix-composer';

// ============================================================================
// Public types
// ============================================================================

/**
 * Layer name. Predefined values are recommended for byte-stability with
 * cache discipline, but arbitrary strings (especially `custom-*`) are
 * permitted for tests and ad-hoc tuning.
 *
 * Canonical predefined names (used by `fromActivity`):
 *   - 'intro'    — Layer 1A blur cross-session intro
 *   - 'activity' — Layer 1B activity definition
 *   - 'catalog'  — Layer 1C entity-catalog + tag teaching
 *   - 'role'     — Layer 2 project + agent role
 *   - 'state'    — Layer 3 state snapshot + NOTE block
 *
 * Custom layers should use a `custom-` prefix to avoid collisions with
 * future canonical layers (`custom-test-fixture`, `custom-system-add-on`).
 */
export type LayerName = string;

/**
 * OpenAI-aligned chat message. Used throughout context history and
 * inside ChainResult.messages.
 *
 * `tool_calls` (on assistant messages) and `tool_call_id` (on tool
 * messages) are reserved for future native-tool-calling support. v1
 * leaves them unset and represents tag execution via the assistant's
 * text content + b:s-result blocks (current behaviour).
 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** Reserved for future native-tool-calling support. */
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  /** Reserved for future native-tool-calling support. */
  tool_call_id?: string;
  /** Optional speaker attribution (free-form). Not transmitted to provider. */
  name?: string;
}

/**
 * Serializable snapshot of a BlurContext. Returned across the
 * script-engine boundary because class instances don't round-trip
 * cleanly through V8 isolate sandboxing.
 *
 * `chat.completions.create` accepts either a live BlurContext instance
 * (in-substrate callers) OR a snapshot (script callers) — the
 * subsystem reconstitutes from snapshot when needed.
 */
export interface BlurContextSnapshot {
  /** Ordered layer entries — insertion order is render order. */
  layers: Array<[LayerName, string]>;
  /** Conversation history. */
  history: ChatMessage[];
  /** Marker for `isBlurContextSnapshot` detection. */
  readonly __blurContext: 'v1';
}

/**
 * `describe()` return shape. Used by the tuning UI (per-layer byte
 * size + hashes) and by cache-discipline audits (verify byte-stability
 * across runs by comparing hashes).
 */
export interface BlurContextDescription {
  totalBytes: number;
  layerCount: number;
  historyCount: number;
  layerSizes: Record<LayerName, number>;
  layerHashes: Record<LayerName, string>;
  /** Hash over the concatenated layer contents (in order). */
  hash: string;
}

// ============================================================================
// fromActivity options
// ============================================================================

export interface FromActivityOpts {
  runtime: BlurAIRuntime;
  /** Activity to compose for. Looked up via `runtime.activities.get`. */
  activityId: string;
  /**
   * Optional agent. Looked up via `runtime.agents.get(agentId)` and used
   * for Layer 2 (role rendering). When omitted, Layer 2 still renders
   * but without role detail.
   */
  agentId?: string;
  /**
   * Optional project. Looked up via `runtime.projects.get(projectId)`
   * and used for Layer 2 (project north-star). When omitted, Layer 2
   * skips the project block.
   */
  projectId?: string;
  /**
   * Optional pre-rendered state-snapshot text for Layer 3. When
   * omitted, Layer 3 is skipped (caller has no prep data — typical for
   * scratch tests).
   */
  snapshotText?: string;
  /** ISO timestamp when the snapshot was taken (best-effort). */
  snapshotAt?: string;
  /**
   * Optional surface override. When provided, replaces
   * activity.surface for Layer 1C filtering. Useful for "show me what
   * the catalog looks like if I narrow to library only" scratch tests.
   */
  surface?: { include?: '*' | string[]; exclude?: string[] };
  /**
   * Synthetic engagement id used inside composePrefix. The composer
   * only reads `.id` for diagnostic logging — the value doesn't affect
   * the rendered output. Defaults to `ctx_<random>`.
   */
  syntheticEngagementId?: string;
}

// ============================================================================
// BlurContext class
// ============================================================================

/**
 * Immutable context container. Construct via the static factories;
 * mutators return new instances.
 */
export class BlurContext {
  private readonly _layers: ReadonlyMap<LayerName, string>;
  private readonly _history: ReadonlyArray<ChatMessage>;

  // Private — use static factories.
  private constructor(
    layers: ReadonlyMap<LayerName, string>,
    history: ReadonlyArray<ChatMessage>,
  ) {
    this._layers = layers;
    this._history = history;
  }

  // ---------------------------------------------------------------------
  // Static factories
  // ---------------------------------------------------------------------

  /**
   * Compose a BlurContext from an Activity (and optional agent/project).
   * Wraps `composePrefix` from prefix-composer.ts.
   *
   * Async because activity / project / agent lookups may hit disk
   * (depending on host pack implementations).
   *
   * If the activity isn't found, returns a context whose 'activity'
   * layer is a placeholder. This is graceful-degradation behaviour for
   * scratch-mode tests — a missing activity shouldn't crash a tuning
   * session. Callers that REQUIRE the activity exist should
   * pre-validate with `runtime.activities.get`.
   */
  static async fromActivity(opts: FromActivityOpts): Promise<BlurContext> {
    const { runtime, activityId, agentId, projectId, snapshotText, snapshotAt, surface } = opts;
    const syntheticEngagementId = opts.syntheticEngagementId ?? `ctx_${randomId()}`;

    // Resolve activity. composePrefix tolerates a null activity (Layer 1B
    // renders a placeholder), so we don't throw on miss.
    const activity = await safeLookup(runtime, 'activities', activityId);

    // Apply surface override if provided. The composer reads from
    // activity.surface, so we shallow-clone and override.
    const activityForCompose = surface && activity
      ? { ...(activity as Record<string, unknown>), surface }
      : activity;

    // Resolve optional project.
    const project = projectId ? await safeLookup(runtime, 'projects', projectId) : null;

    // Resolve optional agent.
    const agent = agentId ? await safeLookup(runtime, 'agents', agentId) : null;

    // Compose. Synthetic engagement shape — only the .id, .activityId,
    // and .scope fields are read by the composer; .scope.ref is what
    // the composer uses to pick the project block in Layer 2, but we
    // pass the project explicitly so .scope can be minimal.
    const composed = composePrefix({
      runtime,
      engagement: {
        id: syntheticEngagementId,
        activityId,
        scope: project ? { kind: 'project', ref: (project as { id: string }).id } : undefined,
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      activity: activityForCompose as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      project: project as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      agent: agent as any,
      snapshotText: snapshotText ?? null,
      snapshotAt: snapshotAt ?? null,
    });

    // Slot into canonical names. Skip empty layers — composer returns
    // empty strings for absent inputs (e.g., no snapshotText → empty
    // layer3). Cleaner to omit them than carry empty entries.
    const layers = new Map<LayerName, string>();
    addIfNonEmpty(layers, 'intro', composed.layers.layer1A_blurIntro);
    addIfNonEmpty(layers, 'activity', composed.layers.layer1B_activityDefinition);
    addIfNonEmpty(layers, 'catalog', composed.layers.layer1C_entityCatalog);
    addIfNonEmpty(layers, 'role', composed.layers.layer2_projectRole);
    addIfNonEmpty(layers, 'state', composed.layers.layer3_stateSnapshot);

    return new BlurContext(layers, []);
  }

  /** Empty context. Caller adds layers via withLayer. */
  static fromScratch(): BlurContext {
    return new BlurContext(new Map(), []);
  }

  /**
   * Single-layer context holding `rawText` as the 'custom-composed'
   * layer. For callers that already have a prefix string (e.g. a
   * back-compat shim wrapping the old dispatch path) and just want to
   * route it through chat.completions.
   */
  static fromComposed(rawText: string): BlurContext {
    const layers = new Map<LayerName, string>();
    if (rawText && rawText.length > 0) {
      layers.set('custom-composed', rawText);
    }
    return new BlurContext(layers, []);
  }

  /**
   * Reconstitute a BlurContext from a snapshot. Used by the
   * chat-completions subsystem when callers pass a snapshot across the
   * script-engine boundary (V8 isolates don't round-trip class
   * instances cleanly).
   */
  static fromSnapshot(snap: BlurContextSnapshot): BlurContext {
    const layers = new Map<LayerName, string>(snap.layers);
    const history = Array.isArray(snap.history) ? snap.history.slice() : [];
    return new BlurContext(layers, history);
  }

  /** Type-guard for snapshot vs live-instance discrimination. */
  static isSnapshot(value: unknown): value is BlurContextSnapshot {
    return !!value
      && typeof value === 'object'
      && (value as { __blurContext?: string }).__blurContext === 'v1';
  }

  // ---------------------------------------------------------------------
  // Accessors
  // ---------------------------------------------------------------------

  /** Layer name → content. Insertion order = render order. */
  get layers(): ReadonlyMap<LayerName, string> {
    return this._layers;
  }

  /** Conversation history (chronological). */
  get history(): ReadonlyArray<ChatMessage> {
    return this._history;
  }

  // ---------------------------------------------------------------------
  // Mutators (return new instances)
  // ---------------------------------------------------------------------

  /**
   * Set or replace a layer. Returns a new instance.
   *
   * If `content` is empty, the layer is dropped (use withoutLayer if
   * intent matters for readability).
   */
  withLayer(name: LayerName, content: string): BlurContext {
    const next = new Map(this._layers);
    if (content && content.length > 0) {
      next.set(name, content);
    } else {
      next.delete(name);
    }
    return new BlurContext(next, this._history);
  }

  /** Remove a layer. No-op if not present. Returns a new instance. */
  withoutLayer(name: LayerName): BlurContext {
    if (!this._layers.has(name)) return this;
    const next = new Map(this._layers);
    next.delete(name);
    return new BlurContext(next, this._history);
  }

  /**
   * Append messages to the conversation history. Returns a new
   * instance. Messages are appended in argument order.
   *
   * Note: the system prefix (layers) is NOT part of history. Callers
   * who want to flatten everything into a single role-tagged stream
   * should use `composeMessages()` which emits the system message
   * first, then history.
   */
  withHistoryAppended(...messages: ChatMessage[]): BlurContext {
    if (messages.length === 0) return this;
    const next = this._history.concat(messages);
    return new BlurContext(this._layers, next);
  }

  /** Clear conversation history. Returns a new instance. */
  withoutHistory(): BlurContext {
    if (this._history.length === 0) return this;
    return new BlurContext(this._layers, []);
  }

  // ---------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------

  /**
   * Flatten layers (newline-joined) then append history rendered as
   * `<role>: <content>` blocks. Used by string-only provider paths
   * (the back-compat shim for providers that haven't migrated to
   * messages arrays yet).
   *
   * Byte-deterministic given identical layer + history contents.
   */
  compose(): string {
    const parts: string[] = [];
    for (const [, content] of this._layers) {
      parts.push(content);
    }
    if (this._history.length > 0) {
      const block = this._history
        .map(m => `${m.role}: ${m.content}`)
        .join('\n\n');
      parts.push(block);
    }
    return parts.join('\n');
  }

  /**
   * Render as an OpenAI-style messages array.
   *
   * Layers are joined into a single `role: 'system'` message — this is
   * the cache-friendly shape (system message hashes separately on most
   * providers). Empty layer-map → no system message emitted.
   *
   * History is appended verbatim.
   */
  composeMessages(): ChatMessage[] {
    const out: ChatMessage[] = [];
    if (this._layers.size > 0) {
      const systemContent: string[] = [];
      for (const [, content] of this._layers) {
        systemContent.push(content);
      }
      out.push({ role: 'system', content: systemContent.join('\n') });
    }
    for (const m of this._history) {
      out.push(m);
    }
    return out;
  }

  /**
   * Inspection helper. Per-layer sizes + SHA-256 hashes, plus an
   * overall hash. Used by tuning UI and cache-discipline audits.
   */
  describe(): BlurContextDescription {
    const layerSizes: Record<LayerName, number> = {};
    const layerHashes: Record<LayerName, string> = {};
    let totalBytes = 0;
    const concatParts: string[] = [];
    for (const [name, content] of this._layers) {
      const bytes = Buffer.byteLength(content, 'utf8');
      layerSizes[name] = bytes;
      layerHashes[name] = sha256Hex(content);
      totalBytes += bytes;
      concatParts.push(content);
    }
    return {
      totalBytes,
      layerCount: this._layers.size,
      historyCount: this._history.length,
      layerSizes,
      layerHashes,
      hash: sha256Hex(concatParts.join('\n')),
    };
  }

  // ---------------------------------------------------------------------
  // Snapshot
  // ---------------------------------------------------------------------

  /**
   * Plain-data snapshot for serialization. Use this when crossing the
   * script-engine boundary (scripts can't see the class instance
   * directly).
   */
  toSnapshot(): BlurContextSnapshot {
    return {
      layers: Array.from(this._layers.entries()),
      history: this._history.slice(),
      __blurContext: 'v1',
    };
  }
}

// ============================================================================
// Helpers
// ============================================================================

function addIfNonEmpty(target: Map<LayerName, string>, name: LayerName, content: string): void {
  if (content && content.length > 0) {
    target.set(name, content);
  }
}

function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

function randomId(): string {
  // 12 hex chars is plenty for synthetic engagement ids (uniqueness
  // only matters within one process — composePrefix doesn't persist).
  return Math.random().toString(16).slice(2, 14);
}

/**
 * Best-effort lookup against a runtime extension namespace. Tolerates
 * missing extensions (returns null) and missing entries (returns null).
 *
 * The async path covers extensions whose .get returns a Promise (e.g.
 * future-async pack APIs); .get returning a value is also accepted.
 */
async function safeLookup(
  runtime: BlurAIRuntime,
  namespace: string,
  id: string,
): Promise<unknown> {
  try {
    const ext = (runtime as unknown as {
      extensions?: { get?: (name: string) => unknown };
    }).extensions?.get?.(namespace) as
      | { get?: (id: string) => unknown | Promise<unknown> }
      | undefined;
    if (!ext || typeof ext.get !== 'function') return null;
    const value = ext.get.call(ext, id);
    if (value && typeof (value as Promise<unknown>).then === 'function') {
      return await (value as Promise<unknown>);
    }
    return value ?? null;
  } catch {
    return null;
  }
}
