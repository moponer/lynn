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

test("只处理 U 档：L0 / L1 交给各自加载器", () => {
  const root = newRoot();
  writePlugin(root, "theme", { ...base, id: "lynn.theme.x", tier: "L0", entry: "./theme.json" }, undefined);
  assert.equal(scanUiPlugins(root).plugins.length, 0);
  assert.equal(scanUiPlugins(root).errors.length, 0, "非 U 档静默跳过");
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
