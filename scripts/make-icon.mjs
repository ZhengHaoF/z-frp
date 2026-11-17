// 生成桌面应用图标（1024x1024 PNG，无需图形库）。
// 用法: node scripts/make-icon.mjs
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";

const SIZE = 1024;
const SS = 3; // 超采样倍数，抗锯齿
const W = SIZE * SS;

const RADIUS = 190;
const INSET = 48;

function insideRoundedRect(x, y, w, h, r) {
  if (x < 0 || y < 0 || x > w || y > h) return false;
  const cx = Math.min(Math.max(x, r), w - r);
  const cy = Math.min(Math.max(y, r), h - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r || (x >= r && x <= w - r) || (y >= r && y <= h - r);
}

// 经典 Z 字形轮廓（单多边形，归一化 0..1 坐标）
const Z_OUTLINE = [
  [0.28, 0.3],
  [0.72, 0.3],
  [0.72, 0.395],
  [0.4, 0.605],
  [0.72, 0.605],
  [0.72, 0.7],
  [0.28, 0.7],
  [0.28, 0.605],
  [0.6, 0.395],
  [0.28, 0.395],
];

function pointInPolygon(px, py, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    const intersect = yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function inZ(x, y) {
  return pointInPolygon(x, y, Z_OUTLINE);
}

const inner = W - INSET * SS * 2;
const buf = Buffer.alloc(SIZE * SIZE * 4, 0);

for (let py = 0; py < SIZE; py++) {
  for (let px = 0; px < SIZE; px++) {
    let bgHits = 0;
    let zHits = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const x = (px + (sx + 0.5) / SS) * SS;
        const y = (py + (sy + 0.5) / SS) * SS;
        const lx = x - INSET * SS;
        const ly = y - INSET * SS;
        if (!insideRoundedRect(lx, ly, inner, inner, RADIUS * SS)) continue;
        bgHits++;
        if (inZ(lx / inner, ly / inner)) zHits++;
      }
    }
    const total = SS * SS;
    const alpha = Math.round((bgHits / total) * 255);
    if (alpha === 0) continue;
    const zRatio = bgHits ? zHits / bgHits : 0;
    // 垂直渐变 #4894FF -> #1C4ABE，再按 Z 覆盖率混白
    const t = py / SIZE;
    const bg = [
      Math.round(72 + (28 - 72) * t),
      Math.round(148 + (74 - 148) * t),
      Math.round(255 + (190 - 255) * t),
    ];
    const idx = (py * SIZE + px) * 4;
    buf[idx] = Math.round(bg[0] + (255 - bg[0]) * zRatio);
    buf[idx + 1] = Math.round(bg[1] + (255 - bg[1]) * zRatio);
    buf[idx + 2] = Math.round(bg[2] + (255 - bg[2]) * zRatio);
    buf[idx + 3] = alpha;
  }
}

// ---- PNG 编码 ----
const crcTable = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0;
  buf.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

const out = new URL("../apps/desktop/icon-source.png", import.meta.url);
writeFileSync(out, png);
console.log(`已生成 ${out.pathname} (${png.length} 字节)`);
