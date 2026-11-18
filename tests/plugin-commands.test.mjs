/**
 * 插件斜杠命令（P11-1）。
 *
 * 补的是 26 章第 3 节的缺口：`contributes.commands` 全仓 0 处引用——
 * 字段存在、校验器认它、模板演示过，但没有任何代码读它。
 *
 * 命令的定位要说清：**一条命令 = 一个名字 + 一段预置提示词**。
 * 选中后填进输入台，用户确认后发出。它不执行代码，所以没有权限问题。
 *
 * 测试守四件事：
 *  1. 两种写法都能用（内联对象 / 指向 .md 文件）；
 *  2. 坏命令**不拖垮整个插件**，且报出具体原因（不是静默丢弃）；
 *  3. 停用的插件不提供命令（与 `_state.json` 同一份真相）；
 *  4. 命令名加插件前缀（两个插件不会抢同一个名字）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { scanPluginCommands } = await jiti.import("../src/main/plugin-commands.ts", { default: true });

const tmp = (p = "lynn-cmd-") => fs.mkdtempSync(path.join(os.tmpdir(), p));

/** 造一个插件（默认合法） */
function makePlugin(root, id, contributes, over = {}) {
  const dir = path.join(root, "plugins", id);
  fs.mkdirSync(dir, { recursive: true });
  const manifest = {
    id,
    name: over.name ?? id,
    version: "1.0.0",
    apiVersion: 1,
    tier: over.tier ?? "L0",
    engines: { kernel: ">=0.0.1" },
    ...(over.entry ? { entry: over.entry } : {}),
    ...(over.permissions ? { permissions: over.permissions } : {}),
    contributes,
  };
  fs.writeFileSync(path.join(dir, "plugin.json"), JSON.stringify(manifest, null, 2), "utf8");
  return dir;
}

/** 写 `_state.json`（Record<id, enabled>） */
function setEnabled(root, id, enabled) {
  const file = path.join(root, "plugins", "_state.json");
  let state = {};
  if (fs.existsSync(file)) state = JSON.parse(fs.readFileSync(file, "utf8"));
  state[id] = enabled;
  fs.writeFileSync(file, JSON.stringify(state, null, 2), "utf8");
}

test("内联命令：name + description + prompt 都能读出来", () => {
  const root = tmp();
  makePlugin(root, "lynn.demo.cmd", {
    commands: [{ name: "weekly", description: "写周报", prompt: "帮我写一份本周周报，按项目分组。" }],
  });
  const r = scanPluginCommands(root);
  assert.equal(r.commands.length, 1, `没读到命令：${r.errors.join("；")}`);
  const c = r.commands[0];
  assert.equal(c.name, "weekly");
  assert.equal(c.description, "写周报");
  assert.equal(c.prompt, "帮我写一份本周周报，按项目分组。");
  assert.equal(c.pluginId, "lynn.demo.cmd");
});

test("命令名带插件前缀（两个插件不会抢同一个名字）", () => {
  const root = tmp();
  makePlugin(root, "lynn.a", { commands: [{ name: "go", prompt: "A 的" }] });
  makePlugin(root, "lynn.b", { commands: [{ name: "go", prompt: "B 的" }] });
  const r = scanPluginCommands(root);
  assert.equal(r.commands.length, 2, "同名命令在两个插件下应共存");
  assert.deepEqual(r.commands.map((c) => c.id).sort(), ["lynn.a:go", "lynn.b:go"]);
});

test("文件形式：命令名取文件名，描述取一级标题", () => {
  const root = tmp();
  const dir = makePlugin(root, "lynn.demo.file", { commands: ["commands/weekly-report.md"] });
  fs.mkdirSync(path.join(dir, "commands"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "commands", "weekly-report.md"),
    "# 周报生成\n\n把本周的工单汇总成一份周报，按项目分组，标出未完成的。\n",
    "utf8",
  );
  const r = scanPluginCommands(root);
  assert.equal(r.commands.length, 1, `没读到：${r.errors.join("；")}`);
  assert.equal(r.commands[0].name, "weekly-report");
  assert.equal(r.commands[0].description, "周报生成", "描述应取一级标题");
  assert.match(r.commands[0].prompt, /按项目分组/, "prompt 应是文件全文");
});

test("坏命令报具体原因，且不拖垮同插件的其它命令", () => {
  const root = tmp();
  makePlugin(root, "lynn.demo.mixed", {
    commands: [
      { name: "good", prompt: "能用的" },
      { name: "Bad Name", prompt: "名字不合法" },
      { name: "noprompt" },
    ],
  });
  const r = scanPluginCommands(root);
  assert.equal(r.commands.length, 1, "只有合法的那条该被收下");
  assert.equal(r.commands[0].name, "good");
  assert.equal(r.errors.length, 2, `应当报 2 条错误：${r.errors.join("；")}`);
  assert.ok(r.errors.some((e) => /Bad Name/.test(e)), "要指出哪个名字不合法");
  assert.ok(r.errors.some((e) => /noprompt/.test(e) && /prompt/.test(e)), "要指出缺 prompt");
});

test("命令文件不存在：报错并点名是哪个文件", () => {
  const root = tmp();
  makePlugin(root, "lynn.demo.missing", { commands: ["commands/nope.md"] });
  const r = scanPluginCommands(root);
  assert.equal(r.commands.length, 0);
  assert.ok(r.errors.some((e) => /nope\.md/.test(e)), `要点名文件：${r.errors.join("；")}`);
});

test("命令文件越界（../）：拒绝，不读插件目录外的文件", () => {
  const root = tmp();
  const dir = makePlugin(root, "lynn.demo.slip", { commands: ["../../../etc/passwd.md"] });
  // 在插件目录外放一个真文件，确认它不会被读到
  fs.writeFileSync(path.join(root, "outside.md"), "# 不该被读到", "utf8");
  const r = scanPluginCommands(root);
  assert.equal(r.commands.length, 0, "越界路径不该被接受");
  assert.ok(r.errors.some((e) => /越界/.test(e)), `要报越界：${r.errors.join("；")}`);
});

test("停用的插件不提供命令（与 _state.json 同一份真相）", () => {
  const root = tmp();
  makePlugin(root, "lynn.demo.off", { commands: [{ name: "go", prompt: "x" }] });
  setEnabled(root, "lynn.demo.off", false);
  const r = scanPluginCommands(root);
  assert.equal(r.commands.length, 0, "停用的插件不该有命令——否则会出现'关了插件命令还在'");
});

test("启用状态为 true 时命令照常出现", () => {
  const root = tmp();
  makePlugin(root, "lynn.demo.on", { commands: [{ name: "go", prompt: "x" }] });
  setEnabled(root, "lynn.demo.on", true);
  assert.equal(scanPluginCommands(root).commands.length, 1);
});

test("没有 plugins 目录时安静返回空（不抛）", () => {
  const root = tmp();
  const r = scanPluginCommands(root);
  assert.deepEqual(r.commands, []);
  assert.deepEqual(r.errors, []);
});

test("坏 manifest 的插件被跳过（由 PluginHost 负责报，这里不重复）", () => {
  const root = tmp();
  const dir = path.join(root, "plugins", "lynn.bad");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "plugin.json"), "{ 不是 JSON", "utf8");
  const r = scanPluginCommands(root);
  assert.deepEqual(r.commands, []);
});

test("命令顺序稳定（按 id 排，指令台里不会跳来跳去）", () => {
  const root = tmp();
  makePlugin(root, "lynn.z", { commands: [{ name: "zebra", prompt: "z" }] });
  makePlugin(root, "lynn.a", { commands: [{ name: "apple", prompt: "a" }] });
  const first = scanPluginCommands(root).commands.map((c) => c.id);
  const second = scanPluginCommands(root).commands.map((c) => c.id);
  assert.deepEqual(first, second, "两次扫描顺序必须一致");
  assert.deepEqual(first, [...first].sort(), "且按 id 排序");
});

test("超长 prompt 被截断到上限（命令是省打字，不是塞文档）", () => {
  const root = tmp();
  makePlugin(root, "lynn.demo.long", { commands: [{ name: "long", prompt: "x".repeat(20000) }] });
  const r = scanPluginCommands(root);
  assert.equal(r.commands.length, 1);
  assert.ok(r.commands[0].prompt.length <= 8000, `应截断到 8000，实际 ${r.commands[0].prompt.length}`);
});