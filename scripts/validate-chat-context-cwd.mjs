import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const SERVER_ENTRY = path.join(REPO_ROOT, "packages/server/dist/index.js");
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-crew-chat-cwd-"));
const port = 3194;

process.env.CREW_PROJECT_ROOT = tempRoot;

const dbModule = await import(pathToFileURL(path.join(REPO_ROOT, "packages/server/dist/db/index.js")).href);
const agentsModule = await import(pathToFileURL(path.join(REPO_ROOT, "packages/server/dist/api/agents.js")).href);
const forwardModule = await import(pathToFileURL(path.join(REPO_ROOT, "packages/server/dist/forward.js")).href);

const { getDb } = dbModule;
const { buildClaudeCmd } = agentsModule;
const { getRecentChannelContext, buildForwardedMessageInput } = forwardModule;

const db = getDb();

function cleanup() {
  try {
    db.close();
  } catch {
    // ignore
  }
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

function insertMessage(channelId, senderName, content, createdAt) {
  const result = db.prepare(
    "INSERT INTO messages (channel_id, sender_type, sender_name, content, mentions, message_type, created_at) VALUES (?, 'user', ?, ?, '[]', 'chat', ?)"
  ).run(channelId, senderName, content, createdAt);
  return Number(result.lastInsertRowid);
}

async function waitForServer(url, child) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 10_000) {
    if (child.exitCode !== null) {
      throw new Error(`server exited early with code ${child.exitCode}`);
    }
    try {
      const resp = await fetch(url);
      if (resp.ok) return;
    } catch {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("server did not become ready in time");
}

try {
  const agentsDir = path.join(tempRoot, "agents");
  const dedicatedAgentDir = path.join(agentsDir, "dedicated-agent");
  const globalAgentDir = path.join(agentsDir, "global-agent");
  fs.mkdirSync(dedicatedAgentDir, { recursive: true });
  fs.mkdirSync(globalAgentDir, { recursive: true });
  fs.writeFileSync(path.join(dedicatedAgentDir, "CLAUDE.md"), "# Dedicated agent instructions\nAlways verify.\n", "utf8");
  fs.writeFileSync(path.join(globalAgentDir, "CLAUDE.md"), "# Global agent instructions\nStay in your own workspace.\n", "utf8");

  const now = Date.now();
  const projectId = "proj-1";
  const workplaceId = "wp-1";
  const projectDir = path.join(tempRoot, "data/projects/demo");
  const workplaceDir = path.join(projectDir, "workplaces/default");
  fs.mkdirSync(workplaceDir, { recursive: true });

  db.prepare(`
    INSERT INTO projects (id, name, slug, description, tech_stack, status, config, directory, created_at, updated_at)
    VALUES (?, ?, ?, ?, '[]', 'active', '{}', ?, ?, ?)
  `).run(projectId, "Demo", "demo", "Demo project", projectDir, now, now);

  db.prepare(`
    INSERT INTO workplaces (id, project_id, name, slug, status, directory, kind, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'active', ?, 'derived', ?, ?)
  `).run(workplaceId, projectId, "Default", "default", workplaceDir, now, now);

  db.prepare(`
    INSERT INTO project_agents (project_id, agent_name, role_in_project, assignment_type, status, active_workplace_id, assigned_at)
    VALUES (?, ?, '', 'dedicated', 'active', ?, ?)
  `).run(projectId, "dedicated-agent", workplaceId, now);

  db.prepare(`
    INSERT INTO project_agents (project_id, agent_name, role_in_project, assignment_type, status, active_workplace_id, assigned_at)
    VALUES (?, ?, '', 'global', 'active', ?, ?)
  `).run(projectId, "global-agent", workplaceId, now + 1);

  let createdAt = now - 100_000;
  for (let i = 1; i <= 18; i += 1) {
    insertMessage("general", i % 2 === 0 ? "bob" : "alice", `history ${i} keyword`, createdAt);
    createdAt += 1_000;
  }
  const currentMessageId = insertMessage("general", "carol", "latest roadmap question", createdAt + 1_000);
  insertMessage("small", "alice", "small one", createdAt + 2_000);
  insertMessage("small", "bob", "small two", createdAt + 3_000);
  insertMessage("small", "carol", "small three", createdAt + 4_000);

  const longContext = getRecentChannelContext("general", currentMessageId);
  assert(longContext.includes("--- Recent chat context in #general ---"));
  assert(longContext.includes("Use search_chat"));
  assert(longContext.includes(`#${currentMessageId - 1}`));
  assert(!longContext.includes("#1 [alice"));

  const shortContext = getRecentChannelContext("small");
  assert(shortContext.includes("#20 [alice"));
  assert(shortContext.includes("#21 [bob"));
  assert(shortContext.includes("#22 [carol"));
  assert(!shortContext.includes("Use search_chat"));

  const forwardedPrompt = buildForwardedMessageInput("carol", "latest roadmap question", "general", undefined, longContext);
  assert(forwardedPrompt.startsWith("--- Recent chat context in #general ---"));
  assert(forwardedPrompt.includes('[carol in #general]: latest roadmap question'));
  assert(forwardedPrompt.includes('(Reply using send_to_chat with channel="general")'));

  const dedicatedCmd = buildClaudeCmd(dedicatedAgentDir, "/usr/local/bin/claude", "dedicated-agent");
  assert(dedicatedCmd.includes(`cd '${projectDir}'`));
  assert(dedicatedCmd.includes("Dedicated agent instructions"));
  assert(dedicatedCmd.includes(workplaceDir));
  assert(dedicatedCmd.includes(`CLAUDE_CREW_AGENT_DIR='${dedicatedAgentDir}'`));

  const globalCmd = buildClaudeCmd(globalAgentDir, "/usr/local/bin/claude", "global-agent");
  assert(globalCmd.includes(`cd '${globalAgentDir}'`));
  assert(globalCmd.includes("Canonical Project Root"));
  assert(globalCmd.includes(workplaceDir));
  assert(!globalCmd.includes("Global agent instructions"));

  const child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      CREW_PROJECT_ROOT: tempRoot,
      CREW_PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let serverLog = "";
  child.stdout.on("data", (chunk) => {
    serverLog += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    serverLog += String(chunk);
  });

  try {
    await waitForServer(`http://127.0.0.1:${port}/api/status`, child);
    const resp = await fetch(`http://127.0.0.1:${port}/api/messages/search?query=keyword&channel_id=general&limit=20`);
    assert.equal(resp.ok, true, `search endpoint failed: ${resp.status}`);
    const results = await resp.json();
    assert(Array.isArray(results) && results.length > 0, "search endpoint returned no results");
    assert(results.every((item) => item.channel_id === "general"), "search endpoint leaked other channels");
    assert(results.some((item) => String(item.content).includes("keyword")), "search endpoint missed keyword results");
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
  }

  console.log(JSON.stringify({
    ok: true,
    checks: [
      "forward context formatting for short/long chat history",
      "dedicated agent cwd switches to project directory",
      "global agent cwd remains in agent workspace",
      "messages search endpoint returns channel-scoped keyword hits",
    ],
  }, null, 2));
} catch (err) {
  console.error((err instanceof Error ? err.stack : String(err)) || "validation failed");
  process.exitCode = 1;
} finally {
  cleanup();
}
