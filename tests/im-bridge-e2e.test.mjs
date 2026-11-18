/**
 * IM 端点端到端（P13-4）。
 *
 * 前两组测的是零件：`im-bridge` 的安全边界、`im-handlers` 的映射。
 * 这一组测**整条链**：真起服务、真发 HTTP、真拿到映射后的结果。
 *
 * 为什么值得单独一组：零件各自通过不代表接起来对。
 * 最常见的问题是"协议对不上"——`im-bridge` 按 `/api/<method>` 解析，
 * 而调用方以为要发到 `/api`；或者 body 里的 `rpcId` 没被回传。
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { startBridge } = await jiti.import("../src/main/im-bridge.ts", { default: true });
const { buildImHandlers } = await jiti.import("../src/main/im-handlers.ts", { default: true });

/** 按 dsh-im 的 HarnessClient 实际发的格式请求 */
function call(baseUrl, token, method, payload, rpcId = 1) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ type: "client-request", rpcId, method, payload });
    const req = http.request(
      new URL(`/api/${method}`, baseUrl),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          authorization: `Bearer ${token}`,
        },
      },
      (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(d) });
          } catch (e) {
            reject(new Error(`响应不是 JSON：${d.slice(0, 200)}`));
          }
        });
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

function fakeDeps() {
  return {
    listThreads: () => [{ id: "t-1", title: "群一" }],
    createThread: () => "t-new",
    switchThread: () => {},
    renameThread: () => {},
    threadHistory: () => [{ role: "user", text: "在吗" }],
    currentThreadId: () => "t-1",
    submitTurn: async () => {},
    abortTurn: () => {},
    listModels: () => [{ id: "deepseek-chat", label: "Chat" }],
    currentModelId: () => "deepseek-chat",
    selectModel: () => {},
    listWorkspaces: () => [{ path: "F:\\proj" }],
    createWorkspace: () => {},
    version: () => "0.0.2",
  };
}

async function withBridge(fn) {
  const bridge = await startBridge({ handlers: buildImHandlers(fakeDeps()) });
  try {
    return await fn(bridge);
  } finally {
    await bridge.close();
  }
}

test("e2e：握手 → 建会话 → 发消息 → 读历史，整条链能走通", async () => {
  await withBridge(async (b) => {
    // 1) 握手
    const hello = await call(b.baseUrl, b.token, "host.describe", {});
    assert.equal(hello.status, 200);
    assert.equal(hello.body.ok, true);
    assert.equal(hello.body.data.name, "lynn");
    assert.ok(hello.body.data.methods.includes("session.prompt"), "握手要告诉调用方 prompt 可用");

    // 2) 建会话
    const created = await call(b.baseUrl, b.token, "session.create", { title: "IM 群" }, 2);
    assert.equal(created.body.data.id, "t-new");
    assert.equal(created.body.rpcId, 2, "rpcId 必须回传，调用方靠它配对");

    // 3) 发消息
    const sent = await call(b.baseUrl, b.token, "session.prompt", { text: "看图", sessionId: "t-new" }, 3);
    assert.equal(sent.body.ok, true);

    // 4) 读历史
    const hist = await call(b.baseUrl, b.token, "session.history", { sessionId: "t-1" }, 4);
    assert.ok(Array.isArray(hist.body.data.messages));
    assert.equal(hist.body.data.messages.length, 1);
  });
});

test("e2e：不支持的方法返回 ok:false，且错误名可辨识", async () => {
  await withBridge(async (b) => {
    const r = await call(b.baseUrl, b.token, "session.fork", {});
    assert.equal(r.body.ok, false);
    assert.match(r.body.error, /不支持|没有分叉/);
  });
});

test("e2e：未实现的方法 404（不是 500，也不是静默成功）", async () => {
  await withBridge(async (b) => {
    const r = await call(b.baseUrl, b.token, "session.根本没有这个方法", {});
    assert.equal(r.status, 404);
    assert.equal(r.body.ok, false);
  });
});

test("e2e：并发 10 个请求各自拿到自己的 rpcId（不串）", async () => {
  await withBridge(async (b) => {
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => call(b.baseUrl, b.token, "session.list", {}, 100 + i)),
    );
    for (let i = 0; i < 10; i += 1) {
      assert.equal(results[i].body.rpcId, 100 + i, `第 ${i} 个请求的 rpcId 串了`);
      assert.equal(results[i].body.ok, true);
    }
  });
});

test("e2e：错误 token 的请求一个都进不去（并发 10 个全 401）", async () => {
  await withBridge(async (b) => {
    const results = await Promise.all(
      Array.from({ length: 10 }, () => call(b.baseUrl, "bad-token", "session.list", {})),
    );
    for (const r of results) assert.equal(r.status, 401);
  });
});