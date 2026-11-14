// 右栏编制区（2026-11-12）：队→群归属、空场没有当前会话。
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Kernel } from "../dist/main/kernel.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lynn-rg-"));

test("快照的队伍带 threadId（队→群归属）：手动建的队归当前群", async () => {
  const root = tmp();
  const kernel = new Kernel(root);
  try {
    await kernel.init();
    const threadId = kernel.handle("session.snapshot").thread.id;
    assert.ok(threadId, "要有当前会话");
    const r = kernel.handle("team.create", { name: "走查队" });
    assert.equal(r.ok, true);
    const snap = kernel.handle("session.snapshot");
    const team = snap.board.teams.find((t) => t.id === r.id);
    assert.ok(team, "新建的队要出现在快照里");
    assert.equal(team.threadId, threadId, "手动建的队归当前群（否则它掉进他群，像建错了）");
  } finally {
    await kernel.dispose();
  }
});

test("空场：没有当前会话（界面据此不渲染群公告），编制仍在", async () => {
  const root = tmp();
  const kernel = new Kernel(root);
  try {
    await kernel.init();
    const threadId = kernel.handle("session.snapshot").thread.id;
    kernel.handle("thread.remove", { id: threadId });
    const snap = kernel.handle("session.snapshot");
    assert.equal(snap.thread.id, "", "空场时没有当前会话");
    assert.equal(snap.threads.length, 0, "群列表为空");
    assert.ok(Array.isArray(snap.board.teams), "编制数据仍在（编制是跨群资产）");
  } finally {
    await kernel.dispose();
  }
});
