// 2026-11-13 审计 P2 修复回归：
//  - redactSecrets：端点错误响应体凭据脱敏（#16）
//  - taskIdError：RPC taskId 字符集校验（#17——`..` 能让 base 本身跳出数据根）
//  - SettingsStore：safeStorage 不可用时明文落盘必须显式确认 + 文件权限 0600（#9）
//  - app.info：buildId 构建号形状（#19）
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { redactSecrets } from "../dist/main/endpoint.js";
import { taskIdError } from "../dist/main/path-guard.js";
import { SettingsStore } from "../dist/main/settings.js";
import { Kernel } from "../dist/main/kernel.js";

test("redactSecrets：Bearer/sk-/键值对形状的凭据一律打码（#16）", () => {
  assert.ok(!redactSecrets("Error: Bearer sk-abcdef1234567890 not valid").includes("sk-abcdef1234567890"));
  assert.ok(redactSecrets("Error: Bearer sk-abcdef1234567890 not valid").includes("Bearer ***"));
  assert.ok(!redactSecrets('invalid key "sk-proj-abcdefghij123456" provided').includes("sk-proj-abcdefghij123456"));
  assert.ok(!redactSecrets('{"error":{"message":"api_key = 9f8e7d6c5b4a3210bad"}}').includes("9f8e7d6c5b4a3210bad"));
  assert.ok(redactSecrets('{"error":{"message":"api_key = 9f8e7d6c5b4a3210bad"}}').includes("api_key=***") ||
    redactSecrets('{"error":{"message":"api_key = 9f8e7d6c5b4a3210bad"}}').includes("api_key =***") ||
    redactSecrets('{"error":{"message":"api_key = 9f8e7d6c5b4a3210bad"}}').includes("***"), "键值对形状要被打码");
  // 普通错误文案不受影响
  assert.equal(redactSecrets("HTTP 404：model not found"), "HTTP 404：model not found");
});

test("taskIdError：`..` / 绝对路径 / 空值全拒，合法 id 放行（#17）", () => {
  assert.equal(taskIdError("task-mwehcw5c-f"), null);
  assert.match(taskIdError("../../settings"), /不合法/);
  assert.match(taskIdError("C:\\Users\\x"), /不合法/);
  assert.match(taskIdError(""), /缺 taskId/);
  assert.match(taskIdError(undefined), /缺 taskId/);
  assert.match(taskIdError("a..b"), /不合法/);
});

test("SettingsStore：safeStorage 不可用时明文落盘必须显式 plaintextOk（#9）", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-plain-"));
  // 第三个参数 false = 模拟 Linux 无 keyring
  const s = new SettingsStore(root, (b) => Buffer.from(b, "utf-8"), () => false);
  assert.throws(
    () => s.upsertModel({ provider: "p", baseUrl: "https://a/v1", model: "m", apiKey: "secret-key" }),
    /明文.*风险确认|明文存储/,
    "不确认就拒绝保存",
  );
  assert.equal(s.getModel(), null, "拒绝后不落半条配置");
  const entry = s.upsertModel({ provider: "p", baseUrl: "https://a/v1", model: "m", apiKey: "secret-key", plaintextOk: true });
  assert.equal(entry.apiKey?.encrypted, false, "显式确认后按明文存储并如实标记");
  assert.equal(s.getModel()?.apiKey?.data, "secret-key");
  // safeStorage 可用的机器不受影响
  const s2 = new SettingsStore(root, (b) => Buffer.from(b, "utf-8"), () => true);
  const e2 = s2.upsertModel({ provider: "p2", baseUrl: "https://b/v1", model: "m2", apiKey: "k2" });
  assert.equal(e2.apiKey?.encrypted, true);
});

test("settings.json 落盘权限收紧为 0600（#9；POSIX 生效，Windows 尽力而为）", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-mode-"));
  const k = new Kernel(root);
  try {
    const file = path.join(root, "settings.json");
    k.handle("config.prefs", { heartbeatMinutes: 7 });
    assert.ok(fs.existsSync(file));
    if (process.platform !== "win32") {
      const mode = fs.statSync(file).mode & 0o777;
      assert.equal(mode, 0o600, "POSIX 下必须是 0600");
    }
  } finally {
    await k.dispose();
  }
});

test("app.info：buildId 是 git-N 或 t- 形状（#19）", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-bid-"));
  const k = new Kernel(root);
  try {
    const r = k.handle("app.info");
    assert.match(r.buildId ?? "", /^(git-\d+|t-\d+)$/);
    assert.match(r.buildAt ?? "", /^\d{4}-/, "buildAt 保留用于展示");
  } finally {
    await k.dispose();
  }
});
