import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

type BinaryName = "node" | "claude" | "codex" | "tmux" | "ollama";

/**
 * Platform-specific candidate directories for binaries installed
 * via system package managers or standard locations.
 */
const PLATFORM_CANDIDATES: Record<string, string[]> = {
  darwin: ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"],
  linux: ["/usr/local/bin", "/usr/bin", "/snap/bin"],
};

/**
 * Find the absolute path to a named binary.
 *
 * Search order:
 *   1. For "node": process.execPath (the running Node binary)
 *   2. PATH lookup via `which`
 *   3. Version-manager directories (NVM_DIR, FNM_DIR)
 *   4. Platform-specific well-known install paths
 *
 * Returns the resolved path or empty string if not found.
 */
export function findBinary(name: BinaryName): string {
  // For "node", prefer the current process's Node binary
  if (name === "node") {
    if (process.execPath && fs.existsSync(process.execPath)) {
      return process.execPath;
    }
  }

  // Try PATH lookup
  try {
    const result = execFileSync("which", [name], { timeout: 5000 })
      .toString()
      .trim();
    if (result && fs.existsSync(result)) return result;
  } catch {
    // not on PATH
  }

  // Try version-manager directories (NVM, FNM)
  const vmDirs: string[] = [];
  if (process.env.NVM_DIR) {
    vmDirs.push(path.join(process.env.NVM_DIR, "versions/node"));
  } else if (process.env.HOME) {
    const nvmDefault = path.join(process.env.HOME, ".nvm/versions/node");
    if (fs.existsSync(nvmDefault)) vmDirs.push(nvmDefault);
  }
  if (process.env.FNM_DIR) {
    const fnmVersions = path.join(process.env.FNM_DIR, "node-versions");
    if (fs.existsSync(fnmVersions)) vmDirs.push(fnmVersions);
  }

  for (const vmDir of vmDirs) {
    try {
      const versions = fs.readdirSync(vmDir);
      for (const v of versions) {
        // NVM: versions/node/v22.x.x/bin/<name>
        // FNM: node-versions/v22.x.x/installation/bin/<name>
        const candidates = [
          path.join(vmDir, v, "bin", name),
          path.join(vmDir, v, "installation/bin", name),
        ];
        for (const p of candidates) {
          if (fs.existsSync(p)) return p;
        }
      }
    } catch {
      // unreadable directory
    }
  }

  // Platform-specific well-known paths
  const platformDirs = PLATFORM_CANDIDATES[process.platform] || [];
  for (const dir of platformDirs) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) return p;
  }

  return "";
}
