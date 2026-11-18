/**
 * 提示词资产：vendor 冻结 + 离线可编译（P2-2 / 06 章 §8）。
 *
 * 这组断言对应 06 章验收表里的四行，逐条落成可执行事实：
 *   完整性 —— 清单内文件全部存在、sha256 与 manifest 一致、没有清单外的文件
 *   离线   —— 全部角色能从本地文件编译出来，且两次编译逐字节相同（不依赖网络/时间/随机）
 *   可追溯 —— 每个 adapter 钉住的 sha 与它声明的 vendor 文件真实哈希一致
 *   合规   —— 每个 vendor 目录都有 LICENSE 与 UPSTREAM.json（来源/许可/引入时间/逐文件哈希）
 */
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compileRole, listAdapters, findUnmappedToolWords } from "../scripts/prompts/compile.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..");
const PROMPTS = path.join(ROOT, "prompts");
const VENDOR = path.join(PROMPTS, "vendor");

const sha256 = (buf) => `sha256:${crypto.createHash("sha256").update(buf).digest("hex")}`;
const readUpstream = (up) => JSON.parse(fs.readFileSync(path.join(VENDOR, up, "UPSTREAM.json"), "utf8"));

/** vendor 下的上游目录（sources.json 是来源表，不是上游） */
function upstreamDirs() {
  return fs
    .readdirSync(VENDOR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

function walk(dir, base = dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full, base));
    else out.push(path.relative(base, full).split(path.sep).join("/"));
  }
  return out.sort();
}

test("完整性：清单内文件都在，sha256 与清单一致", () => {
  const dirs = upstreamDirs();
  assert.deepEqual(dirs, ["codex", "superpowers", "zcode"], "上游目录应恰好是这三家");
  let checked = 0;
  for (const up of dirs) {
    const manifest = readUpstream(up);
    for (const [rel, want] of Object.entries(manifest.files)) {
      const full = path.join(VENDOR, up, rel);
      assert.ok(fs.existsSync(full), `${up}/${rel} 清单里有但磁盘上没有`);
      assert.equal(sha256(fs.readFileSync(full)), want, `${up}/${rel} 被手改过（vendor 只读，改动请进 adapters/）`);
      checked += 1;
    }
  }
  assert.ok(checked >= 27, `清单里应有全部 27 个文件，实际 ${checked}`);
});

test("完整性：磁盘上没有清单外的文件（防止有人往 vendor 里塞新东西）", () => {
  for (const up of upstreamDirs()) {
    const dir = path.join(VENDOR, up);
    const manifest = readUpstream(up);
    const onDisk = walk(dir).filter((rel) => rel !== "UPSTREAM.json");
    for (const rel of onDisk) {
      assert.ok(rel in manifest.files, `${up}/${rel} 在磁盘上但不在清单里`);
    }
  }
});

test("合规：每个上游都有 LICENSE 与完整的 UPSTREAM.json 元信息", () => {
  for (const up of upstreamDirs()) {
    const dir = path.join(VENDOR, up);
    assert.ok(fs.existsSync(path.join(dir, "LICENSE")), `${up} 缺 LICENSE 原件`);
    const manifest = readUpstream(up);
    assert.equal(manifest.upstream, up);
    assert.ok(manifest.sourcePath, `${up} 缺 sourcePath（日后无从回溯）`);
    assert.ok(["MIT", "Apache-2.0", "see LICENSE"].includes(manifest.license), `${up} license 字段异常：${manifest.license}`);
    assert.match(manifest.vendoredAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, `${up} vendoredAt 应是确定性时间戳`);
    assert.ok(manifest.note && manifest.note.length > 20, `${up} 缺「为什么这么引」的说明`);
  }
});

test("可追溯：每个 adapter 钉住的 sha 与 vendor 真实哈希一致", () => {
  const roles = listAdapters();
  assert.ok(roles.length >= 4, "至少应有 implementer / orchestrator / code-reviewer / visual-judge 四个 adapter");
  for (const role of roles) {
    const r = compileRole(role);
    assert.deepEqual(r.problems, [], `${role} 的溯源有问题：${r.problems.join("；")}`);
    assert.match(r.sha, /^[0-9a-f]{8}$/, `${role} 没解析到上游哈希`);
  }
});

test("离线：全部角色能编译，非空且在注入预算内", () => {
  const MEMBER_SYSTEM_BUDGET = 8000; // 成员 system ≤2.6K 是 P3 的目标；这里只防「肥到离谱」
  for (const role of listAdapters()) {
    const r = compileRole(role);
    assert.ok(r.chars > 500, `${role} 编译结果太短（${r.chars} 字符），多半是 vendor 没读到`);
    assert.ok(r.chars <= MEMBER_SYSTEM_BUDGET, `${role} 编译结果 ${r.chars} 字符，超注入预算`);
    assert.ok(r.text.includes("我们的差异"), `${role} 缺 adapter 的差异段`);
    assert.ok(r.text.includes("派生自"), `${role} 缺来源标注（06 章 §6 修改标注）`);
  }
});

test("离线：两次编译逐字节相同（不依赖网络/时间/随机）", () => {
  for (const role of listAdapters()) {
    const a = compileRole(role);
    const b = compileRole(role);
    assert.equal(a.text, b.text, `${role} 两次编译结果不同——说明混进了非确定性输入`);
  }
});

test("工具名映射不遗漏：编译结果里不许残留上游工具名", () => {
  for (const role of listAdapters()) {
    const r = compileRole(role);
    const left = findUnmappedToolWords(r.text);
    assert.deepEqual(
      left,
      [],
      `${role} 残留上游工具名 ${left.join(", ")}——成员会去调不存在的工具，请补 prompts/adapters/${role}.md 的 toolMap`,
    );
  }
});

test("身份锚点：上游品牌不得成为人设名（06 章 §6 商标要求）", () => {
  for (const role of listAdapters()) {
    const r = compileRole(role);
    for (const brand of ["Codex", "ZCode", "Superpowers"]) {
      // 允许出现在「派生自 …」这类溯源标注里，但不许出现在正文角色定义中
      const bodyOnly = r.text.split("----- 上游正文")[1] ?? "";
      if (bodyOnly.includes(brand)) {
        // 上游正文里自述品牌可接受（保留原文完整性）；但身份头必须是我们自己的
        assert.ok(!r.text.split("\n")[1].includes(brand), `${role} 身份头里出现了上游品牌 ${brand}`);
      }
    }
    assert.ok(r.text.startsWith("【角色】"), `${role} 应先声明我们自己的角色身份`);
  }
});