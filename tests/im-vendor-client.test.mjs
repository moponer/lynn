/**
 * vendored HarnessClient ↔ 我们的桥（P15-7）。
 *
 * 这组测试守的是「照原插件方式实现」这个承诺：
 * 原插件的 `HarnessClient`（101 KB，vendor 里一行不改）必须能通过
 * 我们的本地端点跑完一整轮对话。
 *
 * ## 为什么这些形状这么"怪"
 *
 * 每个断言后面都对应一次真实失败。移植过程中依次踩到：
 *
 * | 症状 | 真因 |
 * |---|---|
 * | `harness-auth-required` 401 | vendor 不发鉴权头，要我们用 `fetchImpl` 注入 |
 * | `harness-response-invalid` | 响应要是 `{ type, rpcId, result: { ok, value } }` |
 * | `invalid response for workspace.list` | 要 `{ items:[{path,sessionIds}], archivedSessionIds }` |
 * | `invalid response for llm.models` | 模型对象要 `name`，我们给的是 `label` |
 * | `harness-reply-timeout` | `session.history` 要**事件格式**，不是消息列表 |
 * | `harness-reply-timeout`（再次） | 事件的 `seq` 必须在**事件对象内部** |
 * | `harness-turn-failed` | 收轮 reason 只认 `completed` |
 *
 * 所以这里不只测"能跑"，还测那些具体形状——它们才是移植的真难点。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { startBridge } = await import("../dist/main/im-bridge.js");
const { buildChannelHandlers } = await import("../dist/main/im-dsh-shapes.js");
const { recordEvent, resetLedger, beginTurn, endTurn, historyEvents } = await import("../dist/main/im-ledger.js");
const { mapKernelEvent, resetTurnSeq } = await import("../dist/main/im-event-map.js");
const { WebSocket } = await import("ws");

const SESSION = "s-test";
const WS_PATH = path.join(os.tmpdir(), "lynn-im-ws");

/** 起一套完整的桥 + 假内核 */
async function harness() {
  resetLedger();
  resetTurnSeq();
  let pushToWs = () => {};
  const emitKernel = (ev) => {
    recordEvent(ev, SESSION);
    for (const env of mapKernelEvent(ev, SESSION)) pushToWs(env);
  };

  const deps = {
    listThreads: () => [{ id: SESSION, title: "测试会话" }],
    createThread: () => SESSION,
    switchThread: () => {},
    renameThread: () => {},
    threadHistory: () => [],
    currentThreadId: () => SESSION,
    submitTurn: () => {
      setTimeout(() => emitKernel({ type: "turn", turn: { busy: true } }), 5);
      setTimeout(() => emitKernel({ type: "delta", text: "回答正文" }), 15);
      setTimeout(() => emitKernel({ type: "done" }), 25);
    },
    waitTurn: () => new Promise((r) => setTimeout(r, 50)),
    abortTurn: () => {},
    listModels: () => [{ id: "m1", label: "模型一" }],
    currentModelId: () => "m1",
    selectModel: () => {},
    listWorkspaces: () => [{ path: WS_PATH, name: "ws" }],
    createWorkspace: () => {},
    version: () => "test",
  };

  const bridge = await startBridge({
    handlers: buildChannelHandlers(deps),
    subscribeEvents: (push) => {
      pushToWs = push;
      return () => {
        pushToWs = () => {};
      };
    },
  });

  const { HarnessClient } = await import("../src/main/im/vendor/shared/harness-client.mjs");
  const client = new HarnessClient({
    baseUrl: bridge.baseUrl,
    autostart: false,
    workspace: WS_PATH,
    // 适配层注入 token：vendor 自己不发鉴权头
    fetchImpl: (url, init) =>
      fetch(url, { ...init, headers: { ...(init?.headers ?? {}), authorization: `Bearer ${bridge.token}` } }),
    createWebSocket: (url) => {
      const u = new URL(url);
      u.searchParams.set("token", bridge.token);
      return new WebSocket(u.toString());
    },
  });

  return { bridge, client, emitKernel };
}

test("账本：事件自带 seq，且收轮用 completed", () => {
  resetLedger();
  beginTurn(SESSION, "rpc-x", "问题");
  recordEvent({ type: "delta", text: "答案" }, SESSION);
  endTurn(SESSION);
  const events = historyEvents(SESSION);
  const types = events.map((e) => e.event.type);
  assert.deepEqual(types, ["turn/start", "user/message", "assistant/chunk", "assistant/message", "turn/end"], `实际：${types.join(",")}`);

  /**
   * 关键：`seq` 必须在**事件对象内部**。
   * vendor 会 `entry?.event ?? entry` 解包后再读 `event.seq`，
   * 只放在外层会被当成 -1 而全部跳过（这就是 reply-timeout 的真因）。
   */
  for (const e of events) {
    assert.equal(typeof e.event.seq, "number", `${e.event.type} 的事件对象里没有 seq`);
    assert.equal(e.event.seq, e.seq, `${e.event.type} 的内外 seq 不一致`);
  }
  // 同一轮内严格递增
  const seqs = events.map((e) => e.seq);
  assert.deepEqual([...seqs].sort((a, b) => a - b), seqs, `seq 不是递增：${seqs.join(",")}`);

  const end = events.find((e) => e.event.type === "turn/end");
  assert.equal(end.event.data.reason.kind, "completed", "收轮 reason 只认 completed");
});

test("账本：user/message 带 source.rpcId（渠道靠它认领这一轮）", () => {
  resetLedger();
  beginTurn(SESSION, "rpc-abc", "问题");
  endTurn(SESSION);
  const um = historyEvents(SESSION).find((e) => e.event.type === "user/message");
  assert.equal(um.event.data.source.rpcId, "rpc-abc", "source.rpcId 是认领的凭据，不能丢");
});

test("形状：workspace.list 必须带 workspaceId 与 archivedSessionIds", async () => {
  const h = buildChannelHandlers({
    listThreads: () => [{ id: "a", title: "A" }],
    currentThreadId: () => "a",
    listWorkspaces: () => [{ path: WS_PATH, name: "ws" }],
    listModels: () => [],
    version: () => "t",
    createThread: () => "a",
    switchThread: () => {},
    renameThread: () => {},
    threadHistory: () => [],
    submitTurn: () => {},
    waitTurn: async () => {},
    abortTurn: () => {},
    currentModelId: () => "",
    selectModel: () => {},
    createWorkspace: () => {},
  });
  const r = h["workspace.list"]({});
  assert.ok(Array.isArray(r.items));
  assert.ok(Array.isArray(r.archivedSessionIds), "缺 archivedSessionIds 会被 vendor 判为 invalid");
  assert.equal(typeof r.items[0].workspaceId, "string", "缺 workspaceId 会反复走创建流程");
  assert.ok(Array.isArray(r.items[0].sessionIds));
});

test("形状：llm.models 必须是 name 而不是 label", async () => {
  const h = buildChannelHandlers({
    listThreads: () => [],
    currentThreadId: () => "",
    listWorkspaces: () => [],
    listModels: () => [{ id: "m1", label: "模型一" }],
    version: () => "t",
    createThread: () => "",
    switchThread: () => {},
    renameThread: () => {},
    threadHistory: () => [],
    submitTurn: () => {},
    waitTurn: async () => {},
    abortTurn: () => {},
    currentModelId: () => "",
    selectModel: () => {},
    createWorkspace: () => {},
  });
  const r = h["llm.models"]({});
  assert.ok(Array.isArray(r.groups));
  assert.ok(Array.isArray(r.failures));
  assert.equal(r.groups[0].models[0].name, "模型一", "vendor 校验要求 name 字段");
  assert.equal(r.groups[0].models[0].label, undefined, "多出来的 label 不该透传");
});

test("端到端：vendored HarnessClient 能跑完一整轮", async () => {
  const { bridge, client } = await harness();
  try {
    assert.equal(await client.health(), true, "host.describe 握手失败");
    const created = await client.createSession({});
    assert.equal(created, SESSION, "session.create 要返回 sessionId 字符串，不是对象");
    const models = await client.listModels();
    assert.ok(models.groups.length > 0);
    const answer = await client.ask(SESSION, "问题", { timeoutMs: 8000 });
    assert.match(String(answer), /回答正文/, `ask 没拿到回答：${String(answer).slice(0, 80)}`);
  } finally {
    await bridge.close();
  }
});

test("端到端：WebSocket 事件流能收到 turn/start 与 turn/end", async () => {
  const { bridge, client } = await harness();
  try {
    const seen = [];
    const ctl = new AbortController();
    const watcher = client
      .watchHarnessEvents({ signal: ctl.signal, onSessionEvent: (e) => seen.push(e.event?.type) })
      .catch(() => {});
    await new Promise((r) => setTimeout(r, 120));
    await client.ask(SESSION, "问题", { timeoutMs: 8000 });
    ctl.abort();
    await watcher;
    assert.ok(seen.includes("turn/start"), `没收到 turn/start：${seen.join(",")}`);
    assert.ok(seen.includes("turn/end"), `没收到 turn/end：${seen.join(",")}`);
  } finally {
    await bridge.close();
  }
});

test("安全：不带 token 的 WebSocket 被拒", async () => {
  const { bridge } = await harness();
  try {
    const wsUrl = bridge.baseUrl.replace("http://", "ws://") + "/api/events.mux";
    const rejected = await new Promise((resolve) => {
      const w = new WebSocket(wsUrl);
      const t = setTimeout(() => resolve(true), 2000);
      w.on("open", () => {
        clearTimeout(t);
        resolve(false);
      });
      w.on("error", () => {
        clearTimeout(t);
        resolve(true);
      });
    });
    assert.equal(rejected, true, "无 token 的 WS 不该连上");
  } finally {
    await bridge.close();
  }
});

test("vendor 目录仍是 MIT 且未改一行（source 里没有我们的注释）", () => {
  const vendor = path.join(process.cwd(), "src", "main", "im", "vendor");
  const meta = JSON.parse(fs.readFileSync(path.join(vendor, "UPSTREAM.json"), "utf8"));
  assert.equal(meta.license, "MIT");
  // 我们的改动只允许发生在 vendor 之外
  const bridgeFile = path.join(vendor, "shared", "harness-client.mjs");
  const src = fs.readFileSync(bridgeFile, "utf8");
  assert.doesNotMatch(src, /2026-11-18|Lynn 的|我们的适配层/, "vendor 里出现了本项目的注释，说明被改过");
});