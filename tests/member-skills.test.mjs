/**
 * C1b（2026-11-19）：成员侧技能注入。
 *
 * 此前 `member-runner` **完全没有技能加载逻辑**——技能只被风铃读（写进 dataRoot/skills），
 * 成员从来看不到。于是"text-check / csv-analysis / text-diff"这类**讲成员工具**的
 * 预置技能，风铃读了也调不到（她只有管理工具），成员又根本收不到，三段能力全部悬空。
 *
 * 判据是**客观的**：技能声明的 allowed-tools 必须全部在本次工具集里——成员手上没有
 * 那个工具，注入技能它也做不了。不靠关键词猜任务类型。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMemberSkills } from "../dist/main/member-runner.js";

const skill = (over) => ({
  name: "text-check",
  description: "文本体检",
  allowedTools: ["lynn_tool_textstat_analyze", "read_file", "write_file", "submit_report"],
  body: "# 文本体检\n\n用 lynn_tool_textstat_analyze 量字数。",
  ...over,
});

test("C1b：工具全在 → 注入技能正文（含描述与正文）", () => {
  const out = renderMemberSkills([skill()], [
    "lynn_tool_textstat_analyze",
    "read_file",
    "write_file",
    "submit_report",
  ]);
  assert.match(out, /可用技能/);
  assert.match(out, /text-check/, "要带技能名");
  assert.match(out, /文本体检/, "要带描述");
  assert.match(out, /量字数/, "要带正文");
});

test("C1b：工具缺一个 → 不注入（成员做不了就不该占上下文）", () => {
  const out = renderMemberSkills([skill()], ["read_file", "write_file", "submit_report"]);
  assert.equal(out, "", "缺 lynn_tool_textstat_analyze，不该注入");
});

test("C1b：submit_report / post_message 不算额外要求（固定通道）", () => {
  const s = skill({ allowedTools: ["read_file", "submit_report", "post_message"] });
  const out = renderMemberSkills([s], ["read_file"]);
  assert.match(out, /text-check/, "固定通道不该挡住注入");
});

test("C1b：不传技能 / 空清单 → 空串（旧行为零影响）", () => {
  assert.equal(renderMemberSkills(undefined, ["read_file"]), "");
  assert.equal(renderMemberSkills([], ["read_file"]), "");
});

test("C1b：只注入最多 2 个技能（防撑爆首条 user）", () => {
  const many = [
    skill({ name: "s1" }),
    skill({ name: "s2" }),
    skill({ name: "s3" }),
  ];
  const out = renderMemberSkills(many, ["lynn_tool_textstat_analyze", "read_file", "write_file"]);
  const count = (out.match(/^### /gm) ?? []).length;
  assert.ok(count <= 2, `最多 2 个技能，实际 ${count}`);
});

test("C1b：空正文的技能不注入（没有内容就没有价值）", () => {
  const out = renderMemberSkills([skill({ body: "   " })], ["lynn_tool_textstat_analyze", "read_file", "write_file"]);
  assert.equal(out, "");
});

test("C1b：正文总字数受预算约束（超长截断而不是全塞）", () => {
  const long = skill({ body: "字".repeat(5000) });
  const out = renderMemberSkills([long], ["lynn_tool_textstat_analyze", "read_file", "write_file"]);
  assert.ok(out.length < 3000, `应截断到 2000 字预算内，实际 ${out.length}`);
  assert.match(out, /已截断/, "要如实标注截断");
});
