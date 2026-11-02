import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkManifest,
  loadManifestOrThrow,
  satisfiesKernelRange,
  MANIFEST_API_VERSION,
} from "../dist/main/plugin-manifest.js";

const valid = (over = {}) => ({
  id: "lynn.theme.lingqing",
  name: "铃青",
  version: "1.0.0",
  apiVersion: MANIFEST_API_VERSION,
  tier: "L0",
  engines: { kernel: "^0.0.1" },
  ...over,
});

test("合法的 L0 manifest 通过校验", () => {
  const r = checkManifest(valid());
  assert.equal(r.ok, true, JSON.stringify(r.issues));
});

test("id 必须是反向域名格式", () => {
  const r = checkManifest(valid({ id: "my-plugin" }));
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.field === "id"));
});

test("apiVersion 不匹配直接拒绝", () => {
  const r = checkManifest(valid({ apiVersion: 99 }));
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.field === "apiVersion"));
});

test("engines.kernel 缺失 = 版本闸门失败", () => {
  const r = checkManifest({ ...valid(), engines: {} });
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.field === "engines.kernel"));
});

test("L1 必须有 .ts 入口且显式声明权限", () => {
  const noEntry = checkManifest(valid({ tier: "L1" }));
  assert.equal(noEntry.ok, false);
  assert.ok(noEntry.issues.some((i) => i.field === "entry"));
  assert.ok(noEntry.issues.some((i) => i.field === "permissions"));

  const withEntry = checkManifest(
    valid({
      tier: "L1",
      entry: "./index.ts",
      permissions: { fs: ["$HOME/.lynn/knowledge/**"], net: ["api.deepseek.com"] },
    }),
  );
  assert.equal(withEntry.ok, true, JSON.stringify(withEntry.issues));
});

test("L1 声明 proc=true 直接拒绝（任意执行必须走 L2）", () => {
  const r = checkManifest(
    valid({
      tier: "L1",
      entry: "./index.ts",
      permissions: { proc: true },
    }),
  );
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.field === "permissions.proc"));
});

test("L2 必须有 mcp.recipe", () => {
  const r = checkManifest(valid({ tier: "L2" }));
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.field === "mcp.recipe"));

  const ok = checkManifest(valid({ tier: "L2", mcp: { recipe: "./recipe.json" } }));
  assert.equal(ok.ok, true, JSON.stringify(ok.issues));
});

test("U 档 slots 必须在卡槽白名单内", () => {
  const bad = checkManifest(
    valid({ tier: "U", contributes: { slots: ["free.canvas"] } }),
  );
  assert.equal(bad.ok, false);
  assert.ok(bad.issues.some((i) => i.field === "contributes.slots"));

  const good = checkManifest(
    valid({ tier: "U", contributes: { slots: ["card.renderer", "theme.tokens"] } }),
  );
  assert.equal(good.ok, true, JSON.stringify(good.issues));
});

test("工具短名不合法即拒绝（命名空间在运行时统一添加）", () => {
  const r = checkManifest(
    valid({ contributes: { tools: ["office_write", "Bad-Name"] } }),
  );
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.field === "contributes.tools"));
});

test("自研插件必须可追溯（generatedBy）", () => {
  const r = checkManifest(valid({ source: "self-authored" }));
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.field === "generatedBy"));
});

test("loadManifestOrThrow：通过返回对象，失败抛错并列出全部问题", () => {
  const m = loadManifestOrThrow(valid());
  assert.equal(m.id, "lynn.theme.lingqing");
  assert.throws(() => loadManifestOrThrow({ id: "x" }), /manifest 校验失败/);
});

test("版本闸门：^ / ~ / .x / 精确", () => {
  assert.equal(satisfiesKernelRange("1.4.0", "^1.2.0"), true);
  assert.equal(satisfiesKernelRange("2.0.0", "^1.2.0"), false);
  assert.equal(satisfiesKernelRange("1.4.9", "~1.4.0"), true);
  assert.equal(satisfiesKernelRange("1.5.0", "~1.4.0"), false);
  assert.equal(satisfiesKernelRange("1.4.2", "1.4.x"), true);
  assert.equal(satisfiesKernelRange("1.5.0", "1.4.x"), false);
  assert.equal(satisfiesKernelRange("1.4.0", "1.4.0"), true);
  assert.equal(satisfiesKernelRange("1.4.1", "1.4.0"), true);
});
