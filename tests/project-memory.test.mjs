// 项目记忆（2026-11-14）：跟着项目走的事实，换项目看不到。
// 三条纪律：去重、写入前脱敏、上限 100 条（超出丢最旧）。
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MemoryStore, parseEntries } from "../dist/main/memory.js";
import { Kernel } from "../dist/main/kernel.js";

const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `lynn-pm-${name}-`));

test("去重：同一句话（标点/大小写不同）不算新增", () => {
  const store = new MemoryStore(tmp("dedup"));
  assert.equal(store.learnProject("p1", "这个仓库用 pnpm 跑测试").added, true);
  assert.equal(store.learnProject("p1", "这个仓库用  PNPM，跑测试。").added, false);
  assert.equal(parseEntries(store.loadProject("p1")).length, 1);
});

test("脱敏：密钥形态写入前就替换掉", () => {
  const store = new MemoryStore(tmp("redact"));
  store.learnProject("p1", "部署用 sk-abcdefghijklmn 这个 key");
  store.learnProject("p1", "token: abc123def456ghi");
  const text = store.loadProject("p1");
  assert.ok(!text.includes("sk-abcdefghijklmn"), "sk- 形态要脱敏");
  assert.ok(!text.includes("abc123def456ghi"), "token= 形态要脱敏");
  assert.match(text, /\*\*\*/);
});

test("上限 100 条：超出丢最旧的，文件不会无限长", () => {
  const store = new MemoryStore(tmp("cap"));
  for (let i = 1; i <= 105; i += 1) store.learnProject("p1", `事实 ${i}`);
  const entries = parseEntries(store.loadProject("p1"));
  assert.equal(entries.length, 100);
  assert.ok(!entries.some((e) => e.text === "事实 1"), "最旧的被挤掉了");
  assert.ok(entries.some((e) => e.text === "事实 105"), "最新的在");
});

test("注入段有预算：只列最近若干条，并如实说只列了几条", () => {
  const store = new MemoryStore(tmp("budget"));
  for (let i = 1; i <= 30; i += 1) store.learnProject("p1", `${i} ${"长事实".repeat(40)}`);
  const section = store.projectSection("p1");
  assert.match(section, /项目记忆/);
  assert.match(section, /只列最近 \d+ 条/, "被截断要如实说");
  assert.ok(section.length < 2600, `注入段要有预算，实际 ${section.length}`);
  assert.ok(section.includes("30 "), "最新的那条要在");
});

test("项目隔离：两个项目互不可见；没有项目时如实拒写", async () => {
  const root = tmp("kernel");
  const kernel = new Kernel(root);
  try {
    await kernel.init();
    assert.match(String(kernel.runTool("save_memory", { entry: "随便一条", scope: "project" })), /没有项目目录/);

    const a = tmp("proj-a");
    kernel.handle("project.setRoot", { root: a });
    assert.match(String(kernel.runTool("save_memory", { entry: "A 项目用 pnpm 跑测试", scope: "project" })), /项目/);
    assert.match(kernel.systemPrompt(), /项目记忆/);
    assert.match(kernel.systemPrompt(), /pnpm/);

    const b = tmp("proj-b");
    kernel.handle("project.setRoot", { root: b });
    assert.ok(!kernel.systemPrompt().includes("pnpm"), "换项目后看不到 A 的事实");
    kernel.runTool("save_memory", { entry: "B 项目用 npm", scope: "project" });
    /**
     * 2026-11-17 缓存修复 B3 后的契约：写入**不再热更新 system**（会打断前缀），
     * 而是当轮尾部提示；快照在切会话/换项目时重建。
     */
    assert.match(kernel.pendingMemoryNote, /B 项目用 npm/, "当轮要能看到刚记的事实");
    assert.ok(!kernel.systemPrompt().includes("B 项目用 npm"), "当前会话的 system 不能因此抖动");

    kernel.handle("project.setRoot", { root: a });
    assert.match(kernel.systemPrompt(), /pnpm/, "切回 A 又能看到");
    assert.ok(!kernel.systemPrompt().includes("B 项目用 npm"), "A 的快照里不该有 B 的事实");

    kernel.handle("project.setRoot", { root: b });
    assert.match(kernel.systemPrompt(), /B 项目用 npm/, "回到 B 时重建快照，应带上它自己的记忆");
  } finally {
    await kernel.dispose();
  }
});

test("read_memory 能读当前项目的记忆；没有项目时如实说", async () => {
  const root = tmp("read");
  const kernel = new Kernel(root);
  try {
    await kernel.init();
    assert.match(String(kernel.runTool("read_memory", { scope: "project" })), /没有项目目录/);
    const dir = tmp("proj-read");
    kernel.handle("project.setRoot", { root: dir });
    kernel.runTool("save_memory", { entry: "发布走 tag 触发", scope: "project" });
    const out = String(kernel.runTool("read_memory", { scope: "project" }));
    assert.match(out, /共 1 条/);
    assert.match(out, /发布走 tag/);
  } finally {
    await kernel.dispose();
  }
});
