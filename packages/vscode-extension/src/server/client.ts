import http from "node:http";

export interface AgentInfo {
  name: string;
  role: string;
  status: string;
  provider: string;
}

export interface ProjectInfo {
  id: number;
  name: string;
  slug: string;
  status: string;
}

export interface SharedFileInfo {
  id: number;
  path: string;
  scope_type: string;
  scope_id: string;
  updated_at: number;
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

  async getProjects(): Promise<ProjectInfo[]> {
    return this.get<ProjectInfo[]>("/api/projects");
  }

  async getSharedFiles(): Promise<SharedFileInfo[]> {
    return this.get<SharedFileInfo[]>("/api/shared-files");
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

  private get<T>(path: string): Promise<T> {
    return new Promise((resolve, reject) => {
      const req = http.get(`${this.baseUrl}${path}`, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data) as T);
          } catch (err) {
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

  private request(method: string, path: string, body: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify(body);
      const url = new URL(`${this.baseUrl}${path}`);
      const req = http.request(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          method,
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(payload),
          },
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => {
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
      req.write(payload);
      req.end();
    });
  }
}
