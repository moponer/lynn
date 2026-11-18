#!/usr/bin/env node
/**
 * 修正 vendor 里的相对路径（2026-11-18 P15-2）。
 *
 * 问题：原仓库结构是 `src/channels/shared/x.mjs`，
 * 它 `import '../../../package.json'` 正好指到仓库根的 package.json。
 *
 * 我们放在 `src/main/im/vendor/shared/x.mjs`——多了一层 `main/im/vendor`，
 * 所以 `../../../package.json` 现在指到 `src/main/package.json`（不存在）。
 *
 * 解决：改成 `../../../../../package.json`（5 级）。
 *
 * 为什么用脚本而不是手工改两个文件：将来重新 vendor 时还要再改一次，
 * 脚本能重复跑。而且这个修正必须**可验证**——跑完要能 import 成功。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const VENDOR = path.join(repo, "src", "main", "im", "vendor");

/** vendor 里的文件在 src/main/im/vendor/<a>/<b>，到仓库根要 5 级 */
const UP = "../../../../../";

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.name.endsWith(".mjs")) out.push(full);
  }
  return out;
}

let changed = 0;
for (const file of walk(VENDOR)) {
  const src = fs.readFileSync(file, "utf8");
  /**
   * 只改**到仓库根**的那种（3 级）。
   * 不要动 `../../shared/x.mjs` 这种同层引用——那些仍然正确。
   */
  const fixed = src.replace(/(['"])\.\.\/\.\.\/\.\.\/package\.json\1/g, (m, q) => `${q}${UP}package.json${q}`);
  if (fixed !== src) {
    fs.writeFileSync(file, fixed, "utf8");
    changed += 1;
    console.log(`  ✔ ${path.relative(repo, file)}`);
  }
}
console.log(`\n修正 ${changed} 个文件`);
