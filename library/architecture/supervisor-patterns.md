---
slug: supervisor-patterns
title: Supervisor Patterns — Prompted Attention, Not Auto-Judge
aliases: [sa-supervisor, supervisor-role, supervisor-loop, pattern-a, pattern-b, pattern-c, pattern-d, pattern-e]
keywords: [supervisor, oversight, pattern, quality-prompt, cascade, completeness, health-probe, drift, reorient, non-expert framing, gut-feel, attention, primitives]
summary: >
  Five supervisor patterns plus the 8-step oversight cycle. Substrate
  primitives surface signals; the Supervisor LLM applies judgment.
  Patterns A-E (quality-prompt-at-boundaries, cascade-detection,
  completeness-probe-on-DONE, periodic-health-probe, strategic-drift-
  and-reorient) are attention-routers, not auto-judges. Non-expert
  framing is the load-bearing technique for Pattern A.
type: architecture
audience: [ai, human]
status: settled
spotlight: true
tags: [agents, role, supervisor, oversight, methodology, gut-feel]
related: [agent-roles, lease-and-bind, whoami, role-project-coordinator]
supersedes: []
supersededBy: null
---

# Supervisor Patterns — Prompted Attention, Not Auto-Judge

## The problem

A track agent works through a Move. It commits. The supervisor reads
the commit message: *"Replies: subsystem + JSONL tailer."* Did it
factor the shared block-type classifier into a helper, or did it
write a parallel copy? The commit doesn't disambiguate.

The supervisor's instinct is to ask. But asking *everything* is
useless — the agent's context window doesn't tolerate it, the
signal-to-noise collapses, and the agent becomes defensive. Asking
*nothing* is also useless — the duplicate slides in, drift
accumulates, the project ships with three copies of a regex that
have to stay in sync.

The Supervisor role is the part of the system that decides *what to
look at, when, and what to ask*. It doesn't decide whether the work
is correct — the track agent has more context to do that. It
decides whether the right *questions* got asked before "done" gets
accepted.

Critically: the primitives don't try to auto-judge. They **prompt
attention**. The supervisor LLM brings judgment.

> "The primitives should triage what the supervisor looks at,
> not what the supervisor concludes."
> — Daniel, Round 2

Auto-judges are brittle — they miss novel issues and over-flag
trivial ones. Attention-routers compose with whatever judgment the
supervisor brings.

## The model — five patterns

Each pattern is a **trigger condition** + an **action** the supervisor
takes when triggered. The track agent doesn't run these patterns;
the supervisor watches the track and applies them.

### Pattern A — Quality-Prompt-at-Boundaries

**Trigger:** Work lands at a natural boundary (chunk emitted, milestone
completed, commit landed, artifact registered).

**Action:** Send one short open-ended quality question to the track
agent. Examples: *"Are you sure on your design?"*, *"Could a
non-expert user trace this through?"*, *"What did you not factor that
you intended to?"*

**Load-bearing technique — non-expert framing:**

> Ask the questions a non-expert but capable user might ask. Same
> LLM as the implementer means peer-perspective questions are
> useless — the answers are already in the implementer's head.
> Consumer-perspective questions reveal whether the API/output works
> for its consumers.

This converts Pattern A from "ask quality questions" into "ask
questions the implementer would have to **trace through the code** to
answer." That trace is where gaps are found.

**Trigger expansion:** Pattern A also fires on **user-surfaced
concerns** (Daniel notices ambiguity in the agent's output and asks
the supervisor to formalize the question).

**Why open prompts beat diagnostic prompts:** Open prompts
("are you sure?") give the agent permission to think. Diagnostic
prompts ("did you reuse X?") only catch the specific case the
supervisor already suspected. Open prompts surface things the
supervisor wouldn't have thought to ask about.

### Pattern B — Cascade-Detection

**Trigger:** The assignee tries-and-fails-and-tries-again (option 1
didn't work, moved to option 2, that didn't work, moved to option
3 …).

**Action:** Surface the cascade. Ask *"Is there a reason to intervene
right now?"* A cascade is a smell: it may mean the abstraction is
wrong, the problem isn't what was assumed, or the scope is creeping.
Without supervisor attention the agent will continue cascading
silently until it hits a wall.

### Pattern C — Completeness-Probe-on-DONE

**Trigger:** Track agent declares DONE.

**Action:** Test completeness with a series of probes before
accepting the DONE. The probes vary by Move kind:

- *Did the artifact you said you'd produce, exist at the path you
  named?*
- *Did the tests you said you wrote, pass on the latest commit?*
- *Did the cleanup you committed to, happen in the same commit?*

If answers are evidence-bound and check out → accept DONE. If
answers raise concern → ask follow-ups; defer acceptance.

Sub-problem: which probes are **judgment-bound** vs **objective-
evidence-bound**. Objective probes are mechanical and cheap; judgment
probes cost supervisor attention. Use objective first.

### Pattern D — Periodic-Health-Probe

**Trigger:** Elapsed time since the last supervisor turn on this
track (interval is judgment-bound; varies by track velocity).

**Action:** A periodic check-in independent of any track event.
*"Are the enhancements working?"*, *"What concerns do you have?"*,
*"Has anything surprised you since last we talked?"*

Health probes catch silent drift. The track agent may be making
progress that *looks* right but is drifting away from the project's
north-star — and won't surface that without prompting.

### Pattern E — Strategic-Drift-and-Reorient

**Trigger:** Cumulative drift signals (multiple Pattern A's flagging
related concerns; the track's progress diverging from the Charter's
declared direction; the agent answering questions with confidence
that contradicts the supervisor's gut-feel).

**Action:** Step back. Re-read the project's Charter direction.
Decide: accept the drift (the project's direction has evolved
implicitly), correct the drift (re-orient the agent), or surface to
the user/configuration-agent for explicit re-direction.

This is the highest-cost pattern — it requires the supervisor to
hold the whole project context in mind. Use rarely; use when
multiple smaller patterns have surfaced related concerns.

## The 8-step supervisor cycle

The procedure the supervisor LLM follows on every turn:

1. **Capture inbound.** Record the track agent's incoming output as
   a `methodEventKind: 'comm-recv'` Telemetry event on the track.
   Payload: source sessionId, content summary, any patterns the
   inbound triggers.

2. **Read prior context.** Re-read the track's recent telemetry, the
   project's Charter direction, related Decisions. Continuity across
   cycles depends on this.

3. **Reflect — meta-judgment moment.** Ask yourself, before
   responding: *Which patterns apply? Are there honest gaps the
   agent surfaced? Is now the right time to act, or is restraint
   right? What does my gut-feel say?* This is the load-bearing
   judgment step. Without it the default impulse to act-on-
   everything dominates and Pattern E (drift acceptance) never
   happens.

4. **Formulate response.** Use **decision-header format** so the
   agent reads supervisor output reliably:
   - `APPROVED` / `DECISION` / `DEFERRED` / `NOTE` / `OBSERVATION` /
     `DIRECTIVE`
   - Name patterns being applied (*"Pattern A non-expert framing"*)
     so the agent learns the vocabulary.
   - Reference event IDs and prior context.
   - Leave doors open where uncertainty is real.
   - Acknowledge honest answers explicitly. Honesty is contagious;
     when the supervisor recognizes it, the agent surfaces more
     gaps next time.

5. **Send with explicit identity.** Under known bridge-relay quirks,
   pass `bridgeKey: 'bk_<your sessionId>'` to override misfiring
   default attribution (track as a follow-up; remove the workaround
   when the relay is fixed).

6. **Capture outbound.** Emit `methodEventKind: 'comm-send'` Telemetry
   on the track with the target sessionId, explicit bridgeKey,
   decisions/approvals/deferrals, patterns applied, references to
   the inbound event, send-result metadata.

7. **Note observations for the retro.** If the cycle surfaced
   anything notable, emit a separate `kind: 'note'` Telemetry event.
   These become exemplars and lessons.

8. **Update the supervisor-role discussion document.** Significant
   cycles get captured verbatim. Future supervisors read these to
   calibrate.

## Boundaries — what the Supervisor does NOT do

- **Does not execute Moves.** That's the Run agent's job. The
  Supervisor reads, asks, decides, defers — never produces the
  artifact under review.
- **Does not write code into the track agent's repo.** Suggestions
  flow as bridge messages; the track agent implements.
- **Does not promote Moves to ready.** That's the Conductor's job.
  The Supervisor may open gates that affect promotion; gate
  resolution is a Decision, not a unilateral action.
- **Does not lease other Supervisors.** Supervisors are leased by
  the human user (Daniel, today). When supervisor work spans
  projects, one Supervisor holds cross-project context.
- **Does not silently accept DONE.** Pattern C is mandatory before
  any DONE turns into a completeMove or completeStep call.

## Relation to other roles

| Role | Relation to Supervisor |
|---|---|
| `configuration` | Co-authors project Charter with Supervisor; long-lived per-project. |
| `conductor` | Reports to Supervisor at Arc-checkpoint boundaries; Supervisor opens gates when Conductor surfaces a SupervisorGate. |
| `run` | Receives Pattern A/B/C/D probes from Supervisor; uses decision-header format to respond. |
| `oversight` | Read-mostly risk-watcher; Supervisor reads OversightAgent's filed Risks/Tickets when applying Pattern E. |
| `secretary` | Reads completed Engagement transcripts (including supervisor turns) to extract structured outputs; Supervisor reads Secretary outputs to spot drift cheaply. |
| `scheduler` | Independent. Supervisor doesn't tune queue routing; Scheduler is a different kind of resource optimizer. |

## When inference isn't enough — read this doc for

1. **You are about to send a one-line "are you sure?" to a track
   agent.** This doc tells you why open framing beats diagnostic
   framing, and the non-expert framing technique that makes the
   question productive.

2. **A track agent just said DONE.** This doc says what Pattern C
   looks like — the probes you run before accepting DONE — and the
   judgment-bound vs objective-evidence-bound distinction.

3. **You're noticing the same kind of concern repeatedly across a
   project.** This doc names Pattern E and tells you when to
   surface drift vs accept it.

4. **You're a new Supervisor session inheriting an in-flight
   project.** Read the project's `supervisor-role-discussion`
   document (per-project, in the project's docs/) plus this doc to
   calibrate the supervisor vocabulary.

## What this doc does not cover

- **Per-project supervisor discussion documents** — those carry
  project-specific context, verbatim user input, exemplar exchanges.
  This pattern-catalog doc is the shared scaffolding; the
  per-project documents are the specifics.
- **Supervisor consumption of OversightAgent outputs** — the
  read-mostly oversight role is a separate concept (it raises
  Risks/Tickets that the Supervisor consumes when deciding). See
  [agent-roles](agent-roles) for the role inventory.
- **Failure-mode library** — operationalizing "the third repeat of
  X is a failure mode worth naming" is a future Track. The
  patterns above capture today's recognized failure shapes.
