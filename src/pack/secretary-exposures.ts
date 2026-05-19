import type { MethodExposure } from 'blur-ai-runtime';

export const secretaryExposures: MethodExposure[] = [
  {
    objectPath: 'secretary',
    method: 'syncTranscript',
    primitivePath: 'secretary.syncTranscript',
    signature:
      "(runnerId: string, transcript: string, opts?: { by?: string; mode?: 'append' | 'replace' }): void",
    description:
      "Sync a Claude session transcript into the Runner record. v0.1 accepts the transcript as an argument (caller supplies); Bridge-driven automatic pull is future. Mode: 'replace' (default) or 'append'. Emits secretary.transcript-synced.",
    sideEffect: 'write',
    category: 'primary',
  },
  {
    objectPath: 'secretary',
    method: 'archiveRunner',
    primitivePath: 'secretary.archiveRunner',
    signature:
      "(runnerId: string, opts?: { outcome?: string; transcript?: string; by?: string }): void",
    description:
      "Finalize a Runner at session-end: optional transcript sync, mark completed. Emits secretary.archived.",
    sideEffect: 'write',
    category: 'primary',
  },
  {
    objectPath: 'secretary',
    method: 'listPendingArchive',
    primitivePath: 'secretary.listPendingArchive',
    signature: '(): RunnerSummary[]',
    description:
      "Runners that may need transcript sync. v0.1 returns running + paused; refine when a clearer 'needs-sync' signal exists.",
    sideEffect: 'read',
    category: 'primary',
  },
];
