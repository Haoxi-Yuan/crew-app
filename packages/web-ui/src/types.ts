export interface Agent {
  id: string;
  name: string;
  provider?: "claude" | "codex";
  role: string;
  status: "online" | "offline" | "busy";
  tmuxState?: "idle" | "busy" | "approval_pending" | "no_session";
  contextPercent?: number;
  last_heartbeat: number | null;
  registered_at: number;
}

export interface Message {
  id: number;
  channel_id: string;
  sender_type: "user" | "agent" | "system";
  sender_name: string;
  content: string;
  mentions: string[];
  message_type: "chat" | "system" | "task";
  created_at: number;
  delivery_status?: Record<string, "sent" | "delivered" | "read">;
}

export interface Channel {
  id: string;
  name: string;
  description: string;
  status: "active" | "archived";
  type?: "public" | "dm" | "group";
  members?: string[] | null;
  created_at: number;
  updated_at: number;
}

export interface SharedFile {
  path: string;
  created_by: string;
  description: string;
  updated_at: number;
  size_bytes: number;
}

export interface ToolApproval {
  id: string;
  provider?: "claude" | "codex";
  agentName: string;
  toolServer: string;
  toolName: string;
  params: string;
  description: string;
  options: { key: string; label: string }[];
  promptType: "tool_use" | "mcp_setup" | "command_execution" | "file_change" | "skill_request" | "user_input";
  detectedAt: number;
}

export interface WsEvent {
  type: string;
  data: unknown;
}
