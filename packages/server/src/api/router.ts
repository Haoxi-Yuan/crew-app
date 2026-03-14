import { Router, type Request, type Response } from "express";
import type { Router as RouterType } from "express";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import agentsRouter, { startVerifiedClaudeSession } from "./agents.js";
import messagesRouter from "./messages.js";
import sharedFilesRouter from "./shared-files.js";
import importRouter from "./import.js";
import channelsRouter from "./channels.js";
import approvalsRouter from "./approvals.js";
import memoryRouter from "./memory.js";
import projectsRouter from "./projects.js";
import standardsRouter from "./standards.js";
import reflectionsRouter from "./reflections.js";
import peaksRouter from "./peaks.js";
import { getDb, type PendingMentionRow, type MessageRow } from "../db/index.js";
import { PROJECT_ROOT } from "../config.js";
import { DEFAULT_PROVIDER, getProvider } from "../agent-runtime.js";
import { startCodexAgent, stopCodexAgent } from "../providers/codex.js";
import { broadcast } from "../ws/handler.js";

const router: RouterType = Router();
const execFileAsync = promisify(execFile);

router.use("/agents", agentsRouter);
router.use("/messages", messagesRouter);
router.use("/channels", channelsRouter);
router.use("/shared-files", sharedFilesRouter);
router.use("/import", importRouter);
router.use("/approvals", approvalsRouter);
router.use("/memory", memoryRouter);
router.use("/projects", projectsRouter);
router.use("/standards", standardsRouter);
router.use("/reflections", reflectionsRouter);
router.use("/peaks", peaksRouter);

router.get("/mentions/:agentName", (req: Request, res: Response) => {
  const { agentName } = req.params;
  const db = getDb();

  const pending = db
    .prepare(
      `SELECT pm.id, pm.message_id, pm.agent_name, pm.created_at,
              m.sender_type, m.sender_name, m.content, m.message_type, m.created_at as msg_created_at
       FROM pending_mentions pm
       JOIN messages m ON m.id = pm.message_id
       WHERE pm.agent_name = ? AND pm.acknowledged = 0
       ORDER BY pm.created_at ASC`
    )
    .all(agentName) as (PendingMentionRow & {
    sender_type: string;
    sender_name: string;
    content: string;
    message_type: string;
    msg_created_at: number;
  })[];

  res.json(
    pending.map((p) => ({
      mention_id: p.id,
      message_id: p.message_id,
      sender_type: p.sender_type,
      sender_name: p.sender_name,
      content: p.content,
      message_type: p.message_type,
      created_at: p.msg_created_at,
    }))
  );
});

router.post("/mentions/:id/ack", (req: Request, res: Response) => {
  const rawId = req.params.id;
  const mentionId = parseInt(typeof rawId === "string" ? rawId : String(rawId));
  if (isNaN(mentionId)) {
    res.status(400).json({ error: "invalid mention id" });
    return;
  }

  const db = getDb();
  db.prepare("UPDATE pending_mentions SET acknowledged = 1 WHERE id = ?").run(
    mentionId
  );
  res.json({ ok: true });
});

function findClaudePath(): string {
  try { return execFileSync("which", ["claude"]).toString().trim(); } catch {}
  const candidates = [
    path.join(process.env.HOME || "", ".nvm/versions/node"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  ];
  for (const c of candidates) {
    if (c.includes("nvm")) {
      try {
        const dirs = fs.readdirSync(c);
        for (const d of dirs) {
          const p = path.join(c, d, "bin/claude");
          if (fs.existsSync(p)) return p;
        }
      } catch {}
    } else if (fs.existsSync(c)) {
      return c;
    }
  }
  return "";
}

async function startAgentRuntime(
  name: string,
  options?: { forceNewSession?: boolean },
): Promise<{
  ok: boolean;
  name: string;
  provider: string;
  message?: string;
  verification?: {
    session: string;
    panePid: number;
    processCommand: string;
    processStartedAt: string;
    sessionId: string;
    bridgeFingerprint: string;
    settingsPath: string | null;
    forceNewSession: boolean;
    command: string;
  };
}> {
  const agentsDir = path.join(PROJECT_ROOT, "agents");
  const agentDir = path.join(agentsDir, name);
  const session = `crew-${name}`;

  if (!fs.existsSync(agentDir)) {
    throw new Error(`Agent workspace not found: ${name}. Use 'crew add ${name} <role>' first.`);
  }

  const provider = getProvider(name);
  if (provider === "codex") {
    await startCodexAgent(name);
    return { ok: true, name, provider };
  }

  try {
    await execFileAsync("tmux", ["has-session", "-t", session]);
    return { ok: true, name, provider, message: "already running" };
  } catch {}

  const claudePath = findClaudePath();
  if (!claudePath) {
    throw new Error("Claude Code CLI not found");
  }

  const verification = await startVerifiedClaudeSession(agentDir, claudePath, name, {
    forceNewSession: options?.forceNewSession,
  });
  return { ok: true, name, provider, verification };
}

async function stopAgentRuntime(name: string): Promise<{ ok: boolean; name: string; provider: string; stopped: boolean }> {
  const provider = getProvider(name);

  if (provider === "codex") {
    await stopCodexAgent(name);
    return { ok: true, name, provider, stopped: true };
  }

  const session = `crew-${name}`;
  try {
    await execFileAsync("tmux", ["has-session", "-t", session]);
  } catch {
    return { ok: true, name, provider, stopped: false };
  }

  await execFileAsync("tmux", ["kill-session", "-t", session]);
  const db = getDb();
  db.prepare("UPDATE agents SET status = 'offline' WHERE name = ?").run(name);
  broadcast({ type: "agent:status", data: { name, status: "offline", provider } });
  return { ok: true, name, provider, stopped: true };
}

// Wake agent: start provider runtime
router.post("/wake", async (req: Request, res: Response) => {
  const { name } = req.body as { name?: string };
  if (!name) {
    res.status(400).json({ error: "name is required" });
    return;
  }

  try {
    const result = await startAgentRuntime(name);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: `Failed to wake agent: ${(err as Error).message}` });
  }
});

router.post("/agents/:name/system-stop", async (req: Request, res: Response) => {
  const name = typeof req.params.name === "string" ? req.params.name : String(req.params.name);
  try {
    const result = await stopAgentRuntime(name);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: `Failed to stop agent: ${(err as Error).message}` });
  }
});

router.post("/agents/:name/system-restart", async (req: Request, res: Response) => {
  const name = typeof req.params.name === "string" ? req.params.name : String(req.params.name);
  try {
    await stopAgentRuntime(name);
    const result = await startAgentRuntime(name, { forceNewSession: true });
    res.json({ ...result, restarted: true });
  } catch (err) {
    res.status(500).json({ error: `Failed to restart agent: ${(err as Error).message}` });
  }
});

// Wake all agents
router.post("/wake-all", (_req: Request, res: Response) => {
  const agentsDir = path.join(PROJECT_ROOT, "agents");

  if (!fs.existsSync(agentsDir)) {
    res.status(404).json({ error: "No agents directory found" });
    return;
  }

  const agentNames = fs.readdirSync(agentsDir).filter((f) =>
    fs.statSync(path.join(agentsDir, f)).isDirectory()
  );

  if (agentNames.length === 0) {
    res.status(404).json({ error: "No agents found" });
    return;
  }

  let launched = 0;
  let skipped = 0;
  let remaining = agentNames.length;

  let claudePath = "";

  for (const name of agentNames) {
    const agentDir = path.join(agentsDir, name);
    const session = `crew-${name}`;
    const provider = getProvider(name);

    if (provider === "codex") {
      startCodexAgent(name)
        .then(() => {
          launched++;
          remaining--;
          if (remaining === 0) res.json({ ok: true, launched, skipped });
        })
        .catch(() => {
          remaining--;
          if (remaining === 0) res.json({ ok: true, launched, skipped });
        });
      continue;
    }

    if (!claudePath) {
      try { claudePath = execFileSync("which", ["claude"]).toString().trim(); } catch {}
      if (!claudePath) {
        const nvmDir = path.join(process.env.HOME || "", ".nvm/versions/node");
        try {
          for (const d of fs.readdirSync(nvmDir)) {
            const p = path.join(nvmDir, d, "bin/claude");
            if (fs.existsSync(p)) { claudePath = p; break; }
          }
        } catch {}
      }
    }

    execFile("tmux", ["has-session", "-t", session], (checkErr) => {
      if (!checkErr) {
        skipped++;
        remaining--;
        if (remaining === 0) res.json({ ok: true, launched, skipped });
        return;
      }
      startVerifiedClaudeSession(agentDir, claudePath, name)
        .then(() => {
          launched++;
          remaining--;
          if (remaining === 0) res.json({ ok: true, launched, skipped });
        })
        .catch(() => {
          remaining--;
          if (remaining === 0) res.json({ ok: true, launched, skipped });
        });
    });
  }
});

// List agent workspaces
router.get("/workspaces", (_req: Request, res: Response) => {
  const agentsDir = path.join(PROJECT_ROOT, "agents");

  if (!fs.existsSync(agentsDir)) {
    res.json([]);
    return;
  }

  const agents = fs.readdirSync(agentsDir).filter((f) =>
    fs.statSync(path.join(agentsDir, f)).isDirectory()
  );

  const result = agents.map((name) => {
    const mcpPath = path.join(agentsDir, name, ".mcp.json");
    const provider = fs.existsSync(path.join(agentsDir, name, ".codex/config.toml")) ? "codex" : DEFAULT_PROVIDER;
    let role = "";
    if (provider === "codex") {
      const agentsMd = path.join(agentsDir, name, "AGENTS.md");
      try {
        const content = fs.readFileSync(agentsMd, "utf-8");
        const match = content.match(/^Role:\s*(.+)$/m);
        if (match) role = match[1].trim();
      } catch {}
    } else {
      try {
        const mcp = JSON.parse(fs.readFileSync(mcpPath, "utf-8"));
        const args = mcp.mcpServers?.["claude-crew"]?.args;
        if (Array.isArray(args) && args.length > 2) role = args[args.length - 1];
      } catch {}
    }
    return { name, provider, role, workspace: path.join(agentsDir, name) };
  });

  res.json(result);
});

// Pick directory via native OS dialog
router.get("/system/pick-directory", (_req: Request, res: Response) => {
  const platform = process.platform;
  if (platform === "darwin") {
    execFile("osascript", ["-e", 'POSIX path of (choose folder with prompt "Select project directory")'], (err, stdout) => {
      if (err) {
        // User cancelled or osascript error
        res.json({ directory: null });
        return;
      }
      const dir = stdout.trim().replace(/\/$/, "");
      res.json({ directory: dir || null });
    });
  } else if (platform === "linux") {
    execFile("zenity", ["--file-selection", "--directory", "--title=Select project directory"], (err, stdout) => {
      if (err) {
        res.json({ directory: null });
        return;
      }
      res.json({ directory: stdout.trim() || null });
    });
  } else {
    // Windows: PowerShell folder browser
    const psScript = `Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.FolderBrowserDialog; $f.Description = 'Select project directory'; if ($f.ShowDialog() -eq 'OK') { $f.SelectedPath } else { '' }`;
    execFile("powershell", ["-NoProfile", "-Command", psScript], (err, stdout) => {
      if (err) {
        res.json({ directory: null });
        return;
      }
      res.json({ directory: stdout.trim() || null });
    });
  }
});

// Detect tech stack from project directory
router.post("/system/detect-tech-stack", (req: Request, res: Response) => {
  const { directory } = req.body as { directory?: string };
  if (!directory || typeof directory !== "string") {
    res.status(400).json({ error: "directory is required" });
    return;
  }
  if (!path.isAbsolute(directory)) {
    res.status(400).json({ error: "directory must be an absolute path" });
    return;
  }
  if (!fs.existsSync(directory)) {
    res.status(400).json({ error: "directory does not exist" });
    return;
  }

  const techStack: string[] = [];

  // TypeScript
  if (fs.existsSync(path.join(directory, "tsconfig.json"))) {
    techStack.push("TypeScript");
  }

  // package.json - extract frameworks from dependencies
  const pkgPath = path.join(directory, "package.json");
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
      const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
      const depMap: Record<string, string> = {
        "react": "React", "next": "Next.js", "vue": "Vue",
        "nuxt": "Nuxt", "svelte": "Svelte", "angular": "Angular",
        "express": "Express", "fastify": "Fastify", "koa": "Koa",
        "tailwindcss": "Tailwind CSS", "prisma": "Prisma",
        "drizzle-orm": "Drizzle", "mongoose": "MongoDB",
        "pg": "PostgreSQL", "better-sqlite3": "SQLite",
        "vite": "Vite", "webpack": "Webpack", "esbuild": "esbuild",
        "jest": "Jest", "vitest": "Vitest", "mocha": "Mocha",
        "electron": "Electron",
      };
      for (const [dep, label] of Object.entries(depMap)) {
        if (allDeps[dep] && !techStack.includes(label)) {
          techStack.push(label);
        }
      }
      if (!techStack.includes("TypeScript") && !fs.existsSync(path.join(directory, "tsconfig.json"))) {
        if (Object.keys(allDeps).length > 0 && !techStack.some(t => t === "TypeScript")) {
          techStack.push("JavaScript");
        }
      }
    } catch {}
  }

  // Rust
  if (fs.existsSync(path.join(directory, "Cargo.toml"))) {
    techStack.push("Rust");
  }

  // Go
  if (fs.existsSync(path.join(directory, "go.mod"))) {
    techStack.push("Go");
  }

  // Python
  if (fs.existsSync(path.join(directory, "pyproject.toml")) ||
      fs.existsSync(path.join(directory, "requirements.txt")) ||
      fs.existsSync(path.join(directory, "setup.py"))) {
    techStack.push("Python");
  }

  // Ruby
  if (fs.existsSync(path.join(directory, "Gemfile"))) {
    techStack.push("Ruby");
  }

  // Java
  if (fs.existsSync(path.join(directory, "pom.xml")) ||
      fs.existsSync(path.join(directory, "build.gradle")) ||
      fs.existsSync(path.join(directory, "build.gradle.kts"))) {
    techStack.push("Java");
  }

  // Swift
  if (fs.existsSync(path.join(directory, "Package.swift"))) {
    techStack.push("Swift");
  }

  // Docker
  if (fs.existsSync(path.join(directory, "Dockerfile")) ||
      fs.existsSync(path.join(directory, "docker-compose.yml")) ||
      fs.existsSync(path.join(directory, "docker-compose.yaml"))) {
    techStack.push("Docker");
  }

  // GitHub Actions
  if (fs.existsSync(path.join(directory, ".github", "workflows"))) {
    techStack.push("GitHub Actions");
  }

  res.json({ tech_stack: techStack });
});

router.get("/status", (_req: Request, res: Response) => {
  const db = getDb();
  const agentCount = db
    .prepare("SELECT COUNT(*) as count FROM agents")
    .get() as { count: number };
  const onlineCount = db
    .prepare("SELECT COUNT(*) as count FROM agents WHERE status = 'online'")
    .get() as { count: number };
  const messageCount = db
    .prepare("SELECT COUNT(*) as count FROM messages")
    .get() as { count: number };

  res.json({
    status: "running",
    agents: { total: agentCount.count, online: onlineCount.count },
    messages: messageCount.count,
    uptime: process.uptime(),
  });
});

export default router;
