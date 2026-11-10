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
