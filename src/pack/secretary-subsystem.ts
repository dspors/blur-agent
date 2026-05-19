/**
 * SecretarySubsystem — host object mounted at runtime.secretary.
 *
 * Implements the Secretary role from
 * blur-agent/library/architecture/role-secretary.md.
 *
 * v0.1 PRIMARY TASK: transcript shuttling — copy Claude session
 * transcripts into Blur Runner records at session-end (and optionally
 * mid-flight). This lets the Runner identity persist independently of
 * session lifecycle (compaction, end, replacement).
 *
 * v0.1 SCOPE:
 *   - syncTranscript(runnerId, transcript) — accepts the transcript as
 *     a string argument. The caller (UI / human / Claude session that
 *     just finished) supplies it. Bridge-driven automatic pull is a
 *     future enhancement.
 *   - archiveRunner(runnerId, opts) — finalize a Runner: ensures the
 *     transcript is recorded and calls markCompleted on the Runner.
 *   - listPendingArchive() — Runners that have ended but whose transcript
 *     has not yet been synced. Driver loop reads this and processes.
 *
 * The Secretary is a CONDUCTOR-class role — it's an AI session running a
 * Secretary prompt that watches lifecycle events and acts. In v0.1, the
 * subsystem exposes the methods; the AI-session loop that calls them
 * gets implemented later. Until then, humans/UI call these methods
 * directly. Bootstrap pattern.
 */

import type { BlurAIRuntime } from 'blur-ai-runtime';

import type { RunSubsystem, RunnerSummary } from './run-subsystem';

export interface SyncTranscriptOpts {
  by?: string;       // who initiated (sessionId, 'system', 'human')
  mode?: 'append' | 'replace';
}

export interface ArchiveRunnerOpts {
  outcome?: string;
  transcript?: string;
  by?: string;
}

export class SecretarySubsystem {
  private runtime: BlurAIRuntime | null = null;
  private runs: RunSubsystem | null = null;

  attachRuntime(runtime: BlurAIRuntime): void { this.runtime = runtime; }

  /** Wired in install() — Secretary needs the Run subsystem to update transcripts. */
  attachRuns(runs: RunSubsystem): void { this.runs = runs; }

  /**
   * Sync (write/append) a Claude session transcript into a Runner.
   * v0.1: transcript supplied as argument. Future: Bridge-driven pull.
   */
  syncTranscript(runnerId: string, transcript: string, opts: SyncTranscriptOpts = {}): void {
    if (!this.runs) throw new Error('secretary: not attached to Run subsystem');
    if (typeof transcript !== 'string') {
      throw new Error('secretary.syncTranscript: transcript must be a string');
    }
    const mode = opts.mode ?? 'replace';
    const runner = this.runs.get(runnerId);
    if (!runner) throw new Error(`secretary: runner not found: ${runnerId}`);
    const next = mode === 'append'
      ? (runner.transcript ?? '') + transcript
      : transcript;
    this.runs.setTranscript(runnerId, next);
    this.emit('secretary.transcript-synced', {
      runnerId, by: opts.by ?? 'system', length: next.length, mode,
    });
  }

  /**
   * Finalize a Runner: optionally take a transcript and outcome,
   * mark the Runner completed.
   */
  archiveRunner(runnerId: string, opts: ArchiveRunnerOpts = {}): void {
    if (!this.runs) throw new Error('secretary: not attached to Run subsystem');
    const runner = this.runs.get(runnerId);
    if (!runner) throw new Error(`secretary: runner not found: ${runnerId}`);
    if (typeof opts.transcript === 'string') {
      this.syncTranscript(runnerId, opts.transcript, { by: opts.by, mode: 'replace' });
    }
    this.runs.markCompleted(runnerId, {
      outcome: opts.outcome,
      by: opts.by ?? 'secretary',
    });
    this.emit('secretary.archived', { runnerId, by: opts.by ?? 'system' });
  }

  /**
   * Runners that may need transcript sync. v0.1 returns running +
   * paused Runners; refine when we have a clearer "needs-sync" signal
   * from the bridge.
   */
  listPendingArchive(): RunnerSummary[] {
    if (!this.runs) return [];
    return this.runs.list({ status: ['running', 'paused'] });
  }

  private emit(kind: string, data: Record<string, unknown>): void {
    if (!this.runtime) return;
    try {
      const audit = (this.runtime as unknown as { audit?: { emit?: (e: unknown) => void } }).audit;
      audit?.emit?.({ kind, data });
    } catch (err) {
      console.warn(`[secretary] audit emit failed for ${kind}:`, (err as Error).message);
    }
  }
}
