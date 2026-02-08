#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -lt 1 ]]; then
  echo "Usage: bash scripts/release/audit-release-artifact.sh <artifact.zip> [more.zip ...]" >&2
  exit 1
fi

forbidden_patterns=(
  "^\\.claude/"
  "^\\.github/"
  "^\\.variant-icons/"
  "^AGENTSMD/"
  "^AGENTS\\.md$"
  "^docs/"
  "^tests/"
  "^scripts/"
  "^worktrees/"
  "^release/"
  "^\\.env$"
  "^\\.env\\."
  "^\\.gitignore$"
  "^mycodebase\\.py$"
  "^package\\.json$"
  "^popup\\.html$"
  "^popup\\.js$"
  "^selectors\\.js$"
)

for zip_path in "$@"; do
  if [[ ! -f "$zip_path" ]]; then
    echo "[audit-release] Artifact not found: $zip_path" >&2
    exit 1
  fi

  entries="$(zipinfo -1 "$zip_path")"
  violations=()
  while IFS= read -r entry; do
    [[ -z "$entry" ]] && continue
    for pattern in "${forbidden_patterns[@]}"; do
      if [[ "$entry" =~ $pattern ]]; then
        violations+=("$entry")
        break
      fi
    done
  done <<< "$entries"

  if [[ "${#violations[@]}" -gt 0 ]]; then
    echo "[audit-release] Forbidden files found in artifact: $zip_path" >&2
    for item in "${violations[@]}"; do
      echo "  - $item" >&2
    done
    exit 1
  fi

  echo "[audit-release] OK: $zip_path"
done
