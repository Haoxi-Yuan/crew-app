import http from "node:http";

export interface AgentInfo {
  name: string;
  role: string;
  status: string;
  provider: string;
}

export interface ProjectInfo {
  id: string;
  name: string;
  slug: string;
  description: string;
  status: string;
  tech_stack: string[];
  agent_count: number;
  memory_count: number;
  workplace_count?: number;
  directory?: string;
  updated_at?: number;
}

export interface ProjectAgentInfo {
  id: number;
  project_id: string;
  agent_name: string;
  role_in_project: string;
  assignment_type: string;
  status: string;
  active_workplace_id: string | null;
  assigned_at: number;
}

export interface WorkplaceInfo {
  id: string;
  project_id: string;
  name: string;
  slug: string;
  status: string;
  directory: string;
  kind: string;
  created_at: number;
  updated_at: number;
}

export interface ProjectDetail extends ProjectInfo {
  config: Record<string, unknown>;
  workplaces: WorkplaceInfo[];
  agents: ProjectAgentInfo[];
  created_at: number;
  paused_at: number | null;
  archived_at: number | null;
}

export interface SharedFileInfo {
  id?: string;
  path: string;
  scope_type: "global" | "project" | "workplace";
  scope_id: string;
  project_id?: string | null;
  workplace_id?: string | null;
  scope_name?: string | null;
  created_by?: string;
  description?: string;
  updated_at: number;
  size_bytes?: number;
}

export interface SharedFileDetail extends SharedFileInfo {
  content: string;
}

export interface ServerStatus {
  status: string;
  agents: { total: number; online: number };
  messages: number;
  uptime: number;
}

export interface AgentRuntimeStatus {
  name: string;
  provider: string;
  runtimeState: string;
  contextPercent: number;
  config: {
    model?: string;
    effort?: string;
    approvalPolicy?: string;
    sandboxMode?: string;
  };
}

export interface AgentConfigUpdate {
  model?: string;
  effort?: string;
  approval_policy?: string;
  sandbox_mode?: string;
  restart?: boolean;
}

export interface ApprovalOption {
  key: string;
  label: string;
}

export interface ApprovalInfo {
  id: string;
  provider?: "claude" | "codex";
  agentName: string;
  toolServer: string;
  toolName: string;
  params: string;
  description: string;
  options: ApprovalOption[];
  promptType: string;
  detectedAt: number;
}

export interface PeakOption {
  label: string;
  pros: string;
  cons: string;
}

export interface PeakInfo {
  id: string;
  agent_name: string;
  project_id: string | null;
  peak_type: string;
  context: string;
  options: PeakOption[];
  agent_lean: string | null;
  default_option: number;
  timeout_seconds: number;
  status: string;
  created_at: number;
  expires_at: number;
}

export interface MemoryEntrySummary {
  id: string;
  heading: string;
  category: string;
  importance: number;
  retrievability: number;
  score?: number;
  project_id: string | null;
  scope_type: string;
  scope_id: string;
}

export interface MemoryEntryDetail {
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
  project_id: string | null;
  scope_type: string;
  scope_id: string;
}

export interface MemoryStats {
  agent_name: string;
  total: number;
  by_status: Record<string, number>;
  by_category: Record<string, number>;
  avg_retrievability: number | null;
  recently_accessed: Array<{
    id: string;
    heading: string;
    category: string;
    access_count: number;
    last_accessed_at: number;
  }>;
  scope_type: string;
  scope_id: string;
}

export interface SharedStandard {
  id: string;
  category: string;
  name: string;
  content: string;
  priority: number;
  status: string;
  created_at: number;
  updated_at: number;
}

export interface StandardHistoryEntry {
  id: number;
  standard_id: string;
  version: number;
  content: string;
  change_summary: string;
  source_reflection_ids: string;
  applied_by: string;
  created_at: number;
}

export interface ReflectionLesson {
  category: string;
  description: string;
  evidence: string;
}

export interface ReflectionUpdate {
  action: string;
  section: string;
  current_text?: string;
  proposed_text: string;
  rationale: string;
  confidence: number;
}

export interface ReflectionInfo {
  id: string;
  agent_name: string;
  project_id: string;
  trigger_type: string;
  task_summary: string;
  lessons_learned: ReflectionLesson[];
  proposed_updates: ReflectionUpdate[];
  confidence: number;
  status: string;
  reviewed_by: string | null;
  created_at: number;
  reviewed_at: number | null;
}

export interface CrewPanelTarget {
  view?: "chat" | "dashboard";
  channelId?: string;
  projectId?: string;
  peakId?: string;
}

export interface ScopeFilter {
  projectId?: string | null;
  workplaceId?: string | null;
  scopeType?: string | null;
  scopeId?: string | null;
}

function buildQuery(filter?: ScopeFilter | Record<string, string | number | boolean | null | undefined>): string {
  if (!filter) return "";
  const params = new URLSearchParams();
  for (const [key, rawValue] of Object.entries(filter)) {
    if (rawValue === undefined || rawValue === null || rawValue === "") continue;
    const apiKey = key
      .replace(/([A-Z])/g, "_$1")
      .toLowerCase()
      .replace(/^project_id$/, "project_id")
      .replace(/^workplace_id$/, "workplace_id")
      .replace(/^scope_type$/, "scope_type")
      .replace(/^scope_id$/, "scope_id");
    params.set(apiKey, String(rawValue));
  }
  const query = params.toString();
  return query ? `?${query}` : "";
}

export class CrewClient {
  private baseUrl: string;

  constructor(port: number) {
    this.baseUrl = `http://127.0.0.1:${port}`;
  }

  updatePort(port: number): void {
    this.baseUrl = `http://127.0.0.1:${port}`;
  }

  async getStatus(): Promise<ServerStatus> {
    return this.get<ServerStatus>("/api/status");
  }

  async getAgents(): Promise<AgentInfo[]> {
    return this.get<AgentInfo[]>("/api/agents");
  }

  async getProjects(status?: string): Promise<ProjectInfo[]> {
    return this.get<ProjectInfo[]>(`/api/projects${status ? `?status=${encodeURIComponent(status)}` : ""}`);
  }

  async getProjectDetail(id: string): Promise<ProjectDetail> {
    return this.get<ProjectDetail>(`/api/projects/${encodeURIComponent(id)}`);
  }

  async getSharedFiles(filter?: ScopeFilter): Promise<SharedFileInfo[]> {
    return this.get<SharedFileInfo[]>(`/api/shared-files${buildQuery(filter)}`);
  }

  async getSharedFile(filePath: string, filter?: ScopeFilter): Promise<SharedFileDetail> {
    return this.get<SharedFileDetail>(`/api/shared-files/${encodeURIComponent(filePath)}${buildQuery(filter)}`);
  }

  async writeSharedFile(
    filePath: string,
    content: string,
    filter?: ScopeFilter & { createdBy?: string; description?: string; artifactKind?: string },
  ): Promise<SharedFileInfo> {
    return this.put(`/api/shared-files/${encodeURIComponent(filePath)}`, {
      content,
      created_by: filter?.createdBy || "user",
      description: filter?.description,
      project_id: filter?.projectId,
      workplace_id: filter?.workplaceId,
      scope_type: filter?.scopeType,
      scope_id: filter?.scopeId,
      artifact_kind: filter?.artifactKind,
    }) as Promise<SharedFileInfo>;
  }

  async deleteSharedFile(filePath: string, filter?: ScopeFilter): Promise<void> {
    await this.delete(`/api/shared-files/${encodeURIComponent(filePath)}${buildQuery(filter)}`);
  }

  async getApprovals(): Promise<ApprovalInfo[]> {
    return this.get<ApprovalInfo[]>("/api/approvals");
  }

  async respondApproval(agentName: string, key: string): Promise<void> {
    await this.post(`/api/approvals/${encodeURIComponent(agentName)}/respond`, { key });
  }

  async getPendingPeaks(): Promise<PeakInfo[]> {
    return this.get<PeakInfo[]>("/api/peaks/pending");
  }

  async decidePeak(id: string, optionIndex: number, note?: string): Promise<unknown> {
    return this.post(`/api/peaks/${encodeURIComponent(id)}/decide`, {
      option_index: optionIndex,
      decided_by: "user",
      ...(note ? { note } : {}),
    });
  }

  async letAgentDecide(id: string): Promise<unknown> {
    return this.post(`/api/peaks/${encodeURIComponent(id)}/let-agent-decide`, {});
  }

  async pausePeak(id: string): Promise<unknown> {
    return this.post(`/api/peaks/${encodeURIComponent(id)}/pause`, {});
  }

  async searchMemory(
    query: string,
    filter?: ScopeFilter & { agentName?: string; category?: string; includeWeak?: boolean; limit?: number; summaryOnly?: boolean },
  ): Promise<{ count: number; entries: MemoryEntrySummary[] }> {
    const qs = new URLSearchParams();
    qs.set("q", query);
    if (filter?.agentName) qs.set("agent_name", filter.agentName);
    if (filter?.category) qs.set("category", filter.category);
    if (filter?.projectId) qs.set("project_id", filter.projectId);
    if (filter?.scopeType) qs.set("scope_type", filter.scopeType);
    if (filter?.scopeId) qs.set("scope_id", filter.scopeId);
    if (filter?.includeWeak !== undefined) qs.set("include_weak", String(filter.includeWeak));
    if (filter?.limit !== undefined) qs.set("limit", String(filter.limit));
    if (filter?.summaryOnly !== undefined) qs.set("summary_only", String(filter.summaryOnly));
    return this.get<{ count: number; entries: MemoryEntrySummary[] }>(`/api/memory/search?${qs.toString()}`);
  }

  async getMemoryEntry(id: string): Promise<MemoryEntryDetail> {
    return this.get<MemoryEntryDetail>(`/api/memory/entries/${encodeURIComponent(id)}`);
  }

  async getMemoryStats(filter?: ScopeFilter & { agentName?: string }): Promise<MemoryStats> {
    const qs = new URLSearchParams();
    if (filter?.agentName) qs.set("agent_name", filter.agentName);
    if (filter?.projectId) qs.set("project_id", filter.projectId);
    if (filter?.scopeType) qs.set("scope_type", filter.scopeType);
    if (filter?.scopeId) qs.set("scope_id", filter.scopeId);
    const query = qs.toString();
    return this.get<MemoryStats>(`/api/memory/stats${query ? `?${query}` : ""}`);
  }

  async getStandards(status?: string): Promise<SharedStandard[]> {
    return this.get<SharedStandard[]>(`/api/standards${status ? `?status=${encodeURIComponent(status)}` : ""}`);
  }

  async updateStandard(id: string, payload: { name?: string; content?: string; priority?: number; status?: string; change_summary?: string }): Promise<SharedStandard> {
    return this.put(`/api/standards/${encodeURIComponent(id)}`, payload) as Promise<SharedStandard>;
  }

  async getStandardHistory(id: string): Promise<StandardHistoryEntry[]> {
    return this.get<StandardHistoryEntry[]>(`/api/standards/${encodeURIComponent(id)}/history`);
  }

  async getReflections(filter?: { projectId?: string; status?: string; agentName?: string; limit?: number }): Promise<ReflectionInfo[]> {
    const qs = new URLSearchParams();
    if (filter?.projectId) qs.set("project_id", filter.projectId);
    if (filter?.status) qs.set("status", filter.status);
    if (filter?.agentName) qs.set("agent_name", filter.agentName);
    if (filter?.limit !== undefined) qs.set("limit", String(filter.limit));
    return this.get<ReflectionInfo[]>(`/api/reflections${qs.toString() ? `?${qs.toString()}` : ""}`);
  }

  async getReflection(id: string): Promise<ReflectionInfo> {
    return this.get<ReflectionInfo>(`/api/reflections/${encodeURIComponent(id)}`);
  }

  async reviewReflection(id: string, action: "approve" | "reject"): Promise<{ ok: true; status: string }> {
    return this.put(`/api/reflections/${encodeURIComponent(id)}/review`, {
      action,
      reviewed_by: "user",
    }) as Promise<{ ok: true; status: string }>;
  }

  async wakeAgent(name: string): Promise<void> {
    await this.post("/api/wake", { name });
  }

  async stopAgent(name: string): Promise<void> {
    await this.post(`/api/agents/${encodeURIComponent(name)}/system-stop`, {});
  }

  async restartAgent(name: string): Promise<void> {
    await this.post(`/api/agents/${encodeURIComponent(name)}/system-restart`, {});
  }

  async getAgentRuntimeStatus(name: string): Promise<AgentRuntimeStatus> {
    return this.get<AgentRuntimeStatus>(`/api/agents/${encodeURIComponent(name)}/runtime-status`);
  }

  async configureAgent(name: string, config: AgentConfigUpdate): Promise<unknown> {
    return this.put(`/api/agents/${encodeURIComponent(name)}/config`, {
      ...config,
      requested_by: "author",
    });
  }

  async setProjectAgentWorkplace(projectId: string, agentName: string, workplaceId: string | null): Promise<unknown> {
    return this.put(`/api/projects/${encodeURIComponent(projectId)}/agents/${encodeURIComponent(agentName)}/workplace`, {
      workplace_id: workplaceId,
    });
  }

  private get<T>(path: string): Promise<T> {
    return new Promise((resolve, reject) => {
      const req = http.get(`${this.baseUrl}${path}`, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data) as T);
          } catch {
            reject(new Error(`Invalid JSON from ${path}: ${data.slice(0, 200)}`));
          }
        });
      });
      req.on("error", reject);
      req.setTimeout(10_000, () => {
        req.destroy();
        reject(new Error(`Request timeout: ${path}`));
      });
    });
  }

  private put(path: string, body: unknown): Promise<unknown> {
    return this.request("PUT", path, body);
  }

  private post(path: string, body: unknown): Promise<unknown> {
    return this.request("POST", path, body);
  }

  private delete(path: string, body?: unknown): Promise<unknown> {
    return this.request("DELETE", path, body);
  }

  private request(method: string, path: string, body: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? "" : JSON.stringify(body);
      const url = new URL(`${this.baseUrl}${path}`);
      const headers: Record<string, string | number> = {};
      if (payload) {
        headers["Content-Type"] = "application/json";
        headers["Content-Length"] = Buffer.byteLength(payload);
      }

      const req = http.request(
        {
          hostname: url.hostname,
          port: url.port,
          path: `${url.pathname}${url.search}`,
          method,
          headers,
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => {
            if (!data) {
              resolve(undefined);
              return;
            }
            try {
              resolve(JSON.parse(data));
            } catch {
              resolve(data);
            }
          });
        },
      );
      req.on("error", reject);
      req.setTimeout(30_000, () => {
        req.destroy();
        reject(new Error(`Request timeout: ${method} ${path}`));
      });
      if (payload) {
        req.write(payload);
      }
      req.end();
    });
  }
}
