// M2-05：会话记忆两层 —— USER 永远保留；MEMORY 可 diff/回滚；system prompt 注入
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MemoryStore, diffLines } from "../dist/main/memory.js";
import { Kernel } from "../dist/main/kernel.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lynn-mem-"));

test("MemoryStore：两层独立落盘；save 版本化；rollback 回内容", () => {
  const root = tmp();
  const s = new MemoryStore(root);
  assert.ok(s.load("user").includes("用户记忆"));
  assert.ok(s.load("memory").includes("助理记忆"));

  s.save("user", "用户偏好暗色主题");
  const v2 = s.save("user", "用户偏好暗色主题；叫用户老陈");
  assert.equal(s.load("user"), "用户偏好暗色主题；叫用户老陈");
  assert.ok(fs.existsSync(path.join(root, "memory", "USER.md")));
  assert.ok(!fs.existsSync(path.join(root, "memory", "MEMORY.md")) || s.load("memory").includes("助理记忆"), "两层互不覆盖");

  s.save("memory", "Q3 报表跑过一次，坑是时区");
  assert.equal(s.load("memory"), "Q3 报表跑过一次，坑是时区");

  const vs = s.versions("user");
  assert.ok(vs.length >= 1);
  const rolled = s.rollback("user", vs.find((v) => v.id !== v2).id);
  assert.ok(rolled.includes("暗色主题"));
  assert.throws(() => s.rollback("user", "user-nope"), /不存在/);
  assert.throws(() => s.rollback("user", "../escape"), /不存在/);
});

test("diffLines：新增/删除/相同三类齐全", () => {
  const d = diffLines("a\nb\nc", "a\nx\nc\nz");
  assert.ok(d.some((x) => x.t === "del" && x.line === "b"));
  assert.ok(d.some((x) => x.t === "add" && x.line === "x"));
  assert.ok(d.some((x) => x.t === "add" && x.line === "z"));
  assert.ok(d.some((x) => x.t === "same" && x.line === "a"));
});

test("MemoryStore：systemPromptSection 只在非空时注入", () => {
  const root = tmp();
  const s = new MemoryStore(root);
  assert.equal(s.systemPromptSection(), "", "空模板不占窗口");
  s.save("user", "叫用户老陈");
  const sec = s.systemPromptSection();
  assert.ok(sec.includes("用户记忆"));
  assert.ok(sec.includes("叫用户老陈"));
  assert.ok(!sec.includes("助理记忆"), "memory 层还空着就不注入");
});

test("Kernel：memory.* RPC 闭环；save 后 systemPrompt 立即含新记忆", async () => {
  const root = tmp();
  const kernel = new Kernel(root);
  try {
    await kernel.init();
    kernel.handle("memory.save", { kind: "user", text: "用户在开发风铃" });
    assert.equal(kernel.handle("memory.get", { kind: "user" }).text, "用户在开发风铃");

    kernel.handle("memory.save", { kind: "user", text: "用户在开发风铃；周四要交月报" });
    const { versions } = kernel.handle("memory.versions", { kind: "user" });
    assert.ok(versions.length >= 1);
    const d = kernel.handle("memory.diff", { kind: "user" });
    assert.ok(d.changes.some((c) => c.t === "add" && c.line.includes("周四")), "diff 能看到新增行");

    const r = kernel.handle("memory.rollback", { kind: "user", versionId: versions[versions.length - 1].id });
    assert.ok(r.ok);
    assert.equal(kernel.handle("memory.get", { kind: "user" }).text, r.text);

    assert.throws(() => kernel.handle("memory.get", { kind: "nope" }), /未知记忆层/);
  } finally {
    await kernel.dispose();
  }
});
