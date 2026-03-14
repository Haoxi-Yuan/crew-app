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

async function getAgentProjectScope(): Promise<{ projectId?: string; workplaceId?: string }> {
  const assignment = await client.getAgentCurrentProject(agentName);
  if (!assignment) return {};
  const workplaces = await client.listProjectWorkplaces(assignment.project_id);
  const defaultWorkplace = workplaces.find((w) => w.slug === "default") || workplaces[0];
  return {
    projectId: assignment.project_id,
    workplaceId: defaultWorkplace?.id,
  };
}

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
  "Read group chat messages. Use after_id to fetch only new messages since your last read (saves context). Use query to filter messages by keyword.",
  {
    limit: z.number().optional().describe("Number of messages to fetch (default 10, max 200)"),
    after_id: z.number().optional().describe("Only return messages with id > after_id (incremental read)"),
    channel: z.string().optional().describe("Channel ID to read from (default: general)"),
    query: z.string().optional().describe("Keyword to filter messages (searches message content)"),
  },
  async ({ limit, after_id, channel, query }) => {
    try {
      let messages;
      if (query) {
        // Use search endpoint when query is provided
        messages = await client.searchChat(query, channel, limit || 20);
      } else {
        messages = await client.readChat(limit || 10, undefined, channel, after_id);
      }
      if (messages.length === 0) {
        const hint = query ? ` matching "${query}"` : after_id ? " since id " + after_id : "";
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
      const suffix = query
        ? `\n\n(${messages.length} results for "${query}")`
        : `\n\n(last_id=${lastId}, use after_id=${lastId} next time to read only newer messages)`;
      return { content: [{ type: "text", text: `${text}${suffix}` }] };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  }
);

// Tool: search_chat
server.tool(
  "search_chat",
  "Search chat history by keyword. Use this to quickly find relevant context in long conversations.",
  {
    query: z.string().describe("Keyword to search for in message content"),
    channel: z.string().optional().describe("Channel ID to search in (omit to search all channels)"),
    limit: z.number().optional().describe("Max results to return (default 20, max 100)"),
  },
  async ({ query, channel, limit }) => {
    try {
      const maxResults = limit || 20;
      const messages = await client.searchChat(query, channel, maxResults);
      if (messages.length === 0) {
        return { content: [{ type: "text", text: `No messages matching "${query}".` }] };
      }
      const fmtTime = (ts: number) => {
        const d = new Date(ts);
        return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
      };
      const text = messages
        .map((m) => {
          const cid = "channel_id" in m ? (m as unknown as { channel_id: string }).channel_id : "";
          const channelTag = cid ? ` (#${cid})` : "";
          return `#${m.id} [${m.sender_name} ${fmtTime(m.created_at)}]${channelTag}: ${m.content}`;
        })
        .join("\n");
      return { content: [{ type: "text", text: `${messages.length} results for "${query}":\n${text}` }] };
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
      const files = await client.listSharedFiles(await getAgentProjectScope());
      const file = files.find((f) => f.path === path);
      if (!file) {
        return { content: [{ type: "text", text: `File not found: ${path}` }] };
      }
      return {
        content: [
          {
            type: "text",
            text: `${file.path} | ${file.size_bytes} bytes | ${file.scope_type || "global"}${file.scope_name ? `:${file.scope_name}` : ""} | by ${file.created_by} | updated ${new Date(file.updated_at).toLocaleString()}${file.description ? ` | ${file.description}` : ""}`,
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
      const file = await client.readSharedFile(path, await getAgentProjectScope());
      return {
        content: [
          {
            type: "text",
            text: `File: ${file.path}\nScope: ${file.scope_type || "global"}${file.scope_id ? ` (${file.scope_id})` : ""}\nAuthor: ${file.created_by}\nUpdated: ${new Date(file.updated_at).toLocaleString()}\n\n${file.content}`,
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
    artifact_kind: z.enum(["canonical", "derived"]).optional().describe("Canonical assets stay in the project root; derived artifacts go to the workplace"),
  },
  async ({ path, content, description, artifact_kind }) => {
    try {
      const scope = await getAgentProjectScope();
      await client.writeSharedFile(agentName, path, content, description, {
        ...scope,
        artifactKind: artifact_kind,
      });
      return {
        content: [{ type: "text", text: `File written: ${path}${artifact_kind ? ` [${artifact_kind}]` : ""}` }],
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
      const files = await client.listSharedFiles(await getAgentProjectScope());
      if (files.length === 0) {
        return { content: [{ type: "text", text: "No shared files yet." }] };
      }
      const text = files
        .map(
          (f) =>
            `- [${f.scope_type || "global"}${f.scope_name ? `:${f.scope_name}` : ""}] ${f.path} (${f.size_bytes} bytes, by ${f.created_by})${f.description ? `: ${f.description}` : ""}`
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
  "Set runtime configuration for an agent. Only usable by the author agent. Claude agents support sonnet/opus plus effort. Codex agents also support sandbox and approval policy.",
  {
    agent_name: z.string().describe("Target agent name"),
    model: z.string().optional().describe("Model to use"),
    effort: z.enum(["medium", "high", "max"]).optional().describe("Reasoning effort level (medium, high, or max)"),
    approval_policy: z.enum(["untrusted", "on-request", "never"]).optional().describe("Tool approval policy"),
    sandbox_mode: z.enum(["read-only", "workspace-write", "danger-full-access"]).optional().describe("Sandbox mode"),
  },
  async ({ agent_name, model, effort, approval_policy, sandbox_mode }) => {
    try {
      const result = await client.setAgentConfig(
        agentName,
        agent_name,
        model,
        effort,
        approval_policy,
        sandbox_mode,
        true
      );
      const parts = [];
      if (model) parts.push(`model=${model}`);
      if (effort) parts.push(`effort=${effort}`);
      if (approval_policy) parts.push(`approval_policy=${approval_policy}`);
      if (sandbox_mode) parts.push(`sandbox_mode=${sandbox_mode}`);
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

server.tool(
  "restart_agent",
  "Restart an agent runtime. Only usable by the author agent.",
  { agent_name: z.string().describe("Target agent name") },
  async ({ agent_name }) => {
    try {
      const result = await client.restartAgent(agentName, agent_name);
      return { content: [{ type: "text", text: result.ok ? `Restarted ${agent_name}.` : `Failed to restart ${agent_name}.` }] };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  "interrupt_agent",
  "Interrupt the current work of an agent. Only usable by the author agent.",
  { agent_name: z.string().describe("Target agent name") },
  async ({ agent_name }) => {
    try {
      const result = await client.interruptAgent(agentName, agent_name);
      return { content: [{ type: "text", text: result.ok ? `Interrupted ${agent_name}.` : `No active work to interrupt for ${agent_name}.` }] };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  "resume_agent",
  "Resume an interrupted or paused agent. Only usable by the author agent.",
  { agent_name: z.string().describe("Target agent name") },
  async ({ agent_name }) => {
    try {
      const result = await client.resumeAgent(agentName, agent_name);
      return { content: [{ type: "text", text: result.ok ? `Resume requested for ${agent_name}.` : `Failed to resume ${agent_name}.` }] };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  "reset_agent_session",
  "Reset an agent session while preserving its workspace. Only usable by the author agent.",
  { agent_name: z.string().describe("Target agent name") },
  async ({ agent_name }) => {
    try {
      const result = await client.resetAgentSession(agentName, agent_name);
      return { content: [{ type: "text", text: result.ok ? `Session reset for ${agent_name}.` : `Failed to reset ${agent_name}.` }] };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  "request_agent_status",
  "Get detailed runtime status for an agent. Only usable by the author agent.",
  { agent_name: z.string().describe("Target agent name") },
  async ({ agent_name }) => {
    try {
      const result = await client.getAgentRuntimeStatus(agent_name);
      return {
        content: [{
          type: "text",
          text: `Agent ${result.name} [provider=${result.provider}] state=${result.runtimeState}, context=${result.contextPercent}%\nconfig=${JSON.stringify(result.config)}`,
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

// Tool: get_project_context
server.tool(
  "get_project_context",
  "Get your current project context including description, tech stack, standards, and team. Use this to refresh project context mid-session or after switching projects. If no project_id given, auto-detects from your assignment.",
  {
    project_id: z.string().optional().describe("Project ID (auto-detected if omitted)"),
  },
  async ({ project_id }) => {
    try {
      let pid = project_id;
      if (!pid) {
        const assignment = await client.getAgentCurrentProject(agentName);
        if (!assignment) {
          return { content: [{ type: "text", text: "You are not assigned to any active project." }] };
        }
        pid = assignment.project_id;
      }
      const result = await client.getProjectContext(pid);
      return { content: [{ type: "text", text: result.context }] };
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
    project_id: z.string().optional().describe("Scope search to a specific project. Omit to search global (non-project) memories."),
  },
  async ({ query, category, include_weak, limit, project_id }) => {
    try {
      const result = await client.memorySearch(query, agentName, category, include_weak, limit, true, project_id);
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
    project_id: z.string().optional().describe("Associate memory with a specific project. Omit for global memories."),
  },
  async ({ category, heading, content, importance, emotional_weight, project_id }) => {
    try {
      const result = await client.memoryWrite(agentName, category, heading, content, importance, emotional_weight, project_id);
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
  {
    project_id: z.string().optional().describe("Scope stats to a specific project. Omit for global memories."),
  },
  async ({ project_id }) => {
    try {
      const stats = await client.memoryStats(agentName, project_id);
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

// Tool: reflect_on_task
server.tool(
  "reflect_on_task",
  "Submit a structured reflection after completing a task. Includes lessons learned and optional proposals for standard updates. High-confidence additive proposals may be auto-applied.",
  {
    project_id: z.string().describe("Project ID this reflection belongs to"),
    trigger_type: z.enum(["task_complete", "project_milestone", "manual", "session_cycle"]).describe("What triggered this reflection"),
    task_summary: z.string().describe("Brief summary of the task completed"),
    lessons_learned: z.array(z.object({
      category: z.enum(["process", "quality", "communication", "tooling", "domain"]),
      description: z.string(),
      evidence: z.string(),
    })).optional().describe("Lessons from this task"),
    proposed_updates: z.array(z.object({
      action: z.enum(["add", "modify", "remove"]),
      section: z.string().describe("Standard name/section"),
      current_text: z.string().optional().describe("Current standard text (for modify/remove)"),
      proposed_text: z.string().describe("Proposed new text"),
      rationale: z.string().describe("Why this change is beneficial"),
      confidence: z.number().describe("0-1 confidence in this proposal"),
    })).optional().describe("Proposed updates to shared standards"),
    confidence: z.number().optional().describe("Overall reflection confidence (0-1, default 0.5)"),
  },
  async ({ project_id, trigger_type, task_summary, lessons_learned, proposed_updates, confidence }) => {
    try {
      const result = await client.submitReflection(
        agentName, project_id, trigger_type, task_summary,
        lessons_learned || [], proposed_updates || [], confidence || 0.5
      );
      const autoSummary = result.auto_results.length > 0
        ? "\n" + result.auto_results.map((r) => `  [${r.index}] ${r.action}: ${r.reason}`).join("\n")
        : "";
      return {
        content: [{
          type: "text",
          text: `Reflection submitted (id: ${result.id}, status: ${result.status})${autoSummary}`,
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

// Tool: propose_standard_update
server.tool(
  "propose_standard_update",
  "Propose a single update to shared coding standards. Use this when you notice a pattern worth standardizing. Auto-applied if confidence >= 0.8, additive, no contradiction, within budget, and >= 2 agents agree.",
  {
    project_id: z.string().describe("Project ID for context"),
    action: z.enum(["add", "modify", "remove"]).describe("Type of update"),
    section: z.string().describe("Standard name/section to update"),
    current_text: z.string().optional().describe("Current text (for modify/remove)"),
    proposed_text: z.string().describe("Proposed text for the standard"),
    rationale: z.string().describe("Why this standard should be adopted"),
    confidence: z.number().describe("0-1 confidence level"),
  },
  async ({ project_id, action, section, current_text, proposed_text, rationale, confidence }) => {
    try {
      const result = await client.proposeStandardUpdate(agentName, project_id, {
        action, section, current_text, proposed_text, rationale, confidence,
      });
      const autoResult = result.auto_results[0];
      const outcome = autoResult ? `${autoResult.action}: ${autoResult.reason}` : "submitted for review";
      return {
        content: [{
          type: "text",
          text: `Standard update proposed (id: ${result.id}, status: ${result.status})\nOutcome: ${outcome}`,
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

// Tool: escalate_peak
server.tool(
  "escalate_peak",
  "Escalate a decision to the human operator (Peak). Use when you face: irreversible actions, multiple viable paths, information asymmetry, or need a drift check. The human will decide, and the decision is persisted to team memory. If the human doesn't respond in time, your default_option is auto-chosen.",
  {
    peak_type: z.enum(["irreversibility", "multiple_paths", "info_asymmetry", "drift_check"]).describe("Type of peak"),
    context: z.string().describe("Clear description of the situation requiring human judgment"),
    options: z.array(z.object({
      label: z.string().describe("Short name for the option"),
      pros: z.string().describe("Advantages of this option"),
      cons: z.string().describe("Disadvantages of this option"),
    })).describe("At least 2 options (except drift_check which can have 0)"),
    agent_lean: z.string().optional().describe("Which option you'd recommend and why"),
    default_option: z.number().optional().describe("Index of option to auto-choose on timeout (default 0)"),
    timeout_seconds: z.number().optional().describe("Seconds to wait for human (30-1800, default 300)"),
    project_id: z.string().optional().describe("Project ID for context"),
  },
  async ({ peak_type, context, options, agent_lean, default_option, timeout_seconds, project_id }) => {
    try {
      const result = await client.escalatePeak(
        agentName, project_id, peak_type, context, options,
        agent_lean, default_option, timeout_seconds
      );
      const expiresIn = Math.round((result.expires_at - Date.now()) / 1000);
      return {
        content: [{
          type: "text",
          text: `Peak escalated (id: ${result.id}, type: ${peak_type})\nStatus: ${result.status}\nExpires in: ${expiresIn}s\nDefault option: ${default_option ?? 0}\n\nUse check_peak_decision("${result.id}") to poll for the human's decision.`,
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

// Tool: check_peak_decision
server.tool(
  "check_peak_decision",
  "Check if a human has decided on a peak you escalated. Returns the decision details if resolved, or 'pending' if still waiting.",
  {
    peak_id: z.string().describe("The peak ID returned from escalate_peak"),
  },
  async ({ peak_id }) => {
    try {
      const result = await client.checkPeakDecision(peak_id);
      if (result.status === "pending") {
        return {
          content: [{
            type: "text",
            text: `Peak ${peak_id} is still pending. The human has not decided yet. You can continue other work and check back later.`,
          }],
        };
      }
      const chosen = result.options[result.decision_index ?? 0];
      const chosenLabel = chosen ? chosen.label : "unknown";
      return {
        content: [{
          type: "text",
          text: `Peak ${peak_id} resolved!\nStatus: ${result.status}\nDecision: option ${result.decision_index} - "${chosenLabel}"\nDecided by: ${result.decided_by || "unknown"}\n${result.decision_note ? `Note: ${result.decision_note}` : ""}\n\nProceed with the chosen option.`,
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
