/**
 * 写作规则按域注入（P2 / 05 章第 4 节）：
 * coding/ops 成员的交付物是代码与命令输出，不该背 1,200 字「去 AI 味」规则。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { writesProseDocs } from "../dist/main/member-profile.js";

test("有 office_* 工具 → 需要写作规则", () => {
  assert.equal(writesProseDocs("后端开发", ["read_file", "office_write_docx"]), true);
  assert.equal(writesProseDocs("数据整理员", ["office_write_table"]), true);
});

test("岗位名带文档属性 → 需要", () => {
  assert.equal(writesProseDocs("文档工程师", []), true);
  assert.equal(writesProseDocs("技术写作", []), true);
  assert.equal(writesProseDocs("报告编辑", []), true);
});

test("coding / ops 成员 → 不需要（省每轮约 750 tokens）", () => {
  assert.equal(writesProseDocs("后端开发", ["read_file", "write_file", "edit_file", "run_command"]), false);
  assert.equal(writesProseDocs("测试工程师", ["run_command"]), false);
  assert.equal(writesProseDocs("运维排查", ["run_command", "read_file"]), false);
  assert.equal(writesProseDocs("", []), false);
});
