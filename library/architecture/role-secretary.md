---
slug: role-secretary
title: Role — Secretary (transcript sync + admin)
aliases: [secretary-role, secretary, role-sec]
keywords: [secretary, role, transcript, sync, archive, admin, audit, automation]
summary: >
  Secretary is the first AI role to be implemented. Its v0.1 job is
  narrow: copy Claude session transcripts into Runner records so the
  Runner identity persists independently of session lifecycle. First
  real automation in the orchestration tier; proves the role pattern.
type: architecture
audience: [ai, human]
status: settled
tags: [secretary, role, agents, automation, transcript]
related: [agent-roles, role-run, brief-mvp-substrate-v1]
spotlight: true
---

# Role — Secretary

## What this role does

Secretary is the **admin role**: it does the bookkeeping the
substrate needs but the work-execution sessions shouldn't pollute
their context with.

v0.1 PRIMARY TASK: **transcript shuttling.** When a Runner's Claude
session ends (or periodically mid-flight), the Secretary copies the
session transcript into the Runner record. This is what makes the
Runner identity persist across session compaction / end / replacement.

Secretary is the **first AI role to get real automation** — chosen
because:
- The task is bounded (one job, one trigger, one output)
- The pain it solves is real (work-context preservation across session lifecycle)
- It doesn't pollute the Run session's Claude context with admin
- Failure mode is benign (retry next event)
- It proves the role-automation pattern before bigger roles (Conductor, PM)

## v0.1 surface

| Method | Purpose |
|---|---|
| `syncTranscript(runnerId, transcript, opts)` | Write/append a transcript snapshot to a Runner |
| `archiveRunner(runnerId, opts)` | Finalize a Runner at session-end (sync transcript + mark completed) |
| `listPendingArchive()` | Runners that may need transcript sync |

Audit events: `secretary.transcript-synced`, `secretary.archived`.

## How v0.1 gets called

v0.1 is **manually triggered**. The Secretary subsystem provides the
methods; the calling loop is bootstrap:

- After a Runner's Claude session does meaningful work mid-flight:
  human (via UI) or the Claude session itself can call
  `runtime.secretary.syncTranscript(runnerId, transcript)`.
- At Runner end: human / UI / Conductor calls
  `runtime.secretary.archiveRunner(runnerId, { outcome, transcript })`.

The transcript content comes from the caller — Secretary doesn't
pull from the bridge in v0.1.

## v0.2 — automation

Future enhancement: Secretary becomes an actual Claude session
running a Secretary prompt that:
1. Subscribes to bridge / Runner lifecycle events
2. On `runners.bound` / per-turn events: pulls transcript via bridge
3. On `runners.completed` / `runners.failed`: pulls final transcript,
   calls `archiveRunner`

The current v0.1 stub is **API-compatible** with v0.2 — the same
methods get called, just by automation instead of human.

## Why narrow scope first

Secretary is deliberately the smallest useful role to implement.
Conductor and PM are bigger jobs (decide what to kick off / handle
end-of-turn). Implementing Secretary first:

1. Proves the role-as-AI-session pattern with a small example
2. Solves the user-named pain (work-context preservation)
3. Builds the infrastructure (event subscription, bridge integration)
   that bigger roles will need
4. De-risks the harder ones

## What v0.1 does NOT do

- **No bridge pull.** Transcript supplied by caller.
- **No subscription loop.** No `runners.*` event listener; the
  Secretary subsystem exposes methods but doesn't watch events
  itself yet.
- **No retry on failure.** If a sync call throws, the caller deals.
- **No cross-session correlation.** v0.1 treats each call atomically.
- **No mid-flight chunking.** Single transcript per call. The future
  could append chunks; v0.1 replaces unless `mode: 'append'` is
  passed.

## Where the code lives

| Concern | File |
|---|---|
| Subsystem | `blur-agent/src/pack/secretary-subsystem.ts` |
| Exposures | `blur-agent/src/pack/secretary-exposures.ts` |
| Wired in | `blur-agent/src/pack/index.ts` |

## How this fits the role catalog

Per `agent-roles.md`, Secretary is one of the seven seeded roles.
Until v0.1 this was documentation only; this commit makes it the
first to have a runtime subsystem. Other roles will follow the same
pattern: per-role subsystem file inside blur-agent, per-role
exposures file, wired into the pack entry, role doc in
`library/architecture/role-<name>.md`.
