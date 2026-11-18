#!/usr/bin/env node
/**
 * system prompt golden 快照（P2-1c）。
 *
 * 为什么需要：`compileLynnPrompt` 已经接管了 system prompt 的组装，但**没有兜底**——
 * 改 persona、改段序、调记忆格式，全都可以悄悄改变每次请求的前缀，却没有任何东西会失败。
 * 05 章 §3 的规则是「编译结果必须可 golden 快照」，§2 的三刀（persona 43→29 条等）
 * 也写明「压缩某段时必须先有 golden 兜底」。所以这个脚本先行。
 *
 * 快照内容刻意**不含**运行期会变的东西（记忆正文、项目路径、环境事实）：
 * 那几段用固定占位符，快照锁的是「代码写死的文本 + 段的顺序 + 分隔行为」。
 * 记忆/项目段的长度由 `scripts/prompt-size.mjs` 负责量，不在这里快照。
 *
 * 用法：
 *   node scripts/bench/golden.mjs            # 打印与快照的差异（不改文件）
 *   node scripts/bench/golden.mjs --write    # 更新快照（改提示词后必须显式做这一步）
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { compileLynnPrompt, estimateTokens } = require("../../dist/main/prompt-compiler.js");
const { DEFAULT_PERSONA, composeSystemPrompt } = require("../../dist/main/persona.js");
const { memberSystemPrompt } = require("../../dist/main/member-runner.js");
const { ROLE_REGISTRY } = require("../../dist/main/role-registry.js");

const here = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN_DIR = path.resolve(here, "../../bench/golden");

/** 占位符要显眼：万一被塞进真实数据，diff 里一眼能看出来 */
const PLACEHOLDER = {
  memory: "【记忆段占位·golden 不含真实记忆】\n- 助理记忆 1 条\n- 用户偏好 1 条\n- 项目记忆 1 条\n",
  project: "【项目段占位】当前项目：golden-fixture\n",
  environment: "【环境段占位】数据根：<data-root>\n",
};

/** 每种场景用哪些段 → 用来锁「空段不多产生空行」与「顺序固定」 */
export function goldenScenarios() {
  const persona = composeSystemPrompt(DEFAULT_PERSONA);
  return [
    {
      name: "default",
      note: "无写作规则插件（rules 为空）：输出必须与「从来没有这个功能」完全一致",
      parts: { persona, ...PLACEHOLDER, rules: "" },
    },
    {
      name: "with-rules",
      note: "装了写作规则插件（rules 非空）：规则段追加在最后，前面逐字节不变",
      parts: { persona, ...PLACEHOLDER, rules: "【写作规则占位】去 AI 味：不用「赋能」这类词。\n" },
    },
  ];
}

/** 生成一份快照（含头信息）与它的元数据 */
export function buildGolden(scenario) {
  const compiled = compileLynnPrompt(scenario.parts);
  const header = [
    `# golden: 风铃 system prompt / 场景=${scenario.name}`,
    `# ${scenario.note}`,
    "#",
    "# 更新方式：node scripts/bench/golden.mjs --write",
    "# 改动提示词是允许的——但要在这里的 diff 里看清楚「哪一段变了、为什么」，",
    "# 并在 docs/plan/PROGRESS.md 的变更日志里写一行。",
    `# digest=${compiled.digest} chars=${compiled.chars} tokens≈${estimateTokens(compiled.text)}`,
    `# segments=${compiled.segments.map((s) => `${s.name}:${s.chars}`).join(" ")}`,
    "---------- 8< ----------",
    "",
  ].join("\n");
  return {
    scenario: scenario.name,
    meta: compiled,
    file: path.join(GOLDEN_DIR, `lynn-system.${scenario.name}.txt`),
    content: header + compiled.text + "\n",
  };
}

export function buildAll() {
  return goldenScenarios().map((s) => buildGolden(s));
}

/**
 * 成员 system prompt 的 golden（P3-1b / 07 章 §4 G3「每 role×domain 至少 1 个 golden」）。
 *
 * 为什么用固定夹具而不是真实档案：golden 锁的是**我们写死的文本与段序**，
 * 不是某个人的岗位说明。真实档案会让快照随人员变动而变，diff 就没人看了。
 * 每个注册表角色取一张：能力域用它声明的第一个，工具面按域给一套有代表性的。
 */
const MEMBER_FIXTURE = {
  name: "样例成员",
  role: "样例岗位",
  goal: "对某一类结果负责",
  boundaries: ["只动工作区", "不装依赖"],
  model: "fixture-model",
  limits: { maxTurns: 12, budgetTokens: 300000, wallClockMin: 30 },
  outputContract: { deliverable: "out.md", evidence: ["报告文件"], acceptance: ["数字可对账"] },
  escalateWhen: "材料缺失或口径冲突",
  body: "先核对材料再动手；结论只写能复核的部分。",
};

/** 按能力域给一套有代表性的工具面（决定了哪些纪律段会出现） */
function toolsForDomain(domain) {
  if (domain === "office") return ["read_file", "list_dir", "office_write_docx", "office_read_table"];
  if (domain === "coding") return ["read_file", "write_file", "grep", "run_command", "repo_map", "read_symbol"];
  if (domain === "research") return ["read_file", "list_dir", "grep"];
  return ["read_file", "list_dir", "run_command"];
}

export function memberScenarios() {
  return ROLE_REGISTRY.map((spec) => {
    const domain = spec.domains[0] ?? "general";
    return {
      roleId: spec.roleId,
      domain,
      tools: toolsForDomain(domain),
      profile: { ...MEMBER_FIXTURE, roleId: spec.roleId },
    };
  });
}

export function buildMemberGolden(scenario) {
  const text = memberSystemPrompt({
    profile: { ...scenario.profile, tools: scenario.tools },
    brief: "【目标】固定夹具，不参与快照\n【完成标准】…\n【材料与位置】…\n【限制】…",
    deadline: "夹具截止",
    tools: scenario.tools,
    workdir: "<workdir>",
    model: { baseUrl: "http://fixture", apiKey: "k", model: "fixture-model" },
  });
  const header = [
    `# golden: 成员 system prompt / role=${scenario.roleId} domain=${scenario.domain} tools=${scenario.tools.length}`,
    "#",
    "# 锁的是我们写死的文本 + 段序 + 按工具面的裁剪结果；不含任何真实档案或任务信息。",
    "# 更新方式：node scripts/bench/golden.mjs --write",
    `# chars=${text.length} tokens≈${estimateTokens(text)}`,
    "---------- 8< ----------",
    "",
  ].join("\n");
  // 工作区路径是夹具里的固定串，仍然脱一下，避免有人误以为快照含真实路径
  return {
    scenario: `member.${scenario.roleId}`,
    meta: { chars: text.length, digest: "" },
    file: path.join(GOLDEN_DIR, `member.${scenario.roleId}.${scenario.domain}.txt`),
    content: header + text.replace(/<workdir>/g, "<workdir>") + "\n",
  };
}

export function buildAllMember() {
  return memberScenarios().map((s) => buildMemberGolden(s));
}

function main() {
  const write = process.argv.includes("--write");
  fs.mkdirSync(GOLDEN_DIR, { recursive: true });
  let stale = 0;
  for (const g of [...buildAll(), ...buildAllMember()]) {
    const exists = fs.existsSync(g.file);
    const same = exists && fs.readFileSync(g.file, "utf8") === g.content;
    if (same) {
      console.log(`✓ ${path.relative(path.resolve(here, "../.."), g.file)} 一致（${g.meta.chars} 字符，digest ${g.meta.digest}）`);
      continue;
    }
    stale += 1;
    if (write) {
      fs.writeFileSync(g.file, g.content, "utf8");
      console.log(`✎ 已写入 ${path.relative(path.resolve(here, "../.."), g.file)}（${g.meta.chars} 字符，digest ${g.meta.digest}）`);
    } else {
      console.log(`✖ 与快照不一致：${path.relative(path.resolve(here, "../.."), g.file)}${exists ? "" : "（文件不存在）"}`);
    }
  }
  if (!write && stale > 0) {
    console.log("\n确认这次变化是有意的，再执行：node scripts/bench/golden.mjs --write");
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
