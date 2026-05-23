/**
 * Verb-style b:tag resolvers — operation tags (HTTP, browser, ...) that
 * sit OUTSIDE the runtime.tagWalker entity-resolver model.
 *
 * Phase 4 (checkpoint-f → next). The existing walker model is built
 * around action-on-entity dispatch (read/list/count/update/invoke on
 * b:project, b:ticket, b:library, ...). Verb tags don't have entities;
 * they describe operations. Forcing them through the entity model
 * stretches it past usefulness, so we add a parallel, in-pack dispatch
 * table here and let chat-completions-subsystem.executeTag consult it
 * before falling through to engagement-flow's resolveGenericTag.
 *
 * v1 catalog:
 *   - b:http-fetch          (real)
 *   - b:browser-navigate    (stub — backend pending)
 *   - b:browser-click       (stub)
 *   - b:browser-type        (stub)
 *   - b:browser-screenshot  (stub)
 *   - b:browser-read        (stub)
 *
 * Stubs return a structured `{ ok: false, error: '...' }` so the
 * model sees a meaningful "not yet implemented" instead of "unknown
 * tag kind". The allowlist check upstream (Phase 3) recognizes these
 * kinds as legitimate, which lets services declare bundle gates that
 * include browser tools today even though execution lands later.
 *
 * Credential substitution runs BEFORE this resolver dispatches
 * (chat-completions-subsystem.ts inserts substituted bodies/attrs
 * into the tag passed here), so `${alias}` placeholders in url/headers/
 * body just work.
 */

import type { BTag } from './b-tags';

// ============================================================================
// Public types
// ============================================================================

export interface VerbTagResult {
  ok: boolean;
  value?: unknown;
  error?: string;
}

export type VerbTagResolver = (tag: BTag) => Promise<VerbTagResult>;

// ============================================================================
// Registry
// ============================================================================

/**
 * Verb-tag dispatch table. Lookup is by full kind string (with `b:` prefix)
 * so chat-completions-subsystem can do a single `in` check.
 */
export const VERB_TAG_RESOLVERS: Record<string, VerbTagResolver> = {
  'b:http-fetch': httpFetchResolver,
  'b:browser-navigate': stubBrowserResolver('navigate'),
  'b:browser-click': stubBrowserResolver('click'),
  'b:browser-type': stubBrowserResolver('type'),
  'b:browser-screenshot': stubBrowserResolver('screenshot'),
  'b:browser-read': stubBrowserResolver('read'),
};

/** True when the given tag.kind is a registered verb tag. */
export function isVerbTag(kind: string): boolean {
  return Object.prototype.hasOwnProperty.call(VERB_TAG_RESOLVERS, kind);
}

/** Snapshot of verb-tag kinds — for diagnostics + allowlist composition checks. */
export function listVerbTags(): string[] {
  return Object.keys(VERB_TAG_RESOLVERS).sort();
}

// ============================================================================
// Resolvers
// ============================================================================

const BROWSER_BACKEND_PENDING =
  'browser backend not yet implemented — Phase 4 stub (engine selection pending; see ' +
  'blur-intelligence-services-and-solve-design Brief)';

function stubBrowserResolver(op: string): VerbTagResolver {
  return async (_tag: BTag) => ({
    ok: false,
    error: `b:browser-${op}: ${BROWSER_BACKEND_PENDING}`,
  });
}

/**
 * Real b:http-fetch via Node's global fetch (Node 18+).
 *
 * Attributes:
 *   url        (required)        absolute URL
 *   method     (optional)        defaults to GET; uppercased
 *   headers    (optional)        JSON object string OR "k:v,k:v" form
 *   timeoutMs  (optional)        per-request timeout; default 30_000
 *
 * Body:
 *   tag.body (trimmed) is sent as-is for non-GET/HEAD methods. We don't
 *   auto-JSON-parse — callers control content-type via the headers attr.
 *
 * Result value shape (ok=true):
 *   { status, statusText, headers, body, bytes, ms, url }
 *
 * Result value shape (ok=false):
 *   { error: '<message>' } — already structured; chat.completions renders it.
 *
 * Note: response body is read as text. Binary payloads land as
 * lossy strings; callers that need raw bytes should fall back to b:script.
 * Body length is bounded by the existing 8KB tag-result truncation cap
 * in renderTagResult.
 */
async function httpFetchResolver(tag: BTag): Promise<VerbTagResult> {
  const url = tag.attrs.url;
  if (!url || typeof url !== 'string') {
    return { ok: false, error: 'b:http-fetch requires url="..." attribute' };
  }
  const method = (tag.attrs.method ?? 'GET').toUpperCase();
  const timeoutMs = parseTimeout(tag.attrs.timeoutMs ?? tag.attrs.timeout) ?? 30_000;
  const headers = parseHeaders(tag.attrs.headers);
  const body =
    method === 'GET' || method === 'HEAD'
      ? undefined
      : tag.body && tag.body.length > 0
        ? tag.body
        : undefined;

  if (typeof fetch !== 'function') {
    return { ok: false, error: 'b:http-fetch requires global fetch (Node 18+); not available on host' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const resp = await fetch(url, {
      method,
      headers,
      body,
      signal: controller.signal,
    });
    const respHeaders: Record<string, string> = {};
    resp.headers.forEach((v, k) => {
      respHeaders[k] = v;
    });
    const text = await resp.text();
    const ms = Date.now() - startedAt;
    return {
      ok: true,
      value: {
        status: resp.status,
        statusText: resp.statusText,
        headers: respHeaders,
        body: text,
        bytes: Buffer.byteLength(text, 'utf8'),
        ms,
        url: resp.url,
      },
    };
  } catch (err) {
    const ms = Date.now() - startedAt;
    const e = err as Error;
    const aborted =
      e.name === 'AbortError' ||
      (typeof e.message === 'string' && e.message.toLowerCase().includes('abort'));
    return {
      ok: false,
      error: aborted
        ? `b:http-fetch timed out after ${timeoutMs}ms (waited ${ms}ms)`
        : `b:http-fetch failed: ${e.message ?? String(e)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

// ============================================================================
// Helpers
// ============================================================================

function parseTimeout(v: string | undefined): number | null {
  if (!v) return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Parse the headers attr. Accepts either:
 *   - a JSON object string: `headers='{"X-Foo":"bar"}'`
 *   - a comma-separated k:v list: `headers="X-Foo:bar,X-Baz:qux"`
 *
 * Returns undefined when input is missing or yields no entries.
 */
function parseHeaders(raw: string | undefined): Record<string, string> | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  // JSON form
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof v === 'string') out[k] = v;
        }
        return Object.keys(out).length > 0 ? out : undefined;
      }
    } catch {
      // fall through to k:v parsing
    }
  }

  // k:v,k:v form
  const out: Record<string, string> = {};
  for (const pair of trimmed.split(',')) {
    const ix = pair.indexOf(':');
    if (ix < 0) continue;
    const k = pair.slice(0, ix).trim();
    const v = pair.slice(ix + 1).trim();
    if (k && v) out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
