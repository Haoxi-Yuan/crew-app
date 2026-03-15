export declare const DEFAULT_PROVIDER = "claude";
export type AgentProvider = "claude" | "codex";
export type ApprovalPolicy = "untrusted" | "on-request" | "never";
export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export interface AgentRuntimeConfig {
    provider: AgentProvider;
    model?: string;
    effort?: string;
    approvalPolicy?: ApprovalPolicy;
    sandboxMode?: SandboxMode;
    threadId?: string;
    serviceName?: string;
    claudeSessionId?: string;
    claudeBridgeFingerprint?: string;
    claudeSettingsPath?: string;
}
export declare function getProvider(agentName: string): AgentProvider;
export declare function getAgentRuntimeConfig(agentName: string): AgentRuntimeConfig;
export declare function mergeAgentMetadata(agentName: string, patch: Record<string, unknown>): Record<string, unknown>;
export declare function clearAgentMetadataKeys(agentName: string, keys: string[]): Record<string, unknown>;
