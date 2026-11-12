// 2026-11-11：右下角系统通知只留给「用户必须动手」的错误。
import { test } from "node:test";
import assert from "node:assert/strict";
import { needsUserAttention } from "../dist/main/notify-policy.js";

test("5xx / 429 / 网络 / 超时 不弹系统通知", () => {
  for (const code of ["endpoint_5xx", "rate_429", "network", "timeout", "steer_failed", "unknown"]) {
    assert.equal(needsUserAttention(code), false, `${code} 不该弹通知`);
  }
});

test("401 / 没模型 / worker 崩溃 需要用户动手，允许通知", () => {
  for (const code of ["auth_401", "no_model", "worker_crashed"]) {
    assert.equal(needsUserAttention(code), true, `${code} 应该弹通知`);
  }
  assert.equal(needsUserAttention(undefined), false);
});
