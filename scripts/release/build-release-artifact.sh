#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
manifest_path="$repo_root/manifest.json"
audit_script="$repo_root/scripts/release/audit-release-artifact.sh"

if [[ ! -f "$manifest_path" ]]; then
  echo "[build-release] manifest.json not found at $manifest_path" >&2
  exit 1
fi

if [[ ! -x "$audit_script" ]]; then
  echo "[build-release] audit script not found or not executable: $audit_script" >&2
  exit 1
fi

requested_version="${1:-}"
release_root="$repo_root/release"
build_dir="$repo_root/.dist/release"

rm -rf "$build_dir"
mkdir -p "$build_dir" "$release_root"

required_files=(
  "manifest.json"
  "background.js"
  "contentScript.js"
  "captureUtils.js"
  "historyStore.js"
  "debatePromptUtils.js"
  "debate_prompts.json"
  "sidepanel.html"
  "sidepanel.js"
  "styles.css"
  "src/background/history-chat-service.js"
  "src/background/session-helpers.js"
  "src/background/profile-service.js"
  "src/background/prompt-service.js"
  "src/background/transport-service.js"
  "src/background/session-runtime-service.js"
  "src/background/message-router.js"
  "src/background/session-registry.js"
  "src/sidepanel/route-utils.js"
  "src/sidepanel/rich-content.js"
  "src/shared/providers.js"
  "src/shared/storage-keys.js"
)

required_dirs=(
  "variant-icons"
)

for file in "${required_files[@]}"; do
  src="$repo_root/$file"
  if [[ ! -f "$src" ]]; then
    echo "[build-release] required file missing: $file" >&2
    exit 1
  fi
  mkdir -p "$build_dir/$(dirname "$file")"
  cp -p "$src" "$build_dir/$file"
done

for dir in "${required_dirs[@]}"; do
  src="$repo_root/$dir"
  if [[ ! -d "$src" ]]; then
    echo "[build-release] required directory missing: $dir" >&2
    exit 1
  fi
  mkdir -p "$build_dir/$dir"
  cp -R "$src"/. "$build_dir/$dir/"
done

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
"$audit_script" "$zip_path"

echo "[build-release] Built artifact: $zip_path"
