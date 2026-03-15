/**
 * Runtime Provider abstraction layer.
 *
 * Defines a common interface for agent runtime providers (Claude, Codex,
 * and future providers). Each provider manages agent lifecycle, state,
 * terminal output, and control operations through a unified API.
 *
 * The provider registry maps agent names to their provider implementation
 * via the database `agents.provider` column.
 */

import { getProvider, type AgentProvider } from "../agent-runtime.js";

export type ProviderRuntimeState = "idle" | "busy" | "approval_pending" | "no_session";

export interface ProviderApproval {
  agentName: string;
  key: string;
  toolServer?: string;
  toolName?: string;
  params?: string;
  description?: string;
}

export interface RuntimeProvider {
  readonly name: AgentProvider;

  // Lifecycle
  start(agentName: string): Promise<void>;
  stop(agentName: string): Promise<void>;
  restart(agentName: string, options?: { resetSession?: boolean }): Promise<void>;

  // State queries
  getState(agentName: string): ProviderRuntimeState;
  getTerminalContent(agentName: string): string;
  getContextPercent(agentName: string): number;

  // Control
  interrupt(agentName: string): Promise<boolean>;
  resume(agentName: string): Promise<boolean>;
  sendInput(agentName: string, input: string, type?: string): Promise<void>;

  // Approvals
  getApproval(agentName: string): ProviderApproval | undefined;
  getApprovals(): ProviderApproval[];
  respondToApproval(agentName: string, key: string): Promise<boolean>;
}

// Provider registry
const providers = new Map<AgentProvider, RuntimeProvider>();

export function registerProvider(provider: RuntimeProvider): void {
  providers.set(provider.name, provider);
}

/**
 * Get the RuntimeProvider implementation for a given agent.
 * Looks up the agent's provider type in the database and returns
 * the registered implementation.
 */
export function getProviderFor(agentName: string): RuntimeProvider {
  const providerType = getProvider(agentName);
  const provider = providers.get(providerType);
  if (!provider) {
    throw new Error(`No runtime provider registered for type "${providerType}"`);
  }
  return provider;
}

/**
 * Get a provider implementation by type name directly.
 */
export function getProviderByType(type: AgentProvider): RuntimeProvider | undefined {
  return providers.get(type);
}
