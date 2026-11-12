// 把单测拆成 fast / slow 两套：CI 先跑 fast，slow（真 Pi worker / Edge / 心跳）单独跑。
// 文件名不能叫 test-*.mjs —— node --test 会把它当用例文件执行并递归起 runner。
// 用法：node scripts/split-tests.mjs fast|slow
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mode = process.argv[2] === "slow" ? "slow" : "fast";

/** 会起真实子进程 / 真浏览器 / 长定时器的用例，放进 slow 套件 */
const SLOW = new Set([
  "agent-host.test.mjs",
  "browser.test.mjs",
  "heartbeat.test.mjs",
  "pi-rpc-host.test.mjs",
  "pi-rpc-smoke.test.mjs",
  "dispatch-smoke.test.mjs",
]);

const files = fs
  .readdirSync(path.join(repo, "tests"))
  .filter((f) => f.endsWith(".test.mjs"))
  .filter((f) => (mode === "slow" ? SLOW.has(f) : !SLOW.has(f)))
  .sort()
  .map((f) => path.join("tests", f));

console.log(`[test:${mode}] ${files.length} files`);
const r = spawnSync(process.execPath, ["--test", "--test-force-exit", ...files], {
  cwd: repo,
  stdio: "inherit",
  env: process.env,
});
process.exit(r.status ?? 1);
