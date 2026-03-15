/**
 * Legacy config facade.
 *
 * Preserves the original export names so that existing consumers
 * continue to work without modification. Internally delegates to
 * the config singleton (config/load.ts).
 *
 * For MVP the VS Code extension injects overrides via env vars
 * before spawning the server child process, so top-level evaluation
 * is safe -- env is already set when this module loads.
 *
 * Post-MVP: callers should migrate to `import { getConfig } from "./config/index.js"`
 * and the server entry point should call `initConfig(overrides)` first.
 */
import { initConfig, isConfigInitialized, getConfig } from "./config/index.js";
// Auto-initialize from env/defaults on first import.
// This keeps backward compatibility for the CLI entry (index.ts).
// If start.ts has already called initConfig(overrides), this is a no-op.
if (!isConfigInitialized()) {
    initConfig();
}
const _cfg = getConfig();
export const PORT = _cfg.server.port;
export const PROJECT_ROOT = _cfg.server.projectRoot;
export const DATA_DIR = _cfg.server.dataDir;
export const DB_PATH = _cfg.server.dbPath;
export const SHARED_DIR = _cfg.server.sharedDir;
export const WORKLOG_DIR = _cfg.server.worklogDir;
export const WEB_UI_DIR = _cfg.server.webUiDir;
export const OLLAMA_BASE_URL = _cfg.ollama.baseUrl;
export const OLLAMA_MODEL = _cfg.ollama.model;
export const OLLAMA_BIN = _cfg.ollama.bin;
export const OLLAMA_MODELS_DIR = _cfg.ollama.modelsDir;
export const HEARTBEAT_TIMEOUT_MS = _cfg.agent.heartbeatTimeoutMs;
export const HEARTBEAT_CHECK_INTERVAL_MS = _cfg.agent.heartbeatCheckIntervalMs;
export const SESSION_AUTO_CYCLE_CONTEXT_PERCENT = _cfg.agent.autoCycleContextPercent;
export const SESSION_AUTO_CYCLE_COOLDOWN_MS = _cfg.agent.autoCycleCooldownMs;
// Terminal / tmux-monitor
export const MONITOR_INTERVAL_MS = _cfg.terminal.monitorIntervalMs;
export const CAPTURE_LINES = _cfg.terminal.captureLines;
// Standards / SOP engine
export const MAX_STANDARDS_BUDGET = _cfg.standards.maxBudgetChars;
export const STANDARDS_AUTO_APPLY_CONFIDENCE = _cfg.standards.autoApplyConfidenceThreshold;
export const STANDARDS_CONSENSUS_MIN = _cfg.standards.consensusMinAgents;
// Memory engine
export const MEMORY_MAX_STABILITY_DAYS = _cfg.memory.maxStabilityDays;
export const MEMORY_MAX_TIMESTAMPS = _cfg.memory.maxTimestamps;
export const MEMORY_ARCHIVE_THRESHOLD = _cfg.memory.archiveThreshold;
export const MEMORY_DAILY_ARCHIVE_AGE_DAYS = _cfg.memory.dailyArchiveAgeDays;
export const MEMORY_PROMOTION_MIN_ACCESSES = _cfg.memory.promotionMinAccesses;
//# sourceMappingURL=config.js.map