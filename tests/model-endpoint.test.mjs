// 2026-11-11：自定义 OpenAI 兼容端点——模型发现、健康检查、本机/非 HTTPS 风险确认。
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import { Kernel } from "../dist/main/kernel.js";
import { endpointRiskLevel } from "../dist/shared/endpoint-risk.js";

async function startModelServer(hasModels = true) {
  const server = http.createServer((req, res) => {
    if (hasModels && req.url?.endsWith("/models")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "free-a", owned_by: "ofm" }, { id: "free-b" }] }));
      return;
    }
    if (req.url?.endsWith("/chat/completions")) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n');
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
    res.writeHead(404).end("not found");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  return { baseUrl: `http://127.0.0.1:${port}/v1`, close: () => new Promise((r) => server.close(() => r())) };
}

test("endpointRiskLevel：本机/局域网 local，http insecure，https remote", () => {
  assert.equal(endpointRiskLevel("http://127.0.0.1:18899/v1"), "local");
  assert.equal(endpointRiskLevel("http://localhost:1234/v1"), "local");
  assert.equal(endpointRiskLevel("http://192.168.1.5:8080/v1"), "local");
  assert.equal(endpointRiskLevel("http://example.com/v1"), "insecure");
  assert.equal(endpointRiskLevel("https://api.example.com/v1"), "remote");
});

test("model.discover：拉到 /v1/models；本机端点未确认风险则拒绝", async () => {
  const srv = await startModelServer();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-endpoint-"));
  const kernel = new Kernel(root);
  try {
    await kernel.init();
    const denied = await kernel.modelDiscover({ baseUrl: srv.baseUrl, apiKey: "k" });
    assert.equal(denied.ok, false);
    assert.match(denied.error, /风险确认|本机/);

    const r = await kernel.modelDiscover({ baseUrl: srv.baseUrl, apiKey: "k", riskAccepted: true });
    assert.equal(r.ok, true);
    assert.deepEqual(r.models.map((m) => m.id), ["free-a", "free-b"]);
    assert.equal(r.models[0].ownedBy, "ofm");
  } finally {
    await kernel.dispose();
    await srv.close();
  }
});

test("model.save / model.list：本机端点必须确认；确认后带 riskLevel/riskAccepted", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-endpoint-save-"));
  const kernel = new Kernel(root);
  try {
    const denied = kernel.handle("model.save", {
      label: "OFM",
      provider: "OFM",
      baseUrl: "http://127.0.0.1:18899/v1",
      model: "free-a",
      apiKey: "k",
    });
    assert.equal(denied.ok, false);
    assert.match(denied.error, /风险确认|本机/);

    const saved = kernel.handle("model.save", {
      label: "OFM",
      provider: "OFM",
      baseUrl: "http://127.0.0.1:18899/v1",
      model: "free-a",
      apiKey: "k",
      riskAccepted: true,
    });
    assert.equal(saved.ok, true);
    const list = kernel.handle("model.list", {});
    assert.equal(list.models[0].riskLevel, "local");
    assert.equal(list.models[0].riskAccepted, true);
  } finally {
    void kernel.dispose();
  }
});

test("model.health：/models 可用时返回 via=models，不花 token", async () => {
  const srv = await startModelServer(true);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-endpoint-health-"));
  const kernel = new Kernel(root);
  try {
    await kernel.init();
    const saved = kernel.handle("model.save", {
      label: "本地",
      provider: "Local",
      baseUrl: srv.baseUrl,
      model: "free-a",
      apiKey: "k",
      riskAccepted: true,
    });
    const r = await kernel.modelHealth({ id: saved.id });
    assert.equal(r.ok, true);
    assert.equal(r.via, "models");
    assert.equal(r.modelCount, 2);
    assert.ok(r.latencyMs >= 0);
  } finally {
    await kernel.dispose();
    await srv.close();
  }
});
