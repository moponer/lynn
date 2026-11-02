// M1-22：lazy-mcp —— 冷启动不连懒加载 server，模型首次命中意图（mcp_connect_server）才拉起
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { McpRegistry, MCP_CONNECT_TOOL } from "../dist/main/mcp.js";
import { Kernel } from "../dist/main/kernel.js";

const fixture = path.resolve(import.meta.dirname, "fixtures", "mcp-echo-server.mjs");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lynn-lazy-"));

test("McpRegistry：lazy server 冷启动不 spawn；connect 后真工具注册且可调用", async () => {
  const reg = new McpRegistry();
  const fp0 = reg.fingerprint();
  await reg.startAll([
    { id: "lazy1", command: process.execPath, args: [fixture], enabled: true, lazy: true, timeoutMs: 8000 },
    { id: "off", command: "nope", enabled: false },
  ]);
  assert.equal(reg.size(), 0, "冷启动零子进程");
  assert.deepEqual(reg.lazyIds(), ["lazy1"]);
  const schemas = reg.schemas();
  const connect = schemas.find((s) => s.function.name === MCP_CONNECT_TOOL);
  assert.ok(connect, "意图元工具在工具面");
  assert.ok(String(connect.function.description).includes("lazy1"));
  assert.ok(reg.has(MCP_CONNECT_TOOL));
  assert.ok(!reg.has("mcp__lazy1__echo"), "真工具此时不可见");
  assert.notEqual(reg.fingerprint(), fp0, "lazy 待命计入指纹");

  // 命中意图：连接
  const msg = await reg.execute(MCP_CONNECT_TOOL, { server: "lazy1" });
  assert.ok(msg.includes("已连接 lazy1"));
  assert.deepEqual(reg.lazyIds(), [], "连接后不再待命");
  assert.ok(reg.has("mcp__lazy1__echo"), "真工具进工具面");
  assert.ok(!reg.schemas().some((s) => s.function.name === MCP_CONNECT_TOOL), "没有待命时元工具退场");

  // 真调用
  const out = await reg.execute("mcp__lazy1__echo", { message: "ping" });
  assert.ok(out.includes("ping"));

  // 重复连接同一个 → 已不在待命清单，如实报错
  await assert.rejects(() => reg.execute(MCP_CONNECT_TOOL, { server: "lazy1" }), /待命清单/);
  await assert.rejects(() => reg.execute(MCP_CONNECT_TOOL, { server: "不存在" }), /待命清单/);
  await reg.stopAll();
});

test("McpRegistry：connect 失败如实报错且保持待命", async () => {
  const reg = new McpRegistry();
  await reg.startAll([
    { id: "bad", command: "definitely-not-a-command-xyz", args: [], enabled: true, lazy: true, timeoutMs: 3000 },
  ]);
  await assert.rejects(() => reg.execute(MCP_CONNECT_TOOL, { server: "bad" }), /失败/);
  assert.deepEqual(reg.lazyIds(), ["bad"], "失败保持待命可重试");
  await reg.stopAll();
});

test("Kernel：lazy server 冷启动只有元工具，连接后工具面出现真工具", async () => {
  const root = tmp();
  fs.writeFileSync(
    path.join(root, "mcp.json"),
    JSON.stringify({
      servers: [
        { id: "echo", command: process.execPath, args: [fixture], enabled: true, lazy: true, timeoutMs: 8000 },
      ],
    }),
    "utf-8",
  );
  const kernel = new Kernel(root);
  try {
    await kernel.init();
    assert.ok(!kernel.toolNames().includes("mcp__echo__echo"), "冷启动没有真工具");
    assert.ok(kernel.toolNames().includes(MCP_CONNECT_TOOL), "元工具在");

    const msg = null;
    void msg;
    // 走内核注册表：连接后真工具进工具面
    const out = await kernel.mcp.execute(MCP_CONNECT_TOOL, { server: "echo" });
    assert.ok(out.includes("已连接 echo"));
    assert.ok(kernel.toolNames().includes("mcp__echo__echo"), "连接后真工具进工具面");
  } finally {
    await kernel.dispose();
  }
});
