#!/usr/bin/env node
/**
 * 基线打分（P0-2）：从 ~/.lynn 的日志与工单算指标，输出 JSON。
 *
 * 纯读：不写数据根，不联网。`--out` 只写到指定路径。
 *
 * 用法：
 *   node scripts/bench/score.mjs
 *   node scripts/bench/score.mjs --since 2026-11-16T04:20 --until 2026-11-16T10:00
 *   node scripts/bench/score.mjs --out bench/baseline.json
 *
 * 口径（与 docs/plan/01-baseline-and-logs.md 一致）：
 *   - 首轮成功 = 该 taskId 第一次 member_exit 为 reported 且 reportChars ≥ 300
 *   - 无交付物 = reported 但 deliverables 与 evidence 都为空
 *   - 命中率 = cacheRead / in（累计）
 *   - 重复执行 = 同一 taskId 的 start 次数 > 1 的额外次数
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MIN_REPORT_CHARS = 300;

function resolveDataRoot(explicit) {
  if (explicit) return explicit;
  if (process.env.LYNN_DATA_ROOT) return process.env.LYNN_DATA_ROOT;
  return path.join(os.homedir(), ".lynn");
}

function readJsonl(file) {
  const out = { rows: [], bad: 0 };
  if (!fs.existsSync(file)) return out;
  const text = fs.readFileSync(file, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim();
    if (!s.startsWith("{")) continue;
    try {
      out.rows.push(JSON.parse(s));
    } catch {
      out.bad += 1;
    }
  }
  return out;
}

function readTasks(dir) {
  const rows = [];
  if (!fs.existsSync(dir)) return rows;
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name, "task.json");
    if (!fs.existsSync(file)) continue;
    try {
      rows.push(JSON.parse(fs.readFileSync(file, "utf8")));
    } catch {
      /* 坏工单跳过 */
    }
  }
  return rows;
}

function inWindow(at, since, until) {
  if (!at) return false;
  if (since && at < since) return false;
  if (until && at > until) return false;
  return true;
}

function pct(n, d) {
  return d > 0 ? Math.round((n / d) * 1000) / 10 : 0;
}

function quantile(sorted, q) {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * q)));
  return sorted[i];
}

/**
 * 纯函数：给数据根与窗口，算出基线对象。
 * 单测直接调用它，CLI 只是包装。
 */
export function computeBaseline({ dataRoot, since = null, until = null } = {}) {
  const root = resolveDataRoot(dataRoot);
  const log = readJsonl(path.join(root, "logs", "agent.log"));
  const usageFile = readJsonl(path.join(root, "logs", "usage.jsonl"));
  const tasks = readTasks(path.join(root, "tasks"));

  const ev = log.rows.filter((e) => inWindow(e.at, since, until));
  const usage = usageFile.rows.filter((e) => inWindow(e.at, since, until));

  // ---- 任务状态 ----
  const byStatus = {};
  for (const t of tasks) byStatus[t.status ?? "unknown"] = (byStatus[t.status ?? "unknown"] ?? 0) + 1;
  const done = byStatus.done ?? 0;

  // ---- 执行（run 序列） ----
  const startsByTask = new Map();
  const exitsByTask = new Map();
  const exitStatus = {};
  let exits = 0;
  let starts = 0;
  const turnList = [];

  for (const e of ev) {
    if (e.kind === "member_start" && e.taskId) {
      starts += 1;
      startsByTask.set(e.taskId, (startsByTask.get(e.taskId) ?? 0) + 1);
    }
    if (e.kind === "member_exit" && e.taskId) {
      exits += 1;
      const st = e.status ?? "unknown";
      exitStatus[st] = (exitStatus[st] ?? 0) + 1;
      if (!exitsByTask.has(e.taskId)) exitsByTask.set(e.taskId, []);
      exitsByTask.get(e.taskId).push(e);
      if (typeof e.turns === "number") turnList.push(e.turns);
    }
  }

  // ---- 首轮成功 / 无交付物 ----
  let firstTry = 0;
  let firstTryDenom = 0;
  let noDeliverable = 0;
  let reported = 0;
  for (const list of exitsByTask.values()) {
    const first = list[0];
    firstTryDenom += 1;
    if (first.status === "reported" && (first.reportChars ?? 0) >= MIN_REPORT_CHARS) firstTry += 1;
    for (const e of list) {
      if (e.status !== "reported") continue;
      reported += 1;
      /**
       * 口径：事件里的 deliverables / evidence 是**数量**（number）。
       * 「无交付物」只认 deliverables = 0 —— 证据（evidence）不是交付物，
       * 这与 08/09 章「证据不算交付」一致；用户要带走的东西才算。
       */
      if (Number(e.deliverables ?? 0) === 0) noDeliverable += 1;
    }
  }

  // ---- token 与命中率 ----
  const bucket = (kind) => {
    const rows = usage.filter((u) => (kind === "member" ? u.kind === "member" : u.kind === kind));
    const inTok = rows.reduce((s, u) => s + (u.in ?? 0), 0);
    const outTok = rows.reduce((s, u) => s + (u.out ?? 0), 0);
    const hit = rows.reduce((s, u) => s + (u.cacheRead ?? 0), 0);
    return { calls: rows.length, in: inTok, out: outTok, cacheRead: hit, hitRate: pct(hit, inTok) };
  };
  const memberTok = bucket("member");
  const turnTok = bucket("turn");
  /**
   * 口径修正（2026-11-17 实测）：usage.jsonl 的 `kind:"turn"` 就是巡检/主会话回合的记账
   * （496 次 ≈ 巡检 491 次），与 agent.log 的 `usage_patrol` 是同一批数据的两种记法。
   * 所以 **total = member + turn**，不能再叠加 patrol，否则重复计 1,000 万。
   * patrol 只作为明细用于核对（--verbose 时可对比）。
   */
  const patrolRows = ev.filter((e) => e.kind === "usage_patrol");
  const patrolIn = patrolRows.reduce((s, e) => s + (e.in ?? 0), 0);
  const patrolOut = patrolRows.reduce((s, e) => s + (e.out ?? 0), 0);
  const patrolHit = patrolRows.reduce((s, e) => s + (e.cacheRead ?? 0), 0);
  const patrolDetail = { calls: patrolRows.length, in: patrolIn, out: patrolOut, cacheRead: patrolHit, hitRate: pct(patrolHit, patrolIn) };

  // 成员命中率另有"按 exit 平均"口径（老数据带 hitRate 字段，新数据不一定有）
  const exitHitRates = [];
  for (const list of exitsByTask.values()) {
    for (const e of list) if (typeof e.hitRate === "number") exitHitRates.push(e.hitRate);
  }
  const memberHitRateAvg = exitHitRates.length
    ? Math.round((exitHitRates.reduce((a, b) => a + b, 0) / exitHitRates.length) * 10) / 10
    : null;

  // ---- 重复执行 ----
  let multiRunTasks = 0;
  let extraRuns = 0;
  for (const n of startsByTask.values()) {
    if (n > 1) {
      multiRunTasks += 1;
      extraRuns += n - 1;
    }
  }
  // 额外执行的 token 估算：用成员平均单 run token × 额外 run
  const avgRunTokens = starts > 0 ? Math.round(memberTok.in / starts) : 0;

  // ---- 断点原因 ----
  const breaks = {};
  for (const u of usage) {
    if (u.cacheBreakReason) breaks[u.cacheBreakReason] = (breaks[u.cacheBreakReason] ?? 0) + 1;
  }

  // ---- 轮次分布 ----
  turnList.sort((a, b) => a - b);
  const turnStats = {
    mean: turnList.length ? Math.round(turnList.reduce((a, b) => a + b, 0) / turnList.length) : 0,
    p50: quantile(turnList, 0.5),
    p90: quantile(turnList, 0.9),
    max: turnList.length ? turnList[turnList.length - 1] : 0,
  };

  return {
    generatedAt: new Date().toISOString(),
    window: { since, until, dataRoot: root },
    parse: { logRows: log.rows.length, badLogLines: log.bad, usageRows: usageFile.rows.length, badUsageLines: usageFile.bad },
    tasks: { total: tasks.length, byStatus, doneRate: pct(done, tasks.length) },
    runs: { starts, exits, byStatus: exitStatus, errorRate: pct(exitStatus.error ?? 0, exits) },
    success: {
      firstTry,
      firstTryDenom,
      firstTryRate: pct(firstTry, firstTryDenom),
      reported,
      noDeliverable,
      noDeliverableRate: pct(noDeliverable, reported),
    },
    tokens: {
      member: memberTok,
      turn: turnTok,
      patrolDetail,
      totalIn: memberTok.in + turnTok.in,
      patrolShare: pct(turnTok.in, memberTok.in + turnTok.in),
    },
    cache: {
      memberHitRate: memberTok.hitRate,
      memberHitRateAvg,
      turnHitRate: turnTok.hitRate,
      patrolDetailHitRate: patrolDetail.hitRate,
      breaks,
    },
    repeat: { multiRunTasks, extraRuns, avgRunTokens, extraTokenEstimate: extraRuns * avgRunTokens },
    turns: turnStats,
  };
}

function parseArgs(argv) {
  const out = { since: null, until: null, dataRoot: null, out: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === "--since") (out.since = next), (i += 1);
    else if (a === "--until") (out.until = next), (i += 1);
    else if (a === "--data") (out.dataRoot = next), (i += 1);
    else if (a === "--out") (out.out = next), (i += 1);
  }
  return out;
}

function printHuman(r) {
  const f = (n) => new Intl.NumberFormat("en-US").format(n);
  const lines = [
    `窗口：${r.window.since ?? "全部"} → ${r.window.until ?? "现在"}`,
    `工单：${r.tasks.total} 张，完成 ${r.tasks.byStatus.done ?? 0}（${r.tasks.doneRate}%）`,
    `执行：start ${r.runs.starts} / exit ${r.runs.exits}，error ${r.runs.errorRate}%`,
    `首轮成功：${r.success.firstTry}/${r.success.firstTryDenom}（${r.success.firstTryRate}%）`,
    `无交付物：${r.success.noDeliverable}/${r.success.reported}（${r.success.noDeliverableRate}%）`,
    `token：成员 ${f(r.tokens.member.in)}（命中 ${r.cache.memberHitRate}% 加权 / ${r.cache.memberHitRateAvg ?? "—"}% 按单）· 巡检 ${f(r.tokens.turn.in)}（${r.cache.turnHitRate}%）· 合计 ${f(r.tokens.totalIn)}`,
    `巡检占比：${r.tokens.patrolShare}%（明细 ${f(r.tokens.patrolDetail.in)}，${r.tokens.patrolDetail.calls} 次调用）`,
    `重复执行：${r.repeat.multiRunTasks} 张单、额外 ${r.repeat.extraRuns} 次、约 ${f(r.repeat.extraTokenEstimate)} tokens`,
    `轮次：mean ${r.turns.mean} / p50 ${r.turns.p50} / p90 ${r.turns.p90} / max ${r.turns.max}`,
    `断点：${Object.entries(r.cache.breaks).map(([k, v]) => `${k}=${v}`).join(" ") || "无"}`,
  ];
  return lines.join("\n");
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}` || process.argv[1]?.endsWith("score.mjs")) {
  const args = parseArgs(process.argv.slice(2));
  const result = computeBaseline({ dataRoot: args.dataRoot, since: args.since, until: args.until });
  if (args.out) {
    fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
    fs.writeFileSync(path.resolve(args.out), `${JSON.stringify(result, null, 2)}\n`, "utf8");
    console.log(`已写入 ${args.out}`);
  }
  console.log(printHuman(result));
}
