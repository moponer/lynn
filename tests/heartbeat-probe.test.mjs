// 秒级心跳：探针只读内存（零 token），唤醒由「合并窗口 / 同批冷却 / 每小时配额」三道闸控制。
import { test } from "node:test";
import assert from "node:assert/strict";
import { heartbeatWakeDecision, probeDelayMs } from "../dist/main/heartbeat.js";

const state = (over = {}) => ({
  lastWakeAt: 0,
  windowStart: 0,
  windowCount: 0,
  lastSig: "",
  lastSigAt: 0,
  ...over,
});

test("探针间隔自适应：有成员在跑按配置（默认 1s），空闲退避到 15s，且有上下界", () => {
  assert.equal(probeDelayMs(2, 1000), 1000);
  assert.equal(probeDelayMs(1, 100), 500, "再小也不低于 500ms");
  assert.equal(probeDelayMs(1, 30_000), 5000, "再大也不超过 5s，保证秒级感知");
  assert.equal(probeDelayMs(0, 1000), 15_000, "空闲退避，别让 1s 定时器常驻耗电");
});

test("唤醒闸：忙时不插队", () => {
  const d = heartbeatWakeDecision({
    now: 10_000, busy: true, sig: "a", state: state(), minGapMs: 20_000, cooldownMs: 30 * 60_000, perHour: 12,
  });
  assert.equal(d.wake, false);
  assert.equal(d.reason, "busy");
});

test("唤醒闸：同一波事件在合并窗口内只叫醒一次", () => {
  const d = heartbeatWakeDecision({
    now: 10_000, busy: false, sig: "a", state: state({ lastWakeAt: 5_000 }), minGapMs: 20_000, cooldownMs: 30 * 60_000, perHour: 12,
  });
  assert.equal(d.wake, false);
  assert.equal(d.reason, "merge_window");
});

test("唤醒闸：事实没变就 30 分钟不重复烧上下文", () => {
  const d = heartbeatWakeDecision({
    now: 60_000, busy: false, sig: "a",
    state: state({ lastWakeAt: 10_000, lastSig: "a", lastSigAt: 30_000 }),
    minGapMs: 20_000, cooldownMs: 30 * 60_000, perHour: 12,
  });
  assert.equal(d.wake, false);
  assert.equal(d.reason, "same_facts");
});

test("唤醒闸：事实变了且过了合并窗口就唤醒，并记一次配额", () => {
  const prev = state({ lastWakeAt: 10_000, lastSig: "a", lastSigAt: 10_000, windowStart: 50_000, windowCount: 3 });
  const d = heartbeatWakeDecision({
    now: 60_000, busy: false, sig: "b", state: prev, minGapMs: 20_000, cooldownMs: 30 * 60_000, perHour: 12,
  });
  assert.equal(d.wake, true);
  assert.equal(d.next.windowCount, 4);
  assert.equal(d.next.lastSig, "b");
  assert.equal(prev.windowCount, 3, "闸状态不可变，调用方自己替换");
});

test("唤醒闸：每小时配额打满后不再唤醒，窗口滚动后恢复", () => {
  const s = state({ windowStart: 1_000, windowCount: 2 });
  const full = heartbeatWakeDecision({
    now: 60_000, busy: false, sig: "b", state: s, minGapMs: 0, cooldownMs: 0, perHour: 2,
  });
  assert.equal(full.wake, false);
  assert.equal(full.reason, "hour_quota");
  assert.equal(full.next.windowCount, 2);

  const rolled = heartbeatWakeDecision({
    now: 1_000 + 60 * 60_000 + 1, busy: false, sig: "b", state: s, minGapMs: 0, cooldownMs: 0, perHour: 2,
  });
  assert.equal(rolled.wake, true, "过了整点窗口重新计数");
  assert.equal(rolled.next.windowCount, 1);
});
