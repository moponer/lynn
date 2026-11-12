// 系统消息分类与合并（2026-11-12）：批量删除不再刷一屏「已删除」，且带「清理」标签。
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Kernel } from "../dist/main/kernel.js";
import { TeamStore } from "../dist/main/team-store.js";
import { TaskStore } from "../dist/main/task-store.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lynn-sysmsg-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("批量删除 3 张单：合并成一条「清理」消息，不再刷 3 条", async () => {
  const root = tmp();
  const teams = new TeamStore(root);
  teams.createTeam("t1", "清理组");
  const tasks = new TaskStore(root);
  for (const id of ["perm-locate-002", "perm-audit-003", "perm-audit-001"]) {
    tasks.create({ id, title: id, teamId: "t1" });
    tasks.transition(id, "todo");
  }
  const kernel = new Kernel(root);
  for (const id of ["perm-locate-002", "perm-audit-003", "perm-audit-001"]) {
    const r = kernel.handle("task.remove", { taskId: id });
    assert.equal(r.ok, true, `删除 ${id} 应成功`);
  }
  await sleep(650);
  const cards = kernel.handle("session.snapshot").feed.filter((c) => c.title === "清理");
  assert.equal(cards.length, 1, "3 次删除只落 1 条汇总消息");
  assert.equal(cards[0].systemTone, "cleanup", "清理类要有自己的标识");
  assert.match(cards[0].text ?? "", /已删除 3 张单/);
  assert.match(cards[0].text ?? "", /perm-locate-002/);
  assert.match(cards[0].text ?? "", /perm-audit-003/);
  kernel.dispose();
});

test("单张删除：一条精简消息，带「清理」标签；工作区未改动如实写", async () => {
  const root = tmp();
  const teams = new TeamStore(root);
  teams.createTeam("t1", "清理组");
  const tasks = new TaskStore(root);
  const ws = path.join(root, "project");
  fs.mkdirSync(ws, { recursive: true });
  tasks.create({ id: "solo", title: "solo", teamId: "t1", workspaceRoot: ws });
  tasks.transition("solo", "todo");
  const kernel = new Kernel(root);
  const r = kernel.handle("task.remove", { taskId: "solo" });
  assert.equal(r.ok, true);
  assert.ok(r.kept?.length, "共享工作区要如实返回");
  await sleep(650);
  const cards = kernel.handle("session.snapshot").feed.filter((c) => c.title === "清理");
  assert.equal(cards.length, 1);
  assert.match(cards[0].text ?? "", /已删除 solo（工单\/卷宗\/临时文件已清/);
  assert.match(cards[0].text ?? "", /未改动/);
  kernel.dispose();
});
