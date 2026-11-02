// M2-12：多 provider —— models.yaml 往返、坏配置如实报、模型发现（本地 http mock）
import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PRESETS, parseModelsYaml, serializeModelsYaml, loadProviders, saveProviders, discoverModels } from "../dist/main/providers.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lynn-prov-"));

test("内置五家预设齐全，价格未知如实为 null", () => {
  const ids = PRESETS.map((p) => p.id);
  for (const want of ["deepseek", "glm", "kimi", "qwen", "minimax"]) assert.ok(ids.includes(want), `缺预设 ${want}`);
  for (const p of PRESETS) {
    assert.ok(p.baseUrl.startsWith("https://"));
    assert.ok(p.models.length > 0);
    if (p.pricing) assert.equal(p.pricing.input, null, `${p.id} 没核实价就不该写数字`);
  }
});

test("models.yaml：解析往返一致；缺 id/base_url 整份不生效（如实报）", () => {
  const yaml = serializeModelsYaml([
    { id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", models: ["deepseek-chat"], contextWindow: 128000 },
    { id: "custom", baseUrl: "https://llm.corp/v1", models: ["a", "b"], apiKeyRef: "corp_key" },
  ]);
  const r = parseModelsYaml(yaml);
  assert.equal(r.error, undefined);
  assert.equal(r.providers.length, 2);
  assert.equal(r.providers[0].baseUrl, "https://api.deepseek.com/v1");
  assert.deepEqual(r.providers[1].models, ["a", "b"]);
  assert.equal(r.providers[1].apiKeyRef, "corp_key");

  const bad = parseModelsYaml("providers:\n  - id: broken\n    models: [x]\n");
  assert.ok(bad.error?.includes("缺 id 或 base_url"), "缺字段的整份拒绝，不静默");
  assert.deepEqual(bad.providers, []);

  assert.deepEqual(parseModelsYaml("").providers, []);
  assert.deepEqual(parseModelsYaml("# 只有注释").providers, []);
});

test("load/save：磁盘往返；坏文件如实报 error", () => {
  const root = tmp();
  assert.deepEqual(loadProviders(root).providers, []);
  saveProviders(root, [{ id: "glm", baseUrl: "https://open.bigmodel.cn/api/paas/v4", models: ["glm-4-flash"] }]);
  const r = loadProviders(root);
  assert.equal(r.error, undefined);
  assert.equal(r.providers[0].id, "glm");
  fs.writeFileSync(path.join(root, "models.yaml"), "providers:\n  - models: [x]\n", "utf-8");
  assert.ok(loadProviders(root).error, "坏条目要报出来");
});

test("discoverModels：真发 HTTP（本地 mock /models）", async () => {
  const server = http.createServer((req, res) => {
    if (req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "m-a" }, { id: "m-b" }, {}] }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  try {
    const ok = await discoverModels(`http://127.0.0.1:${port}/v1`);
    assert.deepEqual(ok.models, ["m-a", "m-b"], "缺 id 的条目过滤掉");
    const err = await discoverModels(`http://127.0.0.1:${port}/nope`);
    assert.ok(err.error?.includes("404"));
    const off = await discoverModels("http://127.0.0.1:9/v1", undefined, 800);
    assert.ok(off.error, "连不上要如实报错");
  } finally {
    server.close();
  }
});
