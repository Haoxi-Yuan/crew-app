export interface ToolApproval {
    id: string;
    agentName: string;
    toolServer: string;
    toolName: string;
    params: string;
    description: string;
    options: {
        key: string;
        label: string;
    }[];
    promptType: "tool_use" | "mcp_setup";
    detectedAt: number;
}
export type AgentTmuxState = "idle" | "busy" | "approval_pending" | "no_session";
export declare function getActiveApprovals(): ToolApproval[];
export declare function getApprovalForAgent(agentName: string): ToolApproval | undefined;
export declare function removeApproval(agentName: string): void;
export declare function getAgentTmuxState(agentName: string): AgentTmuxState;
export declare function getAllAgentTmuxStates(): Map<string, AgentTmuxState>;
export declare function getAgentContextPercent(agentName: string): number;
export declare function getAllAgentContextPercents(): Map<string, number>;
export declare function getAgentTerminalContent(agentName: string): string;
/**
 * Send a key response to an agent's tmux session.
 */
export declare function sendApprovalResponse(agentName: string, key: string): Promise<boolean>;
export declare function startTmuxMonitor(): void;
export declare function stopTmuxMonitor(): void;
