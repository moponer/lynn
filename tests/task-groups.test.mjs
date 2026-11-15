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

test("台账渲染顺序固定：等你 → 卡住 → 进行中 → 未开工 → 已终止", () => {
  assert.deepEqual(GROUP_ORDER, ["waiting", "stuck", "running", "queued", "halted"]);
});

/*
 * 群被「终止任务」之后（2026-11-15 实机）：本来"等你拍板"的验收印章还赖在右栏不走。
 * 终止是停住不是销毁——这些单不再催任何决定，归「已终止」组，恢复后自己回到原来的组。
 */
test("已终止的群：等你的单不再催、也不给任何动作（印章整块消失）", () => {
  assert.equal(groupOf("in_review", "user", true), "halted");
  assert.equal(actionOf("in_review", "user", true), "none");
  assert.equal(groupOf("blocked", undefined, true), "halted");
  assert.equal(actionOf("blocked", undefined, true), "none");
  assert.equal(groupOf("in_progress", undefined, true), "halted", "在跑的单也归已终止（成员已被停）");
  // 已经结案的不该被终止状态翻出来：历史照旧进归档带
  assert.equal(groupOf("done", undefined, true), "archived");
  assert.equal(groupOf("canceled", undefined, true), "archived");
  // 未终止时行为完全不变
  assert.equal(groupOf("in_review", "user", false), "waiting");
  assert.equal(actionOf("in_review", "user", false), "accept");
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
