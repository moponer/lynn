/**
 * L1 权限强制执行（P10-1）。
 *
 * 背景：`agent/l1-worker.mjs` 的头注长期写着「fs/net 权限强制仍属声明……这里不谎报已沙箱」。
 * 2026-11-17 首次实测确认：4 项只挡住 1 项。这是 L1 自启用一直不能放开的原因。
 *
 * 2026-11-18 接入 Node 26 的权限模型（`--permission`）后，本组测试锁住三件事：
 *  1. **真的挡住了**（不是配了参数就算）：越界读、子进程、越界写都失败；
 *  2. **该放行的放行**：dataDir 必须可写，否则 `api.dataDir` 是个谎言；
 *  3. **网络挡不住这件事必须如实标注**：`enforced.net === false`，
 *     且 `isSelfInstallSafe()` 因此返回 false —— 谁要是为了"方便"改成 true，这条会红。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");

const jiti = createJiti(import.meta.url);
const { planSandbox, isSelfInstallSafe } = await jiti.import("../src/main/l1-sandbox.ts", { default: true });
const { L1Host } = await import("../dist/main/plugin-l1.js");

const tmp = (p = "lynn-perm-") => fs.mkdtempSync(path.join(os.tmpdir(), p));

const BASE = {
  workerEntry: path.join(repo, "agent", "l1-worker.mjs"),
  kernelModules: path.join(repo, "node_modules"),
};

test("planSandbox：默认不给子进程、不给通配读", () => {
  const dataDir = tmp();
  const plan = planSandbox({ fs: [], net: [], proc: false }, {
    ...BASE,
    pluginDir: tmp(),
    dataDir,
  });
  assert.ok(plan.args.includes("--permission"), "必须开权限模型");
  assert.ok(!plan.args.includes("--allow-child-process"), "不许给子进程权限");
  assert.ok(!plan.args.some((a) => a === "--allow-fs-read=*"), "默认不给通配读");
  assert.equal(plan.enforced.proc, true);
  assert.equal(plan.enforced.fsWrite, true);
});

test("planSandbox：dataDir 必须可写（否则 api.dataDir 是谎言）", () => {
  const dataDir = tmp();
  const plan = planSandbox({ fs: [], net: [], proc: false }, { ...BASE, pluginDir: tmp(), dataDir });
  assert.ok(
    plan.args.some((a) => a.startsWith("--allow-fs-write=") && a.includes(path.basename(dataDir))),
    `dataDir 必须出现在写白名单里：${plan.args.join(" ")}`,
  );
});

test("planSandbox：node_modules 必须可读（否则插件连加载都做不到）", () => {
  const plan = planSandbox({ fs: [], net: [], proc: false }, { ...BASE, pluginDir: tmp(), dataDir: tmp() });
  assert.ok(
    plan.args.some((a) => a.includes("node_modules")),
    "缺 node_modules 读权限会让 activate 失败在 Access to this API has been restricted",
  );
});

test("planSandbox：manifest 声明的 fs 白名单会进参数", () => {
  const extra = tmp();
  const plan = planSandbox({ fs: [extra], net: [], proc: false }, { ...BASE, pluginDir: tmp(), dataDir: tmp() });
  assert.ok(plan.args.some((a) => a.includes(path.basename(extra))), `声明的 fs 白名单没进参数：${plan.args.join(" ")}`);
});

test("planSandbox：fs 通配声明会转成 --allow-fs-read=*", () => {
  const plan = planSandbox({ fs: ["*"], net: [], proc: false }, { ...BASE, pluginDir: tmp(), dataDir: tmp() });
  assert.ok(plan.args.includes("--allow-fs-read=*"), "通配声明应当转成 *");
});

/**
 * 这两条断言在 P10-2 之后**反过来了**，值得说清为什么。
 *
 * P10-1 时：Node 权限模型不拦网络 → `enforced.net = false` → 自启用不安全。
 * P10-2 时：注入了网络守卫（拦原型层 + dgram + dns），实测 TCP/UDP/DNS 全挡住
 *          → `enforced.net = true` → 自启用的网络前提满足。
 *
 * 但**测试不能只看 `enforced.net` 这个布尔值**——那是自己给自己打分。
 * 真正的验证在 `tests/l1-net-guard.test.mjs`：真跑插件，TCP/UDP/DNS 都被拦。
 * 这里保留的是"标记与说明要一致"这一层。
 */
test("planSandbox：网络标记为已强制，且说明里讲清是谁做的", () => {
  const plan = planSandbox({ fs: [], net: ["example.com"], proc: false }, { ...BASE, pluginDir: tmp(), dataDir: tmp() });
  assert.equal(plan.enforced.net, true, "P10-2 之后网络由守卫强制");
  assert.match(plan.note, /网络/, `说明里要提到网络：${plan.note}`);
});

test("isSelfInstallSafe：网络已强制后返回 true（真实验证在 l1-net-guard 测试里）", () => {
  const plan = planSandbox({ fs: [], net: [], proc: false }, { ...BASE, pluginDir: tmp(), dataDir: tmp() });
  const v = isSelfInstallSafe(plan);
  assert.equal(v.ok, true, `网络已强制，不该再返回 false：${v.reason}`);
  assert.equal(v.reason, "");
});

test("isSelfInstallSafe：任一强制项缺失就返回 false（不是只看网络）", () => {
  const base = planSandbox({ fs: [], net: [], proc: false }, { ...BASE, pluginDir: tmp(), dataDir: tmp() });
  for (const missing of ["fsRead", "proc", "net"]) {
    const broken = { ...base, enforced: { ...base.enforced, [missing]: false } };
    const v = isSelfInstallSafe(broken);
    assert.equal(v.ok, false, `${missing} 缺失时必须判为不安全`);
    assert.ok(v.reason.length > 0, "必须给出理由");
  }
});

/** 真跑一个插件，验证权限**真的**生效（不是只生成了参数） */
async function runProbe(source) {
  const root = tmp();
  const pluginDir = path.join(root, "plugins", "probe");
  const dataDir = path.join(pluginDir, "state");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(pluginDir, "index.ts"), source, "utf8");
  const manifest = {
    id: "lynn.test.perm",
    name: "perm",
    version: "1.0.0",
    apiVersion: 1,
    tier: "L1",
    engines: { kernel: ">=0.0.1" },
    entry: "index.ts",
    permissions: { fs: [], net: [], proc: false },
    contributes: { tools: ["probe"] },
  };
  const host = new L1Host({
    listEntries: () => [{ id: manifest.id, dir: pluginDir, manifest, enabled: true }],
    manifestOf: (id) => (id === manifest.id ? { dir: pluginDir, manifest } : null),
    kernelVersion: "0.0.1",
    workerEntry: BASE.workerEntry,
    kernelModules: BASE.kernelModules,
    toolTimeoutMs: 20_000,
  });
  try {
    const loaded = await host.activate(manifest.id);
    if (!loaded.ok) return { ok: false, detail: loaded.detail };
    const out = await host.execute("lynn_test_perm_probe", {});
    return { ok: true, result: JSON.parse(out) };
  } finally {
    try {
      await host.deactivate(manifest.id);
    } catch {
      /* 忽略 */
    }
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
}

const PROBE = `
export default function activate(api) {
  const probe = (fn) => { try { return { ok: true, v: fn() }; } catch (e) { return { ok: false, code: String(e && e.code || e).slice(0, 80) }; } };
  const fs = require("node:fs");
  api.registerTool({
    name: "probe",
    description: "探测",
    parameters: { type: "object", properties: {} },
    execute: () => JSON.stringify({
      readOutside: probe(() => fs.statSync((process.env.HOME || "") + "/.lynn/settings.json").size),
      spawn: probe(() => require("node:child_process").execSync("node -v", { encoding: "utf-8", timeout: 3000 })),
      writeOutside: probe(() => { fs.writeFileSync((process.env.HOME || "") + "/.lynn/probe-x.txt", "x"); return "written"; }),
      writeDataDir: probe(() => { fs.writeFileSync(api.dataDir + "/ok.txt", "ok"); return "written"; }),
    }),
  });
  return { ok: true };
}
`;

test("真跑：越界读被挡住（不是只配了参数）", async () => {
  const r = await runProbe(PROBE);
  assert.equal(r.ok, true, `插件没跑起来：${r.detail}`);
  assert.equal(r.result.readOutside.ok, false, "凭据文件居然能读——权限没生效");
  assert.match(r.result.readOutside.code, /ACCESS_DENIED|restricted/, `错误码不对：${r.result.readOutside.code}`);
});

test("真跑：子进程被挡住", async () => {
  const r = await runProbe(PROBE);
  assert.equal(r.result.spawn.ok, false, "子进程居然起来了——权限没生效");
});

test("真跑：越界写被挡住", async () => {
  const r = await runProbe(PROBE);
  assert.equal(r.result.writeOutside.ok, false, "居然能写到 ~/.lynn——权限没生效");
});

test("真跑：dataDir 可写（该放行的必须放行）", async () => {
  const r = await runProbe(PROBE);
  assert.equal(r.result.writeDataDir.ok, true, `dataDir 被误挡了：${r.result.writeDataDir.code}——api.dataDir 会变成谎言`);
});

test("真跑：正常工具照常可用（权限不能把插件废掉）", async () => {
  const r = await runProbe(`
export default function activate(api) {
  api.registerTool({
    name: "probe",
    description: "纯计算，不碰 IO",
    parameters: { type: "object", properties: {} },
    execute: () => JSON.stringify({ sum: 1 + 1 }),
  });
  return { ok: true };
}
`);
  assert.equal(r.ok, true, `纯计算插件都跑不起来：${r.detail}`);
  assert.equal(r.result.sum, 2);
});