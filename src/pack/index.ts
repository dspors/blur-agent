/**
 * blur-agent pack — entry point.
 *
 * Mounts three coordinated objects:
 *   - agents   → AgentsSubsystem            (durable identity layer; lease,
 *                                            bindings, notes, roles)
 *   - replies  → AgentRepliesSubsystem      (Decision 29 ReplyRecord store;
 *                                            long-poll waiters; TTL sweep;
 *                                            Persistable)
 *   - providers → ProviderRegistry           (open registry of inference-
 *                                            target implementations; seeded
 *                                            with bridge + mock)
 *
 * AgentsSubsystem.sendMessage / getReply / sendMessageAndAwait dispatch
 * via the ProviderRegistry to the agent's `provider.kind` impl. The
 * BridgeProvider in particular delegates to runtime.bridge.sessions.*
 * (cowork-web-bridge runtime-pack >=0.3.0 required).
 *
 * Seeds the role catalog with the five canonical roles at install time:
 * supervisor, configuration, conductor, run, oversight. Catalog is an
 * open registry — packs / sessions can register additional roles via
 * agents.roles.register at runtime.
 */

import type { LibraryPack, LibraryPackInstall, BlurAIRuntime } from 'blur-ai-runtime';

import { AgentsSubsystem } from './agents-subsystem';
import { AgentRepliesSubsystem } from './replies-subsystem';
import { TurnsSubsystem } from './turns-subsystem';
import { SchedulerSubsystem } from './scheduler-subsystem';
import { ProviderRegistry } from './provider-registry';
import { bridgeProviderImpl } from './providers/bridge-provider';
import { mockProviderImpl } from './providers/mock-provider';
import { exposures } from './exposures';
import { schedulerExposures } from './scheduler-exposures';

export { AgentsSubsystem } from './agents-subsystem';
export { AgentRepliesSubsystem } from './replies-subsystem';
export { TurnsSubsystem } from './turns-subsystem';
export { SchedulerSubsystem } from './scheduler-subsystem';
export { ProviderRegistry } from './provider-registry';
export { LiveReply } from './live-reply';
export type {
  AssignmentResult,
  ListWorkItemsOpts,
  RoutingPolicyEntry,
  SetRoutingPolicyOpts,
  SubmitWorkItemOpts,
  WorkItem,
  WorkItemRef,
  WorkItemStatus,
} from './scheduler-types';
export type { SchedulerAlgorithm } from './scheduler-subsystem';
export type { ProviderImpl, ProviderInfo, ProviderCapabilities, AgentRepliesSink } from './provider-registry';
export type {
  AddNoteOpts,
  AddTurnReferenceOpts,
  Agent,
  AgentBinding,
  AgentBindingScope,
  AgentHandoff,
  AgentLeasedFrom,
  AgentNote,
  AgentNoteKind,
  AgentProvider,
  AgentRoleDef,
  AgentStatus,
  BindOpts,
  BridgeProvider,
  GetReplyOpts,
  LeaseOpts,
  ListOpts,
  ListTurnsOpts,
  LocalProvider,
  MockProvider,
  OpenAIProvider,
  OpenTurnOpts,
  RegisterRoleOpts,
  ReleaseOpts,
  Reply,
  ReplyChunk,
  ReplyPoll,
  ReplyRecord,
  ReplySummary,
  SamplingParams,
  SendMessageAndAwaitOpts,
  SendMessageOpts,
  TogetherProvider,
  Turn,
  TurnReference,
  TurnSideEffect,
  TurnStatus,
  TurnToolCall,
  UnbindOpts,
  UnregisterRoleOpts,
  WhoAmIOpts,
} from './types';
export { synthesizeProvider } from './types';

const SEEDED_ROLES = [
  {
    id: 'supervisor',
    label: 'Supervisor',
    description:
      'Cross-project, human-in-the-loop role. Sets the north-star, resolves gate Decisions, leases Conductor agents, ratifies methodology changes.',
    defaultBindingScopes: ['cross-project' as const],
    docs: 'See blur-project/handoffs/supervisor/CLAUDE.md if present.',
  },
  {
    id: 'configuration',
    label: 'Configuration Agent',
    description:
      'Shapes project Charter and runtime configuration. Co-authors the methodology with the Supervisor. Distinct per-project where helpful (config-agent for project X vs config-agent for project Y).',
    defaultBindingScopes: ['project' as const, 'cross-project' as const],
    defaultHandoffCwdTemplate: '~/.blur/blur-project-management/{projectId}/handoffs/configuration-agent/',
  },
  {
    id: 'conductor',
    label: 'Conductor',
    description:
      'Walks an Arc on a project. Promotes ready Moves, dispatches RunAgents, opens gates, resolves cross-Arc dependencies. State-machine driver, NOT executor.',
    defaultBindingScopes: ['project' as const, 'arc' as const],
    defaultHandoffCwdTemplate: '~/.blur/blur-project-management/{projectId}/handoffs/conductor/',
  },
  {
    id: 'run',
    label: 'RunAgent',
    description:
      "Executes one Move at a time on a track. Generates Charter Steps, files Tickets, emits Telemetry. Bound at track scope so the next Move dispatched on the same track can reuse the agent.",
    defaultBindingScopes: ['track' as const, 'move' as const],
    defaultHandoffCwdTemplate: '~/.blur/blur-project-management/{projectId}/handoffs/{trackId}/',
  },
  {
    id: 'oversight',
    label: 'OversightAgent',
    description:
      'Risk-watcher. Reads project + track state, raises Risks on the Charter, files high-severity Tickets when warranted. Read-mostly; does not execute Moves.',
    defaultBindingScopes: ['project' as const, 'track' as const],
  },
  {
    id: 'secretary',
    label: 'Secretary Agent',
    description:
      "Background extractor / organizer. Reads completed Engagements (and " +
      "their Turn histories) and writes structured outputs into project " +
      "metadata / North Star transcripts / Decision logs. Designed for " +
      "cheap providers (together.ai by default) — narrow, mechanical sorting " +
      "work, not interpretation. Many parallel secretary passes can run " +
      "concurrently.",
    defaultBindingScopes: ['project' as const, 'cross-project' as const],
    defaultHandoffCwdTemplate: '~/.blur/blur-project-management/{projectId}/handoffs/secretary/',
  },
  {
    id: 'scheduler',
    label: 'Scheduler Agent',
    description:
      "Resource optimizer for the WorkItem queue. Watches assignments, " +
      "agent utilization, and recent outcomes; nudges assignment decisions " +
      "as oversight on top of the deterministic algorithm. v0 is lightweight " +
      "(periodic review of the queue, propose rebalances). Forward direction: " +
      "tuning loop that learns which provider works best for which Activity, " +
      "dynamically adjusts routing policy, surfaces capacity issues.",
    defaultBindingScopes: ['runtime' as const, 'cross-project' as const],
    defaultHandoffCwdTemplate: '~/.blur/blur-project-management/handoffs/scheduler/',
  },
];

const pack: LibraryPack = {
  id: 'blur-agent',
  version: '0.4.0',

  install(runtime: BlurAIRuntime): LibraryPackInstall {
    const agents = new AgentsSubsystem(runtime);
    const replies = new AgentRepliesSubsystem(runtime);
    const turns = new TurnsSubsystem(runtime);
    const scheduler = new SchedulerSubsystem(runtime);
    const providers = new ProviderRegistry();

    // Wire the backrefs on the agents subsystem so the dispatch
    // methods (sendMessage / sendText / getReply / sendMessageAndAwait)
    // can resolve their dependencies without circular imports.
    agents.repliesRef = replies;
    agents.providerRegistry = providers;
    agents.turnsRef = turns;

    // Scheduler reaches into agents for candidate listing.
    scheduler.agentsRef = agents;

    // Register built-in providers. mock is fully functional; bridge
    // requires the cowork-web-bridge runtime-pack to be loaded for
    // sendMessage to succeed, but the registration itself is fine.
    providers.register(mockProviderImpl());
    providers.register(bridgeProviderImpl(runtime));

    // Seed the role catalog. Idempotent — duplicate seeds are
    // swallowed (load-from-disk may have already populated them).
    for (const role of SEEDED_ROLES) {
      try {
        agents.registerRole({ role, by: 'blur-agent@install' });
      } catch {
        // Role already present; skip.
      }
    }

    // Seed routing policy. Aligns with the Activity catalog seeded by
    // blur-project. Idempotent (last-set wins). Each `kind` here
    // corresponds to an Activity.id.
    const SEEDED_ROUTING = [
      { kind: 'general', defaultProviderKind: 'bridge' as const, sticky: true },
      { kind: 'project-interview', defaultProviderKind: 'bridge' as const, sticky: true },
      { kind: 'coding', defaultProviderKind: 'bridge' as const, sticky: true },
      { kind: 'secretary-pass', defaultProviderKind: 'together' as const, sticky: false },
      { kind: 'secretary-seed-build', defaultProviderKind: 'together' as const },
      { kind: 'supervisory-review', defaultProviderKind: 'bridge' as const },
      // Scheduler-tick is itself an AI pass over the queue. Cheap by
      // design — runs frequently as an oversight loop on top of the
      // deterministic algorithm.
      { kind: 'scheduler-tick', defaultProviderKind: 'together' as const, sticky: false },
    ];
    for (const entry of SEEDED_ROUTING) {
      try {
        scheduler.setRoutingPolicy({ entry, by: 'blur-agent@install' });
      } catch {
        /* swallow */
      }
    }

    // Start TTL sweep on replies, audit-subscribe on turns, tick on scheduler.
    replies.start();
    turns.start();
    scheduler.start();

    return {
      objects: { agents, replies, turns, scheduler, providers },
      exposures: [
        ...exposures,
        ...schedulerExposures,
        // Per-provider exposures (Decision 29 escape-hatch pattern).
        // Mounted under runtime.agents.providers.<kind>.*. Today none
        // of the built-in providers ship custom exposures; this picks
        // them up when third-party providers do.
        ...providers.collectExposures(),
      ],
    };
  },
};

export default pack;
