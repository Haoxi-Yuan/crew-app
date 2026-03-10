const BASE_URL = process.env.CREW_SERVER_URL || "http://127.0.0.1:3140";

export interface MentionInfo {
  mention_id: number;
  message_id: number;
  sender_type: string;
  sender_name: string;
  content: string;
  message_type: string;
  created_at: number;
}

export interface ChatMessage {
  id: number;
  sender_type: string;
  sender_name: string;
  content: string;
  mentions: string[];
  message_type: string;
  created_at: number;
}

export interface AgentInfo {
  id: string;
  name: string;
  provider?: string;
  role: string;
  status: string;
  last_heartbeat: number | null;
  registered_at: number;
}

export interface SharedFileInfo {
  path: string;
  created_by: string;
  description: string;
  updated_at: number;
  size_bytes: number;
}

const MAX_RETRIES = 5;
const RETRY_DELAYS = [500, 1000, 2000, 4000, 8000];

async function request(path: string, options?: RequestInit): Promise<unknown> {
  const url = `${BASE_URL}/api${path}`;
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const resp = await fetch(url, {
        ...options,
        headers: { "Content-Type": "application/json", ...options?.headers },
      });
      if (!resp.ok) {
        const body = await resp.text();
        throw new Error(`HTTP ${resp.status}: ${body}`);
      }
      return resp.json();
    } catch (err) {
      lastError = err as Error;
      const isConnectionError =
        (err instanceof TypeError && err.message.includes("fetch")) ||
        (err instanceof Error && /ECONNREFUSED|ECONNRESET|EPIPE|socket hang up/i.test(err.message));

      if (!isConnectionError || attempt === MAX_RETRIES) {
        break;
      }
      await new Promise((r) => setTimeout(r, RETRY_DELAYS[attempt] || 8000));
    }
  }

  if (lastError instanceof TypeError && lastError.message.includes("fetch")) {
    throw new Error(
      "Cannot connect to Claude Crew server after retries. Is it running? Start with: crew start"
    );
  }
  throw lastError;
}

export async function register(name: string, role: string): Promise<void> {
  await request("/agents/register", {
    method: "POST",
    body: JSON.stringify({ name, role }),
  });
}

export async function heartbeat(name: string): Promise<void> {
  await request("/agents/heartbeat", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
}

export async function deregister(name: string): Promise<void> {
  await request("/agents/deregister", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
}

export async function checkMentions(
  agentName: string
): Promise<MentionInfo[]> {
  return (await request(`/mentions/${encodeURIComponent(agentName)}`)) as MentionInfo[];
}

export async function acknowledgeMention(id: number): Promise<void> {
  await request(`/mentions/${id}/ack`, { method: "POST" });
}

export async function readChat(
  limit?: number,
  beforeId?: number,
  channelId?: string,
  afterId?: number
): Promise<ChatMessage[]> {
  const params = new URLSearchParams();
  if (limit) params.set("limit", String(limit));
  if (beforeId) params.set("before_id", String(beforeId));
  if (afterId) params.set("after_id", String(afterId));
  if (channelId) params.set("channel_id", channelId);
  const qs = params.toString();
  return (await request(`/messages${qs ? "?" + qs : ""}`)) as ChatMessage[];
}

export async function sendMessage(
  agentName: string,
  content: string,
  channelId?: string
): Promise<{ id: number; mentions: string[] }> {
  return (await request("/messages", {
    method: "POST",
    body: JSON.stringify({
      sender_type: "agent",
      sender_name: agentName,
      content,
      channel_id: channelId || "general",
    }),
  })) as { id: number; mentions: string[] };
}

export async function listAgents(): Promise<AgentInfo[]> {
  return (await request("/agents")) as AgentInfo[];
}

export async function readSharedFile(
  filePath: string
): Promise<{ path: string; content: string; created_by: string; description: string; updated_at: number }> {
  return (await request(
    `/shared-files/${encodeURIComponent(filePath)}`
  )) as { path: string; content: string; created_by: string; description: string; updated_at: number };
}

export async function writeSharedFile(
  agentName: string,
  filePath: string,
  content: string,
  description?: string
): Promise<void> {
  await request(`/shared-files/${encodeURIComponent(filePath)}`, {
    method: "PUT",
    body: JSON.stringify({ content, created_by: agentName, description }),
  });
}

export async function listSharedFiles(): Promise<SharedFileInfo[]> {
  return (await request("/shared-files")) as SharedFileInfo[];
}

// --- Worklog ---

export interface Worklog {
  agent_name: string;
  updated_at: string;
  current_task: {
    description: string;
    status: string;
    progress: string;
    subtasks_done: string[];
    next_step: string;
    blockers: string[];
  } | null;
  recent_decisions: {
    decided_at: string;
    context: string;
    decision: string;
  }[];
  working_files: string[];
  key_context: string;
}

export async function loadWorklog(
  agentName: string
): Promise<{ exists: boolean; worklog: Worklog | null }> {
  return (await request(
    `/agents/${encodeURIComponent(agentName)}/worklog`
  )) as { exists: boolean; worklog: Worklog | null };
}

// --- Agent Config ---

export async function setAgentConfig(
  callerName: string,
  targetAgent: string,
  model?: string,
  effort?: string,
  approvalPolicy?: string,
  sandboxMode?: string,
  restart?: boolean
): Promise<{ ok: boolean; name: string; provider?: string; model?: string; effort?: string; approvalPolicy?: string; sandboxMode?: string; restarted: boolean }> {
  return (await request(`/agents/${encodeURIComponent(targetAgent)}/config`, {
    method: "PUT",
    body: JSON.stringify({
      model,
      effort,
      approval_policy: approvalPolicy,
      sandbox_mode: sandboxMode,
      requested_by: callerName,
      restart,
    }),
  })) as { ok: boolean; name: string; provider?: string; model?: string; effort?: string; approvalPolicy?: string; sandboxMode?: string; restarted: boolean };
}

export async function restartAgent(callerName: string, targetAgent: string): Promise<{ ok: boolean }> {
  return (await request(`/agents/${encodeURIComponent(targetAgent)}/restart`, {
    method: "POST",
    body: JSON.stringify({ requested_by: callerName }),
  })) as { ok: boolean };
}

export async function interruptAgent(callerName: string, targetAgent: string): Promise<{ ok: boolean }> {
  return (await request(`/agents/${encodeURIComponent(targetAgent)}/interrupt`, {
    method: "POST",
    body: JSON.stringify({ requested_by: callerName }),
  })) as { ok: boolean };
}

export async function resumeAgent(callerName: string, targetAgent: string): Promise<{ ok: boolean }> {
  return (await request(`/agents/${encodeURIComponent(targetAgent)}/resume`, {
    method: "POST",
    body: JSON.stringify({ requested_by: callerName }),
  })) as { ok: boolean };
}

export async function resetAgentSession(callerName: string, targetAgent: string): Promise<{ ok: boolean }> {
  return (await request(`/agents/${encodeURIComponent(targetAgent)}/reset-session`, {
    method: "POST",
    body: JSON.stringify({ requested_by: callerName }),
  })) as { ok: boolean };
}

export async function getAgentRuntimeStatus(targetAgent: string): Promise<{
  name: string;
  provider: string;
  runtimeState: string;
  contextPercent: number;
  config: Record<string, unknown>;
}> {
  return (await request(`/agents/${encodeURIComponent(targetAgent)}/runtime-status`)) as {
    name: string;
    provider: string;
    runtimeState: string;
    contextPercent: number;
    config: Record<string, unknown>;
  };
}

export async function saveWorklog(
  agentName: string,
  worklog: Worklog
): Promise<void> {
  await request(`/agents/${encodeURIComponent(agentName)}/worklog`, {
    method: "PUT",
    body: JSON.stringify({ worklog }),
  });
}

// --- Memory ---

export interface MemorySearchResult {
  count: number;
  entries: {
    id: string;
    heading: string;
    category: string;
    content?: string;
    importance: number;
    retrievability: number;
    score: number;
  }[];
}

export interface MemoryReadResult {
  id: string;
  agent_name: string;
  category: string;
  heading: string;
  content: string;
  importance: number;
  status: string;
  access_count: number;
  activation: number;
  retrievability: number;
}

export interface MemoryStats {
  agent_name: string;
  total: number;
  by_status: Record<string, number>;
  by_category: Record<string, number>;
  avg_retrievability: number | null;
  recently_accessed: { id: string; heading: string; category: string; access_count: number; last_accessed_at: number }[];
}

export async function memorySearch(
  query: string,
  agentName: string,
  category?: string,
  includeWeak?: boolean,
  limit?: number,
  summaryOnly?: boolean
): Promise<MemorySearchResult> {
  const params = new URLSearchParams({ q: query, agent_name: agentName });
  if (category) params.set("category", category);
  if (includeWeak) params.set("include_weak", "true");
  if (limit) params.set("limit", String(limit));
  if (summaryOnly !== undefined) params.set("summary_only", String(summaryOnly));
  return (await request(`/memory/search?${params}`)) as MemorySearchResult;
}

export async function memoryWrite(
  agentName: string,
  category: string,
  heading: string,
  content: string,
  importance?: number,
  emotionalWeight?: number
): Promise<{ id: string; status: string; activation: number; retrievability: number }> {
  return (await request("/memory/entries", {
    method: "POST",
    body: JSON.stringify({
      agent_name: agentName,
      category,
      heading,
      content,
      importance,
      emotional_weight: emotionalWeight,
    }),
  })) as { id: string; status: string; activation: number; retrievability: number };
}

export async function memoryRead(id: string): Promise<MemoryReadResult> {
  return (await request(`/memory/entries/${encodeURIComponent(id)}`)) as MemoryReadResult;
}

export async function memoryStats(agentName: string): Promise<MemoryStats> {
  return (await request(`/memory/stats?agent_name=${encodeURIComponent(agentName)}`)) as MemoryStats;
}

export async function memoryConsolidate(agentName: string): Promise<{
  total_processed: number;
  promoted: number;
  archived: number;
}> {
  return (await request("/memory/consolidate", {
    method: "POST",
    body: JSON.stringify({ agent_name: agentName }),
  })) as { total_processed: number; promoted: number; archived: number };
}
