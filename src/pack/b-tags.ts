/**
 * b-tags — model↔substrate protocol tag parser + result renderer.
 *
 * v1 scope (this commit): `<b:s>` script tags only. File ops
 * (`<b:f>`, `<b:fu>`, `<b:fc>`, `<b:fw>`) are reserved by the spec
 * but unimplemented in v1.
 *
 * See `runtime.library.get('state-advancement-loop')` for the full
 * protocol.
 */

// ============================================================================
// Public types
// ============================================================================

export type BTagKind = 'b:s'; // v1: scripts only

export interface BTag {
  /** 1-based position across all extracted tags in source order. */
  position: number;
  kind: BTagKind;
  /** Parsed attributes. Single- or double-quoted; bare values supported. */
  attrs: Record<string, string>;
  /** Raw inner content between open and close tags. */
  body: string;
  /** Source offset of the opening `<`. */
  startOffset: number;
  /** Source offset immediately after the closing `>`. */
  endOffset: number;
}

export type TagResultStatus = 'ok' | 'error' | 'truncated';

/** Result body max before truncation marker. */
const RESULT_BODY_CAP_BYTES = 8192;

// ============================================================================
// Parser
// ============================================================================

/**
 * Extract `<b:*>` tags from a model reply.
 *
 * - Only `<b:s>...</b:s>` recognized in v1 (others are reserved).
 * - Tags are executed **regardless of whether they're inside ``` fences**.
 *   The original design treated fenced tags as content-only ("the model
 *   wants to display tag-shaped text without running it"), but chat-
 *   trained models (llama3.1, etc.) wrap code in fences by markdown
 *   convention — the "common case" of fenced tags IS execution intent.
 *   If we ever need a display-only escape, we'll teach the model a
 *   different one (HTML-style entity encoding or a `lang=blur-display`
 *   fence marker).
 * - Self-closing forms (`<b:s/>`) are not recognized in v1.
 * - Order is source order (left-to-right, top-to-bottom).
 */
export function parseBTags(source: string): BTag[] {
  const tags: BTag[] = [];

  // Match: <b:s ...>body</b:s>
  // Non-greedy body match; supports nested unrelated content but not
  // nested <b:s> (parser is single-level for v1).
  const re = /<b:s((?:\s+[^>]*)?)>([\s\S]*?)<\/b:s>/g;
  let m: RegExpExecArray | null;
  let pos = 1;
  while ((m = re.exec(source)) !== null) {
    tags.push({
      position: pos++,
      kind: 'b:s',
      attrs: parseAttrs(m[1] ?? ''),
      body: m[2] ?? '',
      startOffset: m.index,
      endOffset: m.index + m[0].length,
    });
  }
  return tags;
}

/**
 * Parse attribute string from inside `<b:s ...>`. Supports:
 *   name="value"
 *   name='value'
 *   name=value      (bare; ends at whitespace or `>`)
 */
function parseAttrs(attrString: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([\w][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(attrString)) !== null) {
    out[m[1]!] = m[2] ?? m[3] ?? m[4] ?? '';
  }
  return out;
}

// ============================================================================
// Result rendering
// ============================================================================

/**
 * Render a `<b:s-result>` (or `<b:s-error>`) for the given tag and
 * outcome. Truncates body at RESULT_BODY_CAP_BYTES and appends a
 * `<truncated original-size="N"/>` marker when over.
 */
export function renderTagResult(
  tag: BTag,
  status: TagResultStatus | 'error',
  body: string,
): string {
  const tagName = status === 'error' ? 'b:s-error' : 'b:s-result';
  let safeBody = body;
  if (safeBody.length > RESULT_BODY_CAP_BYTES) {
    safeBody =
      safeBody.slice(0, RESULT_BODY_CAP_BYTES) +
      `\n<truncated original-size="${body.length}"/>`;
  }
  return `<${tagName} for="$${tag.position}">${safeBody}</${tagName}>`;
}

/**
 * Serialize a script's return value for inclusion in a `<b:s-result>`
 * body. Rules:
 *   undefined → '(undefined — script returned no value)'
 *   null      → 'null'  (JSON-encoded)
 *   string    → as-is, with empty-string disambiguation
 *   number / boolean → JSON.stringify
 *   object / array → JSON.stringify(value, null, 2) with sorted keys
 *
 * Why disambiguate undefined / empty-string:
 *   v1 returned '' for undefined → the `<b:s-result>` body was empty →
 *   small models (llama3.1:8b observed) hallucinated that the script
 *   errored. Explicit "(undefined — …)" makes the outcome unambiguous
 *   and removes a class of model confusion.
 */
export function stringifyScriptReturn(value: unknown): string {
  if (value === undefined) return '(undefined — script returned no value)';
  if (value === null) return 'null';
  if (typeof value === 'string') {
    return value === '' ? '(empty string)' : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  // Object / array: stable serialization via sorted-key replacer.
  return stableStringify(value, 2);
}

function stableStringify(obj: unknown, indent: number): string {
  return JSON.stringify(obj, (_key, val) => {
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(val).sort()) {
        sorted[k] = (val as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return val;
  }, indent);
}
