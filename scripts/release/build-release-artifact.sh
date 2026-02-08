#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
manifest_path="$repo_root/manifest.json"

if [[ ! -f "$manifest_path" ]]; then
  echo "[build-release] manifest.json not found at $manifest_path" >&2
  exit 1
fi

requested_version="${1:-}"
release_root="$repo_root/release"
build_dir="$repo_root/.dist/release"

rm -rf "$build_dir"
mkdir -p "$build_dir" "$release_root"

rsync -a --delete \
  --exclude '.git' \
  --exclude '.github' \
  --exclude '.dist' \
  --exclude 'release' \
  --exclude 'worktrees' \
  --exclude 'node_modules' \
  --exclude '.env' \
  --exclude '.env.*' \
  --exclude '.DS_Store' \
  "$repo_root/" "$build_dir/"

node - "$build_dir" "$requested_version" <<'NODE'
const fs = require('fs');
const path = require('path');

const outDir = process.argv[2];
const requestedVersion = process.argv[3] || '';

const manifestPath = path.join(outDir, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

const stripVariantSuffix = (value) =>
  typeof value === 'string' ? value.replace(/\s+\[[^\]]+\]$/, '') : value;

if (requestedVersion) {
  manifest.version = requestedVersion;
}

manifest.name = stripVariantSuffix(manifest.name || 'Multi-LLM Coder');

const existingAction = manifest.action && typeof manifest.action === 'object' ? manifest.action : {};
manifest.action = {
  ...existingAction,
  default_title: stripVariantSuffix(existingAction.default_title || manifest.name)
};

if (Object.prototype.hasOwnProperty.call(manifest, 'version_name')) {
  delete manifest.version_name;
}

fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
NODE

final_version="$(node -e "const m=require('${build_dir}/manifest.json'); process.stdout.write(String(m.version||'0.0.0'))")"
zip_name="multi-llm-coder-v${final_version}.zip"
zip_path="$release_root/$zip_name"

rm -f "$zip_path"
(cd "$build_dir" && zip -qr "$zip_path" .)

echo "[build-release] Built artifact: $zip_path"
