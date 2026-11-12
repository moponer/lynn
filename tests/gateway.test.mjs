// 2026-11-11：本机免费/本地网关探测（只读 /models，不启动进程）。
import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import { probeGateways } from "../dist/main/gateways.js";

function preset(baseUrl, needsKey = false) {
  return { id: "x", name: "Mock", baseUrl, needsKey, docsUrl: "https://example.com", note: "test" };
}

async function server(mode) {
  const srv = http.createServer((req, res) => {
    if (mode === "401") {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    if (req.url?.endsWith("/models")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "a" }, { id: "b" }] }));
      return;
    }
    res.writeHead(404).end("no");
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return { baseUrl: `http://127.0.0.1:${srv.address().port}/v1`, close: () => new Promise((r) => srv.close(() => r())) };
}

test("probeGateways：运行中 → running + 模型数", async () => {
  const srv = await server("ok");
  try {
    const [g] = await probeGateways([preset(srv.baseUrl)], 1500);
    assert.equal(g.status, "running");
    assert.equal(g.modelCount, 2);
  } finally {
    await srv.close();
  }
});

test("probeGateways：401 + needsKey → needs_key，不是 down", async () => {
  const srv = await server("401");
  try {
    const [g] = await probeGateways([preset(srv.baseUrl, true)], 1500);
    assert.equal(g.status, "needs_key");
  } finally {
    await srv.close();
  }
});

test("probeGateways：端口没服务 → down，带真实错误", async () => {
  const [g] = await probeGateways([preset("http://127.0.0.1:1/v1")], 600);
  assert.equal(g.status, "down");
  assert.ok(g.error);
});
