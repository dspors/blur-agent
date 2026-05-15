# blur-agent

Agent subsystem for `blur-ai-runtime`.

A first-class `Agent` object gives every project-attached AI session a
**durable identity** — role, scope bindings, handoff pointer, and
structured notes — that survives session swaps.

Replaces ad-hoc conventions where session-ids were passed around as
strings and role/scope lived in CLAUDE.md prose.

## Key idea

```js
const me = await runtime.agents.whoAmI();
// → { id: 'agt_...', role: 'conductor', bindings: [...], handoff: {...}, notes: [...] }
```

Any AI session can resolve its own role and scope without searching —
no transcript-reading, no string-matching, no `projects.list().filter(...)`.

## Roles (seeded at install)

- `supervisor` — cross-project, human-driven
- `configuration` — project-config and runtime-config
- `conductor` — walks an Arc on a project
- `run` — executes one Move at a time on a track
- `oversight` — risk-watcher

Roles are an **open registry**. Register new ones at runtime via
`runtime.agents.roles.register(...)`.

## Primitives

| Method | Purpose |
|---|---|
| `agents.lease(opts)` | Wraps `pool.lease(...)`; returns an `Agent` |
| `agents.release(id)` | Releases pool session; preserves record |
| `agents.whoAmI(sessionId?)` | Self-reflection — returns calling agent |
| `agents.bind(id, binding)` | Attach agent to a project/track/arc/move |
| `agents.unbind(id, binding)` | Detach |
| `agents.notes.add(id, note)` | Append structured self-memory |
| `agents.roles.register/list/get` | Role catalog |
| `agents.list/get` | Read |

## See also

- [`blur-ai-runtime`](https://github.com/dspors/blur-ai-runtime) — host runtime
- [`blur-session-pool`](https://github.com/dspors/blur-session-pool) — underlying session pool
- [`blur-project`](https://github.com/dspors/blur-project) — what agents work on
- [`ECOSYSTEM.md`](https://github.com/dspors/blur-ai-runtime/blob/main/ECOSYSTEM.md) — canonical index
