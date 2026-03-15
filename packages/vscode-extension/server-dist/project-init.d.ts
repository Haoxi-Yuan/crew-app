/**
 * Project Initialization Module
 *
 * Creates project directory structure and generates CLAUDE.md
 * from project config + active shared standards.
 */
/**
 * Initialize a project's directory and files.
 * Called after project creation or when syncing standards.
 *
 * Creates .claude-crew/ config directory inside the user-specified project
 * directory and generates CLAUDE.md at the project root.
 */
export declare function initProjectDirectory(projectId: string): {
    directory: string;
    claudeMd: string;
};
/**
 * Sync project CLAUDE.md with latest standards.
 * Call this after standards are updated to keep project files in sync.
 */
export declare function syncProjectStandards(projectId: string): void;
/**
 * Sync all active projects with latest standards.
 */
export declare function syncAllProjectStandards(): {
    synced: number;
};
