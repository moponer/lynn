// 短时浸泡（2026-11-11）：50 轮对话 + 清理幂等 + 内存/会话文件增长。
// 不是 24h soak，但能实测「连续运行是否泄漏/清理是否可重复执行」。
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

const require = createRequire(import.meta.url);
const { startMock } = require("./mock-model.cjs");
const repo = path.resolve(import.meta.dirname, "..", "..");
const outDir = path.join(repo, "perf", "eval");
const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
fs.mkdirSync(outDir, { recursive: true });

const home = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-soak-"));
const project = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-soak-proj-"));
process.env.LYNN_HOME = home;
process.env.LYNN_PROJECT_DIR = project;
process.env.NODE_TEST_CONTEXT = "eval";

const { Kernel } = await import(pathToFileURL(path.join(repo, "dist/main/kernel.js")).href);
const { runCleanup } = await import(pathToFileURL(path.join(repo, "dist/main/cleanup.js")).href);

const mock = await startMock({ mode: "ok", chunks: 2, reply: "收到" });
const at = new Date().toISOString();
const entry = { id: "m", label: "Mock", provider: "Mock", baseUrl: mock.baseUrl, model: "mock-1", apiKey: { encrypted: false, data: "k" }, updatedAt: at };
fs.writeFileSync(
  path.join(home, "settings.json"),
  JSON.stringify({ model: entry, models: [entry], defaultModelId: "m", prefs: { heartbeat: false, supervisor: false, autoStart: false } }, null, 2),
  "utf-8",
);

const k = new Kernel(home);
await k.init();

function turn(text) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const off = k.onEvent((ev) => {
      if (ev.type === "done" || ev.type === "error") {
        off();
        resolve({ ms: Math.round(performance.now() - t0), status: ev.type });
      }
    });
    k.handle("feed.send", { text });
  });
}

const mem0 = process.memoryUsage();
const laps = [];
const memMid = { at: 0, rss: 0, heap: 0 };
for (let i = 0; i < 100; i += 1) {
  laps.push(await turn(`第 ${i + 1} 轮：只回复收到`));
  if (i === 49) {
    const m = process.memoryUsage();
    memMid.at = 50;
    memMid.rss = m.rss;
    memMid.heap = m.heapUsed;
  }
}
const mem1 = process.memoryUsage();
// 强制 GC 后再量一次：区分「V8 还没回收」与「真的常驻增长」
if (global.gc) global.gc();
const memGc = process.memoryUsage();

// 造一批超期 scratch，连跑两次清理：第二次必须 freed=0
const taskDir = path.join(home, "tasks", "soak-1");
fs.mkdirSync(path.join(taskDir, "scratch"), { recursive: true });
const old = path.join(taskDir, "scratch", "old.txt");
fs.writeFileSync(old, "x".repeat(2048), "utf-8");
const oldTime = new Date(Date.now() - 30 * 86_400_000);
fs.utimesSync(old, oldTime, oldTime);
const c1 = runCleanup(home, { scratchDays: 14, checkpointDays: 7, logDays: 7 });
const c2 = runCleanup(home, { scratchDays: 14, checkpointDays: 7, logDays: 7 });

const sessionFiles = fs.existsSync(path.join(home, "session"))
  ? fs.readdirSync(path.join(home, "session")).map((f) => ({ f, bytes: fs.statSync(path.join(home, "session", f)).size }))
  : [];

const sorted = laps.map((l) => l.ms).sort((a, b) => a - b);
const result = {
  at: new Date().toISOString(),
  turns: laps.length,
  failedTurns: laps.filter((l) => l.status !== "done").length,
  latencyMs: {
    p50: sorted[Math.floor(sorted.length / 2)],
    p95: sorted[Math.floor(sorted.length * 0.95)],
    max: sorted[sorted.length - 1],
  },
  rssStartMB: Math.round((mem0.rss / 1024 / 1024) * 10) / 10,
  rssAt50MB: Math.round((memMid.rss / 1024 / 1024) * 10) / 10,
  rssEndMB: Math.round((mem1.rss / 1024 / 1024) * 10) / 10,
  rssAfterGcMB: Math.round((memGc.rss / 1024 / 1024) * 10) / 10,
  rssGrowthMB: Math.round(((mem1.rss - mem0.rss) / 1024 / 1024) * 10) / 10,
  rssGrowthAfterGcMB: Math.round(((memGc.rss - mem0.rss) / 1024 / 1024) * 10) / 10,
  heapGrowthMB: Math.round(((mem1.heapUsed - mem0.heapUsed) / 1024 / 1024) * 10) / 10,
  heapAfterGcMB: Math.round((memGc.heapUsed / 1024 / 1024) * 10) / 10,
  sessionFiles,
  cleanup1: { freedBytes: c1.freedBytes, removed: c1.removed.length },
  cleanup2: { freedBytes: c2.freedBytes, removed: c2.removed.length },
  idempotent: c2.freedBytes === 0 && c2.removed.length === 0,
  scratchRemoved: !fs.existsSync(old),
  modelRequests: mock.requests(),
};
fs.writeFileSync(path.join(outDir, `soak-${stamp}.json`), JSON.stringify(result, null, 2), "utf-8");
console.log(JSON.stringify(result, null, 2));
await k.dispose();
await mock.close();
