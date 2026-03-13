import { Router, type Request, type Response } from "express";
import type { Router as RouterType } from "express";
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import agentsRouter, { buildClaudeCmd } from "./agents.js";
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
import { startCodexAgent } from "../providers/codex.js";

const router: RouterType = Router();

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

// Wake agent: start provider runtime
router.post("/wake", (req: Request, res: Response) => {
  const { name } = req.body as { name?: string };
  if (!name) {
    res.status(400).json({ error: "name is required" });
    return;
  }

  const agentsDir = path.join(PROJECT_ROOT, "agents");
  const agentDir = path.join(agentsDir, name);
  const session = `crew-${name}`;

  if (!fs.existsSync(agentDir)) {
    res.status(404).json({ error: `Agent workspace not found: ${name}. Use 'crew add ${name} <role>' first.` });
    return;
  }

  const provider = getProvider(name);
  if (provider === "codex") {
    startCodexAgent(name)
      .then(() => res.json({ ok: true, name, provider }))
      .catch((err) => res.status(500).json({ error: `Failed to wake Codex agent: ${(err as Error).message}` }));
    return;
  }

  // Check if already running
  execFile("tmux", ["has-session", "-t", session], (checkErr) => {
    if (!checkErr) {
      res.json({ ok: true, name, message: "already running" });
      return;
    }
    // Find claude path
    let claudePath = "";
    try { claudePath = execFileSync("which", ["claude"]).toString().trim(); } catch {}
    if (!claudePath) {
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
              if (fs.existsSync(p)) { claudePath = p; break; }
            }
          } catch {}
        } else if (fs.existsSync(c)) { claudePath = c; }
        if (claudePath) break;
      }
    }
    if (!claudePath) {
      res.status(500).json({ error: "Claude Code CLI not found" });
      return;
    }

    // Start new tmux session with model/effort config from DB
    const cmd = buildClaudeCmd(agentDir, claudePath, name);
    execFile("tmux", ["new-session", "-d", "-s", session, cmd], (err) => {
      if (err) {
        res.status(500).json({ error: `Failed to wake agent: ${err.message}` });
        return;
      }
      res.json({ ok: true, name, provider });
    });
  });
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
      const cmd = buildClaudeCmd(agentDir, claudePath, name);
      execFile("tmux", ["new-session", "-d", "-s", session, cmd], (err) => {
        if (!err) launched++;
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
