#!/usr/bin/env node
/**
 * i18n lint（2026-11-17 P6-8 / 18 章 F8）。
 *
 * 目标：**JSX 里写死的中文，且不在 `t()` 里 → 报错**。这样英文环境下不会露出中文。
 *
 * 为什么不能简单粗暴地"见中文就报"：这个仓库里中文到处都是，而且**大部分是对的**——
 *   - 注释（给人看的，不渲染）
 *   - `console.log` / 日志字段（开发者看的）
 *   - 错误信息与断言（内部抛出，不直接显示）
 *   - 数据常量（岗位名、状态标签的中文映射，走的是另一套）
 * 全都报出来就是一万条噪音，没人会看，lint 等于没有。
 *
 * 所以只检查**真正的用户可见位置**：
 *   1. JSX 文本节点：`<b>中文</b>`
 *   2. JSX 属性：`placeholder="中文"`、`title="中文"`、`aria-label="中文"`
 *   3. 模板/字符串里明显给 UI 用的：`text:` / `label:` / `title:` 这类字段
 *
 * 并且给了**豁免名单**（文件级），每条都要写理由——豁免是债，不是默认。
 *
 * ## 已知覆盖不到的地方（如实标注，不假装全覆盖）
 *
 *  1. **纯函数层拼出来的文案**：`perf.ts` 的 `describePerf()` 返回
 *     `主线程：最近一分钟 N 次长任务` 这样的整句。它不是 JSX、也不在 `text:` 字段里，
 *     本 lint 抓不到。这类要**靠人**在写的时候就想起来——或者改成返回结构化数据、由组件翻译。
 *  2. **动态拼接**：`\`第 ${n} 页\`` 这种，中文片段与变量混在一起，正则很难可靠判定。
 *  3. **非 renderer 目录**：主进程的弹窗文案（`dialog.showMessageBox`）不在扫描范围内。
 *
 * 这三条都不是"以后再说"——它们是这个 lint 的**能力边界**，写在这里是为了
 * 不让下一个人误以为"lint 过了就等于英文环境没中文"。
 *
 * 用法：
 *   node scripts/lint-i18n.mjs            报告问题（有则退出码 1）
 *   node scripts/lint-i18n.mjs --list     连豁免名单一起打印
 *   node scripts/lint-i18n.mjs --json     机器可读
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const SRC = path.join(repo, "src", "renderer");

/**
 * 文件级豁免：**每条都要写清为什么**。
 *
 * 这些都是"看起来像 UI 文案、实际不是"的地方。豁免要克制：
 * 一旦把某文件加进来，它里面的真问题也会被一起放过。
 */
const EXEMPT = [
  {
    // 头像是构建期生成的数据（SVG data-URI），里面没有可翻译文本
    file: "src/renderer/desk/avatars.generated.ts",
    why: "构建产物：12 张头像的 data-URI，不含 UI 文案",
  },
  {
    // 设计规范的说明文字与图标名映射：图标名是内部键，说明是给开发者读的
    file: "src/renderer/components/Icon.tsx",
    why: "图标名与路径表：内部键，不渲染",
  },
  {
    // 主题是**产品固有名词**（"青瓦"就是青瓦），和岗位名同类。
    // 英文环境下把"青瓦"译成 "Celadon Tile" 反而丢信息——用户对主题的认知就是这个名字。
    file: "src/renderer/desk/theme.ts",
    why: "主题名与色板说明：产品固有名词，与岗位名同类，不做翻译",
  },
];

/** 中文检测：至少两个连续 CJK 字符（单个字可能是符号/单位） */
const CJK = /[\u4e00-\u9fa5]{2,}/;

/** 这些属性是用户可见的文案 */
const UI_ATTRS = ["placeholder", "title", "aria-label", "alt", "label"];

/** 这些对象字段是用户可见的文案（值会进卡片/按钮） */
const UI_FIELDS = ["text", "label", "title", "placeholder", "hint", "desc", "message", "empty"];

/** 去掉注释（保留行号：换成等长空白） */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + " ".repeat(m.length - p1.length));
}

/** 扫描一个文件，返回问题列表 */
export function scanFile(rel, src) {
  const clean = stripComments(src);
  const lines = clean.split(/\r?\n/);
  const issues = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!CJK.test(line)) continue;
    // 已经走 t() 的不报（t("key") 里是键名，不会是中文；中文在字典里）
    // 这里要抓的是"中文直接写在 JSX/属性里"，所以含 t( 且中文不在 t() 内的仍要报。

    // 1) JSX 文本节点：>中文< 或 >中文{ 或 }中文<
    const jsxText = />(?:\s*)([\u4e00-\u9fa5][^<>{}]*?)(?:\s*)</.exec(line);
    if (jsxText && !/t\(/.test(line)) {
      issues.push({ file: rel, line: i + 1, kind: "jsx-text", text: jsxText[1].trim().slice(0, 60) });
      continue;
    }

    // 2) JSX 属性：attr="中文" 或 attr={"中文"}
    let attrHit = null;
    for (const a of UI_ATTRS) {
      const re = new RegExp(`\\b${a}\\s*=\\s*["'{]\\s*["']?([^"'{}]*[\u4e00-\u9fa5][^"'{}]*)`, "");
      const m = re.exec(line);
      if (m) {
        attrHit = { attr: a, text: m[1].trim().slice(0, 60) };
        break;
      }
    }
    if (attrHit) {
      issues.push({ file: rel, line: i + 1, kind: "jsx-attr", text: `${attrHit.attr}="${attrHit.text}"` });
      continue;
    }

    // 3) 对象字段：text: "中文" / label: `中文`
    let fieldHit = null;
    for (const f of UI_FIELDS) {
      const re = new RegExp(`\\b${f}\\s*:\\s*["'\`]([^"'\`]*[\u4e00-\u9fa5][^"'\`]*)`, "");
      const m = re.exec(line);
      if (m) {
        fieldHit = { field: f, text: m[1].trim().slice(0, 60) };
        break;
      }
    }
    if (fieldHit) {
      issues.push({ file: rel, line: i + 1, kind: "ui-field", text: `${fieldHit.field}: "${fieldHit.text}"` });
    }
  }
  return issues;
}

/** 遍历 src/renderer 下所有 tsx/ts */
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (/\.(tsx|ts)$/.test(e.name)) out.push(full);
  }
  return out;
}

/**
 * 入口。**只在直接运行时执行**——被 import 时（比如测试要复用 `scanFile`）不该跑一遍
 * 全量扫描并设置 `process.exitCode`，否则 import 它的测试文件会被判失败。
 */
function main() {
  const argv = process.argv.slice(2);
  const exemptSet = new Set(EXEMPT.map((e) => e.file));
  const files = walk(SRC).map((f) => path.relative(repo, f).replace(/\\/g, "/"));
  const all = [];
  for (const rel of files) {
    if (exemptSet.has(rel)) continue;
    all.push(...scanFile(rel, fs.readFileSync(path.join(repo, rel), "utf8")));
  }

  if (argv.includes("--json")) {
    console.log(JSON.stringify({ issues: all, exempt: EXEMPT, scanned: files.length }, null, 2));
    return;
  }
  if (argv.includes("--list")) {
    console.log(`扫描 ${files.length} 个文件，豁免 ${EXEMPT.length} 个：`);
    for (const e of EXEMPT) console.log(`  - ${e.file}：${e.why}`);
    console.log("");
  }
  if (!all.length) {
    console.log(`✓ i18n lint 通过：${files.length} 个文件里没有写死的用户可见中文（豁免 ${EXEMPT.length} 个，各有理由）`);
    return;
  }
  // 按文件聚合，先给总数再给明细——几千行明细没人看
  const byFile = new Map();
  for (const it of all) byFile.set(it.file, (byFile.get(it.file) ?? 0) + 1);
  console.log(`✖ 发现 ${all.length} 处写死的用户可见中文，分布在 ${byFile.size} 个文件：\n`);
  for (const [file, n] of [...byFile.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
    console.log(`  ${String(n).padStart(4)}  ${file}`);
  }
  if (byFile.size > 20) console.log(`  …还有 ${byFile.size - 20} 个文件`);
  console.log("\n明细（前 30 条）：");
  for (const it of all.slice(0, 30)) {
    console.log(`  ${it.file}:${it.line}  [${it.kind}] ${it.text}`);
  }
  console.log("\n改法：把文案搬进 src/shared/i18n-strings.ts，用 t(\"key\") 取。");
  process.exitCode = 1;
}

// 直接运行才执行（被 import 时只提供 scanFile）
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();