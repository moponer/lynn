/**
 * 终局验收脚本（P7-1 / 附录 B）。
 *
 * 这组测试守的是**验收表本身的可信度**——一张自己会撒谎的验收表，比没有验收表更糟：
 *  1. 每一项都必须有明确状态（pass/fail/pending），不许有"不知道"混在里面；
 *  2. `pending` 必须写清缺什么（真实日志 / 真机 / 未实现），否则读者无从判断能不能等；
 *  3. `fail` 必须是真的没达标，不能把"没测"写成"没达标"（那会误导人去做无用功）；
 *  4. 附录 B 的每个分组都要有覆盖，新增指标时不能只加在文档里、忘了进脚本。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");

function runAcceptance() {
  const out = execFileSync("node", [path.join(repo, "scripts/acceptance.mjs"), "--json"], {
    encoding: "utf8",
    cwd: repo,
    maxBuffer: 8 * 1024 * 1024,
  });
  return JSON.parse(out);
}

const data = runAcceptance();
const rows = data.rows;

test("每一项都有明确状态：只有 pass / fail / pending 三种", () => {
  for (const r of rows) {
    assert.ok(["pass", "fail", "pending"].includes(r.status), `${r.id}（${r.name}）状态非法：${r.status}`);
  }
});

test("pending 必须带 blockedBy：结构化区分「等数据」与「等开发」", () => {
  for (const r of rows.filter((x) => x.status === "pending")) {
    assert.ok(
      ["production", "browser", "not-built"].includes(r.blockedBy),
      `${r.id}（${r.name}）标了 pending 却没有 blockedBy——"等日志"和"等开发"是两种完全不同的行动`,
    );
    assert.ok(r.measured && r.measured.length > 4, `${r.id} 的说明太短，读者判断不了`);
  }
});

test("pass / fail 的项不该带 blockedBy（它们已经验证过了）", () => {
  for (const r of rows.filter((x) => x.status !== "pending")) {
    assert.equal(r.blockedBy, null, `${r.id}（${r.name}）已经验证过了，不该还挂着 blockedBy`);
  }
});

test("fail 不许把「没测」当「没达标」——两者会误导完全不同的行动", () => {
  for (const r of rows.filter((x) => x.status === "fail")) {
    assert.ok(
      !/需要真实|未测|需真机/.test(r.measured),
      `${r.id}（${r.name}）没测却标了 fail：${r.measured}`,
    );
  }
});

test("附录 B 的六个分组都有覆盖", () => {
  const groups = new Set(rows.map((r) => r.group));
  for (const g of ["成本", "质量", "提示词", "安全", "性能", "可观测"]) {
    assert.ok(groups.has(g), `验收表缺少「${g}」分组——附录 B 有这一节，脚本里不能漏`);
  }
});

test("每一项都有基线、目标、采集方式（附录 B 的三列）", () => {
  for (const r of rows) {
    assert.ok(r.baseline, `${r.id} 缺基线`);
    assert.ok(r.target, `${r.id} 缺目标`);
    assert.ok(r.how && r.how.length > 0, `${r.id} 缺采集方式`);
  }
});

test("汇总数与明细自洽（避免统计口径与表格打架）", () => {
  const s = data.summary;
  assert.equal(s.total, rows.length);
  assert.equal(s.pass + s.fail + s.pending, rows.length, "三类之和必须等于总数");
  assert.equal(s.pass, rows.filter((r) => r.status === "pass").length);
  assert.equal(s.fail, rows.filter((r) => r.status === "fail").length);
  assert.equal(s.pending, rows.filter((r) => r.status === "pending").length);
});

test("已达标项要真的有证据（measured 不是空话）", () => {
  for (const r of rows.filter((x) => x.status === "pass")) {
    assert.ok(r.measured && r.measured.length > 2, `${r.id}（${r.name}）标了 pass 却没有证据`);
  }
});

test("已知未达标项必须在表里如实标 fail（不藏）", () => {
  const ids = rows.map((r) => r.id);
  // 这两条是 2026-11-17 复核过的事实，不许哪天被悄悄改成 pass
  assert.ok(ids.includes("S1"), "沙箱绕过用例必须在表里");
  const s1 = rows.find((r) => r.id === "S1");
  assert.equal(s1.status, "fail", "沙箱 10 条用例目前只挡住 2 条，必须如实标 fail");
  assert.match(s1.measured, /2\/10/, "要说清到底挡住了几条");

  const a3 = rows.find((r) => r.id === "A3");
  assert.ok(a3, "固定成本必须在表里");
  // 允许它将来变 pass，但当前如果没达标就必须是 fail
  if (a3.status === "fail") assert.match(a3.measured, /\d/, "要给出实测数字");
});