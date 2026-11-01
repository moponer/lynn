/**
 * Pi 接缝实验 v2（计划书 §7 实验 1）：
 * 本地 mock OpenAI 兼容 SSE 端点 + Pi Agent 循环 + 自定义工具。
 * 不依赖真实 Key——验证的是「Pi 流式 + 工具调用」这条接缝本身。
 * 运行：npx electron scripts/pi-experiment.mjs
 */
import * as http from "node:http";
import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

function log(...args) {
  console.log("[EXP]", ...args);
}

/** mock 端点：第一次返回 tool_call，之后返回纯文本 */
function startMockServer() {
  let calls = 0;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body);
      const hasToolResult = parsed.messages.some((m) => m.role === "toolResult" || m.role === "tool");
      calls += 1;
      log(`mock 收到第 ${calls} 次请求（messages=${parsed.messages.length}）`);
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      if (!hasToolResult) {
        // 第一轮：请求调用工具
        send({
          id: "mock-1",
          choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call-1", function: { name: "test_echo", arguments: '{"message":"pi-ok"}' } }] } }],
        });
        send({ id: "mock-1", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
      } else {
        // 第二轮：流式吐最终文本
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
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

async function main() {
  const server = await startMockServer();
  const port = server.address().port;
  log("mock 端点: http://127.0.0.1:" + port + "/v1");

  // 1. ModelRuntime：SDK 会话的模型/凭据运行时（agentDir/auth.json 的内存替代）
  const runtime = await ModelRuntime.create({ refreshOnCreate: false });
  runtime.registerProvider("lynn-mock", {
    name: "Mock",
    baseUrl: `http://127.0.0.1:${port}/v1`,
    api: "openai-completions",
    apiKey: "test-key",
    models: [
      {
        id: "mock-chat",
        name: "mock-chat",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 8192,
      },
    ],
  });
  await runtime.setRuntimeApiKey("lynn-mock", "test-key");
  const model = runtime.getModel("lynn-mock", "mock-chat");
  if (!model) throw new Error("getModel 返回空");
  log("Model 对象就绪");

  // 2. 自定义工具（验证用：回声）
  let toolRan = false;
  const testEchoTool = {
    name: "test_echo",
    label: "Echo",
    description: "把 message 参数原样返回。",
    parameters: Type.Object({ message: Type.String({ description: "要回显的文本" }) }),
    execute: async (_id, params) => {
      toolRan = true;
      log("工具被调用: test_echo(", params.message, ")");
      return { content: [{ type: "text", text: `echo: ${params.message}` }], details: {} };
    },
  };

  // 3. 建 Pi 会话（SDK 层；内存会话；只启用自定义工具）
  const { session } = await createAgentSession({
    modelRuntime: runtime,
    model,
    sessionManager: SessionManager.inMemory(),
    customTools: [testEchoTool],
    tools: ["test_echo"],
  });

  let streamed = "";
  session.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      streamed += event.assistantMessageEvent.delta;
    } else if (event.type === "agent_end") {
      log("事件: agent_end");
    }
  });

  // 4. 发一条必须用工具才能完成的消息
  log("prompt 发送…");
  await session.prompt(`请调用 test_echo 工具，message 参数填 "pi-ok"，然后把工具返回的原样告诉我。`);
  await session.waitForIdle?.();

  // 5. 断言
  const assertions = [
    ["工具被执行", toolRan],
    ["流式收到文本", streamed.length > 0],
    ["文本包含回显", streamed.includes("echo: pi-ok")],
  ];
  let failed = false;
  for (const [name, ok] of assertions) {
    log(`${ok ? "PASS" : "FAIL"} — ${name}`);
    if (!ok) failed = true;
  }
  log("最终输出:", JSON.stringify(streamed));
  server.close();
  if (failed) throw new Error("实验断言未全过");
  console.log("[EXPERIMENT:OK] Pi 流式 + 工具调用链路跑通");
}

// Electron 主进程入口（.mjs 直跑）
const { app } = await import("electron");
app.whenReady().then(async () => {
  try {
    await main();
    app.exit(0);
  } catch (err) {
    console.error("[EXPERIMENT:FAIL]", err instanceof Error ? err.stack : err);
    app.exit(1);
  }
});
