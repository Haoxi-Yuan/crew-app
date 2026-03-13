import type Database from "better-sqlite3";

function hasColumn(cols: { name: string }[], name: string): boolean {
  return cols.some((c) => c.name === name);
}

function rebuildSharedFilesTable(
  db: Database.Database,
  sharedFileCols: { name: string }[],
): void {
  if (sharedFileCols.length === 0) return;
  if (
    hasColumn(sharedFileCols, "id")
    && hasColumn(sharedFileCols, "scope_type")
    && hasColumn(sharedFileCols, "scope_id")
    && hasColumn(sharedFileCols, "metadata")
  ) {
    return;
  }

  const hasProjectId = hasColumn(sharedFileCols, "project_id");
  db.exec("ALTER TABLE shared_files RENAME TO shared_files_legacy");
  db.exec(`
    CREATE TABLE shared_files (
      id TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      scope_type TEXT NOT NULL DEFAULT 'global',
      scope_id TEXT NOT NULL DEFAULT '',
      created_by TEXT NOT NULL,
      description TEXT DEFAULT '',
      updated_at INTEGER NOT NULL,
      size_bytes INTEGER DEFAULT 0,
      metadata TEXT DEFAULT '{}',
      UNIQUE(scope_type, scope_id, path)
    );
    CREATE INDEX IF NOT EXISTS idx_shared_files_scope ON shared_files(scope_type, scope_id, updated_at DESC);
  `);

  const projectScopeExpr = hasProjectId
    ? "CASE WHEN project_id IS NOT NULL AND project_id != '' THEN 'project' ELSE 'global' END"
    : "'global'";
  const projectIdExpr = hasProjectId
    ? "CASE WHEN project_id IS NOT NULL THEN project_id ELSE '' END"
    : "''";

  db.exec(`
    INSERT INTO shared_files (id, path, scope_type, scope_id, created_by, description, updated_at, size_bytes, metadata)
    SELECT
      path,
      path,
      ${projectScopeExpr},
      ${projectIdExpr},
      created_by,
      description,
      updated_at,
      size_bytes,
      '{}'
    FROM shared_files_legacy
  `);
  db.exec("DROP TABLE shared_files_legacy");
}

export function initSchema(db: Database.Database): void {
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  const msgCols = db.pragma("table_info(messages)") as { name: string }[];
  if (msgCols.length > 0 && !hasColumn(msgCols, "channel_id")) {
    db.exec("ALTER TABLE messages ADD COLUMN channel_id TEXT DEFAULT 'general'");
  }

  const pmCols = db.pragma("table_info(pending_mentions)") as { name: string }[];
  if (pmCols.length > 0 && !hasColumn(pmCols, "delivery_status")) {
    db.exec("ALTER TABLE pending_mentions ADD COLUMN delivery_status TEXT DEFAULT 'sent'");
  }

  const chCols = db.pragma("table_info(channels)") as { name: string }[];
  if (chCols.length > 0 && !hasColumn(chCols, "type")) {
    db.exec("ALTER TABLE channels ADD COLUMN type TEXT DEFAULT 'public'");
  }
  if (chCols.length > 0 && !hasColumn(chCols, "members")) {
    db.exec("ALTER TABLE channels ADD COLUMN members TEXT DEFAULT NULL");
  }
  if (chCols.length > 0 && !hasColumn(chCols, "project_id")) {
    db.exec("ALTER TABLE channels ADD COLUMN project_id TEXT DEFAULT NULL");
  }
  if (chCols.length > 0 && !hasColumn(chCols, "workplace_id")) {
    db.exec("ALTER TABLE channels ADD COLUMN workplace_id TEXT DEFAULT NULL");
  }

  const agentCols = db.pragma("table_info(agents)") as { name: string }[];
  if (agentCols.length > 0 && !hasColumn(agentCols, "provider")) {
    db.exec("ALTER TABLE agents ADD COLUMN provider TEXT DEFAULT 'claude'");
  }

  const memCols = db.pragma("table_info(memory_entries)") as { name: string }[];
  if (memCols.length > 0 && !hasColumn(memCols, "project_id")) {
    db.exec("ALTER TABLE memory_entries ADD COLUMN project_id TEXT DEFAULT NULL");
  }
  if (memCols.length > 0 && !hasColumn(memCols, "scope_type")) {
    db.exec("ALTER TABLE memory_entries ADD COLUMN scope_type TEXT DEFAULT 'global'");
  }
  if (memCols.length > 0 && !hasColumn(memCols, "scope_id")) {
    db.exec("ALTER TABLE memory_entries ADD COLUMN scope_id TEXT DEFAULT ''");
  }

  const paCols = db.pragma("table_info(project_agents)") as { name: string }[];
  if (paCols.length > 0 && !hasColumn(paCols, "active_workplace_id")) {
    db.exec("ALTER TABLE project_agents ADD COLUMN active_workplace_id TEXT DEFAULT NULL");
  }

  const sfCols = db.pragma("table_info(shared_files)") as { name: string }[];
  // Rebuild legacy shared_files before creating indexes that reference scope columns.
  rebuildSharedFilesTable(db, sfCols);

  db.exec(`
    CREATE TABLE IF NOT EXISTS channels (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      description TEXT DEFAULT '',
      status TEXT DEFAULT 'active',
      type TEXT DEFAULT 'public',
      members TEXT DEFAULT NULL,
      project_id TEXT DEFAULT NULL,
      workplace_id TEXT DEFAULT NULL,
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
    CREATE INDEX IF NOT EXISTS idx_pending_agent ON pending_mentions(agent_name, acknowledged);

    CREATE TABLE IF NOT EXISTS shared_files (
      id TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      scope_type TEXT NOT NULL DEFAULT 'global',
      scope_id TEXT NOT NULL DEFAULT '',
      created_by TEXT NOT NULL,
      description TEXT DEFAULT '',
      updated_at INTEGER NOT NULL,
      size_bytes INTEGER DEFAULT 0,
      metadata TEXT DEFAULT '{}',
      UNIQUE(scope_type, scope_id, path)
    );
    CREATE INDEX IF NOT EXISTS idx_shared_files_scope ON shared_files(scope_type, scope_id, updated_at DESC);

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
      embedding BLOB,
      project_id TEXT DEFAULT NULL,
      scope_type TEXT NOT NULL DEFAULT 'global',
      scope_id TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_memory_agent ON memory_entries(agent_name);
    CREATE INDEX IF NOT EXISTS idx_memory_category ON memory_entries(category);
    CREATE INDEX IF NOT EXISTS idx_memory_status ON memory_entries(status);
    CREATE INDEX IF NOT EXISTS idx_memory_retrievability ON memory_entries(retrievability);
    CREATE INDEX IF NOT EXISTS idx_memory_project ON memory_entries(project_id);
    CREATE INDEX IF NOT EXISTS idx_memory_scope ON memory_entries(scope_type, scope_id);

    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      slug TEXT UNIQUE NOT NULL,
      description TEXT DEFAULT '',
      tech_stack TEXT DEFAULT '[]',
      status TEXT DEFAULT 'active',
      config TEXT DEFAULT '{}',
      directory TEXT DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      paused_at INTEGER,
      archived_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);

    CREATE TABLE IF NOT EXISTS workplaces (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      slug TEXT NOT NULL,
      status TEXT DEFAULT 'active',
      directory TEXT NOT NULL,
      kind TEXT DEFAULT 'derived',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(project_id, slug)
    );
    CREATE INDEX IF NOT EXISTS idx_workplaces_project ON workplaces(project_id, status, updated_at DESC);

    CREATE TABLE IF NOT EXISTS project_agents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      agent_name TEXT NOT NULL,
      role_in_project TEXT DEFAULT '',
      assignment_type TEXT DEFAULT 'dedicated',
      status TEXT DEFAULT 'active',
      active_workplace_id TEXT DEFAULT NULL REFERENCES workplaces(id) ON DELETE SET NULL,
      assigned_at INTEGER NOT NULL,
      UNIQUE(project_id, agent_name)
    );
    CREATE INDEX IF NOT EXISTS idx_pa_project ON project_agents(project_id);
    CREATE INDEX IF NOT EXISTS idx_pa_agent ON project_agents(agent_name);

    CREATE TABLE IF NOT EXISTS shared_standards (
      id TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      name TEXT NOT NULL,
      content TEXT NOT NULL,
      priority INTEGER DEFAULT 0,
      status TEXT DEFAULT 'active',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_standards_category ON shared_standards(category);

    CREATE TABLE IF NOT EXISTS project_templates (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      description TEXT DEFAULT '',
      tech_stack TEXT DEFAULT '[]',
      agent_roles TEXT DEFAULT '[]',
      claude_md_template TEXT DEFAULT '',
      skills_config TEXT DEFAULT '[]',
      directory_structure TEXT DEFAULT '[]',
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS reflections (
      id TEXT PRIMARY KEY,
      agent_name TEXT NOT NULL,
      project_id TEXT NOT NULL,
      trigger_type TEXT NOT NULL,
      task_summary TEXT NOT NULL,
      lessons_learned TEXT NOT NULL DEFAULT '[]',
      proposed_updates TEXT NOT NULL DEFAULT '[]',
      confidence REAL NOT NULL DEFAULT 0.5,
      status TEXT DEFAULT 'pending',
      reviewed_by TEXT,
      created_at INTEGER NOT NULL,
      reviewed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_reflections_project ON reflections(project_id);
    CREATE INDEX IF NOT EXISTS idx_reflections_status ON reflections(status);

    CREATE TABLE IF NOT EXISTS standards_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      standard_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      content TEXT NOT NULL,
      change_summary TEXT NOT NULL,
      source_reflection_ids TEXT DEFAULT '[]',
      applied_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(standard_id, version)
    );

    CREATE TABLE IF NOT EXISTS peaks (
      id TEXT PRIMARY KEY,
      agent_name TEXT NOT NULL,
      project_id TEXT,
      peak_type TEXT NOT NULL,
      context TEXT NOT NULL,
      options TEXT NOT NULL DEFAULT '[]',
      agent_lean TEXT,
      default_option INTEGER DEFAULT 0,
      timeout_seconds INTEGER DEFAULT 300,
      status TEXT DEFAULT 'pending',
      decision_index INTEGER,
      decision_note TEXT,
      decided_by TEXT,
      created_at INTEGER NOT NULL,
      decided_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_peaks_agent ON peaks(agent_name);
    CREATE INDEX IF NOT EXISTS idx_peaks_status ON peaks(status);
  `);

  // Backfill new scope columns from legacy project_id bridge.
  db.exec(`
    UPDATE memory_entries
    SET
      scope_type = CASE
        WHEN project_id IS NOT NULL AND project_id != '' THEN 'project'
        ELSE 'global'
      END,
      scope_id = CASE
        WHEN project_id IS NOT NULL THEN project_id
        ELSE ''
      END
    WHERE (scope_type IS NULL OR scope_type = '' OR scope_type = 'global')
      AND (scope_id IS NULL OR scope_id = '')
      AND project_id IS NOT NULL
  `);

  const exists = db.prepare("SELECT 1 FROM channels WHERE id = 'general'").get();
  if (!exists) {
    const now = Date.now();
    db.prepare(
      "INSERT INTO channels (id, name, description, status, type, project_id, workplace_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?)"
    ).run("general", "General", "Default group chat", "active", "public", now, now);
  }
}
