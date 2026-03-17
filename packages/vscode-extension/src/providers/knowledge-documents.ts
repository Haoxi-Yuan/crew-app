import * as vscode from "vscode";
import {
  CrewClient,
  type MemoryEntryDetail,
  type ReflectionInfo,
  type SharedStandard,
  type StandardHistoryEntry,
} from "../server/client.js";

export const MEMORY_SCHEME = "claude-crew-memory";
export const REFLECTION_SCHEME = "claude-crew-reflection";
export const STANDARD_SCHEME = "claude-crew-standard";

interface NativeDocumentDebugOptions {
  isEnabled?: () => boolean;
  log?: (message: string) => void;
  showError?: (message: string) => Thenable<unknown>;
}

function requireClient(getClient: () => CrewClient | null): CrewClient {
  const client = getClient();
  if (!client) {
    throw new Error("Claude Crew server is not running.");
  }
  return client;
}

function parseId(uri: vscode.Uri): string {
  return uri.path.replace(/^\/+/, "").replace(/\.md$/i, "");
}

function parseVersion(uri: vscode.Uri): number | null {
  const params = new URLSearchParams(uri.query);
  const raw = params.get("version");
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function toMarkdownMemory(entry: MemoryEntryDetail): string {
  return [
    `# ${entry.heading}`,
    "",
    `- Category: ${entry.category}`,
    `- Status: ${entry.status}`,
    `- Scope: ${entry.scope_type}${entry.scope_id ? ` / ${entry.scope_id}` : ""}`,
    `- Retrievability: ${entry.retrievability}`,
    `- Access Count: ${entry.access_count}`,
    "",
    "## Content",
    "",
    entry.content,
    "",
  ].join("\n");
}

function toMarkdownReflection(reflection: ReflectionInfo): string {
  const lessons = reflection.lessons_learned.length > 0
    ? reflection.lessons_learned
      .map((lesson) => `- **${lesson.category}**: ${lesson.description}${lesson.evidence ? `\n  Evidence: ${lesson.evidence}` : ""}`)
      .join("\n")
    : "- None";
  const updates = reflection.proposed_updates.length > 0
    ? reflection.proposed_updates
      .map((update) => [
        `### ${update.action} / ${update.section}`,
        update.current_text ? `Current: ${update.current_text}` : "",
        `Proposed: ${update.proposed_text}`,
        `Rationale: ${update.rationale}`,
        `Confidence: ${update.confidence}`,
      ].filter(Boolean).join("\n"))
      .join("\n\n")
    : "None";

  return [
    `# Reflection ${reflection.id}`,
    "",
    `- Agent: ${reflection.agent_name}`,
    `- Project: ${reflection.project_id}`,
    `- Trigger: ${reflection.trigger_type}`,
    `- Status: ${reflection.status}`,
    `- Confidence: ${reflection.confidence}`,
    "",
    "## Task Summary",
    "",
    reflection.task_summary,
    "",
    "## Lessons Learned",
    "",
    lessons,
    "",
    "## Proposed Updates",
    "",
    updates,
    "",
  ].join("\n");
}

function toMarkdownStandard(standard: SharedStandard, history?: StandardHistoryEntry): string {
  const header = history
    ? `# ${standard.name} (history v${history.version})`
    : `# ${standard.name}`;
  return [
    header,
    "",
    `- Category: ${standard.category}`,
    `- Status: ${standard.status}`,
    `- Priority: ${standard.priority}`,
    history ? `- Change Summary: ${history.change_summary}` : "",
    "",
    standard.content,
    "",
  ].filter(Boolean).join("\n");
}

export function buildMemoryUri(id: string): vscode.Uri {
  return vscode.Uri.from({ scheme: MEMORY_SCHEME, path: `/${id}.md` });
}

export function buildReflectionUri(id: string): vscode.Uri {
  return vscode.Uri.from({ scheme: REFLECTION_SCHEME, path: `/${id}.md` });
}

export function buildStandardUri(id: string, version?: number): vscode.Uri {
  const params = new URLSearchParams();
  if (version !== undefined) params.set("version", String(version));
  return vscode.Uri.from({ scheme: STANDARD_SCHEME, path: `/${id}.md`, query: params.toString() });
}

export class MemoryDocumentProvider implements vscode.TextDocumentContentProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;

  constructor(private readonly getClient: () => CrewClient | null) {}

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const client = requireClient(this.getClient);
    const entry = await client.getMemoryEntry(parseId(uri));
    return toMarkdownMemory(entry);
  }

  refresh(uri?: vscode.Uri): void {
    this.emitter.fire(uri || vscode.Uri.from({ scheme: MEMORY_SCHEME, path: "/" }));
  }
}

export class ReflectionDocumentProvider implements vscode.TextDocumentContentProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;

  constructor(private readonly getClient: () => CrewClient | null) {}

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const client = requireClient(this.getClient);
    const reflection = await client.getReflection(parseId(uri));
    return toMarkdownReflection(reflection);
  }

  refresh(uri?: vscode.Uri): void {
    this.emitter.fire(uri || vscode.Uri.from({ scheme: REFLECTION_SCHEME, path: "/" }));
  }
}

export class StandardFileSystemProvider implements vscode.FileSystemProvider {
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

  readDirectory(): Thenable<[string, vscode.FileType][]> {
    return Promise.resolve([]);
  }

  createDirectory(): void {
    throw vscode.FileSystemError.NoPermissions("Standard directories are not supported.");
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    this.debugLog(`readFile ${uri.toString(true)}`);
    const content = await this.resolveContent(uri);
    return Buffer.from(content, "utf-8");
  }

  async writeFile(uri: vscode.Uri, content: Uint8Array): Promise<void> {
    const version = parseVersion(uri);
    if (version !== null) {
      throw vscode.FileSystemError.NoPermissions("Standard history documents are read-only.");
    }
    const client = requireClient(this.getClient);
    const standardId = parseId(uri);
    const text = Buffer.from(content).toString("utf-8");
    this.debugLog(`writeFile start ${uri.toString(true)} bytes=${content.byteLength} standard=${standardId}`);
    try {
      this.debugLog(`writeFile api:start standard=${standardId}`);
      await client.updateStandard(standardId, {
        content: text,
        change_summary: "Edited in VS Code",
      });
      this.debugLog(`writeFile api:success standard=${standardId}`);
      this.emitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
      this.debugLog(`writeFile complete ${uri.toString(true)}`);
    } catch (error) {
      const message = `Failed to save standard "${standardId}": ${(error as Error).message}`;
      this.debugLog(`writeFile api:error standard=${standardId} error=${(error as Error).message}`);
      void this.debug.showError?.(message);
      throw error;
    }
  }

  delete(): void {
    throw vscode.FileSystemError.NoPermissions("Deleting standards is not supported from the editor.");
  }

  rename(): void {
    throw vscode.FileSystemError.NoPermissions("Renaming standards is not supported.");
  }

  copy(): void {
    throw vscode.FileSystemError.NoPermissions("Copying standards is not supported.");
  }

  notifyStandardChanged(id: string): void {
    this.emitter.fire([{ type: vscode.FileChangeType.Changed, uri: buildStandardUri(id) }]);
    this.debugLog(`notifyStandardChanged ${id}`);
  }

  private async resolveContent(uri: vscode.Uri): Promise<string> {
    const client = requireClient(this.getClient);
    const id = parseId(uri);
    const standards = await client.getStandards();
    const standard = standards.find((item) => item.id === id);
    if (!standard) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    const version = parseVersion(uri);
    if (version === null) {
      return standard.content;
    }
    const history = await client.getStandardHistory(id);
    const versionEntry = history.find((entry) => entry.version === version);
    if (!versionEntry) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    return toMarkdownStandard(standard, versionEntry);
  }

  private async doStat(uri: vscode.Uri): Promise<vscode.FileStat> {
    this.debugLog(`stat ${uri.toString(true)}`);
    await this.resolveContent(uri);
    return { type: vscode.FileType.File, ctime: 0, mtime: Date.now(), size: 0 };
  }

  private debugLog(message: string): void {
    if (!this.debug.isEnabled?.()) return;
    this.debug.log?.(`[standard-fs] ${message}`);
  }
}
