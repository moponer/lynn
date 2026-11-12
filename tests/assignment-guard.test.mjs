// 派单内容级去重：2026-11-11 长任务同一阶段重派 24 次，每次新 taskId 绕开并发闸。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assignmentSimilarity,
  findDuplicateAssignment,
  normalizeAssignmentTitle,
} from "../dist/main/assignment-guard.js";

const existing = [
  {
    taskId: "t1",
    title: "阶段5-A·子代理A：统计 src/components 下 .tsx 文件数",
    member: "组件统计员A",
    teamId: "team-1",
    status: "in_review",
  },
  {
    taskId: "t2",
    title: "阶段2·仓库分析 shutdown.rs",
    member: "shutdown 分析员",
    teamId: "team-1",
    status: "done",
  },
];

test("重派标题归一化后与在审单同源", () => {
  assert.equal(normalizeAssignmentTitle("阶段5-A 统计 .tsx 文件数（workspace 重派）"), "阶段5a统计.tsx文件数");
  assert.ok(assignmentSimilarity("阶段5-A 统计 .tsx 文件数（重派）", "阶段5-A 统计 .tsx 文件数") > 0.9);
});

test("同一成员 + 相似标题命中未终态工单", () => {
  const hit = findDuplicateAssignment(existing, {
    title: "阶段5-A 统计 src/components 下 .tsx 文件数（A2 承接）",
    member: "组件统计员A",
    teamId: "team-1",
  });
  assert.equal(hit?.taskId, "t1");
});

test("不同成员 / 已归档 / 明显不同的任务都不拦", () => {
  assert.equal(
    findDuplicateAssignment(existing, {
      title: "阶段5-A 统计 .tsx 文件数（重派）",
      member: "另一个人",
      teamId: "team-1",
    }),
    null,
  );
  assert.equal(
    findDuplicateAssignment(existing, {
      title: "阶段2·仓库分析 shutdown.rs（重派）",
      member: "shutdown 分析员",
      teamId: "team-1",
    }),
    null,
  );
  assert.equal(
    findDuplicateAssignment(existing, {
      title: "阶段6 负向用例：读不存在的文件并如实报告",
      member: "组件统计员A",
      teamId: "team-1",
    }),
    null,
  );
});
