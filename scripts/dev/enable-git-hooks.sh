#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
hooks_dir="$repo_root/.githooks"

if [[ ! -d "$hooks_dir" ]]; then
  echo "[enable-git-hooks] Hooks directory not found: $hooks_dir" >&2
  exit 1
fi

git -C "$repo_root" config core.hooksPath .githooks
echo "[enable-git-hooks] Enabled repo hooks path: .githooks"
