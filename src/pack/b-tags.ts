/**
 * b-tags — model↔substrate protocol tag parser + result renderer.
 *
 * Decision 37 — kind-first descriptive tag names. Any `<b:WORD>...</b:WORD>`
 * pair where WORD is a non-empty identifier is recognized; the dispatcher
 * (in engagement-flow-subsystem) decides what to do with each kind by
 * consulting `runtime.tags.resolvers()`:
 *
 *   - `<b:script>` / `<b:s>`  — run via `runtime.script.run` (escape hatch)
 *   - `<b:p>`                  — legacy property read (B_P_RESOLVERS path)
 *   - `<b:project>` / `<b:ticket>` / `<b:library>` / etc. — pack-declared
 *     entity tags resolved via the walker's resolver map
 *
 * File-op tags (`<b:f>`, `<b:fu>`, `<b:fc>`, `<b:fw>`) are reserved by the
 * state-advancement-loop v2 spec but not yet implemented.
 *
 * See `runtime.library.get('state-advancement-loop')` and
 * `runtime.library.get('37-layered-prefix-kind-first-tags')` for context.
 */

// ============================================================================
// Public types
// ============================================================================

/**
 * Tag kind — `b:` followed by the entity kind name (or `script`/`s`/`p` for
 * the verb-style legacy/escape tags). Decision 37 broadened this from a
 * fixed enum to any descriptive name produced by the walker; the dispatcher
 * routes by string match.
 *
 * Position counter is shared across ALL kinds in one model reply so
 * `for="$N"` references resolve unambiguously.
 *
 * Common kinds today:
 *   `b:script` — full runtime.script.run access (escape hatch)
 *   `b:s`      — legacy alias for b:script
 *   `b:p`      — legacy property read (B_P_RESOLVERS map)
 *   `b:project`, `b:ticket`, `b:decision`, `b:library`, `b:engagement`,
 *   `b:agent`, `b:turn` — pack-declared entity tags
 *
 * Reserved for state-advancement-loop v2: `b:f`, `b:fu`, `b:fc`, `b:fw`.
 */
export type BTagKind = string;

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
 * Decision 37: matches any `<b:WORD>...</b:WORD>` where WORD is an
 * identifier (`[a-z][a-z0-9_-]*`). The dispatcher decides what to do
 * with each kind:
 *
 *   - `b:script` / `b:s` — runtime.script.run (escape hatch)
 *   - `b:p`              — legacy property read (B_P_RESOLVERS)
 *   - `b:project`, `b:ticket`, etc. — walker-resolved entity tags
 *
 * Rules:
 *   - Tags execute regardless of whether they're inside ``` fences.
 *     Chat-trained models wrap code in fences by markdown convention;
 *     the common case of fenced tags IS execution intent.
 *   - Self-closing forms (`<b:ticket/>`) are recognized for action-only
 *     tags like `<b:ticket action="list" filter="status:open" />`.
 *   - Order is source order (left-to-right, top-to-bottom).
 *   - Position counter is SHARED across all kinds so `for="$N"` is unique.
 *   - Result tags (`<b:*-result>` / `<b:*-error>`) are deliberately not
 *     matched — they're substrate-produced and matching them would re-
 *     execute already-resolved tags on subsequent iterations.
 *   - Tag names with `-` suffix (so any name ending in `-result` or
 *     `-error`) are dropped by the post-filter. The model is taught not
 *     to emit those, but the filter is defense in depth.
 */
export function parseBTags(source: string): BTag[] {
  const candidates: Array<Omit<BTag, 'position'>> = [];

  // Paired form: <b:WORD attrs>body</b:WORD>
  // WORD must match: [a-z][a-z0-9_-]*
  // The capture group is back-referenced in the close tag for correctness.
  const rePaired = /<b:([a-z][a-z0-9_-]*)((?:\s+[^>]*)?)>([\s\S]*?)<\/b:\1>/g;
  let m: RegExpExecArray | null;
  while ((m = rePaired.exec(source)) !== null) {
    const wordRaw = m[1] ?? '';
    if (isResultTagName(wordRaw)) continue;  // skip <b:*-result>/<b:*-error>
    const kind = `b:${wordRaw}`;
    const isPropertyRead = wordRaw === 'p';
    candidates.push({
      kind,
      attrs: parseAttrs(m[2] ?? ''),
      // <b:p>'s body is a dot-path; trim whitespace. Other tags may carry
      // payload (JSON, value, code) where whitespace might be significant —
      // don't trim those.
      body: isPropertyRead ? (m[3] ?? '').trim() : (m[3] ?? ''),
      startOffset: m.index,
      endOffset: m.index + m[0].length,
    });
  }

  // Self-closing form: <b:WORD attrs/>
  // Common for action-only invocations: <b:ticket action="list" filter="..." />
  const reSelfClosing = /<b:([a-z][a-z0-9_-]*)((?:\s+[^>]*)?)\/>/g;
  while ((m = reSelfClosing.exec(source)) !== null) {
    const wordRaw = m[1] ?? '';
    if (isResultTagName(wordRaw)) continue;
    // Skip if this offset is already covered by a paired tag (regex above)
    // wins because paired tags have more semantic content.
    const offset = m.index;
    if (candidates.some(c => offset >= c.startOffset && offset < c.endOffset)) {
      continue;
    }
    candidates.push({
      kind: `b:${wordRaw}`,
      attrs: parseAttrs(m[2] ?? ''),
      body: '',
      startOffset: offset,
      endOffset: offset + m[0].length,
    });
  }

  // Source-order assignment of 1-based positions.
  candidates.sort((a, b) => a.startOffset - b.startOffset);
  return candidates.map((c, i) => ({ ...c, position: i + 1 }));
}

/**
 * Reserve `<b:*-result>` and `<b:*-error>` for substrate use. The parser
 * skips any tag whose name ends in `-result` or `-error` so the dispatcher
 * never re-executes already-resolved tags on subsequent iterations.
 */
function isResultTagName(word: string): boolean {
  return word.endsWith('-result') || word.endsWith('-error');
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
