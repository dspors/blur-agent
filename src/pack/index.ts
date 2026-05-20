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
import { EngagementFlowSubsystem } from './engagement-flow-subsystem';
import { ChatCompletionsSubsystem } from './chat-completions-subsystem';
import { BlurContext, type BlurContextSnapshot, type FromActivityOpts } from './blur-context';
import { RunSubsystem } from './run-subsystem';
import { SecretarySubsystem } from './secretary-subsystem';
import { bridgeProviderImpl } from './providers/bridge-provider';
import { mockProviderImpl } from './providers/mock-provider';
import { installD29Adapters } from './providers/d29-provider-adapter';
import { exposures } from './exposures';
import { schedulerExposures } from './scheduler-exposures';
import { engagementFlowExposures } from './engagement-flow-exposures';
import { runExposures } from './run-exposures';
import { secretaryExposures } from './secretary-exposures';
import { chatCompletionsExposures, contextExposures } from './chat-completions-exposures';

export { AgentsSubsystem } from './agents-subsystem';
export { AgentRepliesSubsystem } from './replies-subsystem';
export { TurnsSubsystem } from './turns-subsystem';
export { SchedulerSubsystem } from './scheduler-subsystem';
export { ProviderRegistry } from './provider-registry';
export { EngagementFlowSubsystem } from './engagement-flow-subsystem';
export { ChatCompletionsSubsystem } from './chat-completions-subsystem';
export { BlurContext } from './blur-context';
export type {
  BlurContextSnapshot,
  ChatMessage,
  LayerName,
  FromActivityOpts,
  BlurContextDescription,
} from './blur-context';
export type {
  ModelSpec,
  ToolDef,
  CreateOpts,
  IterationRecord,
  ChainResult,
} from './chat-completions-subsystem';
export { LiveReply } from './live-reply';
export type {
  EngagementFlowOptions,
  LinkedOutput,
  PrepData,
  PrepDataAgent,
  PrepDataProject,
  PrepDataRuntime,
  PrepDataTrackSummary,
  PrepStepDescriptor,
} from './engagement-flow-types';
export type {
  ListTicketsOpts,
  RequestTurnOpts,
  RequestTurnResult,
  Ticket,
  TicketHistory,
  TicketHistoryEvent,
  TicketStatus,
  TicketTerminalReason,
} from './ticket-types';
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
export { aiSchedulerAlgorithm } from './ai-scheduler';
export type { AIAlgorithmOpts, AIVerdict, AIVerdictRecord } from './ai-scheduler';
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

// Per-runtime subsystem registry — keyed by the runtime instance so
// `uninstall()` can stop the subsystems it created in `install()`.
// Without this, audit subscribers leak on `runtime.packs.reload()`:
// the old subsystem's onEngagementOpened keeps firing alongside the
// new one's, leading to duplicate auto-lease and ghost agent ids in
// `engagement.boundAgentIds`. See `tkt_deb19c69-…`.
interface InstalledSubsystems {
  agents: AgentsSubsystem;
  replies: AgentRepliesSubsystem;
  turns: TurnsSubsystem;
  scheduler: SchedulerSubsystem;
  engagementFlow: EngagementFlowSubsystem;
}
const installedByRuntime: WeakMap<BlurAIRuntime, InstalledSubsystems> = new WeakMap();

const pack: LibraryPack = {
  id: 'blur-agent',
  version: '0.4.0',

  install(runtime: BlurAIRuntime): LibraryPackInstall {
    const agents = new AgentsSubsystem(runtime);
    const replies = new AgentRepliesSubsystem(runtime);
    const turns = new TurnsSubsystem(runtime);
    const scheduler = new SchedulerSubsystem(runtime);
    const providers = new ProviderRegistry();
    const engagementFlow = new EngagementFlowSubsystem(runtime);
    const chatCompletions = new ChatCompletionsSubsystem(runtime);
    const runners = new RunSubsystem();
    const secretary = new SecretarySubsystem();
    runners.attachRuntime(runtime);
    secretary.attachRuntime(runtime);
    secretary.attachRuns(runners);

    // Wire the backrefs on the agents subsystem so the dispatch
    // methods (sendMessage / sendText / getReply / sendMessageAndAwait)
    // can resolve their dependencies without circular imports.
    agents.repliesRef = replies;
    agents.providerRegistry = providers;
    agents.turnsRef = turns;

    // Scheduler reaches into agents for candidate listing.
    scheduler.agentsRef = agents;

    // Decision 36 step 2 — Scheduler reaches into runtime.tables (Model
    // Table + Activity Table) to resolve the override chain in
    // requestTurn. Optional: if the substrate hasn't mounted tables
    // (e.g. older runtime), the resolver falls through to the layers
    // that don't depend on system tables (pin, caller-table,
    // engagement.runtimeModel, baseline).
    const tables = (runtime as unknown as { tables?: {
      listModels(): Array<{ modelRef: string; providerKind: string; providerModelId: string }>;
      listActivityRouting(): Array<{ activityId: string; mode: string; default: string | null; outcomes?: Record<string, string> }>;
    } }).tables;
    if (tables && typeof tables.listModels === 'function' && typeof tables.listActivityRouting === 'function') {
      scheduler.tablesRef = {
        listModels: () => tables.listModels(),
        listActivityRouting: () => tables.listActivityRouting(),
      };
    }

    // Engagement-flow auto-lease subscriber calls agents.lease(...);
    // dispatchTurn routes through scheduler.requestTurn (Decision 34).
    engagementFlow.agentsRef = agents;
    engagementFlow.schedulerRef = scheduler;

    // chat.completions (Decision 34) calls the provider registry
    // directly + long-polls via replies subsystem. No agent, no
    // engagement — each chain is self-contained.
    chatCompletions.providerRegistry = providers;
    chatCompletions.repliesRef = replies;

    // Register built-in providers. mock is fully functional; bridge
    // requires the cowork-web-bridge runtime-pack to be loaded for
    // sendMessage to succeed, but the registration itself is fine.
    providers.register(mockProviderImpl());
    providers.register(bridgeProviderImpl(runtime));

    // D29 adapters for blur-providers-core's inner providers
    // (`local`, `together`). Bridges their sync-return ProviderRequest
    // shape onto the D29 streaming-chunk shape. Skipped silently when
    // the inner providerRegistry extension isn't loaded — production
    // gets local+together when the providers pack is installed; mock-
    // only test fixtures aren't affected.
    // See general-activity-multi-provider-v1 §9 +
    // src/pack/providers/d29-provider-adapter.ts.
    const d29Result = installD29Adapters(runtime, { outer: providers });
    if (d29Result.registered.length > 0) {
      // eslint-disable-next-line no-console
      console.log(
        `[blur-agent] D29 adapter wired for: ${d29Result.registered.join(', ')}`,
      );
    }
    if (d29Result.skipped.length > 0) {
      // eslint-disable-next-line no-console
      console.log(
        `[blur-agent] D29 adapter skipped: ${d29Result.skipped
          .map(s => `${s.kind} (${s.reason})`)
          .join(', ')}`,
      );
    }

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

    // Start TTL sweep on replies, audit-subscribe on turns, tick on
    // scheduler, audit-subscribe on engagement-flow.
    replies.start();
    turns.start();
    scheduler.start();
    engagementFlow.start();

    // Register the subsystem set under this runtime so uninstall() can
    // find them and stop their audit subscribers on pack reload.
    installedByRuntime.set(runtime, {
      agents, replies, turns, scheduler, engagementFlow,
    });

    // Context factory — exposes BlurContext static factories via the
    // script-facing surface as `runtime.context.fromActivity(...)`.
    // Returns plain-data snapshots because V8 isolates don't
    // round-trip class instances. The chat.completions subsystem
    // accepts either the live class instance OR a snapshot.
    const contextFactory = {
      async fromActivity(opts: Omit<FromActivityOpts, 'runtime'>): Promise<BlurContextSnapshot> {
        const ctx = await BlurContext.fromActivity({ runtime, ...opts });
        return ctx.toSnapshot();
      },
      fromScratch(): BlurContextSnapshot {
        return BlurContext.fromScratch().toSnapshot();
      },
      fromComposed(rawText: string): BlurContextSnapshot {
        return BlurContext.fromComposed(rawText).toSnapshot();
      },
      describe(snapshot: BlurContextSnapshot) {
        return BlurContext.fromSnapshot(snapshot).describe();
      },
    };

    // `chat` namespace with `.completions` as the subsystem instance.
    // resolveObjectPath('chat.completions') walks runtime.extensions.chat
    // then .completions, landing on this instance.
    const chat = { completions: chatCompletions };

    return {
      objects: {
        agents, replies, turns, scheduler, providers, engagementFlow, runners, secretary,
        // Decision 34 — chat-completions primitive + context factory.
        chat,
        context: contextFactory,
      },
      exposures: [
        ...exposures,
        ...schedulerExposures,
        ...engagementFlowExposures,
        ...runExposures,
        ...secretaryExposures,
        ...chatCompletionsExposures,
        ...contextExposures,
        // Per-provider exposures (Decision 29 escape-hatch pattern).
        // Mounted under runtime.agents.providers.<kind>.*. Today none
        // of the built-in providers ship custom exposures; this picks
        // them up when third-party providers do.
        ...providers.collectExposures(),
      ],
      // Decision 37: entity declarations consumed by runtime.tags walker.
      // Agent + Turn entities live here (Engagement is owned by blur-project,
      // not blur-agent, despite the related subsystem reference here).
      entities: [
        {
          kind: 'agent',
          label: 'Agent',
          description:
            'A durable AI-session identity holding role, provider, and scope ' +
            'bindings. Survives session rotation. Bound to an Engagement during ' +
            'dispatch.',
          idShape: 'agt_<hex>',
          read: { method: 'agents.get' },
          list: {
            method: 'agents.list',
            filters: ['role', 'status'],
          },
        },
        {
          kind: 'turn',
          label: 'Turn',
          description:
            'One model←→substrate exchange within an Engagement. Carries prompt, ' +
            'assembled text (model reply), provider/model, status, iteration data.',
          idShape: 'tur_<hex>',
          read: { method: 'turns.get' },
          list: {
            method: 'turns.list',
            filters: ['agentId', 'status', 'since'],
          },
        },
      ],
    };
  },

  /**
   * Called by the runtime on `runtime.packs.unload(...)` and as part of
   * `runtime.packs.reload(...)`. Stops every subsystem we started so
   * its audit subscribers are removed cleanly. Without this hook,
   * pack reload leaks subscribers — see the comment on
   * `installedByRuntime` above for the symptom (`tkt_deb19c69-…`).
   */
  uninstall(runtime: BlurAIRuntime): void {
    const subsystems = installedByRuntime.get(runtime);
    if (!subsystems) return;
    try { subsystems.engagementFlow.stop(); } catch { /* swallow */ }
    try { subsystems.scheduler.stop(); } catch { /* swallow */ }
    try { subsystems.turns.stop(); } catch { /* swallow */ }
    try { subsystems.replies.stop(); } catch { /* swallow */ }
    // agents subsystem has no audit subscribers (no start/stop pair) —
    // its state is durable via Persistable and is repopulated on reload.
    installedByRuntime.delete(runtime);
  },
};

export default pack;
