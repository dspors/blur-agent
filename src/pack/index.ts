/**
 * blur-agent pack — entry point.
 *
 * Mounts AgentsSubsystem at the short name `agents`. Runtime exposes
 * primitives at `runtime.agents.*` and auto-exposes
 * `runtime.agents.json()` from the Persistable interface (decision 20).
 *
 * Seeds the role catalog with the five canonical roles at install time:
 * supervisor, configuration, conductor, run, oversight. Catalog is an
 * open registry — packs / sessions can register additional roles via
 * agents.roles.register at runtime.
 */

import type { LibraryPack, LibraryPackInstall, BlurAIRuntime } from 'blur-ai-runtime';

import { AgentsSubsystem } from './agents-subsystem';
import { exposures } from './exposures';

export { AgentsSubsystem } from './agents-subsystem';
export type {
  Agent,
  AgentBinding,
  AgentBindingScope,
  AgentHandoff,
  AgentLeasedFrom,
  AgentNote,
  AgentNoteKind,
  AgentRoleDef,
  AgentStatus,
  AddNoteOpts,
  BindOpts,
  LeaseOpts,
  ListOpts,
  RegisterRoleOpts,
  ReleaseOpts,
  UnbindOpts,
  UnregisterRoleOpts,
  WhoAmIOpts,
} from './types';

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
    defaultHandoffCwdTemplate: '~/.blur/projects/{projectId}/handoffs/configuration-agent/',
  },
  {
    id: 'conductor',
    label: 'Conductor',
    description:
      'Walks an Arc on a project. Promotes ready Moves, dispatches RunAgents, opens gates, resolves cross-Arc dependencies. State-machine driver, NOT executor.',
    defaultBindingScopes: ['project' as const, 'arc' as const],
    defaultHandoffCwdTemplate: '~/.blur/projects/{projectId}/handoffs/conductor/',
  },
  {
    id: 'run',
    label: 'RunAgent',
    description:
      "Executes one Move at a time on a track. Generates Charter Steps, files Tickets, emits Telemetry. Bound at track scope so the next Move dispatched on the same track can reuse the agent.",
    defaultBindingScopes: ['track' as const, 'move' as const],
    defaultHandoffCwdTemplate: '~/.blur/projects/{projectId}/handoffs/{trackId}/',
  },
  {
    id: 'oversight',
    label: 'OversightAgent',
    description:
      'Risk-watcher. Reads project + track state, raises Risks on the Charter, files high-severity Tickets when warranted. Read-mostly; does not execute Moves.',
    defaultBindingScopes: ['project' as const, 'track' as const],
  },
];

const pack: LibraryPack = {
  id: 'blur-agent',
  version: '0.1.0',

  install(runtime: BlurAIRuntime): LibraryPackInstall {
    const agents = new AgentsSubsystem(runtime);
    for (const role of SEEDED_ROLES) {
      try {
        agents.registerRole({ role, by: 'blur-agent@install' });
      } catch {
        // If the role already exists from a prior persist load, skip.
      }
    }
    return {
      objects: { agents },
      exposures,
    };
  },
};

export default pack;
