import { type ProjectRow, type WorkplaceRow } from "./db/index.js";
export interface AgentWorkspaceContext {
    agentName: string;
    agentDir: string;
    contextDir: string;
    contextFile: string;
    currentProjectLink: string;
    currentWorkplaceLink: string;
    project: Pick<ProjectRow, "id" | "name" | "slug" | "directory"> | null;
    workplace: Pick<WorkplaceRow, "id" | "name" | "slug" | "directory" | "kind"> | null;
    projectAgents: {
        name: string;
        role_in_project: string;
        assignment_type: string;
    }[];
}
export declare function getAgentWorkspaceContext(agentName: string): AgentWorkspaceContext;
export declare function syncAgentWorkspaceContext(agentName: string): AgentWorkspaceContext;
export declare function buildAgentWorkspaceEnv(agentName: string): Record<string, string>;
