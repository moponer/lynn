import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AVATAR_STATES,
  AVATAR_STATE_LABEL,
  clampYaw,
  nextView,
  shouldSpeak,
  stateFromEvent,
  viewOfYaw,
  yawForView,
} from "../dist/shared/avatar.js";

/** 形象状态机与三视图（计划书 §2.5）：只消费事件流，动效只表达状态。 */

test("七个状态与计划书一致", () => {
  assert.deepEqual(AVATAR_STATES, [
    "idle",
    "thinking",
    "running",
    "success",
    "failed",
    "waiting_confirm",
    "standby",
  ]);
  assert.equal(AVATAR_STATE_LABEL.waiting_confirm, "等你确认");
});

test("角度折返到 (-180,180]，拖动不累积成 720°", () => {
  assert.equal(clampYaw(190), -170);
  assert.equal(clampYaw(-190), 170);
  assert.equal(clampYaw(360), 0);
});

test("三视图判定与预设按钮", () => {
  assert.equal(viewOfYaw(0), "front");
  assert.equal(viewOfYaw(30), "front");
  assert.equal(viewOfYaw(90), "side");
  assert.equal(viewOfYaw(-90), "side");
  assert.equal(viewOfYaw(180), "back");
  assert.equal(viewOfYaw(-170), "back");

  assert.equal(yawForView("side"), 90);
  assert.equal(nextView("front"), "side");
  assert.equal(nextView("back"), "front");
  assert.equal(nextView("front", -1), "back");
});

test("事件 → 状态：只认事件流，未知事件保持不动", () => {
  assert.equal(stateFromEvent("idle", "agent_start"), "thinking");
  assert.equal(stateFromEvent("thinking", "tool_call"), "running");
  assert.equal(stateFromEvent("running", "done"), "success");
  assert.equal(stateFromEvent("running", "error"), "failed");
  assert.equal(stateFromEvent("idle", "waiting_confirm"), "waiting_confirm");
  assert.equal(stateFromEvent("success", "agent_settled"), "idle");
  assert.equal(stateFromEvent("running", "something_else"), "running");
});

test("心声节流：只在想/跑/等时说，且至少隔 6 秒", () => {
  assert.equal(shouldSpeak("idle", null, 0), false);
  assert.equal(shouldSpeak("success", null, 0), false);
  assert.equal(shouldSpeak("thinking", null, 0), true);
  assert.equal(shouldSpeak("thinking", 10_000, 12_000), false, "冷却中");
  assert.equal(shouldSpeak("thinking", 10_000, 16_000), true, "过冷却");
});
