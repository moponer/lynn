// M0-07：最小 L2 MCP（stdio JSON-RPC）+ 与内置工具同一道门禁
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Kernel } from "../dist/main/kernel.js";
import { McpClient, McpRegistry, loadMcpConfig, mcpToolName } from "../dist/main/mcp.js";

const fixture = path.resolve(import.meta.dirname, "fixtures", "mcp-echo-server.mjs");
const server = (id = "echo") => ({ id, command: process.execPath, args: [fixture], enabled: true, timeoutMs: 8_000 });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lynn-mcp-"));

test("工具名映射：mcp__server__tool，非法字符归一", () => {
  assert.equal(mcpToolName("my-server", "read.file"), "mcp__my_server__read_file");
});

test("配置读取：没有文件=空，坏 JSON 报错，缺字段的条目被跳过", () => {
  const root = tmp();
  assert.deepEqual(loadMcpConfig(root).servers, []);

  fs.writeFileSync(path.join(root, "mcp.json"), "{not json", "utf-8");
  assert.match(loadMcpConfig(root).error, /解析失败/);

  fs.writeFileSync(
    path.join(root, "mcp.json"),
    JSON.stringify({ servers: [{ id: "a", command: "node" }, { id: 1 }, { command: "node" }] }),
    "utf-8",
  );
  const cfg = loadMcpConfig(root).servers;
  assert.equal(cfg.length, 1);
  assert.equal(cfg[0].id, "a");
  assert.equal(cfg[0].enabled, true);
});

test("连上 server：列工具、调用、错误如实回文本", async () => {
  const client = new McpClient(server());
  try {
    const tools = await client.start();
    assert.deepEqual(tools.map((t) => t.name).sort(), ["boom", "echo"]);
    assert.equal(await client.call("echo", { message: "hi" }), "echo:hi");
    assert.match(await client.call("boom", {}), /^MCP 工具报错：炸了/);
    await assert.rejects(() => client.call("nope", {}), /没有这个工具/);
  } finally {
    await client.stop();
  }
});

test("server 起不来：注册表记错误但不拖垮其它", async () => {
  const reg = new McpRegistry();
  try {
    await reg.startAll([{ id: "bad", command: "definitely-not-a-real-binary-xyz", args: [] }, server("good")]);
    assert.equal(reg.size(), 2, "echo 的两个工具在");
    assert.equal(reg.lastErrors().length, 1);
    assert.equal(reg.lastErrors()[0].id, "bad");
    assert.equal(await reg.execute(mcpToolName("good", "echo"), { message: "ok" }), "echo:ok");
  } finally {
    await reg.stopAll();
  }
});

test("进工具面，且与内置工具同一道权限门禁", async () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, "mcp.json"), JSON.stringify({ servers: [server()] }), "utf-8");
  const kernel = new Kernel(root);
  try {
    await kernel.init();
    const names = kernel.toolNames();
    assert.ok(names.includes("mcp__echo__echo"), `工具面里应有 MCP 工具：${names.join(",")}`);
    // 管理型 8 件仍在（MCP 不挤掉它们）
    assert.ok(names.includes("assign_task"));

    kernel.handle("permission.set", { mode: "plan" });
    const denied = await kernel.executeToolCall("mcp__echo__echo", { message: "x" });
    assert.match(denied, /权限档位=计划/);

    kernel.handle("permission.set", { mode: "auto" });
    assert.equal(await kernel.executeToolCall("mcp__echo__echo", { message: "通过" }), "echo:通过");
  } finally {
    await kernel.dispose();
  }
});
