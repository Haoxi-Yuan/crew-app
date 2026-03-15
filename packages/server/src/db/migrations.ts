/**
 * Versioned database migration framework.
 *
 * Each migration has a numeric version and an up() function.
 * Migrations run in order and are tracked in the `_migrations` table.
 * Once applied, a migration is never re-run.
 *
 * Existing ad-hoc ALTER TABLE checks from schema.ts have been consolidated here.
 * The base schema (CREATE TABLE IF NOT EXISTS) remains in schema.ts since it
 * handles fresh databases. Migrations handle evolution of existing databases.
 */

import type Database from "better-sqlite3";

interface Migration {
  version: number;
  name: string;
  up: (db: Database.Database) => void;
}

function hasColumn(db: Database.Database, table: string, column: string): boolean {
  const cols = db.pragma(`table_info(${table})`) as { name: string }[];
  return cols.some((c) => c.name === column);
}

function tableExists(db: Database.Database, table: string): boolean {
  const row = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?"
  ).get(table) as { 1: number } | undefined;
  return !!row;
}

/**
 * Ordered list of migrations. Append new migrations at the end.
 * NEVER reorder or modify existing migrations.
 */
const migrations: Migration[] = [
  {
    version: 1,
    name: "add_channel_id_to_messages",
    up(db) {
      if (tableExists(db, "messages") && !hasColumn(db, "messages", "channel_id")) {
        db.exec("ALTER TABLE messages ADD COLUMN channel_id TEXT DEFAULT 'general'");
      }
    },
  },
  {
    version: 2,
    name: "add_delivery_status_to_pending_mentions",
    up(db) {
      if (tableExists(db, "pending_mentions") && !hasColumn(db, "pending_mentions", "delivery_status")) {
        db.exec("ALTER TABLE pending_mentions ADD COLUMN delivery_status TEXT DEFAULT 'sent'");
      }
    },
  },
  {
    version: 3,
    name: "add_channel_fields",
    up(db) {
      if (!tableExists(db, "channels")) return;
      if (!hasColumn(db, "channels", "type")) {
        db.exec("ALTER TABLE channels ADD COLUMN type TEXT DEFAULT 'public'");
      }
      if (!hasColumn(db, "channels", "members")) {
        db.exec("ALTER TABLE channels ADD COLUMN members TEXT DEFAULT NULL");
      }
      if (!hasColumn(db, "channels", "project_id")) {
        db.exec("ALTER TABLE channels ADD COLUMN project_id TEXT DEFAULT NULL");
      }
      if (!hasColumn(db, "channels", "workplace_id")) {
        db.exec("ALTER TABLE channels ADD COLUMN workplace_id TEXT DEFAULT NULL");
      }
    },
  },
  {
    version: 4,
    name: "add_provider_to_agents",
    up(db) {
      if (tableExists(db, "agents") && !hasColumn(db, "agents", "provider")) {
        db.exec("ALTER TABLE agents ADD COLUMN provider TEXT DEFAULT 'claude'");
      }
    },
  },
  {
    version: 5,
    name: "add_scope_to_memory_entries",
    up(db) {
      if (!tableExists(db, "memory_entries")) return;
      if (!hasColumn(db, "memory_entries", "project_id")) {
        db.exec("ALTER TABLE memory_entries ADD COLUMN project_id TEXT DEFAULT NULL");
      }
      if (!hasColumn(db, "memory_entries", "scope_type")) {
        db.exec("ALTER TABLE memory_entries ADD COLUMN scope_type TEXT DEFAULT 'global'");
      }
      if (!hasColumn(db, "memory_entries", "scope_id")) {
        db.exec("ALTER TABLE memory_entries ADD COLUMN scope_id TEXT DEFAULT ''");
      }
    },
  },
  {
    version: 6,
    name: "add_active_workplace_to_project_agents",
    up(db) {
      if (tableExists(db, "project_agents") && !hasColumn(db, "project_agents", "active_workplace_id")) {
        db.exec("ALTER TABLE project_agents ADD COLUMN active_workplace_id TEXT DEFAULT NULL");
      }
    },
  },
  {
    version: 7,
    name: "rebuild_shared_files_with_scope",
    up(db) {
      if (!tableExists(db, "shared_files")) return;
      const cols = db.pragma("table_info(shared_files)") as { name: string }[];
      if (cols.length === 0) return;

      const hasId = cols.some((c) => c.name === "id");
      const hasScopeType = cols.some((c) => c.name === "scope_type");
      const hasScopeId = cols.some((c) => c.name === "scope_id");
      const hasMetadata = cols.some((c) => c.name === "metadata");

      if (hasId && hasScopeType && hasScopeId && hasMetadata) return;

      const hasProjectId = cols.some((c) => c.name === "project_id");
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
        SELECT path, path, ${projectScopeExpr}, ${projectIdExpr}, created_by, description, updated_at, size_bytes, '{}'
        FROM shared_files_legacy
      `);
      db.exec("DROP TABLE shared_files_legacy");
    },
  },
  {
    version: 8,
    name: "backfill_memory_scope_from_project_id",
    up(db) {
      if (!tableExists(db, "memory_entries")) return;
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
    },
  },
];

/**
 * Run all pending migrations in order.
 * Safe to call multiple times - already-applied migrations are skipped.
 */
export function runMigrations(db: Database.Database): void {
  // Create tracking table if needed
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    )
  `);

  const applied = new Set(
    (db.prepare("SELECT version FROM _migrations").all() as { version: number }[])
      .map((r) => r.version)
  );

  const insertMigration = db.prepare(
    "INSERT INTO _migrations (version, name, applied_at) VALUES (?, ?, ?)"
  );

  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;

    const tx = db.transaction(() => {
      migration.up(db);
      insertMigration.run(migration.version, migration.name, Date.now());
    });
    tx();
  }
}
