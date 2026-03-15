import * as vscode from "vscode";
import { fork, type ChildProcess } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";

export class ServerManager {
  private process: ChildProcess | null = null;
  private _port: number | null = null;
  private outputChannel: vscode.OutputChannel;
  private context: vscode.ExtensionContext;
  private _onDidChangeState = new vscode.EventEmitter<"starting" | "running" | "stopped">();
  public readonly onDidChangeState = this._onDidChangeState.event;

  constructor(context: vscode.ExtensionContext, outputChannel: vscode.OutputChannel) {
    this.context = context;
    this.outputChannel = outputChannel;
  }

  get port(): number | null {
    return this._port;
  }

  get isRunning(): boolean {
    return this.process !== null && this._port !== null;
  }

  async start(): Promise<number> {
    if (this.isRunning) {
      return this._port!;
    }

    this._onDidChangeState.fire("starting");
    this.outputChannel.appendLine("[claude-crew] Starting server...");

    const serverEntry = this.resolveServerEntry();
    if (!serverEntry) {
      this._onDidChangeState.fire("stopped");
      throw new Error("Server entry point not found. Please build the server first.");
    }

    const isBundled = serverEntry.endsWith("server-bundle.mjs");
    const env = this.buildEnv(serverEntry, isBundled);
    this.outputChannel.appendLine(`[claude-crew] Server entry: ${serverEntry}`);
    this.outputChannel.appendLine(`[claude-crew] Mode: ${isBundled ? "bundled" : "development"}`);
    this.outputChannel.appendLine(`[claude-crew] Data dir: ${env.CREW_DATA_DIR || "(default)"}`);
    this.outputChannel.appendLine(`[claude-crew] Project root: ${env.CREW_PROJECT_ROOT || "(default)"}`);

    const child = fork(serverEntry, [], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe", "ipc"],
      silent: true,
    });

    this.process = child;

    // Capture stdout for the ready event (structured JSON line)
    const port = await new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        this.process = null;
        this._port = null;
        this._onDidChangeState.fire("stopped");
        this.outputChannel.appendLine("[claude-crew] Server startup timed out after 30s");
        reject(new Error("Server startup timed out after 30s"));
      }, 30_000);

      let stdoutBuffer = "";

      child.stdout?.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        stdoutBuffer += text;

        // Look for the ready event JSON line
        const lines = stdoutBuffer.split("\n");
        for (const line of lines) {
          try {
            const parsed = JSON.parse(line.trim());
            if (parsed.event === "ready" && typeof parsed.port === "number") {
              clearTimeout(timeout);
              resolve(parsed.port);
              return;
            }
          } catch {
            // Not JSON, ignore
          }
        }
      });

      child.stderr?.on("data", (chunk: Buffer) => {
        this.outputChannel.appendLine(chunk.toString().trimEnd());
      });

      child.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });

      child.on("exit", (code, signal) => {
        clearTimeout(timeout);
        this.process = null;
        this._port = null;
        this._onDidChangeState.fire("stopped");
        if (code !== null && code !== 0) {
          this.outputChannel.appendLine(`[claude-crew] Server exited with code ${code}`);
          reject(new Error(`Server exited with code ${code}`));
        } else {
          this.outputChannel.appendLine(`[claude-crew] Server stopped (signal=${signal})`);
        }
      });
    });

    this._port = port;
    this._onDidChangeState.fire("running");
    this.outputChannel.appendLine(`[claude-crew] Server ready on port ${port}`);
    return port;
  }

  async stop(): Promise<void> {
    if (!this.process) return;

    this.outputChannel.appendLine("[claude-crew] Stopping server...");
    const child = this.process;
    this.process = null;
    this._port = null;

    return new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 5_000);

      child.once("exit", () => {
        clearTimeout(timeout);
        this._onDidChangeState.fire("stopped");
        resolve();
      });

      child.kill("SIGTERM");
    });
  }

  async restart(): Promise<number> {
    await this.stop();
    return this.start();
  }

  dispose(): void {
    if (this.process) {
      this.process.kill("SIGTERM");
      this.process = null;
    }
    this._port = null;
    this._onDidChangeState.fire("stopped");
    this._onDidChangeState.dispose();
  }

  private resolveServerEntry(): string | null {
    const extensionPath = this.context.extensionPath;

    const candidates = [
      // Bundled server bundle (for packaged VSIX)
      path.join(extensionPath, "server-dist", "server-bundle.mjs"),
      // Development: built server in monorepo (extension inside packages/)
      path.join(extensionPath, "..", "server", "dist", "index.js"),
    ];

    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
    return null;
  }

  private buildEnv(serverEntry: string, isBundled: boolean): Record<string, string> {
    const config = vscode.workspace.getConfiguration("claude-crew");
    const env: Record<string, string> = {};
    const extensionPath = this.context.extensionPath;
    const serverDistDir = path.join(extensionPath, "server-dist");

    // Port: 0 = auto-select
    const port = config.get<number>("server.port", 0);
    env.CREW_PORT = String(port);

    // Data directory
    const dataDir = config.get<string>("server.dataDir", "");
    if (dataDir) {
      env.CREW_DATA_DIR = dataDir;
    } else {
      env.CREW_DATA_DIR = this.context.globalStorageUri.fsPath;
    }
    fs.mkdirSync(env.CREW_DATA_DIR, { recursive: true });

    // Project root: explicit config > workspace folder > data dir
    const projectRoot = config.get<string>("server.projectRoot", "");
    if (projectRoot) {
      env.CREW_PROJECT_ROOT = projectRoot;
    } else {
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (workspaceFolders && workspaceFolders.length > 0) {
        env.CREW_PROJECT_ROOT = workspaceFolders[0].uri.fsPath;
      } else {
        env.CREW_PROJECT_ROOT = env.CREW_DATA_DIR;
      }
    }

    // Web UI directory (bundled inside extension)
    const webUiMedia = path.join(extensionPath, "media", "web-ui");
    if (fs.existsSync(webUiMedia)) {
      env.CREW_WEB_UI_DIR = webUiMedia;
    }

    if (isBundled) {
      // --- Bundled VSIX mode ---
      // Install dir: extension itself contains all packaged assets
      env.CREW_INSTALL_DIR = extensionPath;

      // Native binding: bypass `bindings` package, load .node directly
      const nativeAddon = path.join(
        serverDistDir, "native", "better-sqlite3",
        "build", "Release", "better_sqlite3.node"
      );
      if (fs.existsSync(nativeAddon)) {
        env.CREW_SQLITE_NATIVE_BINDING = nativeAddon;
      }

      // MCP bridge and tool-memory (bundled as standalone ESM files)
      const mcpBridge = path.join(serverDistDir, "mcp", "bridge.mjs");
      if (fs.existsSync(mcpBridge)) {
        env.CREW_MCP_BRIDGE_PATH = mcpBridge;
      }
      const mcpToolMemory = path.join(serverDistDir, "mcp", "tool-memory.mjs");
      if (fs.existsSync(mcpToolMemory)) {
        env.CREW_MCP_TOOL_MEMORY_PATH = mcpToolMemory;
      }

      // NODE_PATH: better-sqlite3 JS runtime (still loaded via require)
      const bundledNodeModules = path.join(serverDistDir, "native");
      if (fs.existsSync(bundledNodeModules)) {
        env.NODE_PATH = bundledNodeModules;
      }
    }
    // In development mode, all paths resolve naturally from the monorepo

    return env;
  }
}
