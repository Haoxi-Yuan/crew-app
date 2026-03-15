# Claude Crew VS Code Extension - Revised Migration Plan

> Status: REVISED
> Created: 2026-03-13
> Updated: 2026-03-15
> Goal: Replace the Swift macOS app with a VS Code extension, preserve current functionality, and prepare for Marketplace distribution

---

## Table of Contents

1. [Overview](#1-overview)
2. [Current State Audit](#2-current-state-audit)
3. [Core Gaps To Close](#3-core-gaps-to-close)
4. [Revised Phases](#4-revised-phases)
5. [Cross-Cutting Concerns](#5-cross-cutting-concerns)
6. [File Inventory](#6-file-inventory)
7. [Risk Assessment](#7-risk-assessment)
8. [Execution Order](#8-execution-order)

---

## 1. Overview

### 1.1 Current Architecture (as of 2026-03-15)

```text
Swift App (macOS only)
    -> WKWebView -> http://127.0.0.1:3140
    -> ServerProcess.swift spawns Node.js server

Node.js Server (Express 5 + SQLite)
    -> REST API + WebSocket
    -> Claude runtime via tmux
    -> Codex runtime via app-server transport
    -> memory-engine, SOP engine, PEAK, project/workplace scopes
    -> MCP bridge (per-agent)

Web UI (HTML/CSS/TypeScript)
    -> group chat, channels, approvals, dashboard, shared files, quick jump

CLI / Bash scripts
    -> crew.sh, crew-manage.sh
    -> still assume local/dev environment and tmux-oriented workflows
```

### 1.2 Target Architecture

```text
VS Code Extension
    -> Activity Bar views: Agents, Projects, Shared Files
    -> WebView panel: Chat, dashboard, approvals, PEAKs
    -> Commands: start/stop server, wake agent, open runtime, configure agent
    -> Notifications: mentions, approvals, peaks
    -> Settings: editor-managed configuration

Bundled Node.js Server (child process)
    -> same REST/WebSocket surface
    -> extension-injected paths and settings
    -> runtime abstraction for Claude and Codex
    -> packaged web assets for WebView

Provider runtimes
    -> Claude: tmux on supported systems
    -> Codex: existing app-server transport
    -> future providers via plugin/registry model
```

### 1.3 What Changed Since The Previous Draft

The original draft is directionally correct, but the repo moved in several important ways:

- Multi-model support is no longer a future phase. Claude and Codex both already exist in the server and UI.
- The Web UI is no longer a primitive pre-theme prototype. It already has a coherent design system and feature-complete surface; the migration problem is now WebView adaptation, not a wholesale redesign.
- The real portability blocker is not the absence of a VS Code package yet. It is still the server's hardcoded configuration, path assumptions, and runtime coupling.
- Terminal abstraction is too narrow as the primary design unit. The codebase already has two runtime styles: tmux for Claude and app-server for Codex. The abstraction should start at "agent runtime provider", not only "terminal provider".
- "Single install and everything works" should be reframed as "single extension install plus first-run dependency checks". Claude CLI, Codex CLI, and tmux cannot all realistically be fully embedded.

### 1.4 Updated Constraints

- **No feature regression**: group chat, channels, approvals, PEAK, memory, projects, shared files, and provider-specific runtime controls must keep working.
- **Cross-platform path**: macOS first, Linux next, Windows/WSL supported through explicit compatibility strategy.
- **Out-of-process server**: the extension should manage a child server process instead of running the server inside the extension host.
- **Provider-aware migration**: Claude and Codex are baseline features, not optional extensions.
- **Marketplace-ready packaging**: package size, native module handling, and first-run diagnostics must be designed early.

---

## 2. Current State Audit

### 2.1 Already Implemented In The Repository

These areas should be treated as existing assets to integrate, not future roadmap items:

- **Provider support**: Claude and Codex both exist end-to-end in the server and UI.
- **Agent creation with provider selection**: `/api/agents/create` already accepts provider and branches startup logic.
- **Runtime state and approvals**: approval handling already exists for both tmux-based Claude and app-server-based Codex.
- **Feature-rich web UI**: channels, DMs, dashboard, approvals, terminal panel, quick jump, shared files, and project management are already present.
- **Project/workplace scope model**: storage routing and workspace context synchronization already exist.
- **Memory / SOP / PEAK systems**: these are now core product features and must be preserved during migration.

### 2.2 Still Missing For VS Code Migration

- No `packages/vscode-extension/` package exists yet.
- No extension manifest, activation code, tree views, or command registrations exist yet.
- No server bundling pipeline exists yet.
- No programmatic server startup API exists yet.
- No WebView-safe asset loading or VS Code theme bridge exists yet.
- No true configuration layering exists yet.
- No versioned database migration framework exists yet.

### 2.3 Current Technical Debt That Directly Blocks Migration

#### Configuration And Pathing

- `packages/server/src/config.ts` is still flat constants, not a layered config model.
- `packages/server/src/index.ts` still binds to `127.0.0.1` and uses fixed intervals.
- UI context thresholds are still hardcoded client-side.

#### Hardcoded Runtime Assumptions

- `packages/server/src/providers/codex.ts` still contains hardcoded `/Users/yuan/.nvm/...` fallback paths.
- Binary lookup logic is duplicated across server and shell scripts.
- Data directories are still derived from project root, not injected host storage paths.

#### Schema Evolution

- `packages/server/src/db/schema.ts` still uses ad-hoc `ALTER TABLE` checks rather than versioned migrations.

#### Runtime Coupling

- Claude runtime management is tmux-centric.
- Codex runtime management is provider-specific and separate.
- The migration needs a common runtime/provider layer before a clean extension integration is possible.

---

## 3. Core Gaps To Close

### 3.1 Gap A: Portable Configuration

We need a layered config system that can be driven by:

1. built-in defaults
2. environment variables
3. config files
4. VS Code settings / runtime overrides

This is still the main prerequisite for bundling and extension hosting.

### 3.2 Gap B: Runtime Provider Abstraction

The primary abstraction should be:

- provider runtime lifecycle
- provider availability detection
- provider launch command construction
- provider state / approval / terminal inspection hooks

Terminal attachment is only one capability of a runtime, not the architectural center.

### 3.3 Gap C: WebView Adaptation

The existing web UI should be reused, but must be made compatible with:

- `webview.asWebviewUri(...)`
- message passing instead of direct host assumptions
- persisted panel state
- VS Code theme changes
- CSP-safe asset loading

### 3.4 Gap D: Extension Packaging

The extension must package:

- the server build
- the web UI build
- the correct native dependency strategy for `better-sqlite3`
- first-run diagnostics for external tool dependencies

---

## 4. Revised Phases

## Phase 0: Configuration, Pathing, And Migration Infrastructure

> This remains the true prerequisite phase.

### 4.0.1 Goals

- eliminate hardcoded machine-specific paths
- make data paths injectable
- centralize config loading and validation
- replace ad-hoc schema evolution with versioned migrations

### 4.0.2 Deliverables

#### A. Layered Config Loader

Introduce:

- `packages/server/src/config/defaults.ts`
- `packages/server/src/config/schema.ts`
- `packages/server/src/config/load.ts`

Target shape:

```ts
export interface CrewConfig {
  server: {
    port: number;
    host: string;
    dataDir: string;
    webUiDir: string;
    logLevel: "debug" | "info" | "warn" | "error";
  };
  agent: {
    defaultProvider: "claude" | "codex";
    heartbeatTimeoutMs: number;
    heartbeatCheckIntervalMs: number;
    contextWarningPercent: number;
    contextCriticalPercent: number;
    autoCycleContextPercent: number;
    autoCycleCooldownMs: number;
  };
  terminal: {
    captureLines: number;
    monitorIntervalMs: number;
  };
  embedding: {
    provider: "ollama" | "none";
    baseUrl: string;
    model: string;
    dim: number;
    requestTimeoutMs: number;
    availabilityTimeoutMs: number;
  };
  standards: {
    maxBudgetChars: number;
    autoApplyConfidenceThreshold: number;
    consensusMinAgents: number;
  };
  peak: {
    checkIntervalMs: number;
    defaultTimeoutSeconds: number;
    minTimeoutSeconds: number;
    maxTimeoutSeconds: number;
  };
  bridge: {
    serverUrl: string;
    maxRetries: number;
    retryDelays: number[];
  };
}
```

#### B. Shared Binary Finder

Create a shared utility used by:

- server runtime startup
- provider implementations
- shell scripts where practical

Targets:

- `node`
- `claude`
- `codex`
- `tmux`
- `ollama`

The utility must check PATH first, then environment-specific roots such as `NVM_DIR`, `FNM_DIR`, and platform-specific install locations. It must not contain user-home hardcoded fallbacks.

#### C. Versioned Database Migrations

Introduce:

- `packages/server/src/db/migrations.ts`
- `_migrations` table

Move existing schema evolution logic out of one-off column checks and into ordered migrations.

### 4.0.3 Files To Modify

| File | Changes |
|------|---------|
| `packages/server/src/config.ts` | Replace with compatibility exports or thin facade over new config loader |
| `packages/server/src/index.ts` | Accept resolved config instead of importing fixed constants |
| `packages/server/src/db/schema.ts` | Reduce to base schema helpers or fold into migration system |
| `packages/server/src/db/index.ts` | Run migrations at startup |
| `packages/server/src/providers/codex.ts` | Remove hardcoded Node/Codex path fallbacks |
| `packages/server/src/api/agents.ts` | Use shared binary finder and resolved config |
| `packages/server/src/tmux-monitor.ts` | Read timing and thresholds from config |
| `packages/server/src/memory-engine.ts` | Move constants behind config |
| `packages/server/src/sop-engine.ts` | Move thresholds behind config |
| `packages/web-ui/src/utils.ts` | Stop hardcoding context thresholds |

---

## Phase 1: Server Productization For Extension Hosting

> Make the server runnable as an extension-managed child process.

### 4.1.1 Goals

- produce a distributable server build
- support extension-injected path overrides
- support health checks and clean shutdown

### 4.1.2 Deliverables

#### A. Programmatic Startup Entry Point

Add:

- `packages/server/src/start.ts`

```ts
export interface ServerOptions {
  configOverrides?: Partial<CrewConfig>;
  signal?: AbortSignal;
  onReady?: (info: { port: number }) => void;
  onError?: (error: Error) => void;
}

export async function startServer(options: ServerOptions): Promise<{ close(): Promise<void> }>;
```

The CLI entry point can become a thin wrapper around this.

#### B. Bundling Strategy

Bundle the server into one JS artifact while handling `better-sqlite3` as a native dependency.

Preferred path:

- keep `better-sqlite3`
- ship platform-targeted VSIX builds
- keep server out-of-process

#### C. Host-Aware Paths

When hosted by the extension:

- `dataDir` must resolve to `context.globalStorageUri.fsPath`
- `webUiDir` must resolve to bundled extension media assets
- logs should route to extension output channels or child process log files

### 4.1.3 Non-Goals

- rewriting the server to run in-browser
- replacing SQLite
- merging the server into the extension host process

---

## Phase 2: Runtime Provider Abstraction

> Replace implicit runtime branching with an explicit provider-runtime layer.

### 4.2.1 Why This Phase Moved Earlier

The original plan centered on terminal abstraction, but the codebase already has two runtime models:

- Claude -> tmux-managed terminal session
- Codex -> app-server transport session

The extension must integrate both. Therefore the right abstraction boundary is provider runtime, not terminal API alone.

### 4.2.2 Target Interfaces

```ts
export interface RuntimeProvider {
  readonly name: "claude" | "codex";

  isAvailable(): Promise<boolean>;
  createWorkspace(agent: AgentSeed): Promise<void>;
  start(agentName: string): Promise<void>;
  stop(agentName: string): Promise<void>;
  restart(agentName: string): Promise<void>;
  getState(agentName: string): RuntimeState;
  getContextPercent(agentName: string): number;
  getTerminalContent(agentName: string): string;
  sendInput(agentName: string, input: string, options?: { enter?: boolean }): Promise<void>;
  getPendingApproval(agentName: string): RuntimeApproval | undefined;
}
```

### 4.2.3 Concrete Refactors

- Move Claude tmux-specific logic behind `providers/claude.ts`
- Keep Codex provider as a first-class runtime provider
- Make approval/state APIs provider-neutral
- Keep tmux attachment as a Claude capability instead of a universal assumption

### 4.2.4 Output Of This Phase

After this phase, the server should expose a stable API that the VS Code extension can use without caring whether an agent is Claude or Codex.

---

## Phase 3: VS Code Extension Core

> Create the extension package and wire it to the existing server surface.

### 4.3.1 New Package

Create:

```text
packages/vscode-extension/
├── package.json
├── tsconfig.json
├── esbuild.config.ts
├── src/
│   ├── extension.ts
│   ├── server/
│   │   ├── manager.ts
│   │   ├── client.ts
│   │   └── health.ts
│   ├── views/
│   │   ├── webview-panel.ts
│   │   ├── agent-tree.ts
│   │   ├── project-tree.ts
│   │   └── shared-files-tree.ts
│   ├── features/
│   │   ├── commands.ts
│   │   ├── notifications.ts
│   │   ├── status-bar.ts
│   │   └── config-sync.ts
│   └── utils/
│       ├── logger.ts
│       └── platform.ts
└── media/
    └── web-ui/
```

### 4.3.2 Core Responsibilities

- start/stop/restart the bundled server child process
- render tree views for agents/projects/files
- open the main WebView panel
- bridge extension settings into server config overrides
- surface notifications and output logs

### 4.3.3 Initial Commands

- `claude-crew.openPanel`
- `claude-crew.startServer`
- `claude-crew.stopServer`
- `claude-crew.restartServer`
- `claude-crew.refreshAgents`
- `claude-crew.refreshProjects`
- `claude-crew.wakeAgent`
- `claude-crew.stopAgent`
- `claude-crew.openRuntime`
- `claude-crew.configureAgent`

---

## Phase 4: Web UI To WebView Adaptation

> Reuse the existing UI, adapt it to the VS Code WebView environment.

### 4.4.1 This Replaces The Old "Dark Theme Migration" Phase

The problem is no longer "make the UI dark". The current UI already has a defined visual language and broad feature coverage. What is needed now is host adaptation.

### 4.4.2 Required Work

#### A. Asset Loading

- rewrite HTML asset references for WebView-safe URIs
- ensure bundled JS/CSS live under extension `media/`
- remove any assumptions about direct localhost-served static assets for the extension-hosted UI

#### B. Theme Integration

- map VS Code theme kinds to CSS classes
- listen for theme changes from extension host
- allow both current custom theme and host-aware overrides

#### C. State Persistence

- use `acquireVsCodeApi().getState()` / `setState()`
- preserve selected channel, project, scroll position, filter state, and panel mode

#### D. Messaging

- establish message bridge for host-originated events that should not flow through server WebSocket alone
- keep server WebSocket as the primary real-time data channel where practical

### 4.4.3 Important Decision

Do not rewrite the UI into native VS Code views unless there is a clear functional reason. The existing single-page UI is already the richest surface in the product.

---

## Phase 5: Feature Integration In VS Code

> Wire existing product features into extension affordances.

### 4.5.1 Must-Have Integrations

- Agent tree with status and provider badges
- Project tree with quick open actions
- Shared files tree
- status bar items for server health / pending approvals / unread mentions
- notifications for mentions, approvals, and peaks
- commands for wake/stop/restart/configure
- runtime open/attach behavior

### 4.5.2 Runtime Open Strategy

- Claude agents: expose tmux attach/open options on supported systems
- Codex agents: open terminal/log/output view plus existing runtime content feed
- where no interactive terminal attach is possible, provide read-only runtime stream and command actions

### 4.5.3 Feature Parity Checklist

The extension launch candidate must preserve:

- group chat and mentions
- channels and DMs
- provider-aware message forwarding
- approval cards and approval responses
- PEAK escalation flow
- project dashboard
- shared files CRUD
- memory search and write flows
- reflections and standards workflows
- runtime state visibility

---

## Phase 6: Provider Extensibility

> This is no longer "multi-model support". It is the follow-on cleanup that turns current Claude/Codex support into a real plugin surface.

### 4.6.1 Scope

- provider registry
- provider capability descriptors
- provider-specific configuration schemas
- future providers beyond Claude and Codex

### 4.6.2 Why This Is Deferred

The repository already supports two providers. The migration blocker is integration quality, not the lack of provider count.

---

## Phase 7: Packaging, Marketplace, And First-Run Experience

### 4.7.1 Packaging Strategy

- build and bundle server artifact
- build and bundle web UI artifact
- build extension artifact
- package per-platform VSIX where native dependency constraints require it

### 4.7.2 First-Run Experience

On activation, check and report:

- extension server health
- Claude CLI availability
- Codex CLI availability
- tmux availability where Claude runtime management depends on it
- workspace permissions / writable storage paths

The extension should guide the user, not assume every runtime dependency is embedded.

### 4.7.3 Marketplace Readiness

- clear capability matrix by platform
- concise onboarding
- crash/log reporting guidance
- explicit dependency documentation

---

## 5. Cross-Cutting Concerns

### 5.1 Error Handling

- extension host failures must not silently orphan the child server
- server startup errors must be surfaced in an output channel and a user-visible notification
- provider availability failures must degrade per agent, not break the whole app

### 5.2 Logging

Need consistent logging layers:

- extension output channel
- child server stderr/stdout capture
- optional structured log file in extension storage

### 5.3 Testing Strategy

#### Server

- config loading tests
- migration tests against legacy schemas
- provider startup abstraction tests

#### Web UI / WebView

- state persistence tests
- theme bridge tests
- smoke tests for panel boot

#### Extension

- activation tests
- server manager tests
- command registration tests

### 5.4 Documentation

Need separate docs for:

- extension user guide
- migration architecture
- dependency matrix by provider/platform
- recovery and troubleshooting

---

## 6. File Inventory

### 6.1 New Files To Create

```text
packages/server/src/config/defaults.ts
packages/server/src/config/schema.ts
packages/server/src/config/load.ts
packages/server/src/utils/find-binary.ts
packages/server/src/start.ts
packages/server/src/db/migrations.ts

packages/vscode-extension/package.json
packages/vscode-extension/tsconfig.json
packages/vscode-extension/esbuild.config.ts
packages/vscode-extension/src/extension.ts
packages/vscode-extension/src/server/manager.ts
packages/vscode-extension/src/server/client.ts
packages/vscode-extension/src/server/health.ts
packages/vscode-extension/src/views/webview-panel.ts
packages/vscode-extension/src/views/agent-tree.ts
packages/vscode-extension/src/views/project-tree.ts
packages/vscode-extension/src/views/shared-files-tree.ts
packages/vscode-extension/src/features/commands.ts
packages/vscode-extension/src/features/notifications.ts
packages/vscode-extension/src/features/status-bar.ts
packages/vscode-extension/src/features/config-sync.ts
packages/vscode-extension/src/utils/logger.ts
packages/vscode-extension/src/utils/platform.ts
```

### 6.2 Existing Files To Modify

```text
package.json
pnpm-workspace.yaml
packages/server/package.json
packages/server/src/config.ts
packages/server/src/index.ts
packages/server/src/db/index.ts
packages/server/src/db/schema.ts
packages/server/src/api/agents.ts
packages/server/src/api/router.ts
packages/server/src/providers/codex.ts
packages/server/src/tmux-monitor.ts
packages/server/src/memory-engine.ts
packages/server/src/sop-engine.ts
packages/mcp-bridge/src/client.ts
packages/web-ui/index.html
packages/web-ui/styles.css
packages/web-ui/src/main.ts
packages/web-ui/src/chat.ts
packages/web-ui/src/dashboard.ts
packages/web-ui/src/quick-jump.ts
packages/web-ui/src/utils.ts
```

### 6.3 Files To Delete Later

Do not delete the Swift app at the start of the migration. Remove it only after extension parity is proven.

Candidates after parity:

```text
app/Package.swift
app/Sources/ClaudeCrew/*
```

---

## 7. Risk Assessment

| Risk | Impact | Mitigation |
|------|--------|------------|
| Hardcoded runtime paths survive into extension | extension only works on dev machine | Phase 0 binary finder + config audit |
| tmux assumptions leak into all providers | Codex and future providers become second-class | runtime-provider abstraction before extension integration |
| Web UI assumes localhost static hosting | panel fails under WebView CSP/URI rules | dedicated WebView adaptation phase |
| `better-sqlite3` packaging complexity | broken Marketplace distribution | platform-targeted VSIX builds |
| deleting Swift app too early | no stable fallback during migration | keep native app until extension launch candidate exists |
| undocumented external dependencies | poor first-run experience | dependency diagnostics and onboarding |

---

## 8. Execution Order

1. Phase 0: configuration, binary lookup, migration framework.
2. Phase 1: server startup API and bundling/productization.
3. Phase 2: runtime-provider abstraction and provider-neutral APIs.
4. Phase 3: create `packages/vscode-extension` and basic activation/server lifecycle.
5. Phase 4: adapt the existing web UI to WebView hosting.
6. Phase 5: wire VS Code trees, commands, notifications, and runtime affordances.
7. Phase 7: packaging, first-run diagnostics, Marketplace prep.
8. Only then consider Swift app removal.

### Immediate Next Step

The first implementation milestone should be:

**Convert the server from fixed constants + machine-local paths into a host-injectable productized service.**

Without that, every later extension step will be forced to work around the same portability problems.
