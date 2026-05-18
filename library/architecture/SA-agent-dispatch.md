---
slug: SA-agent-dispatch
title: SA — Agent Dispatch (Agents · Turns · Tickets · Scheduler · Replies)
aliases:
  - agent-dispatch
  - sa-agent-dispatch
  - turn-dispatch
  - dispatch-pipeline
  - turns-and-tickets
  - scheduler-architecture
  - tickets
  - ticket-model
keywords:
  - agent
  - turn
  - ticket
  - scheduler
  - reply
  - dispatch
  - lease
  - bind
  - sendMessage
  - requestTurn
  - dispatchTurn
  - openTurn
  - provider
  - audit
  - attribution
  - whoami
  - engagement
  - decision-29
  - decision-34
  - decision-35
  - pool
  - persistable
summary: >
  Substrate architecture for the dispatch pipeline — how Engagements,
  Agents, Tickets, Turns, and Replies compose to drive one prompt
  through one model. Documents the five objects, the four entry-point
  primitives (dispatchTurn / requestTurn / sendMessage / openTurn),
  the audit trail, and the open design questions (pool shape per
  Decision 35, v2 fail-closed gate per Decision 34).
type: architecture
audience: [ai, human]
status: active
tags: [agents, substrate, sa, dispatch, tickets, turns, scheduler]
related:
  - agent-roles
  - sa-engagement-flow
  - 29-agent-providers-and-sendmessage
  - 34-ticket-model
  - 35-session-pool-rethink
  - whoami
spotlight: true
---

# SA — Agent Dispatch

This document describes how a single prompt becomes a single model
response in blur-agent. It covers the five objects involved, the four
primitives that drive them, the audit trail they leave, and the
boundaries where future Decisions will continue to evolve the design.

If you are reading this to understand a specific call, jump to
**§Dispatch paths** and pick the one that matches your caller. If you
are designing a change, read **§Object model** first.

---

## 1. Object model

Five durable objects participate in dispatch. Each has a record, a
lifecycle, and an owning subsystem.

| Object | Identity | Owner | Lives | Audit attribution |
|---|---|---|---|---|
| **Engagement** | `eng_<uuid>` | `runtime.engagements` | Until `complete()` (then archived) | Scope for one user-visible task |
| **Agent** | `agt_<uuid>` | `runtime.agents` | Across session rotations; durable | The "who" — appears as `by:` on most kinds |
| **Ticket** | `tkt_<uuid>` | `runtime.agents.scheduler` | One Turn, then archived to history | Authorization for one dispatch |
| **Turn** | `tur_<uuid>` | `runtime.agents.turns` | One round of prompt→reply | Frame for everything inside the dispatch |
| **Reply** | `rep_<uuid>` | `runtime.agents.replies` | Until completed / errored | The streamable result handle |

The relationships:

```
Engagement ─────► Agent              (bind: agent serves this engagement)
    │                │
    │                │ (provider)
    │                ▼
    │            ProviderRegistry → ProviderImpl (claude | together | mock | ...)
    │                │
    │                │ creates
    ▼                ▼
   Turn ◄──── Ticket           ┌─── ReplyRecord (one)
    │            (authorizes)  │
    │                          │
    └─────────────────────────►┘
```

### Engagement

A user-visible unit of work — "summarize the last 3 commits", "draft
this Charter Step", "answer this question." Carries scope (`{kind,
ref}`), an `activityId` selecting which Activity definition applies,
a `shape` (`'ai-ui'`, `'background'`, ...), and accumulates outputs
(filed Steps, Tickets, Decisions) for the result linker. See
[`SA-Engagement-Flow.md`](sa-engagement-flow) for the full Engagement
contract.

For dispatch, the engagement provides:

- **`boundAgentIds[]`** — agents the Scheduler can dispatch through
  without re-leasing.
- **`turnIds[]`** — back-link from Engagement → Turns, populated by
  `engagements.addTurn` (called by `dispatchTurn`).
- **Scope** — for retrieval (`listTickets({engagementId})`, retro
  analysis) and per-engagement history archive.

### Agent

A **durable record of "who is doing what"**, paired with a role (see
[agent-roles](agent-roles)) and bindings. Agents survive session
rotation: the same `agentId` can move from one Claude CLI session to
another without losing its identity, its handoff pointer, or its
binding to an engagement.

For dispatch, the Agent provides:

- **`provider`** — a `{ kind, sessionId?, ... }` discriminated union
  resolved against the `ProviderRegistry` (Decision 29). Tells
  `sendMessage` how to actually deliver the prompt.
- **`role`** — telemetry / routing hint; today informational, in v2
  may bias ticket-policy decisions.

### Ticket (Decision 34)

A per-Turn **authorization record** minted by the Scheduler. Three
roles in one record:

- **Authorization** — `agents.sendMessage` honors `opts.ticketId`. v1
  is fail-soft (warn-and-proceed when missing); v2 will refuse
  dispatch. Audit kind `agents.send-without-ticket` is the v1
  migration metric.
- **Attribution** — every Turn carries `ticketId`. Joining Turn →
  Ticket → caller intent → (future) cost is a one-query operation.
- **Routing** — `outcome?: string` records caller intent
  (`'summary'`, `'risk-check'`, `'code-gen'`, ...). v1 records; v2
  may consult for model-tier selection.

Lifecycle:

```
issued    — minted by requestTurn; not yet stamped on a Turn
   ↓
active    — sendMessage stamped the ticketId; Turn in flight
   ↓
{ completed  — Turn ended normally; auto-released by the
                 agents.turn.completed subscriber }
{ expired    — TTL elapsed (default 5min); released by tick sweep }
{ cancelled  — explicit releaseTicket or sendMessage threw post-issue }
```

Active tickets live in memory (and in the Scheduler's persisted
snapshot). Terminal tickets archive to a per-engagement history ring
(cap 100, FIFO eviction) queryable via
`scheduler.tickets.history(ticketId)`.

### Turn

One round of `prompt → model → response`. Holds:

- `prompt: string`
- `agentId`, `engagementId?`, `ticketId?`
- `replyHandle` linking to the streaming reply
- `status`: `opened` → `completed` | `errored`
- `by?`: caller attribution

Turn records are persistent (replayable from audit). The Turn id
becomes the **audit frame** for everything that happens inside the
dispatch — chunks, errors, completion all carry `turnId` in their
audit envelope.

### Reply

The streaming-output handle. Created alongside the Turn. Provides:

- `chunks: Array<{ at, text }>` accumulated as the model streams.
- `final: { text, ... }` once complete.
- `status: 'open' | 'completed' | 'errored'`.

Replies are the consumer-facing surface for streaming. SSE forwarders
(workspace UI) and post-completion readers (linker) subscribe to the
audit kinds documented in §4.

---

## 2. Subsystem map

```
runtime.engagements              — Engagement record CRUD, addTurn, addOutput
runtime.engagementFlow           — UI-facing façade (subscriber-driven)
  ├─ runSecretaryPrep(engId)
  ├─ runSchedulerLease(engId, {mock?})
  ├─ runLinker(engId)
  ├─ dispatchTurn(engId, opts)   ← THE one-call entry point
  ├─ getPrepData(engId)
  ├─ recentEmissions(opts)       — diagnostic ring (audit.subscribe
  └─ emissionStats()                doesn't marshal into script isolates)

runtime.agents                   — Agent record CRUD, lease/bind, sendMessage
  ├─ lease(opts)                 — manual or pool lease
  ├─ bindAgent / unbindAgent
  ├─ sendMessage(opts)           ← THE dispatch primitive
  ├─ roles.*                     — open role registry
  ├─ providers.*                 — ProviderRegistry (Decision 29)
  ├─ turns.*                     — Turn record CRUD
  │    └─ openTurn(opts)         ← rarely called directly
  ├─ replies.*                   — Reply record CRUD + streaming reads
  └─ scheduler.*                 — WorkItem queue + Ticket model
       ├─ requestTurn(opts)      ← engagement-aware dispatch
       ├─ releaseTicket(id, reason)
       ├─ listTickets(opts)
       ├─ submit(workItem)       — queue-style work (unrelated to Turns)
       └─ tickets.history(id)
```

The **flow direction** is intentionally one-way:

```
UI / caller ──► engagementFlow.dispatchTurn
                    │
                    ▼
                scheduler.requestTurn ──► agents.sendMessage ──► agents.turns.openTurn
                    │                            │                       │
                    │  (issues ticket)           │  (resolves provider)  │  (mints Turn,
                    ▼                            ▼                       │   ReplyRecord;
                Ticket store              ProviderImpl                   │   stamps ticketId)
                                          .sendMessage()                 ▼
                                                                    Turn + Reply
                                                                    records
```

Each layer adds one concern. Callers pick the level they need.

### Inside the Scheduler

The Scheduler is more than a thin pass-through. Per `requestTurn`, it
makes real routing decisions: which **agent** serves the dispatch,
which **(provider, model)** the agent uses, what **Mode** governs the
selection, what happens when a caller **pins** or **overrides**.

The routing contract is captured in
**[Decision 36 — Scheduler routing model](36-scheduler-routing-model)**.
In summary:

- A layered policy: per-call `pin` → caller-supplied Activity Table →
  system Activity Table → AI-Choose → baseline.
- An **Activity Table** maps each Activity to a default
  `(provider, model)` plus a **Mode** (`Always` / `Auto` / `AI`)
  controlling when intelligent routing runs.
- Callers may supply a partial Activity Table on the call;
  caller-wins per Activity, system Table fills gaps. This is the
  evaluation-and-pinning pathway (no global state, no namespace
  pollution).
- **AI-Choose** is the intelligent fallback router — it reasons over
  context + the provider/model capability catalog (Decision 29).
- Pin failure falls back through the policy chain and emits
  `agents.scheduler.pin-fallback` audit.
- The contract surface is stable; the **AI-Choose algorithm is
  explicitly evolutionary**. v1: Claude Cowork backbone with
  selective use of Together / Local where context, training fit, or
  cost warrants.

The deep architectural doc for the Scheduler (queue mechanics, tick
loop, AISchedulerAlgorithm internals, persistence detail) is
`SA-scheduler` — see related links.

---

## 3. Dispatch paths

Four entry points, ordered from most to least opinionated. Pick the
highest level that meets your needs.

### 3.1 `engagementFlow.dispatchTurn` — the UI path

```ts
const t = await runtime.engagementFlow.dispatchTurn('eng_abc', {
  text: 'Summarize the last 3 commits',
  by: 'user',
  outcome: 'summary',
});
// → { ticketId, turnId, replyHandle, agentId,
//     promptLen, prepSpliced }
```

What it does (in order):

1. **PrepData splice** — if this is Turn #1 on the engagement, fetch
   the Secretary's assembled PrepData and prepend it to `text`. Sets
   `prepSpliced: true` on the return value. Turn #2+ skips splicing
   (`prepSpliced: false`, `promptLen === text.length`).
2. **Pick agent** — honor `opts.agentId` if given; otherwise use the
   engagement's `boundAgentIds[0]`. Throws if neither resolves.
3. **Delegate to `scheduler.requestTurn`** with the prompt + agent +
   `outcome` + `by`. Receives `{ticketId, agentId, turnId,
   replyHandle}`.
4. **Link the Turn** to the Engagement via `engagements.addTurn`.
5. **Emit `engagements.turn-queued`** with `{turnId, ticketId,
   prompt: text, outcome, by, prepSpliced}`. UI's SSE forwarder
   relays this.
6. **Return the full handle bundle** for diagnostics.

When to use: any UI-driven Turn, any caller that wants PrepData
auto-splicing or Engagement linkage without managing it.

### 3.2 `scheduler.requestTurn` — the backend path

```ts
const issued = await runtime.agents.scheduler.requestTurn({
  engagementId: 'eng_abc',
  prompt: 'Rate this Charter change for risk',
  outcome: 'risk-check',
  by: 'oversight-agent',
  preferredAgentId: 'agt_xyz', // optional engagement-affinity hint
  ttlMs: 10 * 60 * 1000,        // optional TTL override
});
// → { ticketId, agentId, turnId, replyHandle }
```

What it does:

1. Issue the Ticket (`status: issued`, TTL stamped). Emit
   `agents.scheduler.ticket-issued`.
2. Pick the agent — `preferredAgentId` if supplied and bound,
   otherwise the engagement's first bound agent. (For
   non-engagement-affinity dispatch, omit and one is leased.)
3. Call `agents.sendMessage({agentId, prompt, ticketId, by})`. This
   opens the Turn (which stamps the ticketId) and starts streaming.
4. On send-throw, release ticket with reason `'cancelled'`.
5. Return the handle bundle.

When to use: callers that need ticket attribution and routing intent
but don't want PrepData/Engagement-link machinery. Background passes,
oversight ticks, the AI scheduler optimizer.

### 3.3 `agents.sendMessage` — the dispatch primitive

```ts
const { turnId, replyHandle } = await runtime.agents.sendMessage({
  agentId: 'agt_xyz',
  prompt: 'Explain this stacktrace',
  ticketId: 'tkt_…',   // OPTIONAL in v1 (warns), REQUIRED in v2
  by: 'run-agent',
});
```

What it does:

1. Look up the Agent. Resolve its `provider` against the
   `ProviderRegistry` (Decision 29).
2. Open a Turn record (`agents.turns.openTurn` internally) and a
   paired ReplyRecord. Stamp `ticketId` on the Turn if provided.
3. Emit `agents.turn.opened`.
4. Call `provider.sendMessage(...)`. The provider streams chunks
   (audit kind `agents.reply.chunk`) and emits
   `agents.turn.completed` or `.errored` on terminal.
5. **v1 fail-soft gate**: if `ticketId` is missing, emit
   `agents.send-without-ticket` and proceed. v2 will throw
   `MissingTicketError` here.

When to use: tests, narrow programmatic calls, anything that
deliberately bypasses ticket/engagement semantics. **Production
callers should migrate to `requestTurn` or `dispatchTurn`** — the
warning audit is the nudge.

### 3.4 `agents.turns.openTurn` — the record-mint primitive

Direct access. Used internally by `sendMessage`. Direct callers are
rare; mostly tests asserting Turn-record shape. Documented for
completeness, not recommended as an entry point.

---

## 4. Audit trail

Every dispatch leaves a full audit trace. The kinds, in canonical
order for one Turn:

```
engagements.opened                       (if a new engagement)
engagements.bindAgent                    (when agent attaches)
engagements.secretary.prep-started       (Turn #1 only; via subscriber)
engagements.secretary.prep-progress      (× N steps)
engagements.secretary.prep-complete
engagements.scheduler.lease-started      (Turn #1 only; via subscriber)
engagements.scheduler.session-ready

engagements.turn-queued                  ← dispatchTurn façade emit
agents.scheduler.ticket-issued           ← scheduler.requestTurn emit
agents.turn.opened                       ← sendMessage / openTurn emit
agents.reply.chunk                       (× N chunks)
agents.turn.completed                    (or .errored)
agents.scheduler.ticket-released         ← subscriber on turn.completed

engagements.secretary.linker-started     (on engagements.completed)
engagements.secretary.linker-complete

agents.send-without-ticket               ← v1 warning, when ticketId omitted
```

Every kind carries the **audit frame** for its scope: `engagementId`,
`turnId`, `agentId`, `ticketId`, `by`. Joining by any of these gives
the lineage.

The **diagnostic ring** (`engagementFlow.recentEmissions(...)` and
`.emissionStats()`) mirrors emissions in-memory for verification from
script isolates, because `runtime.audit.subscribe(handler)` cannot
marshal closures across the isolate boundary. Host-side subscribers
(SSE forwarders, the scheduler's ticket-release subscriber, the
linker subscriber) use the real `audit.subscribe` and are
unaffected.

---

## 5. Provider abstraction (Decision 29)

`agents.sendMessage` does not know about Claude, Together, or any
specific provider. It looks up `agent.provider.kind` in the
`ProviderRegistry` and delegates.

```ts
runtime.agents.providers.register({
  kind: 'claude',
  sendMessage: async ({ agent, prompt, turn, reply }) => {
    // provider-specific delivery, streaming, and completion
  },
  // optional: pool semantics, session creation, /clear, etc.
});
```

Registered today:

- **`claude`** — stateful CLI sessions, pool-managed, `/clear` between
  leases.
- **`mock`** — synchronous echo with a synthetic streaming pattern.
  Used by the engagement-flow smoke test (`runSchedulerLease({mock:
  true})`).

Coming:

- **`together`** — stateless HTTP. Does not use the session pool. See
  Decision 35.
- **`openrouter`**, **`ollama`** — also stateless.

The pool is a Claude-shaped concern that currently leaks through
`agents.lease`. [Decision 35](35-session-pool-rethink) tracks moving
pool semantics behind the provider abstraction so non-Claude
providers don't traverse pool code at all.

---

## 6. Lease and bind

Two distinct operations, often confused:

| Operation | Effect | When |
|---|---|---|
| **Lease** | Acquire a session from the provider (Claude: pool checkout; stateless: no-op identity). Mints an `Agent` record with a `provider`. | Once per engagement (typical) or once per Turn (Together throughput case) |
| **Bind** | Attach an `agentId` to an `engagement.boundAgentIds[]`. Pure record link, no provider involvement. | Always paired with lease in the auto-lease subscriber |

The Engagement Flow Track closed the historical gap where `lease`
ran but `bind` did not — the auto-lease subscriber now calls
`engagements.bindAgent` so the UI no longer needs the
"lease-then-bind" two-step.

The **escape hatch**: `runSchedulerLease(engId, {mock: true})` mints
a real Agent with `leasedFrom: 'manual'`, an explicit
`sessionId: 'mock-sess_<engId>'`, and `provider: {kind: 'mock', ...}`.
Bypasses the pool. Used by the smoke test so it runs in any
environment.

---

## 7. Persistence

Subsystems that participate in dispatch and need restart-survivable
state implement `Persistable`:

- **`runtime.engagements`** — Engagement records, including
  `boundAgentIds` and `turnIds`.
- **`runtime.agents`** — Agent records and bindings.
- **`runtime.agents.scheduler`** — WorkItem queue **and** active
  ticket store (the per-engagement history ring is in-memory only;
  long-term analytics consume the audit log).
- **`runtime.agents.turns`** — Turn records.
- **`runtime.agents.replies`** — ReplyRecords (open + recent
  completed).
- **`runtime.engagementFlow`** — PrepData store, accumulated outputs
  per engagement, recent-emissions ring (volatile by design — does
  not persist).

The runtime auto-synthesizes `<name>.json()` from each subsystem's
`saveJson()`. Do not declare a manual `.json()` — the loader will
refuse the object with a "rename or remove" error (one of the
friction items from the backend Track).

---

## 8. Attribution and whoami

Every emit carries `by` somewhere — either explicit on the call or
resolved from the ambient `whoami` context (see [whoami](whoami)).
The dispatch chain propagates `by` from caller → scheduler → ticket
→ turn → reply, so a single audit query can answer "what did the
oversight agent dispatch in the last hour?":

```ts
const events = await runtime.audit.find({
  kind: 'agents.turn.opened',
  by: 'oversight-agent',
  since: Date.now() - 60 * 60 * 1000,
});
```

Joining `events[i].data.ticketId` against `scheduler.listTickets({
includeHistory: true })` then yields the outcome label and (in v2)
cost per dispatch.

---

## 9. Worked example — one Turn, end to end

```ts
// 1. UI opens an engagement (shape: 'ai-ui')
const eng = await runtime.engagements.open({
  activityId: 'general',
  scope: { kind: 'project', ref: 'qb' },
  shape: 'ai-ui',
  by: 'user',
});
// → audit: engagements.opened
// → subscriber fires: Secretary prep + Scheduler lease in parallel
//    (emits 5 progress kinds, binds agent, sets boundAgentIds[0])

// 2. User submits a prompt
const t = await runtime.engagementFlow.dispatchTurn(eng.id, {
  text: 'Summarize the last 3 commits',
  by: 'user',
  outcome: 'summary',
});
// → ticket issued (audit: agents.scheduler.ticket-issued)
// → PrepData spliced (Turn #1)
// → Turn opened (audit: agents.turn.opened with ticketId)
// → engagements.addTurn linked
// → audit: engagements.turn-queued

// 3. Model streams (provider-driven)
// → audit: agents.reply.chunk × N

// 4. Model finishes
// → audit: agents.turn.completed
// → subscriber: scheduler releases ticket (audit:
//    agents.scheduler.ticket-released, reason: 'completed')
// → ticket archived to per-engagement history

// 5. UI marks engagement done
await runtime.engagements.complete(eng.id, { by: 'user' });
// → subscriber: Secretary linker runs
//    (emits linker-started, linker-complete with linkedOutputs[])

// 6. Diagnostics — full lineage
const hist = await runtime.agents.scheduler.tickets.history(t.ticketId);
// → { events: [{issued}, {used, turnId}, {completed}], ticket: {...} }
```

---

## 10. Open design questions

Items that are explicitly **not** settled by this document.

### Pool shape per provider — [Decision 35](35-session-pool-rethink)

The session pool is currently universal (`agents.lease` always
traverses it). Production incident on 2026-05-17 saw a runaway loop
creating/clearing sessions. Mitigation: code commented out;
re-enablement gated on the broader question of "does the pool belong
on every provider, or only Claude?" Probable resolution: dispatch
pool behind the provider abstraction; Together / OpenRouter / Ollama
get a no-op lease.

### v2 fail-closed ticket gate — [Decision 34](34-ticket-model)

`agents.sendMessage` will eventually throw `MissingTicketError` when
`ticketId` is missing. v1 (today) is fail-soft because existing
callers (workspace-ui chat tool, secretary-pass loop, scheduler-tick
consumer, AI scheduler optimizer) all bypass tickets. The
`agents.send-without-ticket` audit-warning count is the migration
metric.

### Cost / token / spend on Ticket

The Ticket type reserves fields for model / tokens / cost; v1 records
none. v2 will require provider implementations to surface these on
`turn.completed`. Routing intelligence (Sonnet vs Opus, cheaper
provider for retries) then consults `outcome` + cost history on the
ticket.

### Per-Turn lease as default

v1 defaults to engagement-affinity (Claude-friendly: one agent
serves all Turns in an engagement). For all-Together engagements,
per-Turn lease may better utilize pool capacity. Deferred until
Together throughput data exists.

### `engagements.setMetadata`

Today PrepData is keyed by `engagementId` inside the engagement-flow
subsystem because there's no general-purpose engagement-metadata
setter. If demand emerges from other callers, adding
`engagements.setMetadata(...)` would generalize the pattern.

---

## 11. Boundaries with sibling docs

- **[`SA-Engagement-Flow.md`](sa-engagement-flow)** — Engagement
  lifecycle, Activities, the prep/lease/link subscriber contract.
  This doc starts where that one ends (at "Turn dispatched").
- **[`agent-roles`](agent-roles)** — Role catalog and binding scopes.
  Dispatch doesn't care which role an Agent has; this doc is
  role-agnostic.
- **[`whoami`](whoami)** — Caller-attribution propagation. Used by
  every emit in §4 to resolve `by:`.
- **[Decision 29](29-agent-providers-and-sendmessage)** — Provider
  registry mechanics, why `sendMessage` is provider-dispatched.
- **[Decision 34](34-ticket-model)** — Full rationale for the Ticket
  model and the gate posture.
- **[Decision 35](35-session-pool-rethink)** — Open design question
  for pool semantics.
- **[Decision 36](36-scheduler-routing-model)** — Activity Table +
  Mode + AI-Choose. The routing contract referenced from §2 "Inside
  the Scheduler" above.
