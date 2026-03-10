import type Database from "better-sqlite3";

export function initSchema(db: Database.Database): void {
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  // Migration: add channel_id column to messages if table exists but lacks the column
  const msgCols = db.pragma("table_info(messages)") as { name: string }[];
  if (msgCols.length > 0 && !msgCols.some((c) => c.name === "channel_id")) {
    db.exec("ALTER TABLE messages ADD COLUMN channel_id TEXT DEFAULT 'general'");
  }

  // Migration: add delivery_status column to pending_mentions if table exists but lacks the column
  // Values: 'sent' -> 'delivered' -> 'read'
  const pmCols = db.pragma("table_info(pending_mentions)") as { name: string }[];
  if (pmCols.length > 0 && !pmCols.some((c) => c.name === "delivery_status")) {
    db.exec("ALTER TABLE pending_mentions ADD COLUMN delivery_status TEXT DEFAULT 'sent'");
  }

  // Migration: add type and members columns to channels
  const chCols = db.pragma("table_info(channels)") as { name: string }[];
  if (chCols.length > 0 && !chCols.some((c) => c.name === "type")) {
    db.exec("ALTER TABLE channels ADD COLUMN type TEXT DEFAULT 'public'");
  }
  if (chCols.length > 0 && !chCols.some((c) => c.name === "members")) {
    db.exec("ALTER TABLE channels ADD COLUMN members TEXT DEFAULT NULL");
  }
  const agentCols = db.pragma("table_info(agents)") as { name: string }[];
  if (agentCols.length > 0 && !agentCols.some((c) => c.name === "provider")) {
    db.exec("ALTER TABLE agents ADD COLUMN provider TEXT DEFAULT 'claude'");
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS channels (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      description TEXT DEFAULT '',
      status TEXT DEFAULT 'active',
      type TEXT DEFAULT 'public',
      members TEXT DEFAULT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      provider TEXT DEFAULT 'claude',
      role TEXT DEFAULT '',
      status TEXT DEFAULT 'offline',
      last_heartbeat INTEGER,
      registered_at INTEGER NOT NULL,
      metadata TEXT DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id TEXT DEFAULT 'general',
      sender_type TEXT NOT NULL,
      sender_name TEXT NOT NULL,
      content TEXT NOT NULL,
      mentions TEXT DEFAULT '[]',
      message_type TEXT DEFAULT 'chat',
      created_at INTEGER NOT NULL,
      metadata TEXT DEFAULT '{}'
    );

    CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
    CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id);

    CREATE TABLE IF NOT EXISTS pending_mentions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id INTEGER NOT NULL REFERENCES messages(id),
      agent_name TEXT NOT NULL,
      acknowledged INTEGER DEFAULT 0,
      delivery_status TEXT DEFAULT 'sent',
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_pending_agent
      ON pending_mentions(agent_name, acknowledged);

    CREATE TABLE IF NOT EXISTS shared_files (
      path TEXT PRIMARY KEY,
      created_by TEXT NOT NULL,
      description TEXT DEFAULT '',
      updated_at INTEGER NOT NULL,
      size_bytes INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS memory_entries (
      id TEXT PRIMARY KEY,
      agent_name TEXT NOT NULL DEFAULT 'author',
      category TEXT NOT NULL,
      source_file TEXT NOT NULL,
      heading TEXT NOT NULL,
      content TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      importance INTEGER NOT NULL DEFAULT 3,
      emotional_weight REAL NOT NULL DEFAULT 1.0,
      created_at INTEGER NOT NULL,
      last_accessed_at INTEGER NOT NULL,
      access_count INTEGER NOT NULL DEFAULT 0,
      access_timestamps TEXT NOT NULL DEFAULT '[]',
      stability REAL NOT NULL DEFAULT 1.0,
      difficulty REAL NOT NULL DEFAULT 0.3,
      activation REAL NOT NULL DEFAULT 0.0,
      retrievability REAL NOT NULL DEFAULT 1.0,
      status TEXT NOT NULL DEFAULT 'active',
      promoted_at INTEGER,
      archived_at INTEGER,
      linked_ids TEXT NOT NULL DEFAULT '[]',
      embedding BLOB
    );

    CREATE INDEX IF NOT EXISTS idx_memory_agent ON memory_entries(agent_name);
    CREATE INDEX IF NOT EXISTS idx_memory_category ON memory_entries(category);
    CREATE INDEX IF NOT EXISTS idx_memory_status ON memory_entries(status);
    CREATE INDEX IF NOT EXISTS idx_memory_retrievability ON memory_entries(retrievability);
  `);

  // Seed default "general" channel
  const exists = db.prepare("SELECT 1 FROM channels WHERE id = 'general'").get();
  if (!exists) {
    const now = Date.now();
    db.prepare(
      "INSERT INTO channels (id, name, description, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("general", "General", "Default group chat", "active", now, now);
  }
}
