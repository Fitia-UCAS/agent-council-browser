#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
default_builder="$repo_root/scripts/dev/build-extension-variant.sh"

if [[ ! -x "$default_builder" ]]; then
  echo "[apply-branding] Missing builder script: $default_builder" >&2
  exit 1
fi

roots=()
while IFS= read -r line; do
  case "$line" in
    worktree\ *)
      worktree_path="${line#worktree }"
      if [[ -d "$worktree_path" ]]; then
        roots+=("$worktree_path")
      fi
      ;;
  esac
done < <(git -C "$repo_root" worktree list --porcelain)

if [[ "${#roots[@]}" -eq 0 ]]; then
  roots=("$repo_root")
fi

for root in "${roots[@]}"; do
  if [[ ! -f "$root/manifest.json" ]]; then
    continue
  fi

  if [[ -x "$root/scripts/dev/build-extension-variant.sh" ]]; then
    builder="$root/scripts/dev/build-extension-variant.sh"
  else
    builder="$default_builder"
  fi

  echo "[apply-branding] $root"
  (cd "$root" && bash "$builder" --in-place)
done
