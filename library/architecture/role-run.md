---
slug: role-run
title: Role — Run (Runner construct)
aliases: [run-role, runner-role, runners]
keywords: [run, runner, role, work-execution, claude, bridge-session, transcript, executor]
summary: >
  The Run role formalizes work-as-Claude-session. A Runner is a stable
  record carrying prompt, bridge-session handle, transcript, and
  lifecycle. The Runner identity persists across session compaction or
  replacement — sessions are an implementation detail.
type: architecture
audience: [ai, human]
status: settled
tags: [run, runner, role, agents, substrate]
related: [agent-roles, role-project-coordinator, brief-mvp-substrate-v1, role-secretary]
spotlight: true
---

# Role — Run (Runner construct)

## What this role does

**Run** is the work-execution role. Its instances are **Runners**:
stable, addressable records of work being done. Each Runner is
currently implemented by a Claude bridge session, but the construct
is engine-agnostic — future implementations (other LLMs, smaller
agents, automated tools) plug in via the same Runner interface.

The Run role bridges:
- **Orchestration** (Conductor / PM decide what work to do) →
- **Execution** (a Claude session does the work) →
- **Recording** (Secretary archives the transcript) →
- **Outcome** (results feed back into substrate state)

## The Runner record

A Runner carries:

| Field | Purpose |
|---|---|
| `id` (`rnr_<12 hex>`) | Stable across session lifecycle. Sessions can compact/end; this id persists. |
| `title` | Short human-readable name |
| `briefSlug?` | Pointer to the Brief defining this Runner's work (see brief-patterns `runner-spec`) |
| `prompt?` | The prompt seed the Claude session was given |
| `status` | `queued | running | paused | completed | failed` |
| `bridgeSessionId?` | Current bridge session implementing this Runner |
| `transcript?` | Snapshot of the work (filled by Secretary) |
| `forRef?` | What artifact this Runner operates on (project, ticket, brief, etc.) |
| `filedAt` / `filedBy` | Provenance |
| `startedAt` / `completedAt` | Lifecycle timestamps |
| `outcome?` / `failureReason?` | Why it ended |
| `scope` | `runtime | project | pack | track` |

The Runner is **the unit of accountability** for a piece of work. You
ask about a Runner; you don't ask about a session.

## Lifecycle

```
file → queued → (bind to session) → running ⇄ paused → completed | failed
```

- **`file({ title, briefSlug?, prompt?, ... })`** — record a new
  Runner to be executed. Starts in `queued`.
- **`bind(id, { bridgeSessionId })`** — attach a bridge session
  (Claude bridge running the work). Marks `running`. v0.1 is manual
  (human/UI calls this after spawning a session); future is automated
  spawn-and-bind by Conductor.
- **`pause(id)`** — pause a running Runner (e.g., switching contexts).
- **`markCompleted(id, opts)`** — positive exit. Optional final
  outcome and transcript.
- **`markFailed(id, opts)`** — negative exit with reason.
- **`setTranscript(id, transcript)`** — Secretary's hook for syncing
  the Claude transcript into the Runner record.

## Audit events

| Event | When |
|---|---|
| `runners.filed` | New Runner recorded |
| `runners.bound` | Bridge session attached |
| `runners.paused` | Runner paused |
| `runners.completed` | Positive exit |
| `runners.failed` | Negative exit |
| `runners.transcript-synced` | Secretary attached / updated transcript |

## Why the Runner identity matters

The user articulated the pain this solves:

> "I have forgotten what session's context did we have a conversation
> about Xyz... compaction has happened and the session I had a
> conversation with about something has moved on from that and the
> ability to pick up where we were on that topic is gone."

A Runner is a stable handle that survives session lifecycle. You
never look up by session id (which can become stale). You look up by
Runner id. The session is an implementation detail; the Runner
identity is the addressable thing.

This matters for:
- **Resuming work** — find Runner R, see what's there, continue
- **Auditing** — what happened across sessions for project X? Query
  Runners with `forRef: { kind: project, ref: X }`
- **Coordinating handoffs** — Conductor reads "Runners in flight";
  Secretary reads "Runners needing transcript sync"; PM reads
  "Runners ending without next-turn decided"

## Bootstrap

v0.1 is heavily manual. The Conductor role isn't implemented yet, so
human/UI plays Conductor:

1. Human reads state (anchors, blockers, briefs)
2. Decides: "let's kick off Runner R using brief B"
3. Calls `runtime.runners.file({ title, briefSlug: B, prompt, filedBy: 'me' })`
4. Spawns a Claude session manually with the prompt
5. Calls `runtime.runners.bind(R, { bridgeSessionId: session_id })`
6. The Claude session runs; produces work
7. At session-end, human calls `runtime.secretary.archiveRunner(R, { outcome, transcript })`

As roles automate, steps 2, 4, 5, 7 progressively move to AI sessions
(Conductor for 2/4/5; Secretary already handles 7 when called).

## What v0.1 does NOT do

- **Auto-spawn bridge sessions.** `bind()` is manual; the human/UI
  has to start the Claude session and supply the bridgeSessionId.
- **Auto-pull transcripts.** Secretary's `syncTranscript()` takes the
  transcript as an argument; Bridge-driven automatic pulling is a
  future enhancement.
- **Recursive Runner spawning.** A Runner asking "can I get help?"
  by filing a sub-Runner is a future pattern. For now, in-session
  delegation happens within the parent session.
- **Cross-engine Runners.** Today all Runners run on Claude bridge
  sessions. The interface allows for future engines; no second
  implementation exists yet.

## Where the code lives

| Concern | File |
|---|---|
| Subsystem | `blur-agent/src/pack/run-subsystem.ts` |
| Exposures | `blur-agent/src/pack/run-exposures.ts` |
| Wired in | `blur-agent/src/pack/index.ts` |

## What connects to what

- **Briefs** — Runner reads its briefSlug Brief at boot for context.
  See `brief-patterns` for the `runner-spec` kind.
- **Blockers** — Runner kickoff is gated by Blockers in its forRef
  chain. Conductor uses `runtime.blockers.unblockedAmong(candidates)`
  to filter Runners ready to kick off.
- **Secretary** — Secretary subscribes to runners.* events; performs
  transcript sync and archive on end.
- **Anchors** — Runner honors active Anchors during execution; can
  challenge / supersede them mid-flight.
- **Tickets** — Runner can file Tickets during execution for
  follow-up work (next-iteration candidates).
- **Decisions** — Runner records Decisions at scope `runner` for
  choices made mid-flight; some propagate up to project/portfolio
  scope at end-of-Runner.
