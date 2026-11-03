#!/usr/bin/env node
// M4-02/M4-04：生成 THIRD_PARTY_NOTICES.md 的依赖清单附录。
// 只读 package-lock.json 的本地事实（name@version），不联网、不猜测许可证——
// 传递依赖的许可证全文以各包发布件内的 LICENSE 为准（文档里如实写明）。
import * as fs from "node:fs";
import * as path from "node:path";

const root = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf-8"));

const rows = [];
for (const [key, info] of Object.entries(lock.packages ?? {})) {
  if (!key) continue; // 根包
  const name = key.startsWith("node_modules/") ? key.slice("node_modules/".length) : key;
  if (name.includes("node_modules")) continue; // 嵌套依赖按顶层路径去重展示
  rows.push(`${name}@${info.version ?? "?"}`);
}
rows.sort((a, b) => a.localeCompare(b));

const block = [
  "<!-- AUTO-DEPS START（由 scripts/gen-notices.mjs 生成，勿手改） -->",
  `共 ${rows.length} 个顶层包（含直接与传递依赖）：`,
  "",
  "```",
  ...rows,
  "```",
  "<!-- AUTO-DEPS END -->",
].join("\n");

const file = path.join(root, "THIRD_PARTY_NOTICES.md");
let md = fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : null;
if (md && /<!-- AUTO-DEPS START[\s\S]*<!-- AUTO-DEPS END -->/.test(md)) {
  md = md.replace(/<!-- AUTO-DEPS START[\s\S]*<!-- AUTO-DEPS END -->/, block);
} else if (md) {
  md = md.trimEnd() + "\n\n" + block + "\n";
} else {
  throw new Error("THIRD_PARTY_NOTICES.md 不存在：先手写正文再跑本脚本");
}
fs.writeFileSync(file, md, "utf-8");
console.log(`THIRD_PARTY_NOTICES.md 已更新（${rows.length} 包）`);
