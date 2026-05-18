---
slug: SA-scheduler
title: SA — Scheduler Subsystem (Queue · Tickets · Routing · Tick)
aliases:
  - sa-scheduler
  - scheduler-architecture
  - scheduler-design
  - scheduler-substrate
  - scheduler-internals
keywords:
  - scheduler
  - subsystem
  - workitem
  - queue
  - ticket
  - tick
  - routing
  - algorithm
  - activity-table
  - ai-choose
  - ai-scheduler
  - aischeduleralgorithm
  - persistable
  - provider
  - decision-29
  - decision-34
  - decision-36
  - busy-set
  - assignment
  - request-turn
  - dispatch
spotlight: true
summary: >
  Deep architectural doc for runtime.agents.scheduler — the central
  queue and dispatcher. Documents the WorkItem queue (scheduler.submit
  path), the Ticket store (scheduler.requestTurn path per Decision 34),
  the pluggable SchedulerAlgorithm, the tick loop (5s interval
  scanning queued work + sweeping expired tickets), the AI optimizer
  pattern (wrap-the-base, async consultation, observation-only in v0),
  persistence shape, and the routing-decision integration with Decision
  36's Activity Table + AI-Choose model.
type: architecture
audience: [ai, human]
status: active
tags: [scheduler, agents, substrate, sa, queue, tickets, routing]
related:
  - sa-agent-dispatch
  - sa-engagement-flow
  - 29-agent-providers-and-sendmessage
  - 34-ticket-model
  - 35-session-pool-rethink
  - 36-scheduler-routing-model
  - agent-roles
---

# SA — Scheduler Subsystem

This document describes what is *inside* `runtime.agents.scheduler`.
The **routing contract** (what it picks, how callers override) is
specified in [Decision 36](36-scheduler-routing-model). The **dispatch
flow from caller down to provider** is specified in
[`SA-agent-dispatch`](sa-agent-dispatch). This doc describes the
mechanism — the queue, the tick, the ticket store, the algorithm
plug-point, and how the routing contract resolves at runtime.

If you are reading to extend the Scheduler (new algorithm, new
audit kind, new persistable state), this is the right doc. If you
are reading to *use* the Scheduler, start with `SA-agent-dispatch`.

---

## 1. What the Scheduler is

> The Scheduler is the **central queue** for all work that needs an
> Agent, plus the **central authorization point** for individual
> Turns.

These are two distinct primitives sharing one subsystem:

| Primitive | Surface | Unit | Lifecycle | Status |
|---|---|---|---|---|
| **WorkItem queue** | `scheduler.submit` | `WorkItem` (priority + filters + workRef) | queued → assigned → running → completed/failed/cancelled | Long-shipped. Used for background passes (Secretary), oversight ticks, AI-only work. |
| **Ticket store** | `scheduler.requestTurn` | `Ticket` (per-Turn authorization) | issued → active → completed/expired/cancelled | Shipped as part of Decision 34. Used for engagement-Turn dispatch. |

They coexist intentionally. Background work that doesn't need a
specific Turn (a Secretary scan, a charter sweep, a Linker pass)
goes through `submit`. Work that opens a Turn against an engagement
goes through `requestTurn`. The Scheduler is the same subsystem
either way — same algorithm plug-point, same agent-pool view, same
tick loop.

**What the Scheduler does NOT do:**

- It does not *run* the work. `submit` dispatches an assignment event;
  the consumer is responsible for actually executing.
- It does not own provider implementations. Provider selection
  influences routing (via Decision 36 + capability descriptors) but
  the actual `sendMessage` lives in `agents.sendMessage` → provider.
- It does not own Agent lifecycle. Lease, bind, role are
  `runtime.agents` concerns.
- It does not own Turn or Reply records. Those are `agents.turns`
  and `agents.replies`. The Scheduler stamps `ticketId` onto a Turn
  via the `requestTurn` → `sendMessage` chain, but doesn't own the
  Turn record.

---

## 2. Components

```
┌─ SchedulerSubsystem (runtime.scheduler, primitives at agents.scheduler.*) ┐
│                                                                            │
│  State                                                                     │
│  ─ workItems:           Map<workItemId, WorkItem>                          │
│  ─ routingPolicy:       Map<kind, RoutingPolicyEntry>     ← evolving       │
│                                                              into D36's    │
│                                                              Activity Tbl  │
│  ─ activeByTicketId:    Map<ticketId, Ticket>             ← D34            │
│  ─ historyByTicketId:   Map<ticketId, Ticket>             ← D34 (in-mem)   │
│  ─ historyEventsByTicketId: Map<ticketId, TicketHistoryEvent[]>            │
│  ─ historyTicketIdsByEngagement: Map<engId, ticketId[]>   ← FIFO ring      │
│                                                                            │
│  Algorithm plug-point                                                      │
│  ─ algorithm: SchedulerAlgorithm                          ← pluggable      │
│       └─ pickAgent(workItem, candidates, busy, policy)                     │
│                                                                            │
│  Backrefs (wired by pack/index.ts on install)                              │
│  ─ agentsRef: AgentsSubsystem                                              │
│                                                                            │
│  Tick                                                                      │
│  ─ tickTimer (setInterval @ SCHEDULER_TICK_MS = 5000)                      │
│       ├─ scan queued WorkItems → tryAssign each                            │
│       └─ sweep expired Tickets → release with reason='expired'             │
│                                                                            │
│  Persistable contract                                                      │
│  ─ saveJson()  → { schemaVersion, workItems, routingPolicy,                │
│                    activeTickets }                                         │
│  ─ loadJson(s) → restores all three; history is NOT persisted              │
│  ─ consumeDirty() → returns + resets dirty flag                            │
└────────────────────────────────────────────────────────────────────────────┘
        ▲
        │ wraps (optional)
        │
┌─ AISchedulerAlgorithm ─────────────────────────────────────────────────────┐
│  Wraps the base SchedulerAlgorithm. pickAgent returns base decision        │
│  SYNCHRONOUSLY. Fires an async consultation to a Scheduler-role agent.     │
│  Emits 'agents.scheduler.ai-verdict'. Observation-only in v0; does NOT     │
│  override base decision. Default-disabled; enabled via                     │
│  scheduler.useAIOptimizer().                                               │
└────────────────────────────────────────────────────────────────────────────┘
```

### State stores in detail

- **`workItems`** — every WorkItem ever submitted, indexed by id.
  Persistable. Terminal items (`completed`, `failed`, `cancelled`)
  remain in the map; the tick algorithm filters them out of the
  scan. Future: terminal-WorkItem retention policy (rolling window
  / archive to audit).
- **`routingPolicy`** — `Map<kind, RoutingPolicyEntry>`. Today
  keyed by engagement-kind / activityKind (e.g., `'general'`,
  `'bookkeeping'`). Each entry has `defaultProviderKind`, `sticky`,
  `fallbackProviderKind`, `hints`. **This is the v0 predecessor to
  Decision 36's Activity Table.** Migration path documented in §7.
- **`activeByTicketId`** — non-terminal Tickets (`issued`, `active`).
  Hot path; checked by every `sendMessage` that carries a
  `ticketId`. Persistable so a crash mid-dispatch can reconcile.
- **`historyByTicketId` + `historyEventsByTicketId`** — terminal
  Tickets and their lifecycle events. **Not persisted by design** —
  terminal tickets are read-only artifacts; on restart the audit
  log (`ticket-issued`, `ticket-released` kinds, retained
  indefinitely) is the source of truth.
- **`historyTicketIdsByEngagement`** — FIFO queue per engagement,
  capped at `TICKET_HISTORY_CAP_PER_ENG` (100). Eviction drops the
  oldest entry's history records when the cap is exceeded.

### Backrefs

The Scheduler is mounted before the Agents subsystem is fully wired,
so `agentsRef` is assigned by `pack/index.ts` after both objects
exist (similar pattern to `engagementFlow.agentsRef` and
`schedulerRef`). All Scheduler methods that need agent lookups
guard with a "scheduler.*: agents subsystem not wired" error.

### Persistence note

The runtime auto-synthesizes `scheduler.json()` from `saveJson()`.
The current schema version is `1`. Bumping the version requires
`loadJson` to handle the migration path (or refuse with a clear
error if migration is impossible).

---

## 3. Algorithm plug-point

The selection-of-an-agent-for-a-WorkItem is **pluggable**:

```ts
interface SchedulerAlgorithm {
  pickAgent(
    workItem: WorkItem,
    candidates: Agent[],            // pool filtered by hard constraints
    busyAgentIds: Set<string>,      // currently assigned (excluded)
    routingPolicy: ReadonlyMap<string, RoutingPolicyEntry>,
  ): { agentId: string; reason: string } | null;
}

scheduler.setAlgorithm(myAlgorithm);
```

The Scheduler itself applies the hard constraints (`requiredRole`,
`requiredCapabilities`) and the busy-set filter *before* calling
`pickAgent`. The algorithm therefore only sees eligible idle
candidates; its job is to **rank and pick** among them, not to
re-filter.

**Returns:**
- `{ agentId, reason }` → assignment proceeds; `reason` is recorded
  on the WorkItem and audited (`reasonAssigned`).
- `null` → no decision; the item stays queued and is reconsidered
  next tick.

### v0 base algorithm

Built-in deterministic algorithm:

1. Honor `preferredAgentId` if the agent is idle + eligible.
2. Consult `routingPolicy[workItem.contextScope?.activityKind]`
   for `defaultProviderKind`; filter candidates by provider.
3. Among remaining candidates, prefer agents whose `agent.provider.kind`
   matches `workItem.preferredProviderKind`.
4. Tie-break: LRU (least-recently-used among eligible).

Returns `null` only when no eligible candidate is currently idle.

### AISchedulerAlgorithm (the wrap pattern)

For experimentation, the Scheduler can wear an AI-driven optimizer
that **observes without overriding**:

```ts
scheduler.useAIOptimizer({
  consultPriorityCeiling: 90,        // skip very-high-priority items
  skipActivityKinds: ['scheduler-tick'],  // avoid recursion
});
```

When enabled, `pickAgent` returns the base algorithm's choice
synchronously (so assignment latency stays bounded), then fires an
async consultation to a Scheduler-role agent: "is `agentX` the right
pick for `workItem`?" The verdict is emitted as
`agents.scheduler.ai-verdict` — **purely observational in v0; never
overrides the deterministic decision**.

The forward path (captured in `ai-scheduler.ts` and intentionally
not yet shipped):

- Cache verdicts by `(activityKind, requiredRole, agentId)` tuples.
  Use them as input to the next decision.
- Add a `reassign` primitive; promote 'wrong' verdicts to actually
  unassign + requeue.
- Replace "first scheduler agent" with load-aware choice.
- Add a routing-policy-mutation primitive the Scheduler agent can
  call; verdicts drive dynamic policy changes.
- Tune consultation throttling (batching by activityKind drops cost
  ~10x).

The wrap-the-base shape means the deterministic algorithm runs
forever even if AI is unavailable — **no new failure modes**.

### Relationship to Decision 36's AI-Choose

`AISchedulerAlgorithm` (today) reasons about **which agent** to
assign a WorkItem to. `AI-Choose` (Decision 36) reasons about
**which (provider, model)** a `requestTurn` dispatch should use.
They are complementary, not redundant:

- AI-Optimizer picks among already-leased agents.
- AI-Choose informs which provider/model the next lease should
  target.

In the steady-state design, both will exist and may share
underlying machinery (verdict cache, capability descriptors,
audit-replay-driven tuning). v1 keeps them separate to evolve
independently.

---

## 4. The tick loop

```ts
private tickTimer = setInterval(() => this.tick(), SCHEDULER_TICK_MS);
// SCHEDULER_TICK_MS = 5000
```

Each tick does two passes:

```
tick()
  ├─ 1. Scan queued WorkItems (priority desc, submittedAt asc)
  │       for each:
  │         tryAssign(item) → pickAgent(...) → emit work-assigned
  │
  └─ 2. Sweep expired Tickets
          for each active ticket where now > expiresAt:
            release(ticketId, reason='expired')
              ├─ emit ticket-released
              └─ archive to history
```

**Event-driven assignment also happens** outside the tick — `submit`
attempts assignment immediately before returning; consumer
`reportCompleted` / `reportFailed` calls free the agent and trigger
an immediate re-scan. The tick is the safety net for items that
became assignable after their submit attempt (agent freed up,
priority change, etc.).

**Timer hygiene:** `tickTimer.unref()` is called so the timer does
not keep the Node process alive. The runtime shutdown path calls
`scheduler.stop()` which clears the timer.

---

## 5. The `submit` path (WorkItem queue)

```ts
const workItem = await runtime.agents.scheduler.submit({
  workRef: { kind: 'engagement', ref: 'eng_abc' },
  priority: 50,                       // default
  submittedBy: 'secretary-pass',
  requiredRole: 'secretary',          // hard filter
  requiredCapabilities: { vision: true },  // hard filter
  preferredAgentId: 'agt_xyz',        // hint
  preferredProviderKind: 'together',  // hint
  contextScope: {
    projectId: 'qb',
    engagementId: 'eng_abc',
    activityKind: 'general',          // routing-policy key
  },
});
```

Flow:

1. Mint `WorkItem` (status `queued`); push to `workItems` map.
2. Emit `agents.scheduler.work-submitted`.
3. Call `tryAssign` immediately:
   - Filter candidates by `requiredRole` + `requiredCapabilities`.
   - Subtract `busyAgentIds`.
   - Call `algorithm.pickAgent(...)`.
   - On hit: status → `assigned`, set `assignedAgentId` +
     `reasonAssigned`, emit `agents.scheduler.work-assigned`.
   - On miss: leave as `queued`; next tick will retry.
4. Return the `WorkItem` (may be `queued` or `assigned`).

**Consumer responsibilities** (the Scheduler doesn't execute work):

- On work start: `scheduler.reportStarted(workItemId)` → status
  `running`, emit `work-started`.
- On success: `scheduler.reportCompleted(workItemId)` → status
  `completed`, free agent, re-scan queue.
- On failure: `scheduler.reportFailed(workItemId, msg)` → status
  `failed`, free agent, re-scan.
- On user-cancel: `scheduler.cancel(workItemId, reason)` → status
  `cancelled`, free agent.

If a consumer crashes mid-work without reporting, the agent stays
in the busy-set until the runtime restarts (snapshot doesn't carry
busy-set — it's rebuilt from `workItems` with `status: 'running'`
on load). Future: liveness check / lease TTL on assignments.

---

## 6. The `requestTurn` path (Ticket store, Decision 34)

```ts
const issued = await runtime.agents.scheduler.requestTurn({
  engagementId: 'eng_abc',
  prompt: 'Summarize the last 3 commits',
  preferredAgentId: 'agt_xyz',
  outcome: 'summary',
  by: 'user',
  ttlMs: 10 * 60 * 1000,   // override default 5min
  // (Decision 36) future opts:
  // pin: 'together/gpt-oss-120b',
  // activityTable: { general: { mode: 'always', default: '...' } },
});
// → { ticketId, agentId, turnId, replyHandle }
```

Flow (concrete order, with audit annotations):

```
1. Validate opts (engagementId, prompt required).
2. Look up engagement; get `boundAgentIds`.
3. Resolve agent:
     - if opts.preferredAgentId in boundAgentIds → use it
     - else use boundAgentIds[0]
     - else throw 'no bound agent'
4. (Decision 36 integration point — see §7)
     - apply Activity Table lookup or AI-Choose to decide
       (providerKind, model) the agent should use for this Turn.
5. Mint Ticket:
     - status: 'issued'
     - issuedAt: now
     - expiresAt: now + (opts.ttlMs ?? TICKET_TTL_MS)
     - providerKind: agent.provider.kind
     - model: (resolved per §7)
     - outcome: opts.outcome
6. Store in activeByTicketId; record history event {kind: 'issued'}.
7. Emit `agents.scheduler.ticket-issued`.
8. Call agents.sendMessage(agentId, {
     text: prompt, by, ticketId,
     // (Decision 36 future) provider/model override
   })
     - sendMessage opens Turn + Reply (audit: turn.opened with ticketId)
     - provider streams (audit: reply.chunk × N)
     - on terminal: audit: turn.completed | turn.errored
9. On send-throw: release ticket with reason='cancelled'; rethrow.
10. On send-return: stamp ticket as 'active' (turnId, startedAt);
    record history event {kind: 'used'}.
11. Return { ticketId, agentId, turnId, replyHandle }.
```

### Auto-release on Turn terminal

In `start()`, the Scheduler subscribes to:

```
audit.subscribe('agents.turn.completed', e => releaseTicket(e.data.ticketId, 'completed'))
audit.subscribe('agents.turn.errored',   e => releaseTicket(e.data.ticketId, 'cancelled'))
```

This is host-side (not script-isolate), so the closure marshals
correctly. The release:

1. Move Ticket from `activeByTicketId` to `historyByTicketId`.
2. Record history event `{kind: reason, at: now}`.
3. Push to `historyTicketIdsByEngagement[engId]`; FIFO-evict beyond
   `TICKET_HISTORY_CAP_PER_ENG`.
4. Emit `agents.scheduler.ticket-released`.

### Sweep on tick

Every tick (5s):

```
for ticket in activeByTicketId.values():
  if ticket.status === 'issued' && now > ticket.expiresAt:
    releaseTicket(ticket.ticketId, 'expired')
```

Only `issued` tickets expire — once a ticket is `active` (sendMessage
has stamped it), the Turn is in flight and TTL no longer applies.
Long-running Turns are bounded by the provider's own timeout, not
the ticket TTL.

---

## 7. Routing decisions — where Decision 36 plugs in

The Scheduler currently has a `routingPolicy` map (keyed by
`kind`, with `defaultProviderKind` + `sticky` + `fallback`). This
is the **v0 predecessor** to Decision 36's full Activity Table.

### v0 (today, shipped)

`routingPolicy` is consulted by the base SchedulerAlgorithm to
filter candidates by provider for `submit` work. `requestTurn` does
not consult it (selects per-agent only).

### v1 (Decision 36)

The `routingPolicy` map evolves into the **Activity Table**:

```ts
// Before (v0):
RoutingPolicyEntry { kind, defaultProviderKind, sticky, fallback, hints }

// After (v1, Decision 36):
ActivityRouting {
  mode: 'always' | 'auto' | 'ai';
  default: ProviderModelRef;             // 'claude/sonnet', etc.
  outcomes?: Record<string, ProviderModelRef>;
}
```

The integration points:

- **`requestTurn` step 4** — Activity Table lookup + Mode-driven
  decision (per `SA-agent-dispatch` §3 and D36 §Decision):
  1. Consult `opts.activityTable` first (caller-supplied; caller-wins per Activity).
  2. Fall through to system `routingPolicy` / Activity Table.
  3. Mode=Always → use `default`.
     Mode=Auto → use `default` unless caller flagged
     `complexity: 'specialized'`; if specialized → AI-Choose.
     Mode=AI → always AI-Choose.
  4. If `opts.pin` is set, it short-circuits the entire lookup.
- **AI-Choose call** emits `agents.scheduler.ai-choose-call` (per
  D36 §Audit surface) so router-call cost is visible.
- **Pin failure** falls back per D36 §Pin failure semantics; emits
  `agents.scheduler.pin-fallback`.

### Migration plan + status (2026-05-18)

The Scheduler does not rewrite its `routingPolicy` to the new shape
in a single commit. v1 implementation per
[`general-activity-multi-provider-v1`](general-activity-multi-provider-v1)
landed as a sequence of independently-shippable commits:

1. ✅ **Step 1 — caller-side opts.** `pin`, `activityTable`,
   `complexity` accepted on `requestTurn`; recorded on
   `ticket.requestOverrides`; no routing change. (D36 step 1)
2. ✅ **Step 2 — substrate tables.** `runtime.tables`
   (ConfigTablesSubsystem) ships in blur-ai-runtime with on-disk
   Model Table + Activity Table; read-only views as `runtime.models.*`
   and `runtime.activityRouting.*`. (See SA-engagement-flow.)
3. ✅ **Step 2.5 — D29 adapter.** `local` + `together` providers
   from blur-providers-core are wrapped into `agents.providers.register`
   shape via `src/pack/providers/d29-provider-adapter.ts`.
4. ✅ **Step 3 — override-chain resolution.** Implemented in
   `src/pack/scheduler-routing.ts` (`resolveDispatch`). Walks pin →
   caller-table → `engagement.runtimeModel` → system Activity Table
   → AI-Choose stub → baseline. Stamps `selectedModelRef` +
   `selectionSource` + `selectionRationale` on the Ticket. Threads
   the resolved provider-native id through `SendMessageOpts.model`
   to the D29 adapter / providers. Pin-fallback when
   resolved providerKind ≠ agent kind (v1 fail-soft).

Remaining (deferred):

5. **Step 3a — cross-provider re-routing.** When a pin targets a
   different providerKind than the bound agent, mint an ephemeral
   agent of the resolved kind via `agents.lease` + `leasedFrom:'manual'`.
   v1 falls back to the bound agent's model + emits
   `agents.scheduler.pin-fallback`.
6. **Step 4 — AI-Choose real implementation.** `aiChooseStub`
   callback in `resolveDispatch` is the contract point. Today it's
   unset (Mode=auto+specialized and Mode=ai fall back to the
   Activity default). Step 4 wires a real router (probably a small
   local model) without resolver-API churn.

The contract surface is stable; the algorithm inside `aiChooseStub`
is explicitly evolutionary per Decision 36.

---

## 8. Audit surface

```
agents.scheduler.work-submitted        { workItemId, ... }
agents.scheduler.work-assigned         { workItemId, agentId, reason }
agents.scheduler.work-started          (consumer-emitted via reportStarted)
agents.scheduler.work-completed
agents.scheduler.work-failed
agents.scheduler.work-cancelled
agents.scheduler.routing-policy-set    { kind, entry, by }

agents.scheduler.ticket-issued         { ticketId, engagementId, agentId,
                                          providerKind, outcome?, expiresAt,
                                          selection?: { ... } /* D36 v1+ */ }
agents.scheduler.ticket-released       { ticketId, engagementId, agentId,
                                          turnId?, reason }

agents.scheduler.ai-verdict            (AISchedulerAlgorithm; observational)

agents.scheduler.ai-choose-call        (D36 v1+; AI-Choose router-call cost)
agents.scheduler.pin-fallback          (D36 v1+; substitution on pin failure)
```

The Scheduler also **subscribes** to:

```
agents.turn.completed    → releaseTicket(_, 'completed')
agents.turn.errored      → releaseTicket(_, 'cancelled')
```

(Host-side subscribers, established in `scheduler.start()`.)

---

## 9. Concurrency, atomicity, failure modes

### Single-threaded by default

The Scheduler runs in a single Node event loop. State mutations
(map updates, dirty-flag set) are not protected by locks because
JavaScript's single-threaded execution model guarantees atomicity
at the function-call grain. `await` boundaries are the points
where another callback can interleave.

### `requestTurn` atomicity

The dispatch path crosses one `await` boundary: `agents.sendMessage`.
Sequence:

```
[sync] mint ticket, store in activeByTicketId, emit ticket-issued
[async] await agents.sendMessage(...)         ← interleave point
[sync] stamp ticket as active OR release on throw
```

A concurrent `requestTurn` on the same engagement during the await
will see the first ticket as `issued` (not yet `active`) — both
proceed. This is intentional: tickets are per-Turn authorization,
not per-agent locks. The agent dispatching two Turns concurrently
is the provider's concern (Claude pool: one session, one turn at a
time; Together: stateless, fine).

### Crash recovery

- **WorkItems**: persisted. On restart, `running` items remain
  `running` until a consumer reports terminal. **Risk:** consumer
  crashed without reporting → permanent busy entry. Mitigated by
  manual `scheduler.reset(workItemId)` (admin primitive). Future:
  liveness check on assignment.
- **Active tickets**: persisted. On restart, `active` tickets are
  reloaded; their TTL continues from the original `expiresAt`. If
  expiry already passed, next tick sweeps them.
- **History**: not persisted. Fresh boots have empty
  `historyByTicketId` and `historyEventsByTicketId`. The audit log
  is the long-term truth; rebuilding history from audit on demand
  is a future read primitive.

### `audit.subscribe` and script isolates

The Scheduler's auto-release subscribers are established in
`start()`, which runs **host-side** (not in a script isolate). Host
closures marshal fine. Script-side `audit.subscribe(handler)` does
not work (closures don't cross the isolate boundary) — this is the
F2 friction documented in the backend-orchestration retro. Script
callers who need to react to dispatch events use the
`engagementFlow.recentEmissions(...)` diagnostic ring.

---

## 10. Persistence

`Persistable` contract:

```ts
saveJson(): {
  schemaVersion: 1,
  workItems: WorkItem[],
  routingPolicy: RoutingPolicyEntry[],
  activeTickets: Ticket[],     // only non-terminal
}

loadJson(snapshot): void
  // Restores all three maps. History is intentionally empty.

consumeDirty(): boolean
  // Self-tracked dirty flag, set on every mutating call.
  // Returns and resets. Used by the runtime's snapshot-on-dirty pass.
```

The `runtime.audit` log is the long-term history substrate.
Anything not in the snapshot can (in principle) be rebuilt by
replaying audit events from boot to now. The Scheduler does not do
this on load (cost), but a future `scheduler.replayHistory()`
admin primitive could rebuild `historyByTicketId` for analytics
queries.

---

## 11. Primitive surface (current)

Exposed via `agents.scheduler.*`:

```
# WorkItem queue
submit(opts)                 → WorkItem
reportStarted(id)            → WorkItem
reportCompleted(id)          → WorkItem
reportFailed(id, msg)        → WorkItem
cancel(id, reason?)          → WorkItem
listWorkItems(opts?)         → WorkItem[]
getWorkItem(id)              → WorkItem | null

# Routing policy (v0 → evolving to Activity Table per D36)
setRoutingPolicy(opts)       → RoutingPolicyEntry
listRoutingPolicy()          → RoutingPolicyEntry[]

# Algorithm + AI optimizer
setAlgorithm(algorithm)      → void
useAIOptimizer(opts?)        → void
useDefaultAlgorithm()        → void  (reset)

# Ticket store (D34)
requestTurn(opts)            → { ticketId, agentId, turnId, replyHandle }
releaseTicket(id, reason)    → void
listTickets(opts?)           → Ticket[]
tickets.history(ticketId)    → TicketHistory | null
```

Planned (D36 implementation):

```
requestTurn(opts) — additional opts:
  - pin?: ProviderModelRef
  - activityTable?: Partial<ActivityTable>
  - complexity?: 'routine' | 'specialized'

setActivityTable(opts)       → ActivityTable        (system table editor)
listActivityTable()          → ActivityTable
```

---

## 12. Open design questions

(These are forward-looking; the substrate is functional without
them. Each is a candidate for a future Decision.)

- **Terminal-WorkItem retention policy.** Today `completed` /
  `failed` / `cancelled` items live in `workItems` forever. Should
  archive after N days, or roll into a separate `archivedWorkItems`
  store.
- **Liveness check on assignments.** A consumer that crashes
  without reporting leaves an agent permanently busy. Need a
  heartbeat or assignment TTL.
- **Activity Table authoring workflow.** Decision 36 specifies the
  shape; the editing surface (markdown? primitive? per-pack
  contribution?) is open.
- **Capability descriptor schema.** Provider registrations need a
  declared capability descriptor for AI-Choose to consult.
  Schema is hand-curated in v1; v2 may formalize.
- **AI-Choose router model bootstrap.** Which model routes the
  routing? Cheapest viable (local 8B) is the natural fit, but
  quality matters for the cold-start period.
- **`pin` vs `activityTable` redundancy.** D36 exposes both as
  caller-side overrides; audit which is used in practice and
  consider deprecating one.
- **History replay primitive.** `scheduler.replayHistory()`
  rebuilds `historyByTicketId` from audit. Useful for analytics
  but expensive; design the read-API shape before building.
- **WorkItem ↔ Ticket unification.** Today they're parallel
  lifecycles in the same subsystem. A future Decision may merge
  them (a Ticket IS a kind of WorkItem) or formalize the
  separation as permanent.
- **Pool semantics per provider** ([Decision 35](35-session-pool-rethink)).
  Affects which agents the Scheduler sees as candidates. Resolution
  shapes whether the Scheduler ever needs to interact with the pool
  directly or only ever through `agents.lease`.

---

## 13. Related docs

- **[`SA-agent-dispatch`](sa-agent-dispatch)** — How callers reach
  the Scheduler. Five-object model (Engagement, Agent, Ticket, Turn,
  Reply). Four dispatch paths.
- **[`SA-engagement-flow`](sa-engagement-flow)** — The Engagement
  lifecycle that the Scheduler dispatches into. Auto-prep,
  auto-lease, result-linker.
- **[Decision 29](29-agent-providers-and-sendmessage)** — Provider
  registry. Where capability descriptors will attach.
- **[Decision 34](34-ticket-model)** — Why Tickets exist + the
  v1/v2 gate posture.
- **[Decision 35](35-session-pool-rethink)** — Pool semantics open
  question.
- **[Decision 36](36-scheduler-routing-model)** — Routing contract:
  Activity Table + Mode + AI-Choose + caller override.
- **[`agent-roles`](agent-roles)** — Role catalog. The `scheduler`
  role is the agent class that AISchedulerAlgorithm leases for
  consultations.
