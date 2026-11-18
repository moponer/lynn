#!/usr/bin/env node
/**
 * WebSocket mux 连通性直测（P15-4）。
 *
 * 单独测这一环，是因为它是最容易"看起来通了其实没通"的地方：
 * HTTP 能建会话、能发消息，但事件流连不上 → 渠道永远停在"正在生成"。
 *
 * 测四件：
 *   1. 带 token 能连上
 *   2. 不带 token 被拒（401）
 *   3. 事件能推过来（帧格式对）
 *   4. 关闭后 socket 断开
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { startBridge } = require("../dist/main/im-bridge.js");
const { WebSocket } = require("ws");

const results = [];
const check = (label, ok, detail = "") => {
  results.push({ ok });
  console.log(`  ${ok ? "✅" : "✖ "} ${label}${detail ? `（${detail}）` : ""}`);
};

const subs = new Set();
const emit = (env) => {
  for (const p of subs) p(env);
};

let bridge = null;
try {
  bridge = await startBridge({
    handlers: { "host.describe": () => ({ name: "lynn" }) },
    subscribeEvents: (push) => {
      subs.add(push);
      return () => subs.delete(push);
    },
  });
  console.log(`桥：${bridge.baseUrl}\n`);

  const wsUrl = bridge.baseUrl.replace("http://", "ws://") + "/api/events.mux";

  // 1) 带 token 连接
  const withToken = await new Promise((resolve) => {
    const ws = new WebSocket(`${wsUrl}?token=${bridge.token}`);
    const timer = setTimeout(() => resolve({ ok: false, reason: "超时 3s" }), 3000);
    ws.on("open", () => {
      clearTimeout(timer);
      resolve({ ok: true, ws });
    });
    ws.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, reason: String(e.message).slice(0, 60) });
    });
  });
  check("带 token 能连上", withToken.ok, withToken.reason ?? "已连接");
  const ws = withToken.ws;

  // 2) 不带 token 被拒
  const noToken = await new Promise((resolve) => {
    const w = new WebSocket(wsUrl);
    const timer = setTimeout(() => resolve({ ok: true, reason: "超时（也算被拒）" }), 3000);
    w.on("open", () => {
      clearTimeout(timer);
      resolve({ ok: false, reason: "居然连上了" });
    });
    w.on("error", () => {
      clearTimeout(timer);
      resolve({ ok: true, reason: "被拒" });
    });
  });
  check("不带 token 被拒", noToken.ok, noToken.reason);

  // 3) 事件能推过来
  if (ws) {
    const got = [];
    ws.on("message", (data) => {
      try {
        got.push(JSON.parse(String(data)));
      } catch {
        /* 忽略 */
      }
    });
    await new Promise((r) => setTimeout(r, 200));
    emit({ type: "server-request", rpcId: "r1", method: "turn/start", payload: { type: "turn/start", data: { turn: "t1" } } });
    await new Promise((r) => setTimeout(r, 300));
    check("事件能推过来", got.length === 1, `收到 ${got.length} 帧`);
    if (got[0]) {
      const f = got[0];
      const shapeOk = f.type === "server-request" && f.method === "turn/start" && f.payload?.type === "turn/start";
      check("帧格式符合 vendor 期待", shapeOk, JSON.stringify(f).slice(0, 90));
    }
    ws.close();
    await new Promise((r) => setTimeout(r, 200));
  }

  // 4) 关闭桥后 socket 断开
  await bridge.close();
  const closed = ws ? ws.readyState === 3 || ws.readyState === 2 : true;
  check("关闭桥后 socket 断开", closed, `readyState=${ws?.readyState}`);
  bridge = null;
} catch (err) {
  console.error("\n出错：", err);
  results.push({ ok: false });
} finally {
  try {
    await bridge?.close();
  } catch {
    /* 忽略 */
  }
}

const pass = results.filter((r) => r.ok).length;
console.log(`\n=== ${pass}/${results.length} 通过 ===`);
process.exit(pass === results.length ? 0 : 1);