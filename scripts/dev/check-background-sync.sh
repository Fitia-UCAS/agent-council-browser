#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
source_file="$repo_root/background.js"
mirror_file="$repo_root/src/background/background.main.js"

if [[ ! -f "$source_file" ]]; then
  echo "[background-sync] missing source file: $source_file" >&2
  exit 1
fi

if [[ ! -f "$mirror_file" ]]; then
  echo "[background-sync] missing mirror file: $mirror_file" >&2
  exit 1
fi

if cmp -s "$source_file" "$mirror_file"; then
  echo "[background-sync] OK: background.js and src/background/background.main.js are in sync"
  exit 0
fi

echo "[background-sync] ERROR: background.js and src/background/background.main.js differ" >&2
exit 1
