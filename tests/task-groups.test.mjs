// 台账分组与"该你做什么"的纯函数（shared/task-groups）
// 回归的背景 bug：backlog/todo 被算进"进行中"，blocked 被并进"等你拍板"并给出验收按钮。

import { test } from "node:test";
import assert from "node:assert/strict";
import { groupOf, actionOf, GROUP_ORDER } from "../dist/shared/task-groups.js";

test("分组与状态一一对应：待受理 / 待派单不再算进行中", () => {
  assert.equal(groupOf("backlog"), "queued");
  assert.equal(groupOf("todo"), "queued");
  assert.equal(groupOf("in_progress"), "running");
  assert.equal(groupOf("in_review"), "waiting");
  assert.equal(groupOf("blocked"), "stuck");
  assert.equal(groupOf("done"), "archived");
  assert.equal(groupOf("canceled"), "archived");
});

test("只有 in_review 可以验收；卡住只给解卡，不给签字", () => {
  assert.equal(actionOf("in_review"), "accept");
  assert.equal(actionOf("blocked"), "unblock");
  for (const s of ["backlog", "todo", "in_progress", "done", "canceled"]) {
    assert.equal(actionOf(s), "none", `${s} 不该出现"验收归档"`);
  }
});

test("台账渲染顺序固定：等你 → 卡住 → 进行中 → 未开工", () => {
  assert.deepEqual(GROUP_ORDER, ["waiting", "stuck", "running", "queued"]);
});

/*
 * 验收权分层（背景 bug）：成员一交回报，工单就变 in_review，值台立刻把三张单
 * 都标成"等你拍板"弹给用户——可这些活归风铃管，用户只该审她交来的最终结果。
 */
test("派给成员的活等风铃验：不占用户待办，也不给验收按钮", () => {
  assert.equal(groupOf("in_review", "lynn"), "running");
  assert.equal(actionOf("in_review", "lynn"), "none");
});

test("reviewer 缺省按用户验：老单和风铃自己的交付都不会被偷偷归档", () => {
  assert.equal(groupOf("in_review"), "waiting");
  assert.equal(actionOf("in_review"), "accept");
  assert.equal(groupOf("in_review", "user"), "waiting");
  assert.equal(actionOf("in_review", "user"), "accept");
});
