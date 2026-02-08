#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
source_file="$repo_root/background.js"
mirror_file="$repo_root/src/background/background.main.js"

cp -f "$source_file" "$mirror_file"
"$repo_root/scripts/dev/check-background-sync.sh"
