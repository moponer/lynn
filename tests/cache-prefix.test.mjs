/**
 * 缓存前缀稳定性（P1-1 / B1）：
 * 「发送什么就存什么」——前一条 user 消息在后续请求里必须逐字节不变，
 * 否则从它开始的前缀缓存全部失效。
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { composeTurnText } from "../dist/main/turn-text.js";

function sse(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

/** 记录每次请求 body 的 mock 端点 */
async function startServer() {
  const bodies = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      try {
        bodies.push(JSON.parse(raw));
      } catch {
        bodies.push({ broken: raw.slice(0, 200) });
      }
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      sse(res, { choices: [{ delta: { role: "assistant" } }] });
      sse(res, { choices: [{ delta: { content: "好的" } }] });
      sse(res, { choices: [{ delta: {}, finish_reason: "stop" }] });
      sse(res, { choices: [], usage: { prompt_tokens: 100, completion_tokens: 5 } });
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    bodies,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "lynn-prefix-"));
}

function seedKernel(root, baseUrl, prefs = {}) {
  fs.writeFileSync(
    path.join(root, "settings.json"),
    JSON.stringify({
      model: {
        provider: "t",
        baseUrl,
        model: "m",
        apiKey: { encrypted: false, data: "k" },
        updatedAt: new Date().toISOString(),
      },
      prefs: { heartbeat: false, supervisor: false, ...prefs },
    }),
    "utf-8",
  );
  // 延迟 import：确保 dist 已构建
  return import("../dist/main/kernel.js").then(({ Kernel }) => new Kernel(root));
}

async function waitIdle(k, ms = 10_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (!k.busy) return;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error("等回合结束超时");
}

test("composeTurnText：技能在前、定向在后，空值不产生多余空行", () => {
  assert.equal(composeTurnText({ fullText: "hi" }), "hi");
  assert.equal(composeTurnText({ fullText: "hi", directive: "对林工说" }), "hi\n\n对林工说");
  assert.equal(composeTurnText({ fullText: "hi", skillText: "【技能】A" }), "【技能】A\n\nhi");
  assert.equal(
    composeTurnText({ fullText: "hi", directive: "对林工说", skillText: "【技能】A" }),
    "【技能】A\n\nhi\n\n对林工说",
  );
  // 空白技能不拼
  assert.equal(composeTurnText({ fullText: "hi", skillText: "   " }), "hi");
});

test("末轮不改工具面：所有请求都带全量 tools，触顶只补一次「只总结」", async () => {
  const bodies = [];
  let n = 0;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      bodies.push(JSON.parse(raw));
      n += 1;
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      sse(res, { choices: [{ delta: { role: "assistant" } }] });
      if (n <= 4) {
        // 前 4 轮一直调工具：把 maxAgentRounds=4 跑满，触发「触顶补总结」
        sse(res, {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: `c${n}`,
                    type: "function",
                    function: { name: "check_roster", arguments: "{}" },
                  },
                ],
              },
            },
          ],
        });
        sse(res, { choices: [{ delta: {}, finish_reason: "tool_calls" }] });
      } else {
        sse(res, { choices: [{ delta: { content: "总结完成" } }] });
        sse(res, { choices: [{ delta: {}, finish_reason: "stop" }] });
      }
      sse(res, { choices: [], usage: { prompt_tokens: 100, completion_tokens: 5 } });
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  const k = await seedKernel(tmpRoot(), baseUrl, { maxAgentRounds: 4 });
  try {
    await k.submitTurn("跑满轮次");
    await waitIdle(k, 20_000);
    assert.ok(bodies.length >= 5, `应包含 4 轮工具 + 1 次总结，实际 ${bodies.length}`);
    for (const b of bodies) {
      assert.ok(Array.isArray(b.tools) && b.tools.length > 0, "每个请求都必须带工具面（末轮也不许空）");
    }
    const last = bodies[bodies.length - 1];
    const lastUser = [...last.messages].reverse().find((m) => m.role === "user");
    assert.match(lastUser.content, /工具轮次已用尽/, "触顶后要明确要求收口");
  } finally {
    await new Promise((r) => server.close(() => r()));
  }
});

test("两轮对话：第一条 user 消息在第二次请求里逐字节不变", async () => {
  const srv = await startServer();
  const k = await seedKernel(tmpRoot(), srv.baseUrl);
  try {
    await k.submitTurn("第一条消息");
    await waitIdle(k);
    await k.submitTurn("第二条消息");
    await waitIdle(k);

    assert.ok(srv.bodies.length >= 2, `至少两次请求，实际 ${srv.bodies.length}`);
    const first = srv.bodies[0].messages;
    const second = srv.bodies[1].messages;
    const u1 = first.find((m) => m.role === "user");
    const u1again = second.find((m) => m.role === "user");
    assert.ok(u1 && u1again, "两次请求都要有 user 消息");
    assert.equal(u1again.content, u1.content, "第一条 user 消息必须原样保留（前缀不能变）");
    assert.ok(u1again.content.includes("第一条消息"));
    assert.ok(second.length > first.length, "第二轮应该多出消息");
  } finally {
    await srv.close();
  }
});
