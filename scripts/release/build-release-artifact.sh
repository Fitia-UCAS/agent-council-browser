#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
requested_version="${1:-}"
release_root="$repo_root/release"
build_dir="$repo_root/.dist/release"
allowlist_file="$repo_root/scripts/release/release-allowlist.txt"
verify_script="$repo_root/scripts/release/verify-release-artifact.sh"

if [[ ! -f "$allowlist_file" ]]; then
  echo "[build-release] Missing allowlist: $allowlist_file" >&2
  exit 1
fi

rm -rf "$build_dir"
mkdir -p "$build_dir" "$release_root"

build_cmd=(node "$repo_root/scripts/build/build-from-src.mjs" --mode=release)
if [[ -n "$requested_version" ]]; then
  build_cmd+=(--version="$requested_version")
fi
"${build_cmd[@]}"

while IFS= read -r entry; do
  [[ -z "$entry" ]] && continue
  [[ "$entry" =~ ^[[:space:]]*# ]] && continue

  src_path="$repo_root/$entry"
  dst_path="$build_dir/$entry"

  if [[ ! -e "$src_path" ]]; then
    echo "[build-release] Missing allowlisted entry in repo: $entry" >&2
    exit 1
  fi

  if [[ "$entry" == */ ]]; then
    mkdir -p "$dst_path"
    rsync -a "$src_path" "$dst_path"
  else
    mkdir -p "$(dirname "$dst_path")"
    rsync -a "$src_path" "$dst_path"
  fi
done < "$allowlist_file"

"$verify_script" "$build_dir"

final_version="$(node -e "const m=require('${build_dir}/manifest.json'); process.stdout.write(String(m.version||'0.0.0'))")"
zip_name="multi-llm-coder-v${final_version}.zip"
zip_path="$release_root/$zip_name"

rm -f "$zip_path"
(cd "$build_dir" && zip -qr "$zip_path" .)

"$verify_script" "$zip_path"

echo "[build-release] Built artifact: $zip_path"
