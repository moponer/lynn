// 2026-11-11 改进项回归：真取消、429/5xx 退避、缓存口径不重复记账。
import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import { streamChat, streamChatWithRetry, LlmError } from "../dist/main/llm.js";

function sse(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

/** 可控 mock 端点：前 N 次按 script 返回错误，之后返回正常 SSE */
async function startServer(script, usage = null) {
  let calls = 0;
  const retries = [];
  const server = http.createServer((req, res) => {
    calls += 1;
    const step = script[Math.min(calls - 1, script.length - 1)];
    if (step?.status) {
      res.writeHead(step.status, {
        "Content-Type": "application/json",
        ...(step.retryAfter ? { "Retry-After": step.retryAfter } : {}),
      });
      res.end(JSON.stringify({ error: { message: step.message ?? "mock error" } }));
      return;
    }
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    sse(res, { choices: [{ delta: { role: "assistant" } }] });
    sse(res, { choices: [{ delta: { content: step?.text ?? "ok" } }] });
    sse(res, { choices: [{ delta: {}, finish_reason: "stop" }] });
    if (usage) sse(res, { choices: [], usage });
    res.write("data: [DONE]\n\n");
    res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    calls: () => calls,
    retries,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

const input = (baseUrl, extra = {}) => ({
  baseUrl,
  apiKey: "k",
  model: "m",
  messages: [{ role: "user", content: "hi" }],
  onDelta: () => undefined,
  ...extra,
});

test("429 读 Retry-After 后自动重试成功，attempts=2", async () => {
  const srv = await startServer([{ status: 429, retryAfter: "0.05" }, { text: "好了" }]);
  try {
    const r = await streamChatWithRetry(input(srv.baseUrl), {
      maxAttempts: 3,
      onRetry: (i) => srv.retries.push(i),
    });
    assert.equal(r.content, "好了");
    assert.equal(r.attempts, 2);
    assert.equal(srv.calls(), 2);
    assert.equal(srv.retries.length, 1);
    assert.equal(srv.retries[0].status, 429);
    assert.ok(srv.retries[0].delayMs < 500, `Retry-After 应生效，实际 ${srv.retries[0].delayMs}ms`);
  } finally {
    await srv.close();
  }
});

test("5xx 最多重试 3 次，仍失败时抛 LlmError(500)", async () => {
  const srv = await startServer([{ status: 500, retryAfter: "0.05" }]);
  try {
    await assert.rejects(
      () => streamChatWithRetry(input(srv.baseUrl), { maxAttempts: 3, onRetry: (i) => srv.retries.push(i) }),
      (err) => err instanceof LlmError && err.status === 500,
    );
    assert.equal(srv.calls(), 3);
    assert.equal(srv.retries.length, 2);
  } finally {
    await srv.close();
  }
});

test("400 不重试（非幂等错误不浪费请求）", async () => {
  const srv = await startServer([{ status: 400, retryAfter: "0.05" }]);
  try {
    await assert.rejects(
      () => streamChatWithRetry(input(srv.baseUrl), { maxAttempts: 3, onRetry: (i) => srv.retries.push(i) }),
      (err) => err instanceof LlmError && err.status === 400,
    );
    assert.equal(srv.calls(), 1);
    assert.equal(srv.retries.length, 0);
  } finally {
    await srv.close();
  }
});

test("用户停止：AbortController 立即断开流，不再等剩余 chunk", async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    sse(res, { choices: [{ delta: { content: "第" } }] });
    setTimeout(() => {
      if (!res.writableEnded) {
        sse(res, { choices: [{ delta: { content: "二" } }] });
        res.end();
      }
    }, 800);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  const controller = new AbortController();
  try {
    const started = Date.now();
    const p = streamChat(input(baseUrl, { signal: controller.signal }));
    setTimeout(() => controller.abort(), 40);
    await assert.rejects(() => p);
    assert.ok(Date.now() - started < 400, `停止应 <400ms，实际 ${Date.now() - started}ms`);
  } finally {
    await new Promise((r) => server.close(() => r()));
  }
});

test("DeepSeek 缓存字段：miss 不再重复记到 cacheWrite", async () => {
  const usage = {
    prompt_tokens: 1200,
    completion_tokens: 24,
    prompt_cache_hit_tokens: 900,
    prompt_cache_miss_tokens: 300,
  };
  const srv = await startServer([{ text: "ok" }], usage);
  try {
    const r = await streamChat(input(srv.baseUrl));
    assert.equal(r.cacheRead, 900);
    assert.equal(r.cacheWrite, 0, "miss 已在 prompt_tokens 里，不能当 cacheWrite 再记一次");
    assert.equal(r.cacheMiss, 300);
    assert.equal(r.promptTokens, 1200);
  } finally {
    await srv.close();
  }
});
