// 模型库：看到已配置 / 编辑 / 删除 / 全局默认 / 每对话模型（2026-11-08 用户反馈）
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SettingsStore, loadApiKey } from "../dist/main/settings.js";
import { ThreadStore } from "../dist/main/threads.js";
import { Kernel } from "../dist/main/kernel.js";

function store() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-model-lib-"));
  return {
    root,
    s: new SettingsStore(root, (b) => Buffer.from(b, "utf-8"), () => true),
    decrypt: (b) => b.toString("utf-8"),
  };
}

test("老版本单条配置自动收编进模型库，不丢配置、不重复", () => {
  const { root, s, decrypt } = store();
  try {
    s.saveModel({ provider: "anges-cn", baseUrl: "https://apihub.agnes-ai.cn/v1", model: "agnes-3.0-flash", apiKey: "sk-old" });
    const list = s.getModels();
    assert.equal(list.length, 1, "旧单条应变成模型库里的一条");
    assert.equal(list[0].baseUrl, "https://apihub.agnes-ai.cn/v1");
    assert.equal(list[0].id, s.getDefaultModelId());
    assert.equal(s.getModels().length, 1, "重复读不能重复收编");
    assert.equal(loadApiKey(s, decrypt), "sk-old");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("新增 / 编辑 / 删除，每条 Key 独立；换端点不重填 Key 会被拒", () => {
  const { root, s, decrypt } = store();
  try {
    const a = s.upsertModel({ label: "A", provider: "p1", baseUrl: "https://a/v1", model: "m-1", apiKey: "k-a" });
    const b = s.upsertModel({ label: "B", provider: "p2", baseUrl: "https://b/v1", model: "m-2", apiKey: "k-b" });
    assert.equal(s.getModels().length, 2);
    assert.equal(s.getDefaultModelId(), a.id, "第一条自动成为默认");
    assert.equal(loadApiKey(s, decrypt, a.id), "k-a");
    assert.equal(loadApiKey(s, decrypt, b.id), "k-b");
    assert.equal(loadApiKey(s, decrypt, "nope"), null, "不存在的 id 不能回退到别的 Key");

    // 编辑 B：同端点只改模型，留空沿用 B 的 Key
    s.upsertModel({ id: b.id, label: "B2", provider: "p2", baseUrl: "https://b/v1", model: "m-3" });
    assert.equal(s.getModel(b.id).model, "m-3");
    assert.equal(loadApiKey(s, decrypt, b.id), "k-b");
    // 编辑 B：换端点还留空 → 硬拒
    assert.throws(
      () => s.upsertModel({ id: b.id, label: "B2", provider: "p3", baseUrl: "https://c/v1", model: "m-4" }),
      /换了 Base URL|重新填写/,
    );
    // 换端点 + 新 Key → 成功
    s.upsertModel({ id: b.id, label: "B2", provider: "p3", baseUrl: "https://c/v1", model: "m-4", apiKey: "k-c" });
    assert.equal(loadApiKey(s, decrypt, b.id), "k-c");

    s.setDefaultModel(b.id);
    assert.equal(s.getDefaultModelId(), b.id);
    assert.equal(loadApiKey(s, decrypt), "k-c", "默认模型的 Key 跟着切");

    const removed = s.removeModel(b.id);
    assert.equal(removed.ok, true);
    assert.equal(removed.defaultModelId, a.id, "删掉默认后自动回落到剩下那条");
    assert.equal(s.getModels().length, 1);
    assert.equal(loadApiKey(s, decrypt), "k-a");
    assert.equal(s.removeModel("nope").ok, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ThreadStore：每对话模型可设置、可清除", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-thread-model-"));
  try {
    const t = new ThreadStore(root);
    const th = t.create("审查 A");
    assert.equal(t.get(th.id).modelId, undefined);
    t.setModel(th.id, "m-1");
    assert.equal(t.get(th.id).modelId, "m-1");
    t.setModel(th.id, null);
    assert.equal(t.get(th.id).modelId, undefined, "null = 跟随全局默认");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Kernel：model.list/save/setDefault/setThread/remove 闭环，Key 永不下发", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-model-rpc-"));
  const kernel = new Kernel(root);
  try {
    await kernel.init();
    assert.equal(kernel.handle("model.list", {}).models.length, 0);

    // 内核测试环境 safeStorage 恒 false（审计 #9）：明文落盘需显式 plaintextOk
    const a = kernel.handle("model.save", { label: "对话模型 A", provider: "p1", baseUrl: "https://a/v1", model: "m-1", apiKey: "k-a", plaintextOk: true });
    assert.equal(a.ok, true);
    const b = kernel.handle("model.save", { label: "对话模型 B", provider: "p2", baseUrl: "https://b/v1", model: "m-2", apiKey: "k-b", plaintextOk: true });
    assert.equal(b.ok, true);

    let list = kernel.handle("model.list", {});
    assert.equal(list.models.length, 2);
    assert.equal(list.defaultModelId, a.id);
    assert.equal(list.activeModelId, a.id);
    assert.ok(list.models.every((m) => !("apiKey" in m)), "渲染层永远拿不到 Key 字段");
    assert.ok(list.models.every((m) => m.apiKeySet === true));

    assert.equal(kernel.handle("model.setDefault", { id: b.id }).ok, true);
    list = kernel.handle("model.list", {});
    assert.equal(list.defaultModelId, b.id);
    assert.equal(list.activeModelId, b.id);
    assert.equal(kernel.handle("config.get", {}).model, "m-2", "快照跟着默认模型走");

    assert.equal(kernel.handle("model.setThread", { id: a.id }).ok, true);
    list = kernel.handle("model.list", {});
    assert.equal(list.threadModelId, a.id);
    assert.equal(list.activeModelId, a.id, "对话覆盖优先于全局默认");
    assert.equal(kernel.handle("config.get", {}).model, "m-1");
    assert.equal(kernel.handle("model.setThread", { id: "nope" }).ok, false);

    assert.equal(kernel.handle("model.setThread", { id: null }).ok, true);
    assert.equal(kernel.handle("model.list", {}).activeModelId, b.id, "清除覆盖后回到全局默认");

    // 编辑：留空 Key 沿用、换端点留空被拒、Key 不明文回显
    assert.equal(kernel.handle("model.save", { id: a.id, label: "A2", provider: "p1", baseUrl: "https://a/v1", model: "m-9" }).ok, true);
    const bad = kernel.handle("model.save", { id: a.id, label: "A2", provider: "p3", baseUrl: "https://c/v1", model: "m-9" });
    assert.equal(bad.ok, false);
    assert.match(bad.error, /API Key|Base URL/);
    assert.ok(!JSON.stringify(kernel.handle("model.list", {})).includes("k-a"));

    const removed = kernel.handle("model.remove", { id: a.id });
    assert.equal(removed.ok, true);
    assert.equal(removed.defaultModelId, b.id);
    assert.equal(kernel.handle("model.list", {}).models.length, 1);
  } finally {
    await kernel.dispose();
    // Windows 上 kernel 目录句柄释放有延迟，不强删临时目录
  }
});
