# Claude Crew - Multi-Agent Group Chat System

A local native macOS application that enables multiple Claude Code agents to communicate through a shared group chat, while each agent maintains its own private terminal session.

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

---

## Overview

### Problem

A single Claude Code agent has a limited context window. Complex projects require multiple agents to collaborate, but there is no built-in mechanism for them to communicate with each other.

### Solution

Claude Crew simulates a **team management** model:

| Concept | Analogy | Implementation |
|---------|---------|----------------|
| Private terminal | 1-on-1 meeting with an employee | Each agent's tmux session (Claude Code CLI) |
| Group chat window | Company Slack channel | Native macOS app (this project) |
| @mention | Calling on someone in a meeting | Message auto-injected into agent's terminal |
| Chat history | Meeting minutes available to all | All agents can query on demand |
| Shared files | Company shared drive | Accessed only when needed |
| Individual memory | Employee's personal notes | Each agent's private `~/.claude/` memory |

### Key Design Principles

- **Direct injection**: When you `@mention` an agent in the group chat, the message is automatically typed into that agent's Claude Code terminal via tmux. No polling needed.
- **Auto reply**: Agents are instructed (via CLAUDE.md) to use `send_to_chat` to post results back to the group chat.
- **No context waste**: Chat content is queryable, not auto-pushed. Agents only receive messages directed at them.
- **Private by default**: Each agent's individual memory and terminal session remain private.
- **Native experience**: The app runs as a native macOS window (Swift + WKWebView), not in a browser.

---

## Architecture

```
+---------------------------------------------------+
|            ClaudeCrew.app (Swift/AppKit)           |
|            WKWebView -> http://127.0.0.1:3140      |
+------------------------+--------------------------+
                         | WebSocket (real-time UI)
+------------------------+--------------------------+
|           Node.js Central Server                   |
|           (Express 5 + SQLite + WebSocket)         |
|                                                    |
|  HTTP API    WebSocket    Heartbeat    Forwarding   |
|  /api/*      /ws          Monitor     (tmux)       |
+---+---------------+----------+----+---------------+
    | HTTP           |          |    | tmux send-keys
+---+---+     +------+------+  | +--+-------------+
| Bridge |     | Bridge      |  | | tmux session   |
| (MCP   |     | (MCP stdio) |  | | crew-architect |
| stdio) |     |             |  | +--+-------------+
+---+---+     +------+------+  |    | Claude Code
    | MCP stdio       | MCP    |    | (interactive)
+---+---+     +------+------+  |    |
| Claude |     | Claude      |  | +--+-------------+
| Code   |     | Code        |  | | tmux session   |
| (tmux) |     | (tmux)      |  | | crew-coder     |
+--------+     +-------------+  | +-+--------------+
                                 |   | Claude Code
                                 +---+
```

### Communication Flow

1. User types `@coder build a timer app` in the group chat UI
2. Central Server stores the message, parses `@coder`, creates a pending mention with `delivery_status = 'sent'`
3. Server runs `tmux send-keys -t crew-coder` to inject the full message into the coder's Claude Code terminal. On success, updates `delivery_status` to `'delivered'` and pushes a `message:status` WebSocket event (UI shows double checkmark)
4. Claude Code receives the message as direct input (as if the user typed it)
5. If Claude Code needs tool approval, the **Tmux Monitor** detects the prompt, broadcasts an `approval:pending` event, and an interactive approval card appears in the chat UI
6. Claude Code processes the request, then calls `send_to_chat` (MCP tool) to post results back to the group chat
7. The Tmux Monitor detects the agent transitions from `idle` to `busy`, marking recent mentions as `'read'` (UI shows blue double checkmark)
8. The response appears in the app UI via WebSocket

### Why tmux?

Each agent runs in a named tmux session (`crew-<name>`). This enables:

- **Programmatic input injection**: `tmux send-keys` types text into a running Claude Code instance
- **Background operation**: Agents run without visible terminal windows
- **Easy monitoring**: `crew attach <name>` to watch any agent work in real-time
- **Reliable process management**: `crew kill <name>` to stop agents cleanly
- **State detection**: The Tmux Monitor scans pane content every 2s to determine agent state (idle/busy/approval_pending)

### Why MCP Stdio Bridge?

Claude Code spawns MCP servers as child processes via stdio. Each agent's workspace contains `.mcp.json` which configures its bridge. The bridge:

- Registers the agent with the central server on startup
- Maintains heartbeat (30s interval)
- Provides 15 MCP tools for the agent to communicate, manage state, and access persistent memory
- Forwards all tool calls to the central server via HTTP

---

## Project Structure

```
~/Projects/claude-crew/
|
|-- agents/                          # Agent workspaces (one per agent)
|   |-- architect/
|   |   |-- .mcp.json                # Project-scoped MCP config for this agent
|   |   `-- CLAUDE.md                # Agent identity and instructions
|   `-- coder/
|       |-- .mcp.json
|       `-- CLAUDE.md
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
|   |       |-- mentions.ts          # @mention parsing + notification queue
|   |       |-- forward.ts           # tmux send-keys forwarding + delivery status tracking
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
|   |       |   `-- memory.ts        # Memory CRUD, search, consolidation, stats API
|   |       |-- memory-engine.ts     # Core decay algorithms (ACT-R activation, SM-2 stability, lifecycle)
|   |       `-- ws/
|   |           `-- handler.ts       # WebSocket: broadcast events to UI
|   |
|   |-- mcp-bridge/                  # MCP stdio bridge (one per agent)
|   |   |-- package.json
|   |   |-- tsconfig.json
|   |   `-- src/
|   |       |-- index.ts             # MCP server: 15 tools, lifecycle management
|   |       `-- client.ts            # HTTP client forwarding to central server
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
|           `-- types.ts             # TypeScript interfaces (Agent, Message, ToolApproval)
|
|-- bin/
|   `-- ollama                       # Ollama CLI binary (local install, gitignored)
|
|-- data/                            # Runtime data (gitignored)
|   |-- claude-crew.db               # SQLite database (auto-created)
|   |-- shared/                      # Shared files directory
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
- **Tmux Monitor**: scans agent tmux sessions every 2s for state changes and tool approval prompts
- **Message forwarding**: auto-injects @mentioned messages into agent tmux sessions via `tmux send-keys`, tracks delivery status
- **Tool approval management**: detects approval prompts, renders interactive cards in UI, sends key responses to tmux
- Serves the web UI static files (HTML/CSS/JS)
- Full agent lifecycle: create workspace, start tmux session, kill processes, delete workspace

**Tech stack:** Express 5, ws, better-sqlite3, zod, TypeScript

**Key files:**
- `src/index.ts` - Entry point. Creates HTTP server, WebSocket, starts heartbeat monitor and tmux monitor.
- `src/config.ts` - All configuration constants (port 3140, paths, timeouts, Ollama URL/model).
- `src/mentions.ts` - Parses `@agent-name` from message content. Expands `@all` to all online agents.
- `src/forward.ts` - Forwards messages to agent tmux sessions via `tmux send-keys`. Updates `delivery_status` to `'delivered'` on success and broadcasts `message:status` events.
- `src/tmux-monitor.ts` - Scans all `crew-*` tmux sessions every 2s. Detects agent state (idle/busy/approval_pending/no_session), parses tool approval prompts (both tool_use and mcp_setup types), sends approval key responses, and marks mentions as read when agents start processing.
- `src/db/schema.ts` - SQLite schema initialization with migration support (e.g. adding `channel_id`, `delivery_status` columns).
- `src/api/router.ts` - Routes `/api/*` requests. Includes wake, workspaces, mentions, approvals, memory, and status endpoints.
- `src/api/memory.ts` - Memory API: CRUD, hybrid keyword+vector search, consolidation, stats, reindex.
- `src/memory-engine.ts` - Core decay algorithms: ACT-R activation, SM-2 stability, lifecycle rules (promote/archive).
- `src/embedding.ts` - Ollama embedding client: vector generation, cosine similarity, graceful degradation when Ollama is unavailable.
- `src/api/agents.ts` - Full agent lifecycle: register (MCP bridge), create (frontend with workspace + tmux), heartbeat, edit, delete (kills processes + removes workspace).
- `src/api/approvals.ts` - Tool approval REST API: list pending, get by agent, respond with key.
- `src/api/channels.ts` - Channel CRUD (public/dm/group) with member management and WebSocket broadcast on changes. DM creation is idempotent.
- `src/api/messages.ts` - Message storage with auto-forwarding and delivery status tracking. For DM/group channels, auto-forwards to all channel members without requiring @mentions. GET joins `pending_mentions` to return per-agent delivery status.
- `src/ws/handler.ts` - WebSocket broadcast. Events: `message:new`, `agent:status`, `agent:tmux_state`, `approval:pending`, `approval:resolved`, `message:status`, `channel:*`, `file:updated`.

### 2. MCP Stdio Bridge (`packages/mcp-bridge`)

A lightweight process spawned by each Claude Code instance. Translates MCP tool calls into HTTP requests to the central server.

**Lifecycle:**
1. Claude Code reads `.mcp.json` from agent workspace, spawns bridge process
2. Bridge registers agent via `POST /api/agents/register`
3. Bridge starts heartbeat (every 30s)
4. Claude Code calls MCP tools -> bridge forwards via HTTP -> returns results
5. On SIGTERM/SIGINT: bridge deregisters agent and exits

**Tech stack:** @modelcontextprotocol/sdk, Node.js fetch (built-in), TypeScript

### 3. Web UI (`packages/web-ui`)

The chat interface rendered inside the native app's WKWebView. Pure TypeScript + CSS, bundled with esbuild (~18KB).

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
- **Real-time updates**: WebSocket for messages, agent status, tmux state, approvals, delivery status.
- **@mention autocomplete**: Type `@` to trigger dropdown with agent list and `@all`.
- **Agent avatars**: Color-coded avatars with initials, status dot indicator (online/offline/busy/warning). Click avatar to open DM.
- **Agent management**: Create (with workspace + tmux), edit role, delete (full cleanup) from UI. Wake individual or all agents.
- **Tool approval cards**: Interactive approval prompts rendered inline in chat. Supports both tool_use (numbered options) and mcp_setup (Enter to confirm) prompts. Click to approve/reject without attaching to tmux.
- **Message delivery status**: Social-app style read receipts for @mentioned messages. Single check (sent), double check gray (delivered), double check blue (read).
- **Agent state labels**: Shows real-time tmux state next to agent names (ready/working/needs approval/no terminal) with pulse animation for warnings.
- **Shared file management**: Create new files, upload files (.md/.json/.txt), edit content, delete.
- **Import history**: Browse and import past Claude Code conversations.
- **Dark theme** matching terminal aesthetics.

### 4. Agent Workspaces (`agents/`)

Each agent has a dedicated workspace directory containing:

- **`.mcp.json`** - Project-scoped MCP configuration. When Claude Code starts in this directory, it reads this file and spawns the MCP bridge with the correct agent name and role.
- **`CLAUDE.md`** - Instructions for the agent. Tells it how to communicate via MCP tools, and crucially: to always use `send_to_chat` to reply so responses appear in the group chat.

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
| created_at | INTEGER | Unix timestamp ms |
| updated_at | INTEGER | Unix timestamp ms |

A default "General" channel (type: public) is seeded on first run.

**Channel types:**
- **public**: Standard broadcast channel visible to everyone. Messages forwarded only to @mentioned agents.
- **dm**: Private channel between user and one agent. Created as `dm-{agentName}`. All messages auto-forwarded to the agent member without needing @mentions.
- **group**: Custom group of agents. All messages auto-forwarded to all member agents without needing @mentions.

### agents

Tracks registered Claude Code agents and their online status.

| Column | Type | Description |
|--------|------|-------------|
| id | TEXT PK | UUID |
| name | TEXT UNIQUE | Agent display name (e.g. "architect") |
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

Metadata for files in the `data/shared/` directory.

| Column | Type | Description |
|--------|------|-------------|
| path | TEXT PK | Relative path within shared/ |
| created_by | TEXT | Agent name or "user" |
| description | TEXT | Brief description |
| updated_at | INTEGER | Unix timestamp ms |
| size_bytes | INTEGER | File size |

---

## MCP Tools Reference

These are the tools available to each Claude Code agent through the MCP bridge.

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

Read a file from the shared team directory.

- **Input:** `path` (string) - Relative path within shared/
- **Output:** File content, author, description, timestamp

### write_shared_file

Write or update a file in the shared team directory.

- **Input:** `path` (string), `content` (string), `description` (string, optional)
- **Output:** Success confirmation

### get_shared_file_meta

Get metadata of a shared file without loading its full content. Use this to check if a file has been updated before reading it fully, saving context.

- **Input:** `path` (string) - Relative path within shared/
- **Output:** Single line: `path | size | author | updated_at | description`

### list_shared_files

List all files in the shared team directory.

- **Input:** none
- **Output:** Array of {path, description, size, author}

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

- **Input:** `query` (string), `category` (string, optional), `include_weak` (boolean, optional), `limit` (number, optional)
- **Output:** List of matching memories with heading, category, strength, and ID
- **Note:** Only use when starting a new topic or needing past context. Returns summaries by default; use `memory_read` to expand.

### memory_read

Read full content of a memory entry by ID. Reinforces the memory (retrieval practice effect).

- **Input:** `id` (string)
- **Output:** Full content with category, status, access count, and strength

### memory_write

Record a new memory with category and importance scoring. Duplicate content auto-detected.

- **Input:** `category` (enum: contact/preference/decision/project/pattern/feedback/daily), `heading` (string), `content` (string), `importance` (number 1-5, optional), `emotional_weight` (number 1.0-2.0, optional)
- **Output:** Memory ID, status, initial strength

### memory_status

View memory health dashboard.

- **Input:** none
- **Output:** Total count, breakdown by status/category, average strength, recently accessed entries

---

## REST API Reference

Base URL: `http://127.0.0.1:3140/api`

### Agents

| Method | Path | Body | Description |
|--------|------|------|-------------|
| POST | /agents/register | `{name, role?}` | Register or reconnect an agent (called by MCP bridge) |
| POST | /agents/create | `{name, role?, wake?}` | Create agent workspace (.mcp.json + CLAUDE.md), register in DB, optionally start tmux session |
| POST | /agents/heartbeat | `{name}` | Send heartbeat (keep online) |
| POST | /agents/deregister | `{name}` | Mark agent offline |
| GET | /agents | - | List all agents (includes `tmuxState`: idle/busy/approval_pending/no_session) |
| PUT | /agents/:name | `{role?, status?}` | Edit agent role/status |
| PUT | /agents/:name/config | `{model?, effort?, requested_by, restart?}` | Set agent model/effort config. Only `requested_by: "author"` is accepted (403 otherwise). Model: sonnet/opus. Effort: medium/high/max. If `restart: true`, kills and re-wakes the agent with new config. |
| GET | /agents/:name/worklog | - | Read agent's saved worklog (task state, decisions, files) |
| PUT | /agents/:name/worklog | `{worklog}` | Save agent's worklog (max 100KB). Stored as JSON file in data/worklogs/ |
| DELETE | /agents/:name | `?workspace=false` | Full cleanup: kill tmux session, kill MCP bridge processes, delete workspace, remove from DB |

### Tool Approvals

| Method | Path | Body | Description |
|--------|------|------|-------------|
| GET | /approvals | - | List all pending tool approvals |
| GET | /approvals/:agentName | - | Get pending approval for a specific agent |
| POST | /approvals/:agentName/respond | `{key}` | Send approval response. Key: `"1"` (Yes), `"2"` (Don't ask again), `"3"` (No), `"Escape"` |

### Channels

| Method | Path | Body/Params | Description |
|--------|------|-------------|-------------|
| GET | /channels | `?status=active` | List channels (optionally filter by status), sorted by type then created_at |
| POST | /channels | `{name, description?, type?, members?}` | Create a new channel (type: "public" or "group", members: string[] for group) |
| POST | /channels/dm/:agentName | - | Create or open a DM channel with the named agent (idempotent) |
| POST | /channels/:id/members | `{name}` | Add an agent member to a group channel |
| DELETE | /channels/:id/members/:name | - | Remove an agent member from a group channel |
| PUT | /channels/:id | `{name?, description?, status?}` | Update/archive a channel |
| DELETE | /channels/:id | - | Delete channel and its messages (cannot delete "general") |

### Messages

| Method | Path | Params/Body | Description |
|--------|------|-------------|-------------|
| POST | /messages | `{sender_type, sender_name, content, channel_id?}` | Send a message. Auto-forwards to mentioned agents' tmux sessions. For DM/group channels, auto-forwards to all channel members (no @mention needed). Updates delivery_status on success. |
| GET | /messages | `?channel_id=general&limit=50&before_id=N&after_id=N` | Fetch messages. `after_id` returns only messages newer than the given ID (ASC order). `before_id` for pagination (DESC, then reversed). Includes `delivery_status` per agent for messages with @mentions. |

### Mentions

| Method | Path | Description |
|--------|------|-------------|
| GET | /mentions/:agentName | Get pending mentions for agent |
| POST | /mentions/:id/ack | Acknowledge a mention |

### Shared Files

| Method | Path | Body | Description |
|--------|------|------|-------------|
| GET | /shared-files | - | List all shared files |
| GET | /shared-files/:path | - | Read a shared file |
| PUT | /shared-files/:path | `{content, created_by, description?}` | Write/update file (max 1MB) |
| DELETE | /shared-files/:path | - | Delete a shared file |

### Wake / Workspaces

| Method | Path | Body | Description |
|--------|------|------|-------------|
| POST | /wake | `{name}` | Start agent in tmux session |
| POST | /wake-all | - | Start all agents in tmux sessions |
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
| POST | /memory/entries | `{agent_name?, category, heading, content, importance?, emotional_weight?}` | Create memory entry (409 on duplicate content) |
| GET | /memory/entries/:id | - | Read entry + record access (reinforces memory) |
| PUT | /memory/entries/:id | `{heading?, content?, importance?, emotional_weight?, category?, status?}` | Update entry fields |
| DELETE | /memory/entries/:id | - | Delete entry |
| GET | /memory/search | `?q=...&agent_name=author&category=...&include_weak=true&limit=5&summary_only=true` | Decay-weighted keyword search |
| POST | /memory/consolidate | `{agent_name?}` | Trigger consolidation (recalculate, promote, archive) |
| GET | /memory/stats | `?agent_name=author` | Memory health dashboard (counts, categories, avg strength) |

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

Or via the web UI: click the **+** button next to "AGENTS" in the sidebar. Enter name and role, check "Start immediately" to auto-launch. The server creates the workspace (`agents/<name>/` with `.mcp.json` and `CLAUDE.md`) and optionally starts the tmux session.

### 4. Wake Agents

```bash
# Wake all agents
crew wake all

# Or wake individually
crew wake coder
```

This starts Claude Code in a tmux session for each agent. The MCP bridge auto-registers the agent with the server.

### 5. Use the Group Chat

Open the app or browser at `http://127.0.0.1:3140`:

```
@coder build a countdown timer CLI tool in Node.js
```

The message is automatically injected into the coder's Claude Code terminal. The coder processes it, builds the tool, then uses `send_to_chat` to post results back.

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
| `crew add <name> <role>` | Create agent workspace with MCP config |
| `crew remove <name>` | Remove agent (stop tmux, delete workspace, delete from DB) |
| `crew wake [name\|all]` | Start agent(s) in tmux session |
| `crew attach <name>` | Attach to agent's terminal (Ctrl+B D to detach) |
| `crew kill [name\|all]` | Stop agent(s) tmux sessions |
| `crew list` | List all registered agents and their status |
| `crew status` | Show server status (JSON) |

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
| POST | /memory/reindex | `{agent_name?}` | Batch-generate embeddings for entries missing them (requires Ollama) |
| GET | /memory/stats | `?agent_name=author` | Memory health dashboard |

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
|-- .mcp.json       # MCP config pointing to bridge with agent name
`-- CLAUDE.md       # Agent instructions (auto-respond via send_to_chat)
```

The `.mcp.json` uses absolute paths to the bridge script and node binary, configured by `crew add`.

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

## Troubleshooting

### Server won't start

Check `/tmp/crew-server.log` or `data/server.log` for error output. Common issues:
- Port 3140 already in use: `lsof -i :3140` to find the process, or set `CREW_PORT=3141`
- Node.js not found: ensure `node --version` works, or set `NODE_PATH=/path/to/node`
- Server script missing: run `crew build` to compile TypeScript

### Agent not connecting

- Ensure the server is running: `crew status`
- Check that agent workspace exists: `ls agents/<name>/.mcp.json`
- Verify tmux session is running: `tmux list-sessions | grep crew-`
- Attach to agent terminal to see errors: `crew attach <name>`

### "Claude Code cannot be launched inside another Claude Code session"

This happens when the `CLAUDECODE` environment variable is set. The `crew wake` command automatically unsets it. If you're launching manually:
```bash
unset CLAUDECODE && cd agents/<name> && claude
```

### Agent tmux session exits immediately

- Claude Code CLI (`claude`) might not be in PATH within tmux. The `crew wake` command uses the full path automatically.
- Check: `which claude` and verify the path exists

### Agent receives messages but doesn't reply in group chat

- The agent's `CLAUDE.md` instructs it to use `send_to_chat`. If the agent's Claude Code session has lost context, it may not follow this instruction.
- The agent might be waiting for tool use approval. Check the chat UI for approval cards, or attach to see: `crew attach <name>`
- To auto-approve MCP tools, add allowed tools to the agent's `.claude/settings.local.json`:
  ```json
  {"permissions": {"allow": ["mcp__claude-crew__send_to_chat"]}, "enableAllProjectMcpServers": true}
  ```

### Agent shows "no terminal" but is online

- The MCP bridge process may still be running and sending heartbeats after the tmux session was killed.
- Fix: Delete the agent from the UI (kills bridge processes) and recreate it.
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
