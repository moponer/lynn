#!/usr/bin/env node
/**
 * 上游提示词资产一次性引入（P2-2 / 06 章）。
 *
 * 两种模式：
 *   node scripts/prompts/vendor-sync.mjs           从本机来源拷进 prompts/vendor/ 并写 UPSTREAM.json
 *   node scripts/prompts/vendor-sync.mjs --check   只核对：清单内文件在、sha256 与清单一致
 *
 * 为什么要有 --check：06 章 §4 的纪律是「vendor 只读，改动只能进 adapter」。
 * 没有校验时这条只是口头约定——手改一个 vendor 文件没人会知道，等到线上行为漂移才回头查。
 * 所以把 sha256 写成清单，并让 `npm run lint:prompts` 每次都核一遍。
 *
 * 为什么 COPY_MAP 是写死的而不是扫目录：这是**一次性引入**（06 章 §1），不是同步。
 * 上游后来加了什么文件跟我们无关；清单变了必须是人来改这里，然后显式重跑一次。
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const VENDOR = path.resolve(here, "../../prompts/vendor");
const SOURCES_FILE = path.join(VENDOR, "sources.json");

/** superpowers 的 14 个技能目录（06 章 §3 写作「13 个」，实际目录是 14 个，按实际引入） */
const SUPERPOWERS_SKILLS = [
  "brainstorming",
  "dispatching-parallel-agents",
  "executing-plans",
  "finishing-a-development-branch",
  "receiving-code-review",
  "requesting-code-review",
  "subagent-driven-development",
  "systematic-debugging",
  "test-driven-development",
  "using-git-worktrees",
  "using-superpowers",
  "verification-before-completion",
  "writing-plans",
  "writing-skills",
];

/**
 * 拷贝清单：dest 相对于 prompts/vendor/<upstream>；src 相对于该上游的 root。
 * 只收「会被注入到提示词里」的正文，不收上游内部参考资料与脚本——
 * 那些是上游自己的开发物，我们没有对应功能，收进来只会变成没人读的死文件。
 */
const COPY_MAP = {
  codex: [
    ["roles/orchestrator.md", "core/templates/agents/orchestrator.md"],
    ["roles/multi-agent.md", "core/templates/collab/experimental_prompt.md"],
    ["protocol/compact.md", "prompts/templates/compact/prompt.md"],
  ],
  superpowers: [
    ["roles/implementer.md", "skills/subagent-driven-development/implementer-prompt.md"],
    ["roles/reviewer-spec.md", "skills/subagent-driven-development/spec-reviewer-prompt.md"],
    ["roles/reviewer-quality.md", "skills/subagent-driven-development/code-quality-reviewer-prompt.md"],
    ["roles/code-reviewer.md", "skills/requesting-code-review/code-reviewer.md"],
    ["roles/reviewer-plan.md", "skills/writing-plans/plan-document-reviewer-prompt.md"],
    ["roles/reviewer-spec-doc.md", "skills/brainstorming/spec-document-reviewer-prompt.md"],
    ...SUPERPOWERS_SKILLS.map((name) => [`skills/${name}/SKILL.md`, `skills/${name}/SKILL.md`]),
  ],
  zcode: [
    // 四份 visual-judge.md 字节完全一致（sha256 相同），合并为一份；差异说明写在 UPSTREAM.json
    ["roles/visual-judge.md", "apps/zcode-cli/packages/spreadsheets-plugin/agents/visual-judge.md"],
  ],
};

/** 每个上游的一段人话说明，写进 UPSTREAM.json 的 note，便于日后回溯为什么这么引 */
const NOTES = {
  codex:
    "Codex 的多代理编排与压缩协议。只取 templates 正文；gpt_5_*_prompt.md 这类整段系统提示词没有引入——" +
    "我们的编译器自己组装，直接用别人的整段会覆盖掉人设与工具事实。",
  superpowers:
    "角色提示词（执行者 / 三种评审者）与 14 个技能正文。技能只取 SKILL.md：上游的 references/ 与 scripts/ " +
    "服务它自己的运行环境（Codex CLI / Copilot），我们没有对应实现，收进来是死文件。",
  zcode:
    "办公域视觉评审员的角色提示词。上游把同一份文件复制在 documents / pdf / presentations / spreadsheets " +
    "四个插件里（sha256 一致），这里合并为一份。",
};

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

function readSources() {
  if (!fs.existsSync(SOURCES_FILE)) throw new Error(`缺少来源表：${SOURCES_FILE}`);
  return JSON.parse(fs.readFileSync(SOURCES_FILE, "utf8")).sources;
}

/** 遍历清单，返回 [{upstream, rel, abs}]（绝对路径只在 sync 时能解析） */
function plannedFiles(sources, only = null) {
  const out = [];
  for (const [upstream, list] of Object.entries(COPY_MAP)) {
    if (only && upstream !== only) continue;
    const root = sources[upstream]?.root;
    if (!root) throw new Error(`来源表里没有 ${upstream} 的 root`);
    for (const [rel, src] of list) out.push({ upstream, rel, abs: path.join(root, src), src });
  }
  return out;
}

/** 已落地的 vendor 文件清单（相对 prompts/vendor/<upstream>/） */
function existingFiles(upstream) {
  const dir = path.join(VENDOR, upstream);
  const out = [];
  const walk = (cur) => {
    if (!fs.existsSync(cur)) return;
    for (const e of fs.readdirSync(cur, { withFileTypes: true })) {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name !== "UPSTREAM.json" && e.name !== "LICENSE") {
        out.push(path.relative(dir, full).split(path.sep).join("/"));
      }
    }
  };
  walk(dir);
  return out.sort();
}

function sync(sources) {
  fs.mkdirSync(VENDOR, { recursive: true });
  const summary = [];
  for (const upstream of Object.keys(COPY_MAP)) {
    const dir = path.join(VENDOR, upstream);
    const files = {};
    let bytes = 0;
    for (const item of plannedFiles(sources, upstream)) {
      if (!fs.existsSync(item.abs)) throw new Error(`来源文件不存在：${item.abs}`);
      const buf = fs.readFileSync(item.abs);
      const dest = path.join(dir, item.rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, buf);
      files[item.rel] = `sha256:${sha256(buf)}`;
      bytes += buf.length;
    }
    // LICENSE：不参与「可改动正文」的判定，但同样记哈希（被换掉要能发现）
    const licenseSrc = sources[upstream].licenseFile;
    if (!fs.existsSync(licenseSrc)) throw new Error(`来源 LICENSE 不存在：${licenseSrc}`);
    const lic = fs.readFileSync(licenseSrc);
    fs.writeFileSync(path.join(dir, "LICENSE"), lic);
    files.LICENSE = `sha256:${sha256(lic)}`;

    const prev = readUpstream(dir);
    const manifest = {
      upstream,
      sourcePath: sources[upstream].root,
      license: detectLicense(lic),
      // 重跑不刷新时间：vendoredAt 记的是「这批内容是什么时候定的」，不是「什么时候又跑了一次」
      vendoredAt: prev?.vendoredAt ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      note: NOTES[upstream],
      files,
    };
    fs.writeFileSync(path.join(dir, "UPSTREAM.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    summary.push({ upstream, count: Object.keys(files).length, bytes, vendoredAt: manifest.vendoredAt });
  }
  return summary;
}

function readUpstream(dir) {
  const f = path.join(dir, "UPSTREAM.json");
  if (!fs.existsSync(f)) return null;
  try {
    return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch {
    return null;
  }
}

function detectLicense(buf) {
  const text = buf.toString("utf8");
  if (/MIT License/i.test(text)) return "MIT";
  if (/Apache License\s*\n?\s*Version 2\.0/i.test(text)) return "Apache-2.0";
  return "see LICENSE";
}

/** 核对：清单内文件存在、哈希一致、磁盘上没有清单外的正文文件 */
function check() {
  const problems = [];
  const rows = [];
  for (const upstream of Object.keys(COPY_MAP)) {
    const dir = path.join(VENDOR, upstream);
    const manifest = readUpstream(dir);
    if (!manifest) {
      problems.push(`${upstream}: 缺少 UPSTREAM.json`);
      continue;
    }
    let checked = 0;
    for (const [rel, want] of Object.entries(manifest.files)) {
      const full = path.join(dir, rel);
      if (!fs.existsSync(full)) {
        problems.push(`${upstream}/${rel}: 清单里有，磁盘上没有`);
        continue;
      }
      const got = `sha256:${sha256(fs.readFileSync(full))}`;
      if (got !== want) problems.push(`${upstream}/${rel}: 被改过（清单 ${want.slice(0, 16)}… 实际 ${got.slice(0, 16)}…）`);
      checked += 1;
    }
    const onDisk = existingFiles(upstream);
    for (const rel of onDisk) {
      if (!(rel in manifest.files)) problems.push(`${upstream}/${rel}: 磁盘上有，清单里没有（手加的文件？）`);
    }
    rows.push({ upstream, checked, license: manifest.license, vendoredAt: manifest.vendoredAt });
  }
  return { problems, rows };
}

function main() {
  const sources = readSources();
  if (process.argv.includes("--check")) {
    const { problems, rows } = check();
    for (const r of rows) console.log(`✓ ${r.upstream.padEnd(12)} ${String(r.checked).padStart(3)} 个文件  ${r.license}  引入于 ${r.vendoredAt}`);
    if (problems.length) {
      console.error("\n✖ vendor 校验未通过（06 章 §4：vendor 只读，改动只能进 adapter）：");
      for (const p of problems) console.error(`  - ${p}`);
      console.error("\n确需更新上游内容：改 prompts/vendor/sources.json 后跑 node scripts/prompts/vendor-sync.mjs");
      process.exitCode = 1;
      return;
    }
    console.log("\nvendor 与清单一致：没有被手改，也没有清单外的文件。");
    return;
  }
  for (const s of sync(sources)) {
    console.log(`✎ ${s.upstream.padEnd(12)} ${String(s.count).padStart(3)} 个文件  ${(s.bytes / 1024).toFixed(1)} KB`);
  }
  console.log("\n已写入 prompts/vendor/*/UPSTREAM.json");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();