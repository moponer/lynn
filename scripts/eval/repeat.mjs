// 重复运行一致性：核心后端用例 ×3 + 完整前端 E2E ×3，比较通过率与耗时抖动。
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";

const repo = path.resolve(import.meta.dirname, "..", "..");
const outDir = path.join(repo, "perf", "eval");
const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
fs.mkdirSync(outDir, { recursive: true });

const backendFiles = [
  "tests/member-runner.test.mjs",
  "tests/task-lifecycle.test.mjs",
  "tests/workspace-roots.test.mjs",
  "tests/cleanup.test.mjs",
  "tests/workspace-extra.test.mjs",
];

function run(cmd, args, label) {
  const t0 = performance.now();
  const r = spawnSync(cmd, args, { cwd: repo, encoding: "utf-8", timeout: 240_000, maxBuffer: 12 * 1024 * 1024 });
  const ms = Math.round(performance.now() - t0);
  const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
  const pass = Number(/ℹ pass (\d+)/.exec(out)?.[1] ?? 0);
  const fail = Number(/ℹ fail (\d+)/.exec(out)?.[1] ?? 0);
  return { label, exit: r.status, ms, pass, fail, timedOut: Boolean(r.error?.message?.includes("ETIMEDOUT")) };
}

function latestUiReport() {
  const files = fs
    .readdirSync(outDir)
    .filter((f) => /^ui-\d+\.json$/.test(f))
    .map((f) => ({ f, m: fs.statSync(path.join(outDir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  if (!files.length) return null;
  return JSON.parse(fs.readFileSync(path.join(outDir, files[0].f), "utf-8"));
}

const result = { at: new Date().toISOString(), backend: [], ui: [] };

const save = () => fs.writeFileSync(path.join(outDir, `repeat-${stamp}.json`), JSON.stringify(result, null, 2), "utf-8");

for (let i = 1; i <= 3; i += 1) {
  result.backend.push(run(process.execPath, ["--test", "--test-force-exit", ...backendFiles], `backend-${i}`));
  console.log(`repeat: backend-${i} done`);
  save();
}
// 前端跑 3 次：修复后每次都在隔离 userData + 前台窗口里执行。
for (let i = 1; i <= 3; i += 1) {
  const r = run(process.execPath, ["scripts/eval/ui.cjs"], `ui-${i}`);
  const rep = latestUiReport();
  result.ui.push({
    ...r,
    failedSteps: rep?.failedSteps ?? null,
    steps: rep?.steps?.length ?? null,
    bootMs: rep?.bootMs ?? null,
    consoleErrors: rep?.consoleErrors?.length ?? null,
    chatRenderedInDom: rep?.uiFacts?.chatRenderedInDom ?? null,
    recoveryRenderedInDom: rep?.uiFacts?.recoveryRenderedInDom ?? null,
  });
  console.log(`repeat: ui-${i} done exit=${r.exit}`);
  save();
}

const stdev = (xs) => {
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.round(Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length));
};

result.summary = {
  backendRuns: result.backend.length,
  backendAllPass: result.backend.every((r) => r.exit === 0 && r.fail === 0),
  backendPassCounts: result.backend.map((r) => r.pass),
  backendMsStdev: stdev(result.backend.map((r) => r.ms)),
  uiRuns: result.ui.length,
  uiAllPass: result.ui.every((r) => r.exit === 0 && r.failedSteps === 0),
  uiFailedSteps: result.ui.map((r) => r.failedSteps),
  uiBootMs: result.ui.map((r) => r.bootMs),
  uiBootStdevMs: stdev(result.ui.map((r) => r.bootMs ?? 0)),
  uiConsoleErrors: result.ui.map((r) => r.consoleErrors),
};
fs.writeFileSync(path.join(outDir, `repeat-${stamp}.json`), JSON.stringify(result, null, 2), "utf-8");
console.log(JSON.stringify(result, null, 2));
