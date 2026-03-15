import { Router, type Request, type Response } from "express";
import type { Router as RouterType } from "express";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { buildAgentWorkspaceEnv, syncAgentWorkspaceContext } from "../agent-context.js";
import { getDb, type AgentRow } from "../db/index.js";
import { broadcast } from "../ws/handler.js";
import { PROJECT_ROOT, WORKLOG_DIR, MCP_BRIDGE_PATH, MCP_TOOL_MEMORY_PATH } from "../config.js";
import { findBinary } from "../utils/find-binary.js";
import { getProjectById, getWorkplaceById } from "../storage-scope.js";
import {
  clearAgentMetadataKeys,
  DEFAULT_PROVIDER,
  getAgentRuntimeConfig,
  mergeAgentMetadata,
  getProvider,
  type AgentProvider,
  type ApprovalPolicy,
  type SandboxMode,
} from "../agent-runtime.js";
import { getProviderFor, getProviderByType } from "../providers/runtime.js";

const execFileAsync = promisify(execFile);
const AGENTS_DIR = path.join(PROJECT_ROOT, "agents");
const BRIDGE_PATH = MCP_BRIDGE_PATH;

const router: RouterType = Router();

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

// --- Helper: find node / claude binaries via shared utility ---
function findNodePath(): string {
  return findBinary("node");
}

function createClaudeInstructions(name: string, role: string): string {
  return `# Agent: ${name}
Role: ${role}

You are "${name}" in the Claude Crew multi-agent team.

## Message format
Messages from the group chat arrive in this format:
- Public channel: \`[sender in #channel-id]: message\\n(Reply using send_to_chat with channel="channel-id")\`
- DM: \`[sender in DM]: message\\n(Reply using send_to_chat with channel="dm-channel-id")\`
- Group: \`[sender in group "group-id"]: message\\n(Reply using send_to_chat with channel="group-id")\`

## How to respond (IMPORTANT)
1. **First**: call \`read_chat(channel="<channel-id>")\` to read recent conversation history and understand context
2. **Then**: do the work requested
3. **Finally**: call \`send_to_chat(message="...", channel="<channel-id>")\` to post your response back

CRITICAL: Always pass the \`channel\` parameter from the incoming message to both \`read_chat\` and \`send_to_chat\`. Never omit it.

## Available tools
### Communication
- \`send_to_chat(message, channel)\` - post a message to a channel (ALWAYS use this to reply)
- \`read_chat(channel, limit, after_id, query)\` - read recent messages or search by keyword
- \`search_chat(query, channel, limit)\` - search chat history by keyword for project context
- \`check_mentions\` - check for @mentions directed at you
- \`list_agents\` - see who else is online

### Shared files
- \`read_shared_file\` / \`write_shared_file\` / \`list_shared_files\` - shared team files

### Memory (persistent across sessions)
- \`memory_read\` / \`memory_write\` / \`memory_search\` - personal persistent memory
- \`memory_status\` - check memory usage

### Project context
- \`get_project_context\` - get current project info and assignment details
- \`tool_preflight\` - refresh tool operating memory after restart or tool changes
- \`tool_handbook\` - look up exact tool parameters, sequencing, and pitfalls
- \`reflect_on_task\` - submit reflection after completing work

## Workspace
- If you are a dedicated agent, your cwd IS the project directory (like Claude Code / Codex)
- If you are a global agent, your cwd is your own agent workspace
- Your agent workspace is always at the path in env var CLAUDE_CREW_AGENT_DIR
- \`.crew/current-project\` and \`.crew/current-workplace\` symlinks are in your agent workspace
- \`.crew/context.json\` in your agent workspace contains project/workplace metadata

## Collaborating with other agents
- Use \`@agent-name\` in your \`send_to_chat\` messages to request help from other agents
- Example: \`send_to_chat(message="@coder please implement the API endpoint I designed above", channel="project-my-project")\`
- Use \`list_agents\` to see who is available and their roles

## Rules
- ALWAYS reply via \`send_to_chat\` with the correct channel parameter
- ALWAYS read channel context with \`read_chat\` before responding to understand the conversation
- Keep chat messages concise, put detailed output in shared files if needed
- You can work on any files on this machine using standard tools
- Do NOT @mention yourself in messages
`;
}

function createCodexInstructions(name: string, role: string): string {
  return `# Agent: ${name}
Role: ${role}

You are "${name}" in the Claude Crew multi-agent team.

## Message format
Messages arrive as:
- Public: \`[sender in #channel-id]: message\\n(Reply using send_to_chat with channel="channel-id")\`
- DM: \`[sender in DM]: message\\n(Reply using send_to_chat with channel="dm-id")\`

## How to respond (IMPORTANT)
1. Call \`read_chat(channel="<channel-id>")\` to read recent conversation context
2. Do the work requested
3. Call \`send_to_chat(message="...", channel="<channel-id>")\` to reply

CRITICAL: Always pass the \`channel\` parameter from the incoming message.

## Available tools
- \`send_to_chat(message, channel)\` - reply to a channel
- \`read_chat(channel, limit, after_id)\` - read channel history for context
- \`check_mentions\` - check @mentions
- \`list_agents\` - see online agents
- \`read_shared_file\` / \`write_shared_file\` / \`list_shared_files\`
- \`memory_read\` / \`memory_write\` / \`memory_search\` / \`memory_status\`
- \`get_project_context\` - current project info
- \`save_worklog\` / \`load_worklog\`
- \`tool_preflight\` - refresh tool operating memory after restart or tool changes
- \`tool_handbook\` - look up exact tool parameters, sequencing, and pitfalls

## Workspace pointers
- \`.crew/current-project\` - canonical project root
- \`.crew/current-workplace\` - active workplace for outputs
- \`.crew/context.json\` - project/workplace metadata

## Rules
- ALWAYS reply via \`send_to_chat\` with the correct channel
- ALWAYS read context with \`read_chat\` before responding
- Keep messages concise, put large output in shared files
- Do NOT @mention yourself
`;
}

function createCodexConfigToml(name: string, role: string): string {
  const nodePath = findNodePath();
  return `model = "gpt-5.4"
model_reasoning_effort = "high"

[mcp_servers.claude_crew]
command = "${nodePath.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"
args = ["${BRIDGE_PATH.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}", "${name.replaceAll("\"", "\\\"")}", "${role.replaceAll("\"", "\\\"")}"]
`;
}

// --- Helper: create workspace ---
function createWorkspace(name: string, role: string, provider: AgentProvider): void {
  const agentDir = path.join(AGENTS_DIR, name);
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(path.join(agentDir, ".crew"), { recursive: true });

  if (provider === "codex") {
    fs.mkdirSync(path.join(agentDir, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(agentDir, ".codex/config.toml"), createCodexConfigToml(name, role));
    fs.writeFileSync(path.join(agentDir, "AGENTS.md"), createCodexInstructions(name, role));
    syncAgentWorkspaceContext(name);
    return;
  }

  const nodePath = findNodePath();
  const mcpConfig = {
    mcpServers: {
      "claude-crew": {
        command: nodePath,
        args: [BRIDGE_PATH, name, role],
      },
    },
  };
  fs.writeFileSync(path.join(agentDir, ".mcp.json"), JSON.stringify(mcpConfig, null, 2) + "\n");
  fs.writeFileSync(path.join(agentDir, "CLAUDE.md"), createClaudeInstructions(name, role));
  syncAgentWorkspaceContext(name);
}

// --- Helper: stop agent runtime via provider ---
async function killAgentProcesses(name: string): Promise<void> {
  try {
    await getProviderFor(name).stop(name);
  } catch {
    // Provider may not be registered or agent may not be running
  }
}

function getClaudeSettingsPath(agentDir: string): string {
  return path.join(agentDir, ".claude", "settings.local.json");
}

function computeClaudeBridgeFingerprint(agentDir: string): string {
  const hasher = createHash("sha256");
  const inputs = [
    BRIDGE_PATH,
    MCP_TOOL_MEMORY_PATH,
    path.join(agentDir, ".mcp.json"),
    getClaudeSettingsPath(agentDir),
  ];
  for (const input of inputs) {
    hasher.update(`FILE:${path.basename(input)}:`);
    if (fs.existsSync(input)) {
      hasher.update(fs.readFileSync(input));
    } else {
      hasher.update("MISSING");
    }
  }
  return hasher.digest("hex").slice(0, 16);
}

function buildClaudeLaunchSpec(
  agentDir: string,
  claudePath: string,
  agentName: string,
  options?: { forceNewSession?: boolean },
): ClaudeLaunchSpec {
  const config = getAgentRuntimeConfig(agentName);
  const env = buildAgentWorkspaceEnv(agentName);
  const exports = Object.entries(env)
    .map(([key, value]) => `${key}='${value.replace(/'/g, "'\\''")}'`)
    .join(" ");
  const mcpConfigPath = `${agentDir}/.mcp.json`;
  const settingsPath = getClaudeSettingsPath(agentDir);
  const bridgeFingerprint = computeClaudeBridgeFingerprint(agentDir);
  const fingerprintChanged = config.claudeBridgeFingerprint !== bridgeFingerprint;
  const forceNewSession = !!options?.forceNewSession || fingerprintChanged || !config.claudeSessionId;
  const sessionId = forceNewSession ? randomUUID() : (config.claudeSessionId as string);

  mergeAgentMetadata(agentName, {
    claudeSessionId: sessionId,
    claudeBridgeFingerprint: bridgeFingerprint,
    claudeSettingsPath: fs.existsSync(settingsPath) ? settingsPath : null,
  });

  // Determine cwd and system prompt based on assignment type
  const db = getDb();
  const assignment = db.prepare(`
    SELECT pa.assignment_type, p.directory
    FROM project_agents pa
    JOIN projects p ON p.id = pa.project_id
    WHERE pa.agent_name = ? AND pa.status = 'active' AND p.status = 'active'
    ORDER BY pa.assigned_at DESC LIMIT 1
  `).get(agentName) as { assignment_type: string; directory: string } | undefined;

  const isDedicated = assignment?.assignment_type === "dedicated" && assignment?.directory;
  const cwd = isDedicated ? assignment.directory : agentDir;

  let cmd = `unset CLAUDECODE && export ${exports} && cd '${cwd}' && '${claudePath}' --mcp-config '${mcpConfigPath}' --strict-mcp-config --setting-sources user --session-id ${sessionId}`;
  if (fs.existsSync(settingsPath)) {
    cmd += ` --settings '${settingsPath}'`;
  }
  if (config.model) cmd += ` --model ${config.model}`;
  if (config.effort) cmd += ` --effort ${config.effort}`;

  // Build --append-system-prompt content
  let systemPrompt = "";

  if (isDedicated) {
    const agentClaudeMdPath = path.join(agentDir, "CLAUDE.md");
    if (fs.existsSync(agentClaudeMdPath)) {
      systemPrompt += fs.readFileSync(agentClaudeMdPath, "utf-8");
    }
    const projectContext = getAgentProjectContext(agentName);
    if (projectContext) {
      const runtimeGuard = buildRuntimeProjectGuard(projectContext);
      if (runtimeGuard) {
        systemPrompt += (systemPrompt ? "\n\n" : "") + runtimeGuard;
      }
      const workspaceInfo = extractWorkspaceInfo(projectContext);
      if (workspaceInfo) {
        systemPrompt += (systemPrompt ? "\n\n" : "") + workspaceInfo;
      }
    }
  } else {
    const projectContext = getAgentProjectContext(agentName);
    if (projectContext) {
      systemPrompt = projectContext;
    }
  }

  if (systemPrompt) {
    const escaped = systemPrompt.replace(/'/g, "'\\''");
    cmd += ` --append-system-prompt '${escaped}'`;
  }

  return {
    cmd,
    sessionId,
    bridgeFingerprint,
    settingsPath: fs.existsSync(settingsPath) ? settingsPath : null,
    forceNewSession,
  };
}

async function getTmuxPanePid(session: string): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync("tmux", ["list-panes", "-t", session, "-F", "#{pane_pid}"]);
    const pid = parseInt(stdout.trim().split("\n")[0] || "", 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

async function getProcessCommand(pid: number): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "command="]);
    const text = stdout.trim();
    return text || null;
  } catch {
    return null;
  }
}

async function getProcessStartTime(pid: number): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "lstart="]);
    const text = stdout.trim();
    return text || null;
  } catch {
    return null;
  }
}

export async function startVerifiedClaudeSession(
  agentDir: string,
  claudePath: string,
  agentName: string,
  options?: { forceNewSession?: boolean; previousPanePid?: number | null },
): Promise<ClaudeRuntimeVerification> {
  const session = `crew-${agentName}`;
  const spec = buildClaudeLaunchSpec(agentDir, claudePath, agentName, options);
  await execFileAsync("tmux", ["new-session", "-d", "-s", session, spec.cmd]);

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const panePid = await getTmuxPanePid(session);
    if (panePid && (!options?.previousPanePid || panePid !== options.previousPanePid)) {
      const processCommand = await getProcessCommand(panePid);
      if (processCommand && processCommand.includes("claude")) {
        const processStartedAt = await getProcessStartTime(panePid);
        return {
          session,
          panePid,
          processCommand,
          processStartedAt: processStartedAt || "",
          sessionId: spec.sessionId,
          bridgeFingerprint: spec.bridgeFingerprint,
          settingsPath: spec.settingsPath,
          forceNewSession: spec.forceNewSession,
          command: spec.cmd,
        };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(`Claude session for ${agentName} did not become healthy in time`);
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
  const provider = getProvider(name);

  const existing = db
    .prepare("SELECT id FROM agents WHERE name = ?")
    .get(name) as AgentRow | undefined;

  if (existing) {
    db.prepare(
      "UPDATE agents SET status = 'online', role = ?, last_heartbeat = ? WHERE name = ?"
    ).run(role || "", now, name);
    broadcast({ type: "agent:status", data: { name, status: "online", role: role || "", provider } });
    res.json({ id: existing.id, name, status: "online" });
    return;
  }

  const id = randomUUID();
  db.prepare(
    "INSERT INTO agents (id, name, provider, role, status, last_heartbeat, registered_at) VALUES (?, ?, ?, ?, 'online', ?, ?)"
  ).run(id, name, provider, role || "", now, now);

  broadcast({ type: "agent:status", data: { name, status: "online", role: role || "", provider } });
  res.json({ id, name, status: "online" });
});

// POST /agents/create - Create workspace + register + optionally wake
router.post("/create", async (req: Request, res: Response) => {
  const { name, role, wake, provider, instructions, requested_by, permissions } = req.body as {
    name?: string;
    role?: string;
    wake?: boolean;
    provider?: AgentProvider;
    instructions?: string;
    requested_by?: string;
    permissions?: string[];
  };

  // When called by an agent (requested_by present), only author is allowed
  if (requested_by && requested_by !== "author") {
    res.status(403).json({ error: "Only the author agent can create agents" });
    return;
  }
  if (!name || typeof name !== "string") {
    res.status(400).json({ error: "name is required" });
    return;
  }

  // Validate name (alphanumeric + hyphens only)
  if (!/^[\w][\w-]*$/.test(name)) {
    res.status(400).json({ error: "Invalid agent name. Use letters, numbers, hyphens only." });
    return;
  }

  if (requested_by === "author" && name === "integrator") {
    res.status(403).json({ error: "Integrator is protected and cannot be recreated or overwritten by the author agent" });
    return;
  }

  const agentDir = path.join(AGENTS_DIR, name);
  const agentRole = role || "";
  const agentProvider: AgentProvider = provider === "codex" ? "codex" : DEFAULT_PROVIDER;

  // Check if bridge is built
  if (!fs.existsSync(BRIDGE_PATH)) {
    res.status(500).json({ error: "MCP bridge not built. Run 'crew build' first." });
    return;
  }

  // Create workspace
  try {
    createWorkspace(name, agentRole, agentProvider);
  } catch (err) {
    res.status(500).json({ error: `Failed to create workspace: ${(err as Error).message}` });
    return;
  }

  if (agentProvider !== "codex") {
    // Overwrite CLAUDE.md with custom instructions if provided.
    if (instructions) {
      fs.writeFileSync(path.join(agentDir, "CLAUDE.md"), instructions);
    }

    // Generate default settings.local.json with standard MCP tool permissions.
    const settingsDir = path.join(agentDir, ".claude");
    if (!fs.existsSync(path.join(settingsDir, "settings.local.json"))) {
      fs.mkdirSync(settingsDir, { recursive: true });
      const defaultPerms = permissions || [
        "mcp__claude-crew__send_to_chat",
        "mcp__claude-crew__read_chat",
        "mcp__claude-crew__check_mentions",
        "mcp__claude-crew__list_agents",
        "mcp__claude-crew__read_shared_file",
        "mcp__claude-crew__write_shared_file",
        "mcp__claude-crew__list_shared_files",
        "mcp__claude-crew__save_worklog",
        "mcp__claude-crew__load_worklog",
        "mcp__claude-crew__tool_preflight",
        "mcp__claude-crew__tool_handbook",
        "mcp__claude-crew__search_chat",
        "mcp__claude-crew__get_shared_file_meta",
      ];
      const settings = {
        permissions: {
          allow: defaultPerms,
          disallowedTools: ["MCPSearch"],
        },
        enableAllProjectMcpServers: true,
        enabledMcpjsonServers: ["claude-crew"],
      };
      fs.writeFileSync(path.join(settingsDir, "settings.local.json"), JSON.stringify(settings, null, 2) + "\n");
    }
  }

  // Register in DB
  const db = getDb();
  const now = Date.now();
  const existing = db.prepare("SELECT id FROM agents WHERE name = ?").get(name) as AgentRow | undefined;
  let agentId: string;

  if (existing) {
    db.prepare("UPDATE agents SET provider = ?, role = ?, status = 'offline' WHERE name = ?").run(agentProvider, agentRole, name);
    agentId = existing.id;
  } else {
    agentId = randomUUID();
    db.prepare(
      "INSERT INTO agents (id, name, provider, role, status, last_heartbeat, registered_at) VALUES (?, ?, ?, ?, 'offline', ?, ?)"
    ).run(agentId, name, agentProvider, agentRole, now, now);
  }

  syncAgentWorkspaceContext(name);

  broadcast({ type: "agent:status", data: { name, status: "offline", role: agentRole, provider: agentProvider } });

  // Optionally wake (start provider runtime)
  if (wake) {
    try {
      await getProviderFor(name).start(name);
      res.json({ ok: true, id: agentId, name, provider: agentProvider, workspace: agentDir, woke: true });
    } catch (err) {
      res.status(500).json({
        ok: false,
        id: agentId,
        name,
        provider: agentProvider,
        workspace: agentDir,
        woke: false,
        wakeError: (err as Error).message,
      });
    }
  } else {
    res.json({ ok: true, id: agentId, name, provider: agentProvider, workspace: agentDir });
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
  broadcast({ type: "agent:status", data: { name, status: "offline", provider: getProvider(name) } });
  res.json({ ok: true });
});

// GET /agents
router.get("/", (req: Request, res: Response) => {
  const project_id = req.query.project_id as string | undefined;
  const db = getDb();

  let agents: AgentRow[];
  if (project_id) {
    agents = db.prepare(`
      SELECT a.id, a.name, a.provider, a.role, a.status, a.last_heartbeat, a.registered_at, a.metadata
      FROM agents a
      INNER JOIN project_agents pa ON pa.agent_name = a.name
      WHERE pa.project_id = ? AND pa.status = 'active'
      ORDER BY a.name
    `).all(project_id) as AgentRow[];
  } else {
    agents = db
      .prepare("SELECT id, name, provider, role, status, last_heartbeat, registered_at, metadata FROM agents ORDER BY name")
      .all() as AgentRow[];
  }

  const result = agents.map((a) => {
    const p = getProviderByType(a.provider as AgentProvider);
    return {
      ...a,
      tmuxState: p ? p.getState(a.name) : "no_session",
      contextPercent: p ? p.getContextPercent(a.name) : 0,
    };
  });
  res.json(result);
});

// GET /agents/:name/terminal - Get current terminal content for an agent
router.get("/:name/terminal", (_req: Request, res: Response) => {
  const { name } = _req.params;
  const content = getProviderFor(name as string).getTerminalContent(name as string);
  res.json({ name, content });
});

// POST /agents/:name/terminal/input - Send input to agent's runtime
router.post("/:name/terminal/input", async (req: Request, res: Response) => {
  const { name } = req.params;
  const { input, type } = req.body as { input?: string; type?: string };
  if (!input && input !== "") {
    res.status(400).json({ error: "input is required" });
    return;
  }

  try {
    await getProviderFor(name as string).sendInput(name as string, input, type);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: `Failed to send input: ${(err as Error).message}` });
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

const ALLOWED_CLAUDE_MODELS = ["sonnet", "opus"] as const;
const ALLOWED_EFFORTS = ["medium", "high", "max"] as const;
const ALLOWED_APPROVAL_POLICIES: ApprovalPolicy[] = ["untrusted", "on-request", "never"];
const ALLOWED_SANDBOX_MODES: SandboxMode[] = ["read-only", "workspace-write", "danger-full-access"];

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

/** Get the current project context string for an agent (if assigned to a project) */
export function getAgentProjectContext(agentName: string): string | null {
  const db = getDb();
  // Check if agent is assigned to any active project
  const assignment = db.prepare(`
    SELECT pa.project_id, pa.active_workplace_id, p.name, p.description, p.tech_stack, p.directory
    FROM project_agents pa
    JOIN projects p ON p.id = pa.project_id
    WHERE pa.agent_name = ? AND pa.status = 'active' AND p.status = 'active'
    ORDER BY pa.assigned_at DESC LIMIT 1
  `).get(agentName) as {
    project_id: string;
    active_workplace_id: string | null;
    name: string;
    description: string;
    tech_stack: string;
    directory: string;
  } | undefined;

  if (!assignment) return null;

  const techStack = JSON.parse(assignment.tech_stack) as string[];
  const standards = db
    .prepare("SELECT name, content FROM shared_standards WHERE status = 'active' ORDER BY priority DESC")
    .all() as { name: string; content: string }[];

  const agents = db
    .prepare("SELECT agent_name, role_in_project FROM project_agents WHERE project_id = ? AND status = 'active'")
    .all(assignment.project_id) as { agent_name: string; role_in_project: string }[];
  const project = getProjectById(assignment.project_id);
  const activeWorkplace = assignment.active_workplace_id ? getWorkplaceById(assignment.active_workplace_id) : null;

  let ctx = `## Active Project: ${assignment.name}\n${assignment.description}\n`;
  if (techStack.length > 0) ctx += `### Tech Stack: ${techStack.join(", ")}\n`;
  if (project?.directory) {
    ctx += `### Canonical Project Root: ${project.directory}\n`;
    ctx += `Store durable code/specs/reference docs and permanent decision memory here.\n`;
  }
  if (activeWorkplace) {
    ctx += `### Active Workplace: ${activeWorkplace.name}\n`;
    ctx += `Directory: ${activeWorkplace.directory}\n`;
    ctx += `Use this workplace for uploads, experiments, revisions, generated outputs, and other derived artifacts.\n`;
  }
  ctx += "### Stable Workspace Pointers: ./.crew/current-project, ./.crew/current-workplace, ./.crew/context.json\n";
  if (standards.length > 0) {
    ctx += `### Standards:\n`;
    for (const s of standards) ctx += `- **${s.name}**: ${s.content}\n`;
  }
  if (agents.length > 0) {
    ctx += `### Team: ${agents.map(a => `${a.agent_name}${a.role_in_project ? ` (${a.role_in_project})` : ""}`).join(", ")}\n`;
    ctx += "Only collaborate with agents listed in this team for project work. If the team may have changed, refresh with get_project_context or list_agents before routing work.\n";
  }

  // Enforce size budget (~3000 tokens ~ 12000 chars)
  if (ctx.length > 12000) {
    ctx = ctx.slice(0, 11900) + "\n...(truncated, call get_project_context for full details)";
  }
  return ctx;
}

/** Build the claude CLI command with optional --model, --effort, and --append-system-prompt flags */
export function buildClaudeCmd(agentDir: string, claudePath: string, agentName: string): string {
  return buildClaudeLaunchSpec(agentDir, claudePath, agentName).cmd;
}

/**
 * Extract workspace-specific info from project context that is not in project CLAUDE.md.
 * Project CLAUDE.md already covers: name, description, tech stack, team, standards.
 * This extracts: workplace directory, workspace pointers.
 */
function extractWorkspaceInfo(projectContext: string): string {
  const lines = projectContext.split("\n");
  const relevant: string[] = [];
  let capturing = false;

  for (const line of lines) {
    if (line.startsWith("### Active Workplace:") ||
        line.startsWith("Directory:") ||
        line.startsWith("Use this workplace") ||
        line.startsWith("### Stable Workspace Pointers:")) {
      relevant.push(line);
      capturing = true;
    } else if (capturing && line.startsWith("###")) {
      capturing = false;
    }
  }

  return relevant.length > 0 ? relevant.join("\n") : "";
}

function buildRuntimeProjectGuard(projectContext: string): string {
  const lines = projectContext.split("\n");
  const relevant: string[] = [
    "## Runtime Project Guard",
    "You are currently working inside a Claude Crew project assignment.",
    "Only route project work to agents listed in the current project team below.",
    "If the team may have changed, call get_project_context or list_agents before delegating.",
  ];

  for (const line of lines) {
    if (line.startsWith("## Active Project:") || line.startsWith("### Team:")) {
      relevant.push(line);
    }
  }

  return relevant.join("\n");
}

// PUT /agents/:name/instructions - Update agent CLAUDE.md (author only)
router.put("/:name/instructions", (req: Request, res: Response) => {
  const { name } = req.params;
  const { instructions, requested_by } = req.body as {
    instructions?: string;
    requested_by?: string;
  };

  if (requested_by !== "author") {
    res.status(403).json({ error: "Only the author agent can update agent instructions" });
    return;
  }

  if (!instructions || typeof instructions !== "string") {
    res.status(400).json({ error: "instructions is required" });
    return;
  }

  // Integrator is protected from author modifications
  if (name === "integrator") {
    res.status(403).json({ error: "Integrator's instructions are protected and cannot be modified by the author agent" });
    return;
  }

  const agentDir = path.join(AGENTS_DIR, name as string);
  if (!fs.existsSync(agentDir)) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }

  const provider = getProvider(name as string);
  if (provider === "codex") {
    res.status(400).json({ error: "Cannot update CLAUDE.md for codex agents. Use AGENTS.md instead." });
    return;
  }

  fs.writeFileSync(path.join(agentDir, "CLAUDE.md"), instructions);
  res.json({ ok: true, name });
});

// PUT /agents/:name/config - Set model and effort (author only)
router.put("/:name/config", async (req: Request, res: Response) => {
  const { name } = req.params;
  const { model, effort, approval_policy, sandbox_mode, requested_by, restart } = req.body as {
    model?: string;
    effort?: string;
    approval_policy?: ApprovalPolicy;
    sandbox_mode?: SandboxMode;
    requested_by?: string;
    restart?: boolean;
  };
  const provider = getProvider(name as string);

  // Only author can change agent config
  if (requested_by !== "author") {
    res.status(403).json({ error: "Only the author agent can change agent configuration" });
    return;
  }

  // Integrator is protected from author modifications
  if (name === "integrator") {
    res.status(403).json({ error: "Integrator's configuration is protected and cannot be modified by the author agent" });
    return;
  }

  // Validate model
  if (provider === "claude" && model !== undefined && !ALLOWED_CLAUDE_MODELS.includes(model as typeof ALLOWED_CLAUDE_MODELS[number])) {
    res.status(400).json({ error: `Invalid model. Allowed: ${ALLOWED_CLAUDE_MODELS.join(", ")}` });
    return;
  }

  // Validate effort
  if (effort !== undefined && !ALLOWED_EFFORTS.includes(effort as typeof ALLOWED_EFFORTS[number])) {
    res.status(400).json({ error: `Invalid effort. Allowed: ${ALLOWED_EFFORTS.join(", ")}` });
    return;
  }
  if (approval_policy !== undefined && !ALLOWED_APPROVAL_POLICIES.includes(approval_policy)) {
    res.status(400).json({ error: `Invalid approval_policy. Allowed: ${ALLOWED_APPROVAL_POLICIES.join(", ")}` });
    return;
  }
  if (sandbox_mode !== undefined && !ALLOWED_SANDBOX_MODES.includes(sandbox_mode)) {
    res.status(400).json({ error: `Invalid sandbox_mode. Allowed: ${ALLOWED_SANDBOX_MODES.join(", ")}` });
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
  if (approval_policy !== undefined) meta.approvalPolicy = approval_policy;
  if (sandbox_mode !== undefined) meta.sandboxMode = sandbox_mode;

  db.prepare("UPDATE agents SET metadata = ? WHERE name = ?").run(JSON.stringify(meta), name);

  // Broadcast config change
  broadcast({
    type: "agent:config",
    data: {
      name,
      provider,
      model: meta.model,
      effort: meta.effort,
      approvalPolicy: meta.approvalPolicy,
      sandboxMode: meta.sandboxMode,
    },
  });

  // Optionally restart the agent to apply new config
  if (restart) {
    try {
      await getProviderFor(name as string).restart(name as string);
    } catch {
      // Agent might not be running; config still saved.
    }
  }

  res.json({
    ok: true,
    name,
    provider,
    model: meta.model,
    effort: meta.effort,
    approvalPolicy: meta.approvalPolicy,
    sandboxMode: meta.sandboxMode,
    restarted: !!restart,
  });
});

router.get("/:name/runtime-status", (req: Request, res: Response) => {
  const { name } = req.params;
  const provider = getProvider(name as string);
  const p = getProviderFor(name as string);
  const config = getAgentRuntimeConfig(name as string);

  res.json({
    name,
    provider,
    runtimeState: p.getState(name as string),
    contextPercent: p.getContextPercent(name as string),
    config,
  });
});

async function authorOnlyAction(req: Request, res: Response, action: () => Promise<boolean>): Promise<void> {
  const { requested_by } = req.body as { requested_by?: string };
  if (requested_by !== "author") {
    res.status(403).json({ error: "Only the author agent can control agent runtime" });
    return;
  }

  // Integrator is protected from author runtime control
  const agentName = req.params.name;
  if (agentName === "integrator") {
    res.status(403).json({ error: "Integrator's runtime is protected and cannot be controlled by the author agent" });
    return;
  }

  try {
    const ok = await action();
    res.json({ ok });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}

router.post("/:name/restart", async (req: Request, res: Response) => {
  const { name } = req.params;
  await authorOnlyAction(req, res, async () => {
    await getProviderFor(name as string).restart(name as string);
    return true;
  });
});

router.post("/:name/interrupt", async (req: Request, res: Response) => {
  const { name } = req.params;
  await authorOnlyAction(req, res, async () => {
    return getProviderFor(name as string).interrupt(name as string);
  });
});

router.post("/:name/resume", async (req: Request, res: Response) => {
  const { name } = req.params;
  await authorOnlyAction(req, res, async () => {
    return getProviderFor(name as string).resume(name as string);
  });
});

router.post("/:name/reset-session", async (req: Request, res: Response) => {
  const { name } = req.params;
  await authorOnlyAction(req, res, async () => {
    clearAgentMetadataKeys(name as string, ["threadId"]);
    await getProviderFor(name as string).restart(name as string, { resetSession: true });
    return true;
  });
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
