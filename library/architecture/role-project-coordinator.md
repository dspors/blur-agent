---
slug: role-project-coordinator
title: Role — Project Coordinator
aliases: [project-coordinator, coordinator-role, coordinator-agent, cross-stream-coordinator, role-coordinator]
keywords: [coordinator, project-coordinator, cross-stream, cross-project, multi-track, prioritization, dependency, conflict-detection, rollup, digest, status, scheduler, supervisor, agent, role, breadth-first, fleet, capacity, blocked, dependency-resolved]
summary: >
  Eighth agent role — Project Coordinator. Carries the cross-stream
  awareness load that today smears across Supervisor + Scheduler +
  manual operator tracking the moment more than one Track is in
  flight. Coordinator is breadth-first across Tracks (Supervisor is
  depth-first within a Track) and provides policy/signal for what to
  prioritize (Scheduler provides the mechanism for who runs it).
  Outputs serve both AI consumers (audit events, telemetry hints for
  the Scheduler) and UI (human-readable rollup digests in the
  workspace). Documents responsibilities, the cuts that separate it
  from the seven seeded roles, primitives it reads/emits, and v1 vs
  deferred scope.
type: architecture
audience: [ai, human]
status: settled
tags: [agents, roles, substrate, coordinator, cross-stream, sa]
related: [agent-roles, supervisor-patterns, flow-engagement-turn-queue, flow-artifact-sync, project-management-101]
supersedes: []
supersededBy: null
spotlight: true
---

# Role — Project Coordinator

## Why this role exists

The moment more than one Track is in flight, a cross-stream awareness
burden appears that no existing role cleanly owns:

- "Where are we across all six active Tracks right now?"
- "Two Tracks both want the OpenAI-quota-heavy agent. Which goes first?"
- "Track A is blocked on Track B's output — Track B just shipped; nobody told A."
- "Supervisor wants to assess the fleet but has to read six telemetry streams to do it."
- "The UI tab wants to show 'state of play' across the workspace; today it has to compose that view itself."

Today this burden lands on the human operator (informally), the
Supervisor (who has to do their own rollups before assessing), and the
Scheduler (which has only local information about its own queue).
That's a smear of responsibility across three places, none of which
own it.

The Project Coordinator role owns it.

## The clean cut

Two distinctions make this role separable rather than redundant:

| Comparison | Coordinator | The other role |
|---|---|---|
| **Vs. Supervisor** | Breadth-first across Tracks. "What's the fleet doing?" | Depth-first within a Track. "Is THIS work good?" |
| **Vs. Scheduler** | Policy/signal. "Track A's WorkItem should run before Track B's because A is blocking three downstreams." | Mechanism. "Given the priority-sorted queue, who runs item X?" |
| **Vs. Conductor** | Cross-Track / cross-project. | Within a single Arc/Track. Sequences phases inside one workstream. |
| **Vs. Secretary** | Cross-Engagement state aggregation. | Per-Engagement context + result-linking. |
| **Vs. Oversight** | Multi-Track aggregation that feeds Oversight + Supervisor. | Method-specific health checks on one Track. |

The Coordinator is the **fleet-aware** role. The seven seeded roles
are all either Track-focused (run, oversight, secretary), Arc-focused
(conductor), project-focused (configuration), runtime-focused
(scheduler), or cross-everything-but-task-specific (supervisor,
whose responsibilities are about quality not state-tracking).

## What the Coordinator does

Six responsibilities, roughly in order of expected usage frequency:

### 1. Roll up cross-Track state on a cadence

The Coordinator reads:

- `runtime.projects.list()` filtered to `status: 'active'`
- For each active project: `charter.get()` + `tracks.list()`
- For each active Track: `telemetry.events({ sinceAt: lastRollupAt })`
- `runtime.engagements.*` for in-flight Engagement status
- `runtime.tickets.list({ status: ['open', 'in-progress'] })` for blockers

…and emits **one consolidated digest** as a `coordinator.rollup` audit event
plus (in v1) a markdown file at a stable path the workspace UI can read.

Default cadence: every 5 minutes. Configurable. Also fires on-demand
when the Coordinator receives a bridge ping requesting a fresh
rollup.

### 2. Detect cross-Track conflicts

When two active Tracks both want the same scarce resource — same
assigned agent, same provider quota, same external dependency (a
human reviewer, a specific tool tab in the UI) — the Coordinator
surfaces the conflict early:

- Emits `coordinator.conflict` audit event with the conflicting Track
  refs + the resource in question.
- Pings the Supervisor if severity is high (both Tracks blocked).
- Records the conflict as a Risk on each Track's Charter for
  durability (`charter.addRisk`).

### 3. Detect dependency resolution

`Track.dependsOn[]` is already a primitive. Today nothing watches for
"the thing this Track was waiting on just shipped." Coordinator does:

- Watches for `telemetry.emit({ kind: 'milestone-reached' })` and
  `tracks.setStatus(..., 'shipped')` events.
- Cross-references against `Track.dependsOn` arrays across the fleet.
- For each newly-unblocked downstream Track: emits
  `coordinator.unblocked` event AND optionally pings the agent
  assigned to that Track.

### 4. Hint priorities to the Scheduler

The current `runtime.scheduler.*` v0 algorithm picks an agent for a
WorkItem via preferredAgentId → role+capability → LRU. Coordinator
injects **WorkItem-level priority hints** so the Scheduler has
fleet-aware ordering signal, not just local-queue signal:

- Boost: Track is blocking three downstream Tracks.
- Boost: Track shipped a milestone and the next WorkItem is the
  smoke-test that proves it.
- Lower: Track is ahead of plan and can absorb a wait.
- Lower: Track is paused or in REVIEW gate.

Mechanism (v1): Coordinator writes to a `runtime.coordinator.hints`
read surface; Scheduler reads it as one of several priority inputs.
The Scheduler's deterministic algorithm still wins; Coordinator hints
break ties or weight an otherwise-equal choice.

### 5. Provide a roll-up "state of play" surface to the UI

The workspace UI today (and the workspace-ui Track's
engagement-project-tool in progress) want a stable read primitive that
answers "what is happening right now across this workspace?"
without having to scrape `projects.list()` + `engagements.list()` +
`telemetry.events()` themselves.

Coordinator exposes:

- `runtime.coordinator.stateOfPlay({ scope?, since? })` →
  `{ activeTracks, inFlightEngagements, openTickets, recentMilestones, conflicts, blockers, digest }`
- Same data underlying the rollup audit events.
- Cheap to call (cached; refreshed on each rollup cadence).

### 6. Brief returning operators / fresh sessions

When a session boots and wants to know "what was happening when I
left?", the Coordinator's most recent digest is the right answer.
Cheaper than reading three days of audit by hand. Particularly useful
for:

- The Supervisor's periodic-health-probe pattern (pattern D in
  supervisor-patterns) — Supervisor reads Coordinator's digest as the
  starting point for its own assessment, instead of fetching the raw
  streams.
- A new Code session opening on a worktree the operator hasn't
  visited in a day.
- Recovery from runtime restart — pre-restart digest read on first
  boot.

## What the Coordinator is NOT

- **Not a Supervisor replacement.** Supervisor evaluates QUALITY of
  individual work (the five supervisor patterns — Quality-Prompt-at-
  Boundaries, Cascade-Detection, etc.). Coordinator evaluates STATE
  across work. Supervisor still owns the depth-first quality call;
  Coordinator hands the Supervisor a better starting point.

- **Not a Scheduler replacement.** The Scheduler still picks the
  agent and runs the algorithm. Coordinator provides one of several
  signals the Scheduler weighs.

- **Not a Conductor replacement.** Conductor walks an Arc within a
  project, sequencing Moves. Coordinator does not care about
  intra-Track sequencing; it cares about inter-Track state.

- **Not a metric system.** Performance metrics belong on the Track
  Charter (`runtime.projects.telemetry.sampleMetric`). Coordinator
  consumes them as one input but does not own them.

- **Not a UI.** The workspace-ui Track owns the UI rendering;
  Coordinator owns the DATA the UI renders. Same `stateOfPlay`
  primitive can drive multiple UI surfaces and AI consumers
  symmetrically.

## Primitives the Coordinator uses

### Reads (the data sources)

- `runtime.projects.list({ includeArchived: false })`
- `runtime.projects.charter.get(projectId)`
- `runtime.projects.tracks.list(projectId)`
- `runtime.projects.telemetry.events(projectId, trackId, { sinceAt })`
- `runtime.engagements.list({ status: 'active' })` (Engagement-level)
- `runtime.agents.turns.list({ status: 'in-flight' })` (Turn queue depth)
- `runtime.scheduler.list?` (current WorkItem queue, if exposed)
- `runtime.tickets.list({ status: ['open', 'in-progress'] })`
- `runtime.decisions.list({ state: 'open' })`
- `runtime.audit.*` (subscribe to telemetry topics for incremental updates)

### Writes (the outputs)

- `runtime.audit.appendEvent('coordinator.rollup', digest)` — every cadence.
- `runtime.audit.appendEvent('coordinator.conflict', { tracks, resource })` — on detection.
- `runtime.audit.appendEvent('coordinator.unblocked', { downstreamTrack, dependsOn })` — on detection.
- `runtime.projects.telemetry.emit(projectId, trackId, { kind: 'method-event', methodEventKind: 'coordinator-observation', ... })` — when an observation belongs on a specific Track's record.
- `runtime.projects.charter.addRisk(projectId, ...)` — when a conflict warrants durable Risk capture.
- Library entry under `library/etal/coordinator-digest-<date>.md` (or similar) for human-readable archive (cadence-throttled; not every rollup).

### New primitives (substrate work, v1.5+)

These primitives don't exist yet. They land as part of Coordinator v1:

- `runtime.coordinator.stateOfPlay({ scope?, since? })` → digest
- `runtime.coordinator.rollup({ force?: boolean })` → manually trigger a fresh pass
- `runtime.coordinator.hints` → read surface for Scheduler integration
- `runtime.coordinator.subscribeToChanges(...)` → push-mode for UI clients

## Position relative to Supervisor + Scheduler

A simple diagram:

```
                      ┌──────────────┐
                      │  Supervisor  │  Depth-first per Track.
                      │              │  Reads Coordinator's digest
                      └───────┬──────┘  as the starting point.
                              │
                              │ reads digest
                              ▼
   ┌─────────────┐    ┌──────────────┐    ┌────────────────┐
   │ All active  │───▶│  Coordinator │───▶│   UI (state-   │
   │ Tracks +    │    │              │    │   of-play tab) │
   │ Engagements │    │ • rollup     │    └────────────────┘
   │ + Tickets + │    │ • conflicts  │
   │ Decisions   │    │ • unblockers │    ┌────────────────┐
   └─────────────┘    │ • hints      │───▶│   Scheduler    │
                      └──────────────┘    │  (priority     │
                                          │   input)       │
                                          └────────────────┘
```

Coordinator is the **policy/signal layer** for fleet awareness.
Everyone else is either the data source (Tracks/Engagements/
Tickets/Decisions), a consumer of the digest (Supervisor, UI), or a
consumer of the priority hints (Scheduler).

## v1 scope vs deferred

**v1 (initial bring-up):**

- One Coordinator agent per workspace (cross-project scope). Single
  instance — coordination of coordinators is out of scope.
- Pull-cadence rollup every 5 min, emits `coordinator.rollup` audit
  event with full digest payload.
- Conflict detection for two cases: shared-agent-assignee + shared-
  provider-quota.
- Dependency-resolution detection by watching `track.shipped` +
  `milestone-reached` events.
- `runtime.coordinator.stateOfPlay()` read primitive.
- Markdown digest archive under a stable path (not via the library
  rescan flow — these are dated snapshots, not durable docs).

**Deferred (v1.5+):**

- Scheduler priority-hint integration. Needs Scheduler API changes
  (new priority input). Design first, file a Ticket.
- Capacity modeling (estimate work-time remaining per Track from
  Charter step + telemetry patterns).
- Predictive routing ("based on past completion patterns, this
  WorkItem belongs on agent X").
- Multi-workspace coordination (federation across hosts).
- Subscribe-based push for UI (UI polls `stateOfPlay()` in v1; SSE
  push in v1.5+).
- Auto-mitigation actions (Coordinator currently only DETECTS
  conflicts; v1.5 could empower it to propose or even apply
  mitigations — pause a Track, reassign an agent).

## Open design questions

1. **Cadence configurability.** 5 min is a guess. Real workflow may
   want 1 min or 15 min. Expose as a runtime config and let the
   Supervisor adjust based on workspace pace?

2. **Digest persistence.** Library doc per rollup is too noisy (every
   5 min produces an entry). Some other archive — a single rolling
   "current state" library entry that gets overwritten, plus
   `coordinator.rollup` audit events for history? Or a dated
   archive only at meaningful state changes?

3. **Coordinator subscribes vs polls.** v1 polls (simple). Eventually
   Coordinator should subscribe to audit topics for low-latency
   conflict + unblocker detection. Needs the substrate SSE primitive
   that `tkt_682f42ee` defers until 2nd consumer — the Coordinator
   might be that second consumer.

4. **Role binding.** Default scope is `cross-project`. Could a
   project-scoped Coordinator make sense for a single high-traffic
   project (e.g., one Coordinator per workspace, plus a dedicated
   one for blur-providers if its activity dominates)? v1: no, but
   not ruled out for v1.5.

5. **Authority to act vs report-only.** v1 is report-only. v1.5
   could let the Coordinator request a Track pause / agent
   reassignment with Supervisor sign-off. Stays out of scope until
   the report-only version is in steady use.

## First steps when a Coordinator session is bound

When you've leased the Coordinator role to a fresh session, the
session's HANDOFF should direct it to:

1. `runtime.projects.list({ includeArchived: false })` — discover the
   fleet.
2. For each active project: `runtime.projects.charter.get(id)` +
   `runtime.projects.tracks.list(id)` — load state.
3. `runtime.tickets.list({ status: ['open', 'in-progress'] })` +
   `runtime.decisions.list({ state: 'open' })` — pull cross-cutting
   work.
4. Read recent audit (`runtime.audit.list({ topic: 'coordinator.*',
   sinceAt: <24h ago> })`) to bootstrap from prior Coordinator state
   if one ran before.
5. Compose initial baseline digest. Emit `coordinator.rollup` audit
   event.
6. Set the 5-min cadence timer. On each tick: incremental rollup
   from telemetry events sinceAt last-rollup.
7. Stand by for high-criticality push events — block detected,
   dependency resolved — and emit immediately rather than waiting
   for the next cadence tick.

The Supervisor can request a fresh rollup at any time via bridge
ping; the Coordinator should handle that as an interrupt.

## Cross-references

- [agent-roles](agent-roles) — the catalog. Coordinator joins the
  seven seeded roles as the eighth entry.
- [supervisor-patterns](supervisor-patterns) — Supervisor reads
  Coordinator's digest as the starting point for the periodic-
  health-probe pattern (Pattern D) and the strategic-drift-and-
  reorient pattern (Pattern E).
- [flow-engagement-turn-queue](flow-engagement-turn-queue) — the
  Scheduler that Coordinator hints to.
- [flow-artifact-sync](flow-artifact-sync) — the same "wait for
  second consumer" deferral pattern Coordinator's substrate SSE
  needs (tkt_682f42ee).
- [project-management-101](project-management-101) — the how-to
  guide that points at Coordinator as the "where are we?" answer.

## Status

Authored 2026-05-17. Not yet bound to a session — the role definition
is in place; substrate primitives (`runtime.coordinator.*`) are not
yet implemented. Pass A (AgentRoleDef field extension + per-role
charter docs) will land the role seed; subsequent ticket will land
the substrate primitives. Until then, the responsibilities described
here can be carried by the Supervisor on a temporary basis — but the
goal is to separate them cleanly because the burden is real and
keeps growing as concurrent work increases.
