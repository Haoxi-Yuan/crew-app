import BetterSqlite3 from "better-sqlite3";
import type Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { DB_PATH, DATA_DIR } from "../config.js";
import { initSchema } from "./schema.js";

let db: Database.Database;

export function getDb(): Database.Database {
  if (!db) {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    db = new BetterSqlite3(DB_PATH);
    initSchema(db);
  }
  return db;
}

export interface AgentRow {
  id: string;
  name: string;
  provider: string;
  role: string;
  status: string;
  last_heartbeat: number | null;
  registered_at: number;
  metadata: string;
}

export interface ChannelRow {
  id: string;
  name: string;
  description: string;
  status: string;
  type: string;
  members: string | null;
  project_id: string | null;
  workplace_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface MessageRow {
  id: number;
  channel_id: string;
  sender_type: string;
  sender_name: string;
  content: string;
  mentions: string;
  message_type: string;
  created_at: number;
  metadata: string;
}

export interface PendingMentionRow {
  id: number;
  message_id: number;
  agent_name: string;
  acknowledged: number;
  created_at: number;
}

export interface SharedFileRow {
  id: string;
  path: string;
  scope_type: string;
  scope_id: string;
  created_by: string;
  description: string;
  updated_at: number;
  size_bytes: number;
  metadata: string;
}

export interface MemoryEntryRow {
  id: string;
  agent_name: string;
  category: string;
  source_file: string;
  heading: string;
  content: string;
  content_hash: string;
  importance: number;
  emotional_weight: number;
  created_at: number;
  last_accessed_at: number;
  access_count: number;
  access_timestamps: string;
  stability: number;
  difficulty: number;
  activation: number;
  retrievability: number;
  status: string;
  promoted_at: number | null;
  archived_at: number | null;
  linked_ids: string;
  embedding: Buffer | null;
  project_id: string | null;
  scope_type: string;
  scope_id: string;
}

export interface ProjectRow {
  id: string;
  name: string;
  slug: string;
  description: string;
  tech_stack: string;
  status: string;
  config: string;
  directory: string;
  created_at: number;
  updated_at: number;
  paused_at: number | null;
  archived_at: number | null;
}

export interface ProjectAgentRow {
  id: number;
  project_id: string;
  agent_name: string;
  role_in_project: string;
  assignment_type: string;
  status: string;
  active_workplace_id: string | null;
  assigned_at: number;
}

export interface WorkplaceRow {
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

export interface SharedStandardRow {
  id: string;
  category: string;
  name: string;
  content: string;
  priority: number;
  status: string;
  created_at: number;
  updated_at: number;
}

export interface ProjectTemplateRow {
  id: string;
  name: string;
  description: string;
  tech_stack: string;
  agent_roles: string;
  claude_md_template: string;
  skills_config: string;
  directory_structure: string;
  created_at: number;
}

export interface ReflectionRow {
  id: string;
  agent_name: string;
  project_id: string;
  trigger_type: string;
  task_summary: string;
  lessons_learned: string;
  proposed_updates: string;
  confidence: number;
  status: string;
  reviewed_by: string | null;
  created_at: number;
  reviewed_at: number | null;
}

export interface StandardsHistoryRow {
  id: number;
  standard_id: string;
  version: number;
  content: string;
  change_summary: string;
  source_reflection_ids: string;
  applied_by: string;
  created_at: number;
}

export interface PeakRow {
  id: string;
  agent_name: string;
  project_id: string | null;
  peak_type: string;
  context: string;
  options: string; // JSON array of {label, pros, cons}
  agent_lean: string | null;
  default_option: number;
  timeout_seconds: number;
  status: string; // pending, decided, auto_decided, expired
  decision_index: number | null;
  decision_note: string | null;
  decided_by: string | null;
  created_at: number;
  decided_at: number | null;
}
