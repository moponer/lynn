// 后端实测：真实 Kernel + 本地 mock 模型（无外部费用），量延迟/吞吐/资源/token/缓存/失败恢复。
// 用法：node scripts/eval/backend.mjs
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

const require = createRequire(import.meta.url);
const { spawn } = require("node:child_process");

const repo = path.resolve(import.meta.dirname, "..", "..");
const outDir = path.join(repo, "perf", "eval");
const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
fs.mkdirSync(outDir, { recursive: true });

/** 独立进程起 mock：被测内核的 CPU/内存不包含 HTTP 服务端开销 */
function startMockProcess(opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(import.meta.dirname, "mock-server.cjs"), JSON.stringify(opts)], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    let buf = "";
    const onData = (d) => {
      buf += d.toString();
      const line = buf.split("\n")[0];
      if (!line) return;
      try {
        const info = JSON.parse(line);
        child.stdout.off("data", onData);
        const control = `${info.baseUrl.replace(/\/v1$/, "")}/__control`;
        resolve({
          baseUrl: info.baseUrl,
          setMode: async (mode) => {
            await fetch(control, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ mode }),
            });
          },
          requests: async () => {
            const r = await fetch(control);
            const j = await r.json();
            return j.requests ?? 0;
          },
          close: () =>
            new Promise((done) => {
              child.once("exit", () => done());
              child.kill();
            }),
        });
      } catch {
        /* 继续等完整一行 */
      }
    };
    child.stdout.on("data", onData);
    child.on("error", reject);
  });
}

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-eval-"));
const project = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-eval-proj-"));
process.env.LYNN_HOME = dataRoot;
process.env.LYNN_PROJECT_DIR = project;
process.env.NODE_TEST_CONTEXT = "eval"; // 强制直连，不冷启动 Pi worker

const { Kernel } = await import(pathToFileURL(path.join(repo, "dist/main/kernel.js")).href);
const { runMemberTask } = await import(pathToFileURL(path.join(repo, "dist/main/member-runner.js")).href);
const { Toolkit } = await import(pathToFileURL(path.join(repo, "dist/main/toolkit.js")).href);

function writeSettings(baseUrl) {
  const at = new Date().toISOString();
  const entry = {
    id: "m-mock",
    label: "Mock",
    provider: "Mock",
    baseUrl,
    model: "mock-1",
    apiKey: { encrypted: false, data: "mock-key" },
    updatedAt: at,
  };
  fs.writeFileSync(
    path.join(dataRoot, "settings.json"),
    JSON.stringify(
      {
        model: entry,
        models: [entry],
        defaultModelId: "m-mock",
        prefs: { heartbeat: false, supervisor: false, autoStart: false },
      },
      null,
      2,
    ),
    "utf-8",
  );
}

function snapshot(k) {
  return k.handle("session.snapshot");
}

/** 一轮对话：resolves {status, ttftMs, totalMs, reply, usage} */
function turn(k, text, opts = {}) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    let ttft = null;
    let settled = false;
    const timeout = setTimeout(() => finish("timeout"), opts.timeoutMs ?? 30_000);
    const off = k.onEvent((ev) => {
      if (ev.type === "delta" && ev.text && ttft === null) ttft = performance.now();
      if (ev.type === "error") finish("error", ev.message);
      if (ev.type === "done") finish("done");
    });
    const finish = (status, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      off();
      const total = performance.now() - t0;
      const snap = snapshot(k);
      const last = [...snap.feed].reverse().find((c) => c.kind === "lynn");
      resolve({
        status,
        error,
        ttftMs: ttft === null ? null : Math.round(ttft - t0),
        totalMs: Math.round(total),
        reply: (last?.text ?? "").slice(0, 200),
        usage: snap.usage,
      });
    };
    k.handle("feed.send", { text });
  });
}

function pct(values, p) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[i];
}

function cpuMs() {
  const u = process.cpuUsage();
  return (u.user + u.system) / 1000;
}

const results = { at: new Date().toISOString(), dataRoot, project, cases: {} };

// ---------- 1) 冷启动 + 10 轮串行对话 ----------
{
  const mock = await startMockProcess({ mode: "ok", chunks: 3, usage: { prompt_tokens: 1200, completion_tokens: 24, prompt_cache_hit_tokens: 900, prompt_cache_miss_tokens: 300 } });
  writeSettings(mock.baseUrl);
  const mem0 = process.memoryUsage();
  const cpu0 = cpuMs();
  const t0 = performance.now();
  const k = new Kernel(dataRoot);
  await k.init();
  const initMs = Math.round(performance.now() - t0);
  const lat = [];
  let firstTurn;
  const loopCpu0 = cpuMs();
  const loop0 = performance.now();
  for (let i = 0; i < 10; i += 1) {
    const r = await turn(k, `第 ${i + 1} 轮：只回复“收到”。`);
    if (i === 0) firstTurn = r;
    if (r.status === "done") lat.push(r);
  }
  const loopMs = performance.now() - loop0;
  const elapsed = performance.now() - t0;
  const mem1 = process.memoryUsage();
  const cpu = cpuMs() - cpu0;
  results.cases.serial = {
    initMs,
    turns: lat.length,
    ttftMs: { p50: pct(lat.map((x) => x.ttftMs ?? 0), 50), p95: pct(lat.map((x) => x.ttftMs ?? 0), 95) },
    totalMs: { p50: pct(lat.map((x) => x.totalMs), 50), p95: pct(lat.map((x) => x.totalMs), 95) },
    turnsPerSec: Math.round((lat.length / loopMs) * 1000 * 100) / 100,
    cpuMs: Math.round(cpu),
    cpuPctOfWall: Math.round((cpu / elapsed) * 1000) / 10,
    loopCpuMs: Math.round(cpuMs() - loopCpu0),
    loopCpuPct: Math.round(((cpuMs() - loopCpu0) / loopMs) * 1000) / 10,
    rssDeltaMB: Math.round(((mem1.rss - mem0.rss) / 1024 / 1024) * 10) / 10,
    heapDeltaMB: Math.round(((mem1.heapUsed - mem0.heapUsed) / 1024 / 1024) * 10) / 10,
    tokenUsage: firstTurn?.usage,
    requestsToModel: await mock.requests(),
  };
  await k.dispose();
  await mock.close();
}

// ---------- 2) 一致性：同一 prompt ×5 ----------
{
  const mock = await startMockProcess({ mode: "ok", chunks: 4, reply: "一致性与正确性检查：Lynn-OK-42" });
  writeSettings(mock.baseUrl);
  const k = new Kernel(dataRoot);
  await k.init();
  const outs = [];
  for (let i = 0; i < 5; i += 1) outs.push(await turn(k, "同一问题：只回复固定串。"));
  const replies = outs.map((o) => o.reply);
  results.cases.consistency = {
    runs: outs.length,
    uniqueReplies: new Set(replies).size,
    allSame: new Set(replies).size === 1,
    expected: "一致性与正确性检查：Lynn-OK-42",
    matchesExpected: replies.every((r) => r === "一致性与正确性检查：Lynn-OK-42"),
    totalMs: outs.map((o) => o.totalMs),
    stdevMs: (() => {
      const xs = outs.map((o) => o.totalMs);
      const m = xs.reduce((a, b) => a + b, 0) / xs.length;
      return Math.round(Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length));
    })(),
  };
  await k.dispose();
  await mock.close();
}

// ---------- 3) 失败与恢复：500 → 恢复；429；中止 ----------
{
  const mock = await startMockProcess({ mode: "fail500", chunkDelayMs: 30, chunks: 30 });
  writeSettings(mock.baseUrl);
  const k = new Kernel(dataRoot);
  await k.init();
  const fail = await turn(k, "这轮应该失败。");
  await new Promise((r) => setTimeout(r, 400));
  const busyAfterFail = snapshot(k).turn.busy;
  await mock.setMode("ok");
  const recovered = await turn(k, "恢复后这一轮应该成功。");

  await mock.setMode("retry429");
  const before429 = await mock.requests();
  const limited = await turn(k, "429 这轮。");
  const after429 = await mock.requests();
  await mock.setMode("ok");

  // 中止：慢流，收到首字后点停
  await mock.setMode("slow");
  const abort = await new Promise((resolve) => {
    const t0 = performance.now();
    let abortedAt = null;
    let settled = false;
    const off = k.onEvent((ev) => {
      if (ev.type === "delta" && ev.text && !abortedAt) {
        abortedAt = performance.now();
        k.handle("session.abort");
      }
      if (ev.type === "done" || ev.type === "error") void finish("settled");
    });
    const finish = async (status) => {
      if (settled) return;
      settled = true;
      off();
      // abort 后 busy 是异步落下的：轮询到稳定（最多 3s），别用同一 tick 的假读数
      const wait0 = performance.now();
      while (snapshot(k).turn.busy && performance.now() - wait0 < 3000) {
        await new Promise((r) => setTimeout(r, 50));
      }
      resolve({
        status,
        abortToStopMs: abortedAt ? Math.round(performance.now() - abortedAt) : null,
        totalMs: Math.round(performance.now() - t0),
        busy: snapshot(k).turn.busy,
        partial: [...snapshot(k).feed].reverse().find((c) => c.kind === "lynn")?.text ?? "",
      });
    };
    setTimeout(() => void finish("timeout"), 6000);
    k.handle("feed.send", { text: "慢流用于中止测试。" });
  });

  results.cases.recovery = {
    fail500: {
      status: fail.status,
      errorVisible: /500|失败|模型|error/i.test(fail.error ?? ""),
      error: (fail.error ?? "").slice(0, 160),
      totalMs: fail.totalMs,
      busyAfterFail,
    },
    recovered: { status: recovered.status, totalMs: recovered.totalMs },
    rate429: {
      status: limited.status,
      totalMs: limited.totalMs,
      error: (limited.error ?? "").slice(0, 80),
      requestsDuring: after429 - before429,
    },
    abort: { ...abort, partialLen: abort.partial.length },
    requestsToModel: await mock.requests(),
  };
  await k.dispose();
  await mock.close();
}

// ---------- 4) 成员并发吞吐（纯 agent 循环，不依赖外部模型） ----------
{
  const workRoots = Array.from({ length: 8 }, () => fs.mkdtempSync(path.join(os.tmpdir(), "lynn-eval-mem-")));
  const profile = {
    name: "评测成员",
    role: "压测",
    goal: "产出文件并回报",
    boundaries: ["只动工作区"],
    tools: ["write_file"],
    model: "mock",
    limits: { maxTurns: 4, budgetTokens: 100000, wallClockMin: 5 },
    outputContract: { deliverable: "out.txt", evidence: ["out.txt"], acceptance: ["存在"] },
    escalateWhen: "卡住",
    body: "",
  };
  const chat = async (input) => {
    const step = input.messages.filter((m) => m.role === "tool").length;
    if (step === 0) {
      return {
        content: "",
        toolCalls: [{ id: "1", name: "write_file", arguments: JSON.stringify({ path: "out.txt", content: "ok" }) }],
        promptTokens: 100,
        completionTokens: 10,
        cacheRead: 0,
        cacheWrite: 0,
      };
    }
    return {
      content: "",
      toolCalls: [{ id: "2", name: "submit_report", arguments: JSON.stringify({ text: "完成", evidence: ["out.txt"] }) }],
      promptTokens: 120,
      completionTokens: 12,
      cacheRead: 0,
      cacheWrite: 0,
    };
  };
  const mem0 = process.memoryUsage();
  const cpu0 = cpuMs();
  const t0 = performance.now();
  const all = await Promise.all(
    workRoots.map((wd) =>
      runMemberTask({
        profile,
        brief: "写一个 out.txt 并回报",
        deadline: "今天",
        tools: ["write_file"],
        workdir: wd,
        model: { baseUrl: "http://mock", apiKey: "k", model: "m" },
        chatFn: chat,
      }),
    ),
  );
  const elapsed = performance.now() - t0;
  const mem1 = process.memoryUsage();
  results.cases.memberConcurrency = {
    tasks: all.length,
    reported: all.filter((r) => r.status === "reported").length,
    wallMs: Math.round(elapsed),
    tasksPerSec: Math.round((all.length / elapsed) * 1000 * 100) / 100,
    avgTaskMs: Math.round(elapsed / all.length),
    cpuMs: Math.round(cpuMs() - cpu0),
    rssDeltaMB: Math.round(((mem1.rss - mem0.rss) / 1024 / 1024) * 10) / 10,
  };
}

// ---------- 5) 工具失败可见性（成员工具层） ----------
{
  const toolkit = new Toolkit(project);
  const t0 = performance.now();
  let out = "";
  try {
    out = await toolkit.execute("read_file", { path: "../不存在.txt" });
  } catch (err) {
    out = String(err);
  }
  const ms = Math.round(performance.now() - t0);
  let out2 = "";
  try {
    out2 = await toolkit.execute("office_read_table", { path: "x.csv" });
  } catch (err) {
    out2 = String(err);
  }
  results.cases.toolFailure = {
    escape: { ms, errorVisible: /越界|不存在/.test(out), output: out.slice(0, 120) },
    unassembledOffice: { errorVisible: /未装配|未配置/.test(out2), output: out2.slice(0, 120) },
  };
}

fs.writeFileSync(path.join(outDir, `backend-${stamp}.json`), JSON.stringify(results, null, 2), "utf-8");
console.log(JSON.stringify(results, null, 2));
