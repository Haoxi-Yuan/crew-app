import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const PORT = parseInt(process.env.CREW_PORT || "3140", 10);
export const PROJECT_ROOT = process.env.CREW_PROJECT_ROOT
  ? path.resolve(process.env.CREW_PROJECT_ROOT)
  : path.resolve(__dirname, "../../..");
export const DATA_DIR = path.join(PROJECT_ROOT, "data");
export const DB_PATH = path.join(DATA_DIR, "claude-crew.db");
export const SHARED_DIR = path.join(DATA_DIR, "shared");
export const WORKLOG_DIR = path.join(DATA_DIR, "agent_state");
export const WEB_UI_DIR = path.join(PROJECT_ROOT, "packages/web-ui");
export const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434";
export const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "nomic-embed-text";
export const OLLAMA_BIN = process.env.OLLAMA_BIN || path.join(PROJECT_ROOT, "bin", "ollama");
export const OLLAMA_MODELS_DIR = process.env.OLLAMA_MODELS || path.join(DATA_DIR, "ollama-models");
export const HEARTBEAT_TIMEOUT_MS = 60_000;
export const HEARTBEAT_CHECK_INTERVAL_MS = 15_000;
// Auto-cycle agent sessions when context usage exceeds this threshold (0-100)
export const SESSION_AUTO_CYCLE_CONTEXT_PERCENT = 80;
// Minimum interval between auto-cycles for the same agent (ms)
export const SESSION_AUTO_CYCLE_COOLDOWN_MS = 5 * 60 * 1000;
