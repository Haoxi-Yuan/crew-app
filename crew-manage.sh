#!/bin/bash
# Claude Crew - System Management Script
# Usage: ./crew-manage.sh {start|stop|restart|status|build|wake|wake-agent|status-agent|restart-agent|kill-agent|kill-agents|stop-all}

set -e

SCRIPT_PATH="$(cd "$(dirname "$0")" && pwd)"
CREW_DIR="$SCRIPT_PATH"
PORT="${CREW_PORT:-3140}"
SERVER_DIST="$CREW_DIR/packages/server/dist/index.js"
LOG_FILE="$CREW_DIR/data/server.log"
SERVER_SESSION="crew-server"

node_supports_server() {
    local candidate="$1"
    [ -x "$candidate" ] || return 1
    (
        cd "$CREW_DIR/packages/server" &&
        "$candidate" -e "require('better-sqlite3')" >/dev/null 2>&1
    )
}

# --- Node.js detection ---
find_node() {
    local candidate
    local node_bin=""

    if [ -n "${NODE_PATH:-}" ] && node_supports_server "${NODE_PATH}"; then
        echo "${NODE_PATH}"
        return
    fi
    if [ -n "${NVM_BIN:-}" ] && node_supports_server "${NVM_BIN}/node"; then
        echo "${NVM_BIN}/node"
        return
    fi
    for candidate in \
        "$HOME/.nvm/versions/node/"*/bin/node \
        /opt/homebrew/bin/node \
        /usr/local/bin/node \
        /usr/bin/node; do
        if node_supports_server "$candidate"; then
            echo "$candidate"
            return
        fi
    done
    node_bin="$(command -v node 2>/dev/null || echo "")"
    if [ -n "$node_bin" ] && [ -x "$node_bin" ]; then
        echo "$node_bin"
        return
    fi
    echo ""
}

NODE_BIN="$(find_node)"

# --- Helpers ---
get_server_pids() {
    pgrep -f "$SERVER_DIST" 2>/dev/null || true
}

get_server_pid() {
    get_server_pids | head -n 1
}

server_session_exists() {
    tmux has-session -t "$SERVER_SESSION" 2>/dev/null
}

build_server_command() {
    printf "cd '%s' && export CREW_PORT='%s' && exec '%s' '%s' >> '%s' 2>&1" \
        "$CREW_DIR" "$PORT" "$NODE_BIN" "$SERVER_DIST" "$LOG_FILE"
}

is_server_process_running() {
    local pid
    pid="$(get_server_pid)"
    [ -n "$pid" ]
}

is_server_api_ready() {
    curl -fsS --max-time 2 "http://127.0.0.1:$PORT/api/status" >/dev/null 2>&1
}

wait_for_server_api() {
    local retries=0
    while [ $retries -lt 10 ]; do
        if is_server_api_ready; then
            return 0
        fi
        sleep 1
        retries=$((retries + 1))
    done
    return 1
}

print_json() {
    local payload="$1"
    if [ -z "$payload" ]; then
        return 1
    fi
    printf '%s\n' "$payload" | python3 -m json.tool 2>/dev/null || printf '%s\n' "$payload"
}

validate_agent_restart_response() {
    local payload="$1"
    [ -n "$payload" ] || return 1
    "$NODE_BIN" -e '
const payload = JSON.parse(process.argv[1]);
if (!payload || payload.ok !== true) process.exit(1);
if (payload.provider === "claude") {
  if (!payload.verification || !payload.verification.panePid || !payload.verification.processStartedAt) {
    process.exit(2);
  }
}
' "$payload"
}

# Wait for port to be free, with timeout
wait_port_free() {
    local retries=0
    while [ $retries -lt 10 ]; do
        if ! lsof -ti :"$PORT" >/dev/null 2>&1; then
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
    if is_server_api_ready; then
        local pid
        pid="$(get_server_pid)"
        echo "[start] Server already running (PID: $pid, port: $PORT)"
        return 0
    fi

    local existing_pids
    existing_pids="$(get_server_pids)"
    if [ -n "$existing_pids" ]; then
        echo "[error] Server process exists but API is not healthy."
        echo "[error] Existing PID(s): $(printf '%s' "$existing_pids" | tr '\n' ' ' | sed 's/ $//')"
        echo "[error] Run '$0 stop' before starting a fresh server."
        return 1
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
    if server_session_exists; then
        echo "[error] Server tmux session already exists but API is not healthy."
        echo "[error] Run '$0 stop' before starting a fresh server."
        return 1
    fi
    local server_cmd
    server_cmd="$(build_server_command)"
    tmux new-session -d -s "$SERVER_SESSION" "$server_cmd"

    if wait_for_server_api; then
        local new_pid
        new_pid="$(get_server_pid)"
        echo "[start] Server started (PID: $new_pid, port: $PORT)"
        echo "[start] Web UI: http://127.0.0.1:$PORT"
        return 0
    fi

    echo "[error] Server process started but health check did not become ready."
    echo "[error] Check log: $LOG_FILE"
    return 1
}

# --- Stop ---
do_stop() {
    local pids
    pids="$(get_server_pids)"

    if ! server_session_exists && [ -z "$pids" ]; then
        echo "[stop] Server process not running."
        return 0
    fi

    if server_session_exists; then
        echo "[stop] Stopping server tmux session: $SERVER_SESSION..."
        tmux kill-session -t "$SERVER_SESSION" 2>/dev/null || true
    fi

    if [ -n "$pids" ]; then
        echo "[stop] Stopping server PID(s): $(printf '%s' "$pids" | tr '\n' ' ' | sed 's/ $//')..."
    fi
    while read -r pid; do
        [ -n "$pid" ] || continue
        kill "$pid" 2>/dev/null || true
    done <<EOF
$pids
EOF

    local retries=0
    while [ $retries -lt 5 ]; do
        if ! is_server_process_running; then
            echo "[stop] Server stopped."
            return 0
        fi
        sleep 1
        retries=$((retries + 1))
    done

    echo "[stop] Force killing remaining server PID(s)..."
    while read -r pid; do
        [ -n "$pid" ] || continue
        kill -9 "$pid" 2>/dev/null || true
    done <<EOF
$(get_server_pids)
EOF
    echo "[stop] Server force stopped."
}

# --- Restart ---
do_restart() {
    echo "[restart] Restarting server..."
    do_stop
    wait_port_free || {
        echo "[error] Port $PORT is still in use after stop."
        return 1
    }
    do_start
}

# --- Status ---
do_status() {
    local pid
    pid="$(get_server_pid)"

    if server_session_exists; then
        echo "[status] Server tmux: running ($SERVER_SESSION)"
    else
        echo "[status] Server tmux: not running"
    fi

    if [ -z "$pid" ]; then
        echo "[status] Server process: not running"
    else
        echo "[status] Server process: running (PID: $pid, port: $PORT)"
    fi

    if is_server_api_ready; then
        echo "[status] Server API: healthy"
    else
        echo "[status] Server API: unavailable"
    fi

    # Count tmux agent sessions
    local agent_count
    agent_count=$(tmux list-sessions -F '#{session_name}' 2>/dev/null | grep '^crew-' | grep -v "^${SERVER_SESSION}$" | grep -c . || true)
    agent_count="${agent_count:-0}"
    echo "[status] Active agents: $agent_count"

    if [ "$agent_count" -gt 0 ]; then
        tmux list-sessions -F '#{session_name}' 2>/dev/null | grep '^crew-' | grep -v "^${SERVER_SESSION}$" | while read -r session; do
            local agent_name="${session#crew-}"
            echo "  - $agent_name"
        done
    fi

    # Server API status
    if is_server_api_ready; then
        echo ""
        curl -fsS "http://127.0.0.1:$PORT/api/status" 2>/dev/null | python3 -m json.tool 2>/dev/null || echo "[status] API not responding"
    fi
}

# --- Wake all agents ---
do_wake() {
    if ! is_server_api_ready; then
        echo "[wake] Server not running. Starting first..."
        do_start || exit 1
    fi
    echo "[wake] Waking all agents..."
    curl -s -X POST "http://127.0.0.1:$PORT/api/wake-all" | python3 -m json.tool 2>/dev/null || echo "[wake] Failed to wake agents"
}

do_wake_agent() {
    local agent_name="$1"
    if [ -z "$agent_name" ]; then
        echo "[wake-agent] Usage: $0 wake-agent <agent-name>"
        exit 1
    fi
    if ! is_server_api_ready; then
        echo "[wake-agent] Server not running. Starting first..."
        do_start || exit 1
    fi
    echo "[wake-agent] Waking $agent_name..."
    curl -s -X POST "http://127.0.0.1:$PORT/api/wake" \
        -H "Content-Type: application/json" \
        -d "{\"name\":\"$agent_name\"}" | python3 -m json.tool 2>/dev/null || echo "[wake-agent] Failed to wake $agent_name"
}

do_status_agent() {
    local agent_name="$1"
    if [ -z "$agent_name" ]; then
        echo "[status-agent] Usage: $0 status-agent <agent-name>"
        exit 1
    fi
    if ! is_server_api_ready; then
        echo "[status-agent] Server not running on port $PORT."
        exit 1
    fi
    echo "[status-agent] Inspecting $agent_name..."
    curl -s "http://127.0.0.1:$PORT/api/agents/$agent_name/runtime-status" | python3 -m json.tool 2>/dev/null || echo "[status-agent] Failed to get status for $agent_name"
}

do_kill_agent() {
    local agent_name="$1"
    if [ -z "$agent_name" ]; then
        echo "[kill-agent] Usage: $0 kill-agent <agent-name>"
        exit 1
    fi
    if ! is_server_api_ready; then
        echo "[kill-agent] Server must be running to stop a specific agent."
        exit 1
    fi
    echo "[kill-agent] Stopping $agent_name..."
    curl -s -X POST "http://127.0.0.1:$PORT/api/agents/$agent_name/system-stop" | python3 -m json.tool 2>/dev/null || echo "[kill-agent] Failed to stop $agent_name"
}

do_restart_agent() {
    local agent_name="$1"
    if [ -z "$agent_name" ]; then
        echo "[restart-agent] Usage: $0 restart-agent <agent-name>"
        exit 1
    fi
    if ! is_server_api_ready; then
        echo "[restart-agent] Server not running. Starting first..."
        do_start || exit 1
    fi
    echo "[restart-agent] Restarting $agent_name..."
    local response=""
    response="$(curl -fsS -X POST "http://127.0.0.1:$PORT/api/agents/$agent_name/system-restart")" || {
        echo "[restart-agent] Failed to restart $agent_name"
        exit 1
    }
    if ! validate_agent_restart_response "$response"; then
        echo "[restart-agent] Restart verification failed for $agent_name"
        print_json "$response" || true
        exit 1
    fi
    print_json "$response"
}

# --- Kill all agents ---
do_kill_agents() {
    echo "[kill] Stopping all agent sessions..."
    tmux list-sessions -F '#{session_name}' 2>/dev/null | grep '^crew-' | grep -v "^${SERVER_SESSION}$" | while read -r session; do
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
    wake-agent)
        do_wake_agent "${2:-}"
        ;;
    status-agent)
        do_status_agent "${2:-}"
        ;;
    restart-agent)
        do_restart_agent "${2:-}"
        ;;
    kill-agent)
        do_kill_agent "${2:-}"
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
        echo "  wake-agent   Start one agent runtime"
        echo "  status-agent Show one agent runtime status"
        echo "  restart-agent Restart one agent runtime"
        echo "  kill-agent   Stop one agent runtime"
        echo "  kill-agents  Stop all agent tmux sessions"
        echo "  stop-all     Stop server and all agents"
        echo ""
        echo "Environment:"
        echo "  CREW_PORT    Server port (default: 3140)"
        echo ""
        ;;
esac
