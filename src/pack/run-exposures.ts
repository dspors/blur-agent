import type { MethodExposure } from 'blur-ai-runtime';

export const runExposures: MethodExposure[] = [
  {
    objectPath: 'runners',
    method: 'file',
    primitivePath: 'runners.file',
    signature:
      "(opts: { title: string; briefSlug?: string; prompt?: string; forRef?: { kind: string; ref: string }; filedBy: string; scope?: 'runtime' | 'project' | 'pack' | 'track'; tags?: string[] }): Runner",
    description:
      "File a new Runner (status: queued). Represents a unit of work to be executed by a Claude bridge session (v0.1; future engines plug in via Runner interface).",
    sideEffect: 'write',
    category: 'primary',
  },
  {
    objectPath: 'runners',
    method: 'get',
    primitivePath: 'runners.get',
    signature: '(id: string): Runner | null',
    description: 'Fetch a Runner by id (including transcript and prompt).',
    sideEffect: 'read',
    category: 'primary',
  },
  {
    objectPath: 'runners',
    method: 'list',
    primitivePath: 'runners.list',
    signature:
      "(opts?: { status?: RunnerStatus | RunnerStatus[] | 'all'; scope?: RunnerScope; forRef?: { kind: string; ref: string }; limit?: number }): RunnerSummary[]",
    description:
      "List Runners. Default status surfaces 'queued', 'running', 'paused'.",
    sideEffect: 'read',
    category: 'primary',
  },
  {
    objectPath: 'runners',
    method: 'bind',
    primitivePath: 'runners.bind',
    signature: "(id: string, opts: { bridgeSessionId: string }): Runner",
    description:
      "Bind a queued/paused Runner to a bridge session — marks status='running'. v0.1: manual binding (human/UI starts the session, then binds). Future: Conductor automates the spawn+bind.",
    sideEffect: 'write',
    category: 'primary',
  },
  {
    objectPath: 'runners',
    method: 'pause',
    primitivePath: 'runners.pause',
    signature: '(id: string): Runner',
    description: "Pause a running Runner.",
    sideEffect: 'write',
    category: 'support',
  },
  {
    objectPath: 'runners',
    method: 'markCompleted',
    primitivePath: 'runners.markCompleted',
    signature:
      "(id: string, opts?: { outcome?: string; transcript?: string; by?: string }): Runner",
    description:
      "Mark a Runner completed (positive exit). Optionally record final outcome and transcript. Emits runners.completed.",
    sideEffect: 'write',
    category: 'primary',
  },
  {
    objectPath: 'runners',
    method: 'markFailed',
    primitivePath: 'runners.markFailed',
    signature: '(id: string, opts: { reason: string; by?: string }): Runner',
    description: 'Mark a Runner failed. Emits runners.failed.',
    sideEffect: 'write',
    category: 'primary',
  },
  {
    objectPath: 'runners',
    method: 'setTranscript',
    primitivePath: 'runners.setTranscript',
    signature: '(id: string, transcript: string): Runner',
    description:
      "Attach a transcript snapshot. Typically called by Secretary at session-end (or mid-flight sync). Emits runners.transcript-synced.",
    sideEffect: 'write',
    category: 'support',
  },
  {
    objectPath: 'runners',
    method: 'takeaways',
    primitivePath: 'runners.takeaways',
    signature:
      "(opts?: { scope?: RunnerScope; format?: 'list' | 'prose' }): string",
    description:
      "Flat list of active (queued / running / paused) Runners. For context injection.",
    sideEffect: 'read',
    category: 'primary',
  },
];
