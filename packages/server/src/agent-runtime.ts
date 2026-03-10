import { getDb } from "./db/index.js";

export const DEFAULT_PROVIDER = "claude";

export type AgentProvider = "claude" | "codex";
export type ApprovalPolicy = "untrusted" | "on-request" | "never";
export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";

export interface AgentRuntimeConfig {
  provider: AgentProvider;
  model?: string;
  effort?: string;
  approvalPolicy?: ApprovalPolicy;
  sandboxMode?: SandboxMode;
  threadId?: string;
  serviceName?: string;
}

function parseMetadata(agentName: string): Record<string, unknown> {
  const db = getDb();
  const row = db.prepare("SELECT metadata FROM agents WHERE name = ?").get(agentName) as { metadata: string } | undefined;
  if (!row?.metadata) {
    return {};
  }

  try {
    return JSON.parse(row.metadata) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function getProvider(agentName: string): AgentProvider {
  const db = getDb();
  const row = db.prepare("SELECT provider FROM agents WHERE name = ?").get(agentName) as { provider?: string } | undefined;
  return row?.provider === "codex" ? "codex" : "claude";
}

export function getAgentRuntimeConfig(agentName: string): AgentRuntimeConfig {
  const meta = parseMetadata(agentName);
  const provider = getProvider(agentName);

  return {
    provider,
    model: typeof meta.model === "string" ? meta.model : undefined,
    effort: typeof meta.effort === "string" ? meta.effort : undefined,
    approvalPolicy: typeof meta.approvalPolicy === "string" ? meta.approvalPolicy as ApprovalPolicy : undefined,
    sandboxMode: typeof meta.sandboxMode === "string" ? meta.sandboxMode as SandboxMode : undefined,
    threadId: typeof meta.threadId === "string" ? meta.threadId : undefined,
    serviceName: typeof meta.serviceName === "string" ? meta.serviceName : undefined,
  };
}

export function mergeAgentMetadata(agentName: string, patch: Record<string, unknown>): Record<string, unknown> {
  const db = getDb();
  const meta = parseMetadata(agentName);
  const next = { ...meta, ...patch };
  db.prepare("UPDATE agents SET metadata = ? WHERE name = ?").run(JSON.stringify(next), agentName);
  return next;
}

export function clearAgentMetadataKeys(agentName: string, keys: string[]): Record<string, unknown> {
  const db = getDb();
  const meta = parseMetadata(agentName);
  for (const key of keys) {
    delete meta[key];
  }
  db.prepare("UPDATE agents SET metadata = ? WHERE name = ?").run(JSON.stringify(meta), agentName);
  return meta;
}
