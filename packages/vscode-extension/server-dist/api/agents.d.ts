import type { Router as RouterType } from "express";
declare const router: RouterType;
export interface ClaudeLaunchSpec {
    cmd: string;
    sessionId: string;
    bridgeFingerprint: string;
    settingsPath: string | null;
    forceNewSession: boolean;
}
export interface ClaudeRuntimeVerification {
    session: string;
    panePid: number;
    processCommand: string;
    processStartedAt: string;
    sessionId: string;
    bridgeFingerprint: string;
    settingsPath: string | null;
    forceNewSession: boolean;
    command: string;
}
export declare function startVerifiedClaudeSession(agentDir: string, claudePath: string, agentName: string, options?: {
    forceNewSession?: boolean;
    previousPanePid?: number | null;
}): Promise<ClaudeRuntimeVerification>;
export interface AgentConfig {
    model?: string;
    effort?: string;
}
/** Read agent config (model/effort) from metadata in DB */
export declare function getAgentConfig(agentName: string): AgentConfig;
/** Get the current project context string for an agent (if assigned to a project) */
export declare function getAgentProjectContext(agentName: string): string | null;
/** Build the claude CLI command with optional --model, --effort, and --append-system-prompt flags */
export declare function buildClaudeCmd(agentDir: string, claudePath: string, agentName: string): string;
export default router;
