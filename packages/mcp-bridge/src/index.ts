#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as client from "./client.js";

const agentName = process.argv[2];
if (!agentName) {
  console.error("Usage: claude-crew-bridge <agent-name> [role]");
  process.exit(1);
}
const agentRole = process.argv[3] || "";

const server = new McpServer({
  name: "claude-crew",
  version: "1.0.0",
});

// Tool: check_mentions
server.tool(
  "check_mentions",
  "Check @mentions directed at you.",
  {},
  async () => {
    try {
      const mentions = await client.checkMentions(agentName);
      if (mentions.length === 0) {
        return { content: [{ type: "text", text: "No pending mentions." }] };
      }
      // Auto-acknowledge all fetched mentions
      for (const m of mentions) {
        await client.acknowledgeMention(m.mention_id);
      }
      const text = mentions
        .map(
          (m) =>
            `[${m.sender_name}] (${new Date(m.created_at).toLocaleTimeString()}): ${m.content}`
        )
        .join("\n\n");
      return {
        content: [
          {
            type: "text",
            text: `You have ${mentions.length} mention(s):\n\n${text}`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  }
);

// Tool: read_chat
server.tool(
  "read_chat",
  "Read group chat messages. Use after_id to fetch only new messages since your last read (saves context).",
  {
    limit: z.number().optional().describe("Number of messages to fetch (default 10, max 200)"),
    after_id: z.number().optional().describe("Only return messages with id > after_id (incremental read)"),
    channel: z.string().optional().describe("Channel ID to read from (default: general)"),
  },
  async ({ limit, after_id, channel }) => {
    try {
      const messages = await client.readChat(limit || 10, undefined, channel, after_id);
      if (messages.length === 0) {
        const hint = after_id ? " since id " + after_id : "";
        return { content: [{ type: "text", text: `No messages${hint}.` }] };
      }
      const fmtTime = (ts: number) => {
        const d = new Date(ts);
        return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
      };
      const text = messages
        .map((m) => `#${m.id} [${m.sender_name} ${fmtTime(m.created_at)}]: ${m.content}`)
        .join("\n");
      const lastId = messages[messages.length - 1].id;
      return { content: [{ type: "text", text: `${text}\n\n(last_id=${lastId}, use after_id=${lastId} next time to read only newer messages)` }] };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  }
);

// Tool: send_to_chat
server.tool(
  "send_to_chat",
  "Send message to group chat. Use @name to mention.",
  {
    message: z.string().describe("The message content to send"),
    channel: z.string().optional().describe("Channel ID to send to (default: general)"),
  },
  async ({ message, channel }) => {
    try {
      const result = await client.sendMessage(agentName, message, channel);
      const mentionNote =
        result.mentions.length > 0
          ? ` (mentioned: ${result.mentions.join(", ")})`
          : "";
      return {
        content: [
          { type: "text", text: `Message sent (id: ${result.id})${mentionNote}` },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  }
);

// Tool: list_agents
server.tool(
  "list_agents",
  "List online agents and their status.",
  {},
  async () => {
    try {
      const agents = await client.listAgents();
      if (agents.length === 0) {
        return { content: [{ type: "text", text: "No agents registered." }] };
      }
      const text = agents
        .map(
          (a) =>
            `- ${a.name} [${a.status}]${a.role ? ` (${a.role})` : ""}`
        )
        .join("\n");
      return { content: [{ type: "text", text }] };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  }
);

// Tool: get_shared_file_meta
server.tool(
  "get_shared_file_meta",
  "Get metadata of a shared file without loading full content. Use this to check if a file changed before reading it fully.",
  { path: z.string().describe("File path relative to shared directory") },
  async ({ path }) => {
    try {
      const files = await client.listSharedFiles();
      const file = files.find((f) => f.path === path);
      if (!file) {
        return { content: [{ type: "text", text: `File not found: ${path}` }] };
      }
      return {
        content: [
          {
            type: "text",
            text: `${file.path} | ${file.size_bytes} bytes | by ${file.created_by} | updated ${new Date(file.updated_at).toLocaleString()}${file.description ? ` | ${file.description}` : ""}`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  }
);

// Tool: read_shared_file
server.tool(
  "read_shared_file",
  "Read a shared team file.",
  { path: z.string().describe("File path relative to shared directory") },
  async ({ path }) => {
    try {
      const file = await client.readSharedFile(path);
      return {
        content: [
          {
            type: "text",
            text: `File: ${file.path}\nAuthor: ${file.created_by}\nUpdated: ${new Date(file.updated_at).toLocaleString()}\n\n${file.content}`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  }
);

// Tool: write_shared_file
server.tool(
  "write_shared_file",
  "Write/update a shared team file.",
  {
    path: z.string().describe("File path relative to shared directory"),
    content: z.string().describe("File content to write"),
    description: z.string().optional().describe("Brief description of the file"),
  },
  async ({ path, content, description }) => {
    try {
      await client.writeSharedFile(agentName, path, content, description);
      return {
        content: [{ type: "text", text: `File written: ${path}` }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  }
);

// Tool: list_shared_files
server.tool(
  "list_shared_files",
  "List all shared team files.",
  {},
  async () => {
    try {
      const files = await client.listSharedFiles();
      if (files.length === 0) {
        return { content: [{ type: "text", text: "No shared files yet." }] };
      }
      const text = files
        .map(
          (f) =>
            `- ${f.path} (${f.size_bytes} bytes, by ${f.created_by})${f.description ? `: ${f.description}` : ""}`
        )
        .join("\n");
      return { content: [{ type: "text", text }] };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  }
);

// Tool: save_worklog
server.tool(
  "save_worklog",
  "Save your current task state for recovery after session restart.",
  {
    current_task: z.object({
      description: z.string(),
      status: z.enum(["in_progress", "completed", "blocked", "paused"]),
      progress: z.string(),
      subtasks_done: z.array(z.string()),
      next_step: z.string(),
      blockers: z.array(z.string()),
    }).nullable().describe("Current task state, null if no active task"),
    recent_decisions: z.array(z.object({
      decided_at: z.string(),
      context: z.string(),
      decision: z.string(),
    })).optional().describe("Recent team decisions relevant to your work"),
    working_files: z.array(z.string()).optional().describe("Paths of files you are working on"),
    key_context: z.string().optional().describe("Important context for resuming work"),
  },
  async ({ current_task, recent_decisions, working_files, key_context }) => {
    try {
      const worklog: client.Worklog = {
        agent_name: agentName,
        updated_at: new Date().toISOString(),
        current_task: current_task || null,
        recent_decisions: recent_decisions || [],
        working_files: working_files || [],
        key_context: key_context || "",
      };
      await client.saveWorklog(agentName, worklog);
      return {
        content: [{ type: "text", text: "Worklog saved." }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  }
);

// Tool: load_worklog
server.tool(
  "load_worklog",
  "Load your previous task state after session restart.",
  {},
  async () => {
    try {
      const result = await client.loadWorklog(agentName);
      if (!result.exists || !result.worklog) {
        return { content: [{ type: "text", text: "No previous worklog found. Starting fresh." }] };
      }
      const w = result.worklog;
      const text = JSON.stringify(w, null, 2);
      return {
        content: [{ type: "text", text: `Previous worklog (saved ${w.updated_at}):\n\n${text}` }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  }
);

// Tool: set_agent_config (author only)
server.tool(
  "set_agent_config",
  "Set model and effort for an agent. Only usable by the author agent. Model: sonnet or opus. Effort: medium, high, or max. The agent will be restarted to apply changes.",
  {
    agent_name: z.string().describe("Target agent name"),
    model: z.enum(["sonnet", "opus"]).optional().describe("Model to use (sonnet or opus)"),
    effort: z.enum(["medium", "high", "max"]).optional().describe("Reasoning effort level (medium, high, or max)"),
  },
  async ({ agent_name, model, effort }) => {
    try {
      const result = await client.setAgentConfig(agentName, agent_name, model, effort, true);
      const parts = [];
      if (model) parts.push(`model=${model}`);
      if (effort) parts.push(`effort=${effort}`);
      return {
        content: [{
          type: "text",
          text: `Config updated for ${agent_name}: ${parts.join(", ")}. ${result.restarted ? "Agent restarted." : "Will apply on next restart."}`,
        }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  }
);

// Tool: memory_search
server.tool(
  "memory_search",
  "Search your memory. Returns decay-weighted results: frequently accessed memories rank higher. Use for recalling decisions, preferences, project context. Only use when starting a new topic or needing past context - not for routine messages.",
  {
    query: z.string().describe("Search query (keywords or natural language)"),
    category: z.string().optional().describe("Filter: contact, preference, decision, project, pattern, feedback, daily"),
    include_weak: z.boolean().optional().describe("Include low-strength (nearly forgotten) memories"),
    limit: z.number().optional().describe("Max results (default 5, max 20)"),
  },
  async ({ query, category, include_weak, limit }) => {
    try {
      const result = await client.memorySearch(query, agentName, category, include_weak, limit, true);
      if (result.count === 0) {
        return { content: [{ type: "text", text: "No matching memories found." }] };
      }
      const lines = result.entries.map(
        (e) => `[${e.category}] ${e.heading} (strength: ${Math.round(e.retrievability * 100)}%, id: ${e.id})`
      );
      return {
        content: [{ type: "text", text: `Found ${result.count} memor${result.count === 1 ? "y" : "ies"}:\n${lines.join("\n")}\n\nUse memory_read(id) to expand details.` }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  }
);

// Tool: memory_read
server.tool(
  "memory_read",
  "Read full content of a memory entry by ID. This also reinforces the memory (increases its strength).",
  {
    id: z.string().describe("Memory entry ID"),
  },
  async ({ id }) => {
    try {
      const entry = await client.memoryRead(id);
      return {
        content: [{
          type: "text",
          text: `[${entry.category}] ${entry.heading}\nStatus: ${entry.status} | Accessed: ${entry.access_count}x | Strength: ${Math.round(entry.retrievability * 100)}%\n\n${entry.content}`,
        }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  }
);

// Tool: memory_write
server.tool(
  "memory_write",
  "Record a new memory. Auto-scored for decay: contacts and preferences never decay, daily logs decay fastest. Use importance 4-5 for critical info, 1-2 for ephemeral notes.",
  {
    category: z.enum(["contact", "preference", "decision", "project", "pattern", "feedback", "daily"]).describe("Memory category"),
    heading: z.string().describe("One-line summary (used in search results)"),
    content: z.string().describe("Full memory content"),
    importance: z.number().optional().describe("Importance 1-5 (default 3). 5=critical, 1=trivial"),
    emotional_weight: z.number().optional().describe("1.0-2.0 (default 1.0). Set >1.5 for user-emphasized items"),
  },
  async ({ category, heading, content, importance, emotional_weight }) => {
    try {
      const result = await client.memoryWrite(agentName, category, heading, content, importance, emotional_weight);
      return {
        content: [{ type: "text", text: `Memory saved (id: ${result.id}, status: ${result.status}, strength: ${Math.round(result.retrievability * 100)}%)` }],
      };
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes("duplicate")) {
        return { content: [{ type: "text", text: "Memory already exists (duplicate content detected)." }] };
      }
      return {
        content: [{ type: "text", text: `Error: ${msg}` }],
        isError: true,
      };
    }
  }
);

// Tool: memory_status
server.tool(
  "memory_status",
  "View memory health: total count, category breakdown, average strength, recently accessed entries.",
  {},
  async () => {
    try {
      const stats = await client.memoryStats(agentName);
      const lines = [
        `Total memories: ${stats.total}`,
        `By status: ${Object.entries(stats.by_status).map(([k, v]) => `${k}=${v}`).join(", ") || "none"}`,
        `By category: ${Object.entries(stats.by_category).map(([k, v]) => `${k}=${v}`).join(", ") || "none"}`,
        `Avg strength: ${stats.avg_retrievability !== null ? Math.round(stats.avg_retrievability * 100) + "%" : "N/A"}`,
      ];
      if (stats.recently_accessed.length > 0) {
        lines.push("", "Recently accessed:");
        for (const r of stats.recently_accessed) {
          lines.push(`  [${r.category}] ${r.heading} (${r.access_count}x)`);
        }
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  }
);

// Lifecycle management
async function startup() {
  try {
    await client.register(agentName, agentRole);
    console.error(`[claude-crew-bridge] agent "${agentName}" registered`);
  } catch (err) {
    console.error(`[claude-crew-bridge] registration failed: ${(err as Error).message}`);
  }
}

const heartbeatInterval = setInterval(async () => {
  try {
    await client.heartbeat(agentName);
  } catch {
    // Server might be temporarily down, just skip
  }
}, 30_000);

// Tool list refresh removed: tools are registered at connection time and
// re-established on auto-cycle restart. Periodic refresh wastes context by
// forcing Claude Code to re-inject all tool schemas into the conversation.

async function shutdown() {
  clearInterval(heartbeatInterval);
  try {
    await client.deregister(agentName);
    console.error(`[claude-crew-bridge] agent "${agentName}" deregistered`);
  } catch {
    // Best effort
  }
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// Start
await startup();
const transport = new StdioServerTransport();
await server.connect(transport);
