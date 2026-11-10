import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { scanUiPlugins } from "../dist/main/ui-plugins.js";

/** 从磁盘加载 U 档插件（§4.2.2 / §4.2.4）：只认 U、卡槽白名单、entry 必须留在插件目录内。 */

function newRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-ui-"));
  fs.mkdirSync(path.join(root, "plugins"), { recursive: true });
  return root;
}

function writePlugin(root, dir, manifest, html) {
  const d = path.join(root, "plugins", dir);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "plugin.json"), JSON.stringify(manifest, null, 2));
  if (html !== undefined) fs.writeFileSync(path.join(d, "ui.html"), html);
}

const base = {
  id: "lynn.demo.hello",
  name: "Hello",
  version: "1.0.0",
  apiVersion: 1,
  tier: "U",
  engines: { kernel: "^1.4.0" },
  entry: "./ui.html",
  contributes: { slots: ["status.bar"] },
  source: "marketplace",
};

test("合法的 U 插件被加载：manifest + iframe 文档", () => {
  const root = newRoot();
  writePlugin(root, "hello", base, "<button>hi</button>");
  const r = scanUiPlugins(root);
  assert.equal(r.errors.length, 0, r.errors.join("；"));
  assert.equal(r.plugins.length, 1);
  const p = r.plugins[0];
  assert.equal(p.manifest.id, "lynn.demo.hello");
  assert.deepEqual(p.manifest.slots, ["status.bar"]);
  assert.equal(p.manifest.source, "third-party");
  assert.equal(p.manifest.sandbox, true, "磁盘上的第三方插件强制沙箱");
  assert.match(p.html, /hi/);
});

test("未声明的卡槽被拒，并在 errors 里说清原因", () => {
  const root = newRoot();
  writePlugin(root, "badslot", { ...base, contributes: { slots: ["global.overlay"] } }, "<b>x</b>");
  const r = scanUiPlugins(root);
  assert.equal(r.plugins.length, 0);
  assert.ok(r.errors.some((e) => e.includes("global.overlay")));
});

test("L0 无卡槽声明：静默跳过，不读 entry", () => {
  const root = newRoot();
  writePlugin(
    root,
    "theme",
    { ...base, id: "lynn.theme.x", tier: "L0", entry: "./theme.json", contributes: { theme: "theme.json" } },
    undefined,
  );
  const r = scanUiPlugins(root);
  assert.equal(r.plugins.length, 0, "纯主题 L0 不进 UI 列表");
  assert.equal(r.errors.length, 0, "非 U 档静默跳过");
});

test("L0 占内置视图卡槽：进列表，但不带 iframe 文档、只传 view 名", () => {
  const root = newRoot();
  writePlugin(
    root,
    "console",
    {
      ...base,
      id: "lynn.view.console",
      tier: "L0",
      source: "official",
      entry: undefined,
      contributes: { slots: ["stage.console"], view: "console" },
    },
    undefined,
  );
  const r = scanUiPlugins(root);
  assert.equal(r.errors.length, 0, r.errors.join("；"));
  assert.equal(r.plugins.length, 1);
  assert.equal(r.plugins[0].manifest.view, "console");
  assert.equal(r.plugins[0].manifest.sandbox, false, "L0 是声明式，组件在宿主注册表里");
  assert.equal(r.plugins[0].html, undefined, "L0 不下发任何可执行文档");
});

test("L0 声明需要自己渲染的卡槽 → 拒（无组件代码，得升 U 档）", () => {
  const root = newRoot();
  writePlugin(root, "l0bar", { ...base, id: "lynn.demo.l0bar", tier: "L0", contributes: { slots: ["status.bar"] } }, undefined);
  const r = scanUiPlugins(root);
  assert.equal(r.plugins.length, 0);
  assert.ok(r.errors.some((e) => e.includes("L0 无组件代码")), r.errors.join("；"));
});

test("L1 / L2 不进 UI 列表（归各自加载器）", () => {
  const root = newRoot();
  writePlugin(
    root,
    "l1",
    { ...base, id: "lynn.demo.l1", tier: "L1", entry: "./index.ts", permissions: { fs: [] }, contributes: { slots: ["status.bar"] } },
    undefined,
  );
  const r = scanUiPlugins(root);
  assert.equal(r.plugins.length, 0);
});

test("entry 必须是 .html，且不能跳出插件目录", () => {
  const root = newRoot();
  writePlugin(root, "nohtml", { ...base, entry: "./index.js" }, "<b>x</b>");
  writePlugin(root, "escape", { ...base, id: "lynn.demo.escape", entry: "../secret.html" }, "<b>x</b>");
  const r = scanUiPlugins(root);
  assert.equal(r.plugins.length, 0);
  assert.ok(r.errors.some((e) => e.includes(".html")));
  assert.ok(r.errors.some((e) => e.includes("跳出")));
});

test("entry 文件不存在时给出明确错误", () => {
  const root = newRoot();
  writePlugin(root, "missing", { ...base, id: "lynn.demo.missing" }, undefined);
  const r = scanUiPlugins(root);
  assert.ok(r.errors.some((e) => e.includes("不存在")));
});

test("损坏的 plugin.json 只影响自己，不炸整体扫描", () => {
  const root = newRoot();
  const d = path.join(root, "plugins", "broken");
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "plugin.json"), "{ not json");
  writePlugin(root, "ok", { ...base, id: "lynn.demo.ok" }, "<b>ok</b>");
  const r = scanUiPlugins(root);
  assert.equal(r.plugins.length, 1);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /JSON/);
});
