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
        const body = await this.readBody(req) as { command?: string; args?: unknown[] };
        if (!body.command || !body.command.startsWith("claude-crew.")) {
          this.sendJson(res, 400, { error: "command must start with claude-crew." });
          return;
        }
        const result = await vscode.commands.executeCommand(body.command, ...(body.args || []));
        this.syncRuntimeFile();
        this.sendJson(res, 200, { ok: true, result: result ?? null });
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
