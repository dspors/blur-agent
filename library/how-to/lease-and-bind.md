---
slug: lease-and-bind
title: Lease and Bind an Agent
aliases: [lease-agent, bind-agent, lease-bind-ritual, agent-onboarding, dispatch-agent]
keywords: [lease, bind, agent, pool, dispatch, conductor, runagent, session, project, track, arc, scope, attach, mint]
summary: >
  Two-step ritual to put an agent to work — agents.lease creates the
  record and grabs a session from the pool; agents.bind attaches the
  agent to a project/track/arc scope. Walks through the Conductor
  and RunAgent cases.
type: how-to
audience: [ai, human]
status: settled
tags: [agents, how-to]
related: [agent-roles, whoami]
---

# Lease and Bind an Agent

## When to reach for this

You're the Supervisor or Conductor and you need to attach an agent to
some work. The primitive surface is two steps — `lease` then `bind` —
plus an optional `handoff.cwd` so the agent knows where to read its
CLAUDE.md.

If you're trying to figure out **which role** to lease, read
[agent-roles](agent-roles) first.

## The shortest path: lease with bindings inline

`agents.lease()` accepts `bindings: [...]` directly, so for the common
case you can lease + bind in one call:

```javascript
const conductor = await runtime.agents.lease({
  role: 'conductor',
  label: 'qb Conductor',
  bindings: [{ scope: 'project', ref: 'qb' }],
  handoff: {
    cwd: 'C:\\Users\\dspors\\.blur\\blur-project-management\\qb\\handoffs\\conductor',
  },
  by: '<your-sessionId>',
});
// → { id: 'agt_...', role: 'conductor', sessionId: 'local_...',
//     bindings: [{ scope: 'project', ref: 'qb', attachedAt: '...' }],
//     handoff: { cwd: '...' }, ... }
```

The `pool.lease()` call happens internally. The returned `Agent` has
the bridge `sessionId` already populated. You can immediately
`runtime.bridge.sessions.send(conductor.sessionId, ...)` to deliver
the kickoff prompt.

## When to split into lease-then-bind

Two scenarios warrant the split:

1. **Adding a second binding later.** The Conductor leases against
   `project`, then later binds to a specific `arc` once an Arc is
   filed for that project.
2. **You don't know the scope ref yet.** Lease the agent, do some work
   that produces a `trackId`, then bind.

```javascript
// 1. Mint without bindings (scope ref not known yet)
const run = await runtime.agents.lease({
  role: 'run',
  label: 'qb COA RunAgent',
  by: '<your-sessionId>',
});

// 2. Once the track exists, bind
await runtime.agents.bind(run.id, {
  binding: { scope: 'track', ref: 'qb/coa-wrapper', note: 'COA wrapper Track' },
  by: '<your-sessionId>',
});
```

`agents.bind` is idempotent on `(scope, ref)` — re-binding the same
target replaces (does not duplicate).

## Common patterns

### Conductor leasing a RunAgent for a Move

Inside a Conductor session walking an Arc:

```javascript
// Find the next ready Move
const arcId = 'arc_...';
const move = await runtime.arcs.nextReadyMove(arcId);

// Mint a RunAgent at the right scope
const run = await runtime.agents.lease({
  role: 'run',
  label: `${move.label} RunAgent`,
  bindings: [
    { scope: 'track', ref: `${projectId}/${trackId}` },
    { scope: 'move', ref: `${arcId}/${move.id}` },
  ],
  handoff: { cwd: `~/.blur/blur-project-management/${projectId}/handoffs/${trackId}/` },
  by: conductorAgentId,
});

// Promote and dispatch
await runtime.arcs.startMove(arcId, move.id, {
  by: conductorAgentId,
  dispatchedTo: run.id,
});

await runtime.bridge.sessions.send(run.sessionId, move.dispatch.handoffPrompt);
```

### Re-using a RunAgent across moves on the same track

When a Move completes, **don't** release the RunAgent — bind it to the
next Move and reuse:

```javascript
// Move A completed; promote Move B
await runtime.arcs.completeMove(arcId, moveA.id, { summary: '...', by: conductor });
await runtime.arcs.readyMove(arcId, moveB.id, { by: conductor });

// Same RunAgent, new move binding (track binding already in place)
await runtime.agents.bind(run.id, {
  binding: { scope: 'move', ref: `${arcId}/${moveB.id}` },
  by: conductor,
});

await runtime.arcs.startMove(arcId, moveB.id, { by: conductor, dispatchedTo: run.id });
```

The track-scope binding survives; only the move-scope binding rotates.

## Release vs pause

- `agents.release(id)` — frees the pool session, marks
  `status: 'released'`. Use when the work is done and the agent
  shouldn't be re-resumed.
- `agents.pause(id)` — frees the pool session, marks
  `status: 'paused'`. Use when work is mid-flight and you want to
  cold-resume later via `agents.attachSession(id, newSessionId)`.

The Agent record persists in either case — `agent.id` is the
durability invariant. Sessions rotate; agents don't.

## Verifying the result

```javascript
const me = await runtime.agents.whoAmI();
// Inside the leased session, this returns the freshly-minted Agent.
```

See [whoami](whoami) for what `whoAmI()` returns and when it returns
null.

## What this primitive can't infer for you

- **Which role to pick.** Reach for [agent-roles](agent-roles).
- **Where to point `handoff.cwd`.** Convention is
  `~/.blur/blur-project-management/<projectId>/handoffs/<role>/`
  (or `<trackId>/` for RunAgents). The role's
  `defaultHandoffCwdTemplate` is the source of truth — apply
  `{projectId}` / `{trackId}` substitution.
- **Which pool host to draw from.** Default is fine for most cases;
  override `pool.host` only when you need a specific machine.
