#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
builder="$repo_root/scripts/dev/build-extension-variant.sh"

if [[ ! -x "$builder" ]]; then
  echo "[ensure-variant-icons] Missing builder script: $builder" >&2
  exit 1
fi

branch_name="$(git -C "$repo_root" rev-parse --abbrev-ref HEAD)"

(
  cd "$repo_root"
  bash "$builder" --icons-only "$branch_name"
)
