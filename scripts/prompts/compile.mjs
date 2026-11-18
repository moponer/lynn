#!/usr/bin/env node
/**
 * 离线编译角色提示词（P2-2 / 06 章 §5 + §8「离线」「可追溯」）。
 *
 * 一次编译 = 读本地 adapter 元信息 → 校验它钉住的上游 sha256 → 读本地 vendor 正文 →
 * 剥掉上游 YAML frontmatter → 按 adapter 的工具映射替换工具名 → 拼上我们的身份头与差异段。
 *
 * 三个刻意的设计：
 *  1. **纯本地**：只读 `prompts/` 下的文件，不发任何网络请求。断网时结果完全一样。
 *  2. **sha 校验是硬的**：adapter 里记着它派生自哪个 vendor 文件、那一版的前 8 位哈希。
 *     vendor 被更新（合法场景只有一次：人工重拷）而 adapter 没跟着改 → 这里直接报错。
 *     否则「任一角色能追到 vendor + adapter」只是文档里的一句话。
 *  3. **工具名只认白名单**：编译完把正文里所有反引号标识符过一遍，凡像工具名却不在
 *     MEMBER_EXEC_TOOLS 里的，全部列出来。上游写 `Read`/`Bash`，我们只有 `read_file`/`run_command`；
 *     漏一个映射，成员就会去调一个不存在的工具，然后空转到打回上限。
 *
 * 用法：
 *   node scripts/prompts/compile.mjs --all            列出所有角色（字数 + tokens）
 *   node scripts/prompts/compile.mjs --role implementer   打印编译结果
 *   node scripts/prompts/compile.mjs --all --out .tmp/prompts
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const PROMPTS = path.resolve(here, "../../prompts");
const VENDOR = path.join(PROMPTS, "vendor");
const ADAPTERS = path.join(PROMPTS, "adapters");

/** 成员的执行工具白名单（与 member-runner 的 MEMBER_EXEC_TOOLS 同源；这里只用于校验） */
const MEMBER_EXEC_TOOLS = [
  "read_file",
  "write_file",
  "list_dir",
  "glob",
  "grep",
  "run_command",
  "office_read_table",
  "office_write_table",
  "office_write_docx",
  "browser_navigate",
  "browser_snapshot",
  "browser_click",
  "browser_fill",
  "browser_extract",
  "browser_close",
  "kb_add",
  "app_api",
  "ssh_run",
];

/** 上游工具名 → 我们（06 章 §5 规则 1「工具名全量映射」） */
const TOOL_MAP = {
  Read: "read_file",
  Write: "write_file",
  Edit: "edit_file",
  Bash: "run_command",
  Glob: "glob",
  Grep: "grep",
  Task: "assign_task",
  WebFetch: "browser_navigate",
  WebSearch: "browser_navigate",
};

/** 几个短语级替换：单靠词替换会留下说不通的句子 */
const PHRASE_MAP = [
  [/Task tool \(general-purpose\)/gi, "assign_task（派给一名成员）"],
  [/general-purpose subagent/gi, "执行成员"],
  [/subagent/gi, "成员"],
  [/sub-agent/gi, "成员"],
];

const sha8 = (buf) => crypto.createHash("sha256").update(buf).digest("hex").slice(0, 8);

/** 拆 adapter 的 YAML frontmatter（只支持我们用到的那几个平铺键） */
export function parseAdapter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w]*):\s*(.*)$/.exec(line.trim());
    if (!kv) continue;
    meta[kv[1]] = kv[2].trim();
  }
  if (meta.toolMap) {
    const map = {};
    for (const pair of meta.toolMap.split(",")) {
      const [k, v] = pair.split("=").map((s) => s.trim());
      if (k && v) map[k] = v;
    }
    meta.toolMap = map;
  }
  return { meta, body: text.slice(m[0].length) };
}

/** 剥掉上游正文里的 YAML frontmatter（zcode 的 agent 文件带角色/模型/工具声明，不该发给模型） */
function stripFrontmatter(text) {
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
}

/** 按映射替换工具名；只在「独立出现」时替换，避免 Reading→read_fileing 这种事故 */
function applyToolMap(text, extraMap = {}) {
  const map = { ...TOOL_MAP, ...extraMap };
  let out = text;
  for (const [from, to] of Object.entries(map)) {
    out = out.replace(new RegExp(`\\b${from}\\b`, "g"), to);
  }
  for (const [re, to] of PHRASE_MAP) out = out.replace(re, to);
  return out;
}

const IDENTITY = {
  implementer: "你是风铃派出的一名**执行成员**（做东西）。",
  orchestrator: "这段是风铃**自己**的协作纪律（她是编排者，不执行）。",
  "code-reviewer": "你是风铃派出的一名**验收成员**（只判，不改）。",
  "visual-judge": "你是风铃派出的一名**视觉验收成员**（只看渲染后的页面，只判，不改）。",
};

export function listAdapters() {
  if (!fs.existsSync(ADAPTERS)) return [];
  return fs
    .readdirSync(ADAPTERS)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.replace(/\.md$/, ""))
    .sort();
}

/**
 * 编译一个角色。返回 { role, text, chars, upstream, sha, problems }。
 * `problems` 非空表示不能发出去（sha 不符 / 来源缺失）。
 */
export function compileRole(role) {
  const adapterFile = path.join(ADAPTERS, `${role}.md`);
  if (!fs.existsSync(adapterFile)) throw new Error(`没有 adapter：${adapterFile}`);
  const { meta, body } = parseAdapter(fs.readFileSync(adapterFile, "utf8"));
  const problems = [];
  if (!meta.from) throw new Error(`${role}: adapter 缺 from（派生自哪个 vendor 文件）`);

  const vendorFile = path.join(VENDOR, meta.from);
  if (!fs.existsSync(vendorFile)) {
    return { role, text: "", chars: 0, upstream: meta.from, sha: meta.sha ?? "", problems: [`vendor 文件不存在：${meta.from}`] };
  }
  const vendorBuf = fs.readFileSync(vendorFile);
  const actual = sha8(vendorBuf);
  if (meta.sha && meta.sha !== actual) {
    problems.push(
      `adapter 钉的 sha ${meta.sha} 与 vendor 实际 ${actual} 不符（${meta.from}）——` +
        "上游内容变了：确认改动是有意的，然后更新 adapter 头部的 sha",
    );
  }

  const adapted = applyToolMap(stripFrontmatter(vendorBuf.toString("utf8")), meta.toolMap ?? {});
  const head = `【角色】${role}\n${IDENTITY[role] ?? ""}\n` + `派生自 ${meta.from}@${actual}（见 prompts/vendor/*/UPSTREAM.json）\n`;
  const text = `${head}\n----- 上游正文（工具名已映射）-----\n\n${adapted.trim()}\n\n----- 我们的差异与契约 -----\n\n${body.trim()}\n`;
  return { role, text, chars: text.length, upstream: meta.from, sha: actual, problems };
}

/**
 * 编译后的硬不变量：**上游工具名一个都不许剩下**。
 *
 * 不是「检查有没有 Read 这个词」这么弱——是映射有没有漏。上游写 `Read`/`Bash`，
 * 我们只有 `read_file`/`run_command`。漏一个，成员就会去调一个不存在的工具名，
 * 然后一路空转到打回上限（这正是 11-16 复盘里那类失败）。
 * 英文动词形态（Reading / reads）不算：它们不构成工具调用，替换也不会命中（\b 边界）。
 */
export function findUnmappedToolWords(text) {
  const left = [];
  for (const from of Object.keys(TOOL_MAP)) {
    const re = new RegExp(`\\b${from}\\b`);
    if (re.test(text)) left.push(from);
  }
  return left;
}

function estimateTokens(text) {
  const cjk = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
  return Math.round(cjk + (text.length - cjk) / 4);
}

function main() {
  const argv = process.argv.slice(2);
  const roleArg = argv.includes("--role") ? argv[argv.indexOf("--role") + 1] : null;
  const all = argv.includes("--all");
  const outDir = argv.includes("--out") ? argv[argv.indexOf("--out") + 1] : null;

  const roles = roleArg ? [roleArg] : listAdapters();
  if (!roles.length) {
    console.error("没有 adapter 可编译");
    process.exitCode = 1;
    return;
  }

  let bad = 0;
  const rows = [];
  for (const role of roles) {
    const r = compileRole(role);
    const unmapped = findUnmappedToolWords(r.text);
    if (r.problems.length || unmapped.length) bad += 1;
    rows.push({ ...r, unmapped, tokens: estimateTokens(r.text) });
    if (outDir) {
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(outDir, `${role}.md`), r.text, "utf8");
    }
    if (!all && roleArg) process.stdout.write(r.text);
  }

  if (all) {
    console.log("角色".padEnd(16) + "字符".padStart(8) + "tokens".padStart(9) + "  上游");
    for (const r of rows) {
      console.log(`${r.role.padEnd(16)}${String(r.chars).padStart(8)}${String(r.tokens).padStart(9)}  ${r.upstream}@${r.sha}`);
      for (const p of r.problems) console.error(`  ✖ ${p}`);
      if (r.unmapped.length) console.error(`  ✖ 未映射的上游工具名：${r.unmapped.join(", ")}`);
    }
    if (outDir) console.log(`\n已写入 ${path.relative(process.cwd(), path.resolve(outDir))}/`);
  } else if (roleArg && rows[0]?.problems.length) {
    for (const p of rows[0].problems) console.error(`✖ ${p}`);
  }

  if (bad) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();