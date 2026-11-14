// M2-13：视觉/OCR 模型独立配置 —— 与对话模型解耦；加密纪律同 saveModel
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Kernel } from "../dist/main/kernel.js";
import { SettingsStore } from "../dist/main/settings.js";

test("SettingsStore：vision 独立存取/清除；主模型不受影响", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-vis-"));
  const s = new SettingsStore(root, (b) => b, () => true);
  assert.equal(s.getVisionModel(), null, "未配置如实 null");

  s.saveModel({ provider: "p", baseUrl: "https://a/v1", model: "chat-1", apiKey: "k1" });
  s.saveVisionModel({ provider: "p2", baseUrl: "https://b/v1", model: "vision-1", apiKey: "k2" });

  assert.equal(s.getModel().model, "chat-1", "主模型不受影响");
  assert.equal(s.getVisionModel().model, "vision-1");
  assert.equal(s.getVisionModel().apiKey.encrypted, true, "Key 同样加密落盘");

  // 未填 Key = 沿用旧
  s.saveVisionModel({ provider: "p2", baseUrl: "https://b/v1", model: "vision-2", previous: s.getVisionModel() });
  assert.equal(s.getVisionModel().model, "vision-2");
  assert.equal(s.getVisionModel().apiKey.data, s.getVisionModel().apiKey.data);

  s.clearVision();
  assert.equal(s.getVisionModel(), null);
  assert.equal(s.getModel().model, "chat-1", "清除只动 vision");
});

test("Kernel：config.vision.* RPC 闭环；首次必须给 Key", async () => {
  const kernel = new Kernel(fs.mkdtempSync(path.join(os.tmpdir(), "lynn-vis2-")));
  try {
    await kernel.init();
    assert.equal(kernel.handle("config.vision.get", {}).configured, false);

    const bad = kernel.handle("config.vision.save", { provider: "p", baseUrl: "https://b/v1", model: "vision-1" });
    assert.equal(bad.ok, false, "首次必须给 Key（如实拒绝）");
    assert.ok(bad.error.includes("API Key"));

    // 审计 #9（2026-11-13）：测试环境没有 safeStorage（内核注入 isEncryptionAvailable=()=>false），
    // 带 Key 但没勾「明文存储」也必须拒绝——不许静默把明文写进磁盘。
    const noPlaintext = kernel.handle("config.vision.save", {
      provider: "p",
      baseUrl: "https://b/v1",
      model: "vision-1",
      apiKey: "k",
    });
    assert.equal(noPlaintext.ok, false, "safeStorage 不可用且未确认明文 → 拒绝");
    assert.ok(noPlaintext.error.includes("明文"), `应说明明文风险：${noPlaintext.error}`);

    const ok = kernel.handle("config.vision.save", {
      provider: "p",
      baseUrl: "https://b/v1",
      model: "vision-1",
      apiKey: "k",
      plaintextOk: true,
    });
    assert.equal(ok.ok, true);
    const got = kernel.handle("config.vision.get", {});
    assert.equal(got.configured, true);
    assert.equal(got.model, "vision-1");
    assert.ok(!JSON.stringify(got).includes("k"), "明文 Key 永不下发渲染层");

    kernel.handle("config.vision.clear", {});
    assert.equal(kernel.handle("config.vision.get", {}).configured, false);
  } finally {
    await kernel.dispose();
  }
});
