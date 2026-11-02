import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { probeMcpServer, runOnce } from "../dist/main/plugin-probe.js";

/**
 * 隔离试装（§4.11.3）：一次性进程里跑起来、调用一次、再杀干净。
 * 任何一步失败都不进主程序——这里用真子进程验证，不 mock。
 */

const fixtures = path.resolve(import.meta.dirname, "fixtures");
const node = process.execPath;

test("MCP 握手成功：initialize → tools/list → shutdown，进程被杀干净", async () => {
  const r = await probeMcpServer({
    command: node,
    args: [path.join(fixtures, "mcp-echo.mjs")],
    timeoutMs: 5000,
    listTools: true,
  });
  assert.equal(r.ok, true, `${r.error ?? ""}\n${r.stderr}`);
  assert.equal(r.serverInfo?.name, "echo");
  assert.equal(r.protocolVersion, "2024-11-05");
  assert.deepEqual(r.tools, ["echo", "ping"]);
  assert.equal(r.timedOut, false);
});

test("卡死的 server 会被超时杀掉，并标记 timedOut", async () => {
  const started = Date.now();
  const r = await probeMcpServer({
    command: node,
    args: [path.join(fixtures, "hang.mjs")],
    timeoutMs: 600,
  });
  const took = Date.now() - started;
  assert.equal(r.ok, false);
  assert.equal(r.timedOut, true);
  assert.ok(took < 4000, `应在超时后很快返回，实际 ${took}ms`);
});

test("命令不存在时给出错误，不挂住", async () => {
  const r = await probeMcpServer({ command: "lynn-no-such-command-xyz", timeoutMs: 2000 });
  assert.equal(r.ok, false);
  assert.ok(r.error);
});

test("L1 试装用 runOnce：正常退出 / 非零退出 / 超时", async () => {
  const okRun = await runOnce({ command: node, args: ["-e", "process.exit(0)"] });
  assert.equal(okRun.ok, true);
  assert.equal(okRun.code, 0);

  const bad = await runOnce({ command: node, args: [path.join(fixtures, "fail.mjs")] });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 3);
  assert.match(bad.stderr, /boom/);

  const hung = await runOnce({ command: node, args: [path.join(fixtures, "hang.mjs")], timeoutMs: 500 });
  assert.equal(hung.ok, false);
  assert.equal(hung.timedOut, true);
});
