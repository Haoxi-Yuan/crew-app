import { type ProjectRow, type WorkplaceRow } from "./db/index.js";
export type ScopeType = "global" | "project" | "workplace";
export type ScopeIntent = "canonical" | "derived";
export interface ScopeInput {
    scopeType?: string | null;
    scopeId?: string | null;
    projectId?: string | null;
    workplaceId?: string | null;
    intent?: ScopeIntent;
}
export interface ResolvedScope {
    scopeType: ScopeType;
    scopeId: string;
    projectId: string | null;
    workplaceId: string | null;
    directory: string;
    project: ProjectRow | null;
    workplace: WorkplaceRow | null;
}
export declare function isCanonicalArtifactPath(filePath: string): boolean;
export declare function getProjectById(projectId: string): ProjectRow | null;
export declare function getWorkplaceById(workplaceId: string): WorkplaceRow | null;
export declare function listWorkplacesForProject(projectId: string): WorkplaceRow[];
export declare function ensureDefaultWorkplace(projectId: string): WorkplaceRow;
export declare function resolveScope(input: ScopeInput): ResolvedScope;
export declare function inferScopeIntent(filePath: string, explicitKind?: string | null): ScopeIntent;
export declare function inferMemoryIntent(category: string, explicitKind?: string | null): ScopeIntent;
export declare function listProjectScopeIds(projectId: string): {
    projectId: string;
    workplaceIds: string[];
};
