import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const repoRoot = process.cwd();
const outDir = path.join(repoRoot, 'variant-icons');
const sizes = [16, 32, 48, 128, 512];

const palette = {
    dark: [16, 30, 48, 255],
    bg: [88, 196, 184, 255],
    bgHighlight: [121, 223, 210, 180],
    torso: [47, 126, 138, 255],
    face: [250, 236, 211, 255],
    faceShade: [237, 217, 182, 255],
    yellow: [255, 211, 100, 255],
    cyan: [97, 208, 225, 255],
    pink: [245, 154, 181, 255],
};

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function crc32(buffer) {
    const table =
        crc32.table ||
        (crc32.table = (() => {
            const t = new Uint32Array(256);
            for (let i = 0; i < 256; i += 1) {
                let c = i;
                for (let k = 0; k < 8; k += 1) {
                    c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
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

function encodePngRgba(size, rgbaBuffer) {
    const stride = size * 4;
    const rows = Buffer.alloc((stride + 1) * size);
    for (let y = 0; y < size; y += 1) {
        const rowOffset = y * (stride + 1);
        rows[rowOffset] = 0;
        rgbaBuffer.copy(rows, rowOffset + 1, y * stride, (y + 1) * stride);
    }

    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(size, 0);
    ihdr.writeUInt32BE(size, 4);
    ihdr[8] = 8;
    ihdr[9] = 6;
    ihdr[10] = 0;
    ihdr[11] = 0;
    ihdr[12] = 0;

    const idat = zlib.deflateSync(rows, { level: 9 });
    return Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        pngChunk('IHDR', ihdr),
        pngChunk('IDAT', idat),
        pngChunk('IEND', Buffer.alloc(0)),
    ]);
}

function blendPixel(buffer, size, x, y, color, opacity = 1) {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const index = (y * size + x) * 4;
    const srcA = (color[3] / 255) * clamp(opacity, 0, 1);
    if (srcA <= 0) return;

    const dstA = buffer[index + 3] / 255;
    const outA = srcA + dstA * (1 - srcA);
    if (outA <= 0) return;

    const srcR = color[0] / 255;
    const srcG = color[1] / 255;
    const srcB = color[2] / 255;
    const dstR = buffer[index] / 255;
    const dstG = buffer[index + 1] / 255;
    const dstB = buffer[index + 2] / 255;

    const outR = (srcR * srcA + dstR * dstA * (1 - srcA)) / outA;
    const outG = (srcG * srcA + dstG * dstA * (1 - srcA)) / outA;
    const outB = (srcB * srcA + dstB * dstA * (1 - srcA)) / outA;

    buffer[index] = Math.round(clamp(outR * 255, 0, 255));
    buffer[index + 1] = Math.round(clamp(outG * 255, 0, 255));
    buffer[index + 2] = Math.round(clamp(outB * 255, 0, 255));
    buffer[index + 3] = Math.round(clamp(outA * 255, 0, 255));
}

function drawFilledCircle(buffer, size, cx, cy, radius, color) {
    const minX = Math.floor(cx - radius - 1);
    const maxX = Math.ceil(cx + radius + 1);
    const minY = Math.floor(cy - radius - 1);
    const maxY = Math.ceil(cy + radius + 1);

    for (let y = minY; y <= maxY; y += 1) {
        for (let x = minX; x <= maxX; x += 1) {
            const dx = x + 0.5 - cx;
            const dy = y + 0.5 - cy;
            const dist = Math.sqrt(dx * dx + dy * dy);
            const coverage = clamp(radius + 0.5 - dist, 0, 1);
            if (coverage > 0) blendPixel(buffer, size, x, y, color, coverage);
        }
    }
}

function drawLine(buffer, size, x1, y1, x2, y2, width, color) {
    const distance = Math.hypot(x2 - x1, y2 - y1);
    const steps = Math.max(1, Math.ceil(distance * 2));
    for (let i = 0; i <= steps; i += 1) {
        const t = i / steps;
        const x = x1 + (x2 - x1) * t;
        const y = y1 + (y2 - y1) * t;
        drawFilledCircle(buffer, size, x, y, width / 2, color);
    }
}

function drawPolyline(buffer, size, points, width, color) {
    for (let i = 1; i < points.length; i += 1) {
        const [x1, y1] = points[i - 1];
        const [x2, y2] = points[i];
        drawLine(buffer, size, x1, y1, x2, y2, width, color);
    }
}

function pointInPolygon(x, y, points) {
    let inside = false;
    for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
        const xi = points[i][0];
        const yi = points[i][1];
        const xj = points[j][0];
        const yj = points[j][1];
        const intersects = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-9) + xi;
        if (intersects) inside = !inside;
    }
    return inside;
}

function drawFilledPolygon(buffer, size, points, color) {
    const samples = [
        [0.25, 0.25],
        [0.75, 0.25],
        [0.25, 0.75],
        [0.75, 0.75],
    ];
    let minX = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;

    for (const [x, y] of points) {
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
    }

    for (let y = Math.floor(minY) - 1; y <= Math.ceil(maxY) + 1; y += 1) {
        for (let x = Math.floor(minX) - 1; x <= Math.ceil(maxX) + 1; x += 1) {
            let covered = 0;
            for (const [sx, sy] of samples) {
                if (pointInPolygon(x + sx, y + sy, points)) covered += 1;
            }
            if (covered > 0) blendPixel(buffer, size, x, y, color, covered / samples.length);
        }
    }
}

function regularPolygon(cx, cy, radius, sides, rotation) {
    const points = [];
    for (let i = 0; i < sides; i += 1) {
        const angle = rotation + (Math.PI * 2 * i) / sides;
        points.push([cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius]);
    }
    return points;
}

function scalePolygon(points, cx, cy, scaleX, scaleY = scaleX) {
    return points.map(([x, y]) => [cx + (x - cx) * scaleX, cy + (y - cy) * scaleY]);
}

function drawCouncilPip(buffer, size, cx, cy, radius, color) {
    const outer = regularPolygon(cx, cy, radius * 1.45, 6, Math.PI / 6);
    const inner = scalePolygon(outer, cx, cy, 0.72);
    drawFilledPolygon(buffer, size, outer, palette.dark);
    drawFilledPolygon(buffer, size, inner, color);
}

function drawEye(buffer, size, cx, cy, width, slant) {
    const h = width * 0.38;
    const eye = [
        [cx - width * 0.56, cy + slant - h * 0.2],
        [cx + width * 0.56, cy - slant - h * 0.2],
        [cx + width * 0.48, cy + h],
        [cx - width * 0.48, cy + h],
    ];
    drawFilledPolygon(buffer, size, eye, palette.dark);
}

function drawTinyIcon(buffer, size, center, stroke) {
    const c = center;
    const badgeOuter = regularPolygon(c, c, size * 0.47, 6, Math.PI / 6);
    const badgeInner = scalePolygon(badgeOuter, c, c, 0.85);
    drawFilledPolygon(buffer, size, badgeOuter, palette.dark);
    drawFilledPolygon(buffer, size, badgeInner, palette.bg);

    const headOuter = [
        [c - size * 0.23, c - size * 0.1],
        [c - size * 0.14, c - size * 0.25],
        [c + size * 0.14, c - size * 0.25],
        [c + size * 0.23, c - size * 0.1],
        [c + size * 0.18, c + size * 0.2],
        [c - size * 0.18, c + size * 0.2],
    ];
    const headInner = scalePolygon(headOuter, c, c - size * 0.03, 0.84, 0.82);
    drawFilledPolygon(buffer, size, headOuter, palette.dark);
    drawFilledPolygon(buffer, size, headInner, palette.face);

    drawFilledCircle(buffer, size, c - size * 0.08, c - size * 0.02, Math.max(1.1, size * 0.05), palette.dark);
    drawFilledCircle(buffer, size, c + size * 0.08, c - size * 0.02, Math.max(1.1, size * 0.05), palette.dark);
    drawPolyline(
        buffer,
        size,
        [
            [c - size * 0.1, c + size * 0.09],
            [c, c + size * 0.15],
            [c + size * 0.1, c + size * 0.09],
        ],
        stroke * 0.9,
        palette.dark,
    );
    drawCouncilPip(buffer, size, c - size * 0.12, c - size * 0.34, Math.max(0.9, size * 0.04), palette.yellow);
    drawCouncilPip(buffer, size, c + size * 0.12, c - size * 0.34, Math.max(0.9, size * 0.04), palette.pink);
}

function drawMainIcon(buffer, size, center, stroke) {
    const c = center;
    const badgeOuter = regularPolygon(c, c, size * 0.47, 6, Math.PI / 6);
    const badgeInner = scalePolygon(badgeOuter, c, c, 0.86);
    drawFilledPolygon(buffer, size, badgeOuter, palette.dark);
    drawFilledPolygon(buffer, size, badgeInner, palette.bg);

    const highlight = [
        [c - size * 0.24, c - size * 0.28],
        [c + size * 0.24, c - size * 0.28],
        [c + size * 0.14, c - size * 0.08],
        [c - size * 0.14, c - size * 0.08],
    ];
    drawFilledPolygon(buffer, size, highlight, palette.bgHighlight);

    drawCouncilPip(buffer, size, c - size * 0.16, c - size * 0.29, size * 0.04, palette.yellow);
    drawCouncilPip(buffer, size, c, c - size * 0.34, size * 0.04, palette.cyan);
    drawCouncilPip(buffer, size, c + size * 0.16, c - size * 0.29, size * 0.04, palette.pink);
    drawPolyline(
        buffer,
        size,
        [
            [c - size * 0.18, c - size * 0.23],
            [c, c - size * 0.18],
            [c + size * 0.18, c - size * 0.23],
        ],
        stroke * 0.72,
        palette.dark,
    );

    const torsoOuter = [
        [c - size * 0.22, c + size * 0.16],
        [c + size * 0.22, c + size * 0.16],
        [c + size * 0.29, c + size * 0.34],
        [c - size * 0.29, c + size * 0.34],
    ];
    const torsoInner = scalePolygon(torsoOuter, c, c + size * 0.24, 0.84, 0.88);
    drawFilledPolygon(buffer, size, torsoOuter, palette.dark);
    drawFilledPolygon(buffer, size, torsoInner, palette.torso);

    const headOuter = [
        [c - size * 0.24, c - size * 0.02],
        [c - size * 0.14, c - size * 0.2],
        [c + size * 0.14, c - size * 0.2],
        [c + size * 0.24, c - size * 0.02],
        [c + size * 0.2, c + size * 0.2],
        [c - size * 0.2, c + size * 0.2],
    ];
    const headInner = scalePolygon(headOuter, c, c - size * 0.02, 0.84, 0.82);
    drawFilledPolygon(buffer, size, headOuter, palette.dark);
    drawFilledPolygon(buffer, size, headInner, palette.face);

    const crestLeft = [
        [c - size * 0.16, c - size * 0.2],
        [c - size * 0.1, c - size * 0.33],
        [c - size * 0.04, c - size * 0.2],
    ];
    const crestRight = [
        [c + size * 0.16, c - size * 0.2],
        [c + size * 0.1, c - size * 0.33],
        [c + size * 0.04, c - size * 0.2],
    ];
    drawFilledPolygon(buffer, size, crestLeft, palette.dark);
    drawFilledPolygon(buffer, size, crestRight, palette.dark);
    drawFilledPolygon(buffer, size, scalePolygon(crestLeft, c - size * 0.1, c - size * 0.24, 0.66), palette.faceShade);
    drawFilledPolygon(
        buffer,
        size,
        scalePolygon(crestRight, c + size * 0.1, c - size * 0.24, 0.66),
        palette.faceShade,
    );

    drawEye(buffer, size, c - size * 0.09, c - size * 0.03, size * 0.08, -size * 0.01);
    drawEye(buffer, size, c + size * 0.09, c - size * 0.03, size * 0.08, size * 0.01);
    drawPolyline(
        buffer,
        size,
        [
            [c - size * 0.12, c + size * 0.1],
            [c - size * 0.04, c + size * 0.13],
            [c + size * 0.04, c + size * 0.13],
            [c + size * 0.12, c + size * 0.1],
        ],
        stroke * 0.78,
        palette.dark,
    );

    drawLine(
        buffer,
        size,
        c - size * 0.12,
        c - size * 0.12,
        c - size * 0.02,
        c - size * 0.14,
        stroke * 0.6,
        palette.dark,
    );
    drawLine(
        buffer,
        size,
        c + size * 0.12,
        c - size * 0.12,
        c + size * 0.02,
        c - size * 0.14,
        stroke * 0.6,
        palette.dark,
    );
}

function drawIcon(size) {
    const pixels = Buffer.alloc(size * size * 4);
    const center = size / 2;
    const stroke = Math.max(1.1, size * 0.06);

    if (size <= 20) {
        drawTinyIcon(pixels, size, center, stroke);
    } else {
        drawMainIcon(pixels, size, center, stroke);
    }

    return pixels;
}

fs.mkdirSync(outDir, { recursive: true });

for (const size of sizes) {
    const png = encodePngRgba(size, drawIcon(size));
    const outPath = path.join(outDir, `variant-${size}.png`);
    fs.writeFileSync(outPath, png);
}

console.log(`[render-council-icon] Generated council icon set in ${outDir}`);
