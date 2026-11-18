/**
 * G2 编译闸 / G3 golden / G4 战绩（P3-1b / 07 章 §4）。
 *
 * 三条闸各自要证明的东西：
 *  G2 —— 能不能**判定**"这个成员这次有没有岗位模板"，且判定失败时标出来而不是静默；
 *  G3 —— 每个 role×domain 都有一份 golden，改动提示词必须显式更新快照；
 *  G4 —— 战绩能按 roleId 聚合（换模板门禁与角色看板的数据源）。
 *
 * 另加一条 P3-1b 的实质验收：成员 system 长度，以及**跨任务逐字节相同**。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gateMemberCompile, LIMIT_BOUNDS } from "../dist/main/member-compile.js";
import { ROLE_REGISTRY, roleSpec } from "../dist/main/role-registry.js";
import { MemberPool, roleStats } from "../dist/main/member-pool.js";
import { memberSystemPrompt } from "../dist/main/member-runner.js";
import { buildAllMember, memberScenarios } from "../scripts/bench/golden.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..");
const PROMPTS = path.join(ROOT, "prompts");

/** 成员 system 的字数上限（05 章 §6「成员 system ~4.0K 字 → ≤2.6K」） */
const MEMBER_SYSTEM_BUDGET = 2600;

test("G2：注册表里声明了模板的角色，编译闸判定为「模板可用」", () => {
  let templated = 0;
  for (const spec of ROLE_REGISTRY) {
    if (!spec.template) continue;
    templated += 1;
    const g = gateMemberCompile({ roleId: spec.roleId, domain: spec.domains[0], body: "x".repeat(60) }, PROMPTS);
    assert.equal(g.ok, true, `${spec.roleId} 应能拿到模板：${g.reasons.join("；")}`);
    assert.equal(g.promptFallback, false);
    assert.ok(["vendor", "adapter"].includes(g.templateSource), `${spec.roleId} 模板来源应是 vendor/adapter`);
  }
  assert.ok(templated >= 8, `声明了模板的角色太少（${templated}），注册表和 vendor 对不上了`);
});

test("G2：自研角色靠档案正文，不算 fallback（writer/analyst/presenter）", () => {
  for (const roleId of ["writer", "analyst", "presenter"]) {
    const g = gateMemberCompile({ roleId, domain: "office", body: "先列提纲再写正文；写完后必须读回核对，逐项对照材料，口径不清就停下来回报。" }, PROMPTS);
    assert.equal(g.promptFallback, false, `${roleId} 有正文却标了 fallback`);
    assert.equal(g.templateSource, "profile");
  }
});

test("G2：模板缺失 / 角色不认识 / 正文也空 → promptFallback，但单子照派", () => {
  const missing = gateMemberCompile({ roleId: "implementer", domain: "coding", body: "" }, path.join(ROOT, "不存在的目录"));
  assert.equal(missing.promptFallback, true, "模板目录不对时必须标 fallback");
  assert.match(missing.reasons.join("；"), /模板缺失/);

  const unknown = gateMemberCompile({ roleId: "全栈兼文档", domain: "coding", body: "" }, PROMPTS);
  assert.equal(unknown.promptFallback, true);
  assert.match(unknown.reasons.join("；"), /不在注册表/);

  const selfmadeNoBody = gateMemberCompile({ roleId: "writer", domain: "office", body: "" }, PROMPTS);
  assert.equal(selfmadeNoBody.promptFallback, true, "自研角色正文空着就只剩通用纪律，要标出来");
});

test("G2：限额出界被夹到区间，并记原因（不是拒单）", () => {
  const g = gateMemberCompile(
    { roleId: "implementer", domain: "coding", body: "x".repeat(60), limits: { maxTurns: 999, budgetTokens: 1, wallClockMin: 5 } },
    PROMPTS,
  );
  assert.equal(g.limits.maxTurns, LIMIT_BOUNDS.maxTurns.max);
  assert.equal(g.limits.budgetTokens, LIMIT_BOUNDS.budgetTokens.min);
  assert.equal(g.limits.wallClockMin, LIMIT_BOUNDS.wallClockMin.min);
  assert.equal(g.promptFallback, false, "限额夹层不该把 promptFallback 也带出来——两个信号要分开");
  assert.equal(g.reasons.filter((r) => /夹到/.test(r)).length, 3, "每一条夹层都要留原因");
});

test("G2：工具面里的未知工具会被指出来", () => {
  const g = gateMemberCompile(
    { roleId: "implementer", domain: "coding", body: "x".repeat(60), tools: ["read_file", "bash_real", "submit_report"] },
    PROMPTS,
  );
  assert.match(g.reasons.join("；"), /未知工具：bash_real/);
  assert.ok(!g.reasons.join("；").includes("submit_report"), "回报通道不算未知工具");
});

test("G3：每个 role×domain 都有 golden，且与当前编译结果逐字节一致", () => {
  const snaps = buildAllMember();
  assert.equal(snaps.length, ROLE_REGISTRY.length, "注册表每个角色都该有一份成员 golden");
  for (const g of snaps) {
    const rel = path.relative(ROOT, g.file);
    assert.ok(fs.existsSync(g.file), `${rel} 不存在——先跑 npm run bench:golden:write`);
    assert.equal(g.content, fs.readFileSync(g.file, "utf8"), `${rel} 与代码不一致：提示词变了`);
  }
});

test("P3-1b 验收：成员 system ≤2,600 字（按工具面），且跨任务逐字节相同", () => {
  for (const s of memberScenarios()) {
    const build = (brief, deadline) =>
      memberSystemPrompt({
        profile: { ...s.profile, tools: s.tools },
        brief,
        deadline,
        tools: s.tools,
        workdir: "<workdir>",
        model: { baseUrl: "http://x", apiKey: "k", model: "m" },
      });
    const a = build("任务 A 的简报", "周五");
    const b = build("任务 B 的简报（完全不同的内容，还长一点）", "下周一");
    assert.equal(a, b, `${s.roleId}: 换了任务 system 就变了，跨任务前缀共享无从谈起`);
    assert.ok(
      a.length <= MEMBER_SYSTEM_BUDGET || s.tools.length > 4,
      `${s.roleId}/${s.domain} 的 system 是 ${a.length} 字，超了 ${MEMBER_SYSTEM_BUDGET} 预算`,
    );
  }
});

test("P3-1b 验收：任务级内容（简报/禁区/取舍）离开 system，进了首条 user", async () => {
  const { memberTaskIntro } = await import("../dist/main/member-runner.js");
  const input = {
    profile: { name: "x", role: "y", roleId: "implementer", goal: "g", boundaries: [], tools: ["read_file"], model: "m", limits: { maxTurns: 8, budgetTokens: 300000, wallClockMin: 20 }, outputContract: { deliverable: "d", evidence: [], acceptance: [] }, escalateWhen: "", body: "" },
    brief: "SECRET-BRIEF-9f2",
    deadline: "SECRET-DEADLINE-7a1",
    tools: ["read_file"],
    workdir: "<wd>",
    forbidden: ["SECRET-FORBID-3c4"],
    model: { baseUrl: "x", apiKey: "k", model: "m" },
  };
  const sys = memberSystemPrompt(input);
  for (const secret of ["SECRET-BRIEF-9f2", "SECRET-DEADLINE-7a1", "SECRET-FORBID-3c4"]) {
    assert.ok(!sys.includes(secret), `任务级内容 ${secret} 还在 system 里——它每单都不一样，留在 system 就是每次都全价重发`);
  }
  const intro = memberTaskIntro(input);
  for (const secret of ["SECRET-BRIEF-9f2", "SECRET-DEADLINE-7a1", "SECRET-FORBID-3c4"]) {
    assert.ok(intro.includes(secret), `任务级内容 ${secret} 没进任务段，成员就看不到它了`);
  }
});

test("G4：战绩按 roleId 聚合，probation 与打回原因都算进去", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-g4-"));
  const pool = new MemberPool(root);
  const mk = (name) => ({
    name,
    role: "后端工程师",
    roleId: "implementer",
    goal: "g",
    boundaries: [],
    tools: ["read_file"],
    model: "m",
    limits: { maxTurns: 8, budgetTokens: 300000, wallClockMin: 20 },
    outputContract: { deliverable: "d", evidence: [], acceptance: [] },
    escalateWhen: "",
    body: "先读再改。",
  });
  const a = pool.hire({ profile: mk("甲"), roleId: "implementer", domain: "coding" });
  const b = pool.hire({ profile: mk("乙"), roleId: "implementer", domain: "coding" });
  pool.recordOutcome(a.memberId, { ok: true, turns: 8, tokens: 100000 });
  pool.recordOutcome(b.memberId, { ok: false, turns: 12, tokens: 200000, rejectReason: "测试未跑" });

  const stats = roleStats(pool);
  const row = stats.find((s) => s.roleId === "implementer");
  assert.ok(row, "按 roleId 应聚合出一行");
  assert.equal(row.members, 2);
  assert.equal(row.tasks, 2);
  assert.equal(row.success, 1);
  assert.equal(row.successRate, 50);
  assert.equal(row.avgTurns, 10, "平均轮次应按单数求平均");
  assert.equal(row.avgTokens, 150000);
  assert.deepEqual(row.topRejectReasons, [{ reason: "测试未跑", count: 1 }]);
});