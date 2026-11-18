// 把运行时资产复制进 dist（主进程用 __dirname 相对解析）。
// 之前只复制了 dist/main 与 dist/renderer，托盘图标在 dist/assets 缺失 → 空图标。
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 单层文件复制（assets/ 是平的） */
function copyFlat(src, dst, label) {
  if (!fs.existsSync(src)) {
    console.warn(`[copy-assets] ${label} 不存在，跳过`);
    return 0;
  }
  fs.mkdirSync(dst, { recursive: true });
  let n = 0;
  for (const f of fs.readdirSync(src)) {
    const from = path.join(src, f);
    if (!fs.statSync(from).isFile()) continue;
    fs.copyFileSync(from, path.join(dst, f));
    n += 1;
  }
  return n;
}

/**
 * 递归复制（prompts/ 是树状的）。
 *
 * 为什么 prompts 也要进 dist：G2 编译闸在**运行时**判断「这个角色有没有岗位模板」，
 * 它读的就是这份文件。少了它们，打包后的应用永远报 template 缺失 → 每次派单都标 fallback，
 * 那个标记就彻底失去意义了。LICENSE 与 UPSTREAM.json 一并带上（合规要求随包分发）。
 */
function copyTree(src, dst, label) {
  if (!fs.existsSync(src)) {
    console.warn(`[copy-assets] ${label} 不存在，跳过`);
    return 0;
  }
  let n = 0;
  const walk = (from, to) => {
    fs.mkdirSync(to, { recursive: true });
    for (const e of fs.readdirSync(from, { withFileTypes: true })) {
      const a = path.join(from, e.name);
      const b = path.join(to, e.name);
      if (e.isDirectory()) walk(a, b);
      else {
        fs.copyFileSync(a, b);
        n += 1;
      }
    }
  };
  walk(src, dst);
  return n;
}

const nAssets = copyFlat(path.join(repo, "assets"), path.join(repo, "dist", "assets"), "assets/");
const nPrompts = copyTree(path.join(repo, "prompts"), path.join(repo, "dist", "prompts"), "prompts/");
/**
 * vendored 渠道实现（2026-11-18 P16-1）。
 *
 * 它们是 `.mjs`，tsc 不会编译也不会拷贝——但运行时真的需要（飞书/钉钉/QQ/
 * 企微/微信六个渠道的实现都在里面）。不复制的话 `dist` 里缺文件，
 * 表现为"渠道加载失败：Cannot find module"。
 */
const nImVendor = copyTree(
  path.join(repo, "src", "main", "im", "vendor"),
  path.join(repo, "dist", "main", "im", "vendor"),
  "src/main/im/vendor/",
);
console.log(`[copy-assets] ${nAssets} files → dist/assets，${nPrompts} files → dist/prompts，${nImVendor} files → dist/main/im/vendor`);