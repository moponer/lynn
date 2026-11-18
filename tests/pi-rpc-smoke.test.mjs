import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { AgentHost } from "../dist/main/agent-host.js";
import { PiRpcHost } from "../dist/main/pi-rpc-host.js";

/**
 * 真链路冒烟（M0-03）：真 Pi SDK 跑在**独立子进程**里，模型走本地 mock 端点，
 * 工具在主进程执行后回传。验证的是「壳 ↔ 运行时」这条接缝，不依赖真实 Key。
 */

function startMockModel() {
  let calls = 0;
  const firstMessages = [];
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body);
      seen.push(parsed);
      if (firstMessages.length === 0) firstMessages.push(...parsed.messages);
      const hasToolResult = parsed.messages.some((m) => m.role === "toolResult" || m.role === "tool");
      calls += 1;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      if (!hasToolResult) {
        send({
          id: "mock-1",
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  { index: 0, id: "call-1", function: { name: "test_echo", arguments: '{"message":"pi-ok"}' } },
                ],
              },
            },
          ],
        });
        send({ id: "mock-1", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
      } else {
        for (const piece of ["工具返回已确认：", "echo: pi-ok", "，链路正常。"]) {
          send({ id: "mock-1", choices: [{ index: 0, delta: { content: piece } }] });
        }
        send({ id: "mock-1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
        send({ id: "mock-1", choices: [], usage: { prompt_tokens: 42, completion_tokens: 11 } });
      }
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ server, calls: () => calls, firstMessages, seen })),
  );
}

test("M0-03 真链路：Pi 在子进程里跑，工具回壳执行，流式文本回传", { timeout: 180_000 }, async () => {
  const { server, firstMessages } = await startMockModel();
  const port = server.address().port;
  const entry = path.resolve(import.meta.dirname, "../agent/pi-rpc-entry.mjs");

  const events = [];
  const toolCalls = [];
  const host = new AgentHost({
    entryPath: entry,
    /**
     * Pi SDK 冷启动窗口。
     *
     * 20s 默认值在高载机器上必现超时（2026-11-09 实机）；60s 在 6 核机器上跑**全量 195 个测试文件**
     * 时仍会被饿死——`node --test` 按 CPU 核数并发起子进程，Pi 子进程的 Node 启动被排在后面。
     * 2026-11-17 全量跑实测 60s 超时、单跑 32s 通过，就是这种资源争抢。
     * 放宽到 180s 是**给测试环境留余量**，不是掩盖产品问题：真实启动耗时由性能指标单独管。
     */
    readyTimeoutMs: 180_000,
    model: { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "test-key", model: "mock-chat" },
    tools: [
      {
        name: "test_echo",
        description: "把 message 参数原样返回。",
        parameters: { type: "object", properties: { message: { type: "string" } }, required: ["message"] },
      },
    ],
    systemPrompt: "你是风铃（Lynn），一个指挥者，不亲自执行。",
    onToolCall: async (name, args) => {
      toolCalls.push({ name, args });
      return `echo: ${args.message}`;
    },
    onEvent: (ev) => events.push(ev),
    onError: (message) => events.push({ type: "on_error", message }),
  });

  try {
    await host.start();
    await host.request("prompt", { text: "请调用 test_echo，message 填 pi-ok，然后把结果告诉我。" });
    const text = events.filter((e) => e.type === "text_delta").map((e) => e.text).join("");
    const state = await host.request("get_state");

    console.log("[SMOKE] 子进程 pid 存活：", host.isRunning(), "| busy 回落：", state.isStreaming === false);
    console.log("[SMOKE] 工具在主进程执行：", JSON.stringify(toolCalls));
    console.log("[SMOKE] 流式文本：", JSON.stringify(text));

    assert.deepEqual(toolCalls, [{ name: "test_echo", args: { message: "pi-ok" } }], "工具必须回壳执行");
    assert.ok(text.includes("echo: pi-ok"), `流式文本应含工具结果，实际：${text}`);
    assert.ok(events.some((e) => e.type === "agent_start"), "应有 agent_start");
    assert.ok(events.some((e) => e.type === "agent_settled"), "应有 agent_settled");
    assert.equal(events.filter((e) => e.type === "on_error").length, 0, JSON.stringify(events.filter((e) => e.type === "on_error")));
    // 人设必须真的下发给模型（否则她答成别的助手）
    const sys = firstMessages.find((m) => m.role === "system");
    assert.ok(sys, "模型请求里应有 system 消息");
    assert.ok(String(sys.content).includes("风铃"), `system 消息应含人设：${String(sys.content).slice(0, 80)}`);
  } finally {
    await host.stop();
    server.close();
  }
});

/**
 * 官方 Pi RPC 真链路（架构红线）：起 Pi 自带 rpc-entry.js，风铃逻辑用 --extension 插件接入，
 * 工具经官方 extension_ui 子协议回壳。与上面的回退链路放在同一文件，测试运行时串行，
 * 避免两个真 Pi 子进程并发抢冷启动窗口（Windows 上会偶发 20s 启动超时）。
 */
test("官方 Pi RPC + 风铃扩展：模型流式、工具回壳、官方事件全链路", { timeout: 120_000 }, async () => {
  const { server, seen } = await startMockModel();
  const port = server.address().port;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-official-rpc-"));
  const entry = path.resolve(import.meta.dirname, "../node_modules/@earendil-works/pi-coding-agent/dist/bundle/rpc-entry.js");
  const extension = path.resolve(import.meta.dirname, "../agent/extensions/lynn-bridge.mjs");
  if (!fs.existsSync(entry)) {
    server.close();
    throw new Error("找不到 Pi 官方 rpc-entry.js，请先 npm ci");
  }

  const events = [];
  const errors = [];
  const toolCalls = [];
  const host = new PiRpcHost({
    entryPath: entry,
    extensionPath: extension,
    agentDir: path.join(dir, "agent"),
    sessionDir: path.join(dir, "sessions"),
    projectRoot: dir,
    personaFile: path.join(dir, "persona.md"),
    systemPrompt: "你是风铃（Lynn），一个指挥者。请用简体中文回答。",
    model: { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "test-key", model: "mock-chat", provider: "测试端点" },
    tools: [{
      name: "test_echo",
      description: "把 message 参数原样返回。",
      parameters: { type: "object", properties: { message: { type: "string" } }, required: ["message"] },
    }],
    onToolCall: async (name, args) => {
      toolCalls.push({ name, args });
      return `echo: ${args.message}`;
    },
    onEvent: (ev) => events.push(ev),
    onError: (m) => errors.push(m),
    watchdogMs: 2000,
  });

  try {
    await host.start();
    await host.prompt("请调用 test_echo，message 填 pi-ok，然后把结果告诉我。");

    const text = events
      .filter((e) => e.type === "message_update" && e.assistantMessageEvent?.type === "text_delta")
      .map((e) => e.assistantMessageEvent.delta)
      .join("");
    console.log("[OFFICIAL RPC] 事件类型：", [...new Set(events.map((e) => e.type))].join(","));
    console.log("[OFFICIAL RPC] 工具回壳：", JSON.stringify(toolCalls));

    assert.deepEqual(toolCalls, [{ name: "test_echo", args: { message: "pi-ok" } }], "工具必须回壳执行");
    assert.ok(text.includes("echo: pi-ok"), `流式文本应含工具结果，实际：${text}`);
    assert.ok(events.some((e) => e.type === "agent_start"));
    assert.ok(events.some((e) => e.type === "agent_settled"));
    assert.ok(events.some((e) => e.type === "extension_ui_request"), "工具桥应走官方 UI 子协议");
    assert.ok(events.some((e) => e.type === "tool_execution_end"), "官方工具执行事件应透传");
    assert.equal(errors.filter((m) => /Extension|扩展|failed/i.test(m)).length, 0, JSON.stringify(errors));
    // 人设由扩展的 before_agent_start 注入，必须真的进模型请求
    const sys = seen[0]?.messages?.find((m) => m.role === "system");
    assert.ok(sys, "模型请求里应有 system 消息");
    assert.ok(String(sys.content).includes("风铃"), `system 消息应含人设：${String(sys.content).slice(0, 120)}`);
  } finally {
    await host.stop();
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
