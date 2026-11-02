// 孤儿 worker 清理：只杀「同 entry 且还活着」的标记，死标记与别人的进程都不动
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { reapOrphanWorkers, writeWorkerMarker, clearWorkerMarker } from "../dist/main/agent-orphans.js";

const entry = "F:/spiker/lynn/agent/pi-rpc-entry.mjs";

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "lynn-orphan-"));
}

test("活着的同 entry 进程被清理，标记删除", () => {
  const dir = tmp();
  writeWorkerMarker(dir, { pid: 4321, entry, startedAt: "2026-11-02T00:00:00Z" });
  const killed = [];
  const reaped = reapOrphanWorkers(dir, {
    entry,
    alive: (pid) => pid === 4321,
    kill: (pid) => killed.push(pid),
  });
  assert.deepEqual(reaped, [4321]);
  assert.deepEqual(killed, [4321]);
  assert.equal(fs.readdirSync(dir).length, 0);
});

test("死标记只删文件，不调 kill", () => {
  const dir = tmp();
  writeWorkerMarker(dir, { pid: 5000, entry, startedAt: "2026-11-02T00:00:00Z" });
  let kills = 0;
  reapOrphanWorkers(dir, { entry, alive: () => false, kill: () => (kills += 1) });
  assert.equal(kills, 0);
  assert.equal(fs.readdirSync(dir).length, 0);
});

test("别处 entry 的进程不误杀（同名文件也在）", () => {
  const dir = tmp();
  writeWorkerMarker(dir, { pid: 6000, entry: "C:/other/app/worker.mjs", startedAt: "x" });
  let kills = 0;
  reapOrphanWorkers(dir, { entry, alive: () => true, kill: () => (kills += 1) });
  assert.equal(kills, 0, "不是我们的 entry，不能杀");
});

test("目录不存在时安静返回", () => {
  assert.deepEqual(reapOrphanWorkers(path.join(os.tmpdir(), "lynn-not-exist-xyz"), { entry }), []);
});

test("clear 幂等", () => {
  const dir = tmp();
  writeWorkerMarker(dir, { pid: 7000, entry, startedAt: "x" });
  clearWorkerMarker(dir, 7000);
  clearWorkerMarker(dir, 7000);
  assert.equal(fs.readdirSync(dir).length, 0);
});
