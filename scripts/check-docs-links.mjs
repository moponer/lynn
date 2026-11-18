#!/usr/bin/env node
/**
 * 文档自检（P9-4）。
 *
 * 为什么需要它：`AGENTS.md` 与 25 章里写满了"读这个文件""跑这个命令"。
 * 一处路径写错，agent 就会照着走到 404——而它**不会告诉你文档错了**，
 * 它会自己猜，猜出来的东西可能离题很远。
 *
 * 所以把"文档里提到的路径/命令必须真实存在"做成可执行的检查。
 * 这不是洁癖：这是**让文档能被信任**的唯一办法。
 *
 * 用法：node scripts/check-docs-links.mjs
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");

const DOCS = ["AGENTS.md"];

const issues = [];

/** 1) markdown 链接里的相对路径必须存在 */
function checkLinks(file) {
  const full = path.join(repo, file);
  if (!fs.existsSync(full)) {
    issues.push(`${file}: 文件本身不存在`);
    return;
  }
  const text = fs.readFileSync(full, "utf8");
  const base = path.dirname(full);
  for (const m of text.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)) {
    const target = m[2].split("#")[0].trim();
    if (!target || /^https?:/.test(target) || target.startsWith("mailto:")) continue;
    const resolved = path.resolve(base, target);
    if (!fs.existsSync(resolved)) {
      issues.push(`${file}: 链接指向不存在的路径「${target}」`);
    }
  }
}

/** 2) 反引号里提到的仓库路径必须存在（只查带 / 的，避免误判普通词） */
function checkInlinePaths(file) {
  const full = path.join(repo, file);
  if (!fs.existsSync(full)) return;
  const text = fs.readFileSync(full, "utf8");
  const candidates = new Set();
  for (const m of text.matchAll(/`([A-Za-z0-9_./-]+\.(?:md|json|ts|tsx|mjs|cjs|css|html))`/g)) {
    candidates.add(m[1]);
  }
  for (const c of candidates) {
    // 跳过明显的"示例名"（不是真实仓库文件）
    if (/^(my-plugin|lynn\.demo|example|xxx)/i.test(c)) continue;
    if (c.startsWith("/") || c.includes("..")) continue;
    const resolved = path.resolve(repo, c);
    // 允许只写文件名（如 index.ts / plugin.json）：那类不做存在性检查
    if (!c.includes("/")) continue;
    if (!fs.existsSync(resolved)) {
      issues.push(`${file}: 提到的路径不存在「${c}」`);
    }
  }
}

/** 3) 提到的 npm script 必须真的在 package.json 里 */
function checkScripts(file) {
  const full = path.join(repo, file);
  if (!fs.existsSync(full)) return;
  const text = fs.readFileSync(full, "utf8");
  const pkg = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8"));
  const scripts = pkg.scripts ?? {};
  for (const m of text.matchAll(/`npm run ([a-z:0-9-]+)`/g)) {
    const name = m[1];
    if (!scripts[name]) issues.push(`${file}: 提到了不存在的 npm script「${name}」`);
  }
}

/** 4) 提到的 node scripts/xxx 必须存在 */
function checkNodeScripts(file) {
  const full = path.join(repo, file);
  if (!fs.existsSync(full)) return;
  const text = fs.readFileSync(full, "utf8");
  for (const m of text.matchAll(/`?node (scripts\/[A-Za-z0-9_./-]+\.mjs)/g)) {
    const rel = m[1];
    if (!fs.existsSync(path.join(repo, rel))) {
      issues.push(`${file}: 提到了不存在的脚本「${rel}」`);
    }
  }
}

for (const file of DOCS) {
  checkLinks(file);
  checkInlinePaths(file);
  checkScripts(file);
  checkNodeScripts(file);
}

/**
 * 5) AGENTS.md 必须指向**仓库里真实存在**的入口。
 *
 * 2026-11-18 调整：原来强制指向 `docs/plan/25-*.md` 与 `PROGRESS.md`，
 * 但那两个文档已从 git 历史中移除（不公开）。检查改成指向**仓库内**的真入口：
 * 模板目录、校验脚本、manifest 定义。这样这条检查仍然有意义（agent 找得到东西），
 * 又不会因为"指向一个不存在的文件"而假通过。
 */
{
  const agents = fs.readFileSync(path.join(repo, "AGENTS.md"), "utf8");
  for (const must of ["plugins/_templates", "check-plugin-package.mjs", "plugin-manifest.ts"]) {
    if (!agents.includes(must)) issues.push(`AGENTS.md: 缺少对「${must}」的指引——agent 会找不到`);
  }
}

if (issues.length) {
  console.log(`✖ 文档自检发现 ${issues.length} 处问题：`);
  for (const i of issues) console.log(`  - ${i}`);
  process.exitCode = 1;
} else {
  console.log(`✓ 文档自检通过：${DOCS.length} 份文档里的链接、路径、命令都真实存在`);
}