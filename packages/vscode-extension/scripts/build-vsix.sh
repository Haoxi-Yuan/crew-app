#!/bin/bash
# Build platform-specific VSIX packages for Claude Crew VS Code extension.
#
# Usage:
#   ./scripts/build-vsix.sh                          # Build for current platform
#   ./scripts/build-vsix.sh --target darwin-arm64     # Build for specific platform
#   ./scripts/build-vsix.sh --all                     # Build for all supported platforms
#
# Prerequisites: pnpm, node, npx

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
EXT_DIR="$(dirname "$SCRIPT_DIR")"
MONO_ROOT="$(cd "$EXT_DIR/../.." && pwd)"
SERVER_DIST="$EXT_DIR/server-dist"

ALL_TARGETS=(
  darwin-arm64
  darwin-x64
  linux-x64
  linux-arm64
  win32-x64
)

# Parse arguments
TARGETS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --target)
      TARGETS+=("$2")
      shift 2
      ;;
    --all)
      TARGETS=("${ALL_TARGETS[@]}")
      shift
      ;;
    *)
      echo "Unknown argument: $1"
      echo "Usage: $0 [--target <platform-arch>] [--all]"
      exit 1
      ;;
  esac
done

# Default to current platform if no target specified
if [ ${#TARGETS[@]} -eq 0 ]; then
  CURRENT_PLATFORM="$(node -e "console.log(process.platform)")"
  CURRENT_ARCH="$(node -e "console.log(process.arch)")"
  TARGETS=("${CURRENT_PLATFORM}-${CURRENT_ARCH}")
fi

echo "=== Building targets: ${TARGETS[*]} ==="

# Step 1: Build server and mcp-bridge TypeScript
echo ""
echo "--- Building server (tsc) ---"
(cd "$MONO_ROOT" && pnpm --filter @claude-crew/server build)

echo ""
echo "--- Building mcp-bridge (tsc) ---"
(cd "$MONO_ROOT" && pnpm --filter @claude-crew/mcp-bridge build)

# Step 2: Build web-ui
echo ""
echo "--- Building web-ui ---"
(cd "$MONO_ROOT" && pnpm --filter @claude-crew/web-ui build)

# Step 3: Bundle server + mcp-bridge with esbuild
echo ""
echo "--- Bundling server + mcp-bridge (esbuild) ---"
(cd "$EXT_DIR" && node esbuild-server.mjs)

# Step 4: Copy web-ui assets (no native deps)
echo ""
echo "--- Copying web-ui assets ---"
MEDIA_DIR="$EXT_DIR/media/web-ui"
mkdir -p "$MEDIA_DIR/dist"
cp "$MONO_ROOT/packages/web-ui/index.html" "$MEDIA_DIR/index.html"
cp "$MONO_ROOT/packages/web-ui/styles.css" "$MEDIA_DIR/styles.css"
cp "$MONO_ROOT/packages/web-ui/dist/bundle.js" "$MEDIA_DIR/dist/bundle.js"

# Step 5: Build extension JS
echo ""
echo "--- Building extension (esbuild) ---"
(cd "$EXT_DIR" && node esbuild.config.mjs)

# Step 6: For each target, download the correct native addon and package
SQLITE_VERSION="11.10.0"
NATIVE_DIR="$SERVER_DIST/native"

# Map VS Code targets to Node/prebuild platform-arch pairs
map_target() {
  local target="$1"
  local platform="${target%%-*}"
  local arch="${target##*-}"
  # VS Code uses "win32" which matches Node's process.platform
  echo "$platform $arch"
}

download_native_addon() {
  local platform="$1"
  local arch="$2"
  local dest="$3"

  echo "  Downloading better-sqlite3 v${SQLITE_VERSION} for ${platform}-${arch}..."
  rm -rf "$dest"
  mkdir -p "$dest"

  local tmpdir
  tmpdir="$(mktemp -d)"
  local sqlite_pkg="$MONO_ROOT/node_modules/.pnpm/better-sqlite3@${SQLITE_VERSION}/node_modules/better-sqlite3"

  if [ "$platform" = "$(node -e "console.log(process.platform)")" ] && \
     [ "$arch" = "$(node -e "console.log(process.arch)")" ]; then
    # Current platform: just copy the existing build
    echo "  Using local build (current platform)"
    mkdir -p "$dest/build/Release"
    cp "$sqlite_pkg/build/Release/better_sqlite3.node" "$dest/build/Release/better_sqlite3.node"
  else
    # Cross-platform: use prebuild-install to download
    (
      cd "$tmpdir"
      cp "$sqlite_pkg/package.json" package.json
      mkdir -p build/Release

      npx prebuild-install \
        --platform "$platform" \
        --arch "$arch" \
        --runtime napi \
        --tag-prefix v \
        --target 7 \
        -d 2>&1 || {
          echo "  ERROR: Failed to download prebuild for ${platform}-${arch}"
          echo "  Falling back to compile (requires native toolchain for target)"
          rm -rf "$tmpdir"
          return 1
        }
    )
    mkdir -p "$dest/build/Release"
    cp "$tmpdir/build/Release/better_sqlite3.node" "$dest/build/Release/better_sqlite3.node"
  fi

  # Copy JS runtime files (platform-independent)
  cp -R "$sqlite_pkg/lib" "$dest/lib"
  cp "$sqlite_pkg/package.json" "$dest/package.json"

  rm -rf "$tmpdir"
}

for target in "${TARGETS[@]}"; do
  echo ""
  echo "=== Packaging for $target ==="

  read -r platform arch <<< "$(map_target "$target")"

  # Download/copy native addon for this target
  download_native_addon "$platform" "$arch" "$NATIVE_DIR/better-sqlite3" || continue

  # Package VSIX
  echo "  Creating VSIX..."
  (cd "$EXT_DIR" && npx --yes @vscode/vsce package --no-dependencies --target "$target" 2>&1)

  echo "  Done: $(ls -1 "$EXT_DIR"/*"${target}"*.vsix 2>/dev/null || echo 'VSIX not found')"
done

echo ""
echo "=== Build complete ==="
ls -lh "$EXT_DIR"/*.vsix 2>/dev/null
