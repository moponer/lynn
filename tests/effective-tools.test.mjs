// 本单实际授权（B3 / §4.10.3）：成员卡显示的是"这次派单给了什么"，
// 不是岗位档案模板。assign 记录的 text 是 JSON {brief, deadline, tools}。
import { test } from "node:test";
import assert from "node:assert/strict";
import { effectiveToolsOf } from "../dist/main/team-store.js";

const rec = (over = {}) => ({
  taskId: "WO-1",
  at: "2026-11-04T10:00:00.000Z",
  kind: "assign",
  text: JSON.stringify({ brief: "做点事", deadline: "15:00", tools: ["read_file", "write_file"] }),
  ...over,
});

test("assign 记录解析出本单授权；report/reject 记录一律 null", () => {
  assert.deepEqual(effectiveToolsOf(rec()), ["read_file", "write_file"]);
  assert.equal(effectiveToolsOf(rec({ kind: "report" })), null);
  assert.equal(effectiveToolsOf(rec({ kind: "reject" })), null);
});

test("坏 JSON / 缺 tools / 空 tools / 非字符串元素：null（回落岗位模板），不炸", () => {
  assert.equal(effectiveToolsOf(rec({ text: "{not json" })), null);
  assert.equal(effectiveToolsOf(rec({ text: JSON.stringify({ brief: "x" }) })), null);
  assert.equal(effectiveToolsOf(rec({ text: JSON.stringify({ tools: [] }) })), null);
  assert.equal(effectiveToolsOf(rec({ text: JSON.stringify({ tools: ["ok", 42] }) })), null);
});
