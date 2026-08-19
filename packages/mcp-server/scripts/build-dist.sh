#!/bin/bash
# Copyright (c) Meta Platforms, Inc. and affiliates.
#
# This source code is licensed under the MIT license found in the
# LICENSE file in the root directory of this source tree.
#
# @format
# @oncall memory_lab

# Builds the committed dist/ exactly the way it is meant to be built.
#
# The three steps below used to be applied by hand, and one of them is easy to
# get subtly wrong: prepending the @generated prologue to dist/index.js pushed
# its `#!/usr/bin/env node` off line 1, which makes the file a syntax error in
# an ES module and takes the published `memlab-mcp` bin with it. A shipped
# entry point that never runs is exactly the kind of defect a manual step
# produces, so the step is a script.
#
#   1. compile with the package tsconfig
#   2. drop *.map (not committed)
#   3. prepend @generated/@nolint, AFTER any shebang rather than above it

set -euo pipefail

PKG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_DIR="$(mktemp -d)"
trap 'rm -rf "$BUILD_DIR"' EXIT

cd "$PKG_DIR"

echo "Compiling to $BUILD_DIR ..."
# A separate tsbuildinfo: the committed one makes an incremental build think
# the (deleted) scratch output is still up to date and emit nothing.
npx tsc -p tsconfig.json --outDir "$BUILD_DIR" --tsBuildInfoFile "$BUILD_DIR/.tsbuildinfo"

echo "Removing source maps ..."
find "$BUILD_DIR" -name '*.map' -delete

echo "Prepending @generated prologue ..."
while IFS= read -r -d '' f; do
  head -n1 "$f" | grep -q '@generated' && continue
  if head -n1 "$f" | grep -q '^#!'; then
    # Shebang must stay on line 1 or node refuses the module.
    {
      head -n1 "$f"
      printf '/* @generated */\n/* @nolint */\n'
      tail -n +2 "$f"
    } >"$f.tmp"
  else
    {
      printf '/* @generated */\n/* @nolint */\n'
      cat "$f"
    } >"$f.tmp"
  fi
  mv "$f.tmp" "$f"
done < <(find "$BUILD_DIR" \( -name '*.js' -o -name '*.d.ts' \) -print0)

echo "Installing into dist/ ..."
rsync -a --include='*/' --include='*.js' --include='*.d.ts' --exclude='*' \
  "$BUILD_DIR/" "$PKG_DIR/dist/"

echo "Smoke-testing the published entry point ..."
if ! printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"build-dist","version":"1"}}}' |
  node "$PKG_DIR/bin/memlab-mcp.js" 2>/dev/null | head -n1 | grep -q '"serverInfo"'; then
  echo "ERROR: bin/memlab-mcp.js did not answer an initialize handshake." >&2
  echo "The built dist/ is broken; not a publishable artifact." >&2
  exit 1
fi

echo "dist/ rebuilt and the entry point answers a real handshake."
