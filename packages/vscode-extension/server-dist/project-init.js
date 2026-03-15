/**
 * Project Initialization Module
 *
 * Creates project directory structure and generates CLAUDE.md
 * from project config + active shared standards.
 */
import fs from "node:fs";
import path from "node:path";
import { getDb } from "./db/index.js";
/**
 * Initialize a project's directory and files.
 * Called after project creation or when syncing standards.
 *
 * Creates .claude-crew/ config directory inside the user-specified project
 * directory and generates CLAUDE.md at the project root.
 */
export function initProjectDirectory(projectId) {
    const db = getDb();
    const project = db.prepare("SELECT * FROM projects WHERE id = ?").get(projectId);
    if (!project)
        throw new Error(`Project not found: ${projectId}`);
    const projectDir = project.directory;
    if (!projectDir)
        throw new Error(`Project "${project.name}" has no directory set`);
    // Create .claude-crew/ config directory inside user's project
    const crewConfigDir = path.join(projectDir, ".claude-crew");
    fs.mkdirSync(crewConfigDir, { recursive: true });
    // Generate CLAUDE.md from project config + standards
    const claudeMd = generateProjectClaudeMd(project);
    // Write CLAUDE.md to project root directory
    fs.writeFileSync(path.join(projectDir, "CLAUDE.md"), claudeMd, "utf-8");
    return { directory: projectDir, claudeMd };
}
/**
 * Generate CLAUDE.md content from project config and active standards.
 */
function generateProjectClaudeMd(project) {
    const db = getDb();
    const techStack = JSON.parse(project.tech_stack);
    const standards = db.prepare("SELECT * FROM shared_standards WHERE status = 'active' ORDER BY priority DESC").all();
    const agents = db.prepare(`
    SELECT agent_name, role_in_project FROM project_agents
    WHERE project_id = ? AND status = 'active'
  `).all(project.id);
    const lines = [];
    lines.push(`# Project: ${project.name}`);
    lines.push("");
    if (project.description) {
        lines.push(project.description);
        lines.push("");
    }
    if (techStack.length > 0) {
        lines.push(`## Tech Stack`);
        lines.push(techStack.map((t) => `- ${t}`).join("\n"));
        lines.push("");
    }
    if (agents.length > 0) {
        lines.push(`## Team`);
        for (const a of agents) {
            lines.push(`- **${a.agent_name}**: ${a.role_in_project || "Team member"}`);
        }
        lines.push("");
    }
    lines.push("## Collaboration Boundary");
    lines.push("- Only delegate project work to agents listed in the Team section above.");
    lines.push("- If team membership changes later, refresh with Claude Crew project tools or updated context before routing work.");
    lines.push("");
    if (standards.length > 0) {
        lines.push(`## Shared Standards`);
        for (const s of standards) {
            lines.push(`### ${s.name} [${s.category}]`);
            lines.push(s.content);
            lines.push("");
        }
    }
    return lines.join("\n");
}
/**
 * Sync project CLAUDE.md with latest standards.
 * Call this after standards are updated to keep project files in sync.
 */
export function syncProjectStandards(projectId) {
    initProjectDirectory(projectId);
}
/**
 * Sync all active projects with latest standards.
 */
export function syncAllProjectStandards() {
    const db = getDb();
    const projects = db.prepare("SELECT id FROM projects WHERE status = 'active'").all();
    let synced = 0;
    for (const p of projects) {
        try {
            initProjectDirectory(p.id);
            synced++;
        }
        catch {
            // Skip failed projects
        }
    }
    return { synced };
}
//# sourceMappingURL=project-init.js.map