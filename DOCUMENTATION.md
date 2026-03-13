# Claude Crew - Multi-Agent Group Chat System

A local native macOS application that enables multiple Claude Code and Codex agents to communicate through a shared group chat, while each agent maintains its own private runtime session and workspace.

---

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Project Structure](#project-structure)
4. [Components Detail](#components-detail)
5. [Database Schema](#database-schema)
6. [MCP Tools Reference](#mcp-tools-reference)
7. [REST API Reference](#rest-api-reference)
8. [Quick Start](#quick-start)
9. [CLI Reference](#cli-reference)
10. [Configuration](#configuration)
11. [Memory System](#memory-system)
12. [Development](#development)
13. [Troubleshooting](#troubleshooting)
14. [Project Management System](#project-management-system)
15. [PEAK System (Human-AI Decision Escalation)](#peak-system-human-ai-decision-escalation)
16. [SOP Auto-Evolution (Standards & Reflections)](#sop-auto-evolution-standards--reflections)

---

## Overview

### Problem

A single Claude Code agent has a limited context window. Complex projects require multiple agents to collaborate, but there is no built-in mechanism for them to communicate with each other.

### Solution

Claude Crew simulates a **team management** model:

| Concept | Analogy | Implementation |
|---------|---------|----------------|
| Private terminal | 1-on-1 meeting with an employee | Each agent's tmux session or Codex app-server session |
| Group chat window | Company Slack channel | Native macOS app (this project) |
| @mention | Calling on someone in a meeting | Message auto-injected into agent's terminal |
| Chat history | Meeting minutes available to all | All agents can query on demand |
| Shared files | Company shared drive | Accessed only when needed |
| Individual memory | Employee's personal notes | Server-managed per-agent memory with global/project/workplace scope |

### Key Design Principles

- **Direct injection**: When you `@mention` an agent in the group chat, the message is pushed straight into that agent's active runtime. Claude agents receive it via tmux; Codex agents receive it via the app-server session. No polling needed.
- **Auto reply**: Agents are instructed (via `CLAUDE.md` or `AGENTS.md`) to use `send_to_chat` to post results back to the group chat.
- **No context waste**: Chat content is queryable, not auto-pushed. Agents only receive messages directed at them.
- **Private by default**: Each agent's individual memory and terminal session remain private.
- **Native experience**: The app runs as a native macOS window (Swift + WKWebView), not in a browser.

---

## Architecture

```
+---------------------------------------------------+
|            ClaudeCrew.app (Swift/AppKit)          |
|            WKWebView -> http://127.0.0.1:3140     |
+------------------------+--------------------------+
                         | WebSocket (real-time UI)
+------------------------+--------------------------+
|           Node.js Central Server                  |
|         (Express 5 + SQLite + WebSocket)          |
|                                                   |
|  HTTP API   WebSocket   Heartbeat   Forwarding    |
|  /api/*     /ws         Monitor     (provider)    |
+---+---------------+----------+----+--------------+
    | HTTP           |          |    |
+---+---+     +------+------+  | +--+----------------------+
| Bridge |     | Bridge      |  | | Provider runtime       |
| (MCP   |     | (MCP stdio) |  | | - Claude Code via tmux |
| stdio) |     |             |  | | - Codex via app-server |
+---+---+     +------+------+  | +-------------------------+
    | MCP stdio       | MCP    |
+---+---+     +------+------+  |
| Claude |     | Codex       |  |
| Code   |     | CLI         |  |
+--------+     +-------------+  |
```

### Communication Flow

1. User types `@coder build a timer app` in the group chat UI
2. Central Server stores the message, parses `@coder`, creates a pending mention with `delivery_status = 'sent'`
3. Server forwards the full message into the coder's active runtime. Claude agents receive it via `tmux send-keys`; Codex agents receive it through the app-server transport. On success, `delivery_status` becomes `'delivered'` and a `message:status` WebSocket event is pushed.
4. The agent runtime receives the message as direct operator input
5. If the runtime needs approval, the provider-specific monitor detects it, broadcasts an `approval:pending` event, and an interactive approval card appears in the chat UI
6. The agent processes the request, then calls `send_to_chat` (MCP tool) to post results back to the group chat
7. Runtime state transitions (`idle` -> `busy`) mark recent mentions as `'read'` (UI shows blue double checkmark)
8. The response appears in the app UI via WebSocket

### Why tmux for Claude, and app-server for Codex?

Claude agents run in named tmux sessions (`crew-<name>`). Codex agents run through the Codex app-server transport. Together, these provider-specific runtimes enable:

- **Programmatic input injection**: the server can deliver user messages directly into a live provider session
- **Background operation**: Agents run without visible terminal windows
- **Easy monitoring**: Claude agents can be inspected with `crew attach <name>`; Codex runtime state is exposed through the app and server APIs
- **Reliable process management**: `crew kill <name>` to stop agents cleanly
- **State detection**: Claude uses the Tmux Monitor; Codex exposes runtime/approval state through the provider bridge

### Why MCP Stdio Bridge?

Claude Code and Codex both talk to Claude Crew through an MCP stdio bridge. Each agent workspace contains either `.mcp.json` or `.codex/config.toml`, plus local instructions and `.crew` pointers. The bridge:

- Registers the agent with the central server on startup
- Maintains heartbeat (30s interval)
- Provides MCP tools for the agent to communicate, manage state, access scoped files and memory, project/workplace context, reflections, standards, and peaks
- Forwards all tool calls to the central server via HTTP

---

## Project Structure

```
~/Projects/claude-crew/
|
|-- agents/                          # Agent workspaces (one per agent)
|   |-- architect/
|   |   |-- .mcp.json                # Project-scoped MCP config for this agent
|   |   |-- CLAUDE.md / AGENTS.md    # Agent identity and instructions (provider-specific)
|   |   `-- .crew/                   # Runtime pointers to current project/workplace
|   `-- coder/
|       |-- .mcp.json
|       |-- CLAUDE.md / AGENTS.md
|       `-- .crew/
|
|-- app/                             # Swift native macOS app
|   |-- Package.swift
|   `-- Sources/ClaudeCrew/
|       |-- main.swift               # App entry point
|       |-- AppDelegate.swift        # Lifecycle: start/stop Node server, menu bar
|       |-- MainWindow.swift         # WKWebView window (960x680)
|       `-- ServerProcess.swift      # Node.js child process management
|
|-- packages/
|   |-- server/                      # Central Node.js server
|   |   |-- package.json             # express, ws, better-sqlite3, zod
|   |   |-- tsconfig.json
|   |   `-- src/
|   |       |-- index.ts             # Entry: HTTP + WebSocket + heartbeat monitor + tmux monitor
|   |       |-- config.ts            # Port, paths, timeout constants
|   |       |-- agent-context.ts     # Syncs .crew context files and project/workplace pointers into agent workspaces
|   |       |-- mentions.ts          # @mention parsing + notification queue
|   |       |-- forward.ts           # provider-runtime forwarding + delivery status tracking
|   |       |-- tmux-monitor.ts      # Tmux session scanner: state detection, tool approval parsing
|   |       |-- db/
|   |       |   |-- index.ts         # Database singleton + type definitions
|   |       |   `-- schema.ts        # SQLite schema + migration logic
|   |       |-- api/
|   |       |   |-- router.ts        # API router: mentions, wake, workspaces, status, approvals
|   |       |   |-- agents.ts        # Full lifecycle: register, create, heartbeat, edit, delete
|   |       |   |-- approvals.ts     # Tool approval API: list, get, respond
|   |       |   |-- messages.ts      # POST send (with auto-forward + delivery status), GET list
|   |       |   |-- channels.ts      # CRUD: create, update, archive, delete channels
|   |       |   |-- shared-files.ts  # GET/PUT/DELETE shared files
|   |       |   |-- import.ts        # Import Claude Code conversation history
|   |       |   |-- memory.ts        # Memory CRUD, search, consolidation, stats API
|   |       |   |-- projects.ts      # Project CRUD, lifecycle, agent assignment, context generation
|   |       |   |-- standards.ts     # Shared coding standards CRUD with budget enforcement
|   |       |   |-- reflections.ts   # Agent reflection submission and review
|   |       |   `-- peaks.ts         # Peak escalation, settlement, timeout handling
|   |       |-- memory-engine.ts     # Core decay algorithms (ACT-R activation, SM-2 stability, lifecycle)
|   |       |-- sop-engine.ts       # SOP auto-evolution engine (pattern extraction, contradiction detection, consolidation)
|   |       |-- project-init.ts     # Project directory initialization and CLAUDE.md generation
|   |       |-- storage-scope.ts    # Explicit project/workplace scope resolution and routing rules
|   |       `-- ws/
|   |           `-- handler.ts       # WebSocket: broadcast events to UI
|   |
|   |-- mcp-bridge/                  # MCP stdio bridge (one per agent)
|   |   |-- package.json
|   |   |-- tsconfig.json
|   |   `-- src/
|   |       |-- index.ts             # MCP server: 21 tools (chat, files, memory, project context, reflection, standards, peak)
|   |       `-- client.ts            # HTTP client: chat, files, memory, project, reflection, standards, peak methods
|   |
|   `-- web-ui/                      # Chat interface (HTML/CSS/TS)
|       |-- package.json             # esbuild (dev dependency only)
|       |-- index.html               # Single-page app shell
|       |-- styles.css               # Dark theme styles
|       `-- src/
|           |-- main.ts              # Init, channels, agents, files, wake, approvals, WebSocket
|           |-- chat.ts              # Message rendering, approval cards, delivery status
|           |-- input.ts             # Input with @mention autocomplete
|           |-- sidebar.ts           # (legacy, logic moved to main.ts)
|           |-- dashboard.ts         # Project dashboard (list, detail, create, agent assignment)
|           |-- project-types.ts     # TypeScript interfaces for projects, standards, reflections
|           `-- types.ts             # TypeScript interfaces (Agent, Message, ToolApproval)
|
|-- bin/
|   `-- ollama                       # Ollama CLI binary (local install, gitignored)
|
|-- data/                            # Runtime data (gitignored)
|   |-- claude-crew.db               # SQLite database (auto-created)
|   |-- shared/                      # Global shared files directory
|   |-- projects/                    # Canonical project roots + per-project workplaces
|   |-- agent_state/                 # Agent worklogs (JSON, one per agent)
|   |-- ollama-models/               # Ollama model storage (nomic-embed-text, ~274MB)
|   `-- server.log                   # Server output log
|
|-- cli/
|   `-- crew.sh                      # CLI tool: crew start|stop|wake|attach|...
|
|-- crew-manage.sh                   # System management (start/stop/restart/status/build/wake)
|-- package.json                     # pnpm workspace root
|-- pnpm-workspace.yaml              # Workspace: packages/*
|-- tsconfig.base.json               # Shared TypeScript config
`-- .gitignore
```

---

## Components Detail

### 1. Central Server (`packages/server`)

The backbone of the system. A single Node.js process running on `127.0.0.1:3140`.

**Responsibilities:**
- HTTP REST API for all data operations
- WebSocket server for real-time push to the native app UI
- SQLite database management (WAL mode for concurrent reads)
- Heartbeat monitoring: marks agents offline after 60s of silence
- **Tmux Monitor**: scans Claude agent tmux sessions every 2s for state changes and tool approval prompts
- **Message forwarding**: injects @mentioned messages into the active provider runtime, tracks delivery status
- **Tool approval management**: normalizes approval prompts from both Claude/tmux and Codex/app-server into the same UI flow
- Serves the web UI static files (HTML/CSS/JS)
- Full agent lifecycle: create workspace, start tmux/Codex session, kill processes, delete workspace

**Tech stack:** Express 5, ws, better-sqlite3, zod, TypeScript

**Key files:**
- `src/index.ts` - Entry point. Creates HTTP server, WebSocket, starts heartbeat monitor, peak timeout monitor, and the Claude tmux monitor.
- `src/config.ts` - All configuration constants (port 3140, paths, timeouts, Ollama URL/model). `CREW_PROJECT_ROOT` can override the runtime root for isolated validation.
- `src/agent-context.ts` - Maintains `.crew/context.json`, `.crew/current-project`, and `.crew/current-workplace` inside each agent workspace.
- `src/mentions.ts` - Parses `@agent-name` from message content. Expands `@all` to all online agents.
- `src/forward.ts` - Forwards messages into provider runtimes. Claude uses `tmux send-keys`; Codex uses the app-server session. Updates `delivery_status` to `'delivered'` on success and broadcasts `message:status` events.
- `src/tmux-monitor.ts` - Claude-provider runtime monitor. Scans all `crew-*` tmux sessions every 2s, detects agent state (idle/busy/approval_pending/no_session), parses tool approval prompts, sends approval key responses, and marks mentions as read when agents start processing.
- `src/db/schema.ts` - SQLite schema initialization with migration support, including project/workplace scope columns and `workplaces` table creation.
- `src/api/router.ts` - Routes `/api/*` requests. Includes wake, workspaces, mentions, approvals, memory, and status endpoints.
- `src/api/memory.ts` - Memory API: CRUD, hybrid keyword+vector search, project/workplace scoping, consolidation, stats, reindex.
- `src/memory-engine.ts` - Core decay algorithms: ACT-R activation, SM-2 stability, lifecycle rules (promote/archive).
- `src/embedding.ts` - Ollama embedding client: vector generation, cosine similarity, graceful degradation when Ollama is unavailable.
- `src/api/agents.ts` - Full agent lifecycle: register (MCP bridge), create (frontend with workspace + runtime pointers), heartbeat, edit, delete (kills processes + removes workspace).
- `src/api/approvals.ts` - Tool approval REST API: list pending, get by agent, respond with key.
- `src/api/channels.ts` - Channel CRUD (public/dm/group) with member management, project/workplace channel support, and WebSocket broadcast on changes. DM creation is idempotent.
- `src/api/messages.ts` - Message storage with auto-forwarding and delivery status tracking. For DM/group channels, auto-forwards to all channel members without requiring @mentions. GET joins `pending_mentions` to return per-agent delivery status.
- `src/ws/handler.ts` - WebSocket broadcast. Events: `message:new`, `agent:status`, `agent:tmux_state`, `approval:pending`, `approval:resolved`, `message:status`, `channel:*`, `file:updated`.

### 2. MCP Stdio Bridge (`packages/mcp-bridge`)

A lightweight process spawned by each agent runtime. Translates MCP tool calls into HTTP requests to the central server.

**Lifecycle:**
1. Claude Code or Codex reads the agent workspace config (`.mcp.json` or `.codex/config.toml`) and spawns the bridge
2. Bridge registers agent via `POST /api/agents/register`
3. Bridge starts heartbeat (every 30s)
4. The runtime calls MCP tools -> bridge forwards via HTTP -> returns results
5. On SIGTERM/SIGINT: bridge deregisters agent and exits

**Tech stack:** @modelcontextprotocol/sdk, Node.js fetch (built-in), TypeScript

### 3. Web UI (`packages/web-ui`)

The chat interface rendered inside the native app's WKWebView. Pure TypeScript + CSS, bundled with esbuild.

**Layout:**
```
+----------+------------------------------------+
| Sidebar  |  # General                         |
|          |  Chat messages (scrollable)        |
| CHANNELS |                                    |
| # general|  [user] 10:30                      |
| # dev    |  @coder build a timer app    vv    |
|          |                                    |
| AGENTS   |  +------------------------------+  |
| ! + btns |  | coder needs approval         |  |
| * coder  |  | claude-crew - send_to_chat   |  |
|   ready  |  | [Yes] [Don't ask] [No]       |  |
| * arch   |  +------------------------------+  |
|   working|                                    |
|          |  [coder] 10:31                     |
|          |  Timer app built. vv (read)        |
|          |------------------------------------+
| FILES    |  [@] Type a message...      [Send] |
| + ^ btns |                                    |
| api.md   |                                    |
|          |                                    |
| [Import] |                                    |
+----------+------------------------------------+
| Connected | Agents: 2/3 online                 |
+----------------------------------------------------+
```

**Features:**
- **Multi-channel support**: Public channels, DM (direct message), and group channels. Create, switch, archive, delete. Right-click context menu.
- **DM channels**: Click an agent's avatar in the sidebar to open a private 1-on-1 chat. Messages auto-forwarded to the agent without @mentions.
- **Group channels**: Create custom groups with selected agent members. Messages auto-forwarded to all members. Manage members (add/remove) from the channel header.
- **Channel list categorization**: Sidebar shows channels organized by type - public (#), groups (G with member count), direct messages (agent avatar).
- **Real-time updates**: WebSocket for messages, agent status, runtime state (`agent:tmux_state` event name), approvals, delivery status.
- **@mention autocomplete**: Type `@` to trigger dropdown with agent list and `@all`.
- **Agent avatars**: Color-coded avatars with initials, status dot indicator (online/offline/busy/warning). Click avatar to open DM.
- **Agent management**: Create (with workspace + provider config), edit role, delete (full cleanup) from UI. Wake individual or all agents.
- **Tool approval cards**: Interactive approval prompts rendered inline in chat. Supports both Claude/tmux and Codex/app-server approval flows. Click to approve/reject without attaching to a terminal.
- **Message delivery status**: Social-app style read receipts for @mentioned messages. Single check (sent), double check gray (delivered), double check blue (read).
- **Agent state labels**: Shows real-time runtime state next to agent names (ready/working/needs approval/no terminal) with pulse animation for warnings.
- **Shared file management**: Create new files, upload files (.md/.json/.txt), edit content, delete.
- **Import history**: Browse and import past Claude Code conversations.
- **Dark theme** matching terminal aesthetics.

### 4. Agent Workspaces (`agents/`)

Each agent has a dedicated workspace directory containing:

- **`.mcp.json`** or **`.codex/config.toml`** - Provider-specific MCP/runtime configuration.
- **`CLAUDE.md`** or **`AGENTS.md`** - Instructions for the agent. Tells it how to communicate via MCP tools and to always use `send_to_chat` for team-visible replies.
- **`.crew/context.json`** - Machine-readable metadata for the current assignment.
- **`.crew/current-project`** - Symlink to the canonical project root for the current assignment.
- **`.crew/current-workplace`** - Symlink to the active workplace for derived artifacts and execution outputs.

Example `.mcp.json`:
```json
{
  "mcpServers": {
    "claude-crew": {
      "command": "/path/to/node",
      "args": ["/path/to/bridge/index.js", "coder", "Backend developer"]
    }
  }
}
```

The default runtime `cwd` stays in the agent's own workspace. Project/workplace access is exposed through the `.crew/*` pointers and environment variables such as `CLAUDE_CREW_PROJECT_DIR` and `CLAUDE_CREW_WORKPLACE_DIR`.

### 5. Native App (`app/`)

A Swift/AppKit application that wraps the web UI in a native macOS window and manages the Node.js server lifecycle.

**What it does:**
1. On launch: finds Node.js binary, starts the server as a child process
2. Waits for server health check (`/api/status`) to return 200
3. Opens a WKWebView window pointing to `http://127.0.0.1:3140`
4. On quit: sends SIGTERM to the Node.js process

**Features:**
- Transparent title bar with dark background
- Menu bar with Quit (Cmd+Q), Reload (Cmd+R), Edit menu (copy/paste)
- Automatic Node.js path discovery (nvm, homebrew, system)

### 6. CLI Tool (`cli/crew.sh`)

A shell script for managing the system from the terminal. Symlinked to `/usr/local/bin/crew`.

---

## Database Schema

SQLite database at `data/claude-crew.db` (auto-created on first run). Uses WAL journal mode.

### channels

Chat channels supporting public, DM (direct message), and group types.

| Column | Type | Description |
|--------|------|-------------|
| id | TEXT PK | Channel ID (e.g. "general", "dm-coder", "my-team") |
| name | TEXT UNIQUE | Display name |
| description | TEXT | Optional description |
| status | TEXT | "active" or "archived" |
| type | TEXT | "public" (default), "dm", or "group" |
| members | TEXT | JSON array of agent names (for dm/group channels), NULL for public |
| project_id | TEXT | Associated project ID (nullable) |
| workplace_id | TEXT | Associated workplace ID (nullable) |
| created_at | INTEGER | Unix timestamp ms |
| updated_at | INTEGER | Unix timestamp ms |

A default "General" channel (type: public) is seeded on first run.

**Channel types:**
- **public**: Standard broadcast channel visible to everyone. Messages forwarded only to @mentioned agents.
- **dm**: Private channel between user and one agent. Created as `dm-{agentName}`. All messages auto-forwarded to the agent member without needing @mentions.
- **group**: Custom group of agents. All messages auto-forwarded to all member agents without needing @mentions.

### agents

Tracks registered Claude Code/Codex agents and their online status.

| Column | Type | Description |
|--------|------|-------------|
| id | TEXT PK | UUID |
| name | TEXT UNIQUE | Agent display name (e.g. "architect") |
| provider | TEXT | `"claude"` or `"codex"` |
| role | TEXT | Optional description (e.g. "API designer") |
| status | TEXT | "online", "offline", or "busy" |
| last_heartbeat | INTEGER | Unix timestamp ms of last heartbeat |
| registered_at | INTEGER | Unix timestamp ms of first registration |
| metadata | TEXT | JSON blob for extensibility |

### messages

The group chat message log.

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PK | Auto-increment message ID |
| channel_id | TEXT | Channel this message belongs to (default: "general") |
| sender_type | TEXT | "user", "agent", or "system" |
| sender_name | TEXT | Display name of sender |
| content | TEXT | Message body (supports markdown) |
| mentions | TEXT | JSON array of mentioned agent names |
| message_type | TEXT | "chat", "system", or "task" |
| created_at | INTEGER | Unix timestamp ms (server-assigned) |
| metadata | TEXT | JSON blob for extensibility |

### pending_mentions

Queue of unacknowledged @mentions for each agent, with delivery tracking.

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PK | Auto-increment |
| message_id | INTEGER FK | References messages(id) |
| agent_name | TEXT | Which agent was mentioned |
| acknowledged | INTEGER | 0 = pending, 1 = seen |
| delivery_status | TEXT | `'sent'` (default), `'delivered'` (forwarded to tmux), `'read'` (agent started processing) |
| created_at | INTEGER | Unix timestamp ms |

### shared_files

Metadata for files in global, project, and workplace file scopes.

| Column | Type | Description |
|--------|------|-------------|
| id | TEXT PK | UUID |
| path | TEXT | Relative path within the resolved scope root |
| scope_type | TEXT | `"global"`, `"project"`, or `"workplace"` |
| scope_id | TEXT | Scope identifier (empty for global) |
| created_by | TEXT | Agent name or "user" |
| description | TEXT | Brief description |
| updated_at | INTEGER | Unix timestamp ms |
| size_bytes | INTEGER | File size |
| metadata | TEXT | JSON blob including resolved `project_id` / `workplace_id` |

### projects

Multi-project workspace management.

| Column | Type | Description |
|--------|------|-------------|
| id | TEXT PK | UUID |
| name | TEXT | Project name |
| slug | TEXT UNIQUE | URL-friendly slug |
| description | TEXT | Project description |
| tech_stack | TEXT | JSON array of technologies |
| status | TEXT | "active", "paused", "archived" |
| config | TEXT | JSON config blob |
| directory | TEXT | Project directory path |
| created_at | INTEGER | Unix timestamp ms |
| updated_at | INTEGER | Unix timestamp ms |
| paused_at | INTEGER | Nullable, when paused |
| archived_at | INTEGER | Nullable, when archived |

### workplaces

Per-project execution spaces for derived artifacts, uploads, outputs, and temporary analysis.

| Column | Type | Description |
|--------|------|-------------|
| id | TEXT PK | UUID |
| project_id | TEXT FK | References projects(id) |
| name | TEXT | Workplace display name |
| slug | TEXT | Workplace slug unique within the project |
| status | TEXT | `"active"` |
| directory | TEXT | Workplace directory path |
| kind | TEXT | Usually `"derived"` |
| created_at | INTEGER | Unix timestamp ms |
| updated_at | INTEGER | Unix timestamp ms |

### project_agents

Agent-to-project assignment mapping.

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PK | Auto-increment |
| project_id | TEXT FK | References projects(id) |
| agent_name | TEXT | Agent name |
| role_in_project | TEXT | Agent's role in this project |
| assignment_type | TEXT | "dedicated" or "shared" |
| status | TEXT | "active", "inactive" |
| active_workplace_id | TEXT | Current workplace for this agent inside the project |
| assigned_at | INTEGER | Unix timestamp ms |

### shared_standards

Shared coding standards with budget enforcement and version tracking.

| Column | Type | Description |
|--------|------|-------------|
| id | TEXT PK | UUID |
| category | TEXT | Standard category |
| name | TEXT | Standard name |
| content | TEXT | Standard content |
| priority | INTEGER | Priority level |
| status | TEXT | "active" or "disabled" |
| created_at | INTEGER | Unix timestamp ms |
| updated_at | INTEGER | Unix timestamp ms |

### reflections

Agent reflection submissions with structured lessons and proposed standard updates.

| Column | Type | Description |
|--------|------|-------------|
| id | TEXT PK | UUID |
| agent_name | TEXT | Submitting agent |
| project_id | TEXT | Project context |
| trigger_type | TEXT | "task_complete", "project_milestone", "manual", "session_cycle" |
| task_summary | TEXT | Task description |
| lessons_learned | TEXT | JSON array of lessons |
| proposed_updates | TEXT | JSON array of standard update proposals |
| confidence | REAL | 0-1 confidence score |
| status | TEXT | "pending", "auto_applied", "manually_approved", or "rejected" |
| reviewed_by | TEXT | Who reviewed (nullable) |
| created_at | INTEGER | Unix timestamp ms |
| reviewed_at | INTEGER | Nullable |

### standards_history

Version history for shared standards, enabling rollback.

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PK | Auto-increment |
| standard_id | TEXT FK | References shared_standards(id) |
| version | INTEGER | Version number |
| content | TEXT | Content at this version |
| change_summary | TEXT | What changed |
| source_reflection_ids | TEXT | JSON array of reflection IDs |
| applied_by | TEXT | Who applied the change |
| created_at | INTEGER | Unix timestamp ms |

### peaks

Human-AI decision escalation records. Agents escalate critical decisions; humans settle them.

| Column | Type | Description |
|--------|------|-------------|
| id | TEXT PK | UUID |
| agent_name | TEXT | Escalating agent |
| project_id | TEXT | Project context (nullable) |
| peak_type | TEXT | "irreversibility", "multiple_paths", "info_asymmetry", "drift_check" |
| context | TEXT | Situation description |
| options | TEXT | JSON array of {label, pros, cons} |
| agent_lean | TEXT | Agent's recommendation (nullable) |
| default_option | INTEGER | Index to auto-choose on timeout |
| timeout_seconds | INTEGER | Seconds to wait for human (30-1800) |
| status | TEXT | "pending", "decided", "auto_decided", "expired" (`auto_decided` = human explicitly deferred to agent; `expired` = timeout settlement) |
| decision_index | INTEGER | Chosen option index (nullable) |
| decision_note | TEXT | Human's note (nullable) |
| decided_by | TEXT | Who decided (nullable) |
| created_at | INTEGER | Unix timestamp ms |
| decided_at | INTEGER | When decided (nullable) |

**Note:** `memory_entries` now use explicit `scope_type` / `scope_id` columns for `global`, `project`, and `workplace` scoping. The legacy `project_id` column remains as a backward-compatibility bridge, but new writes resolve through explicit scope routing.

---

## MCP Tools Reference

These are the tools available to each Claude Code/Codex agent through the MCP bridge.

### check_mentions

Check if you have been @mentioned in the group chat.

- **Input:** none
- **Output:** List of pending messages where you are mentioned. Auto-acknowledges all returned mentions.
- **Note:** With tmux forwarding, messages are already injected into the terminal. This tool serves as a fallback for checking missed mentions.

### read_chat

Read recent messages from the group chat. Supports incremental reading to save context.

- **Input:** `limit` (number, optional, default 10, max 200), `after_id` (number, optional, only return messages newer than this ID), `channel` (string, optional, default "general")
- **Output:** Messages with `#id [sender HH:MM]: content` format, plus `last_id` hint for next incremental read
- **Context cost:** Proportional to limit. Use `after_id` to fetch only new messages and minimize context consumption.

### send_to_chat

Send a message to the group chat. **This is how agents reply to the team.**

- **Input:** `message` (string), `channel` (string, optional, default "general")
- **Output:** Message ID and list of agents mentioned
- **Note:** Use `@agent-name` to mention agents, `@all` for broadcast

### list_agents

See which agents are currently in the group chat.

- **Input:** none
- **Output:** Array of {name, role, status}

### read_shared_file

Read a file from the resolved file scope. If the agent is assigned to a project, project/workplace scope is auto-detected.

- **Input:** `path` (string) - Relative path within the resolved scope root
- **Output:** File content, author, description, timestamp, and scope metadata

### write_shared_file

Write or update a file in the resolved file scope.

- **Input:** `path` (string), `content` (string), `description` (string, optional), `artifact_kind` (`canonical` or `derived`, optional)
- **Output:** Success confirmation with resolved scope
- **Routing rule:** canonical assets are written to the project root; derived artifacts are written to the active workplace.

### get_shared_file_meta

Get metadata of a shared file without loading its full content. Use this to check if a file has been updated before reading it fully, saving context.

- **Input:** `path` (string) - Relative path within the resolved scope root
- **Output:** Single line: `path | size | scope | author | updated_at | description`

### list_shared_files

List files in the active scope.

- **Input:** none
- **Output:** Array of {path, description, size, author, scope}

### save_worklog

Save current task state for recovery after session restart. Used by auto-cycle to preserve continuity.

- **Input:** `current_task` (object with description, status, progress, subtasks_done, next_step, blockers), `recent_decisions` (array, optional), `working_files` (array, optional), `key_context` (string, optional)
- **Output:** Confirmation that worklog is saved
- **Note:** Worklog is stored server-side per agent and persists across session restarts.

### load_worklog

Load previous task state after session restart.

- **Input:** none
- **Output:** Previous worklog JSON (task state, decisions, files, context) or "no previous worklog" if none exists.
- **Note:** Agents should call this at startup to resume work from where they left off.

### set_agent_config

Set the model and reasoning effort for an agent. **Author-exclusive** - only the author agent can call this tool. The target agent will be restarted to apply the new configuration.

- **Input:** `agent_name` (string), `model` (optional, "sonnet" or "opus"), `effort` (optional, "medium", "high", or "max")
- **Output:** Confirmation with applied config and restart status
- **Constraints:** Model restricted to sonnet/opus. Effort minimum is medium. Server rejects calls from non-author agents with 403.

### memory_search

Search agent memory with humanistic decay-weighted ranking. Frequently accessed memories rank higher. See [Memory System](#memory-system) for full details.

- **Input:** `query` (string), `category` (string, optional), `include_weak` (boolean, optional), `limit` (number, optional), `project_id` (string, optional - aggregates project + workplaces)
- **Output:** List of matching memories with heading, category, strength, and ID
- **Note:** Only use when starting a new topic or needing past context. Returns summaries by default; use `memory_read` to expand.

### memory_read

Read full content of a memory entry by ID. Reinforces the memory (retrieval practice effect).

- **Input:** `id` (string)
- **Output:** Full content with category, status, access count, and strength

### memory_write

Record a new memory with category and importance scoring. Duplicate content auto-detected.

- **Input:** `category` (enum: contact/preference/decision/project/pattern/feedback/daily), `heading` (string), `content` (string), `importance` (number 1-5, optional), `emotional_weight` (number 1.0-2.0, optional), `project_id` (string, optional), `scope_kind` (`canonical` or `derived`, optional)
- **Output:** Memory ID, status, initial strength, and resolved scope
- **Routing rule:** decision/project memories default to project scope; ambiguous or transient memories default to workplace scope.

### memory_status

View memory health dashboard.

- **Input:** `project_id` (string, optional - aggregates project + workplaces)
- **Output:** Total count, breakdown by status/category, average strength, recently accessed entries

### get_project_context

Get your current project context including description, tech stack, standards, team, canonical project root, and workplace guidance. Auto-detects project from agent assignment if no project_id given.

- **Input:** `project_id` (string, optional)
- **Output:** Markdown context string with project description, tech stack, active standards, team, project root, workplace info, and `.crew/*` pointer hints

### reflect_on_task

Submit a structured reflection after completing a task. High-confidence additive proposals may be auto-applied to shared standards.

- **Input:** `project_id` (string), `trigger_type` (enum: task_complete/project_milestone/manual/session_cycle), `task_summary` (string), `lessons_learned` (array of {category, description, evidence}, optional), `proposed_updates` (array of {action, section, current_text?, proposed_text, rationale, confidence}, optional), `confidence` (number 0-1, optional)
- **Output:** Reflection ID, status, auto-apply results
- **Auto-apply criteria:** confidence >= 0.8, add-only action, no contradiction with existing standards, within 4000 char budget, >= 2 agents with similar proposals

### propose_standard_update

Propose a single update to shared coding standards.

- **Input:** `project_id` (string), `action` (enum: add/modify/remove), `section` (string), `current_text` (string, optional), `proposed_text` (string), `rationale` (string), `confidence` (number 0-1)
- **Output:** Proposal ID, status, auto-apply outcome

### escalate_peak

Escalate a decision to the human operator. Use when facing irreversible actions, multiple viable paths, information asymmetry, or drift checks.

- **Input:** `peak_type` (enum: irreversibility/multiple_paths/info_asymmetry/drift_check), `context` (string), `options` (array of {label, pros, cons}), `agent_lean` (string, optional), `default_option` (number, optional, default 0), `timeout_seconds` (number, optional, 30-1800, default 300), `project_id` (string, optional)
- **Output:** Peak ID, status, expiration time, default option info
- **Note:** If the human does not respond within timeout, the default_option is auto-chosen. The decision is persisted to project-scoped memory and can trigger SOP pattern extraction.

### check_peak_decision

Check if a human has decided on a peak you escalated.

- **Input:** `peak_id` (string)
- **Output:** Decision details if resolved (chosen option, decided_by, note), or "pending" status if still waiting
- **Note:** This is now a fallback. The primary settlement path is a direct system message injected back to the agent plus a persisted channel message/pending mention.

---

## REST API Reference

Base URL: `http://127.0.0.1:3140/api`

### Agents

| Method | Path | Body | Description |
|--------|------|------|-------------|
| POST | /agents/register | `{name, role?}` | Register or reconnect an agent (called by MCP bridge) |
| POST | /agents/create | `{name, role?, wake?, provider?}` | Create agent workspace (`.mcp.json` or `.codex/config.toml`, provider instructions, `.crew` context pointers), register in DB, optionally start runtime |
| POST | /agents/heartbeat | `{name}` | Send heartbeat (keep online) |
| POST | /agents/deregister | `{name}` | Mark agent offline |
| GET | /agents | - | List all agents (includes `tmuxState`: idle/busy/approval_pending/no_session) |
| PUT | /agents/:name | `{role?, status?}` | Edit agent role/status |
| PUT | /agents/:name/config | `{model?, effort?, requested_by, restart?}` | Set agent model/effort config. Only `requested_by: "author"` is accepted (403 otherwise). Model: sonnet/opus. Effort: medium/high/max. If `restart: true`, kills and re-wakes the agent with new config. |
| GET | /agents/:name/worklog | - | Read agent's saved worklog (task state, decisions, files) |
| PUT | /agents/:name/worklog | `{worklog}` | Save agent's worklog (max 100KB). Stored as JSON file in data/worklogs/ |
| DELETE | /agents/:name | `?workspace=false` | Full cleanup: stop provider runtime, kill helper processes, delete workspace, remove from DB |

### Tool Approvals

| Method | Path | Body | Description |
|--------|------|------|-------------|
| GET | /approvals | - | List all pending tool approvals |
| GET | /approvals/:agentName | - | Get pending approval for a specific agent |
| POST | /approvals/:agentName/respond | `{key}` | Send approval response. Key: `"1"` (Yes), `"2"` (Don't ask again), `"3"` (No), `"Escape"` |

### Channels

| Method | Path | Body/Params | Description |
|--------|------|-------------|-------------|
| GET | /channels | `?status=active&project_id=...` | List channels (optionally filter by status/project), sorted by type then created_at |
| POST | /channels | `{name, description?, type?, members?}` | Create a new channel (type: "public" or "group", members: string[] for group) |
| POST | /channels/dm/:agentName | - | Create or open a DM channel with the named agent (idempotent) |
| POST | /channels/:id/members | `{name}` | Add an agent member to a group channel |
| DELETE | /channels/:id/members/:name | - | Remove an agent member from a group channel |
| PUT | /channels/:id | `{name?, description?, status?}` | Update/archive a channel |
| DELETE | /channels/:id | - | Delete channel and its messages (cannot delete "general") |

### Messages

| Method | Path | Params/Body | Description |
|--------|------|-------------|-------------|
| POST | /messages | `{sender_type, sender_name, content, channel_id?}` | Send a message. Auto-forwards to mentioned agents' active runtimes. For DM/group channels, auto-forwards to all channel members (no @mention needed). Updates delivery_status on success. |
| GET | /messages | `?channel_id=general&limit=50&before_id=N&after_id=N` | Fetch messages. `after_id` returns only messages newer than the given ID (ASC order). `before_id` for pagination (DESC, then reversed). Includes `delivery_status` per agent for messages with @mentions. |

### Mentions

| Method | Path | Description |
|--------|------|-------------|
| GET | /mentions/:agentName | Get pending mentions for agent |
| POST | /mentions/:id/ack | Acknowledge a mention |

### Shared Files

| Method | Path | Body | Description |
|--------|------|------|-------------|
| GET | /shared-files | `?project_id=...&scope_type=...&scope_id=...` | List files in global scope, an explicit scope, or aggregate project+workplaces |
| GET | /shared-files/:path | `?project_id=...&scope_type=...&scope_id=...` | Read a file from the resolved scope |
| PUT | /shared-files/:path | `{content, created_by, description?, project_id?, workplace_id?, scope_type?, scope_id?, artifact_kind?}` | Write/update file (max 1MB) with explicit or inferred routing |
| DELETE | /shared-files/:path | `?project_id=...&scope_type=...&scope_id=...` | Delete from the resolved scope |

### Wake / Workspaces

| Method | Path | Body | Description |
|--------|------|------|-------------|
| POST | /wake | `{name}` | Start the agent runtime (tmux for Claude, app-server for Codex) |
| POST | /wake-all | - | Start all agent runtimes |
| GET | /workspaces | - | List agent workspaces |

### Import

| Method | Path | Body | Description |
|--------|------|------|-------------|
| GET | /import/sessions | - | List importable Claude Code sessions |
| POST | /import/session | `{sessionId, label?}` | Import a session into group chat |

### Status

| Method | Path | Description |
|--------|------|-------------|
| GET | /status | Server health check (agent counts, message count, uptime) |

### Memory

| Method | Path | Body/Params | Description |
|--------|------|-------------|-------------|
| POST | /memory/entries | `{agent_name?, category, heading, content, importance?, emotional_weight?, project_id?, scope_type?, scope_id?, scope_kind?}` | Create memory entry (409 on duplicate content within the same scope) |
| GET | /memory/entries/:id | - | Read entry + record access (reinforces memory) |
| PUT | /memory/entries/:id | `{heading?, content?, importance?, emotional_weight?, category?, status?}` | Update entry fields |
| DELETE | /memory/entries/:id | - | Delete entry |
| GET | /memory/search | `?q=...&agent_name=author&category=...&include_weak=true&limit=5&summary_only=true&project_id=...` | Decay-weighted search, aggregating project + workplaces when `project_id` is present |
| POST | /memory/consolidate | `{agent_name?, project_id?, scope_type?, scope_id?}` | Trigger consolidation (recalculate, promote, archive) for the resolved scope |
| GET | /memory/stats | `?agent_name=author&project_id=...&scope_type=...&scope_id=...` | Memory health dashboard for the resolved scope |
| POST | /memory/reindex | `{agent_name?, project_id?, scope_type?, scope_id?}` | Batch-generate embeddings for entries missing them in the resolved scope |

**Note:** Memory endpoints accept either explicit `scope_type` / `scope_id` or a `project_id` aggregate. `project_id` means "project plus all workplaces under it", not project-only.

### Projects

| Method | Path | Body/Params | Description |
|--------|------|-------------|-------------|
| GET | /projects | - | List all projects |
| POST | /projects | `{name, description?, tech_stack?, config?}` | Create project |
| GET | /projects/:id | - | Get project detail with agents |
| GET | /projects/:id/workplaces | - | List workplaces under a project |
| POST | /projects/:id/workplaces | `{name?, kind?}` | Create or return a workplace |
| PUT | /projects/:id | `{name?, description?, tech_stack?, config?}` | Update project |
| DELETE | /projects/:id | - | Delete project |
| POST | /projects/:id/pause | - | Pause project |
| POST | /projects/:id/resume | - | Resume project |
| POST | /projects/:id/archive | - | Archive project |
| GET | /projects/:id/agents | - | List project agents |
| POST | /projects/:id/agents | `{agent_name, role_in_project?, assignment_type?}` | Assign agent |
| DELETE | /projects/:id/agents/:name | - | Remove agent from project |
| PUT | /projects/:id/agents/:name/workplace | `{workplace_id?}` | Switch the agent's active workplace for this project |
| GET | /projects/:id/context | - | Generate project context markdown |
| GET | /projects/:id/workplaces/:workplaceId/context | - | Generate workplace context markdown |
| GET | /projects/by-agent/:name | - | Get projects assigned to an agent |
| POST | /projects/:id/memory/share | `{target_project_id, entry_ids}` | Copy memory entries from the source project in the URL to another project |

### Standards

| Method | Path | Body/Params | Description |
|--------|------|-------------|-------------|
| GET | /standards | `?status=active&category=...` | List standards |
| GET | /standards/budget | - | Get standards budget (used/total chars) |
| POST | /standards | `{category, name, content, priority?}` | Create standard (enforces 4000 char budget) |
| PUT | /standards/:id | `{name?, content?, category?, priority?, status?}` | Update standard (auto-records version history) |
| DELETE | /standards/:id | - | Delete standard |
| GET | /standards/:id/history | - | Version history for a standard |
| POST | /standards/:id/rollback | `{version}` | Rollback to a specific version |

### Reflections

| Method | Path | Body/Params | Description |
|--------|------|-------------|-------------|
| POST | /reflections | `{agent_name, project_id, trigger_type, task_summary, lessons_learned, proposed_updates, confidence}` | Submit reflection (auto-triggers SOP review) |
| GET | /reflections | `?project_id=...&status=...&agent_name=...` | List reflections |
| GET | /reflections/:id | - | Get single reflection |
| PUT | /reflections/:id/review | `{status: "approved"\|"rejected", reviewed_by?}` | Review reflection (approval applies proposed updates) |

### Peaks

| Method | Path | Body/Params | Description |
|--------|------|-------------|-------------|
| POST | /peaks | `{agent_name, project_id?, peak_type, context, options, agent_lean?, default_option?, timeout_seconds?}` | Agent escalates a peak |
| GET | /peaks | `?status=...&agent_name=...&project_id=...&limit=20` | List peaks |
| GET | /peaks/pending | - | Get all pending peaks |
| GET | /peaks/:id | - | Get single peak |
| POST | /peaks/:id/decide | `{option_index, note?, decided_by?}` | Human decides (Settlement: persist + propagate + extract patterns) |
| POST | /peaks/:id/let-agent-decide | - | Human defers to agent's default |
| POST | /peaks/:id/pause | - | Extend timeout by 10 minutes |

---

## Quick Start

### Prerequisites

- macOS 14+ (Apple Silicon or Intel)
- Node.js 18+ (with pnpm)
- Swift 5.9+ (included with Xcode Command Line Tools)
- tmux (`brew install tmux`)
- Claude Code CLI (`claude`)

### 1. Build Everything

```bash
cd ~/Projects/claude-crew
crew build
```

This runs: `pnpm install` -> compile server -> compile bridge -> bundle UI -> swift build.

### 2. Start the Server

```bash
crew start
```

Or launch the native app (which starts the server automatically):

```bash
crewapp
```

### 3. Create Agents

Via CLI:
```bash
crew add architect "System architect"
crew add coder "Backend developer"
crew add tester "QA engineer"
```

Or via the web UI: click the **+** button next to "AGENTS" in the sidebar. Enter name and role, check "Start immediately" to auto-launch. The server creates the workspace (`agents/<name>/` with provider config, instructions, and `.crew` pointers) and optionally starts the runtime.

### 4. Wake Agents

```bash
# Wake all agents
crew wake all

# Or wake individually
crew wake coder
```

This starts each agent's configured provider runtime. Claude agents start in tmux; Codex agents start through the Codex app-server. The MCP bridge auto-registers the agent with the server.

### 5. Use the Group Chat

Open the app or browser at `http://127.0.0.1:3140`:

```
@coder build a countdown timer CLI tool in Node.js
```

The message is automatically injected into the coder's active runtime. The coder processes it, builds the tool, then uses `send_to_chat` to post results back.

### 6. Monitor Agents

```bash
# Attach to watch an agent work in real-time
crew attach coder
# Press Ctrl+B then D to detach

# List agent status
crew list

# Stop all agents
crew kill all
```

### 7. Import Past Conversations

Click **Import History** in the sidebar to browse and import previous Claude Code conversations into the group chat.

---

## CLI Reference

Command: `crew <command> [args]`

| Command | Description |
|---------|-------------|
| `crew build` | Build all components (server, bridge, UI, Swift app) |
| `crew start` | Start the central server (background) |
| `crew stop` | Stop the central server |
| `crew app` | Launch the native macOS app |
| `crew add <name> <role>` | Create agent workspace with provider config and `.crew` pointers |
| `crew remove <name>` | Remove agent (stop runtime, delete workspace, delete from DB) |
| `crew wake [name\|all]` | Start agent runtime(s) |
| `crew attach <name>` | Attach to agent's terminal (Ctrl+B D to detach) |
| `crew kill [name\|all]` | Stop agent runtime(s) |
| `crew list` | List all registered agents and their status |
| `crew status` | Show server status (JSON) |
| `crew project list` | List all projects |
| `crew project create <name>` | Create a new project |
| `crew project pause <id>` | Pause a project |
| `crew project resume <id>` | Resume a project |
| `crew project archive <id>` | Archive a project |
| `crew standards list` | List active standards |
| `crew standards add` | Add a new standard (interactive) |
| `crew standards budget` | Show standards budget usage |

Shell alias: `crewapp` = launch the native app (configured in `~/.zshrc`).

---

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CREW_PORT` | 3140 | Server port |
| `CREW_PROJECT_ROOT` | (auto-detected) | Path to claude-crew project root |
| `NODE_PATH` | (auto-detected) | Path to Node.js binary |
| `CLAUDECODE` | - | Must be unset for agents to start (handled automatically) |
| `OLLAMA_BASE_URL` | `http://127.0.0.1:11434` | Ollama server URL for embedding generation |
| `OLLAMA_MODEL` | `nomic-embed-text` | Ollama embedding model name |
| `OLLAMA_MODELS` | `data/ollama-models` | Ollama model storage path (set by crew.sh) |

### Constants (packages/server/src/config.ts)

| Constant | Value | Description |
|----------|-------|-------------|
| PORT | 3140 | HTTP + WebSocket server port |
| HEARTBEAT_TIMEOUT_MS | 60,000 | Mark agent offline after this silence |
| HEARTBEAT_CHECK_INTERVAL_MS | 15,000 | How often to check for stale agents |
| SESSION_AUTO_CYCLE_CONTEXT_PERCENT | 80 | Context usage % threshold to trigger auto-cycle |
| SESSION_AUTO_CYCLE_COOLDOWN_MS | 300,000 | Minimum 5 minutes between auto-cycles per agent |
| OLLAMA_BASE_URL | `http://127.0.0.1:11434` | Ollama API endpoint |
| OLLAMA_MODEL | `nomic-embed-text` | Embedding model (768-dim, ~274MB) |

### Message Types

- `@agent-name` - Notifies only the named agent (message injected into their terminal)
- `@all` - Notifies all online agents (message injected into all terminals)
- Plain message - Stored without notification (information archive)

---

## Memory System

A humanistic memory decay system for agents (primarily the **author** agent). Memories decay based on access patterns rather than simple time, inspired by the ACT-R cognitive model and SM-2 spaced repetition algorithm.

### Core Concept

> **Memory strength = f(access frequency, access spacing, importance, emotional weight, category)**

Instead of a flat 30-day time decay, memories follow a "use it or lose it" model:
- Frequently accessed memories stay strong
- Well-spaced access (like spaced repetition) builds stronger memories than cramming
- Important and emotionally-tagged memories resist decay
- Certain categories (contacts, preferences) are permanent by design

### Memory Categories

| Category | Decay Behavior | Use Case |
|----------|---------------|----------|
| `contact` | **Permanent** (never decays) | People, organizations, contact info |
| `preference` | **Permanent** (never decays) | User preferences, workflow habits |
| `decision` | **Slow decay** (min 60-day stability) | Key decisions, architectural choices |
| `project` | **Slow decay** (min 60-day stability) | Project context, goals, milestones |
| `pattern` | **Normal decay** | Recurring patterns, best practices |
| `feedback` | **Normal decay** | User feedback, corrections |
| `daily` | **Fast decay** (archived after 90 days if unused) | Session notes, daily logs |

### Decay Formula (ACT-R Based)

Each memory entry tracks:
- `access_count` - total times accessed
- `access_timestamps` - last 20 access times (sliding window)
- `stability` - days until memory drops to 90% retrievability (grows with spaced access)
- `activation` - computed strength score (higher = easier to recall)
- `retrievability` - probability of recall (0.0 to 1.0)

**Activation** is computed as:
```
activation = baseLevelActivation + importanceBoost + emotionalBoost + spacingBonus + categoryWeight
```

Where `baseLevelActivation = ln(SUM((now - t_i)^(-0.5)))` for each access time `t_i` (ACT-R power-law decay).

**Retrievability** converts activation to a 0-1 probability via logistic function:
```
retrievability = 1 / (1 + exp(-3 * (activation - threshold)))
```

### Memory Lifecycle

1. **Creation**: Memory written via `memory_write` with category and importance (1-5)
2. **Retrieval reinforcement**: Each `memory_search` hit or `memory_read` call reinforces the memory (updates access history, increases stability)
3. **Promotion**: Daily entries accessed 3+ times over 3+ days are promoted to long-term topic memory
4. **Archival**: Memories with retrievability < 5% are archived (not deleted, recoverable)
5. **Consolidation**: On session startup, all entries are recalculated and lifecycle rules applied

### Search Integration (Hybrid Keyword + Vector)

Search uses a hybrid approach combining keyword matching and semantic vector similarity:

1. **Keyword relevance**: Counts matching query terms in heading + content (BM25-like)
2. **Vector similarity**: Cosine similarity between query embedding and stored entry embedding (via Ollama nomic-embed-text, 768-dim)
3. **Hybrid blend**: When both signals are available, `searchRelevance = 0.5 * keyword + 0.5 * vector`. When Ollama is unavailable, falls back to keyword-only.

Final score combines search relevance with memory strength:
```
finalScore = searchRelevance * (0.3 + 0.7 * retrievability)
```

The 0.3 floor ensures even weak memories can surface if search relevance is very high (the "tip of the tongue" effect).

**Graceful degradation**: If Ollama is not running, all search and write operations work normally using keyword-only mode. Embeddings are generated asynchronously on write (non-blocking). The `POST /memory/reindex` endpoint can batch-generate embeddings for existing entries when Ollama becomes available.

### Context Consumption Control (Lazy Retrieval)

To prevent the memory system from consuming excessive context:

- **Trigger rules**: `memory_search` only fires on new topics, decision points, user requests, or session recovery. NOT on routine message relay.
- **Two-level return**: Default returns only one-line summaries (~150 tokens). Full content via `memory_read` on demand.
- **Token budget**: Single search hard-capped at 500 tokens. Session total target < 5,000 tokens (~2-3% of context).

### Key Files

| File | Description |
|------|-------------|
| `packages/server/src/memory-engine.ts` | Core decay algorithms: activation, retrievability, consolidation, lifecycle rules |
| `packages/server/src/api/memory.ts` | REST API: CRUD, hybrid search, consolidate, stats, reindex |
| `packages/server/src/embedding.ts` | Ollama embedding client: generation, cosine similarity, availability detection |
| `packages/server/src/db/schema.ts` | `memory_entries` table (22 columns + 4 indexes) |
| `packages/mcp-bridge/src/index.ts` | MCP tools: memory_search, memory_read, memory_write, memory_status |
| `packages/mcp-bridge/src/client.ts` | HTTP client functions for memory API |

### MCP Tools

#### memory_search

Search memories with decay-weighted ranking. Only use when encountering a new topic, making decisions, or recalling past context.

- **Input:** `query` (string), `category` (optional), `include_weak` (boolean, optional), `limit` (number, optional)
- **Output:** List of matching memories with heading, category, strength %, and ID. Use `memory_read` to expand.

#### memory_read

Read full content of a memory entry by ID. Also reinforces the memory (increases strength via retrieval practice effect).

- **Input:** `id` (string)
- **Output:** Full memory content with category, status, access count, and strength

#### memory_write

Record a new memory with category and importance scoring. Duplicate content is automatically detected.

- **Input:** `category` (enum), `heading` (string), `content` (string), `importance` (1-5, optional), `emotional_weight` (1.0-2.0, optional)
- **Output:** Memory ID, status (active/permanent), initial strength
- **Note:** Set `emotional_weight > 1.5` for user-emphasized items ("remember this", "important")

#### memory_status

View memory health dashboard: total count, category breakdown, average strength, recently accessed entries.

- **Input:** none
- **Output:** Statistics summary

### REST API

| Method | Path | Body/Params | Description |
|--------|------|-------------|-------------|
| POST | /memory/entries | `{agent_name?, category, heading, content, importance?, emotional_weight?}` | Create memory entry. Returns id, status, activation, retrievability. 409 on duplicate. |
| GET | /memory/entries/:id | - | Read entry (records access, reinforces memory) |
| PUT | /memory/entries/:id | `{heading?, content?, importance?, emotional_weight?, category?, status?}` | Update entry fields |
| DELETE | /memory/entries/:id | - | Delete entry |
| GET | /memory/search | `?q=...&agent_name=author&category=...&include_weak=true&limit=5&summary_only=true` | Hybrid keyword+vector search with decay-weighted ranking |
| POST | /memory/consolidate | `{agent_name?}` | Trigger consolidation (recalculate, promote, archive) |
| POST | /memory/reindex | `{agent_name?, project_id?, scope_type?, scope_id?}` | Batch-generate embeddings for entries missing them in the resolved scope (requires Ollama) |
| GET | /memory/stats | `?agent_name=author&project_id=...&scope_type=...&scope_id=...` | Memory health dashboard |

### Database Schema: memory_entries

| Column | Type | Description |
|--------|------|-------------|
| id | TEXT PK | UUID |
| agent_name | TEXT | Agent owner (default: "author") |
| category | TEXT | contact/preference/decision/project/pattern/feedback/daily |
| source_file | TEXT | Origin file path |
| heading | TEXT | One-line summary (shown in search results) |
| content | TEXT | Full memory content |
| content_hash | TEXT | SHA-256 prefix for dedup |
| importance | INTEGER | Base importance 1-5 |
| emotional_weight | REAL | 1.0 (neutral) to 2.0 (emphasized) |
| created_at | INTEGER | Epoch ms |
| last_accessed_at | INTEGER | Epoch ms, updated on every access |
| access_count | INTEGER | Total access count |
| access_timestamps | TEXT | JSON array of last 20 access epoch ms |
| stability | REAL | Days until 90% retrievability (grows with spaced access) |
| difficulty | REAL | 0.0-1.0, affects stability growth rate |
| activation | REAL | Computed ACT-R activation (cached) |
| retrievability | REAL | 0.0-1.0 recall probability (cached) |
| status | TEXT | active/dormant/archived/promoted/permanent |
| promoted_at | INTEGER | When promoted from daily to long-term |
| archived_at | INTEGER | When archived (forgotten) |
| linked_ids | TEXT | JSON array of related memory IDs |
| project_id | TEXT | Legacy bridge column for compatibility |
| scope_type | TEXT | global/project/workplace |
| scope_id | TEXT | Scope identifier (empty for global) |
| embedding | BLOB | 768-dim float64 vector embedding from Ollama nomic-embed-text (6144 bytes, generated async on write) |

---

## Development

### Dev Mode

```bash
# Terminal 1: Server with auto-rebuild
cd packages/server && pnpm dev

# Terminal 2: Web UI with auto-rebuild
cd packages/web-ui && pnpm dev

# Open http://127.0.0.1:3140 in browser for development
```

### Adding a New MCP Tool

1. Define the tool in `packages/mcp-bridge/src/index.ts` using `server.tool()`
2. Add the corresponding HTTP client method in `packages/mcp-bridge/src/client.ts`
3. Add the API endpoint in `packages/server/src/api/` and register it in `router.ts`
4. Rebuild: `cd packages/server && pnpm build && cd ../mcp-bridge && pnpm build`

### Agent Workspace Structure

Each agent workspace at `agents/<name>/` contains:

```
agents/architect/
|-- .mcp.json / .codex/config.toml
|-- CLAUDE.md / AGENTS.md
`-- .crew/
    |-- context.json
    |-- current-project -> /.../data/projects/<slug>
    `-- current-workplace -> /.../data/projects/<slug>/workplaces/<slug>
```

The runtime keeps the agent's own workspace as the default `cwd`. Current project/workplace access is exposed through `.crew/*` pointers and `CLAUDE_CREW_*` environment variables.

### Tmux Monitor (`src/tmux-monitor.ts`)

A background scanner that runs every 2 seconds, monitoring all `crew-*` tmux sessions.

**What it does:**
1. Lists all tmux sessions matching `crew-*`
2. Captures the last 80 lines of each pane
3. Detects agent state from pane content:
   - `approval_pending`: contains "Do you want to proceed?" (tool_use) or "Enter to confirm" + "MCP server" (mcp_setup)
   - `busy`: last lines contain "Esc to interrupt" or "Running"
   - `idle`: default state when none of the above match
   - `no_session`: agent has no tmux session
4. Parses tool approval prompts to extract: tool server, tool name, parameters, description, numbered options
5. Broadcasts state changes and approval events via WebSocket
6. When an agent transitions from `idle` to `busy`, marks its recent pending mentions as `'read'`
7. **Auto-cycle**: Every 30s, checks agent context usage. If above 80%, triggers session restart (save worklog -> kill tmux -> re-wake). Upserts a system message in chat (one per agent, updated in-place via `message:update`). 5-minute cooldown per agent. Skips agents in `approval_pending` state.

**Approval response handling:**
- `tool_use` prompts: sends the number key directly via `tmux send-keys` (e.g., "1" for Yes)
- `mcp_setup` prompts: navigates with Down arrow keys to the option, then sends Enter

### WebSocket Events

| Event | Data | Description |
|-------|------|-------------|
| `message:new` | Message object | New chat message |
| `agent:status` | `{name, status, role?}` | Agent online/offline/removed |
| `agent:tmux_state` | `{name, tmuxState}` | Agent tmux state change (idle/busy/approval_pending/no_session) |
| `approval:pending` | ToolApproval object | New tool approval prompt detected |
| `approval:resolved` | `{agentName, approvalId}` | Approval resolved (responded or disappeared) |
| `message:update` | Message object | Existing message content updated (e.g. auto-cycle status upsert) |
| `message:status` | `{messageId, agentName, status}` | Delivery status update (sent/delivered/read) |
| `agent:config` | `{name, model?, effort?}` | Agent model/effort config changed |
| `channel:created/updated/deleted` | Channel object | Channel changes |
| `file:updated` | - | Shared file changed |

### Database Migrations

The schema initialization in `src/db/schema.ts` includes migration logic. When the server starts with an existing database:
- Checks if `messages` table has `channel_id` column, adds it if missing
- Checks if `pending_mentions` table has `delivery_status` column, adds it if missing
- Checks if `channels` table has `type` column, adds it if missing (defaults to "public")
- Checks if `channels` table has `members` column, adds it if missing (defaults to NULL)
- Checks if `channels`, `memory_entries`, and `project_agents` have the newer project/workplace scope columns
- Rebuilds `shared_files` into the scoped schema if it is still using the legacy `path`-only layout
- Creates the `workplaces` table if it does not exist
- Creates all tables if they don't exist
- Seeds the default "General" channel

### Tech Stack Summary

| Component | Technology | Why |
|-----------|------------|-----|
| Server | Express 5 + TypeScript | Mature HTTP framework, Express 5 for modern async |
| Database | SQLite (better-sqlite3) | Zero config, WAL mode for concurrent reads, single file |
| Real-time | ws (WebSocket) | Lightweight, native Node.js WebSocket |
| MCP | @modelcontextprotocol/sdk | Official MCP SDK for Claude Code integration |
| Validation | zod | Runtime type validation for MCP tool inputs |
| Web UI | Vanilla TypeScript + esbuild | No framework overhead, ~14KB bundle |
| Native App | Swift 6 + AppKit + WebKit | True macOS native, no Electron/Tauri dependency |
| Embeddings | Ollama + nomic-embed-text | Local 768-dim vector embeddings, ~500MB RAM, graceful degradation |
| Agent Mgmt | tmux | Programmatic terminal control, background sessions |
| Build | pnpm workspace + Swift PM | Monorepo with efficient dependency management |

---

## Project Management System

Claude Crew supports multi-project workspace management, allowing agents to be assigned to different projects with isolated contexts and shared standards.

### Layered Context Architecture

Project context is delivered to agents through a four-layer system:

| Layer | Source | Scope | Mutability |
|-------|--------|-------|------------|
| Layer 0 | Global `~/.claude/CLAUDE.md` | All agents, all projects | User-managed |
| Layer 1 | Agent `agents/<name>/CLAUDE.md` / `AGENTS.md` | Single agent, all projects | Never modified by project switch |
| Layer 2 | `--append-system-prompt` | Single agent, single project | Dynamic, generated from project context |
| Layer 3 | `.crew/context.json` + `.crew/current-*` | Single agent, single active assignment | Dynamic filesystem pointers |

Layer 2 context is generated by the `get_project_context` MCP tool (or `GET /projects/:id/context` API). It includes the project description, tech stack, active shared standards, current team members, canonical project root, and workplace guidance. Layer 3 gives the runtime stable filesystem entry points without changing the agent's default `cwd`: `.crew/current-project`, `.crew/current-workplace`, and `.crew/context.json`.

### Memory Isolation

Memory and shared files now use explicit scope routing:

- `global`: team-wide shared context
- `project`: canonical assets, specs, durable decisions, long-lived reference memory
- `workplace`: derived artifacts, uploads, generated outputs, revisions, temporary analysis

When APIs receive a `project_id`, reads aggregate the project plus all of its workplaces. New writes resolve to project or workplace based on content intent rather than blindly reusing `project_id`.

### Cross-Project Memory Sharing

When knowledge from one project is relevant to another, memory entries can be copied between projects using `POST /projects/:id/memory/share`. This creates new entries in the target project while preserving the originals.

### Project Lifecycle

Projects follow a defined lifecycle with state transitions:

```
active -> paused -> active    (reversible pause/resume)
active -> archived            (soft archive, data preserved)
paused -> archived            (can archive from paused state)
```

- **Active**: Agents are working, context is generated, and canonical vs derived writes are routed separately.
- **Paused**: Agents remain assigned but work is suspended. The `paused_at` timestamp is recorded.
- **Archived**: Project is complete or abandoned. The `archived_at` timestamp is recorded. Archived projects and their memories remain queryable but are excluded from active context generation.

### Dashboard UI

The web interface includes a view switcher (Chat / Dashboard) in the top navigation. The Dashboard view provides:

- **Project list**: All projects with status indicators, agent counts, and quick actions (pause/resume/archive).
- **Project detail**: Full project information, tech stack, assigned agents with roles, workplace list, and aggregate memory stats.
- **Create project**: Form for creating new projects with name, description, tech stack, and initial configuration.
- **Agent assignment**: Add or remove agents from projects, set their roles and assignment type (dedicated or shared), and switch their active workplace.

---

## PEAK System (Human-AI Decision Escalation)

PEAK (Point of Escalation for Augmented Knowledge) is a structured system for agents to escalate critical decisions to the human operator, ensuring human judgment is applied at the moments where it matters most.

### Philosophy

AI agents excel at continuous, systematic work -- executing tasks, following patterns, and maintaining consistency. Humans excel at discontinuous judgment -- making calls at critical decision points where experience, values, and broader context matter. These critical moments are called "peaks."

Rather than requiring constant human oversight or giving agents full autonomy, the PEAK system creates a targeted feedback loop: agents work autonomously on routine tasks and escalate only when they encounter genuine decision points.

### Three Phases

#### Phase 1: Detection

An agent identifies a peak when it encounters one of four trigger types:

| Type | Description | Example |
|------|-------------|---------|
| `irreversibility` | Action that cannot be easily undone | Deleting a database table, publishing to production |
| `multiple_paths` | Multiple viable approaches with different trade-offs | Choosing between REST and GraphQL for a new API |
| `info_asymmetry` | Agent lacks information that the human likely has | Business priority questions, stakeholder preferences |
| `drift_check` | Periodic check that work aligns with human intent | After completing a major milestone |

The agent calls `escalate_peak` with context, options (each with pros and cons), an optional recommendation (agent lean), a default option for timeout, and a timeout duration (30-1800 seconds, default 300).

#### Phase 2: Presentation

The peak appears in the Web UI as a Peak Card with a purple accent theme. The card displays:

- The agent name and peak type
- Situation context
- Options presented as cards with pros and cons for each
- The agent's recommendation (if provided)
- A countdown timer showing time remaining before auto-decision
- Three action buttons: **Choose** (select an option), **Let Agent Decide** (defer to the agent's default), **Let Me Think** (extend timeout by 10 minutes)

The agent can still poll for the decision using `check_peak_decision` with the peak ID, but this is now a fallback path rather than the primary resume mechanism.

#### Phase 3: Settlement

When the human makes a decision (or the timeout expires), three things happen:

1. **Resume**: The decision is sent back to the escalating agent as a direct system message, and a persistent channel message/pending mention is also created as a fallback delivery path.
2. **Persist**: The decision is written to project-scoped memory as a permanent `decision` entry, making it available for future reference.
3. **Propagate**: The SOP engine's `extractPatternFromPeaks()` function is triggered, which clusters similar past decisions and proposes shared standards when a pattern emerges.

### Timeout Handling

If the human does not respond within the specified `timeout_seconds`:

- The `default_option` (specified by the agent at escalation time) is automatically chosen.
- The peak status changes to `expired` after timeout settlement.
- The decision is still persisted to memory and triggers pattern extraction, just as a human decision would.
- The agent can detect this via `check_peak_decision` and proceed accordingly.

### Feedback Loop

The PEAK system is designed to become less intrusive over time:

- **Early stage**: Many peaks are escalated as agents lack context about human preferences. Frequent decisions accumulate into team memory and eventually into shared standards.
- **Mature stage**: Few peaks are escalated. Agents reference past decisions and established standards for routine trade-offs, only escalating genuinely novel situations.

This progression happens naturally through the combination of scoped memory persistence and SOP auto-evolution (see next section).

---

## SOP Auto-Evolution (Standards & Reflections)

The SOP (Standard Operating Procedures) auto-evolution system allows shared coding standards to evolve organically based on agent experience and human decisions, rather than requiring manual maintenance.

### Reflection Workflow

After completing a task, an agent calls `reflect_on_task` with:

- A summary of what was done
- Lessons learned (structured as category/description/evidence)
- Proposed updates to shared standards (add/modify/remove with rationale and confidence)

The server auto-reviews proposed updates and may apply them without human intervention if they meet the auto-apply criteria.

### Auto-Apply Criteria

A proposed standard update is automatically applied when ALL of the following conditions are met:

1. **High confidence**: The proposing agent's confidence score is >= 0.8.
2. **Add-only action**: The proposal adds new content rather than modifying or removing existing standards.
3. **No contradiction**: The proposed text does not contradict existing standards (detected via keyword negation pairs).
4. **Within budget**: The total standards content after applying the update remains within the 4000 character budget.
5. **Multi-agent consensus**: At least 2 different agents have submitted similar proposals (matching category and overlapping keywords).

If any condition is not met, the reflection is stored with status "pending" for human review via `PUT /reflections/:id/review`.

### Pattern Extraction from Peak Decisions

The `extractPatternFromPeaks()` function in the SOP engine analyzes settled peaks to identify recurring decision patterns:

1. Clusters peaks by type and context similarity.
2. When a cluster reaches size >= 3, it proposes a new shared standard capturing the pattern.
3. The proposed standard still goes through the same auto-apply criteria, including the multi-agent consensus gate. Repeated peaks alone do not bypass those checks.

This creates a direct pipeline from human decisions to codified team standards.

### Standards Budget

To prevent standards from growing unboundedly and consuming excessive agent context, a hard budget of **4000 characters** is enforced on total active standards content:

- `GET /standards/budget` returns current usage (used characters / total budget).
- Creating or updating a standard that would exceed the budget is rejected.
- When the budget is approached, the SOP engine triggers **auto-consolidation**: merging related standards, removing redundancies, and archiving low-priority standards to reclaim space.

### Version History and Rollback

Every change to a shared standard is recorded in the `standards_history` table with:

- The version number (auto-incrementing per standard)
- The full content at that version
- A change summary describing what was modified
- References to the source reflection IDs that triggered the change
- Who applied the change (agent name, "auto", or human reviewer name)

Standards can be rolled back to any previous version via `POST /standards/:id/rollback` with the target version number.

### Contradiction Detection

The SOP engine detects contradictions between proposed and existing standards using keyword negation pairs. For example, if an existing standard says "always use semicolons" and a proposal says "never use semicolons," the negation pair (always/never) triggers a contradiction flag. Contradicting proposals are never auto-applied and require explicit human review.

---

## Troubleshooting

### Server won't start

Check `/tmp/crew-server.log` or `data/server.log` for error output. Common issues:
- Port 3140 already in use: `lsof -i :3140` to find the process, or set `CREW_PORT=3141`
- Node.js not found: ensure `node --version` works, or set `NODE_PATH=/path/to/node`
- Server script missing: run `crew build` to compile TypeScript

### Agent not connecting

- Ensure the server is running: `crew status`
- Check that agent workspace exists: `ls agents/<name>/.mcp.json` or `ls agents/<name>/.codex/config.toml`
- For Claude agents, verify the tmux session is running: `tmux list-sessions | grep crew-`
- For Claude agents, attach to the terminal to see errors: `crew attach <name>`
- For Codex agents, inspect server logs and the agent's `.crew/context.json` for the active runtime context

### "Claude Code cannot be launched inside another Claude Code session"

This happens when the `CLAUDECODE` environment variable is set. The `crew wake` command automatically unsets it. If you're launching manually:
```bash
unset CLAUDECODE && cd agents/<name> && claude
```

### Agent tmux session exits immediately

- Claude Code CLI (`claude`) might not be in PATH within tmux. The `crew wake` command uses the full path automatically.
- Check: `which claude` and verify the path exists

### Codex agent fails to wake

- Verify the Codex CLI is installed and in PATH
- Check the agent workspace for `.codex/config.toml`
- Inspect `data/server.log` for `Codex app-server` startup or websocket errors

### Agent receives messages but doesn't reply in group chat

- The agent's `CLAUDE.md` or `AGENTS.md` instructs it to use `send_to_chat`. If the runtime has lost context, it may not follow this instruction.
- The agent might be waiting for tool use approval. Check the chat UI for approval cards, or attach to see: `crew attach <name>`
- To auto-approve MCP tools, add allowed tools to the agent's `.claude/settings.local.json`:
  ```json
  {"permissions": {"allow": ["mcp__claude-crew__send_to_chat"]}, "enableAllProjectMcpServers": true}
  ```

### Agent shows "no terminal" but is online

- The MCP bridge or provider runtime may still be sending heartbeats after the visible terminal/runtime went away.
- Fix: Delete the agent from the UI (stops provider runtime and helper processes) and recreate it.
- Or manually: `pgrep -f "mcp-bridge.*<name>" | xargs kill`

### Messages sent from UI don't appear

- Check WebSocket connection: status bar should show "Connected"
- Verify server is running: `curl http://127.0.0.1:3140/api/status`
- Check browser/app console for JavaScript errors

### App window is blank

- Server may not have started in time. Press Cmd+R to reload.
- Verify `packages/web-ui/dist/bundle.js` exists (run `crew build` if not)

### Import shows no sessions

- Claude Code stores conversations in `~/.claude/projects/*/`. If no `.jsonl` files exist there, there is nothing to import.

### Agent shows offline but tmux session is running

- Heartbeat timeout is 60 seconds. If the MCP bridge crashed inside the Claude Code session, the agent will be marked offline.
- Check the tmux session: `crew attach <name>` to see if Claude Code is still running.
- Restart the agent: `crew kill <name> && crew wake <name>`
