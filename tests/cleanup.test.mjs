// 数据清理（2026-11-10 P2-1）：只清过程文件；交付物/证据/沙箱一律不动。
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runCleanup, measureUsage, formatBytes } from "../dist/main/cleanup.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lynn-clean-"));
const OLD = Date.now() - 40 * 86_400_000;

function touchOld(p) {
  fs.writeFileSync(p, "old", "utf-8");
  fs.utimesSync(p, new Date(OLD), new Date(OLD));
}

test("runCleanup：超期 scratch 删；新 scratch / artifacts / workspace 不动", () => {
  const root = tmp();
  const t1 = path.join(root, "tasks", "t1");
  fs.mkdirSync(path.join(t1, "scratch"), { recursive: true });
  fs.mkdirSync(path.join(t1, "artifacts"), { recursive: true });
  fs.mkdirSync(path.join(t1, "workspace"), { recursive: true });
  const oldScratch = path.join(t1, "scratch", "download.zip");
  const newScratch = path.join(t1, "scratch", "recent.log");
  const artifact = path.join(t1, "artifacts", "report.md");
  const sandbox = path.join(t1, "workspace", "main.ts");
  touchOld(oldScratch);
  fs.writeFileSync(newScratch, "new", "utf-8");
  touchOld(artifact);
  touchOld(sandbox);

  const r = runCleanup(root, { scratchDays: 14, checkpointDays: 7, logDays: 7 });
  assert.ok(r.freedBytes > 0);
  assert.ok(!fs.existsSync(oldScratch), "超期过程文件应删除");
  assert.ok(fs.existsSync(newScratch), "未超期的不动");
  assert.ok(fs.existsSync(artifact), "交付/证据永久保留");
  assert.ok(fs.existsSync(sandbox), "沙箱工作区不自动删");
  assert.equal(r.removed.length, 1);
});

test("runCleanup：检查点与轮转日志按 TTL 删；当前 agent.log 保留", () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, "checkpoints"), { recursive: true });
  fs.mkdirSync(path.join(root, "logs"), { recursive: true });
  const oldCp = path.join(root, "checkpoints", "c1.jsonl");
  const live = path.join(root, "logs", "agent.log");
  const rotated = path.join(root, "logs", "agent.1.log");
  touchOld(oldCp);
  fs.writeFileSync(live, "live", "utf-8");
  touchOld(rotated);

  runCleanup(root, { scratchDays: 14, checkpointDays: 7, logDays: 7 });
  assert.ok(!fs.existsSync(oldCp));
  assert.ok(fs.existsSync(live), "当前日志永远保留");
  assert.ok(!fs.existsSync(rotated), "轮转日志按 TTL 删");
});

test("measureUsage：分开统计过程/证据/沙箱/日志/检查点", () => {
  const root = tmp();
  const t1 = path.join(root, "tasks", "t1");
  fs.mkdirSync(path.join(t1, "scratch"), { recursive: true });
  fs.mkdirSync(path.join(t1, "artifacts"), { recursive: true });
  fs.mkdirSync(path.join(t1, "workspace"), { recursive: true });
  fs.writeFileSync(path.join(t1, "scratch", "a"), "1234", "utf-8");
  fs.writeFileSync(path.join(t1, "artifacts", "b"), "12", "utf-8");
  fs.writeFileSync(path.join(t1, "workspace", "c"), "123456", "utf-8");
  const u = measureUsage(root);
  assert.equal(u.scratchBytes, 4);
  assert.equal(u.artifactsBytes, 2);
  assert.equal(u.sandboxBytes, 6);
  assert.equal(u.tasksBytes, 12);
  assert.equal(u.totalBytes, 12);
  assert.equal(formatBytes(2048), "2 KB");
});
