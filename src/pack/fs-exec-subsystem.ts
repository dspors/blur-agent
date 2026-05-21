/**
 * FsExecSubsystem — bounded filesystem + child-process primitives.
 *
 * Decision 35. Provides `runtime.fs.{read,write,edit,glob,grep}` and
 * `runtime.exec` for agent personalities (Decision-34 chat.completions
 * chains) that need to touch the filesystem or run commands without
 * routing through the cowork-web-bridge to Claude Code.
 *
 * Every operation goes through a `PermissionPolicy` gate:
 *   - path operations check absolute paths against allow/deny globs
 *   - exec operations check the resolved command against allow/deny
 *     globs (deny wins)
 *   - file size + exec wall-time are capped
 *
 * The substrate-only-runtime principle (Decision 17) is preserved at
 * the script-isolate level — these primitives are the ONLY way through
 * the sandbox. The script runtime itself still has no `require`, no
 * raw `fs`, no network.
 *
 * Edit uses unique-match semantics (same as Claude Code's Edit tool):
 * fails if `oldString` appears 0 times or multiple times when
 * `replaceAll` is false. Prevents accidental clobbering when a model
 * passes a non-unique fragment.
 *
 * Default policy is conservative — refuse unless explicitly allowed.
 * Hosts override via env vars (BLUR_FS_WORKSPACE_ROOT,
 * BLUR_EXEC_ALLOWLIST) or by mutating `runtime.fs.policy` after install.
 *
 * Streaming exec output, b:fs / b:exec verb tags, and per-agent policy
 * overrides are out of scope for v1 (see Decision 35 §Out of scope).
 */

import { readFile, writeFile, readdir, stat, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import * as path from 'node:path';

// ============================================================================
// Public types
// ============================================================================

export interface ReadOpts {
  offset?: number;
  limit?: number;
  encoding?: 'utf8' | 'base64';
}

export interface WriteOpts {
  create?: boolean;      // create file if absent (default true)
  encoding?: 'utf8' | 'base64';
}

export interface EditOpts {
  /** When true, replace every occurrence. Default false (unique-match). */
  replaceAll?: boolean;
}

export interface GlobOpts {
  cwd?: string;
  limit?: number;        // max entries (default 1000)
}

export interface GrepOpts {
  /** Search root. Default: workspaceRoot. */
  path?: string;
  /** Optional file-name glob filter (e.g. all TypeScript files). */
  glob?: string;
  /** Treat pattern as literal string rather than regex. Default false. */
  literal?: boolean;
  /** Max matches (default 500). */
  limit?: number;
  /** Case-insensitive match. */
  ignoreCase?: boolean;
}

export interface ExecOpts {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
  /** Treat `cmd` as already-tokenized when it's an array. */
}

export interface ReadResult {
  content: string;
  bytes: number;
  truncated: boolean;
  encoding: 'utf8' | 'base64';
}

export interface WriteResult {
  bytesWritten: number;
  created: boolean;
}

export interface EditResult {
  replaced: number;
}

export interface GrepHit {
  file: string;
  line: number;
  text: string;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
  killed: boolean;
  /** Resolved command (helpful for audit). */
  cmd: string[];
}

export interface PermissionPolicySnapshot {
  workspaceRoot: string;
  allowedPaths: string[];
  deniedPaths: string[];
  allowedExecCommands: string[];
  deniedExecCommands: string[];
  maxFileBytes: number;
  maxExecMs: number;
}

// ============================================================================
// PermissionDenied error
// ============================================================================

/**
 * Thrown by fs / exec primitives when the policy gate refuses an
 * operation. Caught by the chat.completions tag-execution path and
 * surfaced as a `status: 'error'` tag result with a clear message.
 */
export class PermissionDenied extends Error {
  readonly code = 'PermissionDenied';
  constructor(message: string, readonly detail?: { path?: string; cmd?: string }) {
    super(message);
    this.name = 'PermissionDenied';
  }
}

// ============================================================================
// PermissionPolicy
// ============================================================================

const DEFAULT_DENIED_PATHS = [
  '**/.env',
  '**/.env.*',
  '**/secrets/**',
  '**/.git/objects/**',
  '**/.git/hooks/**',
  '**/id_rsa',
  '**/id_ed25519',
  '**/.ssh/**',
  '**/.aws/**',
];

const DEFAULT_ALLOWED_EXEC = [
  'git',
  'git *',
  'npm',
  'npm *',
  'npx',
  'npx *',
  'node',
  'node *',
  'tsc',
  'tsc *',
  'jest',
  'jest *',
  'pytest',
  'pytest *',
  'ls',
  'ls *',
  'cat',
  'cat *',
  'pwd',
  'wc',
  'wc *',
];

const DEFAULT_DENIED_EXEC = [
  'rm *',
  'rmdir *',
  'sudo *',
  'curl *',
  'wget *',
  'ssh *',
  'scp *',
  'nc *',
  'dd *',
  'kill *',
  'shutdown *',
  'reboot *',
  '* > /dev/*',
];

/**
 * Permission gate for fs + exec. Matches paths and commands against
 * glob patterns; explicit deny always wins over allow.
 *
 * Globs supported: `**` (any dir depth), `*` (any chars within a
 * segment), `?` (one char). Anchored at the full path/command string
 * unless prefixed with a recursive-dir glob for path-anywhere matching.
 */
export class PermissionPolicy {
  workspaceRoot: string;
  allowedPaths: string[];
  deniedPaths: string[];
  allowedExecCommands: string[];
  deniedExecCommands: string[];
  maxFileBytes: number;
  maxExecMs: number;

  constructor(opts: {
    workspaceRoot: string;
    allowedPaths?: string[];
    deniedPaths?: string[];
    allowedExecCommands?: string[];
    deniedExecCommands?: string[];
    maxFileBytes?: number;
    maxExecMs?: number;
  }) {
    this.workspaceRoot = path.resolve(opts.workspaceRoot);
    // Default allow: the workspace root AND everything beneath it.
    // The `/**` alone doesn't match the root itself (only descendants),
    // so glob / grep callers that pass `cwd: workspaceRoot` would be
    // refused. Including the bare root fixes that.
    this.allowedPaths = opts.allowedPaths ?? [
      this.workspaceRoot,
      `${this.workspaceRoot}/**`,
    ];
    this.deniedPaths = opts.deniedPaths ?? DEFAULT_DENIED_PATHS.slice();
    this.allowedExecCommands = opts.allowedExecCommands ?? DEFAULT_ALLOWED_EXEC.slice();
    this.deniedExecCommands = opts.deniedExecCommands ?? DEFAULT_DENIED_EXEC.slice();
    this.maxFileBytes = opts.maxFileBytes ?? 4 * 1024 * 1024;
    this.maxExecMs = opts.maxExecMs ?? 60_000;
  }

  /**
   * Check whether a (resolved absolute) path may be read/written.
   * Returns `{ allowed: false, reason }` when denied; `{ allowed: true }`
   * when permitted. Mode is informational for now — policy applies
   * uniformly to read and write in v1.
   */
  checkPath(absPath: string, _mode: 'read' | 'write'): { allowed: boolean; reason?: string } {
    if (!path.isAbsolute(absPath)) {
      return { allowed: false, reason: `path must be absolute (got '${absPath}')` };
    }
    // Deny first — explicit deny always wins.
    for (const p of this.deniedPaths) {
      if (matchGlob(p, absPath)) {
        return { allowed: false, reason: `path matches deny pattern '${p}'` };
      }
    }
    for (const p of this.allowedPaths) {
      if (matchGlob(p, absPath)) {
        return { allowed: true };
      }
    }
    return {
      allowed: false,
      reason: `path '${absPath}' is outside workspace root '${this.workspaceRoot}' (no allow pattern matched)`,
    };
  }

  /**
   * Check whether a command may be exec'd. `cmd` is the joined command
   * line (`"git status"`, `"npm test --silent"`).
   */
  checkExec(cmdLine: string): { allowed: boolean; reason?: string } {
    const trimmed = cmdLine.trim();
    if (!trimmed) return { allowed: false, reason: 'empty command' };
    for (const p of this.deniedExecCommands) {
      if (matchGlob(p, trimmed)) {
        return { allowed: false, reason: `command matches deny pattern '${p}'` };
      }
    }
    for (const p of this.allowedExecCommands) {
      if (matchGlob(p, trimmed)) {
        return { allowed: true };
      }
    }
    return {
      allowed: false,
      reason: `command '${trimmed.slice(0, 80)}' not in allow list — add to runtime.fs.policy.allowedExecCommands if intended`,
    };
  }

  toSnapshot(): PermissionPolicySnapshot {
    return {
      workspaceRoot: this.workspaceRoot,
      allowedPaths: this.allowedPaths.slice(),
      deniedPaths: this.deniedPaths.slice(),
      allowedExecCommands: this.allowedExecCommands.slice(),
      deniedExecCommands: this.deniedExecCommands.slice(),
      maxFileBytes: this.maxFileBytes,
      maxExecMs: this.maxExecMs,
    };
  }
}

// ============================================================================
// FsExecSubsystem
// ============================================================================

export class FsExecSubsystem {
  readonly policy: PermissionPolicy;

  constructor(opts: { policy: PermissionPolicy }) {
    this.policy = opts.policy;
  }

  // ---------------------------------------------------------------------
  // fs.read
  // ---------------------------------------------------------------------

  async read(filePath: string, opts: ReadOpts = {}): Promise<ReadResult> {
    const absPath = this.resolvePath(filePath);
    const gate = this.policy.checkPath(absPath, 'read');
    if (!gate.allowed) throw new PermissionDenied(`fs.read: ${gate.reason}`, { path: absPath });

    const encoding = opts.encoding ?? 'utf8';
    const buf = await readFile(absPath);
    const bytes = buf.byteLength;
    const cap = this.policy.maxFileBytes;
    let slice: Buffer;
    let truncated = false;

    // Apply offset / limit at byte level (works for both encodings).
    const start = Math.max(0, opts.offset ?? 0);
    const end = Math.min(bytes, start + (opts.limit ?? Math.max(0, bytes - start)));
    slice = buf.subarray(start, end);

    if (slice.byteLength > cap) {
      slice = slice.subarray(0, cap);
      truncated = true;
    }

    const content = encoding === 'base64'
      ? slice.toString('base64')
      : slice.toString('utf8');

    return {
      content,
      bytes: slice.byteLength,
      truncated: truncated || (end < bytes),
      encoding,
    };
  }

  // ---------------------------------------------------------------------
  // fs.write
  // ---------------------------------------------------------------------

  async write(filePath: string, content: string, opts: WriteOpts = {}): Promise<WriteResult> {
    const absPath = this.resolvePath(filePath);
    const gate = this.policy.checkPath(absPath, 'write');
    if (!gate.allowed) throw new PermissionDenied(`fs.write: ${gate.reason}`, { path: absPath });

    const encoding = opts.encoding ?? 'utf8';
    const buf = encoding === 'base64'
      ? Buffer.from(content, 'base64')
      : Buffer.from(content, 'utf8');

    if (buf.byteLength > this.policy.maxFileBytes) {
      throw new Error(
        `fs.write: content size ${buf.byteLength} exceeds maxFileBytes ${this.policy.maxFileBytes}`,
      );
    }

    const create = opts.create ?? true;
    const existed = existsSync(absPath);
    if (!existed && !create) {
      throw new Error(`fs.write: file does not exist and create=false: ${absPath}`);
    }

    // Ensure parent dir exists when creating.
    if (!existed) {
      await mkdir(path.dirname(absPath), { recursive: true });
    }

    await writeFile(absPath, buf);
    return { bytesWritten: buf.byteLength, created: !existed };
  }

  // ---------------------------------------------------------------------
  // fs.edit — unique-match semantics
  // ---------------------------------------------------------------------

  async edit(filePath: string, oldString: string, newString: string, opts: EditOpts = {}): Promise<EditResult> {
    if (oldString === newString) {
      throw new Error('fs.edit: oldString and newString must differ');
    }
    if (oldString.length === 0) {
      throw new Error('fs.edit: oldString must be non-empty');
    }
    const absPath = this.resolvePath(filePath);
    const gateR = this.policy.checkPath(absPath, 'read');
    if (!gateR.allowed) throw new PermissionDenied(`fs.edit (read): ${gateR.reason}`, { path: absPath });
    const gateW = this.policy.checkPath(absPath, 'write');
    if (!gateW.allowed) throw new PermissionDenied(`fs.edit (write): ${gateW.reason}`, { path: absPath });

    const current = await readFile(absPath, 'utf8');
    const replaceAll = !!opts.replaceAll;

    if (replaceAll) {
      // Replace every occurrence (escape-free split-join).
      const parts = current.split(oldString);
      if (parts.length === 1) {
        throw new Error(`fs.edit: oldString not found in ${absPath}`);
      }
      const next = parts.join(newString);
      await writeFile(absPath, next, 'utf8');
      return { replaced: parts.length - 1 };
    }

    // Unique-match. Fail if 0 occurrences. Fail if >1 occurrences.
    const firstIdx = current.indexOf(oldString);
    if (firstIdx < 0) {
      throw new Error(`fs.edit: oldString not found in ${absPath}`);
    }
    const secondIdx = current.indexOf(oldString, firstIdx + 1);
    if (secondIdx >= 0) {
      throw new Error(
        `fs.edit: oldString matches multiple times in ${absPath}; pass replaceAll: true or provide more surrounding context`,
      );
    }
    const next = current.slice(0, firstIdx) + newString + current.slice(firstIdx + oldString.length);
    await writeFile(absPath, next, 'utf8');
    return { replaced: 1 };
  }

  // ---------------------------------------------------------------------
  // fs.glob
  // ---------------------------------------------------------------------

  async glob(pattern: string, opts: GlobOpts = {}): Promise<string[]> {
    const cwd = path.resolve(opts.cwd ?? this.policy.workspaceRoot);
    const gate = this.policy.checkPath(cwd, 'read');
    if (!gate.allowed) throw new PermissionDenied(`fs.glob: ${gate.reason}`, { path: cwd });
    const limit = Math.min(opts.limit ?? 1000, 10_000);
    const hits: string[] = [];
    await walkDir(cwd, async (absPath, rel) => {
      if (hits.length >= limit) return false;
      if (matchGlob(pattern, rel) || matchGlob(pattern, absPath)) {
        const pathGate = this.policy.checkPath(absPath, 'read');
        if (pathGate.allowed) hits.push(absPath);
      }
      return true;
    });
    return hits;
  }

  // ---------------------------------------------------------------------
  // fs.grep
  // ---------------------------------------------------------------------

  async grep(pattern: string, opts: GrepOpts = {}): Promise<GrepHit[]> {
    const root = path.resolve(opts.path ?? this.policy.workspaceRoot);
    const gate = this.policy.checkPath(root, 'read');
    if (!gate.allowed) throw new PermissionDenied(`fs.grep: ${gate.reason}`, { path: root });
    const limit = Math.min(opts.limit ?? 500, 5000);
    const fileGlob = opts.glob;
    const literal = !!opts.literal;
    const flags = opts.ignoreCase ? 'i' : '';
    const rx = literal
      ? new RegExp(escapeRegex(pattern), flags)
      : new RegExp(pattern, flags);

    const hits: GrepHit[] = [];
    await walkDir(root, async (absPath, rel) => {
      if (hits.length >= limit) return false;
      if (fileGlob && !matchGlob(fileGlob, rel) && !matchGlob(fileGlob, absPath)) return true;
      const pathGate = this.policy.checkPath(absPath, 'read');
      if (!pathGate.allowed) return true;
      // Skip large binary files (>1MB) heuristically — grep is for text.
      try {
        const s = await stat(absPath);
        if (s.size > 1 * 1024 * 1024) return true;
        if (!s.isFile()) return true;
      } catch { return true; }
      let content: string;
      try {
        content = await readFile(absPath, 'utf8');
      } catch { return true; }
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (rx.test(lines[i])) {
          hits.push({ file: absPath, line: i + 1, text: lines[i].slice(0, 400) });
          if (hits.length >= limit) return false;
        }
      }
      return true;
    });
    return hits;
  }

  // ---------------------------------------------------------------------
  // exec
  // ---------------------------------------------------------------------

  async exec(cmd: string | string[], opts: ExecOpts = {}): Promise<ExecResult> {
    const argv = Array.isArray(cmd) ? cmd.slice() : tokenize(cmd);
    if (argv.length === 0) throw new Error('exec: empty command');
    const joined = argv.join(' ');
    const gate = this.policy.checkExec(joined);
    if (!gate.allowed) throw new PermissionDenied(`exec: ${gate.reason}`, { cmd: joined });

    const cwd = opts.cwd ? this.resolvePath(opts.cwd) : this.policy.workspaceRoot;
    const cwdGate = this.policy.checkPath(cwd, 'read');
    if (!cwdGate.allowed) throw new PermissionDenied(`exec cwd: ${cwdGate.reason}`, { path: cwd });

    const timeoutMs = Math.min(opts.timeoutMs ?? this.policy.maxExecMs, this.policy.maxExecMs);
    const startedAt = Date.now();

    return new Promise<ExecResult>((resolve, reject) => {
      const child = spawn(argv[0], argv.slice(1), {
        cwd,
        env: { ...process.env, ...(opts.env ?? {}) },
        shell: false,
        windowsHide: true,
      });

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let killed = false;
      let settled = false;

      const stdoutBytesCap = this.policy.maxFileBytes;
      const stderrBytesCap = this.policy.maxFileBytes;
      let stdoutBytes = 0;
      let stderrBytes = 0;

      child.stdout?.on('data', (b: Buffer) => {
        stdoutBytes += b.byteLength;
        if (stdoutBytes <= stdoutBytesCap) stdoutChunks.push(b);
      });
      child.stderr?.on('data', (b: Buffer) => {
        stderrBytes += b.byteLength;
        if (stderrBytes <= stderrBytesCap) stderrChunks.push(b);
      });

      const timer = setTimeout(() => {
        if (settled) return;
        killed = true;
        try { child.kill('SIGTERM'); } catch { /* swallow */ }
        // SIGKILL fallback after 1s.
        setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* swallow */ } }, 1000);
      }, timeoutMs);

      const onAbort = (): void => {
        if (settled) return;
        killed = true;
        try { child.kill('SIGTERM'); } catch { /* swallow */ }
      };
      opts.abortSignal?.addEventListener('abort', onAbort);

      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        opts.abortSignal?.removeEventListener('abort', onAbort);
        reject(err);
      });

      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        opts.abortSignal?.removeEventListener('abort', onAbort);
        resolve({
          stdout: Buffer.concat(stdoutChunks).toString('utf8'),
          stderr: Buffer.concat(stderrChunks).toString('utf8'),
          exitCode: code,
          durationMs: Date.now() - startedAt,
          killed,
          cmd: argv,
        });
      });
    });
  }

  // ---------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------

  /** Resolve a possibly-relative path against the workspace root. */
  private resolvePath(p: string): string {
    if (path.isAbsolute(p)) return path.normalize(p);
    return path.resolve(this.policy.workspaceRoot, p);
  }
}

// ============================================================================
// Glob matching — minimatch-style subset
// ============================================================================

/**
 * Match a path against a glob pattern. Supports:
 *   - `**` — any number of segments (including zero)
 *   - `*`  — any chars within a segment (no `/`)
 *   - `?`  — one char
 *
 * Backslashes are normalized to forward slashes before matching so
 * the same patterns work on Windows.
 *
 * Anchored — pattern must match the whole input. Use a recursive-dir
 * prefix (two stars then slash) to match anywhere.
 */
function matchGlob(pattern: string, input: string): boolean {
  const p = pattern.replace(/\\/g, '/');
  const s = input.replace(/\\/g, '/');
  const rx = globToRegex(p);
  return rx.test(s);
}

function globToRegex(pattern: string): RegExp {
  // Tokenize the pattern.
  let rx = '^';
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') {
      // `**` — any depth. If followed by `/`, consume it (zero-dir match).
      if (pattern[i + 2] === '/') {
        rx += '(?:.*/)?';
        i += 3;
      } else {
        rx += '.*';
        i += 2;
      }
    } else if (c === '*') {
      rx += '[^/]*';
      i += 1;
    } else if (c === '?') {
      rx += '[^/]';
      i += 1;
    } else if ('+()[]{}^$.\\|'.includes(c)) {
      rx += '\\' + c;
      i += 1;
    } else {
      rx += c;
      i += 1;
    }
  }
  rx += '$';
  return new RegExp(rx);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ============================================================================
// Directory walking — recursive, prunes deep node_modules / .git
// ============================================================================

const ALWAYS_PRUNE = new Set(['node_modules', '.git', 'dist', '.next', '.cache']);

async function walkDir(
  root: string,
  visit: (absPath: string, relPath: string) => Promise<boolean | void>,
): Promise<void> {
  async function recurse(dir: string): Promise<boolean> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch { return true; }
    for (const ent of entries) {
      const abs = path.join(dir, ent.name);
      const rel = path.relative(root, abs);
      if (ent.isDirectory()) {
        if (ALWAYS_PRUNE.has(ent.name)) continue;
        const cont = await recurse(abs);
        if (cont === false) return false;
      } else if (ent.isFile()) {
        const cont = await visit(abs, rel);
        if (cont === false) return false;
      }
    }
    return true;
  }
  await recurse(root);
}

// ============================================================================
// Command tokenizer
// ============================================================================

/**
 * Simple whitespace tokenizer with quote support. Used for the string
 * form of exec — `exec("npm test --silent")` becomes
 * `['npm', 'test', '--silent']`. Quoted segments preserve spaces:
 * `exec('git commit -m "hello world"')`.
 */
function tokenize(cmd: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (c === '\\' && i + 1 < cmd.length) {
      cur += cmd[i + 1];
      i += 1;
      continue;
    }
    if (c === "'" && !inDouble) { inSingle = !inSingle; continue; }
    if (c === '"' && !inSingle) { inDouble = !inDouble; continue; }
    if (!inSingle && !inDouble && /\s/.test(c)) {
      if (cur.length > 0) { out.push(cur); cur = ''; }
      continue;
    }
    cur += c;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}
