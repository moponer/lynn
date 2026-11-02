import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { L1Host, l1ToolFullName } from "../dist/main/plugin-l1.js";
import { PluginHost } from "../dist/main/plugin-host.js";
import { checkManifest } from "../dist/main/plugin-manifest.js";

// ---------- 测试脚手架：临时插件目录 + 真 jiti 加载 ----------

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "lynn-l1-"));
}

function writePlugin(root, dirName, manifest, entryCode) {
  const dir = path.join(root, "plugins", dirName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "plugin.json"), JSON.stringify(manifest), "utf-8");
  if (entryCode !== undefined) fs.writeFileSync(path.join(dir, "index.ts"), entryCode, "utf-8");
  return dir;
}

const diceManifest = (id = "lynn.tool.dice", entry = "./index.ts") => ({
  id,
  name: "骰子",
  version: "1.0.0",
  apiVersion: 1,
  tier: "L1",
  engines: { kernel: "^0.0.1" },
  entry,
  contributes: { tools: ["roll"] },
  permissions: { proc: false },
  source: "official",
});

const diceEntry = `export default function activate(api) {
  api.registerTool({
    name: "roll",
    description: "掷骰子",
    parameters: { type: "object", properties: { sides: { type: "number" } } },
    execute: async (args) => "掷出 " + (Number(args.sides) || 6),
  });
  globalThis.__diceActivated = (globalThis.__diceActivated || 0) + 1;
}
export function deactivate() { globalThis.__diceDeactivated = (globalThis.__diceDeactivated || 0) + 1; }
`;

function makeHost(root) {
  return new L1Host({
    listEntries: () => [],
    manifestOf: (id) => {
      const dir = path.join(root, "plugins");
      if (!fs.existsSync(dir)) return null;
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!e.isDirectory()) continue;
        const f = path.join(dir, e.name, "plugin.json");
        if (!fs.existsSync(f)) continue;
        const m = JSON.parse(fs.readFileSync(f, "utf-8"));
        if (m.id === id) return { dir: path.join(dir, e.name), manifest: m };
      }
      return null;
    },
    kernelVersion: "0.0.1",
  });
}

// ---------- 命名空间 ----------

test("l1ToolFullName：id 下划线化 + 短名（OpenAI 函数名不含点号）", () => {
  assert.equal(l1ToolFullName("lynn.tool.dice", "roll"), "lynn_tool_dice_roll");
  assert.match(l1ToolFullName("lynn.a.b", "x"), /^[A-Za-z0-9_-]+$/);
});

// ---------- activate：真 jiti 加载 TS，工具面就位 ----------

test("activate：jiti 直跑 TS 入口，工具以命名空间全名注册并可执行", async () => {
  const root = tmpRoot();
  writePlugin(root, "dice", diceManifest(), diceEntry);
  const l1 = makeHost(root);
  const r = await l1.activate("lynn.tool.dice");
  assert.equal(r.ok, true);
  assert.ok(r.detail.includes("lynn_tool_dice_roll") || r.detail.includes("1 个工具"));
  const schemas = l1.toolSchemas();
  assert.equal(schemas.length, 1);
  assert.equal(schemas[0].function.name, "lynn_tool_dice_roll");
  assert.equal(schemas[0].function.parameters.type, "object");
  assert.ok(await l1.execute("lynn_tool_dice_roll", { sides: 20 }).then((s) => s.includes("掷出 20")));
});

test("activate：工具未在 manifest 声明 → 拒绝（先声明再注册）", async () => {
  const root = tmpRoot();
  writePlugin(root, "bad", diceManifest(), `export default function activate(api) {
    api.registerTool({ name: "undeclared", description: "x", parameters: { type: "object", properties: {} }, execute: async () => "y" });
  }`);
  const l1 = makeHost(root);
  await assert.rejects(() => l1.activate("lynn.tool.dice"), /未在 manifest contributes.tools 声明/);
  assert.equal(l1.activeIds().length, 0);
});

test("activate：同一插件重复注册同名工具 → 明确报错且回滚，不静默覆盖", async () => {
  const root = tmpRoot();
  writePlugin(root, "dup", diceManifest("lynn.tool.dup"), `export default function activate(api) {
    const def = { name: "roll", description: "x", parameters: { type: "object", properties: {} }, execute: async () => "y" };
    api.registerTool(def);
    api.registerTool(def); // 第二次：同名冲突
  }`);
  const l1 = makeHost(root);
  await assert.rejects(() => l1.activate("lynn.tool.dup"), /工具名冲突/);
  // 冲突方回滚：部分注册不残留
  assert.deepEqual(l1.activeIds(), []);
  assert.equal(l1.toolSchemas().length, 0);
});

// ---------- 停用即时、无残留（§4.2.1 不变式 1） ----------

test("deactivate：工具立即消失，残留调用被执行层明确拒绝", async () => {
  const root = tmpRoot();
  writePlugin(root, "dice", diceManifest(), diceEntry);
  const l1 = makeHost(root);
  await l1.activate("lynn.tool.dice");
  assert.ok(l1.has("lynn_tool_dice_roll"));
  assert.equal(l1.deactivate("lynn.tool.dice"), true);
  assert.equal(l1.has("lynn_tool_dice_roll"), false);
  assert.equal(l1.toolSchemas().length, 0);
  assert.ok((await l1.execute("lynn_tool_dice_roll", {})).includes("未激活"));
});

// ---------- /reload 排队语义（§4.2.3：Agent 运行中禁止 reload → settled 后生效） ----------

test("requestReload：运行中排队，settled 后重载生效（模块真重求值）", async () => {
  globalThis.__diceActivated = 0; // 进程内共享计数，先归零
  const root = tmpRoot();
  const dir = writePlugin(root, "dice", diceManifest(), diceEntry);
  const l1 = makeHost(root);
  await l1.activate("lynn.tool.dice");
  assert.equal(globalThis.__diceActivated, 1);

  l1.setBusy(true); // 她开始干活
  const v1 = await l1.requestReload("lynn.tool.dice");
  assert.ok(v1.includes("排队"), "运行中必须排队而不是立刻重载");
  assert.deepEqual(l1.queuedReloads(), ["lynn.tool.dice"]);
  assert.deepEqual(l1.activeIds(), ["lynn.tool.dice"]); // 运行中工具面不动

  // 排队期间改代码：返回值从 6 变成 42
  fs.writeFileSync(dir + "/index.ts", diceEntry.replace('Number(args.sides) || 6', 'Number(args.sides) || 42'), "utf-8");
  assert.ok((await l1.execute("lynn_tool_dice_roll", {})).includes("掷出 6")); // 仍是旧代码

  l1.setBusy(false); // agent_settled
  await new Promise((r) => setImmediate(r));
  assert.equal(l1.queuedReloads().length, 0);
  assert.ok((await l1.execute("lynn_tool_dice_roll", {})).includes("掷出 42"), "settled 后重载生效");
  assert.equal(globalThis.__diceActivated, 2); // 模块重新求值过
});

test("requestReload：空闲时立即重载", async () => {
  const root = tmpRoot();
  writePlugin(root, "dice", diceManifest(), diceEntry);
  const l1 = makeHost(root);
  const msg = await l1.requestReload("lynn.tool.dice");
  assert.ok(msg.includes("已启用"));
  assert.deepEqual(l1.activeIds(), ["lynn.tool.dice"]);
});

// ---------- PluginHost 集成：第三方默认关、试装真跑且不留残留 ----------

function l1PluginOnDisk(root, source) {
  writePlugin(root, "dice", diceManifest(), diceEntry);
  const f = path.join(root, "plugins", "dice", "plugin.json");
  const m = JSON.parse(fs.readFileSync(f, "utf-8"));
  if (source) m.source = source;
  else delete m.source;
  fs.writeFileSync(f, JSON.stringify(m), "utf-8");
}

test("scan：第三方 L1 默认关闭，官方默认开启，loadable=true", () => {
  const root = tmpRoot();
  l1PluginOnDisk(root, null); // 第三方（无 source 字段）
  const host = new PluginHost(root);
  const scan = host.scan();
  assert.equal(scan.plugins[0].enabled, false);
  assert.equal(scan.plugins[0].loadable, true);
  // 用户显式启用
  host.setEnabled("lynn.tool.dice", true);
  assert.equal(host.scan().plugins[0].enabled, true);

  // 官方默认开
  const root2 = tmpRoot();
  l1PluginOnDisk(root2, "official");
  const scan2 = new PluginHost(root2).scan();
  assert.equal(scan2.plugins[0].enabled, true);
});

test("probe：L1 试装=真激活→拿工具面→立即反注册（无残留）", async () => {
  const root = tmpRoot();
  l1PluginOnDisk(root, "official");
  const host = new PluginHost(root);
  const l1 = makeHost(root);
  host.attachL1(l1);
  const r = await host.probe("lynn.tool.dice");
  assert.equal(r.ok, true);
  assert.ok(r.detail.includes("lynn_tool_dice_roll") || r.detail.includes("1 个工具"));
  assert.deepEqual(l1.activeIds(), [], "试装后进程内不留残留");
});

test("scan：entry 跳出插件目录被拒", () => {
  const root = tmpRoot();
  writePlugin(root, "evil", diceManifest("lynn.tool.evil", "../evil.ts"), diceEntry);
  const scan = new PluginHost(root).scan();
  assert.equal(scan.plugins.length, 0);
  assert.ok(scan.errors.some((e) => e.includes("entry")));
});
