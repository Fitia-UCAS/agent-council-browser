#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
allowlist_file="$repo_root/scripts/release/release-allowlist.txt"
input_path="${1:-$repo_root/.dist/release}"

if [[ ! -f "$allowlist_file" ]]; then
  echo "[verify-release] Missing allowlist: $allowlist_file" >&2
  exit 1
fi

allowlist=()
while IFS= read -r line; do
  [[ -z "$line" ]] && continue
  [[ "$line" =~ ^[[:space:]]*# ]] && continue
  allowlist+=("$line")
done < "$allowlist_file"

if [[ "${#allowlist[@]}" -eq 0 ]]; then
  echo "[verify-release] Allowlist is empty." >&2
  exit 1
fi

collect_entries() {
  local path="$1"
  if [[ -d "$path" ]]; then
    (cd "$path" && find . -type f | sed 's#^\./##' | sort)
    return
  fi
  if [[ -f "$path" && "$path" == *.zip ]]; then
    unzip -Z1 "$path" | sed '/\/$/d' | sed 's#^\./##' | sort
    return
  fi
  echo "[verify-release] Unsupported artifact path: $path" >&2
  exit 1
}

is_allowed() {
  local entry="$1"
  local rule
  for rule in "${allowlist[@]}"; do
    if [[ "$rule" == */ ]]; then
      [[ "$entry" == "$rule"* ]] && return 0
    else
      [[ "$entry" == "$rule" ]] && return 0
    fi
  done
  return 1
}

entries="$(collect_entries "$input_path")"
if [[ -z "$entries" ]]; then
  echo "[verify-release] No files found in artifact: $input_path" >&2
  exit 1
fi

extras=()
while IFS= read -r entry; do
  [[ -z "$entry" ]] && continue
  if ! is_allowed "$entry"; then
    extras+=("$entry")
  fi
done <<< "$entries"

if [[ "${#extras[@]}" -gt 0 ]]; then
  echo "[verify-release] Found non-allowlisted files:" >&2
  printf ' - %s\n' "${extras[@]}" >&2
  exit 1
fi

missing=()
for rule in "${allowlist[@]}"; do
  if [[ "$rule" == */ ]]; then
    if ! grep -q "^${rule//\//\/}" <<< "$entries"; then
      missing+=("$rule")
    fi
  else
    if ! grep -q "^${rule//\//\/}$" <<< "$entries"; then
      missing+=("$rule")
    fi
  fi
done

if [[ "${#missing[@]}" -gt 0 ]]; then
  echo "[verify-release] Missing required allowlisted entries:" >&2
  printf ' - %s\n' "${missing[@]}" >&2
  exit 1
fi

echo "[verify-release] Artifact verified: $input_path"
