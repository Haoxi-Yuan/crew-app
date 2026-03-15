import { type CrewConfig } from "./schema.js";
/**
 * Initialize the global config singleton.
 * Must be called once before any module calls getConfig().
 * Priority: overrides > env vars > defaults.
 *
 * When CREW_DATA_DIR is set but individual paths (dbPath, sharedDir, etc.)
 * are not, they are re-derived from the overridden dataDir.
 */
export declare function initConfig(overrides?: Partial<CrewConfig>): CrewConfig;
/**
 * Get the current config. Throws if initConfig() has not been called.
 */
export declare function getConfig(): CrewConfig;
/**
 * Check whether the config has been initialized.
 */
export declare function isConfigInitialized(): boolean;
