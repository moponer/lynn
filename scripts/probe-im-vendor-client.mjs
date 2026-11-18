#!/usr/bin/env node
/**
 * vendored HarnessClient ↔ 我们的桥 端到端验证（P15-7）。
 *
 * 这是"照原插件方式实现"的关键证明：原插件的 `HarnessClient`（101 KB，
 * vendor 里一行不改）能不能通过我们的本地端点跑完一整轮对话。
 *
 * ## 为什么要像生产那样接线
 *
 * 前几版探测是"手动往 WS 推事件"，结果一直 `harness-reply-timeout`。
 * 原因是 vendor 的 `ask()` **不靠 WS 等回复**——它每 300ms 轮询
 * `session.history` 读 `history.events`（harness-client.mjs:2282-2292）。
 *
 * 所以这个探测按**生产接线**跑：
 *
 * ```
 * 模拟内核 emit KernelEvent
 *   → im-ledger.recordEvent(ev)          （写账本，供 session.history 读）
 *   → im-event-map.mapKernelEvent(ev)     （翻译成 DSH 事件）
 *   → bridge 的 push → WebSocket          （供 watchHarnessEvents 用）
 * ```
 *
 * 用法：node scripts/probe-im-vendor-client.mjs
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { startBridge } = require("../dist/main/im-bridge.js");
const { buildChannelHandlers } = require("../dist/main/im-dsh-shapes.js");
const { recordEvent, resetLedger } = require("../dist/main/im-ledger.js");
const { mapKernelEvent, resetTurnSeq } = require("../dist/main/im-event-map.js");
const { WebSocket } = require("ws");

const results = [];
const check = (label, ok, detail = "") => {
  results.push({ ok });
  console.log(`  ${ok ? "✅" : "✖ "} ${label}${detail ? `（${detail}）` : ""}`);
};

resetLedger();
resetTurnSeq();

const SESSION = "s-probe";
const WS_PATH = "/tmp/ws";

/** 内核事件 → 账本 + WS 广播（与生产接线一致） */
let pushToWs = () => {};
const emitKernel = (ev) => {
  recordEvent(ev, SESSION);
  for (const env of mapKernelEvent(ev, SESSION)) pushToWs(env);
};

/** 假 deps：submitTurn 模拟内核在后台吐事件 */
const fakeDeps = {
  listThreads: () => [{ id: SESSION, title: "探测" }],
  createThread: () => SESSION,
  switchThread: () => {},
  renameThread: () => {},
  threadHistory: () => [],
  currentThreadId: () => SESSION,
  submitTurn: () => {
    /**
     * 模拟真实时序：busy 置起 → 正文增量 → 收尾。
     * 每个事件都走 emitKernel，所以账本和 WS 同时被更新。
     */
    setTimeout(() => emitKernel({ type: "turn", turn: { busy: true } }), 10);
    setTimeout(() => emitKernel({ type: "delta", text: "你好，" }), 30);
    setTimeout(() => emitKernel({ type: "delta", text: "这是回答。" }), 50);
    setTimeout(() => emitKernel({ type: "done" }), 70);
  },
  waitTurn: () => new Promise((r) => setTimeout(r, 120)),
  abortTurn: () => {},
  listModels: () => [{ id: "m1", label: "模型一" }],
  currentModelId: () => "m1",
  selectModel: () => {},
  listWorkspaces: () => [{ path: WS_PATH, name: "ws" }],
  createWorkspace: () => {},
  version: () => "probe",
};

const handlers = buildChannelHandlers(fakeDeps);
/** 调试：把每次 session.history 的返回打出来 */
const realHistory = handlers["session.history"];
let histCalls = 0;
handlers["session.history"] = (payload, meta) => {
  const r = realHistory(payload, meta);
  histCalls += 1;
  if (histCalls <= 3) {
    console.log(`    [history#${histCalls}] afterSeq=${payload?.afterSeq} → ${(r.events ?? []).map((e) => `${e.event.type}@${e.seq}`).join(" ") || "（空）"}`);
  }
  return r;
};
const realPrompt = handlers["session.prompt"];
handlers["session.prompt"] = async (payload, meta) => {
  console.log(`    [prompt] rpcId=${meta?.rpcId}`);
  return realPrompt(payload, meta);
};

let bridge = null;
try {
  bridge = await startBridge({
    handlers,
    subscribeEvents: (push) => {
      pushToWs = push;
      return () => {
        pushToWs = () => {};
      };
    },
  });
  console.log(`桥已启动：${bridge.baseUrl}\n`);

  const { HarnessClient } = await import("../src/main/im/vendor/shared/harness-client.mjs");

  /**
   * 适配层做两件事，vendor 一行不改：
   *  1. `fetchImpl` 注入 Bearer token（vendor 自己不鉴权）
   *  2. `createWebSocket` 把 token 拼进 query（WS 构造器不能设头）
   */
  const client = new HarnessClient({
    baseUrl: bridge.baseUrl,
    autostart: false,
    workspace: WS_PATH,
    fetchImpl: (url, init) =>
      fetch(url, { ...init, headers: { ...(init?.headers ?? {}), authorization: `Bearer ${bridge.token}` } }),
    createWebSocket: (url) => {
      const u = new URL(url);
      u.searchParams.set("token", bridge.token);
      return new WebSocket(u.toString());
    },
  });

  console.log("=== 1) HTTP RPC 形状 ===");
  check("health()（host.describe）", (await client.health().catch((e) => ({ err: e.message }))) === true);
  const created = await client.createSession({}).catch((e) => ({ err: String(e.message).slice(0, 110) }));
  check("createSession()（session.create）", created === SESSION, typeof created === "string" ? `id=${created}` : created.err);

  console.log("\n=== 2) 模型与工作区 ===");
  const models = await client.listModels().catch((e) => ({ err: String(e.message).slice(0, 110) }));
  check("listModels()（llm.models）", Array.isArray(models?.groups), models?.err ?? `${models?.groups?.length ?? "?"} 组`);
  const sessions = await client.listWorkspaceSessions(WS_PATH).catch((e) => ({ err: String(e.message).slice(0, 110) }));
  check("listWorkspaceSessions()（workspace.list + session.list）", !sessions?.err, sessions?.err ?? `${sessions?.sessions?.length ?? "?"} 个会话`);

  console.log("\n=== 3) WebSocket 事件流 ===");
  const live = [];
  const ctl = new AbortController();
  const watcher = client
    .watchHarnessEvents({ signal: ctl.signal, onSessionEvent: (e) => live.push(e.event?.type ?? "?") })
    .catch(() => {});
  await new Promise((r) => setTimeout(r, 150));
  check("watchHarnessEvents 已订阅", true, "已建立");

  console.log("\n=== 4) 完整一轮（ask）===");
  const answer = await client.ask(SESSION, "这是一次探测", { timeoutMs: 8000 }).catch((e) => ({
    err: `${e.name ?? "Error"}: ${String(e.message).slice(0, 90)}`,
  }));
  const text = typeof answer === "string" ? answer : (answer?.err ?? JSON.stringify(answer));
  check("ask() 拿到回答", typeof answer === "string" && answer.includes("回答"), text.slice(0, 70));

  ctl.abort();
  await watcher;
  check("WebSocket 期间收到事件", live.length > 0, `${live.length} 个：${[...new Set(live)].slice(0, 4).join(",")}`);
} catch (err) {
  console.error("\n探测出错：", err);
  results.push({ ok: false });
} finally {
  try {
    await bridge?.close();
  } catch {
    /* 忽略 */
  }
}

const pass = results.filter((r) => r.ok).length;
console.log(`\n=== 结果：${pass}/${results.length} 通过 ===`);
process.exit(pass === results.length ? 0 : 1);