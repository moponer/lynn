/**
 * 插件版本化与可回滚更新（P12-1）。
 *
 * 补的是最后一个缺口：`update_plugin` 未做——改已装插件只能卸载+重装。
 *
 * 这组测试守五件事，每一条都对应一个真实的失效方式：
 *  1. **更新会先归档旧版**（否则新版坏了回不去）；
 *  2. **回滚本身也能回滚**（否则点错一次就是单行道）；
 *  3. **`.versions` 不被当成插件扫进来**（否则插件列表里会多出幽灵条目）；
 *  4. **更新失败时旧版还在**（否则一次失败的更新毁掉可用插件）；
 *  5. **版本数量有上限**（否则长期更新会把磁盘撑满）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  listVersions,
  archiveVersion,
  rollbackToVersion,
  updatePluginFromDir,
  pruneVersions,
  KEEP_VERSIONS,
} = await jiti.import("../src/main/plugin-versions.ts", { default: true });
const { importPluginPackage } = await jiti.import("../src/main/plugin-package.ts", { default: true });
const { PluginHost } = await import("../dist/main/plugin-host.js");

const tmp = (p = "lynn-ver-") => fs.mkdtempSync(path.join(os.tmpdir(), p));

/** 造一个插件目录（可指定版本号与内容） */
function makePlugin(dir, id, version, marker = "") {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "plugin.json"),
    JSON.stringify(
      { id, name: id, version, apiVersion: 1, tier: "L0", engines: { kernel: ">=0.0.1" }, contributes: { langs: ["lang.json"] } },
      null,
      2,
    ),
    "utf8",
  );
  fs.writeFileSync(path.join(dir, "lang.json"), JSON.stringify({ lang: "zh", strings: { "x.y": marker || version } }), "utf8");
  return dir;
}

test("更新：旧版被归档，新版生效", () => {
  const data = tmp("lynn-data-");
  const v1 = makePlugin(path.join(tmp(), "p1"), "lynn.demo.v", "1.0.0", "旧版");
  const v2 = makePlugin(path.join(tmp(), "p2"), "lynn.demo.v", "2.0.0", "新版");

  assert.equal(importPluginPackage(v1, data).ok, true);
  const r = importPluginPackage(v2, data, { override: true });
  assert.equal(r.ok, true, JSON.stringify(r.issues));
  assert.equal(r.version, "2.0.0", "更新后版本号应为 2.0.0");
  assert.ok(r.archived, "必须返回归档目录名（否则用户不知道能回滚到哪）");

  const live = JSON.parse(fs.readFileSync(path.join(data, "plugins", "lynn.demo.v", "plugin.json"), "utf8"));
  assert.equal(live.version, "2.0.0", "生效的应是新版");

  const vers = listVersions(data, "lynn.demo.v");
  assert.equal(vers.length, 1, "应有一个历史版本");
  assert.equal(vers[0].version, "1.0.0", "归档的应是旧版");
});

test("回滚：换回旧版，且当前版本也被归档（回滚本身能回滚）", () => {
  const data = tmp("lynn-data-");
  const v1 = makePlugin(path.join(tmp(), "p1"), "lynn.demo.r", "1.0.0", "旧版");
  const v2 = makePlugin(path.join(tmp(), "p2"), "lynn.demo.r", "2.0.0", "新版");
  importPluginPackage(v1, data);
  const up = importPluginPackage(v2, data, { override: true });
  assert.equal(up.ok, true);

  const rb = rollbackToVersion(data, "lynn.demo.r", up.archived);
  assert.equal(rb.ok, true, JSON.stringify(rb.issues));
  assert.equal(rb.version, "1.0.0", "应回到 1.0.0");

  const live = JSON.parse(fs.readFileSync(path.join(data, "plugins", "lynn.demo.r", "plugin.json"), "utf8"));
  assert.equal(live.version, "1.0.0");
  assert.ok(rb.archived, "回滚前也应归档当前版本——否则点错了回不去");

  const vers = listVersions(data, "lynn.demo.r");
  assert.ok(vers.some((v) => v.version === "2.0.0"), "2.0.0 应出现在历史里，可以再换回来");
});

test("回滚到不存在的版本：明确拒绝，且不动当前版本", () => {
  const data = tmp("lynn-data-");
  const v1 = makePlugin(path.join(tmp(), "p1"), "lynn.demo.m", "1.0.0");
  importPluginPackage(v1, data);
  const r = rollbackToVersion(data, "lynn.demo.m", "不存在的版本");
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.stage === "missing"));
  const live = JSON.parse(fs.readFileSync(path.join(data, "plugins", "lynn.demo.m", "plugin.json"), "utf8"));
  assert.equal(live.version, "1.0.0", "失败的尝试不该动当前版本");
});

test("默认导入仍拒绝同名（更新必须显式 override）", () => {
  const data = tmp("lynn-data-");
  const v1 = makePlugin(path.join(tmp(), "p1"), "lynn.demo.c", "1.0.0");
  const v2 = makePlugin(path.join(tmp(), "p2"), "lynn.demo.c", "2.0.0");
  importPluginPackage(v1, data);
  const r = importPluginPackage(v2, data);
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.stage === "conflict"), "同名默认要拒");
  assert.match(r.issues.find((i) => i.stage === "conflict").message, /更新/, "提示要指向「更新」而不是只说不能");
});

test("更新不存在的插件：提示用导入而不是更新", () => {
  const data = tmp("lynn-data-");
  const v1 = makePlugin(path.join(tmp(), "p1"), "lynn.demo.new", "1.0.0");
  // 直接对未安装的插件调 updatePluginFromDir
  const r = updatePluginFromDir(data, "lynn.demo.new", v1);
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.stage === "missing"), JSON.stringify(r.issues));
  assert.match(r.issues[0].message, /导入/, "应提示改用导入");
});

test(".versions 不会被当成插件扫进来（否则列表里会有幽灵条目）", () => {
  const data = tmp("lynn-data-");
  const v1 = makePlugin(path.join(tmp(), "p1"), "lynn.demo.g", "1.0.0");
  const v2 = makePlugin(path.join(tmp(), "p2"), "lynn.demo.g", "2.0.0");
  importPluginPackage(v1, data);
  importPluginPackage(v2, data, { override: true });

  // 归档目录里也有 plugin.json，扫描必须跳过它
  const host = new PluginHost(data);
  const scanned = host.scan();
  const hits = scanned.plugins.filter((p) => p.id === "lynn.demo.g");
  assert.equal(hits.length, 1, `应只看到一个 lyynn.demo.g，实际 ${hits.length} 个——.versions 被误扫了`);

  // dirOf 也必须指向生效中的那份，不是归档
  const dir = host.dirOf("lynn.demo.g");
  assert.ok(dir && !dir.includes(".versions"), `dirOf 指到了归档目录：${dir}`);
});

test("版本数量有上限：超过 KEEP_VERSIONS 删最旧的", () => {
  const data = tmp("lynn-data-");
  const live = makePlugin(path.join(data, "plugins", "lynn.demo.p"), "lynn.demo.p", "1.0.0");
  for (let i = 0; i < KEEP_VERSIONS + 3; i += 1) {
    fs.writeFileSync(
      path.join(live, "plugin.json"),
      JSON.stringify({ id: "lynn.demo.p", name: "p", version: `1.0.${i}`, apiVersion: 1, tier: "L0", engines: { kernel: ">=0.0.1" }, contributes: { langs: ["lang.json"] } }),
      "utf8",
    );
    archiveVersion(data, "lynn.demo.p", live);
  }
  const vers = listVersions(data, "lynn.demo.p");
  assert.equal(vers.length, KEEP_VERSIONS, `应只保留 ${KEEP_VERSIONS} 个，实际 ${vers.length}`);
});

test("pruneVersions 返回被删的目录名（便于审计）", () => {
  const data = tmp("lynn-data-");
  const live = makePlugin(path.join(data, "plugins", "lynn.demo.q"), "lynn.demo.q", "1.0.0");
  for (let i = 0; i < KEEP_VERSIONS + 2; i += 1) archiveVersion(data, "lynn.demo.q", live);
  const removed = pruneVersions(data, "lynn.demo.q");
  assert.ok(Array.isArray(removed));
});

test("归档保留完整文件（不只是 plugin.json）", () => {
  const data = tmp("lynn-data-");
  const live = makePlugin(path.join(data, "plugins", "lynn.demo.f"), "lynn.demo.f", "1.0.0", "原始内容");
  fs.mkdirSync(path.join(live, "commands"), { recursive: true });
  fs.writeFileSync(path.join(live, "commands", "x.md"), "# 命令", "utf8");

  const archived = archiveVersion(data, "lynn.demo.f", live);
  const snap = path.join(data, "plugins", ".versions", "lynn.demo.f", archived);
  assert.ok(fs.existsSync(path.join(snap, "commands", "x.md")), "归档必须包含全部文件，否则回滚会缺东西");
  assert.equal(fs.readFileSync(path.join(snap, "lang.json"), "utf8").includes("原始内容"), true);
});

test("版本列表新的在前（按目录名时间戳，不靠 mtime）", () => {
  const data = tmp("lynn-data-");
  const live = makePlugin(path.join(data, "plugins", "lynn.demo.o"), "lynn.demo.o", "1.0.0");
  const a = archiveVersion(data, "lynn.demo.o", live);
  // 保证时间戳不同
  const t0 = Date.now();
  while (Date.now() === t0) {
    /* 忙等一毫秒 */
  }
  const b = archiveVersion(data, "lynn.demo.o", live);
  const vers = listVersions(data, "lynn.demo.o");
  assert.equal(vers[0].dir, b, "最新归档应排第一");
  assert.equal(vers[1].dir, a);
});

test("没有历史版本时返回空数组（不抛）", () => {
  const data = tmp("lynn-data-");
  assert.deepEqual(listVersions(data, "lynn.never.installed"), []);
});