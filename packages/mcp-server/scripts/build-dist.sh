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

# Resolve a compiler without going near the registry. `npx tsc` in a checkout
# that has no local typescript does not fail — it tries to *fetch* one, and in
# a network-restricted shell that surfaces as a wall of npm ENOTFOUND lines
# about `registry.npmjs.org/tsc`, which reads as a broken build rather than a
# missing dev dependency.
find_tsc() {
  if [ -n "${MEMLAB_TSC:-}" ]; then echo "$MEMLAB_TSC"; return; fi
  local d="$PKG_DIR"
  while [ "$d" != "/" ]; do
    [ -f "$d/node_modules/typescript/bin/tsc" ] && {
      echo "$d/node_modules/typescript/bin/tsc"; return; }
    d="$(dirname "$d")"
  done
  echo ""
}

TSC="$(find_tsc)"
if [ -z "$TSC" ]; then
  echo "No typescript found in any node_modules above $PKG_DIR." >&2
  echo "Install the dev dependencies (npm install) or point MEMLAB_TSC at a tsc." >&2
  exit 1
fi

echo "Compiling to $BUILD_DIR ..."
echo "  using $TSC"
# A separate tsbuildinfo: the committed one makes an incremental build think
# the (deleted) scratch output is still up to date and emit nothing.
node "$TSC" -p tsconfig.json --outDir "$BUILD_DIR" --tsBuildInfoFile "$BUILD_DIR/.tsbuildinfo"

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
HANDSHAKE_ERR="$(mktemp)"
trap 'rm -rf "$BUILD_DIR" "$HANDSHAKE_ERR"' EXIT
if ! printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"build-dist","version":"1"}}}' |
  node "$PKG_DIR/bin/memlab-mcp.js" 2>"$HANDSHAKE_ERR" | head -n1 | grep -q '"serverInfo"'; then
  # In an fbsource checkout node_modules/@memlab/core is a symlink to the
  # SIBLING SOURCE package, whose own runtime deps (fs-extra, ...) are not
  # installed — so the entry point cannot start from here no matter how good
  # dist/ is. Reporting that as "the built dist/ is broken" is a false alarm
  # every single time, and it trains people to ignore the check.
  #
  # Deliberately ANY missing module, not just fs-extra: the sibling source
  # package's uninstalled dependency set is not a fixed list, so naming one
  # would let the next one through as a false "dist/ is broken". The
  # `packages/core` conjunct is what keeps this from swallowing unrelated
  # failures — it requires the resolution to have failed inside that package.
  # (The previous pattern spelled this `'(fs-extra|[^'"'"']*)'`, an alternation
  # whose second branch already matched everything, so it read as specific
  # while behaving exactly like this one.)
  if grep -q "Cannot find module '" "$HANDSHAKE_ERR" &&
    grep -q "packages/core" "$HANDSHAKE_ERR"; then
    echo ""
    echo "NOTE: the handshake could not run FROM THIS CHECKOUT." >&2
    echo "  node_modules/@memlab/core here is a symlink to the sibling SOURCE" >&2
    echo "  package, whose runtime deps are not installed, so bin/memlab-mcp.js" >&2
    echo "  cannot start. This says nothing about dist/, which is already" >&2
    echo "  installed above." >&2
    echo "" >&2
    echo "  To verify for real, run the same handshake against the built dist/" >&2
    echo "  from a directory that HAS the deps (the plugin install dir):" >&2
    echo "    cp -r $PKG_DIR/dist \$HOME/.memlab-mcp/dist" >&2
    echo "    node \$HOME/.memlab-mcp/dist/index.js   # then send an initialize frame" >&2
    echo "" >&2
    echo "dist/ rebuilt; entry-point handshake SKIPPED (deps unavailable here)."
    exit 0
  fi
  echo "ERROR: bin/memlab-mcp.js did not answer an initialize handshake." >&2
  echo "The built dist/ is broken; not a publishable artifact." >&2
  echo "--- stderr from the attempt ---" >&2
  cat "$HANDSHAKE_ERR" >&2
  exit 1
fi

echo "dist/ rebuilt and the entry point answers a real handshake."
