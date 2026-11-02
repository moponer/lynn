import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PluginSetStore } from "../dist/main/plugin-set.js";

/** 插件集指纹 / 快照回滚 / 安全模式（§4.11.4）。 */

function newRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-set-"));
  fs.mkdirSync(path.join(root, "plugins"), { recursive: true });
  return root;
}

function writePlugin(root, dir, body, theme) {
  const d = path.join(root, "plugins", dir);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(
    path.join(d, "plugin.json"),
    JSON.stringify({
      id: `lynn.theme.${dir}`,
      name: dir,
      version: "1.0.0",
      apiVersion: 1,
      tier: "L0",
      engines: { kernel: "^1.4.0" },
      contributes: { theme: "./theme.json" },
      ...body,
    }),
  );
  if (theme) fs.writeFileSync(path.join(d, "theme.json"), JSON.stringify(theme));
}

test("指纹：同样内容稳定，改一次内容就变", () => {
  const root = newRoot();
  writePlugin(root, "a", {}, { dark: { "--blue": "#111111" } });
  const s = new PluginSetStore(root);
  const f1 = s.fingerprint().fingerprint;
  assert.equal(s.fingerprint().fingerprint, f1, "同样内容应稳定");
  assert.equal(s.fingerprint().entries.length, 1);

  writePlugin(root, "a", {}, { dark: { "--blue": "#222222" } });
  assert.notEqual(s.fingerprint().fingerprint, f1, "内容变了指纹必须变");
});

test("禁用的插件不计入指纹", () => {
  const root = newRoot();
  writePlugin(root, "a", {}, { dark: { "--blue": "#111111" } });
  writePlugin(root, "b", {}, { dark: { "--blue": "#333333" } });
  const s = new PluginSetStore(root);
  const both = s.fingerprint();
  assert.equal(both.entries.length, 2);

  fs.writeFileSync(path.join(root, "plugins", "_state.json"), JSON.stringify({ "lynn.theme.b": false }));
  const only = s.fingerprint();
  assert.equal(only.entries.length, 1);
  assert.notEqual(only.fingerprint, both.fingerprint);
  assert.equal(only.entries[0].id, "lynn.theme.a");
});

test("快照与一键回滚：恢复启用状态，不动别的文件", () => {
  const root = newRoot();
  writePlugin(root, "a", {}, { dark: { "--blue": "#111111" } });
  const s = new PluginSetStore(root);

  const before = s.snapshot("install");
  assert.ok(fs.existsSync(path.join(root, "plugins", "_snapshots", before)));

  // 装第二个并停用第一个
  writePlugin(root, "b", {}, { dark: { "--blue": "#333333" } });
  fs.writeFileSync(path.join(root, "plugins", "_state.json"), JSON.stringify({ "lynn.theme.a": false }));

  const r = s.rollback();
  assert.equal(r.ok, true);
  const state = JSON.parse(fs.readFileSync(path.join(root, "plugins", "_state.json"), "utf-8"));
  assert.equal(state["lynn.theme.a"], true, "回滚后 a 应恢复启用");
  assert.match(r.detail, /用户数据未动/);
});

test("安全模式：10 分钟内 3 次启动才触发；清掉后恢复", () => {
  const root = newRoot();
  const s = new PluginSetStore(root);
  const t0 = Date.now();

  assert.equal(s.noteStart(t0).safeMode, false);
  assert.equal(s.noteStart(t0 + 1000).safeMode, false);
  const third = s.noteStart(t0 + 2000);
  assert.equal(third.safeMode, true);
  assert.equal(s.isSafeMode(), true);
  assert.match(s.safeModeInfo()?.reason ?? "", /3 次/);

  s.setSafeMode(false);
  assert.equal(s.isSafeMode(), false);
});

test("安全模式过期窗口不计入：11 分钟前的启动不算连续崩溃", () => {
  const root = newRoot();
  const s = new PluginSetStore(root);
  const t0 = Date.now();
  s.noteStart(t0);
  s.noteStart(t0 + 1000);
  // 11 分钟后再启动：前面的都过期了
  const r = s.noteStart(t0 + 11 * 60 * 1000);
  assert.equal(r.safeMode, false);
  assert.equal(r.starts, 1);
});
