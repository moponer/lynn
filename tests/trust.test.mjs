// M1-13：项目信任 —— 陌生仓库的 .lynn/mcp.json 不能自动注入工具
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TrustStore } from "../dist/main/trust.js";
import { Kernel } from "../dist/main/kernel.js";

const fixture = path.resolve(import.meta.dirname, "fixtures", "mcp-echo-server.mjs");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lynn-trust-"));

test("信任按绝对路径记，取消即失效；Windows 路径大小写不敏感", () => {
  const root = tmp();
  const t = new TrustStore(root);
  assert.equal(t.isTrusted(root), false);
  t.setTrusted(root, true);
  assert.equal(t.isTrusted(root), true);
  assert.equal(t.isTrusted(path.resolve(root, ".")), true);
  if (process.platform === "win32") assert.equal(t.isTrusted(root.toUpperCase()), true);
  t.setTrusted(root, false);
  assert.equal(t.isTrusted(root), false);
});

test("未信任项目：项目级 mcp.json 不加载；信任后才进工具面", async () => {
  const root = tmp();
  const project = path.join(root, "project");
  fs.mkdirSync(path.join(project, ".lynn"), { recursive: true });
  fs.writeFileSync(
    path.join(project, ".lynn", "mcp.json"),
    JSON.stringify({ servers: [{ id: "echo", command: process.execPath, args: [fixture], enabled: true }] }),
    "utf-8",
  );

  const kernel = new Kernel(root);
  try {
    await kernel.init();
    // 2026-11-10：默认工作区不再固定为 <dataRoot>/project，测试显式把根指到项目目录
    assert.equal(kernel.handle("project.setRoot", { root: project }).ok, true);
    // 换根后的 MCP 重载是异步的：测试里等它跑完，再断言"未信任会出卡"
    await kernel.reloadMcp({ quiet: false });
    const snap = kernel.handle("session.snapshot");
    assert.equal(snap.project.trusted, false);
    assert.equal(snap.project.hasMcp, true);
    assert.ok(!kernel.toolNames().includes("mcp__echo__echo"), "未信任时不得出现项目级工具");
    assert.ok(
      kernel.handle("session.snapshot").feed.some((c) => c.kind === "system" && /信任/.test(c.text ?? "")),
      "要在对话流里说清楚为什么没加载",
    );

    kernel.handle("trust.set", { trusted: true });
    // 重连是异步的（起子进程 + initialize + tools/list）
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline && !kernel.toolNames().includes("mcp__echo__echo")) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(kernel.toolNames().includes("mcp__echo__echo"), "信任后应加载项目级 MCP 工具");
    assert.equal(kernel.handle("session.snapshot").project.trusted, true);
  } finally {
    await kernel.dispose();
  }
});

/**
 * 2026-11-13：用户报"我手动选的目录为什么没被信任"。
 * 根因不是"信任错了"，是三件事：
 *  ①空目录也报「项目级插件与 MCP 不会加载」——那里根本没有可拦的东西；
 *  ②提示是死路：没说在哪点、也没给按钮；
 *  ③信任后项目级技能不重新发现（只重连了 MCP）——运行时技能表里始终没有它。
 */
test("空目录不该报「不会加载」：gated 说清这个目录到底有什么被闸", async () => {
  const root = tmp();
  const plain = path.join(root, "plain");
  fs.mkdirSync(plain, { recursive: true });
  const kernel = new Kernel(root);
  try {
    await kernel.init();
    const r = kernel.handle("project.setRoot", { root: plain });
    assert.equal(r.ok, true);
    assert.deepEqual(r.gated, { mcp: false, skills: false }, "空目录没有任何被信任闸住的东西");
    const snap = kernel.handle("session.snapshot");
    assert.deepEqual(snap.project.gated, { mcp: false, skills: false });
    // 对话流里也不该说「不会加载」——那里无物可拦
    const said = kernel
      .handle("session.snapshot")
      .feed.filter((c) => c.kind === "system")
      .map((c) => c.text ?? "")
      .join("\n");
    assert.ok(!/不会加载/.test(said), `不该报不会加载：${said}`);
  } finally {
    await kernel.dispose();
  }
});

test("gated：目录里有项目级 MCP / 项目级技能才标出来", async () => {
  const root = tmp();
  const withSkill = path.join(root, "with-skill");
  fs.mkdirSync(path.join(withSkill, ".lynn", "skills", "s1"), { recursive: true });
  fs.writeFileSync(path.join(withSkill, ".lynn", "skills", "s1", "SKILL.md"), "---\nname: s1\ndescription: d\n---\n\nx\n", "utf-8");
  const withMcp = path.join(root, "with-mcp");
  fs.mkdirSync(path.join(withMcp, ".lynn"), { recursive: true });
  fs.writeFileSync(path.join(withMcp, ".lynn", "mcp.json"), JSON.stringify({ servers: [] }), "utf-8");

  const kernel = new Kernel(root);
  try {
    await kernel.init();
    assert.deepEqual(kernel.handle("project.setRoot", { root: withSkill }).gated, { mcp: false, skills: true });
    assert.deepEqual(kernel.handle("project.setRoot", { root: withMcp }).gated, { mcp: true, skills: false });
  } finally {
    await kernel.dispose();
  }
});

test("信任后项目级技能真被重新发现并可激活（此前只重连 MCP，技能表没更新）", async () => {
  const root = tmp();
  const project = path.join(root, "project");
  fs.mkdirSync(path.join(project, ".lynn", "skills", "s1"), { recursive: true });
  fs.writeFileSync(path.join(project, ".lynn", "skills", "s1", "SKILL.md"), "---\nname: s1\ndescription: 项目技能\n---\n\nx\n", "utf-8");

  const kernel = new Kernel(root);
  try {
    await kernel.init();
    kernel.handle("project.setRoot", { root: project });
    assert.ok(!kernel.skillEntries.some((s) => s.name === "s1"), "未信任时项目技能不进运行时技能表");
    kernel.handle("trust.set", { trusted: true });
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(
      kernel.skillEntries.some((s) => s.name === "s1"),
      "信任后必须重新发现项目级技能（2026-11-13 修：此前只重连 MCP）",
    );
  } finally {
    await kernel.dispose();
  }
});
