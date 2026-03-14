#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as client from "./client.js";
import {
  TOOL_BOOTSTRAP_ALLOWLIST,
  buildToolHandbook,
  buildToolPreflight,
  computePreflightRequirement,
  defineTool,
  getToolProfile,
  loadToolMemoryState,
  preflightRequiredForAgent,
  saveToolMemoryState,
  TOOL_HANDBOOK_VERSION,
  type ToolDefinition,
  type ToolResult,
} from "./tool-memory.js";

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

const emptySchema = {} as const;
const toolDefinitions: ToolDefinition[] = [];

let persistedToolState = loadToolMemoryState(agentName);
let preflightRequired = false;

function addTool<TSchema extends z.ZodRawShape>(definition: ToolDefinition<TSchema>): void {
  toolDefinitions.push(definition as ToolDefinition);
}

function ok(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

function failure(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

function formatError(err: unknown): ToolResult {
  return failure(`Error: ${(err as Error).message}`);
}

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

function registerTool<TSchema extends z.ZodRawShape>(definition: ToolDefinition<TSchema>): void {
  server.tool(
    definition.name,
    definition.description,
    definition.schema as z.ZodRawShape,
    async (args: any) => {
      if (preflightRequired && !TOOL_BOOTSTRAP_ALLOWLIST.has(definition.name)) {
        return failure("Tool preflight required. Call tool_preflight() first.");
      }
      try {
        return await definition.handler(args);
      } catch (err) {
        return formatError(err);
      }
    },
  );
}

addTool(defineTool({
  name: "check_mentions",
  description: "Check @mentions directed at you.",
  schema: emptySchema,
  handbook: {
    audience: ["core"],
    priority: "medium",
    when_to_use: [
      "Use at the start of a loop to see whether anyone explicitly asked for you.",
    ],
    when_not_to_use: [
      "Do not use as a substitute for reading the channel context after you know which conversation matters.",
    ],
    pitfalls: [
      "Mentions are point-in-time notifications; still call read_chat before acting.",
    ],
    related_tools: ["read_chat"],
    recovery_notes: [
      "Safe before preflight. Use it to discover work, then run tool_preflight if required.",
    ],
    examples: [
      { title: "Check queue", invocation: "check_mentions()" },
    ],
    keywords: ["mentions", "inbox", "notifications"],
  },
  handler: async () => {
    const mentions = await client.checkMentions(agentName);
    if (mentions.length === 0) {
      return ok("No pending mentions.");
    }
    for (const mention of mentions) {
      await client.acknowledgeMention(mention.mention_id);
    }
    const text = mentions
      .map((mention) => `[${mention.sender_name}] (${new Date(mention.created_at).toLocaleTimeString()}): ${mention.content}`)
      .join("\n\n");
    return ok(`You have ${mentions.length} mention(s):\n\n${text}`);
  },
}));

addTool(defineTool({
  name: "read_chat",
  description: "Read group chat messages. Use after_id to fetch only new messages since your last read. Use query to filter messages by keyword.",
  schema: {
    limit: z.number().optional().describe("Number of messages to fetch (default 10, max 200)"),
    after_id: z.number().optional().describe("Only return messages with id > after_id"),
    channel: z.string().optional().describe("Channel ID to read from (default: general)"),
    query: z.string().optional().describe("Keyword to filter messages"),
  },
  handbook: {
    audience: ["core"],
    priority: "high",
    when_to_use: [
      "Use before replying so you ground yourself in recent channel context.",
      "Use after_id for incremental catch-up after a restart or context cycle.",
    ],
    when_not_to_use: [
      "Do not use search_chat for simple sequential catch-up; read_chat is cheaper and preserves chronology.",
    ],
    pitfalls: [
      "Always pass the incoming channel when responding to a specific thread or project room.",
    ],
    related_tools: ["search_chat", "send_to_chat", "load_worklog"],
    recovery_notes: [
      "Safe before preflight. Use it after load_worklog and tool_preflight during session recovery.",
    ],
    examples: [
      { title: "Catch up after restart", invocation: 'read_chat(channel="project-foo", after_id=128)' },
    ],
    keywords: ["chat", "history", "context", "catch up"],
  },
  handler: async ({ limit, after_id, channel, query }) => {
    let messages;
    if (query) {
      messages = await client.searchChat(query, channel, limit || 20);
    } else {
      messages = await client.readChat(limit || 10, undefined, channel, after_id);
    }
    if (messages.length === 0) {
      const hint = query ? ` matching "${query}"` : after_id ? ` since id ${after_id}` : "";
      return ok(`No messages${hint}.`);
    }
    const fmtTime = (timestamp: number) => {
      const date = new Date(timestamp);
      return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
    };
    const text = messages
      .map((message) => `#${message.id} [${message.sender_name} ${fmtTime(message.created_at)}]: ${message.content}`)
      .join("\n");
    const lastId = messages[messages.length - 1].id;
    const suffix = query
      ? `\n\n(${messages.length} results for "${query}")`
      : `\n\n(last_id=${lastId}, use after_id=${lastId} next time to read only newer messages)`;
    return ok(`${text}${suffix}`);
  },
}));

addTool(defineTool({
  name: "search_chat",
  description: "Search chat history by keyword.",
  schema: {
    query: z.string().describe("Keyword to search for in message content"),
    channel: z.string().optional().describe("Channel ID to search in"),
    limit: z.number().optional().describe("Max results to return (default 20, max 100)"),
  },
  handbook: {
    audience: ["core"],
    priority: "medium",
    when_to_use: [
      "Use to recover a specific decision, agent mention, or prior discussion without replaying the whole chat.",
    ],
    when_not_to_use: [
      "Do not use as your default chronological catch-up tool.",
    ],
    pitfalls: [
      "Keyword-only search can miss paraphrases; try alternate words if the first search is empty.",
    ],
    related_tools: ["read_chat"],
    recovery_notes: [
      "Use when your worklog references an older decision and you need the original chat evidence.",
    ],
    examples: [
      { title: "Find PEAK references", invocation: 'search_chat(query="peak", channel="project-foo", limit=10)' },
    ],
    keywords: ["search", "history", "find decision"],
  },
  handler: async ({ query, channel, limit }) => {
    const messages = await client.searchChat(query, channel, limit || 20);
    if (messages.length === 0) {
      return ok(`No messages matching "${query}".`);
    }
    const fmtTime = (timestamp: number) => {
      const date = new Date(timestamp);
      return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
    };
    const text = messages
      .map((message) => {
        const channelTag = message.channel_id ? ` (#${message.channel_id})` : "";
        return `#${message.id} [${message.sender_name} ${fmtTime(message.created_at)}]${channelTag}: ${message.content}`;
      })
      .join("\n");
    return ok(`${messages.length} results for "${query}":\n${text}`);
  },
}));

addTool(defineTool({
  name: "send_to_chat",
  description: "Send a message to chat. Use @name to mention another agent.",
  schema: {
    message: z.string().describe("The message content to send"),
    channel: z.string().optional().describe("Channel ID to send to (default: general)"),
  },
  handbook: {
    audience: ["core"],
    priority: "high",
    when_to_use: [
      "Use after you have completed the requested work and are ready to reply in the correct channel.",
    ],
    when_not_to_use: [
      "Do not use before reading channel context for the active conversation.",
    ],
    pitfalls: [
      "Always pass the channel from the incoming message. Do not omit it when replying.",
    ],
    related_tools: ["read_chat", "list_agents"],
    recovery_notes: [
      "Blocked until preflight for guarded agents, because routing mistakes are costly after compression.",
    ],
    examples: [
      { title: "Reply to project room", invocation: 'send_to_chat(message="已完成，详情见共享文件。", channel="project-foo")' },
    ],
    keywords: ["reply", "chat", "send", "mention"],
  },
  handler: async ({ message, channel }) => {
    const result = await client.sendMessage(agentName, message, channel);
    const mentionNote = result.mentions.length > 0 ? ` (mentioned: ${result.mentions.join(", ")})` : "";
    return ok(`Message sent (id: ${result.id})${mentionNote}`);
  },
}));

addTool(defineTool({
  name: "list_agents",
  description: "List agents and their status. Defaults to the current project team if you are assigned to a project; use scope='global' to see every agent.",
  schema: {
    scope: z.enum(["current_project", "global"]).optional().describe("current_project (default) or global"),
  },
  handbook: {
    audience: ["core"],
    priority: "high",
    when_to_use: [
      "Use before delegating work when you need a fresh view of the current project roster.",
      "Use with scope='global' only when the task truly concerns the whole crew rather than your project.",
    ],
    when_not_to_use: [
      "Do not assume the global list is your project team.",
    ],
    pitfalls: [
      "Project routing should only use current_project results unless you are intentionally planning global orchestration.",
    ],
    related_tools: ["get_project_context", "assign_agent_to_project"],
    recovery_notes: [
      "For guarded agents, preflight highlights the project-boundary meaning of this tool because misuse causes cross-project drift.",
    ],
    examples: [
      { title: "See current project roster", invocation: "list_agents()" },
      { title: "See all registered agents", invocation: 'list_agents(scope="global")' },
    ],
    keywords: ["agents", "roster", "team", "delegation"],
  },
  handler: async ({ scope }) => {
    const assignment = scope === "global" ? null : await client.getAgentCurrentProject(agentName);
    const agents = await client.listAgents(assignment?.project_id);
    if (agents.length === 0) {
      const emptyLabel = assignment?.project_id ? "No agents assigned to the current project." : "No agents registered.";
      return ok(emptyLabel);
    }
    const header = assignment?.project_id ? `Current project agents (${assignment.name}):` : "Global agents:";
    const text = agents.map((agent) => `- ${agent.name} [${agent.status}]${agent.role ? ` (${agent.role})` : ""}`).join("\n");
    return ok(`${header}\n${text}`);
  },
}));

addTool(defineTool({
  name: "get_shared_file_meta",
  description: "Get metadata for a shared file without loading full content.",
  schema: {
    path: z.string().describe("File path relative to shared directory"),
  },
  handbook: {
    audience: ["core"],
    priority: "medium",
    when_to_use: [
      "Use to check whether a shared file exists or changed before loading its full content.",
    ],
    pitfalls: [
      "This only returns metadata; call read_shared_file if you need the actual contents.",
    ],
    related_tools: ["read_shared_file", "list_shared_files"],
    recovery_notes: [
      "Useful after a restart when you want to validate whether an artifact changed without consuming much context.",
    ],
    examples: [
      { title: "Inspect report timestamp", invocation: 'get_shared_file_meta(path="reports/validation.md")' },
    ],
    keywords: ["metadata", "artifact", "shared file"],
  },
  handler: async ({ path }) => {
    const files = await client.listSharedFiles(await getAgentProjectScope());
    const file = files.find((entry) => entry.path === path);
    if (!file) {
      return ok(`File not found: ${path}`);
    }
    return ok(
      `${file.path} | ${file.size_bytes} bytes | ${file.scope_type || "global"}${file.scope_name ? `:${file.scope_name}` : ""} | by ${file.created_by} | updated ${new Date(file.updated_at).toLocaleString()}${file.description ? ` | ${file.description}` : ""}`,
    );
  },
}));

addTool(defineTool({
  name: "read_shared_file",
  description: "Read a shared team file.",
  schema: {
    path: z.string().describe("File path relative to shared directory"),
  },
  handbook: {
    audience: ["core"],
    priority: "medium",
    when_to_use: [
      "Use when another agent said the details live in a shared artifact or you need the source of truth without opening local files directly.",
    ],
    pitfalls: [
      "Scope resolution follows the current project/workplace. Ambiguous filenames are better checked with list_shared_files first.",
    ],
    related_tools: ["list_shared_files", "write_shared_file", "get_shared_file_meta"],
    recovery_notes: [
      "Shared files are good for compact recovery because they often hold reports or plans instead of long chat threads.",
    ],
    examples: [
      { title: "Read spec draft", invocation: 'read_shared_file(path="specs/agent-plan.md")' },
    ],
    keywords: ["artifact", "shared", "file", "read"],
  },
  handler: async ({ path }) => {
    const file = await client.readSharedFile(path, await getAgentProjectScope());
    return ok(
      `File: ${file.path}\nScope: ${file.scope_type || "global"}${file.scope_id ? ` (${file.scope_id})` : ""}\nAuthor: ${file.created_by}\nUpdated: ${new Date(file.updated_at).toLocaleString()}\n\n${file.content}`,
    );
  },
}));

addTool(defineTool({
  name: "write_shared_file",
  description: "Write or update a shared team file.",
  schema: {
    path: z.string().describe("File path relative to shared directory"),
    content: z.string().describe("File content to write"),
    description: z.string().optional().describe("Brief description of the file"),
    artifact_kind: z.enum(["canonical", "derived"]).optional().describe("Canonical assets stay in the project root; derived artifacts go to the workplace"),
  },
  handbook: {
    audience: ["core"],
    priority: "medium",
    when_to_use: [
      "Use when results are too detailed for chat or should be shared with the team as an artifact.",
    ],
    pitfalls: [
      "Choose canonical for long-lived source-of-truth docs and derived for temporary outputs, reports, or generated artifacts.",
    ],
    related_tools: ["read_shared_file", "list_shared_files"],
    recovery_notes: [
      "Writing the current checkpoint to a shared file can reduce the amount of context that must survive chat compression.",
    ],
    examples: [
      { title: "Write validation report", invocation: 'write_shared_file(path="reports/validation.md", content="# Report", artifact_kind="derived")' },
    ],
    keywords: ["write artifact", "shared file", "report"],
  },
  handler: async ({ path, content, description, artifact_kind }) => {
    const scope = await getAgentProjectScope();
    await client.writeSharedFile(agentName, path, content, description, {
      ...scope,
      artifactKind: artifact_kind,
    });
    return ok(`File written: ${path}${artifact_kind ? ` [${artifact_kind}]` : ""}`);
  },
}));

addTool(defineTool({
  name: "list_shared_files",
  description: "List shared team files in the current scope.",
  schema: emptySchema,
  handbook: {
    audience: ["core"],
    priority: "medium",
    when_to_use: [
      "Use when you need to discover available artifacts before reading one directly.",
    ],
    related_tools: ["read_shared_file", "get_shared_file_meta"],
    recovery_notes: [
      "Useful after a restart when you remember that a report exists but not its exact path.",
    ],
    examples: [
      { title: "List artifacts", invocation: "list_shared_files()" },
    ],
    keywords: ["artifacts", "shared files", "list"],
  },
  handler: async () => {
    const files = await client.listSharedFiles(await getAgentProjectScope());
    if (files.length === 0) {
      return ok("No shared files yet.");
    }
    const text = files
      .map((file) => `- [${file.scope_type || "global"}${file.scope_name ? `:${file.scope_name}` : ""}] ${file.path} (${file.size_bytes} bytes, by ${file.created_by})${file.description ? `: ${file.description}` : ""}`)
      .join("\n");
    return ok(text);
  },
}));

addTool(defineTool({
  name: "save_worklog",
  description: "Save your current task state for recovery after session restart.",
  schema: {
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
  handbook: {
    audience: ["core"],
    priority: "high",
    when_to_use: [
      "Use before a long-running task, before a forced restart, and after meaningful progress checkpoints.",
    ],
    when_not_to_use: [
      "Do not spam it after every message; save only state worth recovering.",
    ],
    pitfalls: [
      "If current_task is null, include enough key_context that another session can still resume safely.",
    ],
    related_tools: ["load_worklog", "reflect_on_task"],
    recovery_notes: [
      "This is the first half of restart resilience. tool_preflight covers tool recall; worklog covers task state.",
    ],
    examples: [
      { title: "Checkpoint current task", invocation: 'save_worklog(current_task={description:"audit",status:"in_progress",progress:"verified API",subtasks_done:["checked chat"],next_step:"inspect tests",blockers:[]})' },
    ],
    keywords: ["checkpoint", "recovery", "resume", "worklog"],
  },
  handler: async ({ current_task, recent_decisions, working_files, key_context }) => {
    const worklog: client.Worklog = {
      agent_name: agentName,
      updated_at: new Date().toISOString(),
      current_task: current_task || null,
      recent_decisions: recent_decisions || [],
      working_files: working_files || [],
      key_context: key_context || "",
    };
    await client.saveWorklog(agentName, worklog);
    return ok("Worklog saved.");
  },
}));

addTool(defineTool({
  name: "load_worklog",
  description: "Load your previous task state after session restart.",
  schema: emptySchema,
  handbook: {
    audience: ["core"],
    priority: "high",
    when_to_use: [
      "Use first during session recovery to recall task state from the prior run.",
    ],
    pitfalls: [
      "Worklog does not replace tool_preflight; it restores task context, not tool-operating guidance.",
    ],
    related_tools: ["save_worklog", "tool_preflight", "read_chat"],
    recovery_notes: [
      "Safe before preflight and required in the author/integrator recovery sequence.",
    ],
    examples: [
      { title: "Resume previous session", invocation: "load_worklog()" },
    ],
    keywords: ["resume", "restart", "recovery", "worklog"],
  },
  handler: async () => {
    const result = await client.loadWorklog(agentName);
    if (!result.exists || !result.worklog) {
      return ok("No previous worklog found. Starting fresh.");
    }
    return ok(`Previous worklog (saved ${result.worklog.updated_at}):\n\n${JSON.stringify(result.worklog, null, 2)}`);
  },
}));

addTool(defineTool({
  name: "tool_preflight",
  description: "Refresh your tool operating memory for the current handbook version. Required before using guarded tools after restart or tool changes.",
  schema: emptySchema,
  handbook: {
    audience: ["core"],
    priority: "high",
    when_to_use: [
      "Use during startup recovery after load_worklog and before you resume guarded work.",
      "Use immediately when the bridge tells you preflight is required.",
    ],
    when_not_to_use: [
      "Do not skip it for author or integrator after a restart or tool catalog change.",
    ],
    pitfalls: [
      "This is the only tool that clears the bridge-side preflight guard for protected agents.",
    ],
    related_tools: ["tool_handbook", "load_worklog", "read_chat"],
    recovery_notes: [
      "This acknowledges the current tool catalog and persists it in .crew/tool-memory-state.json.",
    ],
    examples: [
      { title: "Startup recovery", invocation: "tool_preflight()" },
    ],
    keywords: ["preflight", "tool memory", "startup", "recovery"],
  },
  handler: async () => {
    const payload = buildToolPreflight(agentName, toolDefinitions, persistedToolState);
    saveToolMemoryState(agentName, payload.state);
    persistedToolState = payload.state;
    preflightRequired = false;
    return ok(
      `profile=${payload.profile}\nhandbook_version=${payload.handbook_version}\nchanged_tools=${payload.changed_tools.join(",") || "none"}\n\n${payload.summary}`,
    );
  },
}));

addTool(defineTool({
  name: "tool_handbook",
  description: "Read detailed tool recipes by intent or tool name. Use this when tool usage is unclear after compression or a restart.",
  schema: {
    query: z.string().optional().describe("Intent or keyword query, e.g. 'create agent' or 'validation workflow'"),
    tool_names: z.array(z.string()).optional().describe("Exact tool names to expand"),
    include_examples: z.boolean().optional().describe("Include example invocations"),
  },
  handbook: {
    audience: ["core"],
    priority: "high",
    when_to_use: [
      "Use when you remember the capability but not the exact parameters, sequencing, or failure modes.",
    ],
    pitfalls: [
      "Prefer exact tool_names when you already know the candidate tool; use query when you only know the task intent.",
    ],
    related_tools: ["tool_preflight"],
    recovery_notes: [
      "Safe before preflight so agents can self-serve usage guidance instead of guessing.",
    ],
    examples: [
      { title: "Look up project assignment flow", invocation: 'tool_handbook(query="project assignment", include_examples=true)' },
      { title: "Expand a known tool", invocation: 'tool_handbook(tool_names=["create_agent"], include_examples=true)' },
    ],
    keywords: ["sop", "handbook", "tool usage", "parameters"],
  },
  handler: async ({ query, tool_names, include_examples }) => {
    const payload = buildToolHandbook(agentName, toolDefinitions, {
      query,
      tool_names,
      include_examples,
    });
    return ok(`handbook_version=${payload.handbook_version}\n\n${payload.results}`);
  },
}));

addTool(defineTool({
  name: "set_agent_config",
  description: "Set runtime configuration for an agent. Only usable by the author agent. Claude agents support sonnet/opus plus effort. Codex agents also support sandbox and approval policy.",
  schema: {
    agent_name: z.string().describe("Target agent name"),
    model: z.string().optional().describe("Model to use"),
    effort: z.enum(["medium", "high", "max"]).optional().describe("Reasoning effort level"),
    approval_policy: z.enum(["untrusted", "on-request", "never"]).optional().describe("Tool approval policy"),
    sandbox_mode: z.enum(["read-only", "workspace-write", "danger-full-access"]).optional().describe("Sandbox mode"),
  },
  handbook: {
    audience: ["author"],
    priority: "high",
    when_to_use: [
      "Use when you intentionally want to change an agent's runtime model or sandbox configuration.",
    ],
    when_not_to_use: [
      "Do not use for routine delegation. Config changes restart or alter runtime behavior.",
    ],
    pitfalls: [
      "This tool can restart the target agent. Avoid changing config repeatedly in the middle of active work.",
    ],
    related_tools: ["request_agent_status", "restart_agent"],
    recovery_notes: [
      "After a restart or long session, re-check parameter names here instead of relying on memory.",
    ],
    examples: [
      { title: "Upgrade reasoning effort", invocation: 'set_agent_config(agent_name="coder", model="opus", effort="high")' },
    ],
    keywords: ["model", "effort", "sandbox", "approval", "config"],
  },
  handler: async ({ agent_name, model, effort, approval_policy, sandbox_mode }) => {
    const result = await client.setAgentConfig(agentName, agent_name, model, effort, approval_policy, sandbox_mode, true);
    const parts = [];
    if (model) parts.push(`model=${model}`);
    if (effort) parts.push(`effort=${effort}`);
    if (approval_policy) parts.push(`approval_policy=${approval_policy}`);
    if (sandbox_mode) parts.push(`sandbox_mode=${sandbox_mode}`);
    return ok(`Config updated for ${agent_name}: ${parts.join(", ")}. ${result.restarted ? "Agent restarted." : "Will apply on next restart."}`);
  },
}));

addTool(defineTool({
  name: "restart_agent",
  description: "Restart an agent runtime. Only usable by the author agent.",
  schema: {
    agent_name: z.string().describe("Target agent name"),
  },
  handbook: {
    audience: ["author"],
    priority: "high",
    when_to_use: [
      "Use after changing instructions or config, or when a runtime is clearly stuck and must be restarted.",
    ],
    when_not_to_use: [
      "Do not use as a substitute for interrupting or resuming work when the session is still healthy.",
    ],
    pitfalls: [
      "Integrator is protected. Restarting clears the live session state unless the agent saved its worklog.",
    ],
    related_tools: ["request_agent_status", "interrupt_agent", "resume_agent"],
    recovery_notes: [
      "Verify the target really needs a restart before using this, because it is disruptive.",
    ],
    examples: [
      { title: "Restart author-managed agent", invocation: 'restart_agent(agent_name="coder")' },
    ],
    keywords: ["restart", "agent runtime", "stuck"],
  },
  handler: async ({ agent_name }) => {
    const result = await client.restartAgent(agentName, agent_name);
    return ok(result.ok ? `Restarted ${agent_name}.` : `Failed to restart ${agent_name}.`);
  },
}));

addTool(defineTool({
  name: "interrupt_agent",
  description: "Interrupt the current work of an agent. Only usable by the author agent.",
  schema: {
    agent_name: z.string().describe("Target agent name"),
  },
  handbook: {
    audience: ["author"],
    priority: "medium",
    when_to_use: [
      "Use when an agent is running down the wrong path and you need it to stop before more drift occurs.",
    ],
    pitfalls: [
      "Interrupt is lighter than restart. Use it before escalating to a full reset or restart.",
    ],
    related_tools: ["resume_agent", "reset_agent_session", "request_agent_status"],
    recovery_notes: [
      "Integrator remains excluded even though the author can manage other agents.",
    ],
    examples: [
      { title: "Stop a drifting task", invocation: 'interrupt_agent(agent_name="coder")' },
    ],
    keywords: ["interrupt", "stop work", "drift"],
  },
  handler: async ({ agent_name }) => {
    const result = await client.interruptAgent(agentName, agent_name);
    return ok(result.ok ? `Interrupted ${agent_name}.` : `No active work to interrupt for ${agent_name}.`);
  },
}));

addTool(defineTool({
  name: "resume_agent",
  description: "Resume an interrupted or paused agent. Only usable by the author agent.",
  schema: {
    agent_name: z.string().describe("Target agent name"),
  },
  handbook: {
    audience: ["author"],
    priority: "medium",
    when_to_use: [
      "Use after an intentional interrupt when the existing session should continue from its current state.",
    ],
    pitfalls: [
      "Resume assumes the agent's session still has enough context. If not, restart it instead.",
    ],
    related_tools: ["interrupt_agent", "restart_agent"],
    recovery_notes: [
      "If you are unsure whether a session is still healthy, inspect runtime status first.",
    ],
    examples: [
      { title: "Continue paused work", invocation: 'resume_agent(agent_name="coder")' },
    ],
    keywords: ["resume", "continue", "paused"],
  },
  handler: async ({ agent_name }) => {
    const result = await client.resumeAgent(agentName, agent_name);
    return ok(result.ok ? `Resume requested for ${agent_name}.` : `Failed to resume ${agent_name}.`);
  },
}));

addTool(defineTool({
  name: "reset_agent_session",
  description: "Reset an agent session while preserving its workspace. Only usable by the author agent.",
  schema: {
    agent_name: z.string().describe("Target agent name"),
  },
  handbook: {
    audience: ["author"],
    priority: "medium",
    when_to_use: [
      "Use when the workspace should stay intact but the current session state is corrupted or too stale to trust.",
    ],
    pitfalls: [
      "This is more destructive than interrupt. Save or request a worklog checkpoint first when possible.",
    ],
    related_tools: ["restart_agent", "request_agent_status"],
    recovery_notes: [
      "Prefer reset over manual workspace edits when the problem is session state rather than files.",
    ],
    examples: [
      { title: "Clear session state", invocation: 'reset_agent_session(agent_name="coder")' },
    ],
    keywords: ["reset session", "clear context", "agent state"],
  },
  handler: async ({ agent_name }) => {
    const result = await client.resetAgentSession(agentName, agent_name);
    return ok(result.ok ? `Session reset for ${agent_name}.` : `Failed to reset ${agent_name}.`);
  },
}));

addTool(defineTool({
  name: "request_agent_status",
  description: "Get detailed runtime status for an agent. Usable by the author agent, and by integrator for audit and validation.",
  schema: {
    agent_name: z.string().describe("Target agent name"),
  },
  handbook: {
    audience: ["author", "integrator"],
    priority: "high",
    when_to_use: [
      "Use to verify whether an agent is alive, busy, blocked on approval, or running with the expected config.",
    ],
    pitfalls: [
      "Status is observational; it does not change the runtime by itself.",
    ],
    related_tools: ["restart_agent", "interrupt_agent"],
    recovery_notes: [
      "Integrator should use this for validation and monitoring, not control-plane changes.",
    ],
    examples: [
      { title: "Inspect runtime", invocation: 'request_agent_status(agent_name="coder")' },
    ],
    keywords: ["status", "runtime", "audit", "health"],
  },
  handler: async ({ agent_name }) => {
    const result = await client.getAgentRuntimeStatus(agent_name);
    return ok(`Agent ${result.name} [provider=${result.provider}] state=${result.runtimeState}, context=${result.contextPercent}%\nconfig=${JSON.stringify(result.config)}`);
  },
}));

addTool(defineTool({
  name: "create_agent",
  description: "Create a new agent with custom CLAUDE.md instructions and optionally start it. Only usable by the author agent. The protected integrator agent cannot be recreated or overwritten.",
  schema: {
    name: z.string().describe("Agent name (alphanumeric and hyphens only)"),
    role: z.string().describe("Agent role description"),
    instructions: z.string().optional().describe("Full custom CLAUDE.md content"),
    wake: z.boolean().optional().describe("Start the agent immediately (default: true)"),
    permissions: z.array(z.string()).optional().describe("MCP tool permissions to auto-allow"),
  },
  handbook: {
    audience: ["author"],
    priority: "high",
    when_to_use: [
      "Use after the agent role, boundaries, and instructions are stable enough to materialize a new agent workspace.",
    ],
    when_not_to_use: [
      "Do not use to change existing project membership. Use assign_agent_to_project for that.",
    ],
    pitfalls: [
      "Instructions should be the full CLAUDE.md, not a partial patch. Integrator is explicitly excluded.",
    ],
    related_tools: ["assign_agent_to_project", "update_agent_instructions", "request_agent_status"],
    recovery_notes: [
      "This is one of the highest-risk author tools. If parameter names are fuzzy, expand it with tool_handbook before calling it.",
    ],
    examples: [
      { title: "Create a reviewer", invocation: 'create_agent(name="reviewer", role="Code reviewer", instructions="# Agent: reviewer...", wake=true)' },
    ],
    keywords: ["create agent", "deploy agent", "new agent"],
  },
  handler: async ({ name, role, instructions, wake, permissions }) => {
    const result = await client.createAgent(agentName, name, role, instructions, wake, permissions);
    return ok(`Agent "${name}" created (role: ${role}). Workspace: ${result.workspace}. ${result.woke ? "Agent started." : result.wakeError ? `Wake failed: ${result.wakeError}` : "Agent not started yet."}`);
  },
}));

addTool(defineTool({
  name: "update_agent_instructions",
  description: "Update an existing agent's CLAUDE.md instructions. Only usable by the author agent. Integrator is excluded.",
  schema: {
    agent_name: z.string().describe("Target agent name"),
    instructions: z.string().describe("New full CLAUDE.md content"),
  },
  handbook: {
    audience: ["author"],
    priority: "high",
    when_to_use: [
      "Use when an existing Claude agent's operating instructions must be replaced with a new full instruction file.",
    ],
    pitfalls: [
      "This replaces the entire CLAUDE.md. Restart the target afterward, and never use it on integrator.",
    ],
    related_tools: ["create_agent", "restart_agent"],
    recovery_notes: [
      "If you only need to change project membership or runtime config, use the dedicated tools instead.",
    ],
    examples: [
      { title: "Replace instructions", invocation: 'update_agent_instructions(agent_name="reviewer", instructions="# Agent: reviewer...")' },
    ],
    keywords: ["instructions", "claude.md", "agent prompt"],
  },
  handler: async ({ agent_name, instructions }) => {
    await client.updateAgentInstructions(agentName, agent_name, instructions);
    return ok(`Instructions updated for ${agent_name}. Restart the agent to apply changes.`);
  },
}));

addTool(defineTool({
  name: "assign_agent_to_project",
  description: "Assign an existing agent to a project. Only usable by the author agent. Defaults to your current project if project_id is omitted.",
  schema: {
    agent_name: z.string().describe("Existing agent name to assign"),
    role_in_project: z.string().optional().describe("Role description for this project assignment"),
    assignment_type: z.enum(["dedicated", "shared"]).optional().describe("Assignment mode (default: dedicated)"),
    project_id: z.string().optional().describe("Target project ID"),
  },
  handbook: {
    audience: ["author"],
    priority: "high",
    when_to_use: [
      "Use to formally add an existing agent to the current or specified project without editing project files by hand.",
    ],
    when_not_to_use: [
      "Do not hand-edit a project's CLAUDE.md team section to simulate membership changes.",
    ],
    pitfalls: [
      "If project_id is omitted, the assignment is resolved from the author's current project. Make sure you are in the right project first.",
    ],
    related_tools: ["create_agent", "get_project_context", "list_agents"],
    recovery_notes: [
      "This is the correct fix for roster changes. Manual file edits are not durable system state.",
    ],
    examples: [
      { title: "Add existing agent to current project", invocation: 'assign_agent_to_project(agent_name="integrator", role_in_project="Independent auditor", assignment_type="shared")' },
    ],
    keywords: ["assign agent", "project membership", "team roster"],
  },
  handler: async ({ agent_name, role_in_project, assignment_type, project_id }) => {
    let projectId = project_id;
    let projectName = project_id;
    if (!projectId) {
      const assignment = await client.getAgentCurrentProject(agentName);
      if (!assignment) {
        return failure("You are not assigned to any active project.");
      }
      projectId = assignment.project_id;
      projectName = assignment.name;
    }
    const result = await client.assignAgentToProject(projectId, agent_name, role_in_project, assignment_type);
    return ok(`Assigned ${agent_name} to project ${projectName || projectId} as ${role_in_project || "team member"} (${result.assignment_type}). Project context and CLAUDE.md were refreshed.`);
  },
}));

addTool(defineTool({
  name: "get_project_context",
  description: "Get your current project context including description, tech stack, standards, and team.",
  schema: {
    project_id: z.string().optional().describe("Project ID (auto-detected if omitted)"),
  },
  handbook: {
    audience: ["core"],
    priority: "high",
    when_to_use: [
      "Use to refresh the current project's boundaries, standards, and roster mid-session or after a roster change.",
    ],
    pitfalls: [
      "This returns project facts, not arbitrary chat decisions. Use read_chat or search_chat for conversational history.",
    ],
    related_tools: ["list_agents", "read_chat"],
    recovery_notes: [
      "Use when you suspect cached roster or project facts may have changed since your last run.",
    ],
    examples: [
      { title: "Refresh active project context", invocation: "get_project_context()" },
    ],
    keywords: ["project context", "team", "standards", "roster"],
  },
  handler: async ({ project_id }) => {
    let projectId = project_id;
    if (!projectId) {
      const assignment = await client.getAgentCurrentProject(agentName);
      if (!assignment) {
        return ok("You are not assigned to any active project.");
      }
      projectId = assignment.project_id;
    }
    const result = await client.getProjectContext(projectId);
    return ok(result.context);
  },
}));

addTool(defineTool({
  name: "memory_search",
  description: "Search your memory. Returns decay-weighted results and is best for recalling prior decisions, preferences, or project context.",
  schema: {
    query: z.string().describe("Search query"),
    category: z.string().optional().describe("Filter: contact, preference, decision, project, pattern, feedback, daily"),
    include_weak: z.boolean().optional().describe("Include low-strength memories"),
    limit: z.number().optional().describe("Max results (default 5, max 20)"),
    project_id: z.string().optional().describe("Scope search to a specific project"),
  },
  handbook: {
    audience: ["core"],
    priority: "medium",
    when_to_use: [
      "Use when starting a new topic or when you need to recover a prior decision, preference, or project memory.",
    ],
    when_not_to_use: [
      "Do not use for every routine message relay.",
    ],
    pitfalls: [
      "memory_search returns summaries; use memory_read(id) to inspect full details before acting on an important memory.",
    ],
    related_tools: ["memory_read", "memory_write", "memory_status"],
    recovery_notes: [
      "Tool memory lives outside this system. Use memory for semantic facts, not parameter recall.",
    ],
    examples: [
      { title: "Recover project decision", invocation: 'memory_search(query="agent roster policy", project_id="proj-123")' },
    ],
    keywords: ["memory", "recall", "decision", "preference"],
  },
  handler: async ({ query, category, include_weak, limit, project_id }) => {
    const result = await client.memorySearch(query, agentName, category, include_weak, limit, true, project_id);
    if (result.count === 0) {
      return ok("No matching memories found.");
    }
    const lines = result.entries.map((entry) => `[${entry.category}] ${entry.heading} (strength: ${Math.round(entry.retrievability * 100)}%, id: ${entry.id})`);
    return ok(`Found ${result.count} memor${result.count === 1 ? "y" : "ies"}:\n${lines.join("\n")}\n\nUse memory_read(id) to expand details.`);
  },
}));

addTool(defineTool({
  name: "memory_read",
  description: "Read full content of a memory entry by ID. This also reinforces the memory.",
  schema: {
    id: z.string().describe("Memory entry ID"),
  },
  handbook: {
    audience: ["core"],
    priority: "medium",
    when_to_use: [
      "Use after memory_search when a retrieved memory may affect a decision or action.",
    ],
    related_tools: ["memory_search"],
    recovery_notes: [
      "Good for factual recall, but not a replacement for tool_preflight.",
    ],
    examples: [
      { title: "Open a retrieved memory", invocation: 'memory_read(id="1234-5678")' },
    ],
    keywords: ["read memory", "details"],
  },
  handler: async ({ id }) => {
    const entry = await client.memoryRead(id);
    return ok(`[${entry.category}] ${entry.heading}\nStatus: ${entry.status} | Accessed: ${entry.access_count}x | Strength: ${Math.round(entry.retrievability * 100)}%\n\n${entry.content}`);
  },
}));

addTool(defineTool({
  name: "memory_write",
  description: "Record a new memory. Contacts and preferences never decay; daily notes decay fastest.",
  schema: {
    category: z.enum(["contact", "preference", "decision", "project", "pattern", "feedback", "daily"]).describe("Memory category"),
    heading: z.string().describe("One-line summary"),
    content: z.string().describe("Full memory content"),
    importance: z.number().optional().describe("Importance 1-5"),
    emotional_weight: z.number().optional().describe("1.0-2.0"),
    project_id: z.string().optional().describe("Associate memory with a specific project"),
  },
  handbook: {
    audience: ["core"],
    priority: "medium",
    when_to_use: [
      "Use when the user states a preference, makes a durable decision, or explicitly asks you to remember something.",
    ],
    when_not_to_use: [
      "Do not dump raw transient scratch notes here if a worklog is the right place.",
    ],
    pitfalls: [
      "Project and decision memories are durable context; choose those categories instead of daily when the fact should survive.",
    ],
    related_tools: ["memory_search", "memory_status"],
    recovery_notes: [
      "Store human decisions or audit baselines here, not tool parameter recipes.",
    ],
    examples: [
      { title: "Store project vision", invocation: 'memory_write(category="project", heading="Vision", content="User wants...", importance=5)' },
    ],
    keywords: ["write memory", "remember", "decision", "preference"],
  },
  handler: async ({ category, heading, content, importance, emotional_weight, project_id }) => {
    try {
      const result = await client.memoryWrite(agentName, category, heading, content, importance, emotional_weight, project_id);
      return ok(`Memory saved (id: ${result.id}, status: ${result.status}, strength: ${Math.round(result.retrievability * 100)}%)`);
    } catch (err) {
      const message = (err as Error).message;
      if (message.includes("duplicate")) {
        return ok("Memory already exists (duplicate content detected).");
      }
      throw err;
    }
  },
}));

addTool(defineTool({
  name: "memory_status",
  description: "View memory health: total count, category breakdown, average strength, and recently accessed entries.",
  schema: {
    project_id: z.string().optional().describe("Scope stats to a specific project"),
  },
  handbook: {
    audience: ["core"],
    priority: "medium",
    when_to_use: [
      "Use during startup or cleanup to understand whether your memory base is healthy and project-scoped as expected.",
    ],
    related_tools: ["memory_search", "memory_write"],
    recovery_notes: [
      "Author and integrator should include this in broader recovery, but after worklog and tool_preflight.",
    ],
    examples: [
      { title: "Check project memory health", invocation: 'memory_status(project_id="proj-123")' },
    ],
    keywords: ["memory health", "status", "consolidation"],
  },
  handler: async ({ project_id }) => {
    const stats = await client.memoryStats(agentName, project_id);
    const lines = [
      `Total memories: ${stats.total}`,
      `By status: ${Object.entries(stats.by_status).map(([key, value]) => `${key}=${value}`).join(", ") || "none"}`,
      `By category: ${Object.entries(stats.by_category).map(([key, value]) => `${key}=${value}`).join(", ") || "none"}`,
      `Avg strength: ${stats.avg_retrievability !== null ? `${Math.round(stats.avg_retrievability * 100)}%` : "N/A"}`,
    ];
    if (stats.recently_accessed.length > 0) {
      lines.push("", "Recently accessed:");
      for (const item of stats.recently_accessed) {
        lines.push(`  [${item.category}] ${item.heading} (${item.access_count}x)`);
      }
    }
    return ok(lines.join("\n"));
  },
}));

addTool(defineTool({
  name: "reflect_on_task",
  description: "Submit a structured reflection after completing a task, including lessons learned and optional standard updates.",
  schema: {
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
      current_text: z.string().optional().describe("Current standard text"),
      proposed_text: z.string().describe("Proposed new text"),
      rationale: z.string().describe("Why this change is beneficial"),
      confidence: z.number().describe("0-1 confidence in this proposal"),
    })).optional().describe("Proposed updates to shared standards"),
    confidence: z.number().optional().describe("Overall reflection confidence (0-1, default 0.5)"),
  },
  handbook: {
    audience: ["core"],
    priority: "medium",
    when_to_use: [
      "Use after task completion, project milestones, or session cycles to capture learnings while they are still fresh.",
    ],
    related_tools: ["save_worklog", "propose_standard_update"],
    recovery_notes: [
      "Useful for long-term process learning, not immediate tool recall.",
    ],
    examples: [
      { title: "Record milestone reflection", invocation: 'reflect_on_task(project_id="proj-123", trigger_type="task_complete", task_summary="Validated API")' },
    ],
    keywords: ["reflection", "lessons learned", "process"],
  },
  handler: async ({ project_id, trigger_type, task_summary, lessons_learned, proposed_updates, confidence }) => {
    const result = await client.submitReflection(
      agentName,
      project_id,
      trigger_type,
      task_summary,
      lessons_learned || [],
      proposed_updates || [],
      confidence || 0.5,
    );
    const autoSummary = result.auto_results.length > 0
      ? `\n${result.auto_results.map((item) => `  [${item.index}] ${item.action}: ${item.reason}`).join("\n")}`
      : "";
    return ok(`Reflection submitted (id: ${result.id}, status: ${result.status})${autoSummary}`);
  },
}));

addTool(defineTool({
  name: "propose_standard_update",
  description: "Propose a single update to shared coding standards.",
  schema: {
    project_id: z.string().describe("Project ID for context"),
    action: z.enum(["add", "modify", "remove"]).describe("Type of update"),
    section: z.string().describe("Standard name/section to update"),
    current_text: z.string().optional().describe("Current text"),
    proposed_text: z.string().describe("Proposed text"),
    rationale: z.string().describe("Why this standard should be adopted"),
    confidence: z.number().describe("0-1 confidence level"),
  },
  handbook: {
    audience: ["core"],
    priority: "low",
    when_to_use: [
      "Use when you see a repeated pattern worth standardizing beyond a single task.",
    ],
    related_tools: ["reflect_on_task"],
    recovery_notes: [
      "Not part of startup recovery. Use only when you have enough evidence.",
    ],
    examples: [
      { title: "Propose a new standard", invocation: 'propose_standard_update(project_id="proj-123", action="add", section="Testing", proposed_text="...", rationale="...", confidence=0.9)' },
    ],
    keywords: ["standard", "policy", "sop"],
  },
  handler: async ({ project_id, action, section, current_text, proposed_text, rationale, confidence }) => {
    const result = await client.proposeStandardUpdate(agentName, project_id, {
      action,
      section,
      current_text,
      proposed_text,
      rationale,
      confidence,
    });
    const autoResult = result.auto_results[0];
    const outcome = autoResult ? `${autoResult.action}: ${autoResult.reason}` : "submitted for review";
    return ok(`Standard update proposed (id: ${result.id}, status: ${result.status})\nOutcome: ${outcome}`);
  },
}));

addTool(defineTool({
  name: "escalate_peak",
  description: "Escalate a decision to the human operator (Peak).",
  schema: {
    peak_type: z.enum(["irreversibility", "multiple_paths", "info_asymmetry", "drift_check"]).describe("Type of peak"),
    context: z.string().describe("Situation requiring human judgment"),
    options: z.array(z.object({
      label: z.string().describe("Short name for the option"),
      pros: z.string().describe("Advantages"),
      cons: z.string().describe("Disadvantages"),
    })).describe("At least 2 options (except drift_check which can have 0)"),
    agent_lean: z.string().optional().describe("Which option you'd recommend and why"),
    default_option: z.number().optional().describe("Index of option to auto-choose on timeout"),
    timeout_seconds: z.number().optional().describe("Seconds to wait for human"),
    project_id: z.string().optional().describe("Project ID for context"),
  },
  handbook: {
    audience: ["core"],
    priority: "high",
    when_to_use: [
      "Use when the task reaches irreversibility, multiple viable paths, information asymmetry, or a drift check moment.",
    ],
    pitfalls: [
      "Provide concrete options and context; weak escalations waste the user's decision bandwidth.",
    ],
    related_tools: ["check_peak_decision", "memory_write"],
    recovery_notes: [
      "PEAK decisions outlive the session. Capture them clearly and store downstream outcomes in memory or worklog as needed.",
    ],
    examples: [
      { title: "Escalate architecture choice", invocation: 'escalate_peak(peak_type="multiple_paths", context="Choose team topology", options=[...])' },
    ],
    keywords: ["peak", "escalation", "human decision", "drift check"],
  },
  handler: async ({ peak_type, context, options, agent_lean, default_option, timeout_seconds, project_id }) => {
    const result = await client.escalatePeak(agentName, project_id, peak_type, context, options, agent_lean, default_option, timeout_seconds);
    const expiresIn = Math.round((result.expires_at - Date.now()) / 1000);
    return ok(`Peak escalated (id: ${result.id}, type: ${peak_type})\nStatus: ${result.status}\nExpires in: ${expiresIn}s\nDefault option: ${default_option ?? 0}\n\nUse check_peak_decision("${result.id}") to poll for the human's decision.`);
  },
}));

addTool(defineTool({
  name: "check_peak_decision",
  description: "Check whether a human has decided on a previously escalated peak.",
  schema: {
    peak_id: z.string().describe("The peak ID returned from escalate_peak"),
  },
  handbook: {
    audience: ["core"],
    priority: "medium",
    when_to_use: [
      "Use after escalating to see whether the human resolved the decision yet.",
    ],
    related_tools: ["escalate_peak"],
    recovery_notes: [
      "Use after read_chat if you need to resume a previously pending escalation.",
    ],
    examples: [
      { title: "Poll a pending decision", invocation: 'check_peak_decision(peak_id="peak-123")' },
    ],
    keywords: ["peak status", "decision polling"],
  },
  handler: async ({ peak_id }) => {
    const result = await client.checkPeakDecision(peak_id);
    if (result.status === "pending") {
      return ok(`Peak ${peak_id} is still pending. The human has not decided yet. You can continue other work and check back later.`);
    }
    const chosen = result.options[result.decision_index ?? 0];
    const chosenLabel = chosen ? chosen.label : "unknown";
    return ok(`Peak ${peak_id} resolved!\nStatus: ${result.status}\nDecision: option ${result.decision_index} - "${chosenLabel}"\nDecided by: ${result.decided_by || "unknown"}\n${result.decision_note ? `Note: ${result.decision_note}` : ""}\n\nProceed with the chosen option.`);
  },
}));

const preflightCheck = computePreflightRequirement(agentName, toolDefinitions, persistedToolState);
preflightRequired = preflightCheck.required;

for (const definition of toolDefinitions) {
  registerTool(definition);
}

async function startup() {
  try {
    await client.register(agentName, agentRole);
    const profile = getToolProfile(agentName);
    const guardNote = preflightRequiredForAgent(agentName)
      ? ` preflight=${preflightRequired ? "required" : "ready"} profile=${profile} handbook=${TOOL_HANDBOOK_VERSION}`
      : "";
    console.error(`[claude-crew-bridge] agent "${agentName}" registered.${guardNote}`);
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

await startup();
const transport = new StdioServerTransport();
await server.connect(transport);
