// Edge TTS 护栏（2026-11-16）：非官方接口，会被限流/403；这里锁死退避与熔断行为
import { test } from "node:test";
import assert from "node:assert/strict";
import { VoiceService, voiceCooldownMs, VOICE_COOLDOWN_STEPS } from "../dist/main/voice.js";
import { VOICE_DEFAULT_PREFS } from "../dist/main/voice-policy.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeService(synth) {
  const events = [];
  const errors = [];
  const svc = new VoiceService({
    getPrefs: () => ({ ...VOICE_DEFAULT_PREFS, voiceEnabled: true }),
    emit: (e) => events.push(e),
    isVisible: () => true,
    synthFn: synth,
    onSynthesizeError: (message, reason) => errors.push({ message, reason }),
  });
  return { svc, events, errors };
}

test("退避梯度：连败越多冷却越久（30s → 2min → 5min 封顶）", () => {
  assert.equal(voiceCooldownMs(0), 0);
  assert.equal(voiceCooldownMs(1), VOICE_COOLDOWN_STEPS[0]);
  assert.equal(voiceCooldownMs(2), VOICE_COOLDOWN_STEPS[1]);
  assert.equal(voiceCooldownMs(3), VOICE_COOLDOWN_STEPS[2]);
  assert.equal(voiceCooldownMs(9), VOICE_COOLDOWN_STEPS[2], "再多也封顶，不能无限增长");
});

test("合成失败一次就进入冷却：期间不再撞接口，只提示一次", async () => {
  let calls = 0;
  const { svc, events, errors } = makeService(async () => {
    calls += 1;
    throw new Error("No audio was received. Please verify that your parameters are correct.");
  });
  // 未完成卡是 high 优先级：能穿过 4 秒间隔闸，从而真正走到合成
  svc.sayCard({ kind: "tool", badge: "未完成", title: "阿明 没交出回报 · task-x", body: "**为什么没有回报**：轮次用尽" });
  await sleep(120);
  assert.equal(calls, 1, "第一次要真的发请求");
  assert.equal(errors.length, 1, "失败必须回报一次（供内核写日志）");
  assert.equal(errors[0].reason, "problem", "第一次是真实合成失败（未完成卡的原因）");

  // 冷却期内第二张卡：只丢弃，不再发请求
  svc.sayCard({ kind: "tool", badge: "崩溃", title: "阿明 执行崩溃 · task-y", body: "boom" });
  await sleep(120);
  assert.equal(calls, 1, "冷却期内不许再发请求");
  assert.equal(
    events.filter((e) => e.type === "play").length,
    0,
    "失败不发播放事件（不假装播过；stop 事件是打断上一句的，不算播放）",
  );
  assert.ok(
    errors.some((e) => e.reason === "cooldown"),
    "冷却要留一条说明，便于排查'为什么没播'",
  );
});

test("成功合成会清零失败计数（下一句照常播）", async () => {
  let calls = 0;
  const { svc, events } = makeService(async () => {
    calls += 1;
    return "data:audio/mpeg;base64,AAAA";
  });
  svc.sayCard({ kind: "tool", badge: "未完成", title: "阿明 没交出回报 · task-x", body: "**为什么没有回报**：轮次用尽" });
  await sleep(120);
  assert.equal(calls, 1);
  assert.equal(events.length, 1, "合成成功要发播放事件");
  assert.equal(svc.status().lastError, null);
});
