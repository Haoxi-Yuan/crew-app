# Claude Crew VS Code Extension - Complete Migration Plan

> Status: DRAFT
> Created: 2026-03-13
> Goal: Replace Swift native app with VS Code extension, publish to Marketplace, full feature parity

---

## Table of Contents

1. [Overview](#1-overview)
2. [Phase 0: Configuration Management Overhaul](#2-phase-0-configuration-management-overhaul)
3. [Phase 1: Server Portability](#3-phase-1-server-portability)
4. [Phase 2: VS Code Extension Core](#4-phase-2-vscode-extension-core)
5. [Phase 3: Web UI Dark Theme Migration](#5-phase-3-web-ui-dark-theme-migration)
6. [Phase 4: Terminal Management Abstraction](#6-phase-4-terminal-management-abstraction)
7. [Phase 5: Full Feature Integration](#7-phase-5-full-feature-integration)
8. [Phase 6: Multi-Model Support](#8-phase-6-multi-model-support)
9. [Phase 7: Packaging & Marketplace](#9-phase-7-packaging-marketplace)
10. [Cross-Cutting Concerns](#10-cross-cutting-concerns)
11. [File Inventory](#11-file-inventory)
12. [Risk Assessment](#12-risk-assessment)

---

## 1. Overview

### 1.1 Current Architecture

```
Swift App (macOS only)
    -> WKWebView -> http://127.0.0.1:3140
    -> ServerProcess.swift spawns Node.js server

Node.js Server (Express 5 + SQLite)
    -> REST API + WebSocket
    -> tmux-monitor (agent terminal management)
    -> memory-engine, sop-engine, embedding
    -> MCP bridge (per-agent)

CLI Scripts (bash)
    -> crew.sh, crew-manage.sh
    -> macOS-specific paths throughout
```

### 1.2 Target Architecture

```
VS Code Extension (cross-platform: macOS / Linux / Windows)
    -> Activity Bar: Agent tree, Project tree
    -> WebView Panel: Group chat, Dashboard, Peaks, Approvals
    -> Status Bar: Agent count, pending mentions, approvals
    -> Notifications: @mentions, approvals, peaks
    -> Terminal: Agent terminals (VS Code Terminal API or tmux fallback)
    -> Commands: Start/Stop/Wake/Attach/Configure
    -> Settings: All configuration via VS Code Settings UI

Node.js Server (embedded as child process)
    -> Same Express 5 + SQLite core
    -> Unified config system (replaces scattered constants)
    -> Cross-platform terminal provider (tmux | vscode-terminal)
    -> Data stored in VS Code extension globalStoragePath

MCP Bridge (unchanged)
    -> Per-agent MCP server, communicates with central server
```

### 1.3 Constraints

- **Zero feature regression**: Every feature in the current system MUST work identically
- **Cross-platform**: macOS, Linux, Windows (WSL for terminal features if native unavailable)
- **Single install**: User installs VS Code extension -> everything works
- **Server bundled**: No separate `npm install` or `pnpm build` required by end user
- **Multi-model**: Support Claude, Codex, and extensible to other providers

---

## 2. Phase 0: Configuration Management Overhaul

> Prerequisite for all other phases. Fixes the project's fundamental deficiency.

### 2.1 Problem Inventory

Current configuration is scattered across 10+ files with hardcoded values:

| Location | Issues |
|----------|--------|
| `config.ts` | Only 6 values configurable; all timeouts hardcoded |
| `memory-engine.ts` | 12 ML parameters hardcoded (ACT_R_DECAY, category weights, etc.) |
| `sop-engine.ts` | MAX_STANDARDS_BUDGET=4000, auto-apply threshold=0.8 hardcoded |
| `tmux-monitor.ts` | MONITOR_INTERVAL_MS=2000, capture lines=80 hardcoded |
| `embedding.ts` | EMBEDDING_DIM=768 hardcoded (model-specific), timeouts hardcoded |
| `agents.ts` | Binary paths: `/opt/homebrew/`, `~/.nvm/` (macOS only) |
| `codex.ts` | **CRITICAL**: `/Users/yuan/.nvm/versions/node/v22.14.0/bin/node` hardcoded |
| `index.ts` | Server binds to `127.0.0.1` only, peak check interval=30000 hardcoded |
| `mcp-bridge/client.ts` | Retry delays [500,1000,2000,4000,8000] hardcoded |
| `web-ui/utils.ts` | Context thresholds 60%/80% not synced with server's 80% |

### 2.2 Solution: Unified Configuration System

Create a single source of truth: `packages/server/src/config.ts` that exports ALL configurable values, loaded from a layered config system.

#### 2.2.1 Config Loading Priority (highest to lowest)

```
1. Environment variables (CREW_*)         -> runtime override
2. Config file (~/.claude-crew/config.json or project-level .claude-crew.json)  -> user preference
3. VS Code settings (when running as extension)  -> editor integration
4. Built-in defaults                      -> always works out of box
```

#### 2.2.2 New `config.ts` Structure

```typescript
// packages/server/src/config.ts

export interface CrewConfig {
  // --- Server ---
  server: {
    port: number;                    // default: 3140, env: CREW_PORT
    host: string;                    // default: "127.0.0.1", env: CREW_HOST
    dataDir: string;                 // default: platform-specific (see 2.2.3)
    logLevel: "debug" | "info" | "warn" | "error";  // default: "info"
  };

  // --- Agent Management ---
  agent: {
    defaultProvider: "claude" | "codex";    // default: "claude"
    heartbeatTimeoutMs: number;             // default: 60000
    heartbeatCheckIntervalMs: number;       // default: 15000
    autoCycleContextPercent: number;        // default: 80
    autoCycleCooldownMs: number;            // default: 300000
    autoCycleReflectionPauseMs: number;     // default: 5000
    contextWarningPercent: number;          // default: 60  (sync with UI)
    contextCriticalPercent: number;         // default: 80  (sync with UI)
    worklogMaxBytes: number;               // default: 102400 (100KB)
    projectContextMaxChars: number;        // default: 12000
  };

  // --- Terminal ---
  terminal: {
    provider: "tmux" | "vscode" | "auto";  // default: "auto"
    monitorIntervalMs: number;              // default: 2000
    captureLines: number;                   // default: 80
    autoCycleCheckIntervalMs: number;       // default: 30000
  };

  // --- Embedding ---
  embedding: {
    provider: "ollama" | "none";            // default: "ollama"
    ollamaBaseUrl: string;                  // default: "http://127.0.0.1:11434"
    ollamaModel: string;                    // default: "nomic-embed-text"
    embeddingDim: number;                   // default: 768
    checkIntervalMs: number;                // default: 60000
    requestTimeoutMs: number;               // default: 10000
    availabilityTimeoutMs: number;          // default: 2000
  };

  // --- Memory Engine ---
  memory: {
    actRDecay: number;                      // default: 0.5
    retrievabilitySteepness: number;        // default: 3.0
    retrievabilityThreshold: number;        // default: -1.0
    maxStabilityDays: number;               // default: 365
    maxTimestamps: number;                  // default: 20
    archiveThreshold: number;               // default: 0.05
    categoryWeights: Record<string, number>; // default: {contact:2.0, preference:1.5, ...}
    permanentCategories: string[];           // default: ["contact", "preference"]
    slowDecayCategories: string[];           // default: ["decision", "project"]
  };

  // --- SOP / Standards ---
  standards: {
    maxBudgetChars: number;                 // default: 4000
    autoApplyConfidenceThreshold: number;   // default: 0.8
    consensusMinAgents: number;             // default: 2
  };

  // --- PEAK System ---
  peak: {
    defaultTimeoutSeconds: number;          // default: 300
    minTimeoutSeconds: number;              // default: 30
    maxTimeoutSeconds: number;              // default: 1800
    extensionSeconds: number;               // default: 600
    checkIntervalMs: number;                // default: 30000
  };

  // --- MCP Bridge ---
  bridge: {
    serverUrl: string;                      // default: "http://127.0.0.1:3140"
    maxRetries: number;                     // default: 5
    retryDelays: number[];                  // default: [500, 1000, 2000, 4000, 8000]
  };
}
```

#### 2.2.3 Platform-Specific Default Data Directory

```typescript
function getDefaultDataDir(): string {
  const platform = process.platform;
  if (platform === "win32") {
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "claude-crew");
  } else if (platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "claude-crew");
  } else {
    // Linux: follow XDG spec
    return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "claude-crew");
  }
}
```

When running inside VS Code extension, `dataDir` will be overridden to `context.globalStorageUri.fsPath`.

#### 2.2.4 Config File Format

```json
// ~/.claude-crew/config.json
{
  "server": {
    "port": 3140,
    "logLevel": "info"
  },
  "agent": {
    "defaultProvider": "claude",
    "autoCycleContextPercent": 85
  },
  "embedding": {
    "provider": "ollama",
    "ollamaModel": "nomic-embed-text"
  }
}
```

Deep-merged with defaults. Only user-specified fields override.

#### 2.2.5 Config Loader Implementation

```typescript
// packages/server/src/config-loader.ts

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const DEFAULTS: CrewConfig = { /* all default values */ };

export function loadConfig(overrides?: Partial<CrewConfig>): CrewConfig {
  // 1. Start with defaults
  let config = structuredClone(DEFAULTS);

  // 2. Load config file (if exists)
  const configPaths = [
    path.join(os.homedir(), ".claude-crew", "config.json"),
    path.join(process.cwd(), ".claude-crew.json"),
  ];
  for (const p of configPaths) {
    if (fs.existsSync(p)) {
      const fileConfig = JSON.parse(fs.readFileSync(p, "utf-8"));
      config = deepMerge(config, fileConfig);
    }
  }

  // 3. Apply environment variables
  config = applyEnvOverrides(config);

  // 4. Apply programmatic overrides (from VS Code settings)
  if (overrides) {
    config = deepMerge(config, overrides);
  }

  // 5. Validate with Zod schema
  return configSchema.parse(config);
}
```

#### 2.2.6 Files to Modify

| File | Changes |
|------|---------|
| `packages/server/src/config.ts` | Rewrite: export unified CrewConfig, remove hardcoded constants |
| `packages/server/src/config-loader.ts` | **NEW**: Config loading, merging, validation |
| `packages/server/src/config-schema.ts` | **NEW**: Zod schema for config validation |
| `packages/server/src/memory-engine.ts` | Import ML params from config instead of hardcoding |
| `packages/server/src/sop-engine.ts` | Import thresholds from config |
| `packages/server/src/tmux-monitor.ts` | Import intervals from config |
| `packages/server/src/embedding.ts` | Import dim, timeouts from config |
| `packages/server/src/index.ts` | Use config.server.host, config.peak.checkIntervalMs |
| `packages/server/src/api/agents.ts` | Use cross-platform binary finder from shared util |
| `packages/server/src/providers/codex.ts` | **CRITICAL**: Remove hardcoded `/Users/yuan/...` paths, use binary finder |
| `packages/mcp-bridge/src/client.ts` | Import bridge config (url, retries, delays) |
| `packages/web-ui/src/utils.ts` | Receive thresholds from server API (new `/api/config/ui` endpoint) |

### 2.3 Cross-Platform Binary Finder

Extract duplicated Node.js/Claude CLI path detection into a shared utility:

```typescript
// packages/server/src/utils/find-binary.ts

export function findBinary(name: string): string | null {
  // 1. which / where (cross-platform)
  // 2. Platform-specific fallback paths:
  //    - macOS: /opt/homebrew/bin, /usr/local/bin
  //    - Linux: /usr/bin, /usr/local/bin, /snap/bin
  //    - Windows: check PATH, common install dirs
  // 3. nvm/fnm detection (check NVM_DIR, FNM_DIR env vars, not hardcoded paths)
  // 4. Return null if not found (caller decides how to handle)
}
```

Currently duplicated in:
- `crew.sh` (lines 13-24)
- `crew-manage.sh` (lines 14-31)
- `packages/server/src/api/agents.ts` (findNodePath, findClaudePath)
- `packages/server/src/tmux-monitor.ts` (findClaudePath)
- `packages/server/src/providers/codex.ts` (findNodePath, findCodexPath)

All these must be consolidated into one implementation.

### 2.4 Database Migration System

Current state: Ad-hoc ALTER TABLE checks in `schema.ts` (lines 7-48). No version tracking.

New system:

```typescript
// packages/server/src/db/migrations.ts

interface Migration {
  version: number;
  description: string;
  up(db: Database.Database): void;
}

const migrations: Migration[] = [
  {
    version: 1,
    description: "Initial schema",
    up(db) { /* current CREATE TABLE statements */ }
  },
  {
    version: 2,
    description: "Add channel_id to messages",
    up(db) { db.exec("ALTER TABLE messages ADD COLUMN channel_id TEXT DEFAULT 'general'"); }
  },
  // ... all existing ALTER TABLE migrations extracted here
];

export function runMigrations(db: Database.Database): void {
  db.exec("CREATE TABLE IF NOT EXISTS _migrations (version INTEGER PRIMARY KEY, applied_at INTEGER)");
  const applied = db.prepare("SELECT version FROM _migrations").all().map(r => r.version);
  for (const m of migrations) {
    if (!applied.includes(m.version)) {
      m.up(db);
      db.prepare("INSERT INTO _migrations (version, applied_at) VALUES (?, ?)").run(m.version, Date.now());
    }
  }
}
```

---

## 3. Phase 1: Server Portability

> Make the server runnable as a bundled dependency (no user-facing build step).

### 3.1 Server Bundling

The server must be distributable as a single JS bundle inside the VS Code extension.

#### 3.1.1 Bundle Strategy

Use `esbuild` to bundle the entire server into one file:

```typescript
// packages/server/esbuild.config.ts
{
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  target: "node18",
  outfile: "dist/server.bundle.js",
  external: ["better-sqlite3"],  // native module, cannot bundle
  format: "esm",
}
```

`better-sqlite3` is a native Node.js addon. It must be:
- Included as a prebuilt binary for each platform (macOS arm64, macOS x64, Linux x64, Linux arm64, Windows x64)
- Or use `@vscode/vsce` platform-specific packaging to include the correct binary

#### 3.1.2 Native Module Strategy

Options:
- **A. Platform-specific VSIX**: Build separate `.vsix` for each platform, each including the correct `better-sqlite3` binary. VS Code Marketplace supports this via `--target` flag.
- **B. sql.js (pure WASM SQLite)**: Replace `better-sqlite3` with `sql.js` (pure JavaScript/WASM SQLite). Zero native modules. Trade-off: slightly slower, but eliminates all native compilation issues.
- **C. Prebuild binaries**: Use `@mapbox/node-pre-gyp` or `prebuild-install` to download correct binary at activation.

**Recommendation: Option A** (platform-specific VSIX). VS Code's `vsce` tool natively supports this, and it keeps the fast `better-sqlite3` performance. See Phase 7 for packaging details.

### 3.2 Path Resolution

All path computations must work when the server runs from inside the extension:

```typescript
// When running standalone:
//   PROJECT_ROOT = resolved from __dirname
//   DATA_DIR = {PROJECT_ROOT}/data

// When running inside VS Code extension:
//   SERVER_BUNDLE = {extensionPath}/dist/server.bundle.js
//   DATA_DIR = context.globalStorageUri.fsPath  (managed by VS Code)
//   WEB_UI_DIR = {extensionPath}/media/web-ui
//   AGENTS_DIR = {workspaceFolder}/.claude-crew/agents  (or DATA_DIR/agents)
```

The config loader accepts an `overrides` parameter that the extension uses to inject VS Code-specific paths.

### 3.3 Server Startup API

Add a programmatic startup entry point (not just CLI):

```typescript
// packages/server/src/start.ts

export interface ServerOptions {
  config?: Partial<CrewConfig>;
  onReady?: (port: number) => void;
  onError?: (error: Error) => void;
  signal?: AbortSignal;
}

export async function startServer(options: ServerOptions): Promise<void> {
  const config = loadConfig(options.config);
  // ... initialize DB, start Express, start monitors ...
  options.onReady?.(config.server.port);
}
```

This enables:
- VS Code extension: `import { startServer } from "./server.bundle.js"` (in-process)
- Or: spawn as child process and communicate via HTTP (out-of-process, current approach)

**Decision: Out-of-process (child process)**. Reasons:
- Server uses `better-sqlite3` which needs native module loading
- Isolates crashes (server crash doesn't kill extension host)
- Consistent with current Swift app architecture
- Extension just manages lifecycle + connects via HTTP/WebSocket

---

## 4. Phase 2: VS Code Extension Core

### 4.1 Extension Structure

```
packages/vscode-extension/
├── package.json               # Extension manifest
├── tsconfig.json
├── esbuild.config.ts          # Bundle extension code
├── src/
│   ├── extension.ts           # Activation/deactivation entry point
│   ├── server/
│   │   ├── manager.ts         # Server child process lifecycle
│   │   ├── health.ts          # Health check polling
│   │   └── client.ts          # HTTP + WebSocket client to server
│   ├── views/
│   │   ├── webview-panel.ts   # Main WebView panel (chat + dashboard)
│   │   ├── agent-tree.ts      # TreeDataProvider: agent list
│   │   ├── project-tree.ts    # TreeDataProvider: project list
│   │   └── shared-files-tree.ts # TreeDataProvider: shared files
│   ├── terminal/
│   │   ├── provider.ts        # Terminal provider abstraction
│   │   ├── tmux-provider.ts   # tmux-based terminal (existing behavior)
│   │   └── vscode-provider.ts # VS Code Terminal API provider
│   ├── features/
│   │   ├── notifications.ts   # Mention/approval/peak notifications
│   │   ├── status-bar.ts      # Status bar items
│   │   ├── commands.ts        # All registered commands
│   │   └── config-sync.ts     # Sync VS Code settings -> server config
│   └── utils/
│       ├── platform.ts        # Platform detection & binary finding
│       └── logger.ts          # Output channel logging
├── media/
│   ├── web-ui/                # Bundled web UI files (from packages/web-ui)
│   │   ├── index.html
│   │   ├── bundle.js
│   │   └── styles.css
│   ├── icons/                 # Extension icons
│   │   ├── crew.svg           # Activity bar icon
│   │   ├── agent-online.svg
│   │   ├── agent-offline.svg
│   │   ├── agent-busy.svg
│   │   └── project.svg
│   └── dark/                  # Dark theme icons (VS Code convention)
│       └── ...
└── test/
    ├── extension.test.ts
    └── server-manager.test.ts
```

### 4.2 Extension Manifest (`package.json`)

```jsonc
{
  "name": "claude-crew",
  "displayName": "Claude Crew",
  "description": "Multi-agent collaboration platform - coordinate multiple AI agents through group chat",
  "version": "0.1.0",
  "publisher": "claude-crew",
  "license": "MIT",
  "engines": { "vscode": "^1.85.0" },
  "categories": ["AI", "Chat", "Other"],
  "keywords": ["claude", "multi-agent", "ai", "collaboration", "mcp"],
  "icon": "media/icons/crew.png",
  "main": "./dist/extension.js",

  "activationEvents": [],

  "contributes": {
    "commands": [
      // Server
      { "command": "claude-crew.startServer", "title": "Start Server", "category": "Claude Crew" },
      { "command": "claude-crew.stopServer", "title": "Stop Server", "category": "Claude Crew" },
      { "command": "claude-crew.restartServer", "title": "Restart Server", "category": "Claude Crew" },
      { "command": "claude-crew.showStatus", "title": "Show Status", "category": "Claude Crew" },

      // Panel
      { "command": "claude-crew.openChat", "title": "Open Chat Panel", "category": "Claude Crew", "icon": "$(comment-discussion)" },
      { "command": "claude-crew.openDashboard", "title": "Open Dashboard", "category": "Claude Crew", "icon": "$(dashboard)" },

      // Agent management
      { "command": "claude-crew.addAgent", "title": "Add Agent", "category": "Claude Crew", "icon": "$(add)" },
      { "command": "claude-crew.removeAgent", "title": "Remove Agent", "category": "Claude Crew" },
      { "command": "claude-crew.wakeAgent", "title": "Wake Agent", "category": "Claude Crew", "icon": "$(debug-start)" },
      { "command": "claude-crew.wakeAll", "title": "Wake All Agents", "category": "Claude Crew" },
      { "command": "claude-crew.killAgent", "title": "Stop Agent", "category": "Claude Crew", "icon": "$(debug-stop)" },
      { "command": "claude-crew.killAll", "title": "Stop All Agents", "category": "Claude Crew" },
      { "command": "claude-crew.attachTerminal", "title": "Open Agent Terminal", "category": "Claude Crew", "icon": "$(terminal)" },
      { "command": "claude-crew.configureAgent", "title": "Configure Agent", "category": "Claude Crew", "icon": "$(gear)" },

      // Project
      { "command": "claude-crew.createProject", "title": "Create Project", "category": "Claude Crew" },

      // Utilities
      { "command": "claude-crew.refreshAgents", "title": "Refresh Agents", "category": "Claude Crew", "icon": "$(refresh)" },
      { "command": "claude-crew.refreshProjects", "title": "Refresh Projects", "category": "Claude Crew", "icon": "$(refresh)" }
    ],

    "viewsContainers": {
      "activitybar": [{
        "id": "claude-crew-sidebar",
        "title": "Claude Crew",
        "icon": "media/icons/crew.svg"
      }]
    },

    "views": {
      "claude-crew-sidebar": [
        {
          "id": "claude-crew.agentList",
          "name": "Agents",
          "icon": "$(person)",
          "contextualTitle": "Claude Crew Agents"
        },
        {
          "id": "claude-crew.projectList",
          "name": "Projects",
          "icon": "$(project)",
          "contextualTitle": "Claude Crew Projects"
        },
        {
          "id": "claude-crew.sharedFiles",
          "name": "Shared Files",
          "icon": "$(files)",
          "contextualTitle": "Claude Crew Shared Files"
        }
      ]
    },

    "viewsWelcome": [
      {
        "view": "claude-crew.agentList",
        "contents": "No agents registered.\n[Add Agent](command:claude-crew.addAgent)\n[Start Server](command:claude-crew.startServer)"
      }
    ],

    "menus": {
      "view/title": [
        { "command": "claude-crew.refreshAgents", "when": "view == claude-crew.agentList", "group": "navigation" },
        { "command": "claude-crew.addAgent", "when": "view == claude-crew.agentList", "group": "navigation" },
        { "command": "claude-crew.wakeAll", "when": "view == claude-crew.agentList" },
        { "command": "claude-crew.killAll", "when": "view == claude-crew.agentList" },
        { "command": "claude-crew.refreshProjects", "when": "view == claude-crew.projectList", "group": "navigation" },
        { "command": "claude-crew.createProject", "when": "view == claude-crew.projectList", "group": "navigation" }
      ],
      "view/item/context": [
        { "command": "claude-crew.wakeAgent", "when": "view == claude-crew.agentList && viewItem == agent-offline", "group": "inline" },
        { "command": "claude-crew.killAgent", "when": "view == claude-crew.agentList && viewItem =~ /agent-(online|busy)/", "group": "inline" },
        { "command": "claude-crew.attachTerminal", "when": "view == claude-crew.agentList && viewItem =~ /agent-(online|busy|idle)/", "group": "inline" },
        { "command": "claude-crew.configureAgent", "when": "view == claude-crew.agentList" },
        { "command": "claude-crew.removeAgent", "when": "view == claude-crew.agentList" }
      ]
    },

    "configuration": {
      "title": "Claude Crew",
      "properties": {
        "claude-crew.server.port": {
          "type": "number",
          "default": 3140,
          "description": "Server port number"
        },
        "claude-crew.server.autoStart": {
          "type": "boolean",
          "default": true,
          "description": "Automatically start server when extension activates"
        },
        "claude-crew.server.logLevel": {
          "type": "string",
          "enum": ["debug", "info", "warn", "error"],
          "default": "info",
          "description": "Server log level"
        },
        "claude-crew.agent.defaultProvider": {
          "type": "string",
          "enum": ["claude", "codex"],
          "default": "claude",
          "description": "Default AI provider for new agents"
        },
        "claude-crew.agent.autoCycleContextPercent": {
          "type": "number",
          "default": 80,
          "minimum": 50,
          "maximum": 100,
          "description": "Context usage percentage that triggers auto-cycle"
        },
        "claude-crew.terminal.provider": {
          "type": "string",
          "enum": ["auto", "tmux", "vscode"],
          "default": "auto",
          "description": "Terminal provider for agent sessions. 'auto' detects tmux availability."
        },
        "claude-crew.embedding.provider": {
          "type": "string",
          "enum": ["ollama", "none"],
          "default": "ollama",
          "description": "Embedding provider for semantic memory search. 'none' falls back to keyword search."
        },
        "claude-crew.embedding.ollamaBaseUrl": {
          "type": "string",
          "default": "http://127.0.0.1:11434",
          "description": "Ollama server URL"
        },
        "claude-crew.embedding.ollamaModel": {
          "type": "string",
          "default": "nomic-embed-text",
          "description": "Ollama embedding model name"
        }
      }
    }
  }
}
```

### 4.3 Extension Lifecycle (`extension.ts`)

```typescript
// Activation flow:
// 1. Read VS Code settings, build config overrides
// 2. Determine dataDir (context.globalStorageUri.fsPath)
// 3. Start server child process (if autoStart enabled)
// 4. Wait for health check
// 5. Connect WebSocket client
// 6. Register all commands, tree views, status bar
// 7. Open WebView panel (if previously open)

// Deactivation flow:
// 1. Close WebSocket connection
// 2. Send SIGTERM to server process
// 3. Wait for graceful shutdown (max 5s)
// 4. Force kill if still running
```

### 4.4 Server Manager (`server/manager.ts`)

Responsibilities:
- Spawn Node.js child process running the bundled server
- Pass configuration via environment variables or temp config file
- Pipe stdout/stderr to VS Code Output Channel ("Claude Crew Server")
- Health check via `GET /api/status` with exponential backoff
- Handle server crashes (notify user, offer restart)
- Graceful shutdown on extension deactivation

```typescript
export class ServerManager extends EventEmitter {
  private process: ChildProcess | null = null;
  private status: "stopped" | "starting" | "running" | "error" = "stopped";

  async start(): Promise<void>;      // Spawn process, wait for health check
  async stop(): Promise<void>;       // SIGTERM -> wait -> SIGKILL
  async restart(): Promise<void>;    // stop() then start()
  getStatus(): ServerStatus;
  getPort(): number;
}
```

### 4.5 WebView Panel (`views/webview-panel.ts`)

Strategy: Embed the existing Web UI (after dark theme migration) as a VS Code WebView.

```typescript
export class CrewWebviewPanel {
  private panel: vscode.WebviewPanel;

  constructor(extensionUri: vscode.Uri, port: number) {
    this.panel = vscode.window.createWebviewPanel(
      "claude-crew.chat",
      "Claude Crew",
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,  // Keep state when panel is hidden
        localResourceRoots: [
          vscode.Uri.joinPath(extensionUri, "media"),
        ],
      }
    );
  }

  // Load the Web UI HTML with:
  // - Correct CSP headers for WebView
  // - Injected server URL (http://127.0.0.1:{port})
  // - VS Code WebView API script for bidirectional messaging
  // - Nonce-based script loading for security
  private getHtmlContent(): string;
}
```

**Critical: Content Security Policy**

```html
<meta http-equiv="Content-Security-Policy" content="
  default-src 'none';
  style-src ${webview.cspSource} 'unsafe-inline';
  script-src 'nonce-${nonce}';
  font-src ${webview.cspSource};
  img-src ${webview.cspSource} https: data:;
  connect-src http://127.0.0.1:* ws://127.0.0.1:*;
">
```

**WebView <-> Extension Messaging**:

```typescript
// WebView -> Extension:
//   vscode.postMessage({ command: "openTerminal", agent: "coder" })
//   vscode.postMessage({ command: "approveAction", agentName: "coder", key: "1" })

// Extension -> WebView:
//   panel.webview.postMessage({ type: "serverReady", port: 3140 })
//   panel.webview.postMessage({ type: "themeChanged", theme: "dark" })
```

### 4.6 Agent Tree View (`views/agent-tree.ts`)

```
AGENTS
├── architect          online  [67%]    ← circular progress icon
│   Provider: claude
│   Role: System designer
│   State: busy
│
├── coder              online  [23%]
│   Provider: claude
│   Role: Backend developer
│   State: idle
│
└── researcher         offline
    Provider: claude
    Role: Research specialist
```

Inline actions:
- Wake (when offline) -> `POST /api/wake`
- Stop (when online) -> kill tmux session or VS Code terminal
- Open Terminal (when online) -> create/focus terminal
- Right-click: Configure, Remove, Send Message

Data source: Poll `GET /api/status` + subscribe to WebSocket `agent:status`, `agent:tmux_state`, `agent:context` events.

### 4.7 Status Bar (`features/status-bar.ts`)

```
$(hubot) Claude Crew: 3/5 agents | $(bell-dot) 2 mentions | $(warning) 1 approval | $(milestone) 1 peak
```

- Click "agents" -> focus agent tree view
- Click "mentions" -> open chat panel, scroll to unread
- Click "approval" -> open chat panel, show approval card
- Click "peak" -> open chat panel, show peak card

### 4.8 Notifications (`features/notifications.ts`)

Listen to WebSocket events and surface as VS Code notifications:

| Event | Notification Type | Action Buttons |
|-------|------------------|----------------|
| `message:new` with @mention for human | Information | "Open Chat", "Dismiss" |
| `approval:pending` | Warning | "Approve", "Deny", "View Details" |
| `peak:pending` | Error (high priority) | "Decide Now", "Extend Time" |
| Agent crash/offline unexpectedly | Error | "Restart Agent", "View Logs" |
| Server crash | Error | "Restart Server", "View Logs" |

### 4.9 Commands (`features/commands.ts`)

All commands interact with the server via REST API:

| Command | API Call | Notes |
|---------|----------|-------|
| `startServer` | (spawn process) | Via ServerManager |
| `stopServer` | (kill process) | Via ServerManager |
| `openChat` | (open WebView) | Via CrewWebviewPanel |
| `addAgent` | `POST /api/agents/create` | Show input boxes for name, role, provider |
| `removeAgent` | `DELETE /api/agents/{name}` | Confirm dialog first |
| `wakeAgent` | `POST /api/wake` | Body: { name } |
| `wakeAll` | `POST /api/wake-all` | |
| `killAgent` | (kill session) | Via terminal provider |
| `killAll` | (kill all sessions) | Via terminal provider |
| `attachTerminal` | (create/focus terminal) | Via terminal provider |
| `configureAgent` | `PUT /api/agents/{name}` | Show QuickPick for model, effort, etc. |
| `createProject` | `POST /api/projects` | Multi-step input wizard |

---

## 5. Phase 3: Web UI Dark Theme Migration

> Redesign the Web UI to match VS Code's dark theme while preserving all functionality.

### 5.1 Design Principles

- Match VS Code's default dark theme color palette
- Use CSS custom properties for all colors (enabling future light theme support)
- Preserve all interactive components (approval cards, peak cards, terminal panel, mention dropdown)
- Fonts: Use VS Code's default font stack instead of EB Garamond/VT323

### 5.2 Color System

```css
:root {
  /* Background hierarchy (VS Code Dark+ reference) */
  --bg-primary: #1e1e1e;           /* editor background */
  --bg-secondary: #252526;         /* sidebar background */
  --bg-tertiary: #2d2d2d;          /* input/card background */
  --bg-hover: #2a2d2e;             /* list hover */
  --bg-active: #37373d;            /* list active selection */
  --bg-highlight: #264f78;         /* active selection highlight */

  /* Text hierarchy */
  --text-primary: #cccccc;         /* main text */
  --text-secondary: #969696;       /* secondary/muted text */
  --text-disabled: #5a5a5a;        /* disabled text */
  --text-link: #3794ff;            /* links */
  --text-heading: #e0e0e0;         /* headings */

  /* Accent colors */
  --accent: #0078d4;               /* primary accent (buttons, highlights) */
  --accent-hover: #1c8ae8;         /* accent hover */
  --accent-fg: #ffffff;            /* text on accent background */

  /* Status colors */
  --green: #89d185;                /* online, success */
  --yellow: #cca700;               /* warning, busy */
  --red: #f48771;                  /* error, critical */
  --blue: #75beff;                 /* info */

  /* Borders */
  --border: #3c3c3c;              /* standard border */
  --border-active: #007fd4;       /* focused element border */

  /* Terminal */
  --terminal-bg: #1e1e1e;         /* same as editor */
  --terminal-fg: #cccccc;

  /* Message bubbles */
  --msg-human: #2b2d30;           /* human message bg */
  --msg-agent: #1e1e1e;           /* agent message bg */

  /* Cards (approval, peak) */
  --card-bg: #252526;
  --card-border: #3c3c3c;
  --card-header: #2d2d2d;

  /* Fonts */
  --font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  --font-mono: "Cascadia Code", "Fira Code", "JetBrains Mono", "SF Mono", Menlo, Monaco, Consolas, monospace;
  --font-size: 13px;
  --font-size-small: 11px;
  --font-size-large: 16px;
}
```

### 5.3 Component-by-Component Migration

| Component | Current Style | Target Style |
|-----------|--------------|--------------|
| Sidebar | bg: #E0DCCF, serif font | bg: --bg-secondary, sans-serif |
| Chat messages | bg: #f4f1e6, serif font | bg: --bg-primary, system font |
| Message bubbles | Light background | Subtle dark card background |
| Agent avatars | Colored circles + serif initials | Colored circles + sans-serif |
| Context progress ring | Same | Keep, adjust colors for dark bg |
| Terminal panel | bg: #0a0a14 | bg: --terminal-bg (already dark) |
| Approval cards | Light card with border | Dark card with subtle border |
| Peak cards | Light card, countdown | Dark card, keep countdown design |
| Input area | Light textarea | Dark textarea with --bg-tertiary |
| Scrollbars | Default | Thin dark scrollbars (VS Code style) |
| Quick Jump (Cmd+K) | Light overlay | Dark overlay with --bg-tertiary |
| Dashboard | Light cards | Dark cards with borders |

### 5.4 WebView Theme Integration

Detect VS Code's current theme and adapt:

```typescript
// In webview-panel.ts, inject theme class:
const theme = vscode.window.activeColorTheme.kind;
// ColorThemeKind.Dark -> "vscode-dark"
// ColorThemeKind.Light -> "vscode-light"
// ColorThemeKind.HighContrast -> "vscode-high-contrast"

// Listen for theme changes:
vscode.window.onDidChangeActiveColorTheme((theme) => {
  panel.webview.postMessage({ type: "themeChanged", kind: theme.kind });
});
```

Initial implementation: Dark theme only. Light theme support can be added later via CSS variables.

### 5.5 Files to Modify

| File | Changes |
|------|---------|
| `packages/web-ui/styles.css` | Complete rewrite of color variables, adapt all selectors |
| `packages/web-ui/index.html` | Update font imports, add theme class support |
| `packages/web-ui/src/main.ts` | Add theme message handler, remove hardcoded colors |
| `packages/web-ui/src/chat.ts` | Update ANSI color mapping for dark background |
| `packages/web-ui/src/utils.ts` | Update `contextBorderGradient()` colors for dark bg |
| `packages/web-ui/src/dashboard.ts` | Update inline styles to use CSS variables |
| `packages/web-ui/src/quick-jump.ts` | Update inline styles |

---

## 6. Phase 4: Terminal Management Abstraction

> Support both tmux and VS Code Terminal API, auto-detect best option.

### 6.1 Terminal Provider Interface

```typescript
// packages/server/src/terminal/provider.ts

export interface TerminalProvider {
  readonly name: string;  // "tmux" | "vscode"

  // Lifecycle
  createSession(agentName: string, command: string, cwd: string): Promise<void>;
  destroySession(agentName: string): Promise<void>;
  sessionExists(agentName: string): Promise<boolean>;
  listSessions(): Promise<string[]>;

  // I/O
  captureOutput(agentName: string, lines: number): Promise<string>;
  sendInput(agentName: string, text: string): Promise<void>;
  sendKeys(agentName: string, keys: string): Promise<void>;

  // State
  getSessionState(agentName: string): Promise<TerminalSessionState>;
}

export interface TerminalSessionState {
  exists: boolean;
  rawContent: string;
  state: "idle" | "busy" | "approval_pending" | "no_session";
  contextPercent: number | null;
  approval: TerminalApproval | null;
}
```

### 6.2 Tmux Provider (`terminal/tmux-provider.ts`)

Extracted from current `tmux-monitor.ts`. Wraps all tmux commands:

```typescript
export class TmuxTerminalProvider implements TerminalProvider {
  readonly name = "tmux";

  // createSession: tmux new-session -d -s "crew-{name}" "command"
  // destroySession: tmux kill-session -t "crew-{name}"
  // captureOutput: tmux capture-pane -t "crew-{name}" -p -S -{lines}
  // sendInput: tmux send-keys -t "crew-{name}" "text" Enter
  // sendKeys: tmux send-keys -t "crew-{name}" "keys"

  // isAvailable(): check if tmux binary exists
  static async isAvailable(): Promise<boolean>;
}
```

### 6.3 VS Code Terminal Provider (`terminal/vscode-provider.ts`)

Runs agent CLI inside VS Code terminals, captures output via a wrapper script:

```typescript
export class VSCodeTerminalProvider implements TerminalProvider {
  readonly name = "vscode";

  // createSession:
  //   1. Create output log file at {dataDir}/agent_terminals/{name}.log
  //   2. Create VS Code terminal with:
  //      - name: "Crew: {agentName}"
  //      - shellPath: the wrapper script
  //      - shellArgs: [agentName, logFile, claudePath]
  //      - cwd: agentWorkspace
  //      - iconPath: agent icon
  //   3. Terminal wrapper tees all output to the log file

  // captureOutput:
  //   Read last N lines from {dataDir}/agent_terminals/{name}.log
  //   (Same data as tmux capture-pane, just from a file)

  // sendInput:
  //   terminal.sendText(text)

  // sendKeys:
  //   terminal.sendText(keys, false)  // false = don't add newline
}
```

**Agent Wrapper Script** (`scripts/agent-wrapper.sh` / `agent-wrapper.ps1`):

macOS/Linux:
```bash
#!/bin/bash
AGENT_NAME="$1"
LOG_FILE="$2"
CLAUDE_PATH="$3"
AGENT_DIR="$4"

cd "$AGENT_DIR"
unset CLAUDECODE
# 'script' captures PTY output including ANSI codes
if [[ "$OSTYPE" == "darwin"* ]]; then
  script -q "$LOG_FILE" "$CLAUDE_PATH"
else
  script -qf "$LOG_FILE" -c "$CLAUDE_PATH"
fi
```

Windows (PowerShell):
```powershell
param($AgentName, $LogFile, $ClaudePath, $AgentDir)
Set-Location $AgentDir
$env:CLAUDECODE = $null
# Start-Transcript captures output
Start-Transcript -Path $LogFile -Force
& $ClaudePath
Stop-Transcript
```

### 6.4 Terminal Monitor Refactoring

Current `tmux-monitor.ts` (450+ lines) splits into:

```
packages/server/src/terminal/
├── provider.ts           # Interface definition
├── tmux-provider.ts      # tmux implementation
├── vscode-provider.ts    # VS Code terminal implementation
├── monitor.ts            # State detection, approval parsing (provider-agnostic)
└── auto-detect.ts        # Provider selection logic
```

`monitor.ts` reuses ALL existing parsing logic:
- State detection (idle/busy/approval_pending) from terminal content
- Context percentage extraction
- Approval prompt parsing (tool_use, file_edit, bash, mcp_setup, etc.)
- Auto-cycle trigger logic

The only difference: `captureOutput()` comes from the provider interface, not directly from tmux.

### 6.5 Auto-Detection Logic

```typescript
// terminal/auto-detect.ts

export async function selectTerminalProvider(
  configPreference: "auto" | "tmux" | "vscode",
  isVSCodeExtension: boolean
): Promise<TerminalProvider> {
  if (configPreference === "tmux") {
    if (await TmuxTerminalProvider.isAvailable()) {
      return new TmuxTerminalProvider();
    }
    throw new Error("tmux not found. Install tmux or set terminal.provider to 'auto'.");
  }

  if (configPreference === "vscode") {
    if (!isVSCodeExtension) {
      throw new Error("VS Code terminal provider only available when running as VS Code extension.");
    }
    return new VSCodeTerminalProvider();
  }

  // Auto mode:
  // 1. If running in VS Code, prefer VS Code terminals
  // 2. If tmux available, use tmux
  // 3. Error: no terminal provider available
  if (isVSCodeExtension) {
    return new VSCodeTerminalProvider();
  }
  if (await TmuxTerminalProvider.isAvailable()) {
    return new TmuxTerminalProvider();
  }
  throw new Error("No terminal provider available. Install tmux or run inside VS Code.");
}
```

### 6.6 Windows Support Considerations

| Feature | macOS/Linux | Windows |
|---------|-------------|---------|
| tmux | Native | Not available (no tmux on Windows) |
| VS Code Terminal | Via wrapper + `script` | Via wrapper + PowerShell `Start-Transcript` |
| Agent CLI | `claude` binary | `claude.cmd` or `claude.exe` |
| Path separator | `/` | `\` (use `path.join` everywhere) |
| Process signals | SIGTERM, SIGKILL | `process.kill(pid)` (no SIGKILL, use `taskkill`) |
| PID file | Standard | Standard |

On Windows, the only supported terminal provider is `vscode`. This is acceptable because:
- Windows users typically don't have tmux
- VS Code Terminal API works perfectly on Windows
- The wrapper script has a PowerShell variant

---

## 7. Phase 5: Full Feature Integration

> Ensure every feature from the current system works in VS Code extension.

### 7.1 Feature Checklist

Every feature below MUST work identically:

#### 7.1.1 Group Chat
- [x] Send messages to channels (general, custom)
- [x] @mention agents (dropdown autocomplete)
- [x] Message grouping (5-minute window, same sender)
- [x] ANSI color rendering in messages
- [x] Delivery status indicators (sent -> delivered -> read)
- [x] Unread count badges per channel
- [x] Message hover toolbar (copy)
- [x] Shift+Enter for newline, Enter to send

#### 7.1.2 Channels
- [x] Public channels
- [x] DM channels (1:1 with agent)
- [x] Group channels (subset of agents)
- [x] Channel CRUD (create, rename, archive, delete)
- [x] Member management (add/remove from group channels)
- [x] Channel switching (sidebar + Alt+Up/Down)

#### 7.1.3 DM Terminal Panel
- [x] Live terminal output in DM channels
- [x] ANSI color rendering
- [x] Quick action buttons (Enter, Esc, y, n, 1, 2, 3)
- [x] Terminal content auto-scroll

#### 7.1.4 Agent Management
- [x] Add agent (name, role, provider)
- [x] Remove agent (confirm, cleanup workspace)
- [x] Wake agent (start terminal session)
- [x] Kill agent (stop terminal session)
- [x] Agent status display (online/offline/busy/warning)
- [x] Context usage progress ring
- [x] Configure agent (model, effort, approval policy, sandbox mode)
- [x] Agent list with real-time status updates

#### 7.1.5 Tool Approval System
- [x] Approval cards in chat (tool_use, file_edit, file_create, bash, plan_execute, session_feedback, mcp_setup)
- [x] Multiple response options per approval type
- [x] Approval parameter display (server, tool name, arguments)
- [x] Resolved state display after response
- [x] MCP setup special handling (arrow key navigation)

#### 7.1.6 PEAK Decision System
- [x] Peak cards with countdown timer (MM:SS format)
- [x] 4 peak types (irreversibility, multiple_viable_paths, information_asymmetry, drift_risk)
- [x] Multiple options display with pros/cons
- [x] Agent lean indicator
- [x] Actions: Decide, Let Agent Decide, Extend Time (+10 min)
- [x] Peak timeout auto-decision (default option after timeout)
- [x] Decided state display

#### 7.1.7 Project Management Dashboard
- [x] Project list view (grouped by status: active/paused/archived)
- [x] Create project (name, description, tech stack)
- [x] Project detail view (agents, memories, tech stack)
- [x] Assign/unassign agents to projects
- [x] Project status transitions (active <-> paused -> archived)
- [x] Delete project (confirm dialog)
- [x] Project-scoped channels

#### 7.1.8 Shared Files
- [x] File list in sidebar
- [x] Create new file
- [x] Edit file content
- [x] Delete file
- [x] File metadata (creator, size, last updated)

#### 7.1.9 Memory System
- [x] Semantic memory search (via embedding)
- [x] Keyword fallback search (when embedding unavailable)
- [x] Memory CRUD via MCP tools
- [x] Decay-weighted retrieval (ACT-R model)
- [x] Memory promotion/archival logic
- [x] Memory statistics

#### 7.1.10 SOP/Standards Management
- [x] Standards list display
- [x] Add standard (category, name, content)
- [x] Auto-evolution from agent reflections
- [x] Budget tracking (chars used / total)
- [x] Contradiction detection

#### 7.1.11 Session Management
- [x] Auto-cycle on context threshold
- [x] Worklog save/load across cycles
- [x] Manual restart/interrupt/resume agent
- [x] Session reset

#### 7.1.12 Quick Navigation
- [x] Cmd+K / Ctrl+K quick jump panel
- [x] Search channels and agents
- [x] Keyboard navigation (arrow keys + Enter)

### 7.2 VS Code-Enhanced Features

These features leverage VS Code capabilities beyond what the Web UI provides:

| Feature | Implementation |
|---------|---------------|
| Agent terminal in VS Code terminal panel | Open agent's terminal as a VS Code terminal tab |
| Shared file editing in VS Code editor | Open shared file in a virtual document (TextDocumentContentProvider) |
| Peak notification badge | Badge on activity bar icon |
| Approval quick-approve | Notification button directly approves without opening panel |
| Agent workspace folders | Add agent workspaces to multi-root workspace |
| PEAK decisions in notification center | System-level notification with action buttons |

### 7.3 Web UI Modifications for VS Code WebView

The existing Web UI needs these changes to work inside WebView:

| Change | Reason |
|--------|--------|
| Replace `window.location` port detection with injected config | WebView URL is `vscode-webview://...`, not `http://localhost` |
| Add `acquireVsCodeApi()` for extension messaging | WebView <-> Extension communication |
| Handle CSP restrictions (no inline scripts except nonce'd) | VS Code WebView security |
| Remove server-relative font imports, bundle fonts | WebView can't access `http://localhost` for fonts |
| Add WebView state persistence (`getState`/`setState`) | Survive panel hide/show without data loss |
| Handle theme-changed messages from extension | Dark/light theme switching |

---

## 8. Phase 6: Multi-Model Support

> Currently supports Claude and Codex. Make the provider system extensible.

### 8.1 Provider Architecture

```typescript
// packages/server/src/providers/base.ts

export interface AgentProviderPlugin {
  readonly name: string;         // "claude" | "codex" | "gemini" | ...
  readonly displayName: string;

  // Binary detection
  findBinary(): Promise<string | null>;
  isAvailable(): Promise<boolean>;

  // Session lifecycle
  startSession(agent: AgentConfig, workspace: string): Promise<void>;
  stopSession(agentName: string): Promise<void>;

  // Configuration
  getConfigSchema(): ProviderConfigSchema;      // What settings this provider supports
  buildLaunchCommand(agent: AgentConfig): string; // CLI command to start agent

  // Workspace setup
  setupWorkspace(agentDir: string, agentName: string, role: string): Promise<void>;
  // Generates: .mcp.json, CLAUDE.md (or equivalent), provider-specific config
}
```

### 8.2 Provider Registry

```typescript
// packages/server/src/providers/registry.ts

const providers = new Map<string, AgentProviderPlugin>();

export function registerProvider(provider: AgentProviderPlugin): void;
export function getProvider(name: string): AgentProviderPlugin;
export function listProviders(): AgentProviderPlugin[];
```

### 8.3 Provider Implementations

| Provider | CLI Binary | MCP Support | Config File | Status |
|----------|-----------|-------------|-------------|--------|
| Claude | `claude` | Native (.mcp.json) | CLAUDE.md | Existing, refactor |
| Codex | `codex` | Via config.toml | config.toml | Existing, refactor |
| (Future) | Extensible | Extensible | Extensible | Plugin interface ready |

### 8.4 Changes to Agent API

```typescript
// POST /api/agents/create
{
  "name": "my-agent",
  "role": "Backend developer",
  "provider": "claude",           // Must be a registered provider
  "config": {                     // Provider-specific config
    "model": "opus",
    "effort": "high"
  }
}
```

### 8.5 VS Code Settings for Providers

```jsonc
{
  "claude-crew.providers.claude.models": ["sonnet", "opus", "haiku"],
  "claude-crew.providers.codex.models": ["gpt-5.4", "o3"],
  "claude-crew.providers.codex.defaultModel": "gpt-5.4"
}
```

---

## 9. Phase 7: Packaging & Marketplace

### 9.1 Build Pipeline

```
Source
  |
  v
[1] Build server bundle (esbuild, platform-neutral JS)
  |
  v
[2] Build MCP bridge bundle (esbuild)
  |
  v
[3] Build Web UI bundle + dark theme CSS
  |
  v
[4] Build extension code (esbuild)
  |
  v
[5] Copy assets:
    - dist/server.bundle.js
    - dist/mcp-bridge.bundle.js
    - media/web-ui/ (HTML + JS + CSS)
    - media/icons/
    - scripts/agent-wrapper.sh
    - scripts/agent-wrapper.ps1
  |
  v
[6] Package with vsce:
    - vsce package --target darwin-arm64
    - vsce package --target darwin-x64
    - vsce package --target linux-x64
    - vsce package --target linux-arm64
    - vsce package --target win32-x64
  |
  v
[7] Each .vsix includes platform-specific better-sqlite3 binary
```

### 9.2 Extension Size Optimization

Target: < 15MB per platform VSIX

| Component | Estimated Size |
|-----------|---------------|
| Extension JS bundle | ~200KB |
| Server JS bundle | ~500KB |
| MCP Bridge JS bundle | ~100KB |
| Web UI (HTML + JS + CSS) | ~300KB |
| better-sqlite3 native binary | ~5MB |
| Icons + assets | ~100KB |
| Scripts (wrapper, etc.) | ~10KB |
| **Total** | **~6.2MB** |

### 9.3 Platform-Specific Packaging

```bash
# Build script (scripts/build-vsix.sh)

# 1. Install platform-specific better-sqlite3
npm rebuild better-sqlite3 --target_platform=darwin --target_arch=arm64

# 2. Package
npx vsce package --target darwin-arm64 -o claude-crew-darwin-arm64.vsix
npx vsce package --target darwin-x64 -o claude-crew-darwin-x64.vsix
npx vsce package --target linux-x64 -o claude-crew-linux-x64.vsix
npx vsce package --target linux-arm64 -o claude-crew-linux-arm64.vsix
npx vsce package --target win32-x64 -o claude-crew-win32-x64.vsix
```

### 9.4 Marketplace Metadata

```jsonc
// package.json additions for Marketplace
{
  "repository": {
    "type": "git",
    "url": "https://github.com/your-org/claude-crew"
  },
  "bugs": {
    "url": "https://github.com/your-org/claude-crew/issues"
  },
  "homepage": "https://github.com/your-org/claude-crew#readme",
  "galleryBanner": {
    "color": "#1e1e1e",
    "theme": "dark"
  },
  "badges": [],
  "preview": true,    // Remove when stable
  "pricing": "Free"
}
```

### 9.5 First-Run Experience

When user installs and activates the extension for the first time:

```
1. Extension activates
2. Check Node.js available -> if not, show notification:
   "Claude Crew requires Node.js 18+. [Install Node.js](https://nodejs.org)"
3. Check Claude CLI available -> if not, show notification:
   "Claude Crew works best with Claude Code CLI. [Install](https://claude.ai/code)"
   (Non-blocking: user might use Codex or other providers)
4. Initialize data directory (globalStoragePath):
   - Create subdirectories: agents/, shared/, agent_state/, agent_terminals/
   - Create default config.json
   - Initialize SQLite database with migrations
5. Start server (if autoStart enabled)
6. Show welcome WebView panel with:
   - Quick setup guide
   - "Add Your First Agent" button
   - Links to documentation
7. Show status bar item
```

### 9.6 Update Strategy

- **Auto-update**: VS Code Marketplace handles this automatically
- **Database migration**: `runMigrations()` runs on every server start, handles schema evolution
- **Config migration**: New config fields get default values (backward compatible)
- **Breaking changes**: Major version bump, migration guide in CHANGELOG

---

## 10. Cross-Cutting Concerns

### 10.1 Error Handling

| Layer | Strategy |
|-------|----------|
| Server | Express error middleware, log to Output Channel, return structured JSON errors |
| Extension | try/catch all command handlers, show user-friendly notifications |
| WebView | Catch fetch/WebSocket errors, show inline error banners |
| Terminal | Provider returns error states, monitor handles gracefully |

### 10.2 Logging

```typescript
// Unified logging through VS Code Output Channel
// Channel: "Claude Crew"

// Levels: DEBUG, INFO, WARN, ERROR
// Format: [2026-03-13T10:30:00.000Z] [INFO] [server] Message
// Server logs piped from child process stdout/stderr
```

### 10.3 Testing Strategy

```
packages/vscode-extension/test/
├── unit/
│   ├── server-manager.test.ts     # Process lifecycle, health checks
│   ├── config-sync.test.ts        # VS Code settings -> server config
│   ├── platform.test.ts           # Binary detection, path handling
│   └── agent-tree.test.ts         # Tree view data correctness
├── integration/
│   ├── extension.test.ts          # Activation, command registration
│   ├── webview.test.ts            # WebView creation, messaging
│   └── terminal-provider.test.ts  # Terminal abstraction
└── e2e/
    └── full-flow.test.ts          # Install -> start -> add agent -> chat

packages/server/test/
├── unit/
│   ├── config-loader.test.ts      # Config loading, merging, validation
│   ├── memory-engine.test.ts      # Decay, promotion, archival
│   ├── sop-engine.test.ts         # Auto-apply, contradiction detection
│   ├── terminal-monitor.test.ts   # State parsing, approval detection
│   └── migrations.test.ts         # Database migration correctness
├── integration/
│   ├── api/
│   │   ├── messages.test.ts
│   │   ├── agents.test.ts
│   │   ├── projects.test.ts
│   │   ├── peaks.test.ts
│   │   └── approvals.test.ts
│   └── websocket.test.ts         # Event broadcasting
└── fixtures/
    ├── terminal-output/           # Sample terminal captures for parsing tests
    └── config/                    # Test config files
```

Test framework: `vitest` (fast, TypeScript-native, compatible with current stack)

### 10.4 CI/CD (GitHub Actions)

```yaml
# .github/workflows/ci.yml
# Triggers: push to main, PR

jobs:
  lint-and-test:
    strategy:
      matrix:
        os: [ubuntu-latest, macos-latest, windows-latest]
        node: [18, 20, 22]
    steps:
      - pnpm install
      - pnpm lint
      - pnpm test

  build-vsix:
    strategy:
      matrix:
        target: [darwin-arm64, darwin-x64, linux-x64, linux-arm64, win32-x64]
    steps:
      - Build server bundle
      - Build extension
      - Package VSIX for target
      - Upload artifact

  publish:
    # Only on tagged releases (v*)
    steps:
      - Download all VSIX artifacts
      - vsce publish for each target
```

### 10.5 Documentation

| Document | Contents |
|----------|----------|
| `README.md` | Overview, screenshots, 30-second install, feature highlights |
| `docs/QUICKSTART.md` | Step-by-step first-run guide |
| `docs/CONFIGURATION.md` | All settings explained |
| `docs/AGENTS.md` | How to create, configure, and manage agents |
| `docs/PROVIDERS.md` | Multi-model support, provider-specific setup |
| `docs/ARCHITECTURE.md` | System architecture for contributors |
| `docs/CONTRIBUTING.md` | Development setup, PR guidelines |
| `CHANGELOG.md` | Version history |

---

## 11. File Inventory

### 11.1 New Files to Create

```
packages/vscode-extension/                     # NEW PACKAGE
├── package.json
├── tsconfig.json
├── esbuild.config.ts
├── src/
│   ├── extension.ts
│   ├── server/
│   │   ├── manager.ts
│   │   ├── health.ts
│   │   └── client.ts
│   ├── views/
│   │   ├── webview-panel.ts
│   │   ├── agent-tree.ts
│   │   ├── project-tree.ts
│   │   └── shared-files-tree.ts
│   ├── terminal/
│   │   └── vscode-provider.ts
│   ├── features/
│   │   ├── notifications.ts
│   │   ├── status-bar.ts
│   │   ├── commands.ts
│   │   └── config-sync.ts
│   └── utils/
│       ├── platform.ts
│       └── logger.ts
├── media/
│   ├── web-ui/                     (copied from packages/web-ui build output)
│   └── icons/
├── scripts/
│   ├── agent-wrapper.sh
│   └── agent-wrapper.ps1
└── test/

packages/server/src/
├── config-loader.ts                # NEW
├── config-schema.ts                # NEW
├── utils/
│   └── find-binary.ts              # NEW
├── terminal/
│   ├── provider.ts                 # NEW (interface)
│   ├── tmux-provider.ts            # NEW (extracted from tmux-monitor.ts)
│   ├── vscode-provider.ts          # NEW
│   ├── monitor.ts                  # NEW (extracted from tmux-monitor.ts)
│   └── auto-detect.ts              # NEW
├── db/
│   └── migrations.ts               # NEW
└── providers/
    └── base.ts                     # NEW (provider interface)

scripts/
├── build-vsix.sh                   # NEW
└── agent-wrapper.sh                # NEW
```

### 11.2 Files to Modify

```
packages/server/src/config.ts              # Rewrite: unified config export
packages/server/src/index.ts               # Use config, add programmatic start API
packages/server/src/db/schema.ts           # Extract migrations to migrations.ts
packages/server/src/memory-engine.ts       # Import params from config
packages/server/src/sop-engine.ts          # Import thresholds from config
packages/server/src/embedding.ts           # Import dim/timeouts from config
packages/server/src/tmux-monitor.ts        # Refactor to use terminal provider interface
packages/server/src/agent-runtime.ts       # Align with provider registry
packages/server/src/api/agents.ts          # Use find-binary util, remove duplicated path detection
packages/server/src/api/router.ts          # Add /api/config/ui endpoint
packages/server/src/providers/codex.ts     # Remove hardcoded paths, implement provider interface
packages/server/src/ws/handler.ts          # (minimal: ensure works without tmux)
packages/mcp-bridge/src/client.ts          # Import retry config from config/env
packages/web-ui/index.html                 # Font changes, theme support, CSP
packages/web-ui/styles.css                 # Complete dark theme rewrite
packages/web-ui/src/main.ts               # WebView API integration, config injection
packages/web-ui/src/chat.ts               # ANSI colors for dark bg
packages/web-ui/src/utils.ts              # Theme-aware thresholds
packages/web-ui/src/dashboard.ts           # Dark theme inline styles
packages/web-ui/src/quick-jump.ts          # Dark theme styles
packages/web-ui/src/input.ts              # Dark theme styles
package.json                              # Add vscode-extension to workspaces
pnpm-workspace.yaml                       # Add packages/vscode-extension
```

### 11.3 Files to Delete (After Migration)

```
app/                                       # Swift native app (replaced by VS Code extension)
├── Package.swift
├── Sources/
└── .build/

crew-manage.sh                             # Replaced by extension commands (keep crew.sh for standalone CLI)
```

---

## 12. Risk Assessment

| Risk | Impact | Mitigation |
|------|--------|------------|
| better-sqlite3 native module on multiple platforms | Builds may fail on some platforms | Platform-specific VSIX + CI matrix testing |
| VS Code Terminal API output capture limitations | Cannot read terminal output natively | Use wrapper script + file-based capture |
| Windows + tmux incompatibility | Windows users can't use tmux provider | VS Code terminal provider as default on Windows |
| WebView CSP restrictions break existing UI | Inline scripts/styles may fail | Audit all inline code, migrate to nonce-based |
| Extension activation time (cold start) | Slow startup if server takes long | Show loading indicator, progressive feature activation |
| Ollama not available (common for new users) | Embedding search fails | Graceful fallback to keyword search, clear messaging |
| Claude CLI not installed | Core feature unavailable | Clear first-run guidance, support multiple providers |
| Server port conflict (3140 already in use) | Server fails to start | Auto-detect free port, configurable port |
| Large WebView memory usage | Performance issues with long chat history | Message pagination, virtual scrolling |
| Config migration between versions | User settings may break on update | Zod schema validation with safe defaults for new fields |

---

## Execution Order

```
Phase 0: Configuration Management Overhaul
  |  (prerequisite for everything)
  v
Phase 1: Server Portability
  |  (make server embeddable)
  v
Phase 2: VS Code Extension Core
  |  (basic extension scaffold, server management, WebView shell)
  |
  +---> Phase 3: Dark Theme (can parallel with Phase 2)
  |
  v
Phase 4: Terminal Management Abstraction
  |  (tmux + VS Code terminal, auto-detect)
  v
Phase 5: Full Feature Integration
  |  (verify every feature works)
  v
Phase 6: Multi-Model Support
  |  (provider refactoring)
  v
Phase 7: Packaging & Marketplace
  |  (build pipeline, CI/CD, publish)
  v
DONE: Users install from VS Code Marketplace
```

Phase 3 (Dark Theme) can be developed in parallel with Phase 2 since it only touches `packages/web-ui/` files.
