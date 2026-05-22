---
slug: agent-roles
title: Agent Roles
aliases: [roles, agent-types, role-catalog, sa-agent-roles, seeded-roles]
keywords: [agent, role, conductor, secretary, scheduler, supervisor, configuration, run, oversight, coordinator, project-coordinator, instructor, advisor, assessor, runagent, scope, binding, register, catalog, non-claude-ai]
summary: >
  Catalog of agent roles in blur-agent — supervisor, configuration,
  conductor, run, oversight, secretary, scheduler, coordinator,
  instructor, advisor, assessor. Each role declares its
  responsibilities, default binding scopes, and handoff layout.
  Roles are an open registry; new ones register at runtime.
  Coordinator (added 2026-05) carries cross-Track state awareness
  as concurrent work grows; see role-project-coordinator for the
  deep dive. Instructor (added 2026-05) is the first non-Claude AI
  role — recommendation engine plugged into the OrientationDecl
  `{ instruct }` form.
type: architecture
audience: [ai, human]
status: settled
tags: [agents, substrate, sa, roles]
related: [lease-and-bind, whoami, role-project-coordinator, supervisor-patterns]
spotlight: true
---

# Agent Roles

An **Agent** is a durable record of "who is doing what." It pairs a
**role** (responsibility shape) with one or more **bindings** (which
project / track / arc this agent is responsible for) and an optional
**handoff** pointer (where the agent reads its charter).

The role catalog is an **open registry**. blur-agent seeds eleven
default roles at install; packs and runtime callers can register
additional roles via `runtime.agents.roles.register(...)`.

**2026-05 expansion (Fork A / Fork B substrate work):** Instructor,
Advisor, and Assessor join the eight original seeded roles.
Instructor is the **first non-Claude AI role** — plugged into the
polymorphic `OrientationDecl { instruct }` form so any primitive
exposure can request a smart recommendation in place of a static
docs/anchors/activities list. Advisor and Assessor are
forthcoming patterns staking out the "answer a question" and
"produce a structured judgment" niches respectively.

## v0.1 implementation status

Two roles get their first runtime subsystems in v0.1 of the
substrate (per `brief-mvp-substrate-v1`):

| Role | v0.1 status | Subsystem | Doc |
|---|---|---|---|
| **Run** | **Implemented (Runner construct)** — `runtime.runners.*` | `run-subsystem.ts` | `role-run.md` |
| **Secretary** | **Implemented (transcript sync)** — `runtime.secretary.*` | `secretary-subsystem.ts` | `role-secretary.md` |
| **Instructor** | **Emerging (Fork B substrate)** — `runtime.instruct(...)` integration point in `OrientationDecl`; resolver stub at `orientation.ts` returns `{ docs: [], note: 'instruct unavailable — Phase 3 pending' }` until the Fork B primitive ships. First non-Claude AI role — cheap/fast provider by default. | `instruct-subsystem.ts` (Fork B) | (forthcoming) |
| Conductor | Doc only — bootstrap via human/UI | — | (forthcoming) |
| Project Coordinator | Doc only — see role-project-coordinator | — | `role-project-coordinator.md` |
| Supervisor | Existing patterns (supervisor-patterns.md) | — | `supervisor-patterns.md` |
| Configuration | Doc only | — | (forthcoming) |
| Oversight | Doc only | — | (forthcoming) |
| Scheduler | Doc only | — | (forthcoming) |
| Advisor | Doc only (placeholder — pattern emerging) | — | (forthcoming) |
| Assessor | Doc only (placeholder — pattern emerging) | — | (forthcoming) |

The other documentation-only roles wait on their patterns to
crystallize. The bootstrap path: human/UI plays the role manually;
as automation lands, the role's subsystem takes over.

## The eleven seeded roles

| Role id | Label | Responsibility | Default binding scopes |
|---|---|---|---|
| `supervisor` | Supervisor | Cross-project, human-in-the-loop. Sets the north-star, resolves gate Decisions, leases Conductors, ratifies methodology changes. **Depth-first quality assessment per Track.** | `cross-project` |
| `configuration` | Configuration Agent | Shapes project Charter and runtime configuration. Co-authors methodology with the Supervisor. Distinct per-project where helpful. | `project`, `cross-project` |
| `conductor` | Conductor | Walks an Arc on a project. Promotes ready Moves, dispatches RunAgents, opens gates, resolves cross-Arc dependencies. **State-machine driver, NOT executor.** | `project`, `arc` |
| `run` | RunAgent | Executes one Move at a time on a track. Generates Charter Steps, files Tickets, emits Telemetry. Bound at track scope so the next Move on the same track can reuse the agent. | `track`, `move` |
| `oversight` | OversightAgent | Risk-watcher. Reads project + track state, raises Risks on the Charter, files high-severity Tickets when warranted. **Read-mostly; does not execute Moves.** | `project`, `track` |
| `secretary` | Secretary Agent | Background extractor / organizer. Reads completed Engagements + Turn histories and writes structured outputs (project metadata, North Star transcripts, Decision logs). Mechanical sorting, not interpretation. Designed for cheap providers; many parallel passes run concurrently. | `project`, `cross-project` |
| `scheduler` | Scheduler Agent | Resource optimizer for the WorkItem queue. Watches assignments, agent utilization, and recent outcomes; nudges assignment decisions on top of the deterministic algorithm. **Mechanism: picks who runs.** | `runtime`, `cross-project` |
| `coordinator` | Project Coordinator | **Breadth-first across Tracks.** Rolls up cross-Track state on a cadence, detects cross-stream conflicts (shared assignee / quota) + dependency resolutions, feeds digests to Supervisor and UI, hints priorities to Scheduler. **Policy/signal layer for fleet awareness.** See [role-project-coordinator](role-project-coordinator) for the deep dive. | `cross-project`, `runtime` |
| `instructor` | Instructor | **Recommendation engine.** Given a task + context, produces structured orientation (docs / anchors / activities / note) for the calling agent. Plugs into the polymorphic `OrientationDecl { instruct: { task, context? } }` form — any primitive exposure can declare instruct-based orientation, and the runtime calls the Instructor on each invocation, returning the resolved recommendation as the wrap orientation. **First non-Claude AI role** — designed for cheap, fast providers (Together by default). Read-mostly: synthesizes existing substrate state (docs, anchors, activities, recent decisions) into actionable guidance per call. Per-invocation latency budget matters. | `runtime`, `cross-project` |
| `advisor` | Advisor | **Question-answerer.** Reads a situation (project state, recent decisions, open tickets, charter direction) and produces a structured recommendation on a specific question raised by the caller. Distinct from Configuration (which shapes the Charter) and Oversight (which raises Risks). The Advisor outputs an opinion + supporting evidence; the caller decides whether to act. Forthcoming — pattern emerging from the Fork A substrate-self-teaching work and is being placed-in-advance pending crystallization. | `project`, `cross-project` |
| `assessor` | Assessor | **Judgment producer.** Reads work product (Turns, outputs, commits, briefs) and writes structured Assessments — quality / completeness / risk reads with explicit criteria. Distinct from Supervisor (which acts on assessments) and Secretary (which extracts without interpretation). Designed to run on a cadence per Track or per Phase, feeding the management UI. Forthcoming — staking out the "produce a defensible evaluation artifact" niche. | `track`, `project` |

## Binding scopes

An agent's `bindings` array says **what the agent is responsible for**.
Same agent can be bound at multiple scopes simultaneously (Conductor
bound at `project` AND at one `arc`, for example).

| Scope | Ref shape | Use |
|---|---|---|
| `cross-project` | (omitted) | Supervisors, secretaries that span all projects |
| `project` | `<projectId>` | The most common Configuration / Oversight binding |
| `track` | `<projectId>/<trackId>` | RunAgents that own a track's execution |
| `arc` | `<arcId>` | A Conductor bound to one specific Arc |
| `move` | `<arcId>/<moveId>` | Rarely used — when a Move warrants its own agent |
| `pack` | `<packId>` | Pack-maintainer agents |
| `runtime` | `<runtimeId>` or `'global'` | Scheduler, fleet-level oversight |

## Lifecycle

1. **Mint:** `runtime.agents.lease(opts)` wraps `runtime.pool.lease(...)`
   and returns a freshly-minted `Agent` record with `status: 'live'`,
   a freshly-acquired session, and the chosen role.
2. **Bind:** `runtime.agents.bind(agentId, binding)` attaches a scope.
   The Conductor binds RunAgents to tracks; the Supervisor binds
   Conductors to projects.
3. **Work:** the agent acts in its bound scope. Notes accumulate via
   `runtime.agents.notes.add(agentId, note)`.
4. **Pause / Release:** `runtime.agents.release(agentId)` returns the
   underlying session to the pool but preserves the Agent record. The
   agent can be re-leased later — durable identity survives session
   swaps.

## Role evolution

Roles are an open registry, but **modifying the seeded roles is not in
scope for callers of this pack.** Role evolution is its own
workstream. If you need a variant — say, a "RunAgent for analytics
tasks specifically" — register a new role:

```javascript
await runtime.agents.roles.register({
  role: {
    id: 'run-analytics',
    label: 'Analytics RunAgent',
    description: 'RunAgent specialized for analytics-style Moves...',
    defaultBindingScopes: ['track', 'move'],
    defaultHandoffCwdTemplate:
      '~/.blur/blur-project-management/{projectId}/handoffs/{trackId}/analytics/',
  },
  by: '<your-sessionId>',
});
```

## When inference isn't enough

Most binding / lease / bind operations are inferable from
`runtime.agents.*` primitive signatures. Reach for this doc when:

- You're choosing **which role** to lease and not sure which one
  matches your task.
- You see a role id in `runtime.agents.list()` output and want to
  know what it does.
- You're designing a new role and want to see what binding-scope
  shape the existing roles use.

See [lease-and-bind](lease-and-bind) for the two-step ritual to get
an agent attached to a scope, and [whoami](whoami) for how a session
discovers its own role.
