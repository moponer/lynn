// 2026-11-13 审计 #3 修复回归：L1 插件隔离进程加载。
// workerEntry 配置后：真子进程加载 TS 插件、执行、超时强杀进程树、崩溃隔离。
// 未配置 workerEntry（plugin-l1.test.mjs）保持进程内旧行为——两条路径都要活着。
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { L1Host, L1_WORKER_CALL_TIMEOUT_MS } from "../dist/main/plugin-l1.js";

const WORKER_ENTRY = path.resolve(import.meta.dirname, "..", "agent", "l1-worker.mjs");
/** 项目根：P10-1 权限模型需要读 node_modules 才能加载 jiti */
const PROJECT_ROOT = path.resolve(import.meta.dirname, "..");

function tmpRoot(p = "lynn-l1w-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), p));
}

function writePlugin(root, dirName, manifest, entryCode) {
  const dir = path.join(root, "plugins", dirName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "plugin.json"), JSON.stringify(manifest), "utf-8");
  fs.writeFileSync(path.join(dir, "index.ts"), entryCode, "utf-8");
  return dir;
}

const diceManifest = (id, tools) => ({
  id,
  name: id,
  version: "1.0.0",
  apiVersion: 1,
  tier: "L1",
  engines: { kernel: "^0.0.1" },
  entry: "./index.ts",
  contributes: { tools },
  permissions: { proc: false },
  source: "official",
});

function makeWorkerHost(root, opts = {}) {
  return new L1Host({
    listEntries: () => [],
    manifestOf: (id) => {
      for (const e of fs.readdirSync(path.join(root, "plugins"), { withFileTypes: true })) {
        if (!e.isDirectory()) continue;
        const f = path.join(root, "plugins", e.name, "plugin.json");
        if (!fs.existsSync(f)) continue;
        const m = JSON.parse(fs.readFileSync(f, "utf-8"));
        if (m.id === id) return { dir: path.join(root, "plugins", e.name), manifest: m };
      }
      return null;
    },
    kernelVersion: "0.0.1",
    workerEntry: WORKER_ENTRY,
    /**
     * P10-1：权限强制执行后，worker 需要读 node_modules 才能加载 jiti 转译器。
     * 不传这一项，所有插件都会失败在 "Access to this API has been restricted"——
     * 那不是回归，是权限生效了但没给它"启动所必需"的读权限。
     */
    kernelModules: path.join(PROJECT_ROOT, "node_modules"),
    workerCallTimeoutMs: opts.callTimeoutMs ?? L1_WORKER_CALL_TIMEOUT_MS,
  });
}

test("隔离进程：activate 真起子进程，工具面与执行都经 worker（审计 #3）", async () => {
  const root = tmpRoot();
  writePlugin(
    root,
    "dice",
    diceManifest("lynn.tool.dice", ["roll"]),
    `export default function activate(api) {
      api.registerTool({
        name: "roll", description: "掷骰子",
        parameters: { type: "object", properties: { sides: { type: "number" } } },
        execute: async (args) => "掷出 " + (Number(args.sides) || 6),
      });
    }`,
  );
  const l1 = makeWorkerHost(root);
  const r = await l1.activate("lynn.tool.dice");
  assert.equal(r.ok, true, r.detail);
  assert.ok(r.detail.includes("隔离进程"), "激活详情要如实说明走了隔离进程");
  assert.equal(l1.toolSchemas().length, 1);
  assert.equal(l1.toolSchemas()[0].function.name, "lynn_tool_dice_roll");
  const out = await l1.execute("lynn_tool_dice_roll", { sides: 20 });
  assert.ok(out.includes("掷出 20"));
  // 连续两次都经 worker：状态不串、进程活着
  assert.ok((await l1.execute("lynn_tool_dice_roll", {})).includes("掷出 6"));
  l1.deactivate("lynn.tool.dice");
  assert.equal(l1.activeIds().length, 0);
});

test("隔离进程：激活失败的插件报明原因，不占内核（activateError）", async () => {
  const root = tmpRoot();
  writePlugin(
    root,
    "bad",
    diceManifest("lynn.tool.bad", ["boom"]),
    `export default function activate(api) {
      throw new Error("启动即炸（测试夹具）");
    }`,
  );
  const l1 = makeWorkerHost(root);
  const r = await l1.activate("lynn.tool.bad");
  assert.equal(r.ok, false);
  assert.match(r.detail, /启动即炸/);
  assert.equal(l1.activeIds().length, 0);
});

test("隔离进程：悬挂调用超时强杀进程树，插件卸载且指引重新启用（#3）", async () => {
  const root = tmpRoot("lynn-l1w-hang-");
  writePlugin(
    root,
    "hang",
    diceManifest("lynn.tool.hang", ["hang"]),
    `export default function activate(api) {
      api.registerTool({
        name: "hang", description: "永不返回",
        parameters: { type: "object", properties: {} },
        execute: async () => new Promise(() => {}),
      });
    }`,
  );
  const l1 = makeWorkerHost(root, { callTimeoutMs: 300 });
  await l1.activate("lynn.tool.hang");
  const t0 = Date.now();
  const out = await l1.execute("lynn_tool_hang_hang", {});
  assert.ok(Date.now() - t0 < 5000, "超时要按时返回");
  assert.match(out, /超时/);
  assert.match(out, /强制终止/);
  assert.match(out, /重新启用/, "进程已杀、插件已卸载：指引要如实");
  assert.equal(l1.activeIds().length, 0, "杀掉的插件不再留在运行表里");
});

test("隔离进程：插件 process.exit 不再带崩 host，调用方拿到退出原因", async () => {
  const root = tmpRoot("lynn-l1w-crash-");
  writePlugin(
    root,
    "crash",
    diceManifest("lynn.tool.crash", ["boom"]),
    `export default function activate(api) {
      api.registerTool({
        name: "boom", description: "炸进程",
        parameters: { type: "object", properties: {} },
        execute: async () => { process.exit(3); },
      });
    }`,
  );
  const l1 = makeWorkerHost(root);
  await l1.activate("lynn.tool.crash");
  const out = await l1.execute("lynn_tool_crash_boom", {});
  assert.match(out, /插件工具执行失败/);
  assert.match(out, /code 3|退出/, "退出原因要带出来");
  assert.ok(l1.activeIds().length === 0 || l1.activeIds().length === 1, "崩溃后插件被清理或留待停用");
});
