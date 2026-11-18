#!/usr/bin/env node
/**
 * 单任务工具用量（P4-1 验收尺子 / 10 章 §9）。
 *
 * 为什么需要单独一个脚本：10 章把「读文件次数/任务 15 → ≤7」「单任务工具轮次 17 → ≤12」
 * 写成了验收线，但这两个数**只在真实跑单里才存在**，离线造不出来。没有量尺的时候，
 * 符号工具上线与否只能靠感觉；有了它，改动前后跑同一段日志就能直接对照。
 *
 * 数据源：`agent.log` 的 `member_tool` 事件（内核已有，字段 taskId / member / tool / ok / ms）。
 * 纯读，不联网、不写数据根。
 *
 * 用法：
 *   node scripts/bench/tool-usage.mjs
 *   node scripts/bench/tool-usage.mjs --since 2026-11-16T04:20 --until 2026-11-16T10:00
 *   node scripts/bench/tool-usage.mjs --json
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TARGET = { reads: 7, turns: 12 };
const BASELINE = { reads: 15, turns: 17 };

/** 与 score.mjs 同口径的数据根解析 */
function resolveDataRoot(explicit) {
  if (explicit) return explicit;
  if (process.env.LYNN_DATA_ROOT) return process.env.LYNN_DATA_ROOT;
  return path.join(os.homedir(), ".lynn");
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const s = line.trim();
    if (!s.startsWith("{")) continue;
    try {
      out.push(JSON.parse(s));
    } catch {
      /* 坏行跳过 */
    }
  }
  return out;
}

function inWindow(at, since, until) {
  if (!at) return false;
  if (since && at < since) return false;
  if (until && at > until) return false;
  return true;
}

const pct = (n, d) => (d > 0 ? Math.round((n / d) * 1000) / 10 : 0);
const median = (arr) => {
  if (!arr.length) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  const i = Math.floor((s.length - 1) / 2);
  return s.length % 2 ? s[i] : Math.round((s[i] + s[i + 1]) / 2);
};
const mean = (arr) => (arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0);

/**
 * 纯函数：从日志行算出按任务的工具用量。单测直接调它。
 *
 * 「工具轮次」的口径：一次工具调用 = 一轮（模型出 tool_call → 工具返回）。
 * 这与 10 章的 17 次同口径；同一工具连调两次算两轮。
 */
export function computeToolUsage({ dataRoot, since = null, until = null } = {}) {
  const root = resolveDataRoot(dataRoot);
  const rows = readJsonl(path.join(root, "logs", "agent.log")).filter(
    (e) => e.kind === "member_tool" && inWindow(e.at, since, until),
  );

  const byTask = new Map();
  for (const r of rows) {
    if (!r.taskId) continue;
    const t = byTask.get(r.taskId) ?? { taskId: r.taskId, members: new Set(), calls: 0, reads: 0, byTool: {} };
    t.calls += 1;
    t.members.add(r.member ?? "?");
    if (r.tool === "read_file") t.reads += 1;
    t.byTool[r.tool] = (t.byTool[r.tool] ?? 0) + 1;
    byTask.set(r.taskId, t);
  }

  const tasks = [...byTask.values()].map((t) => ({
    taskId: t.taskId,
    members: [...t.members],
    calls: t.calls,
    reads: t.reads,
    byTool: t.byTool,
  }));
  const reads = tasks.map((t) => t.reads);
  const calls = tasks.map((t) => t.calls);
  const withSymbols = tasks.filter((t) => t.byTool.read_symbol || t.byTool.repo_map || t.byTool.find_symbol).length;

  return {
    window: { since, until, dataRoot: root },
    tasks: tasks.length,
    reads: { mean: mean(reads), median: median(reads), max: reads.length ? Math.max(...reads) : 0, underTarget: reads.filter((n) => n <= TARGET.reads).length },
    turnsPerTask: { mean: mean(calls), median: median(calls), max: calls.length ? Math.max(...calls) : 0, underTarget: calls.filter((n) => n <= TARGET.turns).length },
    /** 用过符号工具的任务数：这是「符号能力有没有真被用起来」最直接的信号 */
    symbolTasks: withSymbols,
    topTools: Object.entries(
      tasks.reduce((acc, t) => {
        for (const [k, v] of Object.entries(t.byTool)) acc[k] = (acc[k] ?? 0) + v;
        return acc;
      }, {}),
    )
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10),
    detail: tasks.sort((a, b) => b.reads - a.reads).slice(0, 10),
  };
}

function parseArgs(argv) {
  const out = { since: null, until: null, dataRoot: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--since") (out.since = argv[i + 1]), (i += 1);
    else if (a === "--until") (out.until = argv[i + 1]), (i += 1);
    else if (a === "--data") (out.dataRoot = argv[i + 1]), (i += 1);
  }
  return out;
}

function printHuman(r) {
  if (!r.tasks) {
    console.log("窗口内没有 member_tool 记录（这一版日志格式之前跑的单量不出来）");
    return;
  }
  const line = (label, v, target, baseline) =>
    `  ${label.padEnd(14)} 均值 ${String(v.mean).padStart(3)} · 中位 ${String(v.median).padStart(3)} · 最大 ${String(v.max).padStart(3)}` +
    ` · 达标 ${v.underTarget}/${r.tasks}（${pct(v.underTarget, r.tasks)}%）  目标 ≤${target}（基线 ${baseline}）`;
  console.log(`窗口：${r.window.since ?? "全部"} → ${r.window.until ?? "现在"}（${r.tasks} 张单有工具记录）`);
  console.log(line("读文件/任务", r.reads, TARGET.reads, BASELINE.reads));
  console.log(line("工具轮次/任务", r.turnsPerTask, TARGET.turns, BASELINE.turns));
  console.log(`  用过符号工具的单：${r.symbolTasks}/${r.tasks}`);
  console.log(`\n最常用的工具：${r.topTools.map(([k, v]) => `${k}×${v}`).join("  ")}`);
  console.log("\n读文件最多的 10 张单：");
  for (const t of r.detail) {
    console.log(`  ${String(t.reads).padStart(3)} 次读 / ${String(t.calls).padStart(3)} 轮  ${t.taskId}  ${t.members.join("、")}`);
  }
}

if (process.argv[1] && (process.argv[1].endsWith("tool-usage.mjs") || process.argv[1].replace(/\\/g, "/").endsWith("/tool-usage.mjs"))) {
  const args = parseArgs(process.argv.slice(2));
  const result = computeToolUsage(args);
  if (process.argv.includes("--json")) console.log(JSON.stringify(result, null, 2));
  else printHuman(result);
}