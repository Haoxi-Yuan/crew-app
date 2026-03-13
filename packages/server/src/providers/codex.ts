import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import WebSocket from "ws";
import { buildAgentWorkspaceEnv } from "../agent-context.js";
import { PROJECT_ROOT } from "../config.js";
import { broadcast } from "../ws/handler.js";
import { getDb } from "../db/index.js";
import {
  DEFAULT_PROVIDER,
  type AgentProvider,
  type ApprovalPolicy,
  type SandboxMode,
  getAgentRuntimeConfig,
  mergeAgentMetadata,
  clearAgentMetadataKeys,
} from "../agent-runtime.js";

const execFileAsync = promisify(execFile);
const AGENTS_DIR = path.join(PROJECT_ROOT, "agents");
const BRIDGE_PATH = path.join(PROJECT_ROOT, "packages/mcp-bridge/dist/index.js");

export type ProviderRuntimeState = "idle" | "busy" | "approval_pending" | "no_session";

export interface ProviderApproval {
  id: string;
  provider: AgentProvider;
  agentName: string;
  toolServer: string;
  toolName: string;
  params: string;
  description: string;
  options: { key: string; label: string }[];
  promptType: "tool_use" | "mcp_setup" | "command_execution" | "file_change" | "skill_request" | "user_input";
  detectedAt: number;
  requestId?: number | string;
  questionIds?: string[];
}

interface PendingRpcRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

interface CodexSession {
  agentName: string;
  role: string;
  agentDir: string;
  process: ChildProcessWithoutNullStreams;
  socket: WebSocket | null;
  nextId: number;
  threadId?: string;
  activeTurnId?: string;
  pending: Map<number, PendingRpcRequest>;
  ready: Promise<void>;
  readyResolve: () => void;
  readyReject: (error: Error) => void;
  stopping: boolean;
}

const sessions = new Map<string, CodexSession>();
const approvalByAgent = new Map<string, ProviderApproval>();
const stateByAgent = new Map<string, ProviderRuntimeState>();
const contentByAgent = new Map<string, string>();
const contextByAgent = new Map<string, number>();

function escapeToml(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"");
}

function getAgentDir(agentName: string): string {
  return path.join(AGENTS_DIR, agentName);
}

function getAgentRole(agentName: string): string {
  const db = getDb();
  const row = db.prepare("SELECT role FROM agents WHERE name = ?").get(agentName) as { role?: string } | undefined;
  return row?.role || "";
}

function findNodePath(): string {
  if (process.execPath && fs.existsSync(process.execPath)) {
    return process.execPath;
  }
  try {
    return execFileSync("which", ["node"]).toString().trim();
  } catch {
    return "/Users/yuan/.nvm/versions/node/v22.14.0/bin/node";
  }
}

function findCodexPath(): string {
  try {
    return execFileSync("which", ["codex"]).toString().trim();
  } catch {
    const fallback = "/Users/yuan/.nvm/versions/node/v22.14.0/bin/codex";
    return fs.existsSync(fallback) ? fallback : "";
  }
}

function appendActivity(agentName: string, chunk: string): void {
  const previous = contentByAgent.get(agentName) || "";
  const next = `${previous}${chunk}`.slice(-50_000);
  contentByAgent.set(agentName, next);
  broadcast({ type: "agent:terminal", data: { name: agentName, content: next } });
}

function setState(agentName: string, next: ProviderRuntimeState): void {
  const prev = stateByAgent.get(agentName) || "no_session";
  if (prev === next) return;
  stateByAgent.set(agentName, next);
  broadcast({ type: "agent:tmux_state", data: { name: agentName, tmuxState: next } });
  if (next === "busy" && prev !== "busy") {
    markRecentMentionsAsRead(agentName);
  }
}

function markRecentMentionsAsRead(agentName: string): void {
  try {
    const db = getDb();
    const result = db
      .prepare(
        "UPDATE pending_mentions SET delivery_status = 'read' WHERE agent_name = ? AND delivery_status = 'delivered'"
      )
      .run(agentName);

    if (result.changes > 0) {
      const updated = db
        .prepare(
          "SELECT DISTINCT message_id FROM pending_mentions WHERE agent_name = ? AND delivery_status = 'read'"
        )
        .all(agentName) as { message_id: number }[];

      for (const row of updated) {
        broadcast({
          type: "message:status",
          data: { messageId: row.message_id, agentName, status: "read" },
        });
      }
    }
  } catch {
    // Best effort.
  }
}

function mapThreadStatus(status: unknown): ProviderRuntimeState {
  if (!status || typeof status !== "object") {
    return "idle";
  }
  const type = (status as { type?: string }).type;
  if (type === "active") {
    const flags = Array.isArray((status as { activeFlags?: string[] }).activeFlags)
      ? (status as { activeFlags: string[] }).activeFlags
      : [];
    return flags.includes("waitingOnApproval") || flags.includes("waitingOnUserInput")
      ? "approval_pending"
      : "busy";
  }
  if (type === "systemError" || type === "notLoaded") {
    return "no_session";
  }
  return "idle";
}

function describeItem(item: unknown): string {
  if (!item || typeof item !== "object") return "activity";
  const typed = item as { type?: string; command?: string; server?: string; tool?: string; text?: string };
  switch (typed.type) {
    case "commandExecution":
      return `command: ${typed.command || ""}`;
    case "mcpToolCall":
      return `mcp: ${typed.server || "server"}#${typed.tool || "tool"}`;
    case "agentMessage":
      return typed.text || "agent message";
    default:
      return typed.type || "activity";
  }
}

function buildApprovalForRequest(agentName: string, msg: { id?: number | string; method?: string; params?: Record<string, unknown> }): ProviderApproval | null {
  const method = msg.method || "";
  const params = msg.params || {};
  const base = {
    id: `codex-${agentName}-${Date.now()}`,
    provider: "codex" as const,
    agentName,
    detectedAt: Date.now(),
    requestId: msg.id,
  };

  if (method === "item/commandExecution/requestApproval") {
    const command = typeof params.command === "string" ? params.command : "";
    return {
      ...base,
      toolServer: "codex",
      toolName: "Command Execution",
      params: command,
      description: typeof params.reason === "string" ? params.reason : "Codex requests command approval.",
      options: [
        { key: "accept", label: "Approve" },
        { key: "acceptForSession", label: "Allow Session" },
        { key: "decline", label: "Reject" },
        { key: "cancel", label: "Cancel" },
      ],
      promptType: "command_execution",
    };
  }

  if (method === "item/fileChange/requestApproval") {
    return {
      ...base,
      toolServer: "codex",
      toolName: "File Change",
      params: typeof params.grantRoot === "string" ? params.grantRoot : "",
      description: typeof params.reason === "string" ? params.reason : "Codex requests file change approval.",
      options: [
        { key: "accept", label: "Approve" },
        { key: "acceptForSession", label: "Allow Session" },
        { key: "decline", label: "Reject" },
        { key: "cancel", label: "Cancel" },
      ],
      promptType: "file_change",
    };
  }

  if (method === "skill/requestApproval") {
    return {
      ...base,
      toolServer: "codex",
      toolName: "Skill Request",
      params: typeof params.skillName === "string" ? params.skillName : "",
      description: "Codex requests approval to use a skill.",
      options: [
        { key: "approve", label: "Approve" },
        { key: "decline", label: "Reject" },
      ],
      promptType: "skill_request",
    };
  }

  if (method === "item/tool/requestUserInput") {
    const questions = Array.isArray(params.questions) ? params.questions as Array<Record<string, unknown>> : [];
    const first = questions[0];
    const questionText = typeof first?.question === "string" ? first.question : "Codex needs input.";
    const questionId = typeof first?.id === "string" ? first.id : "question";
    const options = Array.isArray(first?.options) ? first.options as Array<Record<string, unknown>> : [];
    return {
      ...base,
      toolServer: "codex",
      toolName: "User Input",
      params: questionText,
      description: questionText,
      options: options.map((opt, idx) => ({
        key: `${questionId}:${typeof opt.label === "string" ? opt.label : String(idx + 1)}`,
        label: typeof opt.label === "string" ? opt.label : `Option ${idx + 1}`,
      })),
      questionIds: [questionId],
      promptType: "user_input",
    };
  }

  return null;
}

async function sendRequest(session: CodexSession, method: string, params: unknown, timeoutMs = 30_000): Promise<unknown> {
  if (!session.socket || session.socket.readyState !== WebSocket.OPEN) {
    throw new Error("Codex app-server websocket is not connected");
  }
  const id = session.nextId++;
  const result = new Promise<unknown>((resolve, reject) => {
    session.pending.set(id, { resolve, reject });
    setTimeout(() => {
      if (session.pending.has(id)) {
        session.pending.delete(id);
        reject(new Error(`RPC timeout after ${timeoutMs}ms: ${method}`));
      }
    }, timeoutMs);
  });
  session.socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  return result;
}

function sendResponse(session: CodexSession, id: number | string, result: unknown): void {
  if (!session.socket || session.socket.readyState !== WebSocket.OPEN) return;
  session.socket.send(JSON.stringify({ jsonrpc: "2.0", id, result }));
}

function sendNotification(session: CodexSession, method: string, params?: unknown): void {
  if (!session.socket || session.socket.readyState !== WebSocket.OPEN) return;
  session.socket.send(JSON.stringify(params === undefined ? { jsonrpc: "2.0", method } : { jsonrpc: "2.0", method, params }));
}

function parseIncoming(session: CodexSession, raw: WebSocket.RawData): void {
  try {
    const body = typeof raw === "string" ? raw : raw.toString("utf8");
    handleMessage(session, JSON.parse(body) as Record<string, unknown>);
  } catch (err) {
    appendActivity(session.agentName, `\n[Codex parse error] ${(err as Error).message}\n`);
  }
}

async function findOpenPort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Failed to allocate Codex websocket port"));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

async function connectSocket(url: string): Promise<WebSocket> {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const socket = await new Promise<WebSocket>((resolve, reject) => {
        const ws = new WebSocket(url);
        const cleanup = () => {
          ws.removeAllListeners("open");
          ws.removeAllListeners("error");
        };
        ws.once("open", () => {
          cleanup();
          resolve(ws);
        });
        ws.once("error", (err) => {
          cleanup();
          reject(err);
        });
      });
      return socket;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error(`Timed out connecting to Codex app-server at ${url}`);
}

function handleMessage(session: CodexSession, msg: Record<string, unknown>): void {
  if ("id" in msg && ("result" in msg || "error" in msg)) {
    const pending = session.pending.get(Number(msg.id));
    if (!pending) return;
    session.pending.delete(Number(msg.id));
    if (msg.error) {
      pending.reject(new Error(JSON.stringify(msg.error)));
    } else {
      pending.resolve(msg.result);
    }
    return;
  }

  if (typeof msg.method === "string" && "id" in msg) {
    const approval = buildApprovalForRequest(session.agentName, {
      id: msg.id as number | string,
      method: msg.method,
      params: (msg.params || {}) as Record<string, unknown>,
    });
    if (approval) {
      approvalByAgent.set(session.agentName, approval);
      setState(session.agentName, "approval_pending");
      broadcast({ type: "approval:pending", data: approval });
      appendActivity(session.agentName, `\n[approval] ${approval.toolName}: ${approval.params || approval.description}\n`);
    }
    return;
  }

  const method = typeof msg.method === "string" ? msg.method : "";
  const params = (msg.params || {}) as Record<string, unknown>;
  switch (method) {
    case "thread/started": {
      const thread = params.thread as { id?: string } | undefined;
      if (thread?.id) {
        session.threadId = thread.id;
        mergeAgentMetadata(session.agentName, { threadId: thread.id });
      }
      setState(session.agentName, "idle");
      break;
    }
    case "thread/status/changed": {
      setState(session.agentName, mapThreadStatus(params.status));
      break;
    }
    case "thread/tokenUsage/updated": {
      const usage = params.tokenUsage as { total?: { inputTokens?: number; outputTokens?: number }; modelContextWindow?: number | null } | undefined;
      const total = (usage?.total?.inputTokens || 0) + (usage?.total?.outputTokens || 0);
      const window = usage?.modelContextWindow || 0;
      const pct = window > 0 ? Math.min(100, Math.round((total / window) * 100)) : 0;
      contextByAgent.set(session.agentName, pct);
      broadcast({ type: "agent:context", data: { name: session.agentName, contextPercent: pct } });
      break;
    }
    case "turn/started": {
      const turn = params.turn as { id?: string } | undefined;
      session.activeTurnId = turn?.id;
      setState(session.agentName, "busy");
      appendActivity(session.agentName, "\n[turn] started\n");
      break;
    }
    case "turn/completed": {
      session.activeTurnId = undefined;
      if (approvalByAgent.has(session.agentName)) {
        const removed = approvalByAgent.get(session.agentName)!;
        approvalByAgent.delete(session.agentName);
        broadcast({ type: "approval:resolved", data: { agentName: session.agentName, approvalId: removed.id } });
      }
      setState(session.agentName, "idle");
      appendActivity(session.agentName, "\n[turn] completed\n");
      break;
    }
    case "item/agentMessage/delta": {
      if (typeof params.delta === "string") {
        appendActivity(session.agentName, params.delta);
      }
      break;
    }
    case "item/started": {
      appendActivity(session.agentName, `\n[item] ${describeItem(params.item)}\n`);
      break;
    }
    case "item/completed": {
      appendActivity(session.agentName, `\n[item done] ${describeItem(params.item)}\n`);
      break;
    }
    case "item/commandExecution/outputDelta": {
      if (typeof params.delta === "string") {
        appendActivity(session.agentName, params.delta);
      }
      break;
    }
    case "error": {
      appendActivity(session.agentName, `\n[Codex error] ${JSON.stringify(params)}\n`);
      break;
    }
    default:
      break;
  }
}

async function initializeSession(session: CodexSession): Promise<void> {
  await sendRequest(session, "initialize", {
    clientInfo: { name: "claude-crew", version: "1.0.0" },
    capabilities: {
      experimentalApi: true,
    },
  });
  sendNotification(session, "initialized");

  const config = getAgentRuntimeConfig(session.agentName);
  const developerInstructions = fs.existsSync(path.join(session.agentDir, "AGENTS.md"))
    ? fs.readFileSync(path.join(session.agentDir, "AGENTS.md"), "utf8")
    : `You are "${session.agentName}" in Claude Crew. Always reply using send_to_chat.`;

  try {
    if (config.threadId) {
      const resumed = await sendRequest(session, "thread/resume", {
        threadId: config.threadId,
        cwd: session.agentDir,
        model: config.model || null,
        approvalPolicy: config.approvalPolicy || "on-request",
        sandbox: config.sandboxMode || "workspace-write",
        developerInstructions,
        persistExtendedHistory: true,
      }) as { thread?: { id?: string } };
      if (resumed?.thread?.id) {
        session.threadId = resumed.thread.id;
      }
    } else {
      const started = await sendRequest(session, "thread/start", {
        model: config.model || null,
        cwd: session.agentDir,
        approvalPolicy: config.approvalPolicy || "on-request",
        sandbox: config.sandboxMode || "workspace-write",
        serviceName: config.serviceName || session.agentName,
        developerInstructions,
        personality: "pragmatic",
        ephemeral: false,
        experimentalRawEvents: false,
        persistExtendedHistory: true,
      }) as { thread?: { id?: string } };
      if (started?.thread?.id) {
        session.threadId = started.thread.id;
      }
    }
  } catch (err) {
    clearAgentMetadataKeys(session.agentName, ["threadId"]);
    const started = await sendRequest(session, "thread/start", {
      model: config.model || null,
      cwd: session.agentDir,
      approvalPolicy: config.approvalPolicy || "on-request",
      sandbox: config.sandboxMode || "workspace-write",
      serviceName: config.serviceName || session.agentName,
      developerInstructions,
      personality: "pragmatic",
      ephemeral: false,
      experimentalRawEvents: false,
      persistExtendedHistory: true,
    }) as { thread?: { id?: string } };
    if (started?.thread?.id) {
      session.threadId = started.thread.id;
    }
    appendActivity(session.agentName, `\n[thread resume fallback] ${(err as Error).message}\n`);
  }

  if (session.threadId) {
    mergeAgentMetadata(session.agentName, { threadId: session.threadId });
  }
  setState(session.agentName, "idle");
}

export async function startCodexAgent(agentName: string): Promise<void> {
  const existing = sessions.get(agentName);
  if (existing && !existing.stopping) {
    await existing.ready;
    return;
  }

  const codexPath = findCodexPath();
  if (!codexPath) {
    throw new Error("Codex CLI not found");
  }

  const agentDir = getAgentDir(agentName);
  if (!fs.existsSync(agentDir)) {
    throw new Error(`Agent workspace not found: ${agentName}`);
  }

  const role = getAgentRole(agentName);
  const nodePath = findNodePath();
  const args = [
    "app-server",
    "--listen",
    `ws://127.0.0.1:${await findOpenPort()}`,
    "-c",
    `projects.\"${escapeToml(PROJECT_ROOT)}\".trust_level=\"trusted\"`,
    "-c",
    `mcp_servers.claude_crew.command=\"${escapeToml(nodePath)}\"`,
    "-c",
    `mcp_servers.claude_crew.args=[\"${escapeToml(BRIDGE_PATH)}\",\"${escapeToml(agentName)}\",\"${escapeToml(role)}\"]`,
  ];

  const proc = spawn(codexPath, args, {
    cwd: agentDir,
    env: {
      ...process.env,
      ...buildAgentWorkspaceEnv(agentName),
      CREW_SERVER_URL: process.env.CREW_SERVER_URL || "http://127.0.0.1:3140",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let readyResolve = () => {};
  let readyReject = (_err: Error) => {};
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });

  const session: CodexSession = {
    agentName,
    role,
    agentDir,
    process: proc,
    socket: null,
    nextId: 1,
    threadId: undefined,
    activeTurnId: undefined,
    pending: new Map(),
    ready,
    readyResolve,
    readyReject,
    stopping: false,
  };

  sessions.set(agentName, session);
  contentByAgent.set(agentName, "");
  setState(agentName, "busy");

  proc.stderr.on("data", (chunk) => appendActivity(agentName, `[codex] ${chunk.toString("utf8")}`));
  proc.on("exit", (code, signal) => {
    sessions.delete(agentName);
    const approval = approvalByAgent.get(agentName);
    if (approval) {
      approvalByAgent.delete(agentName);
      broadcast({ type: "approval:resolved", data: { agentName, approvalId: approval.id } });
    }
    setState(agentName, "no_session");
    // Sync DB status to offline when process exits
    try {
      const db = getDb();
      db.prepare("UPDATE agents SET status = 'offline' WHERE name = ?").run(agentName);
      broadcast({ type: "agent:status", data: { name: agentName, status: "offline", provider: "codex" } });
    } catch { /* best effort */ }
    appendActivity(agentName, `\n[codex exited] code=${code ?? "null"} signal=${signal ?? "null"}\n`);
    if (!session.stopping) {
      session.readyReject(new Error(`Codex app-server exited: ${code ?? "null"}`));
    }
  });

  try {
    const socketUrl = args[2] as string;
    session.socket = await connectSocket(socketUrl);
    session.socket.on("message", (msg) => parseIncoming(session, msg));
    session.socket.on("close", () => {
      if (!session.stopping) {
        appendActivity(agentName, "\n[codex websocket closed]\n");
      }
    });
    await initializeSession(session);
    const db = getDb();
    db.prepare("UPDATE agents SET status = 'online', last_heartbeat = ? WHERE name = ?").run(Date.now(), agentName);
    broadcast({ type: "agent:status", data: { name: agentName, status: "online", role, provider: "codex" } });
    session.readyResolve();
  } catch (err) {
    session.stopping = true;
    try { proc.kill("SIGTERM"); } catch { /* ignore */ }
    sessions.delete(agentName);
    setState(agentName, "no_session");
    throw err;
  }
}

export async function stopCodexAgent(agentName: string): Promise<void> {
  const session = sessions.get(agentName);
  if (!session) return;
  session.stopping = true;
  try {
    session.process.kill("SIGTERM");
  } catch {
    // Ignore.
  }
  sessions.delete(agentName);
  approvalByAgent.delete(agentName);
  setState(agentName, "no_session");
  const db = getDb();
  db.prepare("UPDATE agents SET status = 'offline' WHERE name = ?").run(agentName);
  broadcast({ type: "agent:status", data: { name: agentName, status: "offline", provider: "codex" } });
}

async function ensureSession(agentName: string): Promise<CodexSession> {
  await startCodexAgent(agentName);
  const session = sessions.get(agentName);
  if (!session) {
    throw new Error(`Codex session not found for ${agentName}`);
  }
  await session.ready;
  return session;
}

export async function sendMessageToCodexAgent(
  agentName: string,
  senderName: string,
  content: string,
  channelId?: string,
  channelType?: string
): Promise<boolean> {
  try {
    const session = await ensureSession(agentName);
    const runtime = getAgentRuntimeConfig(agentName);
    let inputText: string;
    if (channelType === "dm") {
      inputText = `[${senderName} in DM]: ${content}\n(Reply using send_to_chat with channel="${channelId}")`;
    } else if (channelType === "group") {
      inputText = `[${senderName} in group "${channelId}"]: ${content}\n(Reply using send_to_chat with channel="${channelId}")`;
    } else {
      inputText = `[${senderName} in #${channelId}]: ${content}\n(Reply using send_to_chat with channel="${channelId}")`;
    }

    const userInput = [{ type: "text", text: inputText, text_elements: [] }];
    if (session.activeTurnId) {
      await sendRequest(session, "turn/steer", {
        threadId: session.threadId,
        input: userInput,
        expectedTurnId: session.activeTurnId,
      });
    } else {
      await sendRequest(session, "turn/start", {
        threadId: session.threadId,
        input: userInput,
        cwd: session.agentDir,
        approvalPolicy: runtime.approvalPolicy || "on-request",
        sandboxPolicy: runtime.sandboxMode === "danger-full-access"
          ? { type: "dangerFullAccess" }
          : runtime.sandboxMode === "read-only"
            ? { type: "readOnly", access: { type: "fullAccess" } }
            : {
                type: "workspaceWrite",
                writableRoots: [session.agentDir],
                readOnlyAccess: { type: "fullAccess" },
                networkAccess: true,
                excludeTmpdirEnvVar: false,
                excludeSlashTmp: false,
              },
        model: runtime.model || null,
        effort: runtime.effort || null,
      });
    }
    return true;
  } catch (err) {
    appendActivity(agentName, `\n[codex send error] ${(err as Error).message}\n`);
    return false;
  }
}

export async function sendManualInputToCodexAgent(agentName: string, input: string, type?: string): Promise<void> {
  if (type === "key" && !["Enter", "Escape"].includes(input)) {
    return;
  }
  const prompt = type === "key" ? `[manual key] ${input}` : input;
  await sendMessageToCodexAgent(agentName, "user", prompt);
}

export async function respondToCodexApproval(agentName: string, key: string): Promise<boolean> {
  const session = sessions.get(agentName);
  const approval = approvalByAgent.get(agentName);
  if (!session || !approval || approval.requestId === undefined) {
    return false;
  }

  let result: unknown;
  switch (approval.promptType) {
    case "command_execution":
      result = { decision: key };
      break;
    case "file_change":
      result = { decision: key };
      break;
    case "skill_request":
      result = { decision: key };
      break;
    case "user_input": {
      const [questionId, answer] = key.split(":", 2);
      result = { answers: { [questionId]: { answers: [answer] } } };
      break;
    }
    default:
      return false;
  }

  sendResponse(session, approval.requestId, result);
  approvalByAgent.delete(agentName);
  broadcast({ type: "approval:resolved", data: { agentName, approvalId: approval.id } });
  setState(agentName, session.activeTurnId ? "busy" : "idle");
  return true;
}

export async function interruptCodexAgent(agentName: string): Promise<boolean> {
  const session = sessions.get(agentName);
  if (!session?.threadId || !session.activeTurnId) return false;
  await sendRequest(session, "turn/interrupt", {
    threadId: session.threadId,
    turnId: session.activeTurnId,
  });
  return true;
}

export async function resumeCodexAgent(agentName: string): Promise<boolean> {
  return sendMessageToCodexAgent(agentName, "author", "Continue from the current state and report back to chat when done.");
}

export async function restartCodexAgent(agentName: string, resetThread = false): Promise<boolean> {
  if (resetThread) {
    clearAgentMetadataKeys(agentName, ["threadId"]);
  }
  await stopCodexAgent(agentName);
  await startCodexAgent(agentName);
  return true;
}

export function getCodexApproval(agentName: string): ProviderApproval | undefined {
  return approvalByAgent.get(agentName);
}

export function getCodexApprovals(): ProviderApproval[] {
  return [...approvalByAgent.values()];
}

export function getCodexState(agentName: string): ProviderRuntimeState {
  return stateByAgent.get(agentName) || "no_session";
}

export function getCodexTerminalContent(agentName: string): string {
  return contentByAgent.get(agentName) || "";
}

export function getCodexContextPercent(agentName: string): number {
  return contextByAgent.get(agentName) || 0;
}
