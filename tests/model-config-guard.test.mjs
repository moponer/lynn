// 2026-11-08 实机 401 回归：换 Base URL 不能沿用上一家的 API Key
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SettingsStore, loadApiKey } from "../dist/main/settings.js";
import { Kernel } from "../dist/main/kernel.js";

function store() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-model-guard-"));
  // 假加密：可逆，便于断言 Key 内容，同时保留 encrypted 标记的纪律
  return {
    root,
    s: new SettingsStore(root, (b) => Buffer.from(b, "utf-8"), () => true),
    decrypt: (b) => b.toString("utf-8"),
  };
}

test("换端点留空 Key：硬拒，旧配置一个字都不改", () => {
  const { root, s, decrypt } = store();
  try {
    s.saveModel({ provider: "MiniMax", baseUrl: "https://api.minimax.chat/v1", model: "MiniMax-M3.1-Flash", apiKey: "sk-old" });
    assert.throws(
      () => s.saveModel({
        provider: "anges-cn", baseUrl: "https://apihub.agnes-ai.cn/v1", model: "agnes-3.0-flash",
        previous: s.getModel(),
      }),
      /换了 Base URL|重新填写/,
    );
    assert.equal(s.getModel().baseUrl, "https://api.minimax.chat/v1");
    assert.equal(loadApiKey(s, decrypt), "sk-old");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("同一端点只换模型：留空仍沿用旧 Key；填新 Key 就换掉", () => {
  const { root, s, decrypt } = store();
  try {
    s.saveModel({ provider: "p", baseUrl: "https://a.example/v1", model: "m-1", apiKey: "k-1" });
    s.saveModel({ provider: "p", baseUrl: "https://a.example/v1/", model: "m-2", previous: s.getModel() });
    assert.equal(s.getModel().model, "m-2");
    assert.equal(loadApiKey(s, decrypt), "k-1");

    s.saveModel({ provider: "q", baseUrl: "https://b.example/v1", model: "m-3", apiKey: "k-2", previous: s.getModel() });
    assert.equal(s.getModel().baseUrl, "https://b.example/v1");
    assert.equal(loadApiKey(s, decrypt), "k-2");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("config.save RPC：换端点留空 Key 返回 ok:false + 原因，不静默", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-model-rpc-"));
  const kernel = new Kernel(root);
  try {
    await kernel.init();
    // 内核测试环境 safeStorage 恒 false（审计 #9）：明文落盘需显式 plaintextOk
    assert.equal(kernel.handle("config.save", { provider: "p", baseUrl: "https://a/v1", model: "m-1", apiKey: "k-1", plaintextOk: true }).ok, true);
    const rejected = kernel.handle("config.save", { provider: "q", baseUrl: "https://b/v1", model: "m-2" });
    assert.equal(rejected.ok, false);
    assert.match(rejected.error, /API Key|Base URL/);
    assert.equal(kernel.handle("config.get", {}).baseUrl, "https://a/v1", "拒绝后配置不能被改坏");
    assert.equal(kernel.handle("config.save", { provider: "q", baseUrl: "https://b/v1", model: "m-2", apiKey: "k-2", plaintextOk: true }).ok, true);
  } finally {
    await kernel.dispose();
    // 与 vision-config 一致：Windows 上 kernel 的目录句柄释放有延迟，不强删临时目录
  }
});
