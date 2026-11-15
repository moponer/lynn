// 端点风险闸：config.test/config.save、model.test/model.health；旧确认只继承到同一 baseUrl。
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { Kernel } from "../dist/main/kernel.js";

async function startServer() {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push({ method: req.method, url: req.url });
    if (req.method === "GET" && req.url?.endsWith("/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "test-model" }] }));
      return;
    }
    if (req.method === "POST" && req.url?.endsWith("/chat/completions")) {
      req.resume();
      req.on("end", () => {
        // probeEndpoint 是非流式请求：这里必须返回普通 JSON，不能返回 SSE。
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "chatcmpl-test", choices: [{ message: { role: "assistant", content: "ok" } }] }));
      });
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    hits,
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

async function setupKernel() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-p1-risk-"));
  const kernel = new Kernel(root);
  await kernel.init();
  return kernel;
}

const call = (kernel, method, params) => Promise.resolve(kernel.handle(method, params));

test("四条入口：本机端点未确认时零请求，显式确认后才允许探测", async () => {
  const srv = await startServer();
  const kernel = await setupKernel();
  try {
    const common = { baseUrl: srv.baseUrl, apiKey: "secret-key", model: "test-model" };
    const deniedSave = await call(kernel, "config.save", { provider: "local", ...common, plaintextOk: true });
    const deniedConfigTest = await call(kernel, "config.test", common);
    const deniedModelTest = await call(kernel, "model.test", common);
    const deniedHealth = await kernel.modelHealth(common);
    for (const result of [deniedSave, deniedConfigTest, deniedModelTest, deniedHealth]) {
      assert.equal(result.ok, false);
      assert.match(result.error, /风险确认/);
    }
    assert.equal(srv.hits.length, 0, "风险闸必须在任何网络请求之前");

    assert.equal((await call(kernel, "config.save", { provider: "local", ...common, plaintextOk: true, riskAccepted: true })).ok, true);
    assert.equal((await call(kernel, "config.test", { ...common, riskAccepted: true })).ok, true);
    assert.equal((await call(kernel, "model.test", { ...common, riskAccepted: true })).ok, true);
    const health = await kernel.modelHealth({ ...common, riskAccepted: true });
    assert.equal(health.ok, true);
    assert.equal(health.via, "models");
    assert.equal(srv.hits.length, 3, "两次 chat 探针 + 一次 models 健康检查");
  } finally {
    await kernel.dispose();
    await srv.close();
  }
});

test("已存端点沿用保存时确认；覆盖新 baseUrl 必须重新确认", async () => {
  const first = await startServer();
  const second = await startServer();
  const kernel = await setupKernel();
  try {
    const saved = await call(kernel, "model.save", {
      label: "本机一",
      provider: "local",
      baseUrl: first.baseUrl,
      model: "test-model",
      apiKey: "secret-key",
      plaintextOk: true,
      riskAccepted: true,
    });
    assert.equal(saved.ok, true);

    assert.equal((await call(kernel, "model.test", { id: saved.id })).ok, true, "model.test 继承同端点确认");
    assert.equal((await kernel.modelHealth({ id: saved.id })).ok, true, "model.health 继承同端点确认");
    assert.equal(
      (await call(kernel, "config.save", { provider: "local", baseUrl: first.baseUrl, model: "test-model" })).ok,
      true,
      "旧 config.save 同端点也可沿用确认与 Key",
    );
    assert.equal(
      (await call(kernel, "config.test", { baseUrl: first.baseUrl, apiKey: "", model: "test-model" })).ok,
      true,
      "config.test 继承当前已存端点确认",
    );

    const beforeOverride = second.hits.length;
    const modelOverride = await call(kernel, "model.test", { id: saved.id, baseUrl: second.baseUrl });
    const healthOverride = await kernel.modelHealth({ id: saved.id, baseUrl: second.baseUrl });
    const configOverride = await call(kernel, "config.test", { baseUrl: second.baseUrl, apiKey: "new-key", model: "test-model" });
    const saveOverride = await call(kernel, "config.save", {
      provider: "local",
      baseUrl: second.baseUrl,
      model: "test-model",
      apiKey: "new-key",
      plaintextOk: true,
    });
    for (const result of [modelOverride, healthOverride, configOverride, saveOverride]) {
      assert.equal(result.ok, false);
      assert.match(result.error, /风险确认/);
    }
    assert.equal(second.hits.length, beforeOverride, "覆盖端点未重新确认时不能发请求");

    assert.equal(
      (await call(kernel, "model.test", { id: saved.id, baseUrl: second.baseUrl, riskAccepted: true })).ok,
      true,
    );
    assert.equal(
      (await call(kernel, "config.save", {
        provider: "local",
        baseUrl: second.baseUrl,
        model: "test-model",
        apiKey: "new-key",
        plaintextOk: true,
        riskAccepted: true,
      })).ok,
      true,
    );
  } finally {
    await kernel.dispose();
    await first.close();
    await second.close();
  }
});
