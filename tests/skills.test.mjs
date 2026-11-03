// M2-10：技能体系 —— SKILL.md 解析（宽容）、发现就近、匹配、20K 预算降级、allowed-tools 强制
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseSkillMd, discoverSkills, matchSkills, buildInjection, isToolAllowed, SKILL_BUDGET } from "../dist/main/skills.js";
import { Kernel } from "../dist/main/kernel.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lynn-skl-"));
const writeSkill = (root, name, body) => {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), body, "utf-8");
  return dir;
};

const SKILL = `---
name: 月报整理
description: 把源数据整理成周报月报
allowed-tools:
  - assign_task
  - check_progress
  - check_roster
---

按 deadline 回报，证据先落盘。
`;

test("parseSkillMd：解析/行内数组/未知字段告警/缺 name 兜底目录名", () => {
  const dir = path.join(tmp(), "月报整理");
  fs.mkdirSync(dir, { recursive: true });
  const r = parseSkillMd(SKILL, dir, "user");
  assert.equal(r.error, undefined);
  assert.deepEqual(r.entry.allowedTools, ["assign_task", "check_progress", "check_roster"]);
  assert.ok(r.entry.body.includes("证据先落盘"));

  const inline = parseSkillMd('---\nname: x\ndescription: y\nallowed-tools: [a, b]\nextra: 1\n---\nbody', dir, "user");
  assert.deepEqual(inline.entry.allowedTools, ["a", "b"]);
  assert.ok(inline.entry.warnings.some((w) => w.includes("extra")), "未知字段告警不拒绝");

  const noName = parseSkillMd("---\ndescription: d\n---\nb", path.join(tmp(), "fallback"), "user");
  assert.equal(noName.entry.name, "fallback");
  assert.ok(noName.entry.warnings.some((w) => w.includes("name")));

  assert.ok(parseSkillMd("no frontmatter", dir, "user").error?.includes("frontmatter"));
});

test("discoverSkills：三级就近（用户级先注册）；坏文件不炸", () => {
  const user = tmp();
  const proj = tmp();
  writeSkill(user, "skill-a", SKILL);
  writeSkill(user, "skill-b", SKILL.replace("月报整理", "技能B"));
  // 项目级同名（frontmatter name 仍是"月报整理"）→ 被就近原则覆盖
  writeSkill(proj, "skill-a", SKILL.replace("把源数据整理成周报月报", "项目定制描述"));
  writeSkill(proj, "bad", "没有 frontmatter");
  const { entries, errors } = discoverSkills([
    { dir: user, level: "user" },
    { dir: proj, level: "project" },
  ]);
  assert.equal(entries.length, 2);
  assert.equal(entries.find((e) => e.name === "月报整理").level, "user", "就近原则：用户级先注册");
  assert.ok(errors.some((e) => e.includes("重复")), "同名覆盖要告警");
  assert.ok(errors.some((e) => e.includes("bad")), "坏文件报错不炸整体");
});

test("匹配 + 20K 预算降级 + allowed-tools 判定", () => {
  const e = parseSkillMd(SKILL, path.join(tmp(), "x"), "user").entry;
  assert.ok(matchSkills("帮我把源数据整理成月报", [e]).some((s) => s.name === "月报整理"));
  assert.deepEqual(matchSkills("今天天气怎么样", [e]), [], "无关不激活");

  // 预算：全文 ≤ 预算不降级；构造超预算 → 仅名称
  const big = { ...e, body: "很长的正文。".repeat(SKILL_BUDGET) };
  const inj = buildInjection([big]);
  assert.equal(inj.degraded, true);
  assert.ok(inj.text.includes("月报整理"));
  assert.ok(inj.text.length < SKILL_BUDGET, "降级后必须小于预算");
  assert.equal(buildInjection([e]).degraded, false);

  // allowed-tools 强制语义
  const meta = ["assign_task", "ask_user", "report_to_user"];
  assert.equal(isToolAllowed("read_file", [], meta), true, "未激活技能不限制");
  assert.equal(isToolAllowed("assign_task", [e], meta), true, "声明子集放行");
  assert.equal(isToolAllowed("ask_user", [e], meta), true, "元工具始终放行");
  assert.equal(isToolAllowed("read_file", [e], meta), false, "子集外拒绝");
  assert.equal(isToolAllowed("anything", [{ ...e, allowedTools: ["*"] }], meta), true, "通配放行");
});

test("Kernel：技能被发现；激活后 allowed-tools 真的拦工具（直连执行层同闸）", async () => {
  const root = tmp();
  const skillDir = path.join(root, "skills", "月报整理");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), SKILL, "utf-8");
  const kernel = new Kernel(root);
  try {
    await kernel.init();
    assert.equal(kernel.skillEntries.length, 1, "reloadSkills 发现技能");
    assert.equal(kernel.skillEntries[0].name, "月报整理");

    // 未激活：工具照常
    const before = await kernel.executeToolCall("check_progress", { teamId: "nope", taskId: "nope" });
    assert.ok(before.length > 0);

    // 激活（模拟 submitTurn 的 activateSkillsFor 效果）：子集外工具被拦，元工具放行
    kernel.activateSkillsFor("帮我把源数据整理成月报");
    assert.equal(kernel.activeSkills.length, 1);
    const denied = await kernel.executeToolCall("read_file", { path: "x.md" });
    assert.match(denied, /allowed-tools/, "子集外如实拒绝");
    const allowed = await kernel.executeToolCall("check_progress", { teamId: "nope", taskId: "nope" });
    assert.ok(!allowed.includes("allowed-tools"), "声明子集内放行");
    const meta = await kernel.executeToolCall("report_to_user", { text: "hi" });
    assert.ok(!meta.includes("allowed-tools"), "元工具始终放行");

    // system prompt 注入
    assert.ok(kernel.systemPrompt().includes("月报整理"));
  } finally {
    await kernel.dispose();
  }
});
