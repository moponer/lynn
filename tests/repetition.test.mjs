// 流式复读熔断（2026-11-11 长任务实测：thinking 里同一句连打 237 次 / 17542 字）
import { test } from "node:test";
import assert from "node:assert/strict";
import { detectTrailingRepetition, stripTrailingRepetition } from "../dist/main/repetition.js";

const LINE = '根据 "Critical Context" 中的 "仓库结构适应"，我们已经主动探测并修正了路径偏差，所以不需要再担心路径问题。';

test("真实现场：237 次同句复读能识别，截断后不再刷屏", () => {
  const text = `开头：先核对阶段4 与阶段6 的状态。\n\n${Array(237).fill(LINE).join("\n\n")}`;
  const hit = detectTrailingRepetition(text);
  assert.ok(hit, "必须命中退化复读");
  assert.ok(hit.repeats >= 8);
  assert.ok(hit.chars >= 240);
  const kept = stripTrailingRepetition(text, hit);
  assert.match(kept, /开头：先核对/);
  assert.ok(kept.length < text.length / 10, "整段复读都要截掉，不是只截最后一小段");
  assert.ok((kept.match(/不需要再担心路径问题/g) ?? []).length <= 2);
});

test("正常文本不误杀：分点列举、短重复、收尾补充", () => {
  assert.equal(detectTrailingRepetition("1. 先读文件\n2. 再跑测试\n3. 最后汇报\n".repeat(3)), null);
  assert.equal(detectTrailingRepetition("结论：通过。".repeat(3) + "补充说明：证据都在卷宗里。"), null);
  assert.equal(
    detectTrailingRepetition("我们核对了路径、依赖与配置，确认三处都落在工作区内，可以开工。".repeat(3)),
    null,
  );
});

test("重复次数不足 / 文本太短 / 空文本都不触发", () => {
  assert.equal(detectTrailingRepetition(LINE.repeat(3)), null);
  assert.equal(detectTrailingRepetition(""), null);
  assert.equal(detectTrailingRepetition("短"), null);
});

test("阈值可配置：短周期高频重复也能拦", () => {
  const hit = detectTrailingRepetition("abcdefgh".repeat(10), {
    minUnit: 8,
    minRepeats: 8,
    minChars: 64,
  });
  assert.ok(hit);
  assert.equal(hit.unit, "abcdefgh");
  assert.ok(hit.repeats >= 8);
});
