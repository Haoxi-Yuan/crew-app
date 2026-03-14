import { Router, type Request, type Response } from "express";
import type { Router as RouterType } from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { syncAgentWorkspaceContext } from "../agent-context.js";
import { getDb, type ProjectRow, type ProjectAgentRow, type WorkplaceRow } from "../db/index.js";
import { forwardToMentionedAgents } from "../forward.js";
import { createPendingMentions } from "../mentions.js";
import { ensureDefaultWorkplace, listWorkplacesForProject } from "../storage-scope.js";
import { initProjectDirectory } from "../project-init.js";
import { broadcast } from "../ws/handler.js";

const router: RouterType = Router();

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);
}

function countProjectMemories(projectId: string): number {
  const db = getDb();
  const row = db.prepare(`
    SELECT COUNT(*) as count
    FROM memory_entries
    WHERE status != 'archived'
      AND (
        (scope_type = 'project' AND scope_id = ?)
        OR (scope_type = 'workplace' AND scope_id IN (
          SELECT id FROM workplaces WHERE project_id = ?
        ))
      )
  `).get(projectId, projectId) as { count: number };
  return row.count;
}

function listActiveProjectAgents(projectId: string): { agent_name: string; role_in_project: string; assignment_type: string }[] {
  const db = getDb();
  return db.prepare(`
    SELECT agent_name, role_in_project, assignment_type
    FROM project_agents
    WHERE project_id = ? AND status = 'active'
    ORDER BY assigned_at ASC
  `).all(projectId) as { agent_name: string; role_in_project: string; assignment_type: string }[];
}

function syncProjectAgentContexts(projectId: string): void {
  for (const agent of listActiveProjectAgents(projectId)) {
    syncAgentWorkspaceContext(agent.agent_name);
  }
}

function announceProjectAgentUpdate(projectId: string, action: "assigned" | "removed", subjectAgent: string): void {
  const db = getDb();
  const project = db.prepare("SELECT name FROM projects WHERE id = ?").get(projectId) as { name: string } | undefined;
  const channel = db.prepare(
    "SELECT id, type FROM channels WHERE project_id = ? AND workplace_id IS NULL ORDER BY created_at ASC LIMIT 1"
  ).get(projectId) as { id: string; type: string } | undefined;
  if (!project || !channel) return;

  const activeAgents = listActiveProjectAgents(projectId);
  const mentionTargets = activeAgents.map((agent) => agent.agent_name);
  const roster = activeAgents.length > 0
    ? activeAgents.map((agent) => `${agent.agent_name}${agent.role_in_project ? ` (${agent.role_in_project})` : ""}`).join(", ")
    : "(none)";
  const verb = action === "assigned" ? "added to" : "removed from";
  const now = Date.now();
  const content = [
    `Project team update for ${project.name}: ${subjectAgent} was ${verb} the project.`,
    `Current project agents: ${roster}`,
    "Only agents listed in the current project roster should be used for project delegation.",
    "If you cached an older team composition, refresh it now.",
  ].join("\n");

  const result = db.prepare(`
    INSERT INTO messages (channel_id, sender_type, sender_name, content, mentions, message_type, created_at)
    VALUES (?, 'system', 'project-system', ?, ?, 'project_team_update', ?)
  `).run(channel.id, content, JSON.stringify(mentionTargets), now);

  const messageId = Number(result.lastInsertRowid);
  createPendingMentions(messageId, mentionTargets, channel.id);
  broadcast({
    type: "message:new",
    data: {
      id: messageId,
      channel_id: channel.id,
      sender_type: "system",
      sender_name: "project-system",
      content,
      mentions: mentionTargets,
      message_type: "project_team_update",
      created_at: now,
    },
  });
  if (mentionTargets.length > 0) {
    forwardToMentionedAgents(mentionTargets, "project-system", content, messageId, channel.id, channel.type).catch(() => {});
  }
}

function createWorkplace(project: ProjectRow, name: string, kind = "derived"): WorkplaceRow {
  const db = getDb();
  const now = Date.now();
  const id = crypto.randomUUID();
  const slug = slugify(name) || "default";
  const directory = path.join(project.directory, ".claude-crew", "workplaces", slug);
  fs.mkdirSync(directory, { recursive: true });

  db.prepare(`
    INSERT INTO workplaces (id, project_id, name, slug, status, directory, kind, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?)
  `).run(id, project.id, name, slug, directory, kind, now, now);

  const channelId = `workplace-${project.slug}-${slug}`;
  const channelExists = db.prepare("SELECT 1 FROM channels WHERE id = ?").get(channelId);
  if (!channelExists) {
    db.prepare(`
      INSERT INTO channels (id, name, description, status, type, project_id, workplace_id, created_at, updated_at)
      VALUES (?, ?, ?, 'active', 'public', ?, ?, ?, ?)
    `).run(
      channelId,
      `${project.name}/${name}`,
      `Workplace channel for ${project.name} - ${name}`,
      project.id,
      id,
      now,
      now,
    );
    broadcast({
      type: "channel:created",
      data: {
        id: channelId,
        name: `${project.name}/${name}`,
        description: `Workplace channel for ${project.name} - ${name}`,
        status: "active",
        type: "public",
        project_id: project.id,
        workplace_id: id,
        members: null,
        created_at: now,
        updated_at: now,
      },
    });
  }

  return db.prepare("SELECT * FROM workplaces WHERE id = ?").get(id) as WorkplaceRow;
}

// GET /projects - list all projects
router.get("/", (req: Request, res: Response) => {
  const status = req.query.status as string | undefined;
  const db = getDb();

  let rows: ProjectRow[];
  if (status) {
    rows = db
      .prepare("SELECT * FROM projects WHERE status = ? ORDER BY updated_at DESC")
      .all(status) as ProjectRow[];
  } else {
    rows = db
      .prepare("SELECT * FROM projects ORDER BY updated_at DESC")
      .all() as ProjectRow[];
  }

  // Enrich with agent count and memory count
  const result = rows.map((p) => {
    const agentCount = db
      .prepare("SELECT COUNT(*) as count FROM project_agents WHERE project_id = ? AND status = 'active'")
      .get(p.id) as { count: number };
    return {
      ...p,
      tech_stack: JSON.parse(p.tech_stack),
      config: JSON.parse(p.config),
      agent_count: agentCount.count,
      memory_count: countProjectMemories(p.id),
      workplace_count: listWorkplacesForProject(p.id).length,
    };
  });

  res.json(result);
});

// GET /projects/by-agent/:name - find active projects for an agent
// NOTE: Must be registered before /:id to avoid Express treating "by-agent" as an :id param
router.get("/by-agent/:name", (req: Request, res: Response) => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT p.id as project_id, p.name
    FROM project_agents pa
    JOIN projects p ON p.id = pa.project_id
    WHERE pa.agent_name = ? AND pa.status = 'active' AND p.status = 'active'
    ORDER BY pa.assigned_at DESC
  `).all(req.params.name) as { project_id: string; name: string }[];
  res.json(rows);
});

// POST /projects - create a new project
router.post("/", (req: Request, res: Response) => {
  const { directory, name, description, tech_stack, config } = req.body as {
    directory?: string;
    name?: string;
    description?: string;
    tech_stack?: string[];
    config?: Record<string, unknown>;
  };

  // directory is required and must be an existing absolute path
  if (!directory || typeof directory !== "string") {
    res.status(400).json({ error: "directory is required" });
    return;
  }
  if (!path.isAbsolute(directory)) {
    res.status(400).json({ error: "directory must be an absolute path" });
    return;
  }
  if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
    res.status(400).json({ error: "directory does not exist or is not a directory" });
    return;
  }

  // Derive name from directory basename if not provided
  const projectName = (name && typeof name === "string") ? name : path.basename(directory);

  const db = getDb();
  const id = crypto.randomUUID();
  const slug = slugify(projectName);
  const now = Date.now();

  // Check duplicate name/slug
  const existingName = db.prepare("SELECT 1 FROM projects WHERE name = ? OR slug = ?").get(projectName, slug);
  if (existingName) {
    res.status(409).json({ error: "project with this name already exists" });
    return;
  }

  // Check duplicate directory
  const existingDir = db.prepare("SELECT name FROM projects WHERE directory = ?").get(directory) as { name: string } | undefined;
  if (existingDir) {
    res.status(409).json({ error: `directory is already used by project "${existingDir.name}"` });
    return;
  }

  const techStackJson = JSON.stringify(tech_stack || []);
  const configJson = JSON.stringify(config || {});

  db.prepare(`
    INSERT INTO projects (id, name, slug, description, tech_stack, status, config, directory, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)
  `).run(id, projectName, slug, description || "", techStackJson, configJson, directory, now, now);

  // Initialize project directory: create .claude-crew/ and CLAUDE.md
  initProjectDirectory(id);

  // Create a default channel for the project
  const channelId = `project-${slug}`;
  const channelExists = db.prepare("SELECT 1 FROM channels WHERE id = ?").get(channelId);
  if (!channelExists) {
    db.prepare(
      "INSERT INTO channels (id, name, description, status, type, project_id, created_at, updated_at) VALUES (?, ?, ?, 'active', 'public', ?, ?, ?)"
    ).run(channelId, projectName, `Project channel for ${projectName}`, id, now, now);
    broadcast({
      type: "channel:created",
      data: { id: channelId, name: projectName, description: `Project channel for ${projectName}`, status: "active", type: "public", project_id: id, members: null, created_at: now, updated_at: now },
    });
  }

  const project = {
    id,
    name: projectName,
    slug,
    description: description || "",
    tech_stack: tech_stack || [],
    status: "active",
    config: config || {},
    directory,
    created_at: now,
    updated_at: now,
    paused_at: null,
    archived_at: null,
    agent_count: 0,
    memory_count: 0,
    workplace_count: 0,
  };

  broadcast({ type: "project:created", data: project });
  res.json(project);
});

// GET /projects/:id - project detail
router.get("/:id", (req: Request, res: Response) => {
  const db = getDb();
  const row = db.prepare("SELECT * FROM projects WHERE id = ?").get(req.params.id) as ProjectRow | undefined;

  if (!row) {
    res.status(404).json({ error: "project not found" });
    return;
  }

  const agents = db
    .prepare("SELECT * FROM project_agents WHERE project_id = ? AND status = 'active'")
    .all(row.id) as ProjectAgentRow[];
  const workplaces = listWorkplacesForProject(row.id);

  res.json({
    ...row,
    tech_stack: JSON.parse(row.tech_stack),
    config: JSON.parse(row.config),
    agents,
    memory_count: countProjectMemories(row.id),
    workplaces,
  });
});

router.get("/:id/workplaces", (req: Request, res: Response) => {
  const db = getDb();
  const project = db.prepare("SELECT * FROM projects WHERE id = ?").get(req.params.id) as ProjectRow | undefined;
  if (!project) {
    res.status(404).json({ error: "project not found" });
    return;
  }
  res.json(listWorkplacesForProject(project.id));
});

router.post("/:id/workplaces", (req: Request, res: Response) => {
  const db = getDb();
  const project = db.prepare("SELECT * FROM projects WHERE id = ?").get(req.params.id) as ProjectRow | undefined;
  if (!project) {
    res.status(404).json({ error: "project not found" });
    return;
  }

  const { name, kind } = req.body as { name?: string; kind?: string };
  const requestedName = name?.trim() || "Default Workplace";
  const slug = slugify(requestedName) || "default";
  const existing = db.prepare("SELECT * FROM workplaces WHERE project_id = ? AND slug = ?").get(project.id, slug) as WorkplaceRow | undefined;
  if (existing) {
    res.json(existing);
    return;
  }

  const workplace = createWorkplace(project, requestedName, kind || "derived");
  broadcast({ type: "project:updated", data: { id: project.id } });
  res.json(workplace);
});

// PUT /projects/:id - update project
router.put("/:id", (req: Request, res: Response) => {
  const db = getDb();
  const existing = db.prepare("SELECT * FROM projects WHERE id = ?").get(req.params.id) as ProjectRow | undefined;
  if (!existing) {
    res.status(404).json({ error: "project not found" });
    return;
  }

  const { name, description, tech_stack, config } = req.body as {
    name?: string;
    description?: string;
    tech_stack?: string[];
    config?: Record<string, unknown>;
  };

  const now = Date.now();
  db.prepare(`
    UPDATE projects SET name = ?, description = ?, tech_stack = ?, config = ?, updated_at = ? WHERE id = ?
  `).run(
    name || existing.name,
    description !== undefined ? description : existing.description,
    tech_stack ? JSON.stringify(tech_stack) : existing.tech_stack,
    config ? JSON.stringify(config) : existing.config,
    now,
    existing.id
  );

  const updated = db.prepare("SELECT * FROM projects WHERE id = ?").get(existing.id) as ProjectRow;
  broadcast({ type: "project:updated", data: { ...updated, tech_stack: JSON.parse(updated.tech_stack) } });
  res.json({ ...updated, tech_stack: JSON.parse(updated.tech_stack), config: JSON.parse(updated.config) });
});

// POST /projects/:id/pause
router.post("/:id/pause", (req: Request, res: Response) => {
  const db = getDb();
  const existing = db.prepare("SELECT * FROM projects WHERE id = ?").get(req.params.id) as ProjectRow | undefined;
  if (!existing) { res.status(404).json({ error: "project not found" }); return; }
  if (existing.status !== "active") { res.status(400).json({ error: "only active projects can be paused" }); return; }

  const now = Date.now();
  db.prepare("UPDATE projects SET status = 'paused', paused_at = ?, updated_at = ? WHERE id = ?").run(now, now, existing.id);
  broadcast({ type: "project:updated", data: { id: existing.id, status: "paused" } });
  res.json({ ok: true, status: "paused" });
});

// POST /projects/:id/resume
router.post("/:id/resume", (req: Request, res: Response) => {
  const db = getDb();
  const existing = db.prepare("SELECT * FROM projects WHERE id = ?").get(req.params.id) as ProjectRow | undefined;
  if (!existing) { res.status(404).json({ error: "project not found" }); return; }
  if (existing.status !== "paused") { res.status(400).json({ error: "only paused projects can be resumed" }); return; }

  const now = Date.now();
  db.prepare("UPDATE projects SET status = 'active', updated_at = ? WHERE id = ?").run(now, existing.id);
  broadcast({ type: "project:updated", data: { id: existing.id, status: "active" } });
  res.json({ ok: true, status: "active" });
});

// POST /projects/:id/archive
router.post("/:id/archive", (req: Request, res: Response) => {
  const db = getDb();
  const existing = db.prepare("SELECT * FROM projects WHERE id = ?").get(req.params.id) as ProjectRow | undefined;
  if (!existing) { res.status(404).json({ error: "project not found" }); return; }

  const now = Date.now();
  db.prepare("UPDATE projects SET status = 'archived', archived_at = ?, updated_at = ? WHERE id = ?").run(now, now, existing.id);
  broadcast({ type: "project:updated", data: { id: existing.id, status: "archived" } });
  res.json({ ok: true, status: "archived" });
});

// DELETE /projects/:id
router.delete("/:id", (req: Request, res: Response) => {
  const db = getDb();
  const existing = db.prepare("SELECT * FROM projects WHERE id = ?").get(req.params.id) as ProjectRow | undefined;
  if (!existing) { res.status(404).json({ error: "project not found" }); return; }
  const affectedAgents = db.prepare(
    "SELECT agent_name FROM project_agents WHERE project_id = ?"
  ).all(existing.id) as { agent_name: string }[];

  const tx = db.transaction(() => {
    db.prepare("DELETE FROM project_agents WHERE project_id = ?").run(existing.id);
    db.prepare("DELETE FROM reflections WHERE project_id = ?").run(existing.id);
    db.prepare(`
      UPDATE memory_entries
      SET project_id = NULL, scope_type = 'global', scope_id = ''
      WHERE project_id = ?
    `).run(existing.id);
    db.prepare(`
      UPDATE memory_entries
      SET project_id = NULL, scope_type = 'global', scope_id = ''
      WHERE scope_type = 'workplace' AND scope_id IN (
        SELECT id FROM workplaces WHERE project_id = ?
      )
    `).run(existing.id);
    db.prepare("UPDATE channels SET project_id = NULL, workplace_id = NULL WHERE project_id = ?").run(existing.id);
    db.prepare(`
      UPDATE shared_files
      SET scope_type = 'global', scope_id = '', metadata = '{}'
      WHERE scope_type = 'project' AND scope_id = ?
    `).run(existing.id);
    db.prepare(`
      UPDATE shared_files
      SET scope_type = 'global', scope_id = '', metadata = '{}'
      WHERE scope_type = 'workplace' AND scope_id IN (
        SELECT id FROM workplaces WHERE project_id = ?
      )
    `).run(existing.id);
    db.prepare("DELETE FROM workplaces WHERE project_id = ?").run(existing.id);
    db.prepare("DELETE FROM projects WHERE id = ?").run(existing.id);
  });
  tx();
  for (const row of affectedAgents) {
    syncAgentWorkspaceContext(row.agent_name);
  }

  broadcast({ type: "project:deleted", data: { id: existing.id } });
  res.json({ ok: true });
});

// --- Project Agent Management ---

// GET /projects/:id/agents
router.get("/:id/agents", (req: Request, res: Response) => {
  const db = getDb();
  const project = db.prepare("SELECT 1 FROM projects WHERE id = ?").get(req.params.id);
  if (!project) { res.status(404).json({ error: "project not found" }); return; }

  const agents = db
    .prepare("SELECT * FROM project_agents WHERE project_id = ? ORDER BY assigned_at ASC")
    .all(req.params.id) as ProjectAgentRow[];
  res.json(agents);
});

// POST /projects/:id/agents - assign agent to project
router.post("/:id/agents", (req: Request, res: Response) => {
  const { agent_name, role_in_project, assignment_type } = req.body as {
    agent_name?: string;
    role_in_project?: string;
    assignment_type?: string;
  };

  if (!agent_name) {
    res.status(400).json({ error: "agent_name is required" });
    return;
  }

  const db = getDb();
  const project = db.prepare("SELECT 1 FROM projects WHERE id = ?").get(req.params.id);
  if (!project) { res.status(404).json({ error: "project not found" }); return; }

  const existing = db
    .prepare("SELECT 1 FROM project_agents WHERE project_id = ? AND agent_name = ?")
    .get(req.params.id, agent_name);
  if (existing) {
    res.status(409).json({ error: "agent already assigned to this project" });
    return;
  }

  const now = Date.now();
  const projectId = typeof req.params.id === "string" ? req.params.id : String(req.params.id);
  const defaultWorkplace = ensureDefaultWorkplace(projectId);
  db.prepare(`
    INSERT INTO project_agents (project_id, agent_name, role_in_project, assignment_type, status, active_workplace_id, assigned_at)
    VALUES (?, ?, ?, ?, 'active', ?, ?)
  `).run(projectId, agent_name, role_in_project || "", assignment_type || "dedicated", defaultWorkplace.id, now);

  db.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").run(now, projectId);
  initProjectDirectory(projectId);
  syncProjectAgentContexts(projectId);
  announceProjectAgentUpdate(projectId, "assigned", agent_name);

  broadcast({ type: "project:agent_changed", data: { project_id: projectId, agent_name, action: "assigned" } });
  res.json({ ok: true, agent_name, assignment_type: assignment_type || "dedicated" });
});

// DELETE /projects/:id/agents/:name
router.delete("/:id/agents/:name", (req: Request, res: Response) => {
  const db = getDb();
  const projectId = typeof req.params.id === "string" ? req.params.id : String(req.params.id);
  const agentName = typeof req.params.name === "string" ? req.params.name : String(req.params.name);
  const result = db
    .prepare("DELETE FROM project_agents WHERE project_id = ? AND agent_name = ?")
    .run(projectId, agentName);

  if (result.changes === 0) {
    res.status(404).json({ error: "agent assignment not found" });
    return;
  }

  const now = Date.now();
  db.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").run(now, projectId);
  initProjectDirectory(projectId);
  syncAgentWorkspaceContext(agentName);
  syncProjectAgentContexts(projectId);
  announceProjectAgentUpdate(projectId, "removed", agentName);

  broadcast({ type: "project:agent_changed", data: { project_id: projectId, agent_name: agentName, action: "removed" } });
  res.json({ ok: true });
});

router.put("/:id/agents/:name/workplace", (req: Request, res: Response) => {
  const db = getDb();
  const projectId = typeof req.params.id === "string" ? req.params.id : String(req.params.id);
  const agentName = typeof req.params.name === "string" ? req.params.name : String(req.params.name);
  const { workplace_id } = req.body as { workplace_id?: string | null };

  const assignment = db.prepare(
    "SELECT * FROM project_agents WHERE project_id = ? AND agent_name = ? AND status = 'active'"
  ).get(projectId, agentName) as ProjectAgentRow | undefined;
  if (!assignment) {
    res.status(404).json({ error: "active project assignment not found" });
    return;
  }

  let nextWorkplaceId: string | null = null;
  if (workplace_id) {
    const workplace = db.prepare(
      "SELECT * FROM workplaces WHERE id = ? AND project_id = ?"
    ).get(workplace_id, projectId) as WorkplaceRow | undefined;
    if (!workplace) {
      res.status(404).json({ error: "workplace not found for project" });
      return;
    }
    nextWorkplaceId = workplace.id;
  }

  db.prepare(
    "UPDATE project_agents SET active_workplace_id = ? WHERE project_id = ? AND agent_name = ?"
  ).run(nextWorkplaceId, projectId, agentName);
  syncAgentWorkspaceContext(agentName);

  broadcast({
    type: "project:agent_changed",
    data: { project_id: projectId, agent_name: agentName, action: "workplace_changed", workplace_id: nextWorkplaceId },
  });
  res.json({ ok: true, project_id: projectId, agent_name: agentName, workplace_id: nextWorkplaceId });
});

// GET /projects/:id/context - generate compact project context for injection
router.get("/:id/context", (req: Request, res: Response) => {
  const db = getDb();
  const project = db.prepare("SELECT * FROM projects WHERE id = ?").get(req.params.id) as ProjectRow | undefined;
  if (!project) { res.status(404).json({ error: "project not found" }); return; }

  const agents = db
    .prepare("SELECT agent_name, role_in_project FROM project_agents WHERE project_id = ? AND status = 'active'")
    .all(project.id) as { agent_name: string; role_in_project: string }[];

  const standards = db
    .prepare("SELECT name, content FROM shared_standards WHERE status = 'active' ORDER BY priority DESC")
    .all() as { name: string; content: string }[];

  const techStack = JSON.parse(project.tech_stack) as string[];

  let context = `## Active Project: ${project.name}\n${project.description}\n`;
  if (techStack.length > 0) {
    context += `### Tech Stack: ${techStack.join(", ")}\n`;
  }
  if (project.directory) {
    context += `### Canonical Project Root: ${project.directory}\n`;
    context += "Store durable code, specs, permanent reference docs, and long-lived decision memory here.\n";
  }
  const workplaces = listWorkplacesForProject(project.id);
  if (workplaces.length > 0) {
    const activeNames = workplaces.map((w) => `${w.name} (${w.kind})`).join(", ");
    context += `### Workplaces: ${activeNames}\n`;
    context += "Use workplaces for uploads, generated artifacts, revisions, data files, and intermediate outputs.\n";
  }
  if (standards.length > 0) {
    context += `### Standards:\n`;
    for (const s of standards) {
      context += `- **${s.name}**: ${s.content}\n`;
    }
  }
  if (agents.length > 0) {
    context += `### Team: ${agents.map((a) => `${a.agent_name}${a.role_in_project ? ` (${a.role_in_project})` : ""}`).join(", ")}\n`;
    context += "Only collaborate with agents listed in this team for project work. If the roster changes, refresh this context before delegating.\n";
  }

  // Enforce size budget (~3000 tokens ~ 12000 chars)
  if (context.length > 12000) {
    context = context.slice(0, 11900) + "\n...(truncated, call get_project_context for full details)";
  }

  res.json({ project_id: project.id, context });
});

router.get("/:id/workplaces/:workplaceId/context", (req: Request, res: Response) => {
  const db = getDb();
  const project = db.prepare("SELECT * FROM projects WHERE id = ?").get(req.params.id) as ProjectRow | undefined;
  if (!project) { res.status(404).json({ error: "project not found" }); return; }
  const workplace = db.prepare(
    "SELECT * FROM workplaces WHERE id = ? AND project_id = ?"
  ).get(req.params.workplaceId, project.id) as WorkplaceRow | undefined;
  if (!workplace) { res.status(404).json({ error: "workplace not found" }); return; }

  const agents = db.prepare(`
    SELECT agent_name, role_in_project
    FROM project_agents
    WHERE project_id = ? AND status = 'active' AND (active_workplace_id IS NULL OR active_workplace_id = ?)
  `).all(project.id, workplace.id) as { agent_name: string; role_in_project: string }[];

  const context = [
    `## Workplace: ${workplace.name}`,
    `Project: ${project.name}`,
    `Directory: ${workplace.directory}`,
    `Kind: ${workplace.kind}`,
    agents.length > 0 ? `Active agents: ${agents.map((a) => `${a.agent_name}${a.role_in_project ? ` (${a.role_in_project})` : ""}`).join(", ")}` : "",
    "Use this workplace for derived artifacts, uploads, experiments, revisions, and intermediate outputs.",
  ].filter(Boolean).join("\n");

  res.json({ project_id: project.id, workplace_id: workplace.id, context });
});

// POST /projects/:id/memory/share - Copy memory entries to another project
router.post("/:id/memory/share", (req: Request, res: Response) => {
  const { target_project_id, entry_ids } = req.body as {
    target_project_id?: string;
    entry_ids?: string[];
  };

  if (!target_project_id || !entry_ids || !Array.isArray(entry_ids) || entry_ids.length === 0) {
    res.status(400).json({ error: "target_project_id and entry_ids[] are required" });
    return;
  }

  const db = getDb();

  // Validate source project
  const srcProject = db.prepare("SELECT 1 FROM projects WHERE id = ?").get(req.params.id);
  if (!srcProject) { res.status(404).json({ error: "source project not found" }); return; }

  // Validate target project
  const tgtProject = db.prepare("SELECT 1 FROM projects WHERE id = ?").get(target_project_id);
  if (!tgtProject) { res.status(404).json({ error: "target project not found" }); return; }

  const selectStmt = db.prepare("SELECT * FROM memory_entries WHERE id = ? AND project_id = ?");
  const insertStmt = db.prepare(`
    INSERT INTO memory_entries (
      id, agent_name, category, source_file, heading, content, content_hash,
      importance, emotional_weight, created_at, last_accessed_at,
      access_count, access_timestamps, stability, difficulty,
      activation, retrievability, status, linked_ids, project_id, embedding, scope_type, scope_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let copied = 0;
  let skipped = 0;
  const tx = db.transaction(() => {
    for (const entryId of entry_ids) {
      const row = selectStmt.get(entryId, req.params.id) as Record<string, unknown> | undefined;
      if (!row) { skipped++; continue; }

      const newId = crypto.randomUUID();
      // Check for duplicate in target project
      const dupCheck = db.prepare(
        "SELECT 1 FROM memory_entries WHERE content_hash = ? AND scope_type = 'project' AND scope_id = ? AND status != 'archived'"
      ).get(row.content_hash, target_project_id);
      if (dupCheck) { skipped++; continue; }

      const now = Date.now();
      insertStmt.run(
        newId, row.agent_name, row.category, row.source_file, row.heading, row.content, row.content_hash,
        row.importance, row.emotional_weight, now, now,
        0, "[]", 1.0, 0.3,
        0.0, 1.0, row.status === "permanent" ? "permanent" : "active", row.linked_ids, target_project_id, row.embedding, "project", target_project_id
      );
      copied++;
    }
  });
  tx();

  broadcast({ type: "project:updated", data: { id: target_project_id } });
  res.json({ copied, skipped });
});

export default router;
