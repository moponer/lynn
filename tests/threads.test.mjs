// M1-14：多会话线程 —— ThreadStore 单元 + Kernel 级切换/持久化/重启恢复
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ThreadStore } from "../dist/main/threads.js";
import { Kernel } from "../dist/main/kernel.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lynn-threads-"));
const card = (text) => ({ kind: "text", text, at: new Date().toISOString() });

test("ThreadStore：建/列/改名/删，状态按线程隔离", () => {
  const root = tmp();
  const s = new ThreadStore(root);
  const a = s.create("甲");
  const b = s.create("乙");
  assert.deepEqual(s.list().map((t) => t.id), [b.id, a.id], "新的排前");

  s.saveState(a.id, { feed: [card("hi")], history: [{ role: "user", content: "hi" }] });
  assert.equal(s.loadState(a.id).feed.length, 1);
  assert.equal(s.loadState(b.id).feed.length, 0, "两线程互不串");

  s.rename(a.id, "甲改名");
  assert.equal(s.get(a.id).title, "甲改名");
  assert.throws(() => s.rename("不存在", "x"), /不存在/);

  s.remove(b.id);
  assert.equal(s.get(b.id), null);
  assert.ok(!fs.existsSync(path.join(root, "threads", `${b.id}.json`)), "状态文件一并删");
  assert.ok(!fs.existsSync(s.piDir(b.id)), "Pi 会话目录一并删");
});

test("ThreadStore：search 命中卡片文本与 history，空关键词返回空", () => {
  const root = tmp();
  const s = new ThreadStore(root);
  const a = s.create("检索");
  s.saveState(a.id, {
    feed: [card("关于季度报表的讨论")],
    history: [{ role: "assistant", content: "季度报表已生成" }],
  });
  const hits = s.search("季度报表");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, a.id);
  assert.ok(hits[0].hits.length >= 1);
  assert.deepEqual(s.search(""), []);
  assert.deepEqual(s.search("不存在的词"), []);
});

test("ThreadStore：autoTitle 只改首条消息时的『新会话』", () => {
  const root = tmp();
  const s = new ThreadStore(root);
  const a = s.create();
  assert.equal(a.title, "新会话");
  s.autoTitle(a.id, "帮我写一个导出脚本");
  assert.equal(s.get(a.id).title, "帮我写一个导出脚本");
  s.autoTitle(a.id, "第二条不该覆盖标题");
  assert.equal(s.get(a.id).title, "帮我写一个导出脚本");
});

test("Kernel：双线程切换互不串；重启后恢复最后线程", async () => {
  const root = tmp();
  // 先落一个带内容的线程 A，再起 Kernel（ctor 会 loadState 装载）
  const store = new ThreadStore(root);
  const a = store.create("线程A");
  store.saveState(a.id, { feed: [card("线程A的标记")], history: [{ role: "user", content: "线程A的消息" }] });

  let kernel = new Kernel(root);
  try {
    await kernel.init();
    const first = kernel.handle("session.snapshot").thread.id;
    assert.equal(first, a.id, "恢复最近活跃线程");
    assert.ok(kernel.handle("session.snapshot").feed.some((c) => (c.text ?? "").includes("线程A的标记")), "启动时装载 A 的卡");

    kernel.handle("thread.new", { title: "线程B" });
    const second = kernel.handle("session.snapshot").thread.id;
    assert.notEqual(second, first);
    assert.equal(kernel.handle("session.snapshot").thread.title, "线程B");
    assert.ok(!kernel.handle("session.snapshot").feed.some((c) => (c.text ?? "").includes("线程A的标记")), "切走后不看到 A 的卡");

    kernel.handle("thread.switch", { id: first });
    assert.equal(kernel.handle("session.snapshot").thread.id, first);
    assert.ok(kernel.handle("session.snapshot").feed.some((c) => (c.text ?? "").includes("线程A的标记")), "切回 A 能看到 A 的卡");

    kernel.handle("thread.rename", { id: second, title: "线程B改名" });
    assert.ok(kernel.handle("session.snapshot").threads.find((t) => t.id === second).title === "线程B改名");

    // 删除当前线程 → 自动落到新线程
    kernel.handle("thread.remove", { id: first });
    const snap = kernel.handle("session.snapshot");
    assert.notEqual(snap.thread.id, first);
    assert.equal(snap.threads.find((t) => t.id === first), undefined);

    // 盘上 A 的状态文件应已清理
    assert.ok(!fs.existsSync(path.join(root, "threads", `${first}.json`)), "删除线程会清状态文件");
  } finally {
    await kernel.dispose();
  }

  // 重启恢复：列表与最后线程的对话内容都还在
  kernel = new Kernel(root);
  try {
    await kernel.init();
    const snap = kernel.handle("session.snapshot");
    assert.ok(snap.threads.length >= 1, "重启后线程列表还在");
    assert.ok(snap.threads.find((t) => t.title === "线程B改名"), "改名结果持久化");
    assert.equal(snap.thread.id, snap.threads[0].id, "恢复的是最近活跃线程");
  } finally {
    await kernel.dispose();
  }
});

test("Kernel：thread.search 返回命中会话", async () => {
  const root = tmp();
  // 先落一个带内容的线程，再起 Kernel
  const store = new ThreadStore(root);
  const a = store.create("检索");
  store.saveState(a.id, { feed: [card("独一无二的暗号xyzzy")], history: [] });

  const kernel = new Kernel(root);
  try {
    await kernel.init();
    kernel.handle("thread.new", { title: "另一个" });
    const r = kernel.handle("thread.search", { q: "xyzzy" });
    assert.ok(r.results.some((h) => h.id === a.id), "能搜回上一个线程");
    assert.equal(kernel.handle("thread.search", { q: "" }).results.length, 0);
  } finally {
    await kernel.dispose();
  }
});
