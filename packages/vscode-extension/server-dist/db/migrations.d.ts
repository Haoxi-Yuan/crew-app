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
/**
 * Run all pending migrations in order.
 * Safe to call multiple times - already-applied migrations are skipped.
 */
export declare function runMigrations(db: Database.Database): void;
