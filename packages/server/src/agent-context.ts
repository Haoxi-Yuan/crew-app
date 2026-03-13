import fs from "node:fs";
import path from "node:path";
import { PROJECT_ROOT } from "./config.js";
import { getDb, type ProjectRow, type WorkplaceRow } from "./db/index.js";

const AGENTS_DIR = path.join(PROJECT_ROOT, "agents");

export interface AgentWorkspaceContext {
  agentName: string;
  agentDir: string;
  contextDir: string;
  contextFile: string;
  currentProjectLink: string;
  currentWorkplaceLink: string;
  project: Pick<ProjectRow, "id" | "name" | "slug" | "directory"> | null;
  workplace: Pick<WorkplaceRow, "id" | "name" | "slug" | "directory" | "kind"> | null;
}

function removePathIfPresent(targetPath: string): void {
  try {
    fs.rmSync(targetPath, { force: true, recursive: true });
  } catch {
    // Best effort.
  }
}

function replaceSymlink(linkPath: string, targetPath: string | null): void {
  removePathIfPresent(linkPath);
  if (!targetPath) {
    return;
  }
  fs.symlinkSync(targetPath, linkPath);
}

function buildPointerReadme(): string {
  return [
    "# Claude Crew Workspace Pointers",
    "",
    "This agent keeps its own workspace as the default cwd.",
    "Use the pointers below to access the active collaboration context without changing the runtime cwd.",
    "",
    "- `current-project/` -> canonical project assets",
    "- `current-workplace/` -> derived artifacts and active execution outputs",
    "- `context.json` -> machine-readable metadata for the current assignment",
    "",
  ].join("\n");
}

export function getAgentWorkspaceContext(agentName: string): AgentWorkspaceContext {
  const db = getDb();
  const agentDir = path.join(AGENTS_DIR, agentName);
  const contextDir = path.join(agentDir, ".crew");
  const contextFile = path.join(contextDir, "context.json");
  const currentProjectLink = path.join(contextDir, "current-project");
  const currentWorkplaceLink = path.join(contextDir, "current-workplace");

  const assignment = db.prepare(`
    SELECT
      p.id as project_id,
      p.name as project_name,
      p.slug as project_slug,
      p.directory as project_directory,
      w.id as workplace_id,
      w.name as workplace_name,
      w.slug as workplace_slug,
      w.directory as workplace_directory,
      w.kind as workplace_kind
    FROM project_agents pa
    JOIN projects p ON p.id = pa.project_id
    LEFT JOIN workplaces w ON w.id = pa.active_workplace_id
    WHERE pa.agent_name = ? AND pa.status = 'active' AND p.status = 'active'
    ORDER BY pa.assigned_at DESC
    LIMIT 1
  `).get(agentName) as {
    project_id: string;
    project_name: string;
    project_slug: string;
    project_directory: string;
    workplace_id: string | null;
    workplace_name: string | null;
    workplace_slug: string | null;
    workplace_directory: string | null;
    workplace_kind: string | null;
  } | undefined;

  return {
    agentName,
    agentDir,
    contextDir,
    contextFile,
    currentProjectLink,
    currentWorkplaceLink,
    project: assignment ? {
      id: assignment.project_id,
      name: assignment.project_name,
      slug: assignment.project_slug,
      directory: assignment.project_directory,
    } : null,
    workplace: assignment?.workplace_id ? {
      id: assignment.workplace_id,
      name: assignment.workplace_name || "Workplace",
      slug: assignment.workplace_slug || "workplace",
      directory: assignment.workplace_directory || "",
      kind: assignment.workplace_kind || "derived",
    } : null,
  };
}

export function syncAgentWorkspaceContext(agentName: string): AgentWorkspaceContext {
  const context = getAgentWorkspaceContext(agentName);
  if (!fs.existsSync(context.agentDir)) {
    return context;
  }

  fs.mkdirSync(context.contextDir, { recursive: true });
  fs.writeFileSync(path.join(context.contextDir, "README.md"), buildPointerReadme(), "utf-8");

  const payload = {
    agent_name: context.agentName,
    agent_dir: context.agentDir,
    project: context.project,
    workplace: context.workplace,
    pointers: {
      current_project: context.project ? context.currentProjectLink : null,
      current_workplace: context.workplace ? context.currentWorkplaceLink : null,
    },
  };
  fs.writeFileSync(context.contextFile, JSON.stringify(payload, null, 2) + "\n", "utf-8");

  replaceSymlink(context.currentProjectLink, context.project?.directory || null);
  replaceSymlink(context.currentWorkplaceLink, context.workplace?.directory || null);

  return context;
}

export function buildAgentWorkspaceEnv(agentName: string): Record<string, string> {
  const context = syncAgentWorkspaceContext(agentName);
  const env: Record<string, string> = {
    CLAUDE_CREW_AGENT_DIR: context.agentDir,
    CLAUDE_CREW_CONTEXT_DIR: context.contextDir,
    CLAUDE_CREW_CONTEXT_FILE: context.contextFile,
  };

  if (context.project) {
    env.CLAUDE_CREW_PROJECT_ID = context.project.id;
    env.CLAUDE_CREW_PROJECT_DIR = context.project.directory;
  }
  if (context.workplace) {
    env.CLAUDE_CREW_WORKPLACE_ID = context.workplace.id;
    env.CLAUDE_CREW_WORKPLACE_DIR = context.workplace.directory;
  }

  return env;
}
