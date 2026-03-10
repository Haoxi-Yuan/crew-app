#!/bin/bash
set -e

SCRIPT_PATH="$(readlink -f "$0" 2>/dev/null || readlink "$0" 2>/dev/null || echo "$0")"
CREW_DIR="$(cd "$(dirname "$SCRIPT_PATH")/.." && pwd)"
SERVER_PID_FILE="$CREW_DIR/data/.server.pid"
OLLAMA_PID_FILE="$CREW_DIR/data/.ollama.pid"
AGENTS_DIR="$CREW_DIR/agents"
PORT="${CREW_PORT:-3140}"
OLLAMA_BIN="$CREW_DIR/bin/ollama"
export OLLAMA_MODELS="$CREW_DIR/data/ollama-models"
NODE_PATH="${NODE_PATH:-$(which node 2>/dev/null || echo "")}"

if [ -z "$NODE_PATH" ]; then
    for candidate in \
        "$HOME/.nvm/versions/node/"*/bin/node \
        /opt/homebrew/bin/node \
        /usr/local/bin/node; do
        if [ -x "$candidate" ]; then
            NODE_PATH="$candidate"
            break
        fi
    done
fi

ensure_node() {
    if [ -z "$NODE_PATH" ]; then
        echo "Error: Node.js not found. Install it or set NODE_PATH." >&2
        exit 1
    fi
}

ensure_ollama() {
    if [ ! -x "$OLLAMA_BIN" ]; then
        return 0  # Ollama not installed, skip silently
    fi
    if curl -s "http://127.0.0.1:11434/api/tags" > /dev/null 2>&1; then
        return 0  # Already running
    fi
    echo "Starting Ollama embedding server..."
    "$OLLAMA_BIN" serve > /dev/null 2>&1 &
    echo $! > "$OLLAMA_PID_FILE"
    sleep 2
}

ensure_server() {
    if ! curl -s "http://127.0.0.1:$PORT/api/status" > /dev/null 2>&1; then
        echo "Server not running. Starting..."
        ensure_node
        ensure_ollama
        mkdir -p "$CREW_DIR/data/shared"
        CREW_PORT="$PORT" "$NODE_PATH" "$CREW_DIR/packages/server/dist/index.js" &
        echo $! > "$SERVER_PID_FILE"
        sleep 2
    fi
}

# Create agent workspace with .mcp.json and CLAUDE.md
setup_agent_workspace() {
    local name="$1"
    local role="$2"
    local agent_dir="$AGENTS_DIR/$name"
    local bridge_path="$CREW_DIR/packages/mcp-bridge/dist/index.js"

    mkdir -p "$agent_dir"

    # Write .mcp.json (project-scoped MCP config)
    cat > "$agent_dir/.mcp.json" << MCPEOF
{
  "mcpServers": {
    "claude-crew": {
      "command": "$NODE_PATH",
      "args": ["$bridge_path", "$name", "$role"]
    }
  }
}
MCPEOF

    # Write CLAUDE.md with agent identity and instructions
    cat > "$agent_dir/CLAUDE.md" << MDEOF
# Agent: $name
Role: $role

You are "$name" in the Claude Crew multi-agent team.

Messages from the group chat will be sent to you directly in the format:
[sender in group chat]: message content

## How to respond
When you receive a group chat message, do the work requested, then call \`send_to_chat\` to post your response/results back to the group chat so the team can see it.

## Available tools
- \`send_to_chat\` - post a message to the group chat (ALWAYS use this to reply)
- \`read_chat\` - read recent group chat messages for context
- \`check_mentions\` - check for @mentions directed at you
- \`list_agents\` - see who else is online
- \`read_shared_file\` / \`write_shared_file\` / \`list_shared_files\` - shared team files

## Rules
- ALWAYS reply via \`send_to_chat\` so the team sees your response
- Keep chat messages concise, put detailed output in shared files if needed
- You can work on any files on this machine using standard tools
MDEOF

    echo "Workspace created: $agent_dir"
}

# Start agent in tmux session
wake_agent() {
    local name="$1"
    local agent_dir="$AGENTS_DIR/$name"
    local session="crew-${name}"
    local claude_path
    claude_path="$(which claude 2>/dev/null || echo "")"

    if [ ! -d "$agent_dir" ]; then
        echo "Error: Agent '$name' workspace not found. Run: crew add $name <role>"
        return 1
    fi

    if [ -z "$claude_path" ]; then
        # Try common locations
        for candidate in \
            "$HOME/.nvm/versions/node/"*/bin/claude \
            /opt/homebrew/bin/claude \
            /usr/local/bin/claude; do
            if [ -x "$candidate" ]; then
                claude_path="$candidate"
                break
            fi
        done
    fi

    if [ -z "$claude_path" ]; then
        echo "Error: Claude Code CLI not found."
        return 1
    fi

    # Check if session already exists
    if tmux has-session -t "$session" 2>/dev/null; then
        echo "Agent '$name' already running (tmux session: $session)"
        return 0
    fi

    # Start new tmux session with claude using full path
    # Unset CLAUDECODE to avoid nested session detection
    tmux new-session -d -s "$session" "unset CLAUDECODE && cd '$agent_dir' && '$claude_path'"
    echo "Agent '$name' started (tmux session: $session)"
    echo "  View: crew attach $name"
}

case "${1:-}" in
    start)
        ensure_node
        if [ -f "$SERVER_PID_FILE" ] && kill -0 "$(cat "$SERVER_PID_FILE")" 2>/dev/null; then
            echo "Server already running (PID: $(cat "$SERVER_PID_FILE"))"
            exit 0
        fi
        ensure_ollama
        mkdir -p "$CREW_DIR/data/shared"
        CREW_PORT="$PORT" "$NODE_PATH" "$CREW_DIR/packages/server/dist/index.js" &
        echo $! > "$SERVER_PID_FILE"
        echo "Server started (PID: $!, port: $PORT)"
        echo "Web UI: http://127.0.0.1:$PORT"
        ;;

    stop)
        if [ -f "$SERVER_PID_FILE" ]; then
            PID="$(cat "$SERVER_PID_FILE")"
            if kill -0 "$PID" 2>/dev/null; then
                kill "$PID"
                echo "Server stopped (PID: $PID)"
            else
                echo "Server not running (stale PID file)"
            fi
            rm -f "$SERVER_PID_FILE"
        else
            echo "No server PID file found"
        fi
        # Stop Ollama if we started it
        if [ -f "$OLLAMA_PID_FILE" ]; then
            OPID="$(cat "$OLLAMA_PID_FILE")"
            if kill -0 "$OPID" 2>/dev/null; then
                kill "$OPID"
                echo "Ollama stopped (PID: $OPID)"
            fi
            rm -f "$OLLAMA_PID_FILE"
        fi
        ;;

    app)
        export CREW_PROJECT_ROOT="$CREW_DIR"
        SWIFT_BUILD="$CREW_DIR/app/.build/release/ClaudeCrew"
        if [ ! -f "$SWIFT_BUILD" ]; then
            SWIFT_BUILD="$CREW_DIR/app/.build/debug/ClaudeCrew"
        fi
        if [ ! -f "$SWIFT_BUILD" ]; then
            echo "Native app not built. Run: cd $CREW_DIR/app && swift build -c release"
            exit 1
        fi
        "$SWIFT_BUILD" &
        echo "Claude Crew app launched"
        ;;

    add)
        AGENT_NAME="${2:-}"
        AGENT_ROLE="${3:-}"
        if [ -z "$AGENT_NAME" ]; then
            echo "Usage: crew add <agent-name> <role>"
            echo "Example: crew add architect 'API designer'"
            exit 1
        fi
        ensure_node
        BRIDGE_PATH="$CREW_DIR/packages/mcp-bridge/dist/index.js"
        if [ ! -f "$BRIDGE_PATH" ]; then
            echo "Error: MCP bridge not built. Run 'crew build' first."
            exit 1
        fi
        setup_agent_workspace "$AGENT_NAME" "$AGENT_ROLE"
        # Also register with server if running
        curl -s -X POST "http://127.0.0.1:$PORT/api/agents/register" \
            -H "Content-Type: application/json" \
            --data-raw "{\"name\":\"$AGENT_NAME\",\"role\":\"$AGENT_ROLE\"}" > /dev/null 2>&1 || true
        echo "Agent '$AGENT_NAME' added."
        echo "Run: crew wake $AGENT_NAME"
        ;;

    remove)
        AGENT_NAME="${2:-}"
        if [ -z "$AGENT_NAME" ]; then
            echo "Usage: crew remove <agent-name>"
            exit 1
        fi
        # Kill tmux session if running
        tmux kill-session -t "crew-${AGENT_NAME}" 2>/dev/null && echo "Stopped tmux session: crew-${AGENT_NAME}"
        # Delete workspace
        if [ -d "$AGENTS_DIR/$AGENT_NAME" ]; then
            rm -rf "$AGENTS_DIR/$AGENT_NAME"
            echo "Workspace removed: $AGENTS_DIR/$AGENT_NAME"
        fi
        # Delete from server if running
        curl -s -X DELETE "http://127.0.0.1:$PORT/api/agents/$AGENT_NAME" > /dev/null 2>&1 || true
        echo "Agent '$AGENT_NAME' removed."
        ;;

    wake)
        AGENT_NAME="${2:-}"
        ensure_server
        if [ -z "$AGENT_NAME" ] || [ "$AGENT_NAME" = "all" ]; then
            # Wake all agents
            if [ ! -d "$AGENTS_DIR" ] || [ -z "$(ls -A "$AGENTS_DIR" 2>/dev/null)" ]; then
                echo "No agents found. Add agents first: crew add <name> <role>"
                exit 1
            fi
            for agent_path in "$AGENTS_DIR"/*/; do
                agent="$(basename "$agent_path")"
                wake_agent "$agent"
                sleep 1
            done
            echo "All agents waking up."
        else
            wake_agent "$AGENT_NAME"
        fi
        ;;

    attach)
        AGENT_NAME="${2:-}"
        if [ -z "$AGENT_NAME" ]; then
            echo "Usage: crew attach <agent-name>"
            exit 1
        fi
        SESSION="crew-${AGENT_NAME}"
        if tmux has-session -t "$SESSION" 2>/dev/null; then
            tmux attach-session -t "$SESSION"
        else
            echo "Agent '$AGENT_NAME' is not running. Use: crew wake $AGENT_NAME"
        fi
        ;;

    kill)
        AGENT_NAME="${2:-}"
        if [ -z "$AGENT_NAME" ] || [ "$AGENT_NAME" = "all" ]; then
            # Kill all crew tmux sessions
            tmux list-sessions -F '#{session_name}' 2>/dev/null | grep '^crew-' | while read -r s; do
                tmux kill-session -t "$s"
                echo "Killed session: $s"
            done
        else
            SESSION="crew-${AGENT_NAME}"
            tmux kill-session -t "$SESSION" 2>/dev/null && echo "Killed: $SESSION" || echo "Session not found: $SESSION"
        fi
        ;;

    list)
        if [ -d "$AGENTS_DIR" ] && [ -n "$(ls -A "$AGENTS_DIR" 2>/dev/null)" ]; then
            echo "Registered agents:"
            for agent_path in "$AGENTS_DIR"/*/; do
                agent="$(basename "$agent_path")"
                tmux_status="stopped"
                tmux has-session -t "crew-${agent}" 2>/dev/null && tmux_status="running"
                role=$(python3 -c "import json;d=json.load(open('$agent_path/.mcp.json'));print(d['mcpServers']['claude-crew']['args'][-1])" 2>/dev/null || echo "")
                echo "  $agent [$tmux_status] - $role"
            done
        else
            echo "No agents registered. Use: crew add <name> <role>"
        fi
        ;;

    status)
        curl -s "http://127.0.0.1:$PORT/api/status" 2>/dev/null | python3 -m json.tool 2>/dev/null || echo "Server not reachable at port $PORT"
        ;;

    build)
        ensure_node
        echo "=== Installing dependencies ==="
        cd "$CREW_DIR"
        if [ ! -d "node_modules" ]; then
            pnpm install
        else
            pnpm install --prefer-offline --frozen-lockfile 2>/dev/null || pnpm install
        fi

        echo "=== Building server ==="
        cd "$CREW_DIR/packages/server" && pnpm build

        echo "=== Building MCP bridge ==="
        cd "$CREW_DIR/packages/mcp-bridge" && pnpm build

        echo "=== Building web UI ==="
        cd "$CREW_DIR/packages/web-ui" && mkdir -p dist && pnpm build

        echo "=== Building Swift app ==="
        cd "$CREW_DIR/app" && swift build -c release

        echo "=== Done ==="
        mkdir -p "$CREW_DIR/data/shared"
        echo "Run: crew app     (launch native app)"
        echo "  or crew start   (server only)"
        ;;

    *)
        echo "Claude Crew - Multi-Agent Group Chat"
        echo ""
        echo "Usage: crew <command> [args]"
        echo ""
        echo "Commands:"
        echo "  start               Start the central server"
        echo "  stop                Stop the central server"
        echo "  app                 Launch the native macOS app"
        echo "  add <name> <role>   Create agent workspace"
        echo "  remove <name>       Remove agent and workspace"
        echo "  wake [name|all]     Start agent(s) in tmux session"
        echo "  attach <name>       Attach to agent's terminal (Ctrl+B D to detach)"
        echo "  kill [name|all]     Stop agent(s)"
        echo "  list                List all registered agents"
        echo "  status              Show server status"
        echo "  build               Build all components"
        echo ""
        echo "Quick start:"
        echo "  crew build"
        echo "  crew start"
        echo "  crew add architect 'API designer'"
        echo "  crew add coder 'Backend developer'"
        echo "  crew wake all"
        echo ""
        ;;
esac
