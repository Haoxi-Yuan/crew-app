import { Router, type Request, type Response } from "express";
import type { Router as RouterType } from "express";
import { randomUUID } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { getDb, type AgentRow } from "../db/index.js";
import { broadcast } from "../ws/handler.js";
import { PROJECT_ROOT, WORKLOG_DIR } from "../config.js";
import { getAllAgentTmuxStates, getAllAgentContextPercents, getAgentTerminalContent } from "../tmux-monitor.js";

const execFileAsync = promisify(execFile);
const AGENTS_DIR = path.join(PROJECT_ROOT, "agents");
const BRIDGE_PATH = path.join(PROJECT_ROOT, "packages/mcp-bridge/dist/index.js");

const router: RouterType = Router();

// --- Helper: find node binary ---
function findNodePath(): string {
  try {
    return execFileSync("which", ["node"]).toString().trim();
  } catch { /* ignore */ }
  const candidates = [
    path.join(process.env.HOME || "", ".nvm/versions/node"),
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
  ];
  for (const c of candidates) {
    if (c.includes("nvm")) {
      try {
        for (const d of fs.readdirSync(c)) {
          const p = path.join(c, d, "bin/node");
          if (fs.existsSync(p)) return p;
        }
      } catch { /* ignore */ }
    } else if (fs.existsSync(c)) return c;
  }
  return "";
}

// --- Helper: find claude binary ---
function findClaudePath(): string {
  try {
    return execFileSync("which", ["claude"]).toString().trim();
  } catch { /* ignore */ }
  const candidates = [
    path.join(process.env.HOME || "", ".nvm/versions/node"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  ];
  for (const c of candidates) {
    if (c.includes("nvm")) {
      try {
        for (const d of fs.readdirSync(c)) {
          const p = path.join(c, d, "bin/claude");
          if (fs.existsSync(p)) return p;
        }
      } catch { /* ignore */ }
    } else if (fs.existsSync(c)) return c;
  }
  return "";
}

// --- Helper: create workspace (.mcp.json + CLAUDE.md) ---
function createWorkspace(name: string, role: string): void {
  const agentDir = path.join(AGENTS_DIR, name);
  fs.mkdirSync(agentDir, { recursive: true });

  const nodePath = findNodePath();

  // Write .mcp.json
  const mcpConfig = {
    mcpServers: {
      "claude-crew": {
        command: nodePath,
        args: [BRIDGE_PATH, name, role],
      },
    },
  };
  fs.writeFileSync(
    path.join(agentDir, ".mcp.json"),
    JSON.stringify(mcpConfig, null, 2) + "\n"
  );

  // Write CLAUDE.md
  const claudeMd = `# Agent: ${name}
Role: ${role}

You are "${name}" in the Claude Crew multi-agent team.

Messages from the group chat will be sent to you directly in the format:
[sender in group chat]: message content

## How to respond
When you receive a group chat message, do the work requested, then call \`send_to_chat\` to post your response/results back to the group chat so the team can see it.

## Available tools
- \`send_to_chat\` - post a message to the group chat (ALWAYS use this to reply)
- \`read_chat\` - read recent group chat messages for context
- \`check_mentions\` - check for @mentions directed at you
- \`list_agents\` - see who else is online
- \`read_shared_file\` / \`write_shared_file\` / \`list_shared_files\` - shared team files

## Collaborating with other agents
- Use \`@agent-name\` in your \`send_to_chat\` messages to request help from other agents
- Example: \`send_to_chat("@coder please implement the API endpoint I designed above")\`
- Use \`list_agents\` to see who is available and their roles
- Use \`read_chat\` to catch up on recent conversation context before responding

## Rules
- ALWAYS reply via \`send_to_chat\` so the team sees your response
- Keep chat messages concise, put detailed output in shared files if needed
- You can work on any files on this machine using standard tools
- Do NOT @mention yourself in messages
`;
  fs.writeFileSync(path.join(agentDir, "CLAUDE.md"), claudeMd);
}

// --- Helper: kill tmux session + bridge processes ---
async function killAgentProcesses(name: string): Promise<void> {
  const session = `crew-${name}`;

  // Kill tmux session
  try {
    await execFileAsync("tmux", ["kill-session", "-t", session]);
  } catch { /* session might not exist */ }

  // Kill MCP bridge processes for this agent
  try {
    const { stdout } = await execFileAsync("pgrep", ["-f", `mcp-bridge.*${name}`]);
    const pids = stdout.trim().split("\n").filter(Boolean);
    for (const pid of pids) {
      try { process.kill(parseInt(pid), "SIGTERM"); } catch { /* ignore */ }
    }
  } catch { /* no matching processes */ }
}

// ========== Routes ==========

// POST /agents/register - MCP bridge calls this on startup
router.post("/register", (req: Request, res: Response) => {
  const { name, role } = req.body as { name?: string; role?: string };
  if (!name || typeof name !== "string") {
    res.status(400).json({ error: "name is required" });
    return;
  }

  const db = getDb();
  const now = Date.now();

  const existing = db
    .prepare("SELECT id FROM agents WHERE name = ?")
    .get(name) as AgentRow | undefined;

  if (existing) {
    db.prepare(
      "UPDATE agents SET status = 'online', role = ?, last_heartbeat = ? WHERE name = ?"
    ).run(role || "", now, name);
    broadcast({ type: "agent:status", data: { name, status: "online", role: role || "" } });
    res.json({ id: existing.id, name, status: "online" });
    return;
  }

  const id = randomUUID();
  db.prepare(
    "INSERT INTO agents (id, name, role, status, last_heartbeat, registered_at) VALUES (?, ?, ?, 'online', ?, ?)"
  ).run(id, name, role || "", now, now);

  broadcast({ type: "agent:status", data: { name, status: "online", role: role || "" } });
  res.json({ id, name, status: "online" });
});

// POST /agents/create - Create workspace + register + optionally wake
router.post("/create", (req: Request, res: Response) => {
  const { name, role, wake } = req.body as { name?: string; role?: string; wake?: boolean };
  if (!name || typeof name !== "string") {
    res.status(400).json({ error: "name is required" });
    return;
  }

  // Validate name (alphanumeric + hyphens only)
  if (!/^[\w][\w-]*$/.test(name)) {
    res.status(400).json({ error: "Invalid agent name. Use letters, numbers, hyphens only." });
    return;
  }

  const agentDir = path.join(AGENTS_DIR, name);
  const agentRole = role || "";

  // Check if bridge is built
  if (!fs.existsSync(BRIDGE_PATH)) {
    res.status(500).json({ error: "MCP bridge not built. Run 'crew build' first." });
    return;
  }

  // Create workspace
  try {
    createWorkspace(name, agentRole);
  } catch (err) {
    res.status(500).json({ error: `Failed to create workspace: ${(err as Error).message}` });
    return;
  }

  // Register in DB
  const db = getDb();
  const now = Date.now();
  const existing = db.prepare("SELECT id FROM agents WHERE name = ?").get(name) as AgentRow | undefined;
  let agentId: string;

  if (existing) {
    db.prepare("UPDATE agents SET role = ?, status = 'offline' WHERE name = ?").run(agentRole, name);
    agentId = existing.id;
  } else {
    agentId = randomUUID();
    db.prepare(
      "INSERT INTO agents (id, name, role, status, last_heartbeat, registered_at) VALUES (?, ?, ?, 'offline', ?, ?)"
    ).run(agentId, name, agentRole, now, now);
  }

  broadcast({ type: "agent:status", data: { name, status: "offline", role: agentRole } });

  // Optionally wake (start tmux session)
  if (wake) {
    const claudePath = findClaudePath();
    if (!claudePath) {
      res.json({ ok: true, id: agentId, name, workspace: agentDir, wakeError: "Claude Code CLI not found" });
      return;
    }

    const session = `crew-${name}`;
    const cmd = buildClaudeCmd(agentDir, claudePath, name);
    execFile("tmux", ["new-session", "-d", "-s", session, cmd], (err) => {
      res.json({
        ok: true,
        id: agentId,
        name,
        workspace: agentDir,
        woke: !err,
        wakeError: err ? err.message : undefined,
      });
    });
  } else {
    res.json({ ok: true, id: agentId, name, workspace: agentDir });
  }
});

// POST /agents/heartbeat
router.post("/heartbeat", (req: Request, res: Response) => {
  const { name } = req.body as { name?: string };
  if (!name) {
    res.status(400).json({ error: "name is required" });
    return;
  }

  const db = getDb();
  const now = Date.now();
  const result = db
    .prepare("UPDATE agents SET last_heartbeat = ?, status = 'online' WHERE name = ?")
    .run(now, name);

  if (result.changes === 0) {
    res.status(404).json({ error: "agent not found" });
    return;
  }

  res.json({ ok: true });
});

// POST /agents/deregister
router.post("/deregister", (req: Request, res: Response) => {
  const { name } = req.body as { name?: string };
  if (!name) {
    res.status(400).json({ error: "name is required" });
    return;
  }

  const db = getDb();
  db.prepare("UPDATE agents SET status = 'offline' WHERE name = ?").run(name);
  broadcast({ type: "agent:status", data: { name, status: "offline" } });
  res.json({ ok: true });
});

// GET /agents
router.get("/", (_req: Request, res: Response) => {
  const db = getDb();
  const agents = db
    .prepare("SELECT id, name, role, status, last_heartbeat, registered_at FROM agents ORDER BY name")
    .all() as AgentRow[];
  const tmuxStates = getAllAgentTmuxStates();
  const contextPercents = getAllAgentContextPercents();
  const result = agents.map((a) => ({
    ...a,
    tmuxState: tmuxStates.get(a.name) || "no_session",
    contextPercent: contextPercents.get(a.name) || 0,
  }));
  res.json(result);
});

// GET /agents/:name/terminal - Get current terminal content for an agent
router.get("/:name/terminal", (_req: Request, res: Response) => {
  const { name } = _req.params;
  const content = getAgentTerminalContent(name as string);
  res.json({ name, content });
});

// POST /agents/:name/terminal/input - Send input to agent's tmux session
router.post("/:name/terminal/input", async (req: Request, res: Response) => {
  const { name } = req.params;
  const { input, type } = req.body as { input?: string; type?: string };
  if (!input && input !== "") {
    res.status(400).json({ error: "input is required" });
    return;
  }

  const sessionName = `crew-${name}`;

  try {
    await execFileAsync("tmux", ["has-session", "-t", sessionName]);
  } catch {
    res.status(404).json({ error: `No tmux session for agent '${name}'` });
    return;
  }

  try {
    if (type === "key") {
      await execFileAsync("tmux", ["send-keys", "-t", sessionName, input]);
    } else {
      await execFileAsync("tmux", ["send-keys", "-t", sessionName, input, "Enter"]);
    }
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Failed to send input" });
  }
});

// PUT /agents/:name
router.put("/:name", (req: Request, res: Response) => {
  const { name } = req.params;
  const { role, status } = req.body as { role?: string; status?: string };

  const db = getDb();
  const existing = db.prepare("SELECT * FROM agents WHERE name = ?").get(name) as AgentRow | undefined;
  if (!existing) {
    res.status(404).json({ error: "agent not found" });
    return;
  }

  const newRole = role !== undefined ? role : existing.role;
  const newStatus = status || existing.status;
  db.prepare("UPDATE agents SET role = ?, status = ? WHERE name = ?").run(newRole, newStatus, name as string);
  broadcast({ type: "agent:status", data: { name, status: newStatus, role: newRole } });
  res.json({ ...existing, role: newRole, status: newStatus });
});

// GET /agents/:name/worklog - Read agent's worklog
router.get("/:name/worklog", (req: Request, res: Response) => {
  const { name } = req.params;
  const worklogPath = path.join(WORKLOG_DIR, `${name}_worklog.json`);

  if (!fs.existsSync(worklogPath)) {
    res.json({ exists: false, worklog: null });
    return;
  }

  try {
    const content = fs.readFileSync(worklogPath, "utf-8");
    const worklog = JSON.parse(content);
    res.json({ exists: true, worklog });
  } catch (err) {
    res.status(500).json({ error: `Failed to read worklog: ${(err as Error).message}` });
  }
});

// PUT /agents/:name/worklog - Save agent's worklog
router.put("/:name/worklog", (req: Request, res: Response) => {
  const { name } = req.params;
  const { worklog } = req.body as { worklog?: unknown };

  if (!worklog) {
    res.status(400).json({ error: "worklog is required" });
    return;
  }

  fs.mkdirSync(WORKLOG_DIR, { recursive: true });
  const worklogPath = path.join(WORKLOG_DIR, `${name}_worklog.json`);

  try {
    const content = JSON.stringify(worklog, null, 2);
    // Limit worklog size to 100KB
    if (content.length > 100 * 1024) {
      res.status(400).json({ error: "Worklog too large (max 100KB)" });
      return;
    }
    fs.writeFileSync(worklogPath, content, "utf-8");
    res.json({ ok: true, path: worklogPath });
  } catch (err) {
    res.status(500).json({ error: `Failed to save worklog: ${(err as Error).message}` });
  }
});

// --- Agent config: model and effort ---

const ALLOWED_MODELS = ["sonnet", "opus"] as const;
const ALLOWED_EFFORTS = ["medium", "high", "max"] as const;

export interface AgentConfig {
  model?: string;
  effort?: string;
}

/** Read agent config (model/effort) from metadata in DB */
export function getAgentConfig(agentName: string): AgentConfig {
  const db = getDb();
  const row = db.prepare("SELECT metadata FROM agents WHERE name = ?").get(agentName) as { metadata: string } | undefined;
  if (!row) return {};
  try {
    const meta = JSON.parse(row.metadata);
    return { model: meta.model, effort: meta.effort };
  } catch {
    return {};
  }
}

/** Build the claude CLI command with optional --model and --effort flags */
export function buildClaudeCmd(agentDir: string, claudePath: string, agentName: string): string {
  const config = getAgentConfig(agentName);
  let cmd = `unset CLAUDECODE && cd '${agentDir}' && '${claudePath}'`;
  if (config.model) cmd += ` --model ${config.model}`;
  if (config.effort) cmd += ` --effort ${config.effort}`;
  return cmd;
}

// PUT /agents/:name/config - Set model and effort (author only)
router.put("/:name/config", async (req: Request, res: Response) => {
  const { name } = req.params;
  const { model, effort, requested_by, restart } = req.body as {
    model?: string;
    effort?: string;
    requested_by?: string;
    restart?: boolean;
  };

  // Only author can change agent config
  if (requested_by !== "author") {
    res.status(403).json({ error: "Only the author agent can change agent configuration" });
    return;
  }

  // Validate model
  if (model !== undefined && !ALLOWED_MODELS.includes(model as typeof ALLOWED_MODELS[number])) {
    res.status(400).json({ error: `Invalid model. Allowed: ${ALLOWED_MODELS.join(", ")}` });
    return;
  }

  // Validate effort
  if (effort !== undefined && !ALLOWED_EFFORTS.includes(effort as typeof ALLOWED_EFFORTS[number])) {
    res.status(400).json({ error: `Invalid effort. Allowed: ${ALLOWED_EFFORTS.join(", ")}` });
    return;
  }

  const db = getDb();
  const existing = db.prepare("SELECT metadata FROM agents WHERE name = ?").get(name) as { metadata: string } | undefined;
  if (!existing) {
    res.status(404).json({ error: "agent not found" });
    return;
  }

  // Merge new config into existing metadata
  let meta: Record<string, unknown> = {};
  try { meta = JSON.parse(existing.metadata); } catch {}
  if (model !== undefined) meta.model = model;
  if (effort !== undefined) meta.effort = effort;

  db.prepare("UPDATE agents SET metadata = ? WHERE name = ?").run(JSON.stringify(meta), name);

  // Broadcast config change
  broadcast({
    type: "agent:config",
    data: { name, model: meta.model, effort: meta.effort },
  });

  // Optionally restart the agent to apply new config
  if (restart) {
    const session = `crew-${name}`;
    try {
      await execFileAsync("tmux", ["has-session", "-t", session]);
      await killAgentProcesses(name as string);
      await new Promise((r) => setTimeout(r, 2000));

      const claudePath = findClaudePath();
      if (claudePath) {
        const agentDir = path.join(AGENTS_DIR, name as string);
        if (fs.existsSync(agentDir)) {
          const cmd = buildClaudeCmd(agentDir, claudePath, name as string);
          await execFileAsync("tmux", ["new-session", "-d", "-s", session, cmd]);
        }
      }
    } catch { /* agent might not be running, config still saved */ }
  }

  res.json({ ok: true, name, model: meta.model, effort: meta.effort, restarted: !!restart });
});

// DELETE /agents/:name - Full cleanup: DB + tmux + bridge processes + workspace
router.delete("/:name", async (req: Request, res: Response) => {
  const { name } = req.params;
  const deleteWorkspace = req.query.workspace !== "false";

  // Kill tmux session and bridge processes
  await killAgentProcesses(name as string);

  // Delete from DB
  const db = getDb();
  db.prepare("DELETE FROM agents WHERE name = ?").run(name);
  db.prepare("DELETE FROM pending_mentions WHERE agent_name = ?").run(name);

  // Delete workspace if requested
  const agentDir = path.join(AGENTS_DIR, name as string);
  if (deleteWorkspace && fs.existsSync(agentDir)) {
    fs.rmSync(agentDir, { recursive: true, force: true });
  }

  broadcast({ type: "agent:status", data: { name, status: "removed" } });
  res.json({ ok: true, workspaceDeleted: deleteWorkspace && fs.existsSync(agentDir) === false });
});

export default router;
