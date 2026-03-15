import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface VscodeRuntimeRecord {
  source: "vscode-extension";
  controlPort: number;
  token: string;
  pid: number;
  startedAt: string;
  updatedAt: string;
  workspaceFolders: string[];
  dataDir: string;
  projectRoot: string;
  server: {
    state: "starting" | "running" | "stopped";
    port: number | null;
  };
}

const RUNTIME_DIR = path.join(os.homedir(), ".claude-crew", "runtime");
const RUNTIME_FILE = path.join(RUNTIME_DIR, "vscode-extension.json");

export function getRuntimeFilePath(): string {
  return RUNTIME_FILE;
}

export function writeRuntimeRecord(record: VscodeRuntimeRecord): void {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  fs.writeFileSync(RUNTIME_FILE, `${JSON.stringify(record, null, 2)}\n`, "utf-8");
}

export function clearRuntimeRecord(expectedToken: string): void {
  if (!fs.existsSync(RUNTIME_FILE)) {
    return;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(RUNTIME_FILE, "utf-8")) as Partial<VscodeRuntimeRecord>;
    if (parsed.token && parsed.token !== expectedToken) {
      return;
    }
  } catch {
    // Remove malformed state files left by previous runs.
  }

  fs.rmSync(RUNTIME_FILE, { force: true });
}
