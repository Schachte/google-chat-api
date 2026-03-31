#!/usr/bin/env node
/**
 * Generates chat-bubble PNG icons for the Chrome extension.
 * Uses only Node.js built-ins (no external dependencies).
 *
 * Run: node extension/icons/generate.js
 * Outputs: icon16.png, icon48.png, icon128.png
 */

const zlib = require("zlib");
const fs = require("fs");
const path = require("path");

// ─── PNG encoder (minimal, RGBA) ─────────────────────────────────────────────

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crcData = Buffer.concat([typeBytes, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcData));
  return Buffer.concat([len, typeBytes, data, crc]);
}

function encodePNG(width, height, rgba) {
  // IHDR
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  // IDAT — filtered scanlines (filter byte 0 = None per row)
  const rawRows = [];
  for (let y = 0; y < height; y++) {
    rawRows.push(Buffer.from([0])); // filter byte
    rawRows.push(rgba.subarray(y * width * 4, (y + 1) * width * 4));
  }
  const raw = Buffer.concat(rawRows);
  const compressed = zlib.deflateSync(raw, { level: 9 });

  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    sig,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", compressed),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// ─── Chat-bubble icon renderer ───────────────────────────────────────────────

function setPixel(buf, w, x, y, r, g, b, a) {
  if (x < 0 || x >= w || y < 0 || y >= w) return;
  const i = (y * w + x) * 4;
  // Alpha-blend over existing pixel
  const srcA = a / 255;
  const dstA = buf[i + 3] / 255;
  const outA = srcA + dstA * (1 - srcA);
  if (outA === 0) return;
  buf[i + 0] = Math.round((r * srcA + buf[i + 0] * dstA * (1 - srcA)) / outA);
  buf[i + 1] = Math.round((g * srcA + buf[i + 1] * dstA * (1 - srcA)) / outA);
  buf[i + 2] = Math.round((b * srcA + buf[i + 2] * dstA * (1 - srcA)) / outA);
  buf[i + 3] = Math.round(outA * 255);
}

function fillCircle(buf, w, cx, cy, r, cr, cg, cb, ca) {
  const r2 = r * r;
  for (let dy = -Math.ceil(r); dy <= Math.ceil(r); dy++) {
    for (let dx = -Math.ceil(r); dx <= Math.ceil(r); dx++) {
      const dist2 = dx * dx + dy * dy;
      if (dist2 <= r2) {
        // Anti-alias: fade at the edge
        const edgeDist = r - Math.sqrt(dist2);
        const aa = Math.min(1, Math.max(0, edgeDist));
        setPixel(buf, w, Math.round(cx + dx), Math.round(cy + dy), cr, cg, cb, Math.round(ca * aa));
      }
    }
  }
}

function fillRoundedRect(buf, w, x1, y1, x2, y2, radius, cr, cg, cb, ca) {
  for (let y = y1; y <= y2; y++) {
    for (let x = x1; x <= x2; x++) {
      let inside = true;
      // Check corners
      const corners = [
        [x1 + radius, y1 + radius], // top-left
        [x2 - radius, y1 + radius], // top-right
        [x1 + radius, y2 - radius], // bottom-left
        [x2 - radius, y2 - radius], // bottom-right
      ];
      if (x < x1 + radius && y < y1 + radius) {
        inside = (x - corners[0][0]) ** 2 + (y - corners[0][1]) ** 2 <= radius * radius;
      } else if (x > x2 - radius && y < y1 + radius) {
        inside = (x - corners[1][0]) ** 2 + (y - corners[1][1]) ** 2 <= radius * radius;
      } else if (x < x1 + radius && y > y2 - radius) {
        inside = (x - corners[2][0]) ** 2 + (y - corners[2][1]) ** 2 <= radius * radius;
      } else if (x > x2 - radius && y > y2 - radius) {
        inside = (x - corners[3][0]) ** 2 + (y - corners[3][1]) ** 2 <= radius * radius;
      }
      if (inside) {
        setPixel(buf, w, x, y, cr, cg, cb, ca);
      }
    }
  }
}

function renderChatIcon(size) {
  const buf = Buffer.alloc(size * size * 4, 0); // transparent

  const s = size / 128; // scale factor relative to 128px design

  // Background: rounded rectangle (Google green)
  const pad = Math.round(4 * s);
  const radius = Math.round(24 * s);
  fillRoundedRect(buf, size, pad, pad, size - pad - 1, size - pad - 1, radius,
    0x00, 0xA6, 0x7E, 255); // Teal/green — Google Chat green

  // Chat bubble (white, rounded)
  const bx1 = Math.round(20 * s);
  const by1 = Math.round(24 * s);
  const bx2 = Math.round(108 * s);
  const by2 = Math.round(82 * s);
  const br = Math.round(14 * s);
  fillRoundedRect(buf, size, bx1, by1, bx2, by2, br,
    255, 255, 255, 255);

  // Bubble tail (bottom-left triangle — approximate with small filled area)
  const tailX = Math.round(32 * s);
  const tailY = Math.round(82 * s);
  const tailW = Math.round(16 * s);
  const tailH = Math.round(18 * s);
  for (let dy = 0; dy < tailH; dy++) {
    const width = Math.round(tailW * (1 - dy / tailH));
    for (let dx = 0; dx < width; dx++) {
      setPixel(buf, size, tailX + dx, tailY + dy, 255, 255, 255, 255);
    }
  }

  // Three dots inside the bubble (teal, evenly spaced)
  const dotR = Math.round(5 * s);
  const dotY = Math.round(53 * s);
  const dotSpacing = Math.round(22 * s);
  const dotCenterX = Math.round(64 * s);

  fillCircle(buf, size, dotCenterX - dotSpacing, dotY, dotR, 0x00, 0xA6, 0x7E, 255);
  fillCircle(buf, size, dotCenterX, dotY, dotR, 0x00, 0xA6, 0x7E, 255);
  fillCircle(buf, size, dotCenterX + dotSpacing, dotY, dotR, 0x00, 0xA6, 0x7E, 255);

  return Buffer.from(buf);
}

// ─── Generate all sizes ──────────────────────────────────────────────────────

const dir = path.dirname(process.argv[1]) || __dirname;

for (const size of [16, 48, 128]) {
  const rgba = renderChatIcon(size);
  const png = encodePNG(size, size, rgba);
  const out = path.join(dir, `icon${size}.png`);
  fs.writeFileSync(out, png);
  console.log(`wrote ${out}  (${png.length} bytes)`);
}

console.log("done — icons ready");
