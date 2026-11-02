import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { AgentHost } from "../dist/main/agent-host.js";

/**
 * 真链路冒烟（M0-03）：真 Pi SDK 跑在**独立子进程**里，模型走本地 mock 端点，
 * 工具在主进程执行后回传。验证的是「壳 ↔ 运行时」这条接缝，不依赖真实 Key。
 */

function startMockModel() {
  let calls = 0;
  const firstMessages = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body);
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
    server.listen(0, "127.0.0.1", () => resolve({ server, calls: () => calls, firstMessages })),
  );
}

test("M0-03 真链路：Pi 在子进程里跑，工具回壳执行，流式文本回传", { timeout: 90_000 }, async () => {
  const { server, firstMessages } = await startMockModel();
  const port = server.address().port;
  const entry = path.resolve(import.meta.dirname, "../agent/pi-rpc-entry.mjs");

  const events = [];
  const toolCalls = [];
  const host = new AgentHost({
    entryPath: entry,
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
