/**
 * Scheduler routing — override-chain resolver for Decision 36 step 2.
 *
 * Pure function `resolveDispatch(...)` that walks the layered
 * precedence chain and produces a concrete `(providerKind, modelRef,
 * providerModelId, source)` for one `scheduler.requestTurn` call.
 * The Scheduler consumes the result to stamp the Ticket and thread
 * the model down to the provider at dispatch time.
 *
 * Resolution chain (highest precedence first):
 *
 *   1. opts.pin                     — per-call hard pin ('source: pin')
 *   2. opts.activityTable lookup    — caller-supplied table for this Activity
 *   3. engagement.runtimeModel      — per-engagement pin (step 1)
 *   4. system Activity Table        — from runtime.activityRouting (step 2)
 *   5. baseline                     — DEFAULT_BASELINE_MODELREF
 *
 * For (2) and (4), Mode determines how the entry resolves:
 *   - Mode='always': use entry.default unconditionally
 *   - Mode='auto':   use entry.default; if opts.complexity === 'specialized',
 *                    delegate to AI-Choose (v1: stub returns default; surfaced
 *                    via aiChooseStub callback for future replacement)
 *   - Mode='ai':     always AI-Choose
 *
 * For (2) and (4), if entry.outcomes[opts.outcome] is set, it overrides
 * entry.default (per the v1 doc Activity Table shape).
 *
 * Resolved modelRef is then looked up in the Model Table to get the
 * concrete providerKind + providerModelId. If lookup fails, falls
 * through to the next chain layer (per blur-providers' "v1: no
 * validation" contract) and records the missed lookup in the
 * rationale string.
 *
 * Pure: no I/O, no side effects, no dependency on runtime state
 * beyond what's passed in via the input bundle. Easy to unit-test.
 */

import type { Ticket } from './ticket-types';

// ---------------------------------------------------------------------------
// Types — minimal duplicates of what the resolver consumes so this file has
// no hard dependency on the substrate. Callers pass plain objects.
// ---------------------------------------------------------------------------

export type RoutingMode = 'always' | 'auto' | 'ai';

export interface ActivityRoutingEntry {
  activityId: string;
  mode: RoutingMode;
  default: string | null;
  outcomes?: Record<string, string>;
}

export interface ModelRowLite {
  modelRef: string;
  providerKind: string;
  providerModelId: string;
}

export type SelectionSource =
  | 'pin'                  // opts.pin won
  | 'caller-table'         // opts.activityTable matched
  | 'engagement'           // engagement.runtimeModel matched
  | 'activity-default'     // system Activity Table matched
  | 'ai-choose'            // AI-Choose router was consulted (v1: stub returns default)
  | 'baseline';            // fell all the way through

export interface ResolvedDispatch {
  modelRef: string;
  providerKind: string;
  /**
   * Provider-native id passed verbatim to provider.sendMessage's
   * `req.model`. Resolved from the Model Table when modelRef matches;
   * otherwise `null` (caller can decide whether to fall through or
   * pass `req.model` undefined to let the provider use its default).
   */
  providerModelId: string | null;
  source: SelectionSource;
  /**
   * One-line human-readable reason for analytics. Shows up on the
   * Ticket and ticket-issued audit. Examples:
   *   "opts.pin: together/gpt-oss-120b"
   *   "activity-default: general → mode=always → local/gpt-oss-20b"
   *   "fell through: no Activity entry for 'unknown'; baseline applied"
   */
  rationale: string;
}

export interface ResolveDispatchInput {
  opts: {
    pin?: string;
    activityTable?: Record<string, ActivityRoutingEntry>;
    complexity?: 'routine' | 'specialized';
    outcome?: string;
  };
  /** The engagement being dispatched against — only runtimeModel + activityId are read. */
  engagement: {
    activityId: string;
    runtimeModel?: string;
  };
  /**
   * System Activity Table — keyed by activityId. Pass `null` when the
   * config-tables subsystem isn't loaded (substrate boot before pack
   * install would have empty tables anyway).
   */
  systemActivityTable: Map<string, ActivityRoutingEntry> | null;
  /**
   * Model Table — used to resolve a modelRef → (providerKind, providerModelId).
   * Pass `null` when not loaded; resolver returns providerModelId=null
   * for unresolved refs and downstream decides.
   */
  modelTable: Map<string, ModelRowLite> | null;
  /**
   * Baseline modelRef to fall through to. Defaults to
   * `DEFAULT_BASELINE_MODELREF` ('bridge/claude-sonnet') if omitted.
   * The Scheduler may override per deployment.
   */
  baselineModelRef?: string;
  /**
   * AI-Choose callback. v1: ignored or returns the Activity default.
   * The contract is here so step 3a can wire a real AI router without
   * a resolver-API change. When unset and Mode=auto+specialized or
   * Mode=ai trigger, falls through to the Activity default (or
   * baseline if no default).
   */
  aiChooseStub?: (ctx: AIChooseContext) => string | null;
}

export interface AIChooseContext {
  reason: 'auto-specialized' | 'mode-ai';
  activityId: string;
  outcome?: string;
  /** The Activity entry that triggered AI-Choose (so the router can read its default + outcomes). */
  entry: ActivityRoutingEntry;
}

export const DEFAULT_BASELINE_MODELREF = 'bridge/claude-sonnet';

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

export function resolveDispatch(input: ResolveDispatchInput): ResolvedDispatch {
  const baseline = input.baselineModelRef ?? DEFAULT_BASELINE_MODELREF;

  // (1) per-call pin — highest precedence
  if (typeof input.opts.pin === 'string' && input.opts.pin.length > 0) {
    return wrap(input, input.opts.pin, 'pin', `opts.pin: ${input.opts.pin}`);
  }

  // (2) caller-supplied Activity Table — merges caller-wins per Activity
  const callerEntry = input.opts.activityTable?.[input.engagement.activityId];
  if (callerEntry) {
    const fromCaller = resolveFromEntry(callerEntry, input.opts, input.aiChooseStub, 'caller-table');
    if (fromCaller) {
      return wrap(input, fromCaller.modelRef, fromCaller.source, fromCaller.rationale);
    }
  }

  // (3) engagement.runtimeModel — per-engagement pin
  if (typeof input.engagement.runtimeModel === 'string' && input.engagement.runtimeModel.length > 0) {
    return wrap(
      input,
      input.engagement.runtimeModel,
      'engagement',
      `engagement.runtimeModel: ${input.engagement.runtimeModel}`,
    );
  }

  // (4) system Activity Table
  const systemEntry = input.systemActivityTable?.get(input.engagement.activityId);
  if (systemEntry) {
    const fromSystem = resolveFromEntry(systemEntry, input.opts, input.aiChooseStub, 'activity-default');
    if (fromSystem) {
      return wrap(input, fromSystem.modelRef, fromSystem.source, fromSystem.rationale);
    }
  }

  // (5) baseline
  return wrap(input, baseline, 'baseline', `fell through: no Activity entry; baseline applied`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface EntryResolution {
  modelRef: string;
  source: SelectionSource;
  rationale: string;
}

function resolveFromEntry(
  entry: ActivityRoutingEntry,
  opts: ResolveDispatchInput['opts'],
  aiChooseStub: ResolveDispatchInput['aiChooseStub'],
  tableLabel: 'caller-table' | 'activity-default',
): EntryResolution | null {
  // outcome-specific override (within an entry, outcomes win over default)
  if (opts.outcome && entry.outcomes && entry.outcomes[opts.outcome]) {
    const m = entry.outcomes[opts.outcome];
    return {
      modelRef: m,
      source: tableLabel,
      rationale: `${tableLabel}: ${entry.activityId} → outcome=${opts.outcome} → ${m}`,
    };
  }

  // Mode-driven resolution
  switch (entry.mode) {
    case 'always':
      if (!entry.default) return null;
      return {
        modelRef: entry.default,
        source: tableLabel,
        rationale: `${tableLabel}: ${entry.activityId} → mode=always → ${entry.default}`,
      };

    case 'auto':
      if (opts.complexity === 'specialized') {
        const picked = aiChooseStub?.({
          reason: 'auto-specialized',
          activityId: entry.activityId,
          outcome: opts.outcome,
          entry,
        }) ?? entry.default;
        if (!picked) return null;
        return {
          modelRef: picked,
          source: aiChooseStub ? 'ai-choose' : tableLabel,
          rationale: aiChooseStub
            ? `${tableLabel}: ${entry.activityId} → mode=auto+specialized → AI-Choose picked ${picked}`
            : `${tableLabel}: ${entry.activityId} → mode=auto+specialized (no AI-Choose; fell back to default ${picked})`,
        };
      }
      if (!entry.default) return null;
      return {
        modelRef: entry.default,
        source: tableLabel,
        rationale: `${tableLabel}: ${entry.activityId} → mode=auto (routine) → ${entry.default}`,
      };

    case 'ai': {
      const picked = aiChooseStub?.({
        reason: 'mode-ai',
        activityId: entry.activityId,
        outcome: opts.outcome,
        entry,
      }) ?? entry.default;
      if (!picked) return null;
      return {
        modelRef: picked,
        source: aiChooseStub ? 'ai-choose' : tableLabel,
        rationale: aiChooseStub
          ? `${tableLabel}: ${entry.activityId} → mode=ai → AI-Choose picked ${picked}`
          : `${tableLabel}: ${entry.activityId} → mode=ai (no AI-Choose; fell back to default ${picked})`,
      };
    }

    default:
      return null;
  }
}

/**
 * Final wrap — resolve modelRef → providerKind + providerModelId via
 * the Model Table. If lookup misses, we still return the selection with
 * providerModelId=null + a rationale note; the caller (Scheduler) can
 * then decide whether to dispatch anyway or fall through.
 */
function wrap(
  input: ResolveDispatchInput,
  modelRef: string,
  source: SelectionSource,
  rationale: string,
): ResolvedDispatch {
  const row = input.modelTable?.get(modelRef);
  if (row) {
    return {
      modelRef,
      providerKind: row.providerKind,
      providerModelId: row.providerModelId,
      source,
      rationale,
    };
  }
  // Unknown ref — parse `<providerKind>/<...>` for the providerKind hint
  // so the Scheduler can at least decide whether to dispatch.
  const slash = modelRef.indexOf('/');
  const providerKindHint = slash > 0 ? modelRef.slice(0, slash) : 'unknown';
  return {
    modelRef,
    providerKind: providerKindHint,
    providerModelId: null,
    source,
    rationale: `${rationale} (modelRef not in Model Table; providerModelId unresolved)`,
  };
}

// ---------------------------------------------------------------------------
// Helpers for the Scheduler — stamp a ResolvedDispatch onto a Ticket
// ---------------------------------------------------------------------------

/**
 * Apply the resolved selection to a (mutable) Ticket. Sets the new
 * fields (selectedModelRef, selectionSource, selectionRationale) and
 * the existing `model` field. Keeps `providerKind` consistent with
 * the agent's actual provider kind (which the Scheduler validates
 * separately — pin-fallback fires when they disagree).
 *
 * Note: Ticket.selectionSource is typed as `string` (not SelectionSource)
 * to keep the ticket-types module free of a dependency on this file;
 * the value is always one of the SelectionSource literals.
 */
export function stampResolutionOnTicket(ticket: Ticket, resolved: ResolvedDispatch): void {
  ticket.selectedModelRef = resolved.modelRef;
  ticket.selectionSource = resolved.source;
  ticket.selectionRationale = resolved.rationale;
  if (resolved.providerModelId) {
    ticket.model = resolved.providerModelId;
  }
}
