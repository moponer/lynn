// 环境感知 + 记忆可删（2026-11-13）
// 事故：用户让「删除已取消任务的记忆条目」，风铃把 MEMORY.md 当成项目里的文件派成员去删；
// 成员工具钉死在任务工作区（越界直接抛）→ 这单物理上不可能成功，必然空转到打回上限。
// 锁死：①风铃知道那些文件在哪、且知道"归她管"；②她有真工具能删一条记忆；③能力边界写进提示词。
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Kernel } from "../dist/main/kernel.js";
import { MemoryStore, parseEntries } from "../dist/main/memory.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lynn-env-"));

test("环境事实：提示词写清记忆文件真实路径与「归你管」的边界", async () => {
  const root = tmp();
  const kernel = new Kernel(root);
  try {
    await kernel.init();
    const prompt = kernel.systemPrompt();
    assert.match(prompt, /【环境事实/, "必须有环境事实段");
    assert.ok(prompt.includes(path.join(root, "memory", "MEMORY.md")), "要写真实 MEMORY.md 路径");
    assert.ok(prompt.includes(path.join(root, "memory", "USER.md")), "要写真实 USER.md 路径");
    assert.ok(prompt.includes(path.join(root, "tasks")), "要写任务卷宗位置");
    assert.match(prompt, /别派成员/, "要写明记忆归她管、不要派成员去删");
  } finally {
    await kernel.dispose();
  }
});

test("能力边界：归她自己 / 别派去系统目录 / 点名工具", async () => {
  const root = tmp();
  const kernel = new Kernel(root);
  try {
    await kernel.init();
    const prompt = kernel.systemPrompt();
    assert.match(prompt, /归你自己，别派成员/, "要有能力边界");
    assert.match(prompt, /别派单去「系统目录」/, "要禁止派单去系统目录找/删");
    assert.match(prompt, /forget_memory/, "能力边界里要点名工具");
  } finally {
    await kernel.dispose();
  }
});

test("read_memory：列出条目（行号 + 摘要）", async () => {
  const root = tmp();
  const kernel = new Kernel(root);
  try {
    await kernel.init();
    kernel.runTool("save_memory", { entry: "hermix-desktop 分析任务（校验码 HERMIX-4471）已取消" });
    const out = String(kernel.runTool("read_memory", {}));
    assert.match(out, /HERMIX-4471/, "要能看到刚写的这条");
    assert.match(out, /第\d+行/, "要给行号，便于定位");
  } finally {
    await kernel.dispose();
  }
});

test("forget_memory：真删一条（文件与提示词里都不留），且留版本可回滚", async () => {
  const root = tmp();
  const kernel = new Kernel(root);
  try {
    await kernel.init();
    // 先建一次快照（模拟会话已开始），否则首次读取会包含刚写入的内容
    const before = String(kernel.systemPrompt());
    kernel.runTool("save_memory", { entry: "hermix-desktop 分析任务（校验码 HERMIX-4471）已取消" });
    // 缓存修复 B3：写入不再热改 system（会打断前缀），当轮提示可见
    assert.match(kernel.pendingMemoryNote, /HERMIX-4471/, "当轮要能看到刚写的这条");
    assert.equal(String(kernel.systemPrompt()), before, "写入不得改变当前会话的 system 前缀");

    const out = String(kernel.runTool("forget_memory", { keyword: "HERMIX-4471" }));
    assert.match(out, /已从.*删掉/, "要如实说删掉了");

    const file = path.join(root, "memory", "MEMORY.md");
    assert.ok(!fs.readFileSync(file, "utf8").includes("HERMIX-4471"), "文件里不能还留着");
    assert.ok(!String(kernel.systemPrompt()).includes("HERMIX-4471"), "提示词里也不能还留着");
    assert.ok(kernel.memory.versions("memory").length > 0, "删除要落一版，可回滚");
  } finally {
    await kernel.dispose();
  }
});

test("forget_memory：匹配到多条时拒绝并给候选（不替用户猜）", async () => {
  const root = tmp();
  const kernel = new Kernel(root);
  try {
    await kernel.init();
    kernel.runTool("save_memory", { entry: "季度对账口径按新版：HERMIX-4471 相关的行数不再计入" });
    kernel.runTool("save_memory", { entry: "旧版对账表 HERMIX-4471 已作废" });
    const out = String(kernel.runTool("forget_memory", { keyword: "HERMIX-4471" }));
    assert.match(out, /匹配到 2 条/, "要如实说匹配到多条");
    assert.match(out, /候选/, "要给候选");
    assert.ok(String(kernel.systemPrompt()).includes("HERMIX-4471"), "拒绝时不能误删");
  } finally {
    await kernel.dispose();
  }
});

test("MemoryStore：parseEntries 只认条目行，时间戳与正文分开", () => {
  const entries = parseEntries("# 模板说明\n\n- 2026-11-12 10:00 有时间戳的一条\n- 没有时间戳的一条\n");
  assert.equal(entries.length, 2);
  assert.equal(entries[0].at, "2026-11-12 10:00");
  assert.equal(entries[0].text, "有时间戳的一条");
  assert.equal(entries[1].at, "");
});

test("MemoryStore.forget：0 条命中如实失败；删一条要落一版可回滚", () => {
  const store = new MemoryStore(tmp());
  store.save("memory", "- 2026-11-12 10:00 老条目 HERMIX-1\n- 无时间戳的老条目 HERMIX-2\n");
  const none = store.forget("memory", "根本没有这个");
  assert.equal(none.ok, false);
  assert.match(none.error ?? "", /没有匹配/);

  const before = store.versions("memory").length;
  const one = store.forget("memory", "HERMIX-1");
  assert.equal(one.ok, true);
  assert.ok(!store.load("memory").includes("HERMIX-1"), "删完不能还在");
  assert.ok(store.load("memory").includes("HERMIX-2"), "别的条目不能被牵连");
  assert.ok(store.versions("memory").length > before, "删除要落一版可回滚");
});
