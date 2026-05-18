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
 * - Tags inside triple-backtick fenced code blocks are skipped (model
 *   may display tag-shaped text as content).
 * - Self-closing forms (`<b:s/>`) are not recognized in v1.
 * - Order is source order (left-to-right, top-to-bottom).
 */
export function parseBTags(source: string): BTag[] {
  const tags: BTag[] = [];
  const fences = findFenceRanges(source);

  // Match: <b:s ...>body</b:s>
  // Non-greedy body match; supports nested unrelated content but not
  // nested <b:s> (parser is single-level for v1).
  const re = /<b:s((?:\s+[^>]*)?)>([\s\S]*?)<\/b:s>/g;
  let m: RegExpExecArray | null;
  let pos = 1;
  while ((m = re.exec(source)) !== null) {
    const startOffset = m.index;
    if (insideFence(startOffset, fences)) continue;
    tags.push({
      position: pos++,
      kind: 'b:s',
      attrs: parseAttrs(m[1] ?? ''),
      body: m[2] ?? '',
      startOffset,
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

function findFenceRanges(s: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const re = /```[\s\S]*?```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    ranges.push([m.index, m.index + m[0].length]);
  }
  return ranges;
}

function insideFence(offset: number, ranges: Array<[number, number]>): boolean {
  for (const [start, end] of ranges) {
    if (offset >= start && offset < end) return true;
  }
  return false;
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
 *   undefined → empty string
 *   string    → as-is
 *   number / boolean / null → JSON.stringify
 *   object / array → JSON.stringify(value, null, 2) with sorted keys
 */
export function stringifyScriptReturn(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  if (
    value === null ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
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
