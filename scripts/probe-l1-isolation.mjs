#!/usr/bin/env node
/**
 * L1 隔离边界探测（P10-1 / 24 章第 3 节）。
 *
 * 这个脚本回答一个问题：**放开 L1 自启用之前，隔离进程到底挡住了什么？**
 *
 * 它必须实测，不能读注释：`agent/l1-worker.mjs` 的头注曾写着
 * 「fs/net 权限强制仍属声明……这里不谎报已沙箱」。2026-11-17 首次实测确认：
 * 4 项只挡住 1 项（凭据能读、子进程能起、HTTP 能发）——这就是当时不能放开自启用的原因。
 *
 * 2026-11-18 加入 Node 权限模型（`--permission`）后重测，本脚本给出**当前**结论。
 *
 * 用法：node scripts/probe-l1-isolation.mjs [--json]
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");

const { L1Host } = require("../dist/main/plugin-l1.js");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-l1probe-"));
const pluginDir = path.join(root, "plugins", "probe");
const dataDir = path.join(pluginDir, "state");
fs.mkdirSync(dataDir, { recursive: true });

/**
 * 探测插件。
 *
 * 关键写法：**每项探测都在自己的 try 里**，且用 `await import()` 而不是顶层 `require`。
 * 原因：Node 权限模型在 `require("node:fs")` 这一层就可能抛
 * `Access to this API has been restricted`——如果顶层 require，整个 activate 就挂了，
 * 那样探测脚本只能报"加载失败"，看不出**具体哪一项**被挡。
 */
const PROBE_SOURCE = `
export default async function activate(api) {
  const probes = {};
  const tryIt = async (name, fn) => {
    try {
      probes[name] = { ok: true, value: await fn() };
    } catch (e) {
      probes[name] = { ok: false, error: String((e && (e.code || e.message)) || e).slice(0, 140) };
    }
  };

  // 1) 读凭据文件（这是最要命的一项：能读就等于能偷 Key）
  await tryIt("readCredentials", async () => {
    const fs = await import("node:fs");
    const p = process.env.HOME || process.env.USERPROFILE || "";
    const target = p + "/.lynn/settings.json";
    return fs.statSync(target).size;
  });

  // 2) 起子进程（能起就能绕过一切）
  await tryIt("spawn", async () => {
    const cp = await import("node:child_process");
    return cp.execSync("node -v", { encoding: "utf-8", timeout: 3000 }).trim();
  });

  // 3) 直接用 http 模块（P10-2 网络守卫：应当挡住）
  /**
   * 必须用**外部域名**而不是 127.0.0.1：
   * 守卫刻意放行回环地址（IPC / 本机服务不该被当外发），
   * 拿 127.0.0.1 测等于测"放行逻辑"，测不出"外发是否被拦"。
   */
  await tryIt("http", async () => {
    const http = await import("node:http");
    const req = http.request({ host: "example.com", port: 80, timeout: 300 });
    req.on("error", () => {});
    req.end();
    req.destroy();
    return "http 请求发出去了";
  });

  // 3b) UDP（独立通道，不走 net.Socket）
  await tryIt("udp", async () => {
    const dgram = await import("node:dgram");
    const sock = dgram.createSocket("udp4");
    sock.close();
    return "UDP socket 建起来了";
  });

  // 3c) DNS（c-ares，C++ 实现；DNS 隧道是真实外泄通道）
  await tryIt("dns", async () => {
    const dns = await import("node:dns");
    dns.lookup("example.com", () => {});
    return "DNS 查询发出去了";
  });

  // 4) 写自己安装目录之外的地方（预期挡住）
  await tryIt("writeOutside", async () => {
    const fs = await import("node:fs");
    const p = process.env.HOME || process.env.USERPROFILE || "";
    fs.writeFileSync(p + "/.lynn/probe-should-fail.txt", "x");
    return "写成功了";
  });

  // 5) 写自己的 dataDir（预期允许：不给它，api.dataDir 就是谎言）
  await tryIt("writeDataDir", async () => {
    const fs = await import("node:fs");
    fs.writeFileSync(api.dataDir + "/probe-ok.txt", "ok");
    return "写成功";
  });

  // 6) 环境变量里有没有密钥（内核侧 cmd-env 已剔除）
  const keys = Object.keys(process.env).filter((k) => /KEY|TOKEN|SECRET|PASSWORD/i.test(k));
  probes.envKeys = { ok: true, value: { count: keys.length, sample: keys.slice(0, 3) } };

  api.registerTool({
    name: "probe_report",
    description: "返回隔离边界探测结果",
    parameters: { type: "object", properties: {} },
    execute: () => JSON.stringify(probes),
  });
  return { ok: true };
}
`;
fs.writeFileSync(path.join(pluginDir, "index.ts"), PROBE_SOURCE, "utf8");
fs.writeFileSync(
  path.join(pluginDir, "plugin.json"),
  JSON.stringify(
    {
      id: "lynn.probe.isolation",
      name: "probe",
      version: "1.0.0",
      apiVersion: 1,
      tier: "L1",
      engines: { kernel: ">=0.0.1" },
      entry: "index.ts",
      permissions: { fs: [], net: [], proc: false },
      contributes: { tools: ["probe_report"] },
    },
    null,
    2,
  ),
  "utf8",
);

const manifest = JSON.parse(fs.readFileSync(path.join(pluginDir, "plugin.json"), "utf8"));
const workerEntry = path.join(repo, "agent", "l1-worker.mjs");
const host = new L1Host({
  listEntries: () => [{ id: manifest.id, dir: pluginDir, manifest, enabled: true }],
  manifestOf: (id) => (id === manifest.id ? { dir: pluginDir, manifest } : null),
  kernelVersion: "0.0.1",
  workerEntry: fs.existsSync(workerEntry) ? workerEntry : undefined,
  kernelModules: path.join(repo, "node_modules"),
  toolTimeoutMs: 15_000,
});

const asJson = process.argv.includes("--json");
const say = (...a) => {
  if (!asJson) console.log(...a);
};

say("隔离模式:", fs.existsSync(workerEntry) ? "独立进程（l1-worker.mjs）+ Node 权限模型" : "进程内（无 worker）");

let exitCode = 0;
try {
  const loaded = await host.activate("lynn.probe.isolation");
  if (!loaded.ok) {
    console.error("探测插件加载失败:", loaded.detail);
    process.exit(1);
  }
  const out = await host.execute("lynn_probe_isolation_probe_report", {});
  const probes = JSON.parse(out);

  /**
   * 期望矩阵：哪些项"应该被挡住"。
   * 这张表就是判断"能不能放开自启用"的依据，所以写死在这里而不是靠人记。
   */
  const EXPECT = [
    { key: "readCredentials", label: "读凭据文件 ~/.lynn/settings.json", shouldBlock: true },
    { key: "spawn", label: "起子进程", shouldBlock: true },
    { key: "http", label: "直接用 http 模块（TCP）", shouldBlock: true },
    { key: "udp", label: "UDP（dgram）", shouldBlock: true },
    { key: "dns", label: "DNS 解析（c-ares）", shouldBlock: true },
    { key: "writeOutside", label: "写安装目录之外", shouldBlock: true },
    { key: "writeDataDir", label: "写自己的 dataDir（应当允许）", shouldBlock: false, shouldAllow: true },
  ];

  const rows = EXPECT.map((e) => {
    const p = probes[e.key] ?? { ok: false, error: "没有探测结果" };
    const blocked = !p.ok;
    let verdict;
    if (e.shouldAllow) verdict = blocked ? "✖ 误挡（dataDir 必须可写）" : "✅ 允许";
    else if (e.shouldBlock) verdict = blocked ? "✅ 挡住" : "✖ 未挡住";
    else verdict = blocked ? "· 挡住了（超出预期）" : "· 未挡住（已知限制）";
    return { ...e, blocked, verdict, detail: p.ok ? String(p.value ?? "") : p.error };
  });

  if (asJson) {
    console.log(JSON.stringify({ rows, envKeys: probes.envKeys?.value, mode: fs.existsSync(workerEntry) ? "worker+permission" : "inproc" }, null, 2));
  } else {
    console.log("\n=== 隔离边界实测 ===");
    for (const r of rows) console.log(`  ${r.verdict}  ${r.label}${r.detail ? `（${r.detail}）` : ""}`);
    console.log(`  环境变量里的密钥: ${probes.envKeys?.value?.count ?? 0} 个`);
  }

  // 只有"应该挡却没挡"才算失败；已知限制（网络）不算
  const failures = rows.filter((r) => (r.shouldBlock && !r.blocked) || (r.shouldAllow && r.blocked));
  const netBlocked = ["http", "udp", "dns"].every((k) => rows.find((r) => r.key === k)?.blocked === true);

  if (!asJson) {
    console.log("");
    if (failures.length) {
      exitCode = 1;
      console.log(`✖ ${failures.length} 项不符合预期：${failures.map((f) => f.label).join("、")}`);
    } else {
      console.log("✅ 所有应当挡住的都挡住了，dataDir 可写。");
    }
    if (!netBlocked) {
      console.log("· 网络仍挡不住（Node 权限模型不支持）→ **L1 自启用继续关闭**，理由见 24 章 3.1");
    } else {
      console.log("· 网络也被挡住了 → 可以考虑放开 L1 自启用（仍需审计 + 一键撤销）");
    }
  } else if (failures.length) {
    exitCode = 1;
  }
} finally {
  try {
    await host.dispose?.();
  } catch {
    /* 忽略 */
  }
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
}
process.exit(exitCode);
