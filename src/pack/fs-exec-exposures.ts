/**
 * Exposures for FsExecSubsystem (Decision 35).
 *
 * Mounted at `runtime.fs.*` and `runtime.exec`. Each primitive goes
 * through a `PermissionPolicy` gate — paths must match allowedPaths,
 * commands must match allowedExecCommands. Failures surface as
 * `PermissionDenied` errors with clear messages.
 */

import type { MethodExposure } from 'blur-ai-runtime';

export const fsExposures: MethodExposure[] = [
  {
    objectPath: 'fs',
    method: 'read',
    primitivePath: 'fs.read',
    signature:
      "(path: string, opts?: { offset?: number; limit?: number; encoding?: 'utf8' | 'base64' }): Promise<{ content: string; bytes: number; truncated: boolean; encoding: 'utf8' | 'base64' }>",
    description:
      'Read a file. Path is resolved against workspaceRoot if relative. Allowlist-gated — paths outside workspaceRoot (or matching deniedPaths like **/.env, **/secrets/**, **/.ssh/**) raise PermissionDenied. Encoding defaults to utf8; pass base64 for binary. Capped at policy.maxFileBytes (default 4MB) — larger content is truncated and truncated=true is returned. Supports offset+limit for ranged reads.',
    sideEffect: 'read',
    example: "const r = await runtime.fs.read('src/index.ts');",
    category: 'primary',
  },
  {
    objectPath: 'fs',
    method: 'write',
    primitivePath: 'fs.write',
    signature:
      "(path: string, content: string, opts?: { create?: boolean; encoding?: 'utf8' | 'base64' }): Promise<{ bytesWritten: number; created: boolean }>",
    description:
      'Write a file. Path is resolved against workspaceRoot if relative. Allowlist-gated — paths outside workspaceRoot raise PermissionDenied. Parent directory created on demand. Content size capped at policy.maxFileBytes. Encoding defaults to utf8; pass base64 for binary.',
    sideEffect: 'write',
    example: "await runtime.fs.write('docs/notes.md', '# Title\\n');",
    category: 'primary',
  },
  {
    objectPath: 'fs',
    method: 'edit',
    primitivePath: 'fs.edit',
    signature:
      "(path: string, oldString: string, newString: string, opts?: { replaceAll?: boolean }): Promise<{ replaced: number }>",
    description:
      'In-place edit with unique-match semantics. Throws if oldString is not found OR appears multiple times (when replaceAll is false). Same pattern as Claude Code Edit — prevents accidental clobbering when a model passes a non-unique fragment. Pass replaceAll: true for batch rename / refactor across the file.',
    sideEffect: 'write',
    example:
      "await runtime.fs.edit('src/foo.ts', 'const old = 1;', 'const newName = 1;');",
    category: 'primary',
  },
  {
    objectPath: 'fs',
    method: 'glob',
    primitivePath: 'fs.glob',
    signature:
      "(pattern: string, opts?: { cwd?: string; limit?: number }): Promise<string[]>",
    description:
      'Find files matching a glob pattern. Supports ** (any depth), * (any chars within segment), ? (one char). Default cwd is workspaceRoot. Skips node_modules, .git, dist, .next, .cache by default. Capped at opts.limit (default 1000, max 10000). Returns absolute paths.',
    sideEffect: 'read',
    example:
      "const files = await runtime.fs.glob('**/*.ts', { limit: 200 });",
    category: 'primary',
  },
  {
    objectPath: 'fs',
    method: 'grep',
    primitivePath: 'fs.grep',
    signature:
      "(pattern: string, opts?: { path?: string; glob?: string; literal?: boolean; limit?: number; ignoreCase?: boolean }): Promise<Array<{ file: string; line: number; text: string }>>",
    description:
      'Recursive grep. Pattern is a regex by default — pass literal: true for plain-string search. Optional glob filter narrows the file set. Returns up to limit hits (default 500, max 5000). Skips files > 1 MB and binary content heuristically. Each hit: { file, line, text } where text is the matching line (truncated to 400 chars).',
    sideEffect: 'read',
    example:
      "const hits = await runtime.fs.grep('TODO', { glob: '**/*.ts', limit: 50 });",
    category: 'primary',
  },
  {
    objectPath: 'fs',
    method: 'snapshotPolicy',
    primitivePath: 'fs.snapshotPolicy',
    signature:
      "(): { workspaceRoot: string; allowedPaths: string[]; deniedPaths: string[]; allowedExecCommands: string[]; deniedExecCommands: string[]; maxFileBytes: number; maxExecMs: number }",
    description:
      "Inspect the current permission policy. Read-only snapshot — to mutate the policy, hosts modify runtime.fs.policy directly (substrate-side access; not exposed to scripts).",
    sideEffect: 'read',
    category: 'support',
  },
];

export const execExposures: MethodExposure[] = [
  {
    objectPath: 'exec',
    method: 'run',
    primitivePath: 'exec.run',
    signature:
      "(cmd: string | string[], opts?: { cwd?: string; env?: Record<string,string>; timeoutMs?: number; abortSignal?: AbortSignal }): Promise<{ stdout: string; stderr: string; exitCode: number | null; durationMs: number; killed: boolean; cmd: string[] }>",
    description:
      "Run a child process. String form is whitespace-tokenized (with quote support: 'git commit -m \"msg\"'). Array form bypasses tokenization. Allowlist-gated — commands must match allowedExecCommands (deny patterns checked first; deny always wins). cwd defaults to workspaceRoot. Timeout capped at policy.maxExecMs (default 60s). No shell interpretation by default. Stdout / stderr capped at policy.maxFileBytes.",
    sideEffect: 'external',
    example:
      "const r = await runtime.exec.run('npm test --silent');",
    category: 'primary',
  },
];
