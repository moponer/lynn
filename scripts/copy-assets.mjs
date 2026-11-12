// 把运行时资产复制进 dist/assets（主进程用 __dirname/../assets 解析）。
// 之前只复制了 dist/main 与 dist/renderer，托盘图标在 dist/assets 缺失 → 空图标。
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(repo, "assets");
const dst = path.join(repo, "dist", "assets");

if (!fs.existsSync(src)) {
  console.warn("[copy-assets] assets/ 不存在，跳过");
  process.exit(0);
}
fs.mkdirSync(dst, { recursive: true });
let n = 0;
for (const f of fs.readdirSync(src)) {
  const from = path.join(src, f);
  if (!fs.statSync(from).isFile()) continue;
  fs.copyFileSync(from, path.join(dst, f));
  n += 1;
}
console.log(`[copy-assets] ${n} files → dist/assets`);
