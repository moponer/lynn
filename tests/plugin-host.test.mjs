import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PluginHost, checkThemeFile } from "../dist/main/plugin-host.js";

/** L0 声明式加载器（§4.2.1 / §4.2.2）：主题插件是纯数据，坏插件不炸整体。 */

function newRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-plug-"));
  fs.mkdirSync(path.join(root, "plugins"), { recursive: true });
  return root;
}

function writeTheme(root, dir, theme, extra = {}) {
  const d = path.join(root, "plugins", dir);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(
    path.join(d, "plugin.json"),
    JSON.stringify(
      {
        id: `lynn.theme.${dir}`,
        name: dir,
        version: "1.0.0",
        apiVersion: 1,
        tier: "L0",
        engines: { kernel: "^1.4.0" },
        contributes: { theme: "./theme.json" },
        ...extra,
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(path.join(d, "theme.json"), JSON.stringify(theme, null, 2));
}

test("合法的 L0 主题插件被列出，Token 可读", () => {
  const root = newRoot();
  writeTheme(root, "dusk", { name: "暮色", dark: { "--blue": "#6fb3d1" }, light: { "--blue": "#2f6f8a" } });
  const { plugins, errors } = new PluginHost(root).scan();
  assert.equal(errors.length, 0, errors.join("；"));
  assert.equal(plugins.length, 1);
  assert.equal(plugins[0].tier, "L0");
  assert.equal(plugins[0].loadable, true);
  assert.equal(plugins[0].theme.dark["--blue"], "#6fb3d1");
});

test("主题里出现非白名单 Token 或非颜色值都拒收", () => {
  const root = newRoot();
  writeTheme(root, "bad", { dark: { "--accent": "#fff" } });
  writeTheme(root, "bad2", { dark: { "--blue": "url(x)" } });
  const { plugins, errors } = new PluginHost(root).scan();
  assert.equal(plugins.length, 0);
  assert.ok(errors.some((e) => e.includes("--accent")));
  assert.ok(errors.some((e) => e.includes("必须是颜色值")));
});

test("缺 theme.json / 坏 JSON 只影响自己", () => {
  const root = newRoot();
  writeTheme(root, "ok", { dark: { "--seal": "#c8443a" } });
  const d = path.join(root, "plugins", "broken");
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "plugin.json"), "{ nope");
  const { plugins, errors } = new PluginHost(root).scan();
  assert.equal(plugins.length, 1);
  assert.equal(plugins[0].id, "lynn.theme.ok");
  assert.ok(errors.some((e) => e.includes("JSON")));
});

test("L1 插件可加载；第三方默认关闭（高信任档不静默放开）", () => {
  const root = newRoot();
  const d = path.join(root, "plugins", "l1");
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(
    path.join(d, "plugin.json"),
    JSON.stringify({
      id: "lynn.tool.x",
      name: "X",
      version: "1.0.0",
      apiVersion: 1,
      tier: "L1",
      engines: { kernel: "^1.4.0" },
      entry: "./index.ts",
      permissions: { fs: ["$HOME/.lynn/**"] },
    }),
  );
  fs.writeFileSync(path.join(d, "index.ts"), "export default () => {};\n");
  const { plugins } = new PluginHost(root).scan();
  assert.equal(plugins.length, 1);
  assert.equal(plugins[0].tier, "L1");
  assert.equal(plugins[0].loadable, true);
  assert.equal(plugins[0].enabled, false, "第三方 L1 默认关闭");
});

test("启停状态落盘：新实例读回同一状态", () => {
  const root = newRoot();
  writeTheme(root, "dusk", { dark: { "--blue": "#6fb3d1" } });
  const host = new PluginHost(root);
  assert.equal(host.scan().plugins[0].enabled, true);
  host.setEnabled("lynn.theme.dusk", false);
  assert.equal(new PluginHost(root).scan().plugins[0].enabled, false);
});

test("checkThemeFile 直接校验：至少一组 Token，键必须在白名单", () => {
  assert.equal(checkThemeFile({ dark: { "--blue": "#fff" } }).ok, true);
  assert.equal(checkThemeFile({}).ok, false);
  assert.equal(checkThemeFile({ light: { "--nope": "#fff" } }).ok, false);
});

test("L2 试装：按 recipe 起真 MCP server 做握手，再杀干净", async () => {
  const root = newRoot();
  const mcp = path.resolve(import.meta.dirname, "fixtures/mcp-echo.mjs");
  const d = path.join(root, "plugins", "l2");
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(
    path.join(d, "plugin.json"),
    JSON.stringify({
      id: "lynn.mcp.echo",
      name: "Echo MCP",
      version: "1.0.0",
      apiVersion: 1,
      tier: "L2",
      engines: { kernel: "^1.4.0" },
      mcp: { recipe: "./recipe.json" },
    }),
  );
  fs.writeFileSync(
    path.join(d, "recipe.json"),
    JSON.stringify({ command: process.execPath, args: [mcp] }),
  );

  const host = new PluginHost(root);
  const r = await host.probe("lynn.mcp.echo");
  assert.equal(r.ok, true, r.detail);
  assert.match(r.detail, /握手成功/);
  assert.match(r.detail, /2 个工具/);
});

test("L0 直接通过试装；L1 试装=真激活→反注册（未装配运行时时如实告知）", async () => {
  const root = newRoot();
  writeTheme(root, "dusk", { dark: { "--blue": "#6fb3d1" } });
  const host = new PluginHost(root);
  assert.equal((await host.probe("lynn.theme.dusk")).ok, true);
  assert.match((await host.probe("lynn.theme.dusk")).detail, /纯声明/);

  const d = path.join(root, "plugins", "l1");
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(
    path.join(d, "plugin.json"),
    JSON.stringify({
      id: "lynn.tool.x",
      name: "X",
      version: "1.0.0",
      apiVersion: 1,
      tier: "L1",
      engines: { kernel: "^1.4.0" },
      entry: "./index.ts",
      permissions: { fs: ["$HOME/.lynn/**"] },
    }),
  );
  fs.writeFileSync(
    path.join(d, "index.ts"),
    `export default function activate(api) {
      api.registerTool({ name: "ping", description: "p", parameters: { type: "object", properties: {} }, execute: async () => "pong" });
    }
`,
  );
  // 运行时未装配：如实告知，不假装
  const miss = await host.probe("lynn.tool.x");
  assert.equal(miss.ok, false);
  assert.match(miss.detail, /运行时未就绪/);
  // 装配后：真试装，拿到工具面，且不留在进程里
  const { L1Host } = await import("../dist/main/plugin-l1.js");
  const l1 = new L1Host({ listEntries: () => host.listL1Entries(), manifestOf: (id) => host.manifestOf(id), kernelVersion: "0.0.1" });
  host.attachL1(l1);
  const r = await host.probe("lynn.tool.x");
  assert.equal(r.ok, true, r.detail);
  assert.match(r.detail, /lynn_tool_x_ping/);
  assert.deepEqual(l1.activeIds(), []);
});
