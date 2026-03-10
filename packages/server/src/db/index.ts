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
  path: string;
  created_by: string;
  description: string;
  updated_at: number;
  size_bytes: number;
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
}
