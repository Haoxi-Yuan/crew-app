import { type AgentProvider } from "../agent-runtime.js";
import type { RuntimeProvider, ProviderRuntimeState, ProviderApproval } from "./runtime.js";
export type { ProviderRuntimeState, ProviderApproval };
export interface CodexApproval {
    id: string;
    provider: AgentProvider;
    agentName: string;
    toolServer: string;
    toolName: string;
    params: string;
    description: string;
    options: {
        key: string;
        label: string;
    }[];
    promptType: "tool_use" | "mcp_setup" | "command_execution" | "file_change" | "skill_request" | "user_input";
    detectedAt: number;
    requestId?: number | string;
    questionIds?: string[];
}
export declare function startCodexAgent(agentName: string): Promise<void>;
export declare function stopCodexAgent(agentName: string): Promise<void>;
export declare function sendMessageToCodexAgent(agentName: string, senderNameOrInput: string, content?: string, channelId?: string, channelType?: string): Promise<boolean>;
export declare function sendManualInputToCodexAgent(agentName: string, input: string, type?: string): Promise<void>;
export declare function respondToCodexApproval(agentName: string, key: string): Promise<boolean>;
export declare function interruptCodexAgent(agentName: string): Promise<boolean>;
export declare function resumeCodexAgent(agentName: string): Promise<boolean>;
export declare function restartCodexAgent(agentName: string, resetThread?: boolean): Promise<boolean>;
export declare function getCodexApproval(agentName: string): CodexApproval | undefined;
export declare function getCodexApprovals(): CodexApproval[];
export declare function getCodexState(agentName: string): ProviderRuntimeState;
export declare function getCodexTerminalContent(agentName: string): string;
export declare function getCodexContextPercent(agentName: string): number;
/**
 * Codex RuntimeProvider adapter.
 * Wraps existing codex functions into the unified RuntimeProvider interface.
 */
export declare const codexProvider: RuntimeProvider;
