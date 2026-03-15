type BinaryName = "node" | "claude" | "codex" | "tmux" | "ollama";
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
export declare function findBinary(name: BinaryName): string;
export {};
