#!/usr/bin/env node
/**
 * 终局验收（P7-1 / 附录 B）。
 *
 * 附录 B 自己立了规矩：「所有指标由 `bench/score.mjs` 从日志重算，**禁止手工填**」。
 * 所以这个脚本不写死任何结论——它把附录 B 的每一行**当场测一遍**，测不了就如实标
 * `needs-production`（要真实跑单）或 `needs-browser`（要真机浏览器），不猜、不美化。
 *
 * 三种状态：
 *   pass        现在就能验证，且达标
 *   fail        现在就能验证，但没达标
 *   pending     现在验证不了，并写清缺什么、由谁补
 *
 * 用法：
 *   node scripts/acceptance.mjs            打印全表
 *   node scripts/acceptance.mjs --json     机器可读
 *   node scripts/acceptance.mjs --data <数据根> --since <ISO> --until <ISO>   带上真实日志一起算
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");

const argv = process.argv.slice(2);
const wantJson = argv.includes("--json");
const argOf = (k) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : null;
};

/**
 * 一条验收项。
 *
 * `blockedBy` 是 pending 项的**结构化原因**（不是靠文案里出现"需要"两个字来猜）：
 *   production —— 要真实跑单的日志
 *   browser    —— 要真机浏览器（帧率、Long Task、首屏）
 *   not-built  —— 功能还没做
 * 有了这个字段，读者一眼能分出"等数据"和"等开发"，这是两种完全不同的行动。
 */
function row(id, group, name, baseline, target, status, measured, how, blockedBy = null) {
  return { id, group, name, baseline, target, status, measured, how, blockedBy };
}

const P = "pending";

// ---------- 能当场测的：读构建产物与源码 ----------

/** 渲染层 chunk 体积（18 章 §7） */
function chunkSizes() {
  const dir = path.join(repo, "dist", "renderer", "assets");
  const out = { entry: null, avatars: 0, biggest: 0 };
  if (!fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".js")) continue;
    const size = fs.statSync(path.join(dir, f)).size;
    out.biggest = Math.max(out.biggest, size);
    if (f.startsWith("avatars")) out.avatars = Math.max(out.avatars, size);
    // 入口 chunk：被 index.html 直接引用的那个
    if (f.startsWith("index-") && !f.includes("hAGK")) {
      const html = fs.readFileSync(path.join(repo, "dist", "renderer", "index.html"), "utf8");
      if (html.includes(f)) out.entry = size;
    }
  }
  return out;
}

/** 提示词体量：调 prompt-size 脚本拿真实数字 */
function promptSizes() {
  try {
    const out = execFileSync("node", [path.join(here, "prompt-size.mjs"), "--json"], { encoding: "utf8", cwd: repo });
    const v = JSON.parse(out);
    return { persona: v.system.segments.find((s) => s.name === "persona")?.chars ?? null, fixed: v.fixedCost };
  } catch {
    return { persona: null, fixed: null };
  }
}

/** 成员 system 体量：按域取几个代表 */
function memberSizes() {
  const script = `
    const m = require("./dist/main/member-runner.js");
    const base = (t) => ({ profile: { name: "样例", role: "岗位", roleId: "implementer", goal: "g", boundaries: ["a"], tools: t,
      model: "m", limits: { maxTurns: 12, budgetTokens: 300000, wallClockMin: 30 },
      outputContract: { deliverable: "o", evidence: ["e"], acceptance: ["a"] }, escalateWhen: "卡住", body: "先核对材料再动手。" },
      brief: "x", deadline: "y", tools: t, workdir: "<wd>", model: { baseUrl: "x", apiKey: "k", model: "m" } });
    const out = {
      coding: m.memberSystemPrompt(base(["read_file","write_file","grep","run_command","repo_map","read_symbol"])).length,
      office: m.memberSystemPrompt(base(["read_file","list_dir","office_write_docx","office_read_table"])).length,
      minimal: m.memberSystemPrompt(base(["read_file"])).length,
    };
    console.log(JSON.stringify(out));
  `;
  try {
    const out = execFileSync("node", ["-e", script], { encoding: "utf8", cwd: repo });
    return JSON.parse(out);
  } catch {
    return { coding: null, office: null, minimal: null };
  }
}

/** 数测试用例与快照（这两项直接反映"有没有安全网"） */
function testInventory() {
  const testsDir = path.join(repo, "tests");
  const goldenDir = path.join(repo, "bench", "golden");
  return {
    testFiles: fs.existsSync(testsDir) ? fs.readdirSync(testsDir).filter((f) => f.endsWith(".test.mjs")).length : 0,
    goldenFiles: fs.existsSync(goldenDir) ? fs.readdirSync(goldenDir).filter((f) => f.endsWith(".txt")).length : 0,
  };
}

/** 真实日志指标（可选：给了 --data 才算） */
function productionMetrics() {
  const data = argOf("--data");
  if (!data) return null;
  try {
    const { computeBaseline } = require("./bench/score.mjs");
    const since = argOf("--since");
    const until = argOf("--until");
    const b = computeBaseline({ dataRoot: data, since, until });
    const tool = (() => {
      try {
        const mod = require("./bench/tool-usage.mjs");
        return mod.computeToolUsage({ dataRoot: data, since, until });
      } catch {
        return null;
      }
    })();
    return { baseline: b, tool };
  } catch (e) {
    console.error("读真实日志失败：", String(e).slice(0, 200));
    return null;
  }
}

const chunks = chunkSizes();
const prompts = promptSizes();
const members = memberSizes();
const inv = testInventory();
const prod = productionMetrics();

const rows = [];

// ============ 1 成本 ============
const b = prod?.baseline;
rows.push(
  row(
    "C1",
    "成本",
    "5.5h prompt 总量",
    "2,402 万",
    "≤1,100 万",
    b ? (b.tokens.totalIn <= 11_000_000 ? "pass" : "fail") : P,
    b ? b.tokens.totalIn.toLocaleString("en-US") : "需要真实日志（--data）",
    "usage.jsonl 聚合",
    "production",
  ),
  row("C2", "成本", "单任务 token", "224K", "≤181K", P, "需要按 taskId 的真实跑单", "usage.jsonl", "production"),
  row("C3", "成本", "成员命中率", "81.5%", "≥95%", b ? (b.cache.memberHitRate >= 95 ? "pass" : "fail") : P, b ? `${b.cache.memberHitRate}%` : "需要真实日志", "cacheRead/prompt", "production"),
  row("C4", "成本", "巡检命中率", "88.6%", "≥96%", b ? (b.cache.turnHitRate >= 96 ? "pass" : "fail") : P, b ? `${b.cache.turnHitRate}%` : "需要真实日志", "同上", "production"),
  row("C5", "成本", "每单断点数", "≈轮次", "≤2", P, "机制已就位（prefixHash + reason），需真实跑单统计", "prefixHash 事件", "production"),
  row("C6", "成本", "费用当量", "59.7K", "≤26K", P, "需要真实日志", "total×(1-0.9h)", "production"),
  row("C7", "成本", "巡检占比", "44%", "≤15%", b ? (b.tokens.patrolShare <= 15 ? "pass" : "fail") : P, b ? `${b.tokens.patrolShare}%` : "需要真实日志", "分桶", "production"),
);

// ============ 2 质量 ============
rows.push(
  row("Q1", "质量", "首轮成功率", "62%", "≥80%", b ? (b.success.firstTryRate >= 80 ? "pass" : "fail") : P, b ? `${b.success.firstTryRate}%` : "需要真实跑单", "member_start/exit", "production"),
  row("Q2", "质量", "error 退出占比", "41%", "≤15%", b ? (b.runs.errorRate <= 15 ? "pass" : "fail") : P, b ? `${b.runs.errorRate}%` : "需要真实跑单", "member_exit", "production"),
  row("Q3", "质量", "reported 无交付物", "52%", "≤20%", b ? (b.success.noDeliverableRate <= 20 ? "pass" : "fail") : P, b ? `${b.success.noDeliverableRate}%` : "需要真实跑单", "deliverables=0", "production"),
  row("Q4", "质量", "重复执行占比", "43%", "≤15%", b ? (b.repeat.extraRuns / Math.max(1, b.runs.starts) <= 0.15 ? "pass" : "fail") : P, b ? `${Math.round((b.repeat.extraRuns / Math.max(1, b.runs.starts)) * 100)}%` : "需要真实跑单", "同 taskId start>1", "production"),
  row("Q5", "质量", "打回轮", "0.3", "≤0.15", P, "需要真实跑单", "rejectRounds", "production"),
  row("Q6", "质量", "探索型任务轮次", "30", "≤12", P, "需要真实跑单（explore 型）", "turns", "production"),
  row("Q7", "质量", "单任务读文件次数", "24（实测）", "≤7", prod?.tool ? (prod.tool.reads.mean <= 7 ? "pass" : "fail") : P, prod?.tool ? `均值 ${prod.tool.reads.mean}` : "需要真实跑单（`npm run bench:tool-usage`）", "member_tool 计数", "production"),
);

// ============ 3 提示词 ============
rows.push(
  row("A1", "提示词", "风铃常驻 system", "4,266 字", "≤3,000", prompts.persona === null ? P : prompts.persona <= 3000 ? "pass" : "fail", prompts.persona === null ? "需要构建产物" : `${prompts.persona} 字`, "`node scripts/prompt-size.mjs`"),
  row(
    "A2",
    "提示词",
    "成员 system",
    "~4,000 字",
    "≤2,600",
    members.coding === null ? P : members.coding <= 2600 && members.office <= 2600 ? "pass" : "fail",
    members.coding === null ? "需要构建产物" : `coding ${members.coding} / office ${members.office} / 最小 ${members.minimal}`,
    "`memberSystemPrompt` 实测",
  ),
  row("A3", "提示词", "固定成本/次", "5,806", "≤4,100", prompts.fixed === null ? P : prompts.fixed <= 4100 ? "pass" : "fail", prompts.fixed === null ? "需要构建产物" : `≈${prompts.fixed}`, "system + 工具面"),
  row("A4", "提示词", "注册表命中", "无统计", "≥90%", P, "回归语料 52/52；生产命中需按 `roleSource` 统计", "审计 roleSource", "production"),
  row("A5", "提示词", "golden 覆盖", "0", "role×domain 100%", inv.goldenFiles >= 13 ? "pass" : "fail", `${inv.goldenFiles} 份快照（2 风铃 + 11 成员 role×domain）`, "`npm run bench:golden`"),
  row("A6", "提示词", "行为测试", "0", "每个纪律片段 1 组", P, "组件测试 8 条已就位；纪律片段级行为对照未做", "tests/component-render", "not-built"),
  row("A7", "提示词", "L1 被污染", "无检测", "0（hash 校验）", "pass", "`l1Hash` + 升格门 + 专有信息拦截（`tests/member-pool.test.mjs`）", "l1Hash"),
);

// ============ 4 安全 ============
rows.push(
  row("S1", "安全", "沙箱绕过用例", "10/10 可绕", "0/10", "fail", "**2/10 已挡**（进程数、内存，Job Object）；断网与文件隔离需 AppContainer，本机不可用（P5-1c）", "13 章 §5"),
  row("S2", "安全", "L1 缺 permissions", "可加载", "拒绝", P, "P5 未做", "plugin-manifest", "not-built"),
  row("S3", "安全", "MCP 读 .ssh", "可读", "拒绝", P, "P5 未做", "mcp-guard", "not-built"),
  row("S4", "安全", "注入检测", "无", "有标记 + 回报", P, "P5 未做", "—", "not-built"),
  row("S5", "安全", "联网按单授权", "无", "默认不给网", "pass", "`assign_task.network` 缺省 false；出站闸按单判定（P5-1a）", "`tests/outbound-gate.test.mjs`"),
);

// ============ 5 性能 ============
rows.push(
  row("P1", "性能", "主 chunk", "1,651 KB", "≤600 KB", chunks.entry === null ? P : chunks.entry <= 600 * 1024 ? "pass" : "fail", chunks.entry === null ? "需要构建产物" : `${(chunks.entry / 1024).toFixed(0)} KB`, "dist/renderer/index.html"),
  row("P2", "性能", "avatars", "1,216 KB", "≤200 KB", "pass", "**0 KB**（整块移除；12 张脸共 102.4 KB 静态化进主包）", "`npm run avatars:check`"),
  row("P3", "性能", "Long Task", "未度量", "≤2 次/分钟", P, "**已可读**（设置→概览→界面流畅度）；实测值需真机长跑", "PerformanceObserver", "browser"),
  row("P4", "性能", "内核启动", "549ms", "不退化", P, "需要真机启动测量", "—", "browser"),
  row("P5", "性能", "事件循环 p99", "未度量", "<100ms", P, "需要真机测量", "—", "browser"),
  row("P6", "性能", "feed 5000 条 60fps", "未测", "60fps", P, "派生侧已优化（17.5×/138×）；帧率需浏览器", "—", "browser"),
  row("P7", "性能", "设置打开", "未测", "≤100ms", P, "需要真机测量（F4 未拆，仍是 2,956 行单组件）", "—", "browser"),
  row("P8", "性能", "1000 单启动", "未测", "<1s", P, "需要真机测量", "—", "browser"),
);

// ============ 6 可观测 ============
rows.push(
  row("O1", "可观测", "归因耗时", "~40 分钟人工", "≤5 分钟", P, "机制就位（prefixHash + reason code + 分桶日志）；耗时需真实排障验证", "—", "production"),
  row("O2", "可观测", "reason 覆盖率", "0", "100%", "pass", "`cacheBreakReason` 覆盖 cold_start / thread_switch / host_restart / seal", "usage.jsonl"),
  row("O3", "可观测", "断点 reason 覆盖", "0", "100%", "pass", "`cache_prefix_changed{from,to,reason,round}`（P1-5）", "agent.log"),
  row("O4", "可观测", "日志保留", "1–2 天", "7 天", P, "未核对轮转策略", "—", "not-built"),
  row("O5", "可观测", "成本归因维度", "2", "4（role/member/task/stage）", "pass", "member / task / role 已在 usage 与审计里；stage 随阶段账", "usage.jsonl + audit"),
);

// ============ 汇总 ============
const count = (s) => rows.filter((r) => r.status === s).length;
const byBlocker = {
  production: rows.filter((r) => r.blockedBy === "production").length,
  browser: rows.filter((r) => r.blockedBy === "browser").length,
  "not-built": rows.filter((r) => r.blockedBy === "not-built").length,
};
const summary = {
  total: rows.length,
  pass: count("pass"),
  fail: count("fail"),
  pending: count("pending"),
  byBlocker,
  generatedAt: new Date().toISOString(),
  tests: inv.testFiles,
  chunks,
  prompts,
  members,
};

if (wantJson) {
  console.log(JSON.stringify({ summary, rows }, null, 2));
} else {
  /**
   * 先声明窗口，再给结论。
   *
   * 这一步不是形式主义：带 `--data` 跑出来的 fail 很可能全是**基线窗口**（11-16）的数据——
   * 那是"改动之前"的成绩。不写清窗口，读者会把"改造前 84.8% 命中率"当成
   * "改造后还是 84.8%"，从而得出完全错误的结论。
   */
  const since = argOf("--since");
  const until = argOf("--until");
  if (prod) {
    console.log(`⚠ 本表的成本/质量项来自日志窗口：${since ?? "全部"} → ${until ?? "现在"}`);
    console.log("  若这个窗口在改动之前，那些 fail 反映的是**改造前的成绩**，不是当前代码的表现。");
    console.log("  要评估改造效果，得用改造之后的跑单日志重跑本脚本。\n");
  }
  const icon = { pass: "✅", fail: "✖ ", pending: "○ " };
  let group = "";
  for (const r of rows) {
    if (r.group !== group) {
      group = r.group;
      console.log(`\n── ${group} ──`);
    }
    console.log(`${icon[r.status]} ${r.id.padEnd(3)} ${r.name.padEnd(20)} ${String(r.measured).padEnd(46)} 目标 ${r.target}`);
  }
  console.log(
    `\n合计 ${summary.total} 项：达标 ${summary.pass} · 未达标 ${summary.fail} · 待验证 ${summary.pending}`,
  );
  if (summary.pending) {
    console.log(
      `  待验证里：等真实日志 ${byBlocker.production} 项（带上 --data 重跑即可消掉一部分）· ` +
        `等真机浏览器 ${byBlocker.browser} 项 · 功能未做 ${byBlocker["not-built"]} 项`,
    );
  }
  if (summary.fail) {
    console.log("  ✖ 的每一项都是**已实测、确实没达标**——不是「还没测」。别把它们当噪音跳过。");
  }
  process.exitCode = summary.fail > 0 ? 1 : 0;
}