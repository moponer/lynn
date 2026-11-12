// 2026-11-11：工单标题不能把「上一单失败 + 半条 Windows 路径」硬砍成主区大标题。
import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanTaskTitle } from "../dist/main/kernel.js";

test("cleanTaskTitle：路径/URL 不当标题，超长用省略号而不是硬砍", () => {
  const raw = "上一单 perm-audit-001 失败：被当成项目的 C:\\Users\\Administrator\\AppData\\Local\\Temp\\lynn";
  const t = cleanTaskTitle(raw, "perm-locate-002");
  assert.ok(!t.includes("C:\\Users\\Ad"), "不能把半条路径摆上标题");
  assert.ok(t.includes("（路径）"), "路径要被折叠成占位");
  assert.ok(t.length <= 37, `标题过长：${t.length}`);
  const long = cleanTaskTitle("核对".repeat(40), "WO-1");
  assert.ok(long.endsWith("…"), "超长要省略号");
  assert.ok(long.length <= 37);
});

test("cleanTaskTitle：段落标记剥掉；显式短标题原样保留", () => {
  assert.equal(cleanTaskTitle("【目标】整理周报", "WO-1"), "整理周报");
  assert.equal(cleanTaskTitle("核对权限边界", "WO-2"), "核对权限边界");
  assert.equal(cleanTaskTitle("   ", "WO-3"), "WO-3");
});

test("cleanTaskTitle：UNC / http 链接不当标题", () => {
  const t = cleanTaskTitle("读取 \\\\nas\\共享\\报表.xlsx 和 https://example.com/a 的数据", "t1");
  assert.ok(!t.includes("\\\\nas\\共享"));
  assert.ok(!t.includes("https://"));
  assert.ok(t.includes("（链接）"));
});
