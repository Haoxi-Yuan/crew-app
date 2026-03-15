import type Database from "better-sqlite3";
/**
 * Initialize the database schema and run migrations.
 *
 * CREATE TABLE IF NOT EXISTS statements handle fresh databases.
 * Versioned migrations (migrations.ts) handle schema evolution
 * for existing databases. Migrations run first so that the CREATE
 * statements below act as no-ops for already-migrated tables.
 */
export declare function initSchema(db: Database.Database): void;
