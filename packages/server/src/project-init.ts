/**
 * Project Initialization Module
 *
 * Creates project directory structure and generates CLAUDE.md
 * from project config + active shared standards.
 */

import fs from "node:fs";
import path from "node:path";
import { getDb, type ProjectRow, type SharedStandardRow } from "./db/index.js";
import { DATA_DIR } from "./config.js";

/**
 * Initialize a project's directory and files.
 * Called after project creation or when syncing standards.
 */
export function initProjectDirectory(projectId: string): { directory: string; claudeMd: string } {
  const db = getDb();
  const project = db.prepare("SELECT * FROM projects WHERE id = ?").get(projectId) as ProjectRow | undefined;
  if (!project) throw new Error(`Project not found: ${projectId}`);

  const projectDir = project.directory || path.join(DATA_DIR, "projects", project.slug);

  // Ensure canonical project root exists. Derived artifacts live under workplaces/.
  fs.mkdirSync(projectDir, { recursive: true });

  // Generate CLAUDE.md from project config + standards
  const claudeMd = generateProjectClaudeMd(project);

  // Write CLAUDE.md to project directory
  fs.writeFileSync(path.join(projectDir, "CLAUDE.md"), claudeMd, "utf-8");

  // Update project directory if it changed
  if (project.directory !== projectDir) {
    db.prepare("UPDATE projects SET directory = ? WHERE id = ?").run(projectDir, projectId);
  }

  return { directory: projectDir, claudeMd };
}

/**
 * Generate CLAUDE.md content from project config and active standards.
 */
function generateProjectClaudeMd(project: ProjectRow): string {
  const db = getDb();
  const techStack = JSON.parse(project.tech_stack) as string[];
  const standards = db.prepare(
    "SELECT * FROM shared_standards WHERE status = 'active' ORDER BY priority DESC"
  ).all() as SharedStandardRow[];

  const agents = db.prepare(`
    SELECT agent_name, role_in_project FROM project_agents
    WHERE project_id = ? AND status = 'active'
  `).all(project.id) as { agent_name: string; role_in_project: string }[];

  const lines: string[] = [];

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
export function syncProjectStandards(projectId: string): void {
  initProjectDirectory(projectId);
}

/**
 * Sync all active projects with latest standards.
 */
export function syncAllProjectStandards(): { synced: number } {
  const db = getDb();
  const projects = db.prepare("SELECT id FROM projects WHERE status = 'active'").all() as { id: string }[];

  let synced = 0;
  for (const p of projects) {
    try {
      initProjectDirectory(p.id);
      synced++;
    } catch {
      // Skip failed projects
    }
  }

  return { synced };
}
