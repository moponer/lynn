#!/usr/bin/env node
/**
 * IM 端点真实验证（P13-5）。
 *
 * 前面几组测试用的是**假 deps**（`fakeDeps`），验证的是映射逻辑对不对。
 * 这个脚本用**真的 Kernel**，验证的是：
 *
 *   1. `kernel.imHost()` 返回的能力真的能调（不是只在类型上成立）；
 *   2. 端点起来后真的能握手、列会话、发消息；
 *   3. 关闭端点后端口真的释放。
 *
 * 为什么单独一个脚本而不是测试：它要真起 Kernel（读设置、建目录、可能要 Pi），
 * 在 `npm test` 的并发环境里跑会很慢且互相干扰。所以做成手动跑的一次性验证。
 *
 * 用法：
 *   node scripts/probe-im-bridge.mjs
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");

const { Kernel } = require("../dist/main/kernel.js");
const { startBridge } = require("../dist/main/im-bridge.js");
const { buildImHandlers } = require("../dist/main/im-handlers.js");

/** 发一个 RPC */
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
          } catch {
            reject(new Error(`响应不是 JSON：${d.slice(0, 200)}`));
          }
        });
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-im-probe-"));
// 最小设置：只要不崩就行
fs.writeFileSync(
  path.join(root, "settings.json"),
  JSON.stringify({
    model: { provider: "t", baseUrl: "http://127.0.0.1:9/v1", model: "m", apiKey: { encrypted: false, data: "k" }, updatedAt: new Date().toISOString() },
  }),
  "utf-8",
);

const results = [];
const check = (label, ok, detail = "") => {
  results.push({ label, ok, detail });
  console.log(`  ${ok ? "✅" : "✖ "} ${label}${detail ? `（${detail}）` : ""}`);
};

let kernel = null;
let bridge = null;
try {
  kernel = new Kernel(root);
  await kernel.init();
  console.log("Kernel 已启动\n");

  // 1) imHost 的能力真的可调
  console.log("=== 1) kernel.imHost() 的能力 ===");
  const host = kernel.imHost();
  const threads = host.listThreads();
  check("listThreads 返回数组", Array.isArray(threads), `${threads.length} 个会话`);
  check("currentThreadId 返回字符串", typeof host.currentThreadId() === "string");
  const models = host.listModels();
  check("listModels 返回数组", Array.isArray(models), `${models.length} 个模型`);
  check("version 非空", Boolean(host.version()), host.version());
  check("listWorkspaces 返回数组", Array.isArray(host.listWorkspaces()));

  // 2) 端点起来
  console.log("\n=== 2) 端点 ===");
  bridge = await startBridge({ handlers: buildImHandlers(host) });
  check("端点已监听", bridge.port > 0, `${bridge.baseUrl}`);
  check("token 是 64 字符", bridge.token.length === 64);

  // 3) 真实 HTTP 调用
  console.log("\n=== 3) 真实 HTTP ===");
  const hello = await call(bridge.baseUrl, bridge.token, "host.describe", {});
  check("host.describe 成功", hello.status === 200 && hello.body.ok === true);
  check("报的是 lynn", hello.body.data?.name === "lynn");
  check("声明了 12 个方法", hello.body.data?.methods?.length === 12, `${hello.body.data?.methods?.length} 个`);

  const list = await call(bridge.baseUrl, bridge.token, "session.list", {}, 2);
  check("session.list 成功", list.body.ok === true, `${list.body.data?.sessions?.length} 个会话`);
  check("rpcId 回传", list.body.rpcId === 2);

  const created = await call(bridge.baseUrl, bridge.token, "session.create", { title: "IM 测试群" }, 3);
  check("session.create 成功", created.body.ok === true, `id=${created.body.data?.id}`);
  const newId = created.body.data?.id;
  check("新会话出现在列表里", (await call(bridge.baseUrl, bridge.token, "session.list", {}, 4)).body.data.sessions.some((s) => s.id === newId));

  const renamed = await call(bridge.baseUrl, bridge.token, "session.rename", { sessionId: newId, title: "改名了" }, 5);
  check("session.rename 成功", renamed.body.ok === true);
  check("改名生效", (await call(bridge.baseUrl, bridge.token, "session.list", {}, 6)).body.data.sessions.find((s) => s.id === newId)?.title === "改名了");

  const hist = await call(bridge.baseUrl, bridge.token, "session.history", { sessionId: newId }, 7);
  check("session.history 成功", hist.body.ok === true, `${hist.body.data?.messages?.length} 条`);

  // 4) 安全
  console.log("\n=== 4) 安全 ===");
  const bad = await call(bridge.baseUrl, "wrong", "host.describe", {});
  check("错误 token 被拒", bad.status === 401);
  const unsupported = await call(bridge.baseUrl, bridge.token, "session.fork", {}, 8);
  check("不支持的方法明确拒绝", unsupported.body.ok === false && /不支持|没有分叉/.test(unsupported.body.error ?? ""));

  // 5) 关闭后端口释放
  console.log("\n=== 5) 关闭 ===");
  await bridge.close();
  const closed = await new Promise((resolve) => {
    const req = http.get(`${bridge.baseUrl}/api/host.describe`, { timeout: 1000 }, () => resolve(false));
    req.on("error", () => resolve(true));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
  check("关闭后端口不再响应", closed);
  bridge = null;
} catch (err) {
  console.error("\n验证过程出错：", err);
  results.push({ label: "整体流程", ok: false, detail: String(err) });
} finally {
  try {
    await bridge?.close();
  } catch {
    /* 忽略 */
  }
  try {
    await kernel?.dispose();
  } catch {
    /* 忽略 */
  }
  try {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* 忽略 */
  }
}

const pass = results.filter((r) => r.ok).length;
console.log(`\n=== 结果：${pass}/${results.length} 通过 ===`);
process.exit(pass === results.length ? 0 : 1);
