// 归档折叠只在展示层分组：记录一张不少、顺序不变、逐条仍可定位与删除。
import { test } from "node:test";
import assert from "node:assert/strict";
import { groupArchived, normalizeArchiveTitle } from "../dist/shared/archive-groups.js";

test("归一化标题：轮次后缀与括号噪声被剥掉", () => {
  assert.equal(normalizeArchiveTitle("G盘实习材料盘点（workspace模式重派）"), "g盘实习材料盘点");
  assert.equal(normalizeArchiveTitle("补交清单（第2轮）"), "补交清单");
  assert.equal(normalizeArchiveTitle("组件统计员A2 承接"), "组件统计员a2");
});

test("同会话 + 同归一化标题折叠为一组并标 ×N，组内每条原样保留", () => {
  const items = [
    { id: "t1", title: "G盘实习材料盘点", status: "done", threadId: "th-a" },
    { id: "t2", title: "G盘实习材料盘点（第2轮）", status: "canceled", threadId: "th-a" },
    { id: "t3", title: "G盘实习材料盘点（workspace模式重派）", status: "done", threadId: "th-a" },
    { id: "t4", title: "权限审计报告", status: "done", threadId: "th-a" },
  ];
  const groups = groupArchived(items);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].count, 3);
  assert.deepEqual(groups[0].items.map((x) => x.id), ["t1", "t2", "t3"]);
  assert.equal(groups[0].items[1].status, "canceled", "状态不因折叠被改写");
  assert.equal(groups[1].count, 1);
  assert.deepEqual(items.map((x) => x.id), ["t1", "t2", "t3", "t4"], "输入不被修改");
});

test("不同会话的同名任务不合并", () => {
  const groups = groupArchived([
    { id: "a", title: "盘点", threadId: "th-1" },
    { id: "b", title: "盘点（第2轮）", threadId: "th-2" },
  ]);
  assert.equal(groups.length, 2);
  assert.equal(groups.every((g) => g.count === 1), true);
});

test("空标题用 id 兜底，不会把不同记录误并", () => {
  const groups = groupArchived([
    { id: "a", title: "" },
    { id: "b", title: "（第2轮）" },
  ]);
  assert.equal(groups.length, 2);
});
