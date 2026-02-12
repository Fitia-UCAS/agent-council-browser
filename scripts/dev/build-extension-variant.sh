#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
branch_name="$(git -C "$repo_root" rev-parse --abbrev-ref HEAD)"
build_from_src="$repo_root/scripts/build/build-from-src.mjs"

if [[ -f "$build_from_src" ]]; then
  node "$build_from_src" --mode=dev >/dev/null
fi

mode="dist"
icons_only="false"
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --in-place)
      mode="in_place"
      shift
      ;;
    --icons-only)
      icons_only="true"
      mode="in_place"
      shift
      ;;
    --)
      shift
      break
      ;;
    -*)
      echo "Usage: bash scripts/dev/build-extension-variant.sh [--in-place] [--icons-only] [label]" >&2
      exit 1
      ;;
    *)
      break
      ;;
  esac
done

if [[ "$#" -gt 1 ]]; then
  echo "Usage: bash scripts/dev/build-extension-variant.sh [--in-place] [--icons-only] [label]" >&2
  exit 1
fi

label_raw="${1:-$branch_name}"
label="$(printf '%s' "$label_raw" | tr '/ ' '--' | tr -cd '[:alnum:]_.-')"

if [[ -z "$label" ]]; then
  echo "[build-variant] Unable to derive a valid label from branch name: $label_raw" >&2
  exit 1
fi

manifest_path="$repo_root/manifest.json"
if [[ "$mode" == "in_place" ]]; then
  out_dir="$repo_root"
else
  out_dir="$repo_root/.dist/$label"
fi

if [[ ! -f "$manifest_path" ]]; then
  echo "[build-variant] manifest.json not found at $manifest_path" >&2
  exit 1
fi

if [[ "$mode" != "in_place" ]]; then
  mkdir -p "$out_dir"

  rsync -a --delete \
    --exclude '.git' \
    --exclude '.dist' \
    --exclude 'worktrees' \
    --exclude 'node_modules' \
    --exclude '.env' \
    --exclude '.env.*' \
    --exclude '.DS_Store' \
    "$repo_root/" "$out_dir/"
fi

node - "$out_dir" "$label" "$mode" "$icons_only" <<'NODE'
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const outDir = process.argv[2];
const label = process.argv[3];
const mode = process.argv[4];
const iconsOnly = process.argv[5] === 'true';
const manifestPath = path.join(outDir, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

const stripVariantSuffix = (value) =>
  typeof value === 'string' ? value.replace(/\s+\[[^\]]+\]$/, '') : value;

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const mix = (a, b, t) => Math.round(a + (b - a) * t);

function crc32(buffer) {
  const table = crc32.table || (crc32.table = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i += 1) {
      let c = i;
      for (let k = 0; k < 8; k += 1) {
        c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      }
      t[i] = c >>> 0;
    }
    return t;
  })());
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = table[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const lengthBuffer = Buffer.alloc(4);
  lengthBuffer.writeUInt32BE(data.length, 0);
  const crcBuffer = Buffer.alloc(4);
  crcBuffer.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([lengthBuffer, typeBuffer, data, crcBuffer]);
}

function encodePngRgba(width, height, rgbaBuffer) {
  const stride = width * 4;
  const rows = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * (stride + 1);
    rows[rowOffset] = 0; // No filter
    rgbaBuffer.copy(rows, rowOffset + 1, y * stride, (y + 1) * stride);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const idat = zlib.deflateSync(rows, { level: 9 });
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

function drawRect(buffer, size, x, y, width, height, rgba) {
  for (let py = y; py < y + height; py += 1) {
    if (py < 0 || py >= size) continue;
    for (let px = x; px < x + width; px += 1) {
      if (px < 0 || px >= size) continue;
      const offset = (py * size + px) * 4;
      buffer[offset] = rgba[0];
      buffer[offset + 1] = rgba[1];
      buffer[offset + 2] = rgba[2];
      buffer[offset + 3] = rgba[3];
    }
  }
}

function buildIconPng(size, labelHash) {
  const pixels = Buffer.alloc(size * size * 4);

  let base = [labelHash[0], labelHash[1], labelHash[2]];
  const maxBase = Math.max(...base);
  if (maxBase < 130) {
    base = base.map((value) => mix(value, 255, 0.4));
  }
  const minBase = Math.min(...base);
  if (minBase > 175) {
    base = base.map((value) => mix(value, 60, 0.3));
  }

  const accent = [
    mix(labelHash[3], 255, 0.15),
    mix(labelHash[4], 255, 0.15),
    mix(labelHash[5], 255, 0.15)
  ];
  const borderColor = base.map((value) => mix(value, 20, 0.55));
  const border = Math.max(1, Math.floor(size / 12));
  const stripePeriod = Math.max(3, Math.floor(size / 4));
  const stripeWidth = Math.max(1, Math.floor(stripePeriod / 3));

  for (let y = 0; y < size; y += 1) {
    const t = size <= 1 ? 0 : y / (size - 1);
    const row = [
      mix(base[0], accent[0], t * 0.25),
      mix(base[1], accent[1], t * 0.25),
      mix(base[2], accent[2], t * 0.25)
    ];
    for (let x = 0; x < size; x += 1) {
      const offset = (y * size + x) * 4;
      let color = row;

      if (x < border || y < border || x >= size - border || y >= size - border) {
        color = borderColor;
      } else if (((x * 2 + y * 3 + labelHash[6]) % stripePeriod) < stripeWidth) {
        color = [
          mix(row[0], accent[0], 0.45),
          mix(row[1], accent[1], 0.45),
          mix(row[2], accent[2], 0.45)
        ];
      }

      pixels[offset] = clamp(color[0], 0, 255);
      pixels[offset + 1] = clamp(color[1], 0, 255);
      pixels[offset + 2] = clamp(color[2], 0, 255);
      pixels[offset + 3] = 255;
    }
  }

  // Center 5x5 mirrored identicon blocks for quick visual differentiation.
  const grid = 5;
  const usable = size - border * 2;
  const cell = Math.max(1, Math.floor(usable / (grid + 2)));
  const gridSize = cell * grid;
  const startX = Math.floor((size - gridSize) / 2);
  const startY = Math.floor((size - gridSize) / 2);
  const markColor = [255, 255, 255, 220];

  for (let gy = 0; gy < grid; gy += 1) {
    for (let gx = 0; gx <= 2; gx += 1) {
      const bitIndex = gy * 3 + gx;
      const sourceByte = labelHash[(8 + Math.floor(bitIndex / 8)) % labelHash.length];
      const bit = (sourceByte >> (bitIndex % 8)) & 1;
      if (!bit) continue;

      const drawX = startX + gx * cell;
      const mirroredX = startX + (grid - 1 - gx) * cell;
      const drawY = startY + gy * cell;
      const inset = Math.max(0, Math.floor(cell * 0.12));
      const block = Math.max(1, cell - inset * 2);

      drawRect(pixels, size, drawX + inset, drawY + inset, block, block, markColor);
      drawRect(pixels, size, mirroredX + inset, drawY + inset, block, block, markColor);
    }
  }

  return encodePngRgba(size, size, pixels);
}

const hash = crypto.createHash('sha256').update(label).digest();
const iconSizes = [16, 32, 48, 128];
const iconDirName = 'variant-icons';
const iconDir = path.join(outDir, iconDirName);
fs.mkdirSync(iconDir, { recursive: true });

const icons = {};
for (const size of iconSizes) {
  const filename = `variant-${size}.png`;
  const filePath = path.join(iconDir, filename);
  fs.writeFileSync(filePath, buildIconPng(size, hash));
  icons[String(size)] = `${iconDirName}/${filename}`;
}

if (!iconsOnly) {
  const baseName = stripVariantSuffix(manifest.name || 'Extension');
  manifest.name = `${baseName} [${label}]`;

  const existingAction = manifest.action && typeof manifest.action === 'object' ? manifest.action : {};
  const baseTitle = stripVariantSuffix(existingAction.default_title || baseName);
  manifest.action = {
    ...existingAction,
    default_title: `${baseTitle} [${label}]`,
    default_icon: icons
  };

  manifest.icons = icons;
  manifest.version_name = `dev-${label}`;

  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
}

if (mode === 'in_place' && !iconsOnly) {
  console.log(`[build-variant] Applied in-place branding for ${label} in ${outDir}`);
}
NODE

if [[ "$icons_only" == "true" ]]; then
  echo "[build-variant] Icons ensured for label '$label': $out_dir/variant-icons"
elif [[ "$mode" == "in_place" ]]; then
  echo "[build-variant] In-place branding applied: $out_dir"
else
  echo "[build-variant] Built: $out_dir"
fi
