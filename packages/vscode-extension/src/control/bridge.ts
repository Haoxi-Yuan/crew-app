import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import * as vscode from "vscode";
import type { ServerManager } from "../server/manager.js";
import {
  clearRuntimeRecord,
  writeRuntimeRecord,
  type VscodeRuntimeRecord,
} from "./runtime-registry.js";

type ServerState = "starting" | "running" | "stopped";
type CommandRequestBody = { command?: string; args?: unknown[] };
type ActiveEditorSnapshot = {
  active: boolean;
  uri: string | null;
  scheme: string | null;
  isDirty: boolean;
  text: string | null;
};

export class ControlBridge implements vscode.Disposable {
  private readonly token = crypto.randomBytes(24).toString("hex");
  private readonly startedAt = new Date().toISOString();
  private readonly outputChannel: vscode.OutputChannel;
  private readonly context: vscode.ExtensionContext;
  private readonly serverManager: ServerManager;
  private server: http.Server | null = null;
  private controlPort: number | null = null;
  private serverState: ServerState = "stopped";
  private disposed = false;
  private readonly exposeTestEndpoints = process.env.CLAUDE_CREW_E2E === "1";

  constructor(
    context: vscode.ExtensionContext,
    serverManager: ServerManager,
    outputChannel: vscode.OutputChannel,
  ) {
    this.context = context;
    this.serverManager = serverManager;
    this.outputChannel = outputChannel;
  }

  async start(): Promise<void> {
    if (this.server) {
      return;
    }

    const server = http.createServer((req, res) => {
      void this.handleRequest(req, res);
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });

    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("Control bridge failed to bind to a local TCP port.");
    }

    this.server = server;
    this.controlPort = address.port;
    this.syncRuntimeFile();
    this.outputChannel.appendLine(`[claude-crew] Control bridge listening on 127.0.0.1:${address.port}`);
    if (this.exposeTestEndpoints) {
      this.outputChannel.appendLine("[claude-crew] Control bridge test editor endpoints enabled");
    }
  }

  updateServerState(state: ServerState): void {
    this.serverState = state;
    this.syncRuntimeFile();
  }

  dispose(): void {
    this.disposed = true;
    clearRuntimeRecord(this.token);
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!this.isAuthorized(req)) {
      this.sendJson(res, 401, { error: "unauthorized" });
      return;
    }

    const method = req.method || "GET";
    const url = new URL(req.url || "/", "http://127.0.0.1");

    try {
      if (method === "GET" && url.pathname === "/health") {
        this.sendJson(res, 200, { ok: true });
        return;
      }

      if (method === "GET" && url.pathname === "/runtime") {
        this.sendJson(res, 200, this.buildRuntimeRecord());
        return;
      }

      if (method === "POST" && url.pathname === "/server/start") {
        await this.serverManager.start();
        this.syncRuntimeFile();
        this.sendJson(res, 200, this.buildRuntimeRecord());
        return;
      }

      if (method === "POST" && url.pathname === "/server/stop") {
        await this.serverManager.stop();
        this.syncRuntimeFile();
        this.sendJson(res, 200, this.buildRuntimeRecord());
        return;
      }

      if (method === "POST" && url.pathname === "/server/restart") {
        await this.serverManager.restart();
        this.syncRuntimeFile();
        this.sendJson(res, 200, this.buildRuntimeRecord());
        return;
      }

      if (method === "POST" && url.pathname === "/command") {
        const body = await this.readBody(req) as CommandRequestBody;
        if (!body.command || !body.command.startsWith("claude-crew.")) {
          this.sendJson(res, 400, { error: "command must start with claude-crew." });
          return;
        }
        const result = await vscode.commands.executeCommand(body.command, ...this.reviveArgs(body.args || []));
        this.syncRuntimeFile();
        this.sendJson(res, 200, { ok: true, result: result ?? null });
        return;
      }

      if (this.exposeTestEndpoints && method === "GET" && url.pathname === "/editor/active") {
        this.sendJson(res, 200, this.getActiveEditorSnapshot());
        return;
      }

      if (this.exposeTestEndpoints && method === "POST" && url.pathname === "/editor/replace-and-save") {
        const body = await this.readBody(req) as { text?: string };
        if (typeof body.text !== "string") {
          this.sendJson(res, 400, { error: "text is required" });
          return;
        }
        const snapshot = await this.replaceAndSaveActiveDocument(body.text);
        this.sendJson(res, 200, snapshot);
        return;
      }

      this.sendJson(res, 404, { error: "not found" });
    } catch (error) {
      this.outputChannel.appendLine(`[claude-crew] Control bridge error: ${(error as Error).message}`);
      this.sendJson(res, 500, { error: (error as Error).message });
    }
  }

  private isAuthorized(req: http.IncomingMessage): boolean {
    const token = req.headers["x-claude-crew-token"];
    return token === this.token;
  }

  private async readBody(req: http.IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    if (chunks.length === 0) {
      return {};
    }

    const body = Buffer.concat(chunks).toString("utf-8").trim();
    if (!body) {
      return {};
    }

    return JSON.parse(body);
  }

  private sendJson(res: http.ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload),
    });
    res.end(payload);
  }

  private reviveArgs(values: unknown[]): unknown[] {
    return values.map((value) => this.reviveValue(value));
  }

  private reviveValue(value: unknown): unknown {
    if (Array.isArray(value)) {
      return value.map((item) => this.reviveValue(item));
    }
    if (!value || typeof value !== "object") {
      return value;
    }
    if (this.isUriLike(value)) {
      return vscode.Uri.from({
        scheme: value.scheme,
        authority: value.authority || "",
        path: value.path,
        query: value.query || "",
        fragment: value.fragment || "",
      });
    }
    const entries = Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, this.reviveValue(item)]);
    return Object.fromEntries(entries);
  }

  private isUriLike(value: unknown): value is { scheme: string; path: string; authority?: string; query?: string; fragment?: string } {
    if (!value || typeof value !== "object") return false;
    const candidate = value as Record<string, unknown>;
    return typeof candidate.scheme === "string" && typeof candidate.path === "string";
  }

  private getActiveEditorSnapshot(): ActiveEditorSnapshot {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return { active: false, uri: null, scheme: null, isDirty: false, text: null };
    }
    return {
      active: true,
      uri: editor.document.uri.toString(true),
      scheme: editor.document.uri.scheme,
      isDirty: editor.document.isDirty,
      text: editor.document.getText(),
    };
  }

  private async replaceAndSaveActiveDocument(text: string): Promise<ActiveEditorSnapshot> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      throw new Error("No active text editor.");
    }
    const document = editor.document;
    const fullRange = new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length));
    const changed = await editor.edit((editBuilder) => {
      editBuilder.replace(fullRange, text);
    });
    if (!changed) {
      throw new Error("Failed to update the active document.");
    }
    const saved = await document.save();
    if (!saved) {
      throw new Error("Failed to save the active document.");
    }
    return this.getActiveEditorSnapshot();
  }

  private buildRuntimeRecord(): VscodeRuntimeRecord {
    return {
      source: "vscode-extension",
      controlPort: this.controlPort ?? 0,
      token: this.token,
      pid: process.pid,
      startedAt: this.startedAt,
      updatedAt: new Date().toISOString(),
      workspaceFolders: (vscode.workspace.workspaceFolders || []).map((folder) => folder.uri.fsPath),
      dataDir: this.resolveDataDir(),
      projectRoot: this.resolveProjectRoot(),
      server: {
        state: this.serverState,
        port: this.serverManager.port,
      },
    };
  }

  private resolveDataDir(): string {
    const configured = vscode.workspace.getConfiguration("claude-crew").get<string>("server.dataDir", "");
    return configured || this.context.globalStorageUri.fsPath;
  }

  private resolveProjectRoot(): string {
    const configured = vscode.workspace.getConfiguration("claude-crew").get<string>("server.projectRoot", "");
    if (configured) {
      return configured;
    }

    const workspaceFolders = vscode.workspace.workspaceFolders || [];
    for (const folder of workspaceFolders) {
      const direct = folder.uri.fsPath;
      if (this.looksLikeCrewProjectRoot(direct)) {
        return direct;
      }

      try {
        const children = fs.readdirSync(direct, { withFileTypes: true });
        for (const child of children) {
          if (!child.isDirectory()) {
            continue;
          }
          const candidate = path.join(direct, child.name);
          if (this.looksLikeCrewProjectRoot(candidate)) {
            return candidate;
          }
        }
      } catch {
        // Ignore unreadable directories.
      }
    }

    return this.resolveDataDir();
  }

  private looksLikeCrewProjectRoot(candidate: string): boolean {
    return fs.existsSync(path.join(candidate, "agents"))
      && fs.existsSync(path.join(candidate, "package.json"));
  }

  private syncRuntimeFile(): void {
    if (this.disposed || !this.controlPort) {
      return;
    }
    writeRuntimeRecord(this.buildRuntimeRecord());
  }
}
