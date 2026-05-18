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

/**
 * Supported tag kinds. The position counter is shared across all kinds
 * in one model reply so `for="$N"` references resolve unambiguously.
 *
 *   `b:s` — script (full runtime.script.run access)
 *   `b:p` — property read (host-side entity lookup + dot-path walk)
 *
 * Reserved (not yet implemented): `b:f`, `b:fu`, `b:fc`, `b:fw`, `b:l`, `b:c`.
 */
export type BTagKind = 'b:s' | 'b:p';

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
 * - Currently recognized: `<b:s>` (script) and `<b:p>` (property read).
 * - Tags are executed **regardless of whether they're inside ``` fences**.
 *   Chat-trained models (llama3.1, etc.) wrap code in fences by markdown
 *   convention; the common case of fenced tags IS execution intent.
 * - Self-closing forms (`<b:s/>`) are not recognized in v1.
 * - Order is source order (left-to-right, top-to-bottom).
 * - Position counter is SHARED across all kinds so `for="$N"` is unique.
 */
export function parseBTags(source: string): BTag[] {
  // Collect all candidate matches (each kind by its own regex), then
  // sort by source offset to get global source order, then number.
  const candidates: Array<Omit<BTag, 'position'>> = [];

  // <b:s ...>body</b:s> — script
  const reS = /<b:s((?:\s+[^>]*)?)>([\s\S]*?)<\/b:s>/g;
  let m: RegExpExecArray | null;
  while ((m = reS.exec(source)) !== null) {
    candidates.push({
      kind: 'b:s',
      attrs: parseAttrs(m[1] ?? ''),
      body: m[2] ?? '',
      startOffset: m.index,
      endOffset: m.index + m[0].length,
    });
  }

  // <b:p e="kind:id">path</b:p> — property read.
  // Attributes are required (must include `e`); body is the dot-path.
  const reP = /<b:p((?:\s+[^>]*)?)>([\s\S]*?)<\/b:p>/g;
  while ((m = reP.exec(source)) !== null) {
    candidates.push({
      kind: 'b:p',
      attrs: parseAttrs(m[1] ?? ''),
      body: (m[2] ?? '').trim(),
      startOffset: m.index,
      endOffset: m.index + m[0].length,
    });
  }

  // Source-order assignment of 1-based positions.
  candidates.sort((a, b) => a.startOffset - b.startOffset);
  return candidates.map((c, i) => ({ ...c, position: i + 1 }));
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
 * Render a result envelope for the given tag and outcome. Truncates
 * body at RESULT_BODY_CAP_BYTES and appends a `<truncated …/>` marker
 * when over.
 *
 * Result tag naming convention: `<b:<kind-suffix>-result>` for ok,
 * `<b:<kind-suffix>-error>` for error. Kinds:
 *   b:s → b:s-result / b:s-error
 *   b:p → b:p-result / b:p-error
 */
export function renderTagResult(
  tag: BTag,
  status: TagResultStatus | 'error',
  body: string,
): string {
  const kindSuffix = tag.kind.slice('b:'.length); // 's' or 'p'
  const tagName =
    status === 'error' ? `b:${kindSuffix}-error` : `b:${kindSuffix}-result`;
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
