# CLAUDE.md — blur-agent

1. **Responsibility.** Durable AI-session identity and orchestration.
   Owns `runtime.agents.*`: Agent records (id durable across session
   rotation), role catalog (7 seeded roles — `supervisor`,
   `configuration`, `conductor`, `run`, `oversight`, `secretary`,
   `scheduler`), `ProviderRegistry` (Decision 29), Turn lifecycle,
   Replies subsystem, Scheduler with WorkItem queue, AISchedulerAlgorithm.

2. **Project management.** Use the `blur-runtime` MCP server (tools
   prefixed `mcp__blur-runtime__`). Multiple active workstreams may
   target this repo; the session that launched you knows which one
   it is.

3. **Source:** `~/dev/blur-agent/` (this folder). Build:
   `npm run build` (`tsc` → `dist/`).

4. **Active work plans** live in
   `~/.blur/blur-project-management/<project>/handoffs/<track>/HANDOFF.md`.
   The session that launched you points at the specific one.

Substrate references:
`~/dev/blur-ai-runtime/PACK-AUTHORS.md` for pack contract;
`~/dev/blur-ai-runtime/decisions/` for settled "why" answers
(particularly decisions 17, 20, 21, 29);
`~/dev/blur-ai-runtime/library/architecture/` for cross-cutting specs
(agent-roles, engagement-flow, turn-lifecycle).
