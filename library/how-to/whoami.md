---
slug: whoami
title: How an Agent Discovers Itself
aliases: [who-am-i, self-reflection, agent-identity, who-is-this-session, identify-self]
keywords: [whoami, who, am, i, identity, self, reflection, agent, session, role, binding, scope, handoff]
summary: >
  agents.whoAmI() returns the Agent record for the calling session
  — role, bindings, handoff, notes. The one primitive every
  session-attached agent calls at startup to know what it is and
  what it owns.
type: how-to
audience: [ai, human]
status: settled
tags: [agents, how-to, orientation]
related: [agent-roles, lease-and-bind]
---

# How an Agent Discovers Itself

## The one-line answer

```javascript
const me = await runtime.agents.whoAmI();
// → { id: 'agt_...', role: 'conductor', bindings: [...], handoff: { cwd: '...' }, notes: [...] }
//   OR null if this session has no Agent record.
```

That's it. Inside any AI session, `whoAmI()` resolves the calling
session via the audit frame's `aiSessionId` (Decision 10 / Path B) and
returns its Agent.

## Why this exists

Before blur-agent, sessions discovered their identity by:

- Grepping the project state for a session-id string.
- Reading their handoff CLAUDE.md and pattern-matching on text.
- Asking the user, in chat.

All three are fragile. `whoAmI()` is the canonical replacement — a
single primitive call returns the typed record.

## What you get back

```typescript
{
  id: 'agt_<uuid>',          // durable — outlives session rotations
  role: 'conductor',         // one of the seeded or registered roles
  label: 'qb Conductor',
  status: 'live',            // 'live' | 'paused' | 'released'
  sessionId: 'local_<uuid>', // the bridge session you're running in
  bindings: [
    { scope: 'project', ref: 'qb', attachedAt: '...' },
    { scope: 'arc',     ref: 'arc_...', attachedAt: '...' },
  ],
  handoff: {
    cwd: 'C:\\...\\handoffs\\conductor',  // where your CLAUDE.md lives
  },
  notes: [
    { at: '...', kind: 'handoff-summary', text: '...' },
    ...
  ],
  // ... more fields; see types.ts for full shape
}
```

## Standard session-startup ritual

A session attached to an Agent should run this on the first turn:

```javascript
const me = await runtime.agents.whoAmI();
if (!me) {
  // Either: not yet leased (Supervisor needs to attach you),
  // or: running outside any Agent context (script-only call).
  // Surface this to the user — don't fabricate a role.
  throw new Error('No Agent record for this session. Ask Supervisor to lease.');
}

// Pull the role definition for posture
const roleDef = await runtime.agents.roles.get(me.role);

// Read your handoff (CLAUDE.md auto-loads if cwd is the session's
// working folder, so this is usually informational).
log(`I am ${me.label} (role: ${me.role}) bound to:`);
for (const b of me.bindings) log(`  ${b.scope}${b.ref ? ' ' + b.ref : ''}`);
```

If your handoff is in a sibling directory you can drill in with
`runtime.host.readFile(me.handoff.cwd + '/CLAUDE.md')` (when the
host-ext pack is available).

## When `whoAmI()` returns null

Three causes:

1. **No Agent has been leased for this session yet.** The session is
   running, but the Supervisor / Conductor hasn't called
   `agents.lease({ leasedFrom: 'manual', sessionId: '<this>' })` to
   wrap it. Surface to the user — don't guess.
2. **Calling from outside a script frame.** `whoAmI()` reads the
   audit frame's `aiSessionId`. Calls from pack `install()`,
   inspector callbacks, and audit subscribers have no frame —
   return is null. Pass `opts.sessionId` explicitly in those
   contexts.
3. **Agent was released.** Once `agents.release(id)` runs, the
   binding from session → agent persists in the record but a fresh
   `whoAmI()` against the released session returns null (or the
   released record, depending on history mode).

## Introspecting another agent

```javascript
const other = await runtime.agents.whoAmI({ sessionId: 'local_<some-other>' });
// → that agent's record (or null)
```

Useful for the Conductor asking "who is currently bound to this
RunAgent's session?" before sending a dispatch.

## What this primitive can't infer for you

- **Whether you should accept the role.** If `whoAmI()` says you're
  the configuration-agent for project X but the user asks you to do
  Conductor work, that's a role-mismatch the user has to decide.
- **What your role means.** Pair with [agent-roles](agent-roles) for
  the role catalog.
- **What to do next.** Read your `handoff.cwd` (CLAUDE.md) for the
  operative instructions.
