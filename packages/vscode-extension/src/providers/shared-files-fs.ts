import * as vscode from "vscode";
import {
  CrewClient,
  type ScopeFilter,
  type SharedFileDetail,
  type SharedFileInfo,
} from "../server/client.js";

export const SHARED_FILES_SCHEME = "claude-crew-shared";

interface NativeDocumentDebugOptions {
  isEnabled?: () => boolean;
  log?: (message: string) => void;
  showError?: (message: string) => Thenable<unknown>;
}

function normalizeFilePath(uri: vscode.Uri): string {
  return uri.path.replace(/^\/+/, "");
}

function parseScopeQuery(uri: vscode.Uri): ScopeFilter & { scopeName?: string | null } {
  const params = new URLSearchParams(uri.query);
  return {
    projectId: params.get("project_id"),
    workplaceId: params.get("workplace_id"),
    scopeType: params.get("scope_type"),
    scopeId: params.get("scope_id"),
    scopeName: params.get("scope_name"),
  };
}

function toDirectoryEntries(files: SharedFileInfo[], basePath: string): [string, vscode.FileType][] {
  const prefix = basePath ? `${basePath}/` : "";
  const entries = new Map<string, vscode.FileType>();
  for (const file of files) {
    if (basePath && !file.path.startsWith(prefix)) continue;
    const remaining = basePath ? file.path.slice(prefix.length) : file.path;
    if (!remaining) continue;
    const [next, ...rest] = remaining.split("/");
    entries.set(next, rest.length > 0 ? vscode.FileType.Directory : vscode.FileType.File);
  }
  return [...entries.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

export function buildSharedFileUri(file: SharedFileInfo): vscode.Uri {
  const params = new URLSearchParams();
  params.set("scope_type", file.scope_type);
  params.set("scope_id", file.scope_id);
  if (file.project_id) params.set("project_id", file.project_id);
  if (file.workplace_id) params.set("workplace_id", file.workplace_id);
  if (file.scope_name) params.set("scope_name", file.scope_name);
  return vscode.Uri.from({
    scheme: SHARED_FILES_SCHEME,
    path: `/${file.path}`,
    query: params.toString(),
  });
}

export class SharedFilesFileSystemProvider implements vscode.FileSystemProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.emitter.event;

  constructor(
    private readonly getClient: () => CrewClient | null,
    private readonly debug: NativeDocumentDebugOptions = {},
  ) {}

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => {});
  }

  stat(uri: vscode.Uri): Thenable<vscode.FileStat> {
    return this.doStat(uri);
  }

  async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    const client = this.requireClient();
    const scope = parseScopeQuery(uri);
    this.debugLog(`readDirectory ${uri.toString(true)} scope=${JSON.stringify(scope)}`);
    const files = await client.getSharedFiles(scope);
    return toDirectoryEntries(files, normalizeFilePath(uri));
  }

  createDirectory(): void {
    // Directories are created implicitly when saving a file path.
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const client = this.requireClient();
    const filePath = normalizeFilePath(uri);
    const scope = parseScopeQuery(uri);
    this.debugLog(`readFile ${uri.toString(true)} path=${filePath} scope=${JSON.stringify(scope)}`);
    const file = await client.getSharedFile(filePath, scope);
    return Buffer.from(file.content, "utf-8");
  }

  async writeFile(uri: vscode.Uri, content: Uint8Array): Promise<void> {
    const client = this.requireClient();
    const scope = parseScopeQuery(uri);
    const filePath = normalizeFilePath(uri);
    const text = Buffer.from(content).toString("utf-8");
    this.debugLog(`writeFile start ${uri.toString(true)} bytes=${content.byteLength} path=${filePath} scope=${JSON.stringify(scope)}`);
    try {
      this.debugLog(`writeFile api:start path=${filePath}`);
      await client.writeSharedFile(filePath, text, {
        ...scope,
        artifactKind: scope.scopeType === "project" ? "canonical" : "derived",
        createdBy: "user",
      });
      this.debugLog(`writeFile api:success path=${filePath}`);
      this.emitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
      this.debugLog(`writeFile complete ${uri.toString(true)}`);
    } catch (error) {
      const message = `Failed to save shared file "${filePath}": ${(error as Error).message}`;
      this.debugLog(`writeFile api:error path=${filePath} error=${(error as Error).message}`);
      void this.debug.showError?.(message);
      throw error;
    }
  }

  async delete(uri: vscode.Uri): Promise<void> {
    const client = this.requireClient();
    const filePath = normalizeFilePath(uri);
    const scope = parseScopeQuery(uri);
    this.debugLog(`delete ${uri.toString(true)} path=${filePath} scope=${JSON.stringify(scope)}`);
    await client.deleteSharedFile(filePath, scope);
    this.emitter.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
  }

  rename(): void {
    throw vscode.FileSystemError.NoPermissions("Shared file rename is not supported.");
  }

  copy(): void {
    throw vscode.FileSystemError.NoPermissions("Shared file copy is not supported.");
  }

  notifyUpdated(file: SharedFileInfo): void {
    this.emitter.fire([{ type: vscode.FileChangeType.Changed, uri: buildSharedFileUri(file) }]);
    this.debugLog(`notifyUpdated ${file.path} scope=${file.scope_type}:${file.scope_id}`);
  }

  private async doStat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const path = normalizeFilePath(uri);
    this.debugLog(`stat ${uri.toString(true)} path=${path || "/"}`);
    if (!path) {
      return { type: vscode.FileType.Directory, ctime: 0, mtime: Date.now(), size: 0 };
    }

    const client = this.requireClient();
    try {
      const file = await client.getSharedFile(path, parseScopeQuery(uri));
      return {
        type: vscode.FileType.File,
        ctime: file.updated_at,
        mtime: file.updated_at,
        size: file.size_bytes ?? Buffer.byteLength(file.content, "utf-8"),
      };
    } catch {
      const dirEntries = await client.getSharedFiles(parseScopeQuery(uri));
      const prefix = `${path}/`;
      if (dirEntries.some((entry) => entry.path.startsWith(prefix))) {
        return { type: vscode.FileType.Directory, ctime: 0, mtime: Date.now(), size: 0 };
      }
      throw vscode.FileSystemError.FileNotFound(uri);
    }
  }

  private requireClient(): CrewClient {
    const client = this.getClient();
    if (!client) {
      throw vscode.FileSystemError.Unavailable("Claude Crew server is not running.");
    }
    return client;
  }

  private debugLog(message: string): void {
    if (!this.debug.isEnabled?.()) return;
    this.debug.log?.(`[shared-files-fs] ${message}`);
  }
}

export function formatSharedFileLabel(file: SharedFileInfo): string {
  const scopeName = file.scope_name ? `${file.scope_type}:${file.scope_name}` : file.scope_type;
  return `${file.path} (${scopeName})`;
}

export function sharedFileMarkdown(file: SharedFileDetail): string {
  return [
    `# ${file.path}`,
    "",
    `- Scope: ${file.scope_type}${file.scope_name ? ` / ${file.scope_name}` : ""}`,
    `- Updated: ${new Date(file.updated_at).toLocaleString()}`,
    "",
    "```",
    file.content,
    "```",
    "",
  ].join("\n");
}
