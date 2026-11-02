// 生成托盘图标 assets/tray.png（16×16，风铃抽象形：圆顶铃身 + 铃舌）。
// 零依赖手写 PNG：签名 + IHDR + IDAT(zlib deflate) + IEND，CRC32 自算。
// 只需跑一次（node scripts/gen-tray-icon.mjs），产物进仓库，运行时 main.ts 直接读。
import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";

const S = 16;
// 0=透明 1=铃身 2=高光 3=铃舌
const art = [
  "0000000000000000",
  "0000011111100000",
  "0001111111110000",
  "0011221111111000",
  "0012211111111000",
  "0111111111111100",
  "0111111111111100",
  "0111111111111100",
  "0111111111111100",
  "0111111111111100",
  "0011111111111000",
  "0001111111110000",
  "0000033333000000",
  "0000033333000000",
  "0000003330000000",
  "0000000000000000",
];
const palette = [
  [0, 0, 0, 0], // transparent
  [230, 181, 74, 255], // 铃身（暖金）
  [255, 236, 200, 255], // 高光
  [154, 108, 32, 255], // 铃舌
];

const raw = Buffer.alloc(S * (S * 4 + 1));
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0;
  for (let x = 0; x < S; x++) {
    const [r, g, b, a] = palette[Number(art[y][x])];
    const o = y * (S * 4 + 1) + 1 + x * 4;
    raw[o] = r;
    raw[o + 1] = g;
    raw[o + 2] = b;
    raw[o + 3] = a;
  }
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const t = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
};

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0);
ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

const out = path.resolve(import.meta.dirname, "..", "assets", "tray.png");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, png);
console.log(`written ${out} (${png.length} bytes)`);
