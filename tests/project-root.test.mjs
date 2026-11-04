// 会话工作区（2026-11-04 用户问"开始对话时能否设置工作区"）：
// 每个会话各带一个工作区；新会话可指定，中途可换，切回旧会话要回到它自己的目录。
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Kernel } from "../dist/main/kernel.js";
import { ThreadStore } from "../dist/main/threads.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lynn-projroot-"));

test("ThreadStore：create 可带工作区，setProject 可改", () => {
  const root = tmp();
  const s = new ThreadStore(root);
  const dirA = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-a-"));
  const a = s.create("甲", dirA);
  assert.equal(s.get(a.id).projectRoot, path.resolve(dirA));
  const dirB = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-b-"));
  s.setProject(a.id, dirB);
  assert.equal(s.get(a.id).projectRoot, path.resolve(dirB));
});

test("Kernel：新会话指定工作区、中途可换、切回旧会话恢复自己的目录", async () => {
  const root = tmp();
  const dirA = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-a-"));
  const dirB = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-b-"));
  const kernel = new Kernel(root);
  try {
    await kernel.init();
    const first = kernel.handle("session.snapshot").thread.id;

    // 中途换当前会话的工作区
    const set = kernel.handle("project.setRoot", { root: dirA });
    assert.equal(set.ok, true);
    assert.equal(kernel.handle("session.snapshot").project.root, path.resolve(dirA));

    // 新会话带自己的工作区
    const created = kernel.handle("session.new", { projectRoot: dirB });
    assert.equal(kernel.handle("session.snapshot").project.root, path.resolve(dirB));
    assert.equal(kernel.handle("session.snapshot").thread.projectRoot, path.resolve(dirB));

    // 切回旧会话 → 回到它自己的目录（不跟着新会话串）
    kernel.handle("thread.switch", { id: first });
    assert.equal(kernel.handle("session.snapshot").project.root, path.resolve(dirA));

    // 不存在的目录要拒
    const bad = kernel.handle("project.setRoot", { root: path.join(root, "nope") });
    assert.equal(bad.ok, false);
    assert.match(bad.error ?? "", /目录不存在/);
    assert.ok(created.threadId);
  } finally {
    await kernel.dispose();
  }
});
