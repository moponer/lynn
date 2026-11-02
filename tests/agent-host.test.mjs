import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { AgentHost } from "../dist/main/agent-host.js";

const WORKER = path.resolve(import.meta.dirname, "fixtures/rpc-fake-worker.mjs");

function makeHost({ onToolCall, onEvent, onError, watchdogMs = 40 } = {}) {
  const events = [];
  const errors = [];
  const toolCalls = [];
  const host = new AgentHost({
    entryPath: WORKER,
    model: { baseUrl: "http://127.0.0.1:1/v1", apiKey: "k", model: "m" },
    tools: [{ name: "test_echo", description: "回声", parameters: { type: "object", properties: {} } }],
    onToolCall: async (name, args) => {
      toolCalls.push({ name, args });
      const custom = onToolCall?.(name, args);
      return custom ?? `echo: ${args.message}`;
    },
    onEvent: (ev) => {
      events.push(ev);
      onEvent?.(ev);
    },
    onError: (message) => {
      errors.push(message);
      onError?.(message);
    },
    watchdogMs,
  });
  return { host, events, errors, toolCalls };
}

test("握手：start 下发工具清单，worker 回 ready + init 响应", async () => {
  const { host } = makeHost();
  await host.start();
  assert.equal(host.isRunning(), true);
  const state = await host.request("get_state");
  assert.equal(state.isStreaming, false);
  await host.stop();
  assert.equal(host.isRunning(), false);
});

test("prompt：事件流 text_delta 顺序到达，settled 后 busy 回落", async () => {
  const { host, events } = makeHost();
  await host.start();
  await host.request("prompt", { text: "hi" });
  const text = events.filter((e) => e.type === "text_delta").map((e) => e.text).join("");
  assert.equal(text, "你好，世界。");
  assert.ok(events.some((e) => e.type === "agent_start"));
  assert.ok(events.some((e) => e.type === "agent_settled"));
  assert.equal(host.isBusy(), false);
  await host.stop();
});

test("工具回环：worker 发 tool_request → 壳执行 → 结果回传后继续出文本", async () => {
  const { host, events, toolCalls } = makeHost();
  await host.start();
  await host.request("prompt", { text: "tool" });
  assert.deepEqual(toolCalls, [{ name: "test_echo", args: { message: "pi-ok" } }]);
  const text = events.filter((e) => e.type === "text_delta").map((e) => e.text).join("");
  assert.ok(text.includes("工具返回：echo: pi-ok"), text);
  await host.stop();
});

test("工具执行抛错：错误内容回传给 worker，不炸壳", async () => {
  const { host, events } = makeHost({
    onToolCall: () => {
      throw new Error("权限拒绝");
    },
  });
  await host.start();
  await host.request("prompt", { text: "tool" });
  const text = events.filter((e) => e.type === "text_delta").map((e) => e.text).join("");
  assert.ok(text.includes("工具执行失败：权限拒绝"), text);
  await host.stop();
});

test("看门狗：worker 漏发 settled 时，两次探活对账后补 settled", async () => {
  const arrived = [];
  const { host } = makeHost({
    onEvent: (ev) => {
      if (ev.type === "agent_settled") arrived.push(ev);
    },
  });
  await host.start();
  await host.request("prompt", { text: "stuck" });
  assert.equal(host.isBusy(), true);
  assert.equal(arrived.length, 0);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(arrived.length, 1, "看门狗应收敛成一条补发 settled");
  assert.equal(arrived[0].reconciled, true);
  assert.equal(host.isBusy(), false);
  await host.stop();
});

test("worker 崩溃：挂起请求被拒 + stderr 带出来", async () => {
  const { host, errors } = makeHost();
  await host.start();
  const pending = host.request("prompt", { text: "crash" });
  await assert.rejects(() => pending, /Agent 子进程退出|exploding/);
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(
    errors.some((e) => e.includes("exploding on purpose")),
    `onError 应带 stderr：${errors.join(" | ")}`,
  );
  assert.equal(host.isRunning(), false);
});
