/**
 * 成员池与三层隔离（P3-2 / 08 章）。
 *
 * 逐条对应 08 章 §7 的场景表——那五条就是这项的验收口径：
 *  1. 同成员跑 3 个不同任务 → **L1 的 sha256 不变**
 *  2. 任务 A 记教训 → 只写 L2，L1 不变
 *  3. 任务 B 同域 → 命中 L2 并注入首条 user
 *  4. 任务 B 异域 → 不注入，成员仍可被雇佣
 *  5. 连续 3 单失败 → probation（不自动删，可人工恢复）
 *
 * 外加几条机制性的：入池幂等、升格是唯一改 L1 的门、专有信息不许进 L1、离线可导出/导入。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemberPool, makeMemberId, renderLessons, lessonsFromOutcome } from "../dist/main/member-pool.js";
import { runMemberTask, memberSystemPrompt } from "../dist/main/member-runner.js";

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "lynn-pool-"));
}
function tmpWorkdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "lynn-pool-wd-"));
}

function profile(over = {}) {
  return {
    name: "林工",
    role: "后端工程师",
    roleId: "implementer",
    goal: "把代码改对",
    boundaries: ["只改工作区"],
    tools: ["read_file", "write_file"],
    model: "deepseek-chat",
    limits: { maxTurns: 6, budgetTokens: 300000, wallClockMin: 20 },
    outputContract: { deliverable: "diff", evidence: ["测试输出"], acceptance: ["test 全绿"] },
    escalateWhen: "卡住",
    body: "先读再改。",
    ...over,
  };
}

function hireOne(pool, over = {}) {
  return pool.hire({
    profile: profile(over.profile),
    roleId: over.roleId ?? "implementer",
    domain: over.domain ?? "coding",
    hiredFrom: over.hiredFrom ?? "team-a",
  });
}

const LESSON = {
  scope: "domain",
  domain: "coding",
  when: "跑测试 / typecheck",
  lesson: "先 npm run build:main 再跑单测，能早 3 轮发现类型错",
  evidenceTaskId: "task-a",
};

test("场景 1：同成员跑 3 个不同任务，L1 的 sha256 不变（验收核心）", () => {
  const pool = new MemberPool(tmpRoot());
  const { memberId } = hireOne(pool);
  const before = pool.l1Hash(memberId);

  for ( const [i, taskId] of ["task-a", "task-b", "task-c"].entries()) {
    pool.appendLesson(memberId, { ...LESSON, evidenceTaskId: taskId });
    pool.recordOutcome(memberId, { ok: i !== 2, turns: 5 + i, tokens: 1000 * (i + 1) });
    pool.pickLessons(memberId, { domain: "coding", brief: "跑测试" });
  }
  assert.equal(pool.l1Hash(memberId), before, "跑了三单之后 L1 居然变了——说明有东西在偷偷写岗位说明");
});

test("场景 2：记教训只写 L2，L1 不变、版本不变", () => {
  const pool = new MemberPool(tmpRoot());
  const { memberId } = hireOne(pool);
  const v0 = pool.get(memberId).meta.version;
  const h0 = pool.l1Hash(memberId);

  const { lesson, duplicated } = pool.appendLesson(memberId, LESSON);
  assert.equal(duplicated, false);
  assert.equal(lesson.scope, "domain");

  const m = pool.get(memberId);
  assert.equal(m.meta.version, v0, "记教训不许动 L1 版本号");
  assert.equal(pool.l1Hash(memberId), h0, "记教训不许改 L1 内容");
  assert.equal(m.lessons.length, 1, "经验要真的落到 L2");
});

test("L2 去重：同一张单重派反复记同一条，只加 hits 不灌水", () => {
  const pool = new MemberPool(tmpRoot());
  const { memberId } = hireOne(pool);
  pool.appendLesson(memberId, LESSON);
  const again = pool.appendLesson(memberId, LESSON);
  assert.equal(again.duplicated, true);
  const m = pool.get(memberId);
  assert.equal(m.lessons.length, 1, "同一条经验不该变两条");
  assert.equal(m.lessons[0].hits, 2);
});

test("场景 3：任务 B 同域命中 L2，并被注入首条 user（不进 system）", () => {
  const pool = new MemberPool(tmpRoot());
  const { memberId } = hireOne(pool);
  pool.appendLesson(memberId, LESSON);

  const picked = pool.pickLessons(memberId, { domain: "coding", brief: "跑一下测试看看" });
  assert.equal(picked.length, 1, "同域任务应当命中这条经验");
  const text = renderLessons(picked);
  assert.match(text, /build:main/, "注入文本要带上经验正文");
  assert.match(text, /task-a/, "要能追到这条经验来自哪张单");

  const input = {
    profile: profile({ memberId }),
    brief: "跑测试",
    deadline: "周五",
    tools: ["read_file"],
    workdir: tmpWorkdir(),
    lessons: picked,
    model: { baseUrl: "http://x", apiKey: "k", model: "m" },
  };
  // L2 只能进首条 user：system prompt 里出现经验就等于每轮都付、每次换前缀
  assert.ok(!memberSystemPrompt(input).includes("build:main"), "L2 不许进 system prompt");
});

test("场景 4：任务 B 异域不注入，但成员仍可被雇佣", () => {
  const pool = new MemberPool(tmpRoot());
  const { memberId } = hireOne(pool);
  pool.appendLesson(memberId, LESSON);

  const picked = pool.pickLessons(memberId, { domain: "office", brief: "写一份季度报告" });
  assert.deepEqual(picked, [], "写文档的任务不该被塞 coding 的坑");

  // 异域只是"这次没经验可注入"，不是"这个人不能用"
  const again = hireOne(pool, { domain: "office", roleId: "writer", hiredFrom: "team-b" });
  assert.ok(again.memberId, "异域任务照样能招人");
  assert.equal(pool.list({ domain: "office" }).length, 1, "两个领域各是各的人");
});

test("场景 5：连续 3 单失败进 probation，成功一次恢复（不自动删）", () => {
  const pool = new MemberPool(tmpRoot());
  const { memberId } = hireOne(pool);
  for (let i = 0; i < 2; i += 1) pool.recordOutcome(memberId, { ok: false });
  assert.equal(pool.get(memberId).meta.status, "active", "两单还不够，别过早下线");

  pool.recordOutcome(memberId, { ok: false });
  const p = pool.get(memberId);
  assert.equal(p.meta.status, "probation", "连续 3 单失败要标 probation");
  assert.ok(pool.list().some((m) => m.meta.memberId === memberId), "probation 不等于删除，人还在池子里");
  assert.deepEqual(pool.list({ status: "active" }).map((m) => m.meta.memberId), [], "推荐时不该再推它");

  pool.recordOutcome(memberId, { ok: true });
  assert.equal(pool.get(memberId).meta.status, "active", "成功一次要能恢复（人工可救）");
});

test("入池幂等：同角色同名同来源重复招募拿回同一个人，不会凭空多一个分身", () => {
  const pool = new MemberPool(tmpRoot());
  const a = hireOne(pool);
  const b = hireOne(pool);
  assert.equal(a.memberId, b.memberId);
  assert.equal(b.created, false, "第二次数的是复用，不是新人");
  assert.equal(pool.list().length, 1);
});

test("升格是唯一改 L1 的门：版本 +1、哈希变、经验从 L2 移走", () => {
  const pool = new MemberPool(tmpRoot());
  const { memberId } = hireOne(pool);
  const { lesson } = pool.appendLesson(memberId, LESSON);
  const h0 = pool.l1Hash(memberId);
  const v0 = pool.get(memberId).meta.version;

  // 没写确认人 → 直接拒（人工确认是硬要求）
  assert.throws(() => pool.promoteLesson(memberId, lesson.id, {}), /确认人/);

  const r = pool.promoteLesson(memberId, lesson.id, { confirmedBy: "user" });
  assert.equal(r.version, v0 + 1, "升格必须让版本 +1（污染检查靠它）");
  assert.notEqual(r.l1Hash, h0, "升格当然会改 L1——这正是它必须显式的原因");
  const m = pool.get(memberId);
  assert.match(m.profile.body, /已升格经验/, "经验要真的写进岗位说明");
  assert.equal(m.lessons.length, 0, "升格后这条要从 L2 移走，别两头都留");
});

test("专有信息不许升格进 L1（客户名/临时路径/项目代号）", () => {
  const pool = new MemberPool(tmpRoot());
  const { memberId } = hireOne(pool);
  const { lesson } = pool.appendLesson(memberId, {
    ...LESSON,
    lesson: "在 D:\\客户资料\\2026 里跑得很慢",
  });
  assert.throws(() => pool.promoteLesson(memberId, lesson.id, { confirmedBy: "user" }), /专有信息/);
});

test("候选推荐：成功率高的排前面，没战绩的中性起步，probation 不参与", () => {
  const pool = new MemberPool(tmpRoot());
  const good = hireOne(pool, { profile: { name: "老手" } });
  const bad = hireOne(pool, { profile: { name: "新手" } });
  for (let i = 0; i < 3; i += 1) pool.recordOutcome(good.memberId, { ok: true, turns: 5, tokens: 20000 });
  for (let i = 0; i < 3; i += 1) pool.recordOutcome(bad.memberId, { ok: false, turns: 15, tokens: 200000 });

  const ranked = pool.rankCandidates({ roleId: "implementer", domain: "coding" });
  assert.ok(ranked.length >= 1);
  assert.equal(ranked[0].member.meta.memberId, good.memberId, "3 战 3 胜的人应排在前面");
  assert.ok(!ranked.some((r) => r.member.meta.memberId === bad.memberId), "probation 不该被推荐");
  assert.match(ranked[0].why, /成功/, "推荐要能解释为什么（风铃要在群里说得出来）");
});

test("离线可导出/导入；导入不覆盖已有 L1（那是绕过升格）", () => {
  const src = new MemberPool(tmpRoot());
  const { memberId } = hireOne(src);
  src.appendLesson(memberId, LESSON);
  const dump = src.exportAll();
  assert.equal(dump.members.length, 1);
  assert.ok(dump.members[0].l1Hash, "导出要带 L1 指纹，便于异地比对");

  const dst = new MemberPool(tmpRoot());
  const r1 = dst.importAll(dump);
  assert.deepEqual(r1.imported, [memberId]);
  assert.equal(dst.l1Hash(memberId), dump.members[0].l1Hash, "导入后 L1 必须逐字节一致");
  assert.equal(dst.get(memberId).lessons.length, 1, "经验也要跟着走");

  const r2 = dst.importAll(dump);
  assert.deepEqual(r2.skipped, [memberId], "已存在的不许覆盖");
});

test("memberId 稳定且带角色前缀（名字可改、ID 不变）", () => {
  const a = makeMemberId("implementer", "same-seed");
  const b = makeMemberId("implementer", "same-seed");
  assert.equal(a, b, "同输入必须同 ID");
  assert.match(a, /^m-implementer-[0-9a-f]{6}$/);
  assert.notEqual(a, makeMemberId("implementer", "other-seed"));
  assert.notEqual(a, makeMemberId("writer", "same-seed"));
});

test("从结局提炼经验：只提炼能照做的，提炼不出来就不写", () => {
  const limit = lessonsFromOutcome({
    memberId: "m-x",
    taskId: "t1",
    domain: "coding",
    ok: false,
    exitStatus: "turn_limit",
    turns: 15,
    maxTurns: 15,
  });
  assert.equal(limit.length, 1);
  assert.match(limit[0].lesson, /给到 \d+ 以上/, "要给出下次该给多少轮的具体数字，不是「注意轮次」这种废话");

  const rework = lessonsFromOutcome({
    memberId: "m-x",
    taskId: "t1",
    domain: "coding",
    ok: false,
    reworkFocus: ["测试未跑", "缺引用"],
  });
  assert.equal(rework.length, 1);
  assert.match(rework[0].lesson, /测试未跑/, "打回原因要变成下次的自检项");

  const nothing = lessonsFromOutcome({ memberId: "m-x", taskId: "t1", domain: "coding", ok: true });
  assert.deepEqual(nothing, [], "顺利交付就没什么可记的，别硬凑");
});