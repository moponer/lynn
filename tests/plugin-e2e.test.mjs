/**
 * 插件包端到端（P9-4）。
 *
 * 前面几组测的是零件：`readPackage` 校验、`importPluginPackage` 导入、`L1Host` 激活。
 * 这一组测**整条链**，而且刻意用**真实的 zip**（不是目录）：
 *
 *   打 zip → 导入 → 扫描能看到 → 启用 → L1 激活 → 调到工具
 *
 * 为什么值得单独一组：目录导入和 zip 导入走的是**不同分支**（后者多一步解包）。
 * 只测目录，等于没测用户实际会用的那条路——用户拿到的是 `.zip`。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");

const jiti = createJiti(import.meta.url);
const { importPluginPackage } = await jiti.import("../src/main/plugin-package.ts", { default: true });
const { PluginHost } = await import("../dist/main/plugin-host.js");
const { L1Host } = await import("../dist/main/plugin-l1.js");

const tmp = (p = "lynn-e2e-") => fs.mkdtempSync(path.join(os.tmpdir(), p));

/** 把一个目录打成 zip（deflate，与真实打包一致） */
function zipDir(dir) {
  const entries = [];
  const walk = (cur, prefix) => {
    for (const e of fs.readdirSync(cur, { withFileTypes: true })) {
      const full = path.join(cur, e.name);
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) walk(full, rel);
      else entries.push({ name: rel, data: fs.readFileSync(full) });
    }
  };
  walk(dir, "");

  const chunks = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const comp = zlib.deflateRawSync(data);
    const crc = zlib.crc32 ? zlib.crc32(data) : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt32LE(crc >>> 0, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    chunks.push(local, nameBuf, comp);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(8, 10);
    cen.writeUInt32LE(crc >>> 0, 16);
    cen.writeUInt32LE(comp.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);
    offset += local.length + nameBuf.length + comp.length;
  }
  const cenBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cenBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cenBuf, end]);
}

test("e2e：模板打成 zip → 导入 → 扫描可见 → L1 激活 → 调到工具", async () => {
  const tpl = path.join(repo, "plugins", "_templates", "tool-l1");
  const manifest = JSON.parse(fs.readFileSync(path.join(tpl, "plugin.json"), "utf8"));

  // 1) 打 zip
  const zipPath = path.join(tmp(), "tool.zip");
  fs.writeFileSync(zipPath, zipDir(tpl));
  assert.ok(fs.statSync(zipPath).size > 100, "zip 打出来是空的");

  // 2) 导入
  const data = tmp("lynn-e2e-data-");
  const r = importPluginPackage(zipPath, data);
  assert.equal(r.ok, true, `导入失败：${JSON.stringify(r.issues)}`);
  assert.equal(r.id, manifest.id);

  // 3) 扫描能看到（这是界面与 list_plugins 的数据源）
  const host = new PluginHost(data);
  const scanned = host.scan();
  const found = scanned.plugins.find((p) => p.id === manifest.id);
  assert.ok(found, `扫描看不到 ${manifest.id}：${scanned.errors.join("；")}`);
  assert.equal(found.tier, "L1");
  assert.equal(found.loadable, true, "L1 应当可加载");

  // 4) L1 激活并调工具
  const dir = path.join(data, "plugins", manifest.id);
  const l1 = new L1Host({
    listEntries: () => [{ id: manifest.id, dir, manifest, enabled: true }],
    manifestOf: (id) => (id === manifest.id ? { dir, manifest } : null),
    kernelVersion: "0.0.1",
    workerEntry: path.join(repo, "agent", "l1-worker.mjs"),
      // P10-1：权限模型下 worker 要读 node_modules 才能加载 jiti
      kernelModules: path.join(repo, "node_modules"),
    toolTimeoutMs: 20_000,
  });
  try {
    const loaded = await l1.activate(manifest.id);
    assert.equal(loaded.ok, true, `激活失败：${loaded.detail}`);
    const prefix = manifest.id.replace(/[^a-z0-9]+/gi, "_");
    const out = await l1.execute(`${prefix}_word_count`, { text: "abc 中文测试" });
    const parsed = JSON.parse(out);
    assert.equal(parsed.cjk, 4, "中文字数不对");
    assert.equal(parsed.words, 1, "英文词数不对");
  } finally {
    try {
      await l1.deactivate(manifest.id);
    } catch {
      /* 忽略 */
    }
  }
});

test("e2e：UI 模板导入后能被 ui-plugins 扫到（占卡槽）", async () => {
  const tpl = path.join(repo, "plugins", "_templates", "ui-u");
  const manifest = JSON.parse(fs.readFileSync(path.join(tpl, "plugin.json"), "utf8"));
  const data = tmp("lynn-e2e-ui-");
  const r = importPluginPackage(tpl, data);
  assert.equal(r.ok, true, JSON.stringify(r.issues));

  const { scanUiPlugins } = await import("../dist/main/ui-plugins.js");
  const scanned = scanUiPlugins(data);
  const found = scanned.plugins.find((p) => p.manifest.id === manifest.id);
  assert.ok(found, `UI 扫描看不到：${scanned.errors.join("；")}`);
  assert.deepEqual(found.manifest.slots, ["status.bar"]);
  assert.ok(found.html && found.html.length > 100, "ui.html 没被读出来");
});

test("e2e：坏包在导入阶段就被拦住，不会留下半装状态", () => {
  const bad = tmp("lynn-e2e-bad-");
  fs.writeFileSync(path.join(bad, "plugin.json"), JSON.stringify({ id: "bad", name: "x" }), "utf8");
  const data = tmp("lynn-e2e-baddata-");
  const r = importPluginPackage(bad, data);
  assert.equal(r.ok, false);
  assert.ok(r.issues.length >= 2, "应当一次列出多个问题（id 格式、version 缺失、tier 缺失…）");
  const plugins = path.join(data, "plugins");
  assert.deepEqual(fs.existsSync(plugins) ? fs.readdirSync(plugins) : [], [], "plugins/ 里不该留东西");
});