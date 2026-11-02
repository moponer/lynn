import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPack, checkPack, describePack } from "../dist/shared/lynnpack.js";

/**
 * .lynnpack 分享边界（计划书 §2.2 / §4.9）：
 * 只含配置；永不含记忆、会话、凭据、本地文件。
 */

const base = {
  kind: "lynnpack",
  version: 1,
  createdAt: "2026-11-01T00:00:00.000Z",
  theme: { id: "paper", mode: "light" },
  avatar: true,
  capabilities: ["browser"],
};

test("合法的配置包通过校验", () => {
  const r = checkPack(JSON.stringify(base));
  assert.equal(r.ok, true, r.issues.join("；"));
  assert.equal(r.pack?.theme.id, "paper");
});

test("混进 apiKey / token / memory 等字段一律拒收", () => {
  for (const bad of [{ apiKey: "sk-xxx" }, { token: "t" }, { memory: ["x"] }, { session: {} }]) {
    const r = checkPack(JSON.stringify({ ...base, ...bad }));
    assert.equal(r.ok, false, `应拒绝 ${JSON.stringify(bad)}`);
    assert.ok(r.issues.some((i) => i.includes("禁止字段")));
  }
});

test("kind / version / theme 不合法都拒绝", () => {
  assert.equal(checkPack(JSON.stringify({ ...base, kind: "pack" })).ok, false);
  assert.equal(checkPack(JSON.stringify({ ...base, version: 2 })).ok, false);
  assert.equal(checkPack(JSON.stringify({ ...base, theme: { id: "lingqing", mode: "dark" } })).ok, false);
  assert.equal(checkPack(JSON.stringify({ ...base, theme: { id: "night", mode: "dim" } })).ok, false);
  assert.equal(checkPack("not json").ok, false);
});

test("导出的包只有配置：不含凭据、记忆、会话", () => {
  const pack = buildPack({
    theme: { id: "celadon", mode: "dark" },
    avatar: false,
    model: { provider: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat" },
    capabilities: ["office", "browser"],
    roles: [{ name: "顾明", role: "文档校对", goal: "", tools: ["read", "write"] }],
    teamName: "我的班底",
  });
  const keys = JSON.stringify(pack).toLowerCase();
  for (const k of ["apikey", "api_key", "token", "memory", "session", "credential"]) {
    assert.ok(!keys.includes(`"${k}"`), `导出包里不该出现 ${k}`);
  }
  // 岗位模板只留岗位段
  assert.deepEqual(Object.keys(pack.teamTemplate.roles[0]).sort(), ["goal", "name", "role", "tools"]);
});

test("导入摘要逐项说清将要应用什么", () => {
  const pack = buildPack({
    theme: { id: "night", mode: "dark" },
    avatar: true,
    model: { provider: "GLM", baseUrl: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4.6" },
    capabilities: [],
    roles: [
      { name: "林工", role: "后端工程师", goal: "", tools: [] },
      { name: "阿岚", role: "数据分析师", goal: "", tools: [] },
    ],
  });
  const lines = describePack(pack);
  assert.ok(lines.some((l) => l.includes("夜航") && l.includes("暗色")));
  assert.ok(lines.some((l) => l.includes("不含 Key")));
  assert.ok(lines.some((l) => l.includes("2 个岗位")));
});
