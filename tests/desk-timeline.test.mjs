// 详情区「第几轮 / 状态时间线」的数据通路：内核只读派生，不改工单状态、不改卷宗。
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Kernel } from "../dist/main/kernel.js";
import { TeamStore } from "../dist/main/team-store.js";
import { TaskStore } from "../dist/main/task-store.js";
import { TaskCase } from "../dist/main/task-case.js";

test("快照带出派单轮次与状态时间线，权威状态与卷宗都不被改动", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-timeline-"));
  const teams = new TeamStore(root);
  teams.createTeam("t1", "长任务组");
  const tasks = new TaskStore(root);
  tasks.create({ id: "task-x", title: "七阶段长任务", teamId: "t1", member: "林工", threadId: "th-1" });
  tasks.transition("task-x", "todo");

  const tc = new TaskCase(root);
  tc.append("task-x", { kind: "assign", text: "第一版简报", member: "林工" });
  tc.append("task-x", { kind: "report", text: "回报带证据" });
  tc.append("task-x", { kind: "note", text: "第 2 轮重做：沿用原工单，未新建工单" });
  tc.append("task-x", { kind: "assign", text: "重做版简报", member: "林工" });
  const before = fs.readFileSync(tc.timelineFile("task-x"), "utf-8");

  const kernel = new Kernel(root);
  const item = kernel.snapshotBoard().track.find((t) => t.id === "task-x");
  assert.ok(item, "没有派单账本的工单也要出现在台账上");
  assert.equal(item.round, 2, "轮次由卷宗里的派单事件推导");
  assert.equal(item.timeline.length, 4);
  assert.equal(item.timeline[0].kind, "assign");
  assert.equal(item.timeline[item.timeline.length - 1].text, "重做版简报");
  assert.equal(tasks.get("task-x").status, "todo", "快照不能改权威状态");
  assert.equal(fs.readFileSync(tc.timelineFile("task-x"), "utf-8"), before, "快照不能改写卷宗");
});
