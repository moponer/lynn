// 回复守门（2026-11-11）：不许把「文件放哪 / 叫什么 / 什么格式 / 你自己存」推回用户。
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isAskingUserForOutputDetails, claimsDone, NO_DELIVERABLE_HINT, REPLY_GUARD_HINT } from "../dist/main/reply-guard.js";
import { Kernel } from "../dist/main/kernel.js";
import { TeamStore } from "../dist/main/team-store.js";
import { TaskStore } from "../dist/main/task-store.js";

test("命中：产出侧反问（路径/文件名/格式/让用户自己保存）", () => {
  for (const s of [
    "你要什么格式？",
    "文件放哪？",
    "叫什么名字？",
    "把内容发我",
    "要不要发给你",
    "你自己保存一下吧",
    "你指定个路径",
    "复制粘贴给你",
  ]) {
    assert.equal(isAskingUserForOutputDetails(s), true, `应命中：${s}`);
  }
});

test("不误伤：材料位置、正常交付说明、正常提问", () => {
  for (const s of [
    "材料在哪个目录？",
    "已生成 reports/漏洞管理.docx，放在工作区。",
    "这份清单里的第 3 项口径要不要改？",
    "我派了一名数据整理员去做，完成后把结果给你。",
  ]) {
    assert.equal(isAskingUserForOutputDetails(s), false, `不该命中：${s}`);
  }
  assert.match(REPLY_GUARD_HINT, /assign_task/);
  assert.match(REPLY_GUARD_HINT, /office_write_docx/);
});

test("内核：ask_user 问产出细节被拒发，不落决策卡", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-guard-"));
  const kernel = new Kernel(root);
  const reply = kernel.runTool("ask_user", { question: "文件放哪？叫什么名字？" });
  assert.match(reply, /不要问用户产出文件放哪/);
  assert.equal(kernel.decisions.length, 0, "被拒的提问不该出现在等用户列表里");
  kernel.dispose();
});

test("内核：report_to_user 里反问也会被拒", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-guard-"));
  const kernel = new Kernel(root);
  const reply = kernel.runTool("report_to_user", {
    conclusion: "内容我整理好了，你要什么格式？要不要发你自己存？",
  });
  assert.match(reply, /不要问用户产出文件放哪/);
  kernel.dispose();
});

test("完成宣称识别：完成/交付才算，未完成与归档不算", () => {
  for (const s of ["已处理完毕", "文档已完成", "已交付", "全部完成", "搞定了"]) {
    assert.equal(claimsDone(s), true, `应识别为完成宣称：${s}`);
  }
  for (const s of ["未完成", "没做出来", "已归档", "已取消归档", "还需要两轮"]) {
    assert.equal(claimsDone(s), false, `不该识别为完成宣称：${s}`);
  }
  assert.match(NO_DELIVERABLE_HINT, /没有任何交付物/);
});

test("内核：没有交付物却宣称完成，report_to_user 被拒", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-guard-"));
  const teams = new TeamStore(root);
  teams.createTeam("t1", "文档组");
  const tasks = new TaskStore(root);
  tasks.create({ id: "task-a", title: "漏洞处理流程文档", teamId: "t1", member: "文档撰写员" });
  const kernel = new Kernel(root);
  const reply = kernel.runTool("report_to_user", {
    teamId: "t1",
    taskId: "task-a",
    conclusion: "已处理完毕：文档已完成并交付。",
    unfinished: [],
    decisionsNeeded: [],
  });
  assert.match(reply, /没有任何交付物/);
  kernel.dispose();
});

test("内核：无交付物关单时，返回明确说「没有交付物」，不说已处理完毕", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-guard-"));
  const teams = new TeamStore(root);
  teams.createTeam("t1", "文档组");
  const tasks = new TaskStore(root);
  tasks.create({ id: "task-b", title: "漏洞处理流程文档", teamId: "t1", member: "文档撰写员" });
  tasks.transition("task-b", "todo");
  const kernel = new Kernel(root);
  const reply = kernel.runTool("stop_task", { taskId: "task-b", reason: "成员两次跑完未交付", dismiss: true });
  assert.match(reply, /没有任何交付物/);
  assert.match(reply, /不要说「如果你还需要就再告诉我」/);
  assert.equal(tasks.get("task-b").status, "canceled");
  const feed = kernel.handle("session.snapshot").feed.map((c) => c.text ?? "").join("\n");
  assert.match(feed, /未完成：task-b 没有任何交付物/);
  kernel.dispose();
});
