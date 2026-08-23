#!/usr/bin/env bash
# typecheck.sh — tsc over this app, reporting only OUR errors.
#
# The Electrobun SDK is projected into .hutch/devkit as real .ts sources rather
# than as declaration files, so `strict` type-checks it too and it does not
# compile clean. Its diagnostics are noise we cannot fix and that regenerate on
# every `electrobun prepare`; ours are the ones that must fail the build.
set -uo pipefail
cd "$(dirname "$0")/.."

out=$(./node_modules/.bin/tsc --noEmit --pretty false 2>&1 || true)
mine=$(printf '%s\n' "$out" | grep -E '^(src/|electrobun\.config\.ts)' || true)

if [ -n "$mine" ]; then
  printf '%s\n' "$mine"
  exit 1
fi
echo "typecheck ok"
