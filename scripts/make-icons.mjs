// Generate solid-green placeholder PNGs at the two sizes the manifest expects.
// Pure node stdlib — no native deps. Swap these out for real icons before shipping.

import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, "..", "public");

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function makePng(size, rgb) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8]  = 8;  // bit depth
  ihdr[9]  = 2;  // color type: RGB
  ihdr[10] = 0;  // compression
  ihdr[11] = 0;  // filter
  ihdr[12] = 0;  // interlace

  // Each scanline: filter byte (0) + width*3 RGB bytes
  const row = Buffer.alloc(1 + size * 3);
  row[0] = 0;
  for (let x = 0; x < size; x++) {
    row[1 + x * 3] = rgb[0];
    row[2 + x * 3] = rgb[1];
    row[3 + x * 3] = rgb[2];
  }
  // Stamp a simple mountain shape in white so the icon isn't a flat tile.
  const white = [255, 255, 255];
  const rows = Array.from({ length: size }, () => Buffer.from(row));
  for (let y = 0; y < size; y++) {
    const r = rows[y];
    for (let x = 0; x < size; x++) {
      // Two peaks: |x - 0.35*size| < (size - y) * 0.4  OR  |x - 0.65*size| < (size - y) * 0.3
      const dy = size - y;
      const peak1 = Math.abs(x - 0.35 * size) < dy * 0.45 && y > size * 0.35;
      const peak2 = Math.abs(x - 0.65 * size) < dy * 0.30 && y > size * 0.45;
      if (peak1 || peak2) {
        r[1 + x * 3]     = white[0];
        r[1 + x * 3 + 1] = white[1];
        r[1 + x * 3 + 2] = white[2];
      }
    }
  }
  const raw = Buffer.concat(rows);
  const idat = deflateSync(raw);

  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const green = [0x2b, 0x7a, 0x4b];
writeFileSync(join(outDir, "icon-192.png"), makePng(192, green));
writeFileSync(join(outDir, "icon-512.png"), makePng(512, green));
console.log("Wrote public/icon-192.png and public/icon-512.png (placeholder mountains).");
