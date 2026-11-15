// 运行时错误脱敏：worker stderr/error 事件与 Pi errorMessage 都先 redactSecrets 再截断。
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { redactSecrets } from "../dist/main/endpoint.js";
import { Kernel } from "../dist/main/kernel.js";

const newKernel = () => new Kernel(fs.mkdtempSync(path.join(os.tmpdir(), "lynn-p1-redaction-")));

test("redactSecrets：Bearer、sk key 与 token/secret 参数统一打码", () => {
  const out = redactSecrets("Bearer abcdef1234567890 sk-abcd1234efgh5678 token=supersecretvalue password:anothersecret");
  assert.match(out, /Bearer \*\*\*/);
  assert.match(out, /sk-\*\*\*/);
  assert.match(out, /token=\*\*\*/);
  assert.match(out, /password=\*\*\*/);
  assert.doesNotMatch(out, /abcdef1234567890|abcd1234efgh5678|supersecretvalue|anothersecret/);
});

test("worker 错误落卡与 error 事件：先脱敏再截到 2000 字，不留部分凭据", async () => {
  const kernel = newKernel();
  const events = [];
  const off = kernel.onEvent((event) => events.push(event));
  try {
    const message = `${"x".repeat(1980)} Bearer abcdef1234567890 token=supersecretvalue ${"y".repeat(100)}`;
    kernel.reportRuntimeError(message);
    const card = kernel.feed.at(-1);
    const error = events.filter((event) => event.type === "error").at(-1);
    assert.ok(card.text.startsWith("运行时错误："));
    assert.ok(error);
    assert.ok(error.message.length <= 2000);
    assert.ok(card.text.length <= "运行时错误：".length + 2000);
    const visible = `${card.text}\n${error.message}`;
    assert.match(visible, /Bearer \*\*\*/);
    assert.doesNotMatch(visible, /abcdef1234567890|supersecretvalue/);
  } finally {
    off();
    await kernel.dispose();
  }
});

test("Pi message_end.errorMessage 落错误卡前同样脱敏，端点原文只保留安全前缀", async () => {
  const kernel = newKernel();
  const events = [];
  const off = kernel.onEvent((event) => events.push(event));
  try {
    const raw = `gateway failed ${"x".repeat(130)} Bearer abcdef1234567890 sk-abcd1234efgh5678 token=supersecretvalue`;
    kernel.ensureHost = async () => ({
      updateSystemPrompt: async () => undefined,
      prompt: async () => {
        kernel.onAgentEvent({
          type: "message_end",
          message: { role: "assistant", stopReason: "error", errorMessage: raw },
        });
        return {};
      },
      stats: async () => null,
    });
    await kernel.runChatRpc("ping");
    const cards = kernel.feed.map((card) => card.text ?? "").join("\n");
    const errors = events.filter((event) => event.type === "error").map((event) => event.message).join("\n");
    const visible = `${cards}\n${errors}`;
    assert.match(visible, /端点原文/);
    assert.doesNotMatch(visible, /abcdef1234567890|abcd1234efgh5678|supersecretvalue/);
    assert.doesNotMatch(visible, /Bearer abcdef|sk-abcd/);
  } finally {
    off();
    await kernel.dispose();
  }
});
