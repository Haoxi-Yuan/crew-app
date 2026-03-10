#!/bin/bash
# Claude Crew - System Management Script
# Usage: ./crew-manage.sh {start|stop|restart|status|build|wake|kill-agents|stop-all}

set -e

SCRIPT_PATH="$(cd "$(dirname "$0")" && pwd)"
CREW_DIR="$SCRIPT_PATH"
PORT="${CREW_PORT:-3140}"
SERVER_DIST="$CREW_DIR/packages/server/dist/index.js"
LOG_FILE="$CREW_DIR/data/server.log"

# --- Node.js detection ---
find_node() {
    local node_bin
    node_bin="$(which node 2>/dev/null || echo "")"
    if [ -n "$node_bin" ]; then
        echo "$node_bin"
        return
    fi
    for candidate in \
        "$HOME/.nvm/versions/node/"*/bin/node \
        /opt/homebrew/bin/node \
        /usr/local/bin/node; do
        if [ -x "$candidate" ]; then
            echo "$candidate"
            return
        fi
    done
    echo ""
}

NODE_BIN="$(find_node)"

# --- Helpers ---
# Get server PID by matching the actual node process, not any random port listener
get_server_pid() {
    lsof -ti :"$PORT" 2>/dev/null | while read -r pid; do
        if ps -p "$pid" -o command= 2>/dev/null | grep -q "node.*server/dist"; then
            echo "$pid"
            return
        fi
    done
}

is_server_running() {
    local pid
    pid="$(get_server_pid)"
    [ -n "$pid" ]
}

# Wait for port to be free, with timeout
wait_port_free() {
    local retries=0
    while [ $retries -lt 10 ]; do
        if ! is_server_running; then
            return 0
        fi
        sleep 0.5
        retries=$((retries + 1))
    done
    return 1
}

# --- Build ---
build_server() {
    if [ -z "$NODE_BIN" ]; then
        echo "[error] Node.js not found. Install it or set NODE_PATH."
        exit 1
    fi

    echo "[build] Building all packages..."
    cd "$CREW_DIR" && pnpm -r build 2>&1
    echo "[build] Done."
}

# --- Start ---
do_start() {
    if is_server_running; then
        local pid
        pid="$(get_server_pid)"
        echo "[start] Server already running (PID: $pid, port: $PORT)"
        return 0
    fi

    if [ -z "$NODE_BIN" ]; then
        echo "[error] Node.js not found."
        exit 1
    fi

    if [ ! -f "$SERVER_DIST" ]; then
        echo "[start] Server not built. Building first..."
        build_server
    fi

    mkdir -p "$CREW_DIR/data/shared"
    echo "[start] Starting server on port $PORT..."
    CREW_PORT="$PORT" nohup "$NODE_BIN" "$SERVER_DIST" >> "$LOG_FILE" 2>&1 &
    local new_pid=$!

    # Wait for server to be ready
    local retries=0
    while [ $retries -lt 10 ]; do
        if curl -s "http://127.0.0.1:$PORT/api/status" > /dev/null 2>&1; then
            echo "[start] Server started (PID: $new_pid, port: $PORT)"
            echo "[start] Web UI: http://127.0.0.1:$PORT"
            return 0
        fi
        sleep 1
        retries=$((retries + 1))
    done

    echo "[warn] Server process started (PID: $new_pid) but health check not responding yet."
    echo "[warn] Check log: $LOG_FILE"
}

# --- Stop ---
do_stop() {
    local pid
    pid="$(get_server_pid)"

    if [ -z "$pid" ]; then
        echo "[stop] Server not running on port $PORT."
        return 0
    fi

    echo "[stop] Stopping server (PID: $pid)..."
    kill "$pid" 2>/dev/null

    # Wait for process to exit
    local retries=0
    while [ $retries -lt 5 ]; do
        if ! kill -0 "$pid" 2>/dev/null; then
            echo "[stop] Server stopped."
            return 0
        fi
        sleep 1
        retries=$((retries + 1))
    done

    # Force kill if still running
    echo "[stop] Force killing server (PID: $pid)..."
    kill -9 "$pid" 2>/dev/null || true
    echo "[stop] Server force stopped."
}

# --- Restart ---
do_restart() {
    echo "[restart] Restarting server..."
    do_stop
    wait_port_free || echo "[warn] Port $PORT may still be in use"
    do_start
}

# --- Status ---
do_status() {
    local pid
    pid="$(get_server_pid)"

    if [ -z "$pid" ]; then
        echo "[status] Server: not running"
    else
        echo "[status] Server: running (PID: $pid, port: $PORT)"
    fi

    # Count tmux agent sessions
    local agent_count
    agent_count=$(tmux list-sessions -F '#{session_name}' 2>/dev/null | grep -c '^crew-' || echo "0")
    echo "[status] Active agents: $agent_count"

    if [ "$agent_count" -gt 0 ]; then
        tmux list-sessions -F '#{session_name}' 2>/dev/null | grep '^crew-' | while read -r session; do
            local agent_name="${session#crew-}"
            echo "  - $agent_name"
        done
    fi

    # Server API status
    if [ -n "$pid" ]; then
        echo ""
        curl -s "http://127.0.0.1:$PORT/api/status" 2>/dev/null | python3 -m json.tool 2>/dev/null || echo "[status] API not responding"
    fi
}

# --- Wake all agents ---
do_wake() {
    if ! is_server_running; then
        echo "[wake] Server not running. Starting first..."
        do_start
    fi
    echo "[wake] Waking all agents..."
    curl -s -X POST "http://127.0.0.1:$PORT/api/wake-all" | python3 -m json.tool 2>/dev/null || echo "[wake] Failed to wake agents"
}

# --- Kill all agents ---
do_kill_agents() {
    echo "[kill] Stopping all agent sessions..."
    tmux list-sessions -F '#{session_name}' 2>/dev/null | grep '^crew-' | while read -r session; do
        tmux kill-session -t "$session" 2>/dev/null
        echo "  Killed: $session"
    done
    echo "[kill] All agent sessions stopped."
}

# --- Stop everything ---
do_stop_all() {
    do_kill_agents
    do_stop
    echo "[stop-all] Everything stopped."
}

# --- Main ---
case "${1:-}" in
    start)
        do_start
        ;;
    stop)
        do_stop
        ;;
    restart)
        do_restart
        ;;
    status)
        do_status
        ;;
    build)
        build_server
        ;;
    wake)
        do_wake
        ;;
    kill-agents)
        do_kill_agents
        ;;
    stop-all)
        do_stop_all
        ;;
    *)
        echo "Claude Crew - System Management"
        echo ""
        echo "Usage: $0 <command>"
        echo ""
        echo "Commands:"
        echo "  start        Start the server"
        echo "  stop         Stop the server"
        echo "  restart      Restart the server"
        echo "  status       Show server and agent status"
        echo "  build        Build all packages"
        echo "  wake         Start all agent tmux sessions"
        echo "  kill-agents  Stop all agent tmux sessions"
        echo "  stop-all     Stop server and all agents"
        echo ""
        echo "Environment:"
        echo "  CREW_PORT    Server port (default: 3140)"
        echo ""
        ;;
esac
