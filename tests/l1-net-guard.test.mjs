/**
 * L1 网络强制（P10-2）。
 *
 * 这是 L1 自启用最后一道门。Node 的 `--permission` **不拦网络**（实测 `http` 照常可用），
 * 所以必须自己注入守卫。
 *
 * ## 实测踩到的三个坑（都写进测试了）
 *
 * 1. **模块表面 patch 无效**：patch `http.request` 挡不住 `import http`（ESM 拿到另一份引用）。
 *    必须 patch **原型**（`net.Socket.prototype.connect`）——CJS 与 ESM 共享同一个类。
 * 2. **只 patch 原型会漏 TCP**：`http.Agent` 走的是 `net.connect` / `net.createConnection`，
 *    不是直接调原型方法。三个入口都要 patch。
 * 3. **回环地址被刻意放行**：用 `127.0.0.1` 测"外发是否被拦"测不出来——那是放行分支。
 *
 * ## 三条独立通道
 *
 * | 通道 | 走 net.Socket 吗 | 怎么封 |
 * |---|---|---|
 * | TCP / TLS / HTTP / fetch | ✅ | patch 原型 + net.connect + createConnection |
 * | UDP（dgram） | ❌ | patch dgram.createSocket |
 * | DNS（c-ares，C++） | ❌ | patch dns.lookup / resolve* |
 *
 * DNS 最容易被忽略：它是真实外泄通道（DNS 隧道能把数据编码进查询名）。
 * 只封 TCP 就说"断网"，是假的安全感。
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
const { netPolicyOf, hostAllowed, netGuardSource, netEnforcedBy } = await jiti.import("../src/main/l1-net-guard.ts", {
  default: true,
});
const { L1Host } = await import("../dist/main/plugin-l1.js");

const tmp = (p = "lynn-net-") => fs.mkdtempSync(path.join(os.tmpdir(), p));

test("netPolicyOf：没声明 net 就是完全断网", () => {
  assert.equal(netPolicyOf(undefined).denyAll, true);
  assert.equal(netPolicyOf([]).denyAll, true);
  assert.equal(netPolicyOf(["example.com"]).denyAll, false);
});

test("hostAllowed：精确匹配与 *.通配", () => {
  const p = netPolicyOf(["api.example.com", "*.trusted.dev"]);
  assert.equal(hostAllowed("api.example.com", p), true);
  assert.equal(hostAllowed("API.EXAMPLE.COM", p), true, "大小写不敏感");
  assert.equal(hostAllowed("a.trusted.dev", p), true, "通配子域");
  assert.equal(hostAllowed("evil.com", p), false);
  assert.equal(hostAllowed("example.com", p), false, "通配不该匹配裸域");
});

test("netPolicyOf：空白的 net 项被忽略（不产生'空字符串规则'）", () => {
  assert.equal(netPolicyOf(["  ", ""]).denyAll, true);
});

test("netEnforcedBy：如实说明覆盖范围（不吹成绝对断网）", () => {
  const v = netEnforcedBy(netPolicyOf([]));
  assert.equal(v.ok, true);
  assert.match(v.note, /刻意逃逸|不在覆盖范围/, `必须说清覆盖边界：${v.note}`);
});

test("netGuardSource：包含三条通道的封堵（TCP/UDP/DNS）", () => {
  const src = netGuardSource(netPolicyOf([]));
  assert.match(src, /Socket\.prototype\.connect/, "要 patch 原型（模块表面挡不住 ESM）");
  assert.match(src, /__net\.connect/, "要 patch net.connect（http.Agent 走这条）");
  assert.match(src, /createConnection/, "要 patch createConnection");
  assert.match(src, /dgram/, "要封 UDP");
  assert.match(src, /dns/, "要封 DNS");
  assert.match(src, /ERR_NET_BLOCKED/, "错误码要能被识别");
});

/** 真跑一个插件，验证网络守卫生效 */
async function runWithNet(netPerms, probeBody) {
  const root = tmp();
  const pluginDir = path.join(root, "plugins", "probe");
  const dataDir = path.join(pluginDir, "state");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, "index.ts"),
    `export default function activate(api) {
  api.registerTool({
    name: "probe",
    description: "探测网络",
    parameters: { type: "object", properties: {} },
    execute: () => JSON.stringify((() => {
      const out = {};
      const t = (k, fn) => { try { fn(); out[k] = "未拦"; } catch (e) { out[k] = "拦住:" + (e.code || e.message).slice(0, 40); } };
      ${probeBody}
      return out;
    })()),
  });
  return { ok: true };
}
`,
    "utf8",
  );
  const manifest = {
    id: "lynn.test.net",
    name: "net",
    version: "1.0.0",
    apiVersion: 1,
    tier: "L1",
    engines: { kernel: ">=0.0.1" },
    entry: "index.ts",
    permissions: { fs: [], net: netPerms, proc: false },
    contributes: { tools: ["probe"] },
  };
  fs.writeFileSync(path.join(pluginDir, "plugin.json"), JSON.stringify(manifest), "utf8");
  const host = new L1Host({
    listEntries: () => [{ id: manifest.id, dir: pluginDir, manifest, enabled: true }],
    manifestOf: () => ({ dir: pluginDir, manifest }),
    kernelVersion: "0.0.1",
    workerEntry: path.join(repo, "agent", "l1-worker.mjs"),
    kernelModules: path.join(repo, "node_modules"),
    toolTimeoutMs: 20_000,
  });
  try {
    const loaded = await host.activate(manifest.id);
    assert.equal(loaded.ok, true, `插件没起来：${loaded.detail}`);
    return JSON.parse(await host.execute("lynn_test_net_probe", {}));
  } finally {
    try {
      await host.deactivate(manifest.id);
    } catch {
      /* 忽略 */
    }
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
}

const PROBE_ALL = `
      t("tcp", () => { const h = require("node:http"); const r = h.request({ host: "example.com", port: 80, timeout: 300 }); r.on("error", () => {}); r.end(); r.destroy(); });
      t("udp", () => { require("node:dgram").createSocket("udp4").close(); });
      t("dns", () => { require("node:dns").lookup("example.com", () => {}); });
`;

test("真跑：没声明 net 时，TCP/UDP/DNS 全被挡住", async () => {
  const r = await runWithNet([], PROBE_ALL);
  assert.match(r.tcp, /拦住/, `TCP 没挡住：${r.tcp}`);
  assert.match(r.udp, /拦住/, `UDP 没挡住：${r.udp}`);
  assert.match(r.dns, /拦住/, `DNS 没挡住：${r.dns}`);
});

test("真跑：白名单内的域名放行，白名单外的拦住", async () => {
  /**
   * 这里要区分两件事，否则断言会假阳性：
   *  - **守卫拦住**（白名单外）：同步抛 ERR_NET_BLOCKED；
   *  - **守卫放行但后续失败**（白名单内）：不抛，或抛的是 DNS/网络错误。
   *
   * 所以用 `net.connect`（不涉及 DNS 解析）来测白名单，而不是 http.request——
   * 后者会先撞上 DNS 守卫，测不出白名单本身。
   */
  const r = await runWithNet(["example.com"], `
      t("allowed", () => { const n = require("node:net"); const s = n.connect({ host: "example.com", port: 80 }); s.on("error", () => {}); });
      t("denied", () => { const n = require("node:net"); const s = n.connect({ host: "evil.example.net", port: 80 }); s.on("error", () => {}); });
  `);
  assert.match(r.allowed, /未拦/, `白名单内应放行（DNS 由内核代理，见下一条）：${r.allowed}`);
  assert.match(r.denied, /拦住/, `白名单外应拦住：${r.denied}`);
});

/**
 * DNS 的规则与 TCP **一致**：白名单域名可解析，其余一律拒。
 *
 * 这里纠正过一个设计错误：最初写的是"DNS 一律禁"，结果白名单形同虚设——
 * `net.connect({host:"example.com"})` 内部要解析域名，DNS 一禁就连不上，
 * 于是"允许的域名"也连不出去。实测踩到了，所以改成按白名单放行。
 */
test("真跑：白名单域名的 DNS 可解析（否则白名单形同虚设）", async () => {
  const r = await runWithNet(["example.com"], `
      t("dns", () => { require("node:dns").lookup("example.com", () => {}); });
  `);
  assert.match(r.dns, /未拦/, `白名单域名的 DNS 应当放行（否则 TCP 连不上）：${r.dns}`);
});

test("真跑：非白名单域名的 DNS 仍被拒（DNS 隧道外泄的主要通道）", async () => {
  const r = await runWithNet(["example.com"], `
      t("dns", () => { require("node:dns").lookup("evil.attacker.com", () => {}); });
  `);
  assert.match(r.dns, /拦住/, `非白名单域名不该能解析：${r.dns}`);
});

test("真跑：resolveTxt 等常用于隧道的解析接口一律禁", async () => {
  const r = await runWithNet(["example.com"], `
      t("txt", () => { require("node:dns").resolveTxt("example.com", () => {}); });
  `);
  assert.match(r.txt, /拦住/, `resolveTxt 应禁（DNS 隧道常用）：${r.txt}`);
});

test("真跑：回环地址放行（本机 IPC 不该被当外发）", async () => {
  const r = await runWithNet([], `
      t("loopback", () => { const n = require("node:net"); const s = n.connect({ host: "127.0.0.1", port: 9 }); s.on("error", () => {}); });
  `);
  assert.match(r.loopback, /未拦/, `回环应当放行：${r.loopback}`);
});

test("真跑：纯计算插件不受网络守卫影响", async () => {
  const r = await runWithNet([], `
      t("pure", () => { if (1 + 1 !== 2) throw new Error("math broke"); });
  `);
  assert.match(r.pure, /未拦/, "守卫不能误伤纯计算");
});