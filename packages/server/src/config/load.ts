import { fileURLToPath } from "node:url";
import path from "node:path";
import { CrewConfigSchema, type CrewConfig } from "./schema.js";
import { getDefaults } from "./defaults.js";

let _config: CrewConfig | null = null;

/**
 * Derive the default project root from the compiled JS location.
 * In dev: __dirname = packages/server/dist -> ../../.. = project root
 * This is only used as a fallback when neither overrides nor env provide it.
 */
function deriveProjectRoot(): string {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(__dirname, "../../..");
}

/**
 * Deep-merge two partial config objects. Only merges plain objects;
 * arrays and primitives from `patch` replace `base` values.
 */
function deepMerge<T extends Record<string, unknown>>(base: T, patch: Partial<T>): T {
  const result = { ...base } as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    if (
      value !== undefined &&
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      typeof result[key] === "object" &&
      result[key] !== null &&
      !Array.isArray(result[key])
    ) {
      result[key] = deepMerge(
        result[key] as Record<string, unknown>,
        value as Record<string, unknown>,
      );
    } else if (value !== undefined) {
      result[key] = value;
    }
  }
  return result as T;
}

/**
 * Build config from env vars. Returns a partial CrewConfig with only
 * the values that are explicitly set in the environment.
 */
function fromEnv(): Partial<CrewConfig> {
  const env: Partial<CrewConfig> = {};

  if (process.env.CREW_PORT) {
    env.server = { ...env.server, port: parseInt(process.env.CREW_PORT, 10) } as CrewConfig["server"];
  }
  if (process.env.CREW_PROJECT_ROOT) {
    env.server = { ...env.server, projectRoot: path.resolve(process.env.CREW_PROJECT_ROOT) } as CrewConfig["server"];
  }
  if (process.env.CREW_INSTALL_DIR) {
    env.server = { ...env.server, installDir: path.resolve(process.env.CREW_INSTALL_DIR) } as CrewConfig["server"];
  }
  if (process.env.CREW_DATA_DIR) {
    env.server = { ...env.server, dataDir: path.resolve(process.env.CREW_DATA_DIR) } as CrewConfig["server"];
  }
  if (process.env.CREW_DB_PATH) {
    env.server = { ...env.server, dbPath: path.resolve(process.env.CREW_DB_PATH) } as CrewConfig["server"];
  }
  if (process.env.CREW_WEB_UI_DIR) {
    env.server = { ...env.server, webUiDir: path.resolve(process.env.CREW_WEB_UI_DIR) } as CrewConfig["server"];
  }
  if (process.env.CREW_MCP_BRIDGE_PATH) {
    env.server = { ...env.server, mcpBridgePath: path.resolve(process.env.CREW_MCP_BRIDGE_PATH) } as CrewConfig["server"];
  }
  if (process.env.CREW_MCP_TOOL_MEMORY_PATH) {
    env.server = { ...env.server, mcpToolMemoryPath: path.resolve(process.env.CREW_MCP_TOOL_MEMORY_PATH) } as CrewConfig["server"];
  }
  if (process.env.CREW_HOST) {
    env.server = { ...env.server, host: process.env.CREW_HOST } as CrewConfig["server"];
  }
  if (process.env.CREW_LOG_LEVEL) {
    env.server = { ...env.server, logLevel: process.env.CREW_LOG_LEVEL as CrewConfig["server"]["logLevel"] } as CrewConfig["server"];
  }

  if (process.env.OLLAMA_BASE_URL) {
    env.ollama = { ...env.ollama, baseUrl: process.env.OLLAMA_BASE_URL } as CrewConfig["ollama"];
  }
  if (process.env.OLLAMA_MODEL) {
    env.ollama = { ...env.ollama, model: process.env.OLLAMA_MODEL } as CrewConfig["ollama"];
  }
  if (process.env.OLLAMA_BIN) {
    env.ollama = { ...env.ollama, bin: process.env.OLLAMA_BIN } as CrewConfig["ollama"];
  }
  if (process.env.OLLAMA_MODELS) {
    env.ollama = { ...env.ollama, modelsDir: process.env.OLLAMA_MODELS } as CrewConfig["ollama"];
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
export function initConfig(overrides?: Partial<CrewConfig>): CrewConfig {
  // Determine projectRoot: overrides > env > derive from __dirname
  let projectRoot: string;
  if (overrides?.server?.projectRoot) {
    projectRoot = path.resolve(overrides.server.projectRoot);
  } else if (process.env.CREW_PROJECT_ROOT) {
    projectRoot = path.resolve(process.env.CREW_PROJECT_ROOT);
  } else {
    projectRoot = deriveProjectRoot();
  }

  // Determine installDir: overrides > env > projectRoot (backwards compat)
  let installDir: string | undefined;
  if (overrides?.server?.installDir) {
    installDir = path.resolve(overrides.server.installDir);
  } else if (process.env.CREW_INSTALL_DIR) {
    installDir = path.resolve(process.env.CREW_INSTALL_DIR);
  }
  // undefined means getDefaults will fall back to projectRoot

  const defaults = getDefaults(projectRoot, installDir);
  const envConfig = fromEnv();

  // Merge: defaults <- env <- overrides
  let merged = deepMerge(defaults, envConfig);
  if (overrides) {
    merged = deepMerge(merged, overrides as Record<string, unknown>) as CrewConfig;
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
  _config = Object.freeze(validated) as CrewConfig;
  return _config;
}

/**
 * Get the current config. Throws if initConfig() has not been called.
 */
export function getConfig(): CrewConfig {
  if (!_config) {
    throw new Error(
      "Config not initialized. Call initConfig() before accessing config. " +
      "This usually means the server entry point (start.ts or index.ts) " +
      "did not call initConfig() before importing other modules."
    );
  }
  return _config;
}

/**
 * Check whether the config has been initialized.
 */
export function isConfigInitialized(): boolean {
  return _config !== null;
}
