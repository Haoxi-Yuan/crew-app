import { fileURLToPath } from "node:url";
import path from "node:path";
import { CrewConfigSchema } from "./schema.js";
import { getDefaults } from "./defaults.js";
let _config = null;
/**
 * Derive the default project root from the compiled JS location.
 * In dev: __dirname = packages/server/dist -> ../../.. = project root
 * This is only used as a fallback when neither overrides nor env provide it.
 */
function deriveProjectRoot() {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    return path.resolve(__dirname, "../../..");
}
/**
 * Deep-merge two partial config objects. Only merges plain objects;
 * arrays and primitives from `patch` replace `base` values.
 */
function deepMerge(base, patch) {
    const result = { ...base };
    for (const [key, value] of Object.entries(patch)) {
        if (value !== undefined &&
            typeof value === "object" &&
            value !== null &&
            !Array.isArray(value) &&
            typeof result[key] === "object" &&
            result[key] !== null &&
            !Array.isArray(result[key])) {
            result[key] = deepMerge(result[key], value);
        }
        else if (value !== undefined) {
            result[key] = value;
        }
    }
    return result;
}
/**
 * Build config from env vars. Returns a partial CrewConfig with only
 * the values that are explicitly set in the environment.
 */
function fromEnv() {
    const env = {};
    if (process.env.CREW_PORT) {
        env.server = { ...env.server, port: parseInt(process.env.CREW_PORT, 10) };
    }
    if (process.env.CREW_PROJECT_ROOT) {
        env.server = { ...env.server, projectRoot: path.resolve(process.env.CREW_PROJECT_ROOT) };
    }
    if (process.env.CREW_DATA_DIR) {
        env.server = { ...env.server, dataDir: path.resolve(process.env.CREW_DATA_DIR) };
    }
    if (process.env.CREW_DB_PATH) {
        env.server = { ...env.server, dbPath: path.resolve(process.env.CREW_DB_PATH) };
    }
    if (process.env.CREW_WEB_UI_DIR) {
        env.server = { ...env.server, webUiDir: path.resolve(process.env.CREW_WEB_UI_DIR) };
    }
    if (process.env.CREW_HOST) {
        env.server = { ...env.server, host: process.env.CREW_HOST };
    }
    if (process.env.CREW_LOG_LEVEL) {
        env.server = { ...env.server, logLevel: process.env.CREW_LOG_LEVEL };
    }
    if (process.env.OLLAMA_BASE_URL) {
        env.ollama = { ...env.ollama, baseUrl: process.env.OLLAMA_BASE_URL };
    }
    if (process.env.OLLAMA_MODEL) {
        env.ollama = { ...env.ollama, model: process.env.OLLAMA_MODEL };
    }
    if (process.env.OLLAMA_BIN) {
        env.ollama = { ...env.ollama, bin: process.env.OLLAMA_BIN };
    }
    if (process.env.OLLAMA_MODELS) {
        env.ollama = { ...env.ollama, modelsDir: process.env.OLLAMA_MODELS };
    }
    return env;
}
/**
 * Initialize the global config singleton.
 * Must be called once before any module calls getConfig().
 * Priority: overrides > env vars > defaults.
 *
 * When CREW_DATA_DIR is set but individual paths (dbPath, sharedDir, etc.)
 * are not, they are re-derived from the overridden dataDir.
 */
export function initConfig(overrides) {
    // Determine projectRoot: overrides > env > derive from __dirname
    let projectRoot;
    if (overrides?.server?.projectRoot) {
        projectRoot = path.resolve(overrides.server.projectRoot);
    }
    else if (process.env.CREW_PROJECT_ROOT) {
        projectRoot = path.resolve(process.env.CREW_PROJECT_ROOT);
    }
    else {
        projectRoot = deriveProjectRoot();
    }
    const defaults = getDefaults(projectRoot);
    const envConfig = fromEnv();
    // Merge: defaults <- env <- overrides
    let merged = deepMerge(defaults, envConfig);
    if (overrides) {
        merged = deepMerge(merged, overrides);
    }
    // When dataDir is overridden, re-derive dependent paths that weren't explicitly set
    const effectiveDataDir = merged.server.dataDir;
    if (effectiveDataDir !== defaults.server.dataDir) {
        if (!overrides?.server?.dbPath && !process.env.CREW_DB_PATH) {
            merged.server.dbPath = path.join(effectiveDataDir, "claude-crew.db");
        }
        if (!overrides?.server?.sharedDir) {
            merged.server.sharedDir = path.join(effectiveDataDir, "shared");
        }
        if (!overrides?.server?.worklogDir) {
            merged.server.worklogDir = path.join(effectiveDataDir, "agent_state");
        }
        if (!overrides?.ollama?.modelsDir && !process.env.OLLAMA_MODELS) {
            merged.ollama.modelsDir = path.join(effectiveDataDir, "ollama-models");
        }
    }
    const validated = CrewConfigSchema.parse(merged);
    _config = Object.freeze(validated);
    return _config;
}
/**
 * Get the current config. Throws if initConfig() has not been called.
 */
export function getConfig() {
    if (!_config) {
        throw new Error("Config not initialized. Call initConfig() before accessing config. " +
            "This usually means the server entry point (start.ts or index.ts) " +
            "did not call initConfig() before importing other modules.");
    }
    return _config;
}
/**
 * Check whether the config has been initialized.
 */
export function isConfigInitialized() {
    return _config !== null;
}
//# sourceMappingURL=load.js.map