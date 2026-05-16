/**
 * AISchedulerAlgorithm — AI-driven oversight on top of the deterministic
 * SchedulerAlgorithm.
 *
 * Pattern: wrap a base algorithm. pickAgent() always returns the base
 * decision SYNCHRONOUSLY (so the existing scheduler machinery is
 * unchanged and assignment latency stays bounded). On the side, an
 * async consultation fires to a leased Scheduler agent for review.
 * The consultation's verdict is emitted as an audit event
 * (`agents.scheduler.ai-verdict`) — observation-only in v0; never
 * overrides the deterministic decision.
 *
 * Forward direction (v1+ — captured here so we don't lose the shape):
 *
 *   - Cache verdicts by `(activityKind, requiredRole, agentId)` tuples.
 *     Use them as input to the NEXT decision: if the AI flagged this
 *     assignment as 'suboptimal' last time, try a different agent now.
 *
 *   - Promote 'wrong' verdicts to actually unassign + requeue. Needs a
 *     reassign primitive on SchedulerSubsystem (cancel current
 *     assignment, push back to queued status, tryAssign).
 *
 *   - Replace the simple "first scheduler agent" pick with a load-aware
 *     choice (use the Scheduler agent that's least busy with current
 *     consultations).
 *
 *   - Add a routing-policy-mutation primitive that the Scheduler agent
 *     can call. Verdicts then drive dynamic routing changes
 *     ('reroute scheduler-tick to bridge when together is rate-limited').
 *
 *   - Tune consultation throttling: today every call fires; sensible
 *     batching by activityKind drops cost ~10x without losing signal.
 *
 * Why this shape NOW (Daniel's intent: "we may rework it but let's not
 * lose it"):
 *
 *   - The wrapper-over-base pattern means we can run the deterministic
 *     algorithm forever if AI is unavailable. No new failure modes.
 *
 *   - The async-side consultation prepares the substrate for closing
 *     the loop later. The audit event is the data feed; we just need
 *     to start writing into it now to have signal when we want to act
 *     on it.
 *
 *   - The default-disabled posture means production behavior is
 *     unchanged unless a session explicitly calls
 *     `scheduler.useAIOptimizer()` — exercises the path in smoke +
 *     experiments without forcing it on real workflows.
 */

import type {
  RoutingPolicyEntry,
  WorkItem,
} from './scheduler-types';
import type { Agent } from './types';
import type { AgentsSubsystem } from './agents-subsystem';
import type { SchedulerAlgorithm } from './scheduler-subsystem';

interface RuntimeShape {
  audit?: {
    emit?: (e: { kind: string; ref?: string; data?: Record<string, unknown> }) => void;
  };
}

export interface AIAlgorithmOpts {
  /**
   * Skip consultation for items above this priority. UI-driven work
   * (priority 100) typically wants immediate assignment; background
   * AI-only work (priority <50) is where AI review is worth the latency.
   * Default: 90 — skip only the very-highest priority.
   */
  consultPriorityCeiling?: number;

  /**
   * Skip consultation for these activity kinds. Belt-and-braces against
   * the obvious recursion ('scheduler-tick' itself shouldn't trigger
   * a consultation; the Scheduler agent runs scheduler-tick).
   * Default: ['scheduler-tick'].
   */
  skipActivityKinds?: string[];

  /**
   * Per-call consultation timeout. Beyond this the verdict is recorded
   * as 'timeout' and the deterministic decision stands (which it would
   * have anyway). Default: 10_000 ms.
   */
  consultTimeoutMs?: number;

  /**
   * Optional Scheduler agent id to consult. When unset, the wrapper
   * picks the first idle agent with role='scheduler'. Useful for tests.
   */
  schedulerAgentId?: string;
}

export type AIVerdict =
  | 'ok'           // assignment was reasonable; no action
  | 'suboptimal'   // a better option existed but the gap is small
  | 'wrong'        // assignment is materially worse than alternatives
  | 'no-agent'     // no Scheduler agent was leased; skipped
  | 'timeout'      // consultation didn't return in time
  | 'parse-error'; // couldn't parse the agent's reply

export interface AIVerdictRecord {
  workItemId: string;
  agentId: string;            // who the deterministic algorithm picked
  baseReason: string;         // the deterministic reason
  verdict: AIVerdict;
  comment?: string;           // free-text from the Scheduler agent
  recommendedAgentId?: string;
  durationMs: number;
  at: string;
}

/**
 * Construct an AI-augmented SchedulerAlgorithm. Wraps a base
 * deterministic algorithm; consults a leased Scheduler agent for
 * review of each non-skipped decision.
 */
export function aiSchedulerAlgorithm(
  base: SchedulerAlgorithm,
  agents: AgentsSubsystem,
  runtime: RuntimeShape,
  opts: AIAlgorithmOpts = {},
): SchedulerAlgorithm {
  const priorityCeiling = opts.consultPriorityCeiling ?? 90;
  const skipKinds = new Set(opts.skipActivityKinds ?? ['scheduler-tick']);
  const consultTimeoutMs = opts.consultTimeoutMs ?? 10_000;

  return {
    pickAgent(
      workItem: WorkItem,
      candidates: Agent[],
      busy: Set<string>,
      routingPolicy: ReadonlyMap<string, RoutingPolicyEntry>,
    ): { agentId: string; reason: string } | null {
      const decision = base.pickAgent(workItem, candidates, busy, routingPolicy);
      if (!decision) return null; // no decision → nothing to consult about

      // Skip rules.
      const activityKind = workItem.contextScope?.activityKind;
      if (workItem.priority >= priorityCeiling) {
        return decision;
      }
      if (activityKind && skipKinds.has(activityKind)) {
        return decision;
      }

      // Fire-and-forget consultation. Errors are caught + emitted as
      // audit events; they never affect the returned decision.
      consultScheduler({
        workItem,
        candidates,
        decision,
        agents,
        runtime,
        consultTimeoutMs,
        schedulerAgentId: opts.schedulerAgentId,
      }).catch(() => { /* swallow — audit captures errors */ });

      return decision;
    },
  };
}

/** Run one consultation against a Scheduler agent. */
async function consultScheduler(opts: {
  workItem: WorkItem;
  candidates: Agent[];
  decision: { agentId: string; reason: string };
  agents: AgentsSubsystem;
  runtime: RuntimeShape;
  consultTimeoutMs: number;
  schedulerAgentId?: string;
}): Promise<void> {
  const startMs = Date.now();
  const { workItem, candidates, decision, agents, runtime, consultTimeoutMs } = opts;

  // Pick a Scheduler agent. Explicit id wins; otherwise first active.
  let schedulerAgent: Agent | undefined;
  if (opts.schedulerAgentId) {
    const a = agents.get(opts.schedulerAgentId);
    if (a && a.status === 'active') schedulerAgent = a;
  } else {
    const pool = agents.list({ role: 'scheduler', status: 'active' });
    schedulerAgent = pool[0];
  }
  if (!schedulerAgent) {
    emitVerdict(runtime, {
      workItemId: workItem.id,
      agentId: decision.agentId,
      baseReason: decision.reason,
      verdict: 'no-agent',
      durationMs: Date.now() - startMs,
      at: new Date().toISOString(),
    });
    return;
  }

  const prompt = buildPrompt(workItem, candidates, decision);

  let replyText: string;
  try {
    const reply = await agents.sendText(schedulerAgent.id, prompt);
    const final = await reply.await({ timeoutMs: consultTimeoutMs });
    replyText = final.text;
  } catch {
    emitVerdict(runtime, {
      workItemId: workItem.id,
      agentId: decision.agentId,
      baseReason: decision.reason,
      verdict: 'timeout',
      durationMs: Date.now() - startMs,
      at: new Date().toISOString(),
    });
    return;
  }

  const parsed = parseVerdict(replyText, candidates);
  emitVerdict(runtime, {
    workItemId: workItem.id,
    agentId: decision.agentId,
    baseReason: decision.reason,
    verdict: parsed.verdict,
    comment: parsed.comment,
    recommendedAgentId: parsed.recommendedAgentId,
    durationMs: Date.now() - startMs,
    at: new Date().toISOString(),
  });
}

/**
 * Build the consultation prompt. Tight by design — Scheduler agents
 * should run on cheap providers (Together by default), so we don't
 * waste tokens. Schema is JSON-strict to make parsing reliable.
 */
function buildPrompt(
  workItem: WorkItem,
  candidates: Agent[],
  decision: { agentId: string; reason: string },
): string {
  const candidateLines = candidates.map(c => {
    const provider = c.provider?.kind ?? 'unknown';
    const session = c.sessionId ? c.sessionId.slice(0, 16) : '<none>';
    return `  - ${c.id}: role=${c.role}, provider=${provider}, session=${session}, leasedAt=${c.leasedAt}`;
  }).join('\n');

  return [
    "You are reviewing a scheduler assignment decision. Respond with",
    "STRICT JSON only — no prose before or after. Shape:",
    '  { "verdict": "ok" | "suboptimal" | "wrong",',
    '    "comment": "<one-sentence reason>",',
    '    "recommendedAgentId": "<id from the candidate list, or null>" }',
    "",
    "WorkItem:",
    `  id:            ${workItem.id}`,
    `  workRef:       ${workItem.workRef.kind}/${workItem.workRef.ref}`,
    `  priority:      ${workItem.priority}`,
    `  requiredRole:  ${workItem.requiredRole ?? '<any>'}`,
    `  activityKind:  ${workItem.contextScope?.activityKind ?? '<unset>'}`,
    `  preferredAgentId: ${workItem.preferredAgentId ?? '<unset>'}`,
    `  preferredProvider: ${workItem.preferredProviderKind ?? '<unset>'}`,
    "",
    "Candidate agents (active, eligible):",
    candidateLines || "  <none>",
    "",
    `Deterministic decision: ${decision.agentId} (reason: ${decision.reason})`,
    "",
    "Verdict guidance:",
    "  ok          — decision is reasonable; no better alternative was clearly available.",
    "  suboptimal  — a marginally better agent existed (e.g., provider-match was passed over).",
    "  wrong       — the decision violates a hard constraint (role mismatch, busy agent).",
    "",
    "Respond now with JSON only.",
  ].join("\n");
}

/** Parse the Scheduler agent's reply. Tolerant — fall back to verdict='parse-error'. */
function parseVerdict(
  text: string,
  candidates: Agent[],
): { verdict: AIVerdict; comment?: string; recommendedAgentId?: string } {
  if (!text || typeof text !== 'string') {
    return { verdict: 'parse-error', comment: 'empty reply' };
  }
  // Extract the JSON block — tolerate prose around it.
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return { verdict: 'parse-error', comment: 'no JSON found' };

  let parsed: { verdict?: string; comment?: string; recommendedAgentId?: string };
  try {
    parsed = JSON.parse(match[0]);
  } catch (e) {
    return { verdict: 'parse-error', comment: `JSON.parse: ${(e as Error).message}` };
  }

  const verdict = parsed.verdict;
  if (verdict !== 'ok' && verdict !== 'suboptimal' && verdict !== 'wrong') {
    return { verdict: 'parse-error', comment: `invalid verdict '${verdict}'` };
  }
  let recommendedAgentId: string | undefined;
  if (typeof parsed.recommendedAgentId === 'string' && parsed.recommendedAgentId) {
    // Validate against the candidate list — never accept an arbitrary id.
    if (candidates.find(c => c.id === parsed.recommendedAgentId)) {
      recommendedAgentId = parsed.recommendedAgentId;
    }
  }
  return {
    verdict: verdict as AIVerdict,
    comment: typeof parsed.comment === 'string' ? parsed.comment : undefined,
    recommendedAgentId,
  };
}

function emitVerdict(runtime: RuntimeShape, record: AIVerdictRecord): void {
  try {
    const audit = runtime.audit;
    if (audit?.emit) {
      audit.emit({
        kind: 'agents.scheduler.ai-verdict',
        ref: `item:agents.scheduler.workItems[${record.workItemId}]`,
        data: { ...record },
      });
    }
  } catch {
    /* swallow */
  }
}
