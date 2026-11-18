/**
 * 插件包导入（P9-2）。
 *
 * 用户的三个要求在这里验收：
 *  1. **手动安装标准插件文件包** —— zip / 目录都能装；
 *  2. **错误必须直接拦截显示** —— 每种失败都要给**具体到字段**的原因，不是"导入失败"；
 *  3. **不能搞崩本体** —— 恶意包（zip slip）、坏清单、缺入口，一律在写盘前拦住。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { importPluginPackage, readPackage, unzipToDir, locatePluginRoot } = await jiti.import("../src/main/plugin-package.ts", {
  default: true,
});

const tmp = (p = "lynn-pkg-") => fs.mkdtempSync(path.join(os.tmpdir(), p));

/** 造一个插件目录 */
function makePluginDir(root, id, over = {}) {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  const manifest = {
    id,
    name: over.name ?? id,
    version: "1.0.0",
    apiVersion: 1,
    tier: over.tier ?? "L0",
    engines: { kernel: ">=0.0.1" },
    ...(over.entry ? { entry: over.entry } : {}),
    contributes: over.contributes ?? { langs: ["lang.json"] },
  };
  fs.writeFileSync(path.join(dir, "plugin.json"), JSON.stringify(manifest, null, 2), "utf8");
  fs.writeFileSync(path.join(dir, "lang.json"), JSON.stringify({ lang: "zh", strings: { "x.y": "好" } }), "utf8");
  if (over.entry) fs.writeFileSync(path.join(dir, over.entry), "export default function activate() { return {}; }\n", "utf8");
  return dir;
}

/** 打一个最小 zip（stored，够测试用） */
function makeZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
    const nameBuf = Buffer.from(name, "utf8");
    const crc = (() => {
      let c = ~0;
      for (const b of data) {
        c ^= b;
        for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
      }
      return ~c >>> 0;
    })();
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    chunks.push(local, nameBuf, data);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0, 8);
    cen.writeUInt16LE(0, 10);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(data.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);
    offset += local.length + nameBuf.length + data.length;
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

test("从目录导入：装进 plugins/<id>/", () => {
  const src = tmp();
  const data = tmp("lynn-data-");
  const dir = makePluginDir(src, "lynn.demo.dir");
  const r = importPluginPackage(dir, data);
  assert.equal(r.ok, true, JSON.stringify(r.issues));
  assert.equal(r.id, "lynn.demo.dir");
  assert.ok(fs.existsSync(path.join(data, "plugins", "lynn.demo.dir", "plugin.json")));
});

test("从 zip 导入：解包后装进 plugins/", () => {
  const src = tmp();
  const data = tmp("lynn-data-");
  const dir = makePluginDir(src, "lynn.demo.zip");
  const zip = makeZip([
    ["plugin.json", fs.readFileSync(path.join(dir, "plugin.json"))],
    ["lang.json", fs.readFileSync(path.join(dir, "lang.json"))],
  ]);
  const zipPath = path.join(src, "pack.zip");
  fs.writeFileSync(zipPath, zip);
  const r = importPluginPackage(zipPath, data);
  assert.equal(r.ok, true, JSON.stringify(r.issues));
  assert.ok(fs.existsSync(path.join(data, "plugins", "lynn.demo.zip", "plugin.json")));
});

test("zip slip 必须拦：包内 ../ 路径不能写出 plugins/", () => {
  const src = tmp();
  const data = tmp("lynn-data-");
  const zip = makeZip([
    ["plugin.json", JSON.stringify({ id: "lynn.evil", name: "evil", version: "1.0.0", apiVersion: 1, tier: "L0", engines: { kernel: ">=0.0.1" }, contributes: { langs: ["l.json"] } })],
    ["../../../逃出去.txt", "不该写到这里"],
  ]);
  const zipPath = path.join(src, "evil.zip");
  fs.writeFileSync(zipPath, zip);
  const r = importPluginPackage(zipPath, data);
  // 要么直接失败，要么至少把越界文件拦下
  const escaped = path.resolve(src, "../../../逃出去.txt");
  assert.equal(fs.existsSync(escaped), false, "越界文件被写出来了——zip slip 防护失效");
  assert.ok(r.issues.some((i) => /越界/.test(i.message)), "必须报告越界");
});

test("坏清单：给具体到字段的原因，不是笼统的「导入失败」", () => {
  const src = tmp();
  const data = tmp("lynn-data-");
  const dir = path.join(src, "bad");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "plugin.json"), JSON.stringify({ name: "缺 id" }), "utf8");
  const r = importPluginPackage(dir, data);
  assert.equal(r.ok, false);
  assert.ok(r.issues.length > 0);
  for (const i of r.issues) {
    assert.ok(i.stage && i.message, "每条 issue 都要有 stage 与 message");
    assert.ok(i.message.length > 4, `原因太短：${i.message}`);
  }
  assert.ok(r.issues.some((i) => /id/i.test(i.message)), `要指出是 id 的问题：${JSON.stringify(r.issues)}`);
});

test("没有 plugin.json：明确说是「不是插件包」", () => {
  const src = tmp();
  const data = tmp("lynn-data-");
  const dir = path.join(src, "empty");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "readme.txt"), "hi", "utf8");
  const r = importPluginPackage(dir, data);
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.stage === "layout" && /plugin\.json/.test(i.message)));
});

test("声明的入口文件不存在：拦下来并点名是哪个文件", () => {
  const src = tmp();
  const data = tmp("lynn-data-");
  const dir = path.join(src, "noentry");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "plugin.json"),
    JSON.stringify({
      id: "lynn.noentry",
      name: "x",
      version: "1.0.0",
      apiVersion: 1,
      tier: "L1",
      engines: { kernel: ">=0.0.1" },
      entry: "missing.ts",
      contributes: { tools: ["t"] },
      // L1 必须显式声明权限（manifest 校验要求）——这条本身就是好设计
      permissions: { fs: [], net: [], proc: false },
    }),
    "utf8",
  );
  const r = importPluginPackage(dir, data);
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.stage === "entry" && /missing\.ts/.test(i.message)), JSON.stringify(r.issues));
});

test("同名冲突：默认拒，且提示先卸载（保留可恢复路径）", () => {
  const src = tmp();
  const data = tmp("lynn-data-");
  const dir = makePluginDir(src, "lynn.dup");
  assert.equal(importPluginPackage(dir, data).ok, true);
  const again = importPluginPackage(dir, data);
  assert.equal(again.ok, false);
  // P12-1 之后提示指向「更新」（会先归档旧版），不再只让用户卸载重装\n  assert.ok(again.issues.some((i) => i.stage === "conflict" && /更新/.test(i.message)));
});

test("包内套一层目录也能找到（GitHub 下载的 zip 常这样）", () => {
  const src = tmp();
  const inner = tmp("lynn-inner-");
  makePluginDir(inner, "lynn.nested");
  // 把插件目录套进一层
  const wrapped = path.join(src, "wrapped");
  fs.mkdirSync(wrapped, { recursive: true });
  fs.cpSync(path.join(inner, "lynn.nested"), path.join(wrapped, "lynn.nested"), { recursive: true });
  const found = locatePluginRoot(wrapped);
  assert.ok(found, "套一层目录时应能找到 plugin.json");
  assert.ok(found.manifestFile.endsWith("plugin.json"));
});

test("导入失败时不在 plugins/ 里留垃圾", () => {
  const src = tmp();
  const data = tmp("lynn-data-");
  const dir = path.join(src, "bad2");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "plugin.json"), "{ 这不是 JSON", "utf8");
  const r = importPluginPackage(dir, data);
  assert.equal(r.ok, false);
  const pluginsRoot = path.join(data, "plugins");
  const leftovers = fs.existsSync(pluginsRoot) ? fs.readdirSync(pluginsRoot) : [];
  assert.deepEqual(leftovers, [], `plugins/ 里不该留东西，实际：${leftovers.join(",")}`);
});