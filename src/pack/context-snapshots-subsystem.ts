/**
 * ContextSnapshotsSubsystem — named storage for BlurContextSnapshot
 * values, used by the workbench Context panel and any other caller
 * that wants to save / load a BlurContext by name.
 *
 * Runner Spec: runner-spec-workbench-context-builder-v1 (Phase 1B).
 *
 * Shape: in-process Map<name, { snapshot, savedAt }> with Persistable
 * backing so saved snapshots survive `runtime.packs.reload('blur-agent')`
 * and process restart (Decision 20).
 *
 * This subsystem is folded into the `runtime.context` host object —
 * see pack/index.ts. Mounting under `context` keeps the script-facing
 * namespace clean (`runtime.context.snapshots.save`) while letting
 * Pack-Manager's Persistable auto-detection pick up the storage.
 */

import { createHash } from 'node:crypto';

import type { Persistable } from 'blur-ai-runtime';

import type { BlurContextSnapshot } from './blur-context';
import { BlurContext } from './blur-context';

const SCHEMA_VERSION = 'v1';
const MAX_NAME_LEN = 120;

interface StoredEntry {
  snapshot: BlurContextSnapshot;
  savedAt: string;
}

interface PersistedShape {
  version: string;
  entries: Record<string, StoredEntry>;
}

export interface SnapshotListEntry {
  name: string;
  hash: string;
  layerCount: number;
  historyCount: number;
  totalBytes: number;
  savedAt: string;
}

export interface SaveResult {
  name: string;
  hash: string;
  savedAt: string;
}

export class ContextSnapshotsSubsystem implements Persistable {
  private readonly byName = new Map<string, StoredEntry>();
  private _dirty = false;

  /**
   * Save a snapshot under `name`. Overwrites if present. Returns the
   * computed hash + savedAt timestamp.
   */
  save(name: string, snapshot: BlurContextSnapshot): SaveResult {
    this.assertValidName(name);
    if (!BlurContext.isSnapshot(snapshot)) {
      throw new Error(
        'context.snapshots.save: argument is not a BlurContextSnapshot',
      );
    }
    const savedAt = new Date().toISOString();
    this.byName.set(name, { snapshot, savedAt });
    this._dirty = true;
    return {
      name,
      hash: this.hashOf(snapshot),
      savedAt,
    };
  }

  /** Load a snapshot by name. Returns null if not present. */
  load(name: string): BlurContextSnapshot | null {
    this.assertValidName(name);
    const entry = this.byName.get(name);
    if (!entry) return null;
    // Defensive deep-copy: BlurContextSnapshot is plain JSON, and we
    // don't want callers mutating our cached copy.
    return JSON.parse(JSON.stringify(entry.snapshot)) as BlurContextSnapshot;
  }

  /**
   * List saved snapshots — metadata only (no full snapshot bodies).
   * Sorted by savedAt descending (most-recent first).
   */
  list(): SnapshotListEntry[] {
    const out: SnapshotListEntry[] = [];
    for (const [name, entry] of this.byName) {
      const desc = BlurContext.fromSnapshot(entry.snapshot).describe();
      out.push({
        name,
        hash: desc.hash,
        layerCount: desc.layerCount,
        historyCount: desc.historyCount,
        totalBytes: desc.totalBytes,
        savedAt: entry.savedAt,
      });
    }
    out.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
    return out;
  }

  /** Delete a snapshot. Returns whether one existed. */
  delete(name: string): { existed: boolean } {
    this.assertValidName(name);
    const existed = this.byName.delete(name);
    if (existed) this._dirty = true;
    return { existed };
  }

  // ---------------------------------------------------------------------
  // Persistable (Decision 20)
  // ---------------------------------------------------------------------

  saveJson(): string {
    const entries: Record<string, StoredEntry> = {};
    for (const [name, entry] of this.byName) {
      entries[name] = entry;
    }
    const persisted: PersistedShape = {
      version: SCHEMA_VERSION,
      entries,
    };
    return JSON.stringify(persisted);
  }

  loadJson(s: string): void {
    if (!s || typeof s !== 'string') return;
    let parsed: PersistedShape;
    try {
      parsed = JSON.parse(s) as PersistedShape;
    } catch (err) {
      console.warn(
        `[context.snapshots] loadJson: parse failed — ${(err as Error).message}; starting empty`,
      );
      return;
    }
    if (!parsed || parsed.version !== SCHEMA_VERSION || !parsed.entries) return;
    this.byName.clear();
    for (const [name, entry] of Object.entries(parsed.entries)) {
      if (!entry || !BlurContext.isSnapshot(entry.snapshot)) continue;
      this.byName.set(name, entry);
    }
    this._dirty = false;
  }

  consumeDirty(): boolean {
    const d = this._dirty;
    this._dirty = false;
    return d;
  }

  // ---------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------

  private assertValidName(name: string): void {
    if (typeof name !== 'string' || name.length === 0) {
      throw new Error('context.snapshots: name must be a non-empty string');
    }
    if (name.length > MAX_NAME_LEN) {
      throw new Error(
        `context.snapshots: name exceeds ${MAX_NAME_LEN} chars`,
      );
    }
    if (/[\\/\x00-\x1f]/.test(name)) {
      throw new Error(
        'context.snapshots: name may not contain path separators or control chars',
      );
    }
  }

  private hashOf(snapshot: BlurContextSnapshot): string {
    return BlurContext.fromSnapshot(snapshot).describe().hash;
  }
}

/**
 * Test/debug helper — exposes hashing in a static surface so callers
 * who hold raw snapshots can reproduce the stored hash without
 * roundtripping through save().
 */
export function hashSnapshot(snapshot: BlurContextSnapshot): string {
  return createHash('sha256')
    .update(snapshot.layers.map(([, c]) => c).join('\n'), 'utf8')
    .digest('hex');
}
