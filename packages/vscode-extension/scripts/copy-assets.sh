#!/bin/bash
# Copy web-ui assets into the extension media directory.
# Native addons and server bundles are handled by build-vsix.sh and esbuild-server.mjs.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
EXT_DIR="$(dirname "$SCRIPT_DIR")"
WEB_UI_DIR="$EXT_DIR/../web-ui"
MEDIA_DIR="$EXT_DIR/media/web-ui"

echo "Copying web-ui assets to $MEDIA_DIR"
mkdir -p "$MEDIA_DIR/dist"
cp "$WEB_UI_DIR/index.html" "$MEDIA_DIR/index.html"
cp "$WEB_UI_DIR/styles.css" "$MEDIA_DIR/styles.css"
cp "$WEB_UI_DIR/dist/bundle.js" "$MEDIA_DIR/dist/bundle.js"

echo "Done."
