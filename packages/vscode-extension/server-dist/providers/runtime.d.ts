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
import { type AgentProvider } from "../agent-runtime.js";
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
    start(agentName: string): Promise<void>;
    stop(agentName: string): Promise<void>;
    restart(agentName: string, options?: {
        resetSession?: boolean;
    }): Promise<void>;
    getState(agentName: string): ProviderRuntimeState;
    getTerminalContent(agentName: string): string;
    getContextPercent(agentName: string): number;
    interrupt(agentName: string): Promise<boolean>;
    resume(agentName: string): Promise<boolean>;
    sendInput(agentName: string, input: string, type?: string): Promise<void>;
    getApproval(agentName: string): ProviderApproval | undefined;
    getApprovals(): ProviderApproval[];
    respondToApproval(agentName: string, key: string): Promise<boolean>;
}
export declare function registerProvider(provider: RuntimeProvider): void;
/**
 * Get the RuntimeProvider implementation for a given agent.
 * Looks up the agent's provider type in the database and returns
 * the registered implementation.
 */
export declare function getProviderFor(agentName: string): RuntimeProvider;
/**
 * Get a provider implementation by type name directly.
 */
export declare function getProviderByType(type: AgentProvider): RuntimeProvider | undefined;
