/**
 * 本地 IM 端点（P13-2）。
 *
 * 这个模块的价值在于让外部网关接上 Lynn，所以测试的重点**不是"能收请求"**，
 * 而是**"只该被信任的调用方收到"**——一个监听端口的模块，安全边界错了
 * 比没有它更危险。
 *
 * 守五条：
 *  1. 只监听 loopback（不 bind 0.0.0.0）；
 *  2. token 不对一律 401；
 *  3. 带 Origin 的跨站请求一律 403；
 *  4. 未实现的方法 404，且错误里列出已实现清单（排障友好）；
 *  5. 超大 body 被拒，不打满内存。
 */
/**
 * 桥的信封形状（P15-7）：
 *
 * ```
 * 请求：{ type: "client-request", rpcId, method, payload }
 * 响应：{ type: "server-response", rpcId, result: { ok, value?, error? } }
 * ```
 *
 * 这个形状不是随意定的——vendored `HarnessClient` 逐字段校验它
 * （harness-client.mjs:1136-1147）：`type` 必须是 `server-response`、
 * `rpcId` 必须相等、`result.ok` 必须是布尔。任何一项不对都报
 * `harness-response-invalid`，表现为"发消息没反应"。
 *
 * 早期版本用的是 `{ ok, data }`，对 vendor 完全不工作。
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { startBridge } = await jiti.import("../src/main/im-bridge.ts", { default: true });

/** 发一个请求到端点 */
function post(baseUrl, token, method, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(`/api/${method}`, baseUrl);
    const payload = JSON.stringify(body);
    const req = http.request(
      url,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...extraHeaders,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          let parsed = null;
          try {
            parsed = JSON.parse(data);
          } catch {
            /* 非 JSON 就留 null */
          }
          resolve({ status: res.statusCode, body: parsed, raw: data });
        });
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

/** 起一个只有两个方法的端点 */
async function withBridge(fn) {
  const bridge = await startBridge({
    handlers: {
      "host.describe": () => ({ name: "lynn", version: "test" }),
      "session.prompt": (p) => ({ echoed: p }),
    },
  });
  try {
    return await fn(bridge);
  } finally {
    await bridge.close();
  }
}

test("正常调用：带正确 token 能拿到结果", async () => {
  await withBridge(async (b) => {
    const r = await post(b.baseUrl, b.token, "host.describe", {
      type: "client-request",
      rpcId: 1,
      method: "host.describe",
      payload: {},
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.result.ok, true);
    assert.equal(r.body.result.value.name, "lynn");
    assert.equal(r.body.rpcId, 1, "rpcId 要原样回传（调用方靠它配对）");
  });
});

test("payload 原样透传给 handler", async () => {
  await withBridge(async (b) => {
    const payload = { text: "你好", threadId: "t-1" };
    const r = await post(b.baseUrl, b.token, "session.prompt", {
      type: "client-request",
      rpcId: 2,
      method: "session.prompt",
      payload,
    });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.result.value.echoed, payload);
  });
});

test("token 不对：401，且不透露任何业务信息", async () => {
  await withBridge(async (b) => {
    const r = await post(b.baseUrl, "wrong-token", "host.describe", {
      type: "client-request",
      rpcId: 1,
      method: "host.describe",
      payload: {},
    });
    assert.equal(r.status, 401);
    assert.equal(r.body.result.ok, false);
    assert.doesNotMatch(r.raw, /lynn|version/, "401 的响应里不该带业务数据");
  });
});

test("不带 token：401", async () => {
  await withBridge(async (b) => {
    const r = await post(b.baseUrl, "", "host.describe", {
      type: "client-request",
      rpcId: 1,
      method: "host.describe",
      payload: {},
    });
    assert.equal(r.status, 401);
  });
});

test("带 Origin 的跨站请求：403（浏览器发起的请求必须挡掉）", async () => {
  await withBridge(async (b) => {
    const r = await post(
      b.baseUrl,
      b.token,
      "host.describe",
      { type: "client-request", rpcId: 1, method: "host.describe", payload: {} },
      { origin: "https://evil.example.com" },
    );
    assert.equal(r.status, 403, "跨站请求即使 token 对也要拒——防 CSRF");
  });
});

test("未实现的方法：404，且错误里列出已实现清单", async () => {
  await withBridge(async (b) => {
    const r = await post(b.baseUrl, b.token, "session.fork", {
      type: "client-request",
      rpcId: 1,
      method: "session.fork",
      payload: {},
    });
    assert.equal(r.status, 404);
    assert.equal(r.body.result.ok, false);
    assert.match(r.body.result.error, /host\.describe/, "错误里要列出已实现的方法，方便排障");
  });
});

test("path 与 body 的 method 不一致：400（防止绕过白名单）", async () => {
  await withBridge(async (b) => {
    const r = await post(b.baseUrl, b.token, "host.describe", {
      type: "client-request",
      rpcId: 1,
      method: "session.prompt",
      payload: {},
    });
    assert.equal(r.status, 400);
  });
});

test("handler 抛错：返回 ok:false 而不是 500（调用方要能读到原因）", async () => {
  const bridge = await startBridge({
    handlers: {
      "session.prompt": () => {
        throw new Error("模型没配置");
      },
    },
  });
  try {
    const r = await post(bridge.baseUrl, bridge.token, "session.prompt", {
      type: "client-request",
      rpcId: 1,
      method: "session.prompt",
      payload: {},
    });
    assert.equal(r.status, 200, "业务错误用 200 + ok:false，不是 500");
    assert.equal(r.body.result.ok, false);
    assert.match(r.body.result.error, /模型没配置/);
  } finally {
    await bridge.close();
  }
});

test("GET 请求：405（只接受 POST）", async () => {
  await withBridge(async (b) => {
    const status = await new Promise((resolve, reject) => {
      const req = http.get(new URL("/api/host.describe", b.baseUrl), { headers: { authorization: `Bearer ${b.token}` } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on("error", reject);
    });
    assert.equal(status, 405);
  });
});

test("非 JSON body：400", async () => {
  await withBridge(async (b) => {
    const r = await new Promise((resolve, reject) => {
      const payload = "这不是 JSON";
      const req = http.request(
        new URL("/api/host.describe", b.baseUrl),
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(payload),
            authorization: `Bearer ${b.token}`,
          },
        },
        (res) => {
          let d = "";
          res.on("data", (c) => (d += c));
          res.on("end", () => resolve({ status: res.statusCode }));
        },
      );
      req.on("error", reject);
      req.end(payload);
    });
    assert.equal(r.status, 400);
  });
});

test("只监听 loopback：从非 127.0.0.1 地址连不上", async () => {
  await withBridge(async (b) => {
    /**
     * 用本机的非 loopback 网卡地址尝试连接，应当失败。
     * 拿不到网卡就跳过（不同机器环境不同，不能因此让测试红）。
     */
    const os = await import("node:os");
    const ifaces = os.networkInterfaces();
    let lanAddr = null;
    for (const list of Object.values(ifaces)) {
      for (const i of list ?? []) {
        if (i.family === "IPv4" && !i.internal) lanAddr = i.address;
      }
    }
    if (!lanAddr) return; // 没有非 loopback 网卡，跳过
    const ok = await new Promise((resolve) => {
      const req = http.get(`http://${lanAddr}:${b.port}/api/host.describe`, { timeout: 1000 }, () => resolve(true));
      req.on("error", () => resolve(false));
      req.on("timeout", () => {
        req.destroy();
        resolve(false);
      });
    });
    assert.equal(ok, false, `从 ${lanAddr} 连上了——说明监听了 0.0.0.0，这是漏洞`);
  });
});

test("token 每次启动都不同（不是写死的常量）", async () => {
  const a = await startBridge({ handlers: { "host.describe": () => ({}) } });
  const b = await startBridge({ handlers: { "host.describe": () => ({}) } });
  try {
    assert.notEqual(a.token, b.token);
    assert.equal(a.token.length, 64, "32 字节 hex = 64 字符");
    assert.notEqual(a.port, b.port, "随机端口不该撞");
  } finally {
    await a.close();
    await b.close();
  }
});

/**
 * 这一条守一个真实踩过的 bug：**URL 路径里的非 ASCII 必须解码**。
 *
 * HTTP 客户端会把 `/api/session.根本` 编码成 `/api/session.%E6%A0%B9%E6%9C%AC`，
 * 服务端 `req.url` 拿到的是编码后的形式。不解码就与 body 里的原文对不上，
 * 于是"未知方法"被误判成"path 与 body 不一致"——错误码从 404 变成 400，
 * 排障时完全找不着方向。
 */
test("非 ASCII 方法名：按解码后的名字判未知方法（404，不是 400）", async () => {
  await withBridge(async (b) => {
    const r = await post(b.baseUrl, b.token, "session.根本不存在", {
      type: "client-request",
      rpcId: 1,
      method: "session.根本不存在",
      payload: {},
    });
    assert.equal(r.status, 404, "应当报「没有这个方法」，而不是「path 与 body 不一致」");
    assert.match(r.body.result.error, /没有这个方法/);
  });
});