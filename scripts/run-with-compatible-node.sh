#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

node_supports_server() {
  local candidate="$1"
  [ -x "$candidate" ] || return 1
  (
    cd "$REPO_ROOT/packages/server" &&
    "$candidate" -e "require('better-sqlite3')" >/dev/null 2>&1
  )
}

find_node() {
  local candidate=""

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

  candidate="$(command -v node 2>/dev/null || true)"
  if [ -n "$candidate" ] && [ -x "$candidate" ]; then
    echo "$candidate"
  fi
}

NODE_BIN="$(find_node)"
if [ -z "$NODE_BIN" ]; then
  echo "Error: no compatible Node.js binary found for Claude Crew." >&2
  exit 1
fi

exec "$NODE_BIN" "$@"
