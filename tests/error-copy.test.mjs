/**
 * 错误卡可行动（P6-6 / 18 章 §5 F7）。
 *
 * 要治的具体毛病：**给了必然失败的按钮**。原来 `classifyError` 把 429 一律映射成 `retry`，
 * 而额度用尽时点「重试」只会再撞一次 429——用户点三次、烧三次请求配额，最后还是得去充值。
 *
 * 所以这组断言的核心判据是：**这个按钮点下去，成功概率是不是接近零**。
 * 接近零就不许给按钮，并且必须如实说明"为什么不给"。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { errorCopy, shouldMergeError, errorMergeKey, ERROR_MERGE_WINDOW_MS } = await jiti.import("../src/main/error-copy.ts", {
  default: true,
});

test("额度用尽：不给「重试」，给「去设置」——重试必然再撞 429", () => {
  const c = errorCopy("rate_429", "429 quota exceeded", { quotaExhausted: true, cooldownMinutes: 20 });
  assert.equal(c.action, "settings", `额度用尽时不该给重试，实际给了 ${c.action}`);
  assert.equal(c.retryable, false);
  assert.match(c.title, /额度/, "标题要说清是额度问题，不是笼统的「出错了」");
  assert.match(c.detail, /20 分钟/, "要说具体停多久（从 context 来的真实数字）");
  assert.match(c.detail, /发一条消息/, "要给出恢复路径：充值后怎么继续");
});

test("临时限流：给「重试」——等一会儿确实可能通", () => {
  const c = errorCopy("rate_429", "429 too many requests", { quotaExhausted: false });
  assert.equal(c.action, "retry");
  assert.equal(c.retryable, true);
});

test("Key 无效：不给「重试」，给「去设置」", () => {
  const c = errorCopy("auth_401", "401 unauthorized");
  assert.equal(c.action, "settings");
  assert.equal(c.retryable, false);
  assert.match(c.detail, /重试没有意义/, "要明说为什么没有重试按钮");
});

test("超时 / 5xx / 网络抖动：都可以重试（这些重试真的可能成功）", () => {
  for (const code of ["timeout", "timeout_idle", "endpoint_5xx", "network"]) {
    const c = errorCopy(code, "x");
    assert.equal(c.action, "retry", `${code} 应当可重试`);
    assert.equal(c.retryable, true);
  }
});

test("5xx 文案按「有没有备用模型」说不同的话", () => {
  const withBackup = errorCopy("endpoint_5xx", "500", { hasBackupModel: true });
  assert.match(withBackup.detail, /备用模型/, "配了就该告诉用户可以切");
  const noBackup = errorCopy("endpoint_5xx", "500", { hasBackupModel: false });
  assert.match(noBackup.detail, /没有配置备用模型/, "没配就别假装有");
});

test("沙箱拦截：不给任何按钮——这不是故障，是权限边界", () => {
  const c = errorCopy("sandbox_violation", "读 ~/.ssh 不在授权内");
  assert.equal(c.action, "none");
  assert.equal(c.retryable, false);
  assert.match(c.detail, /ESCALATE|授权/, "要给可行的下一步，不是只说「被挡住了」");
});

test("未知错误：给「看日志」，不假装知道怎么修", () => {
  const c = errorCopy("unknown", "某个没见过的错误");
  assert.equal(c.action, "logs");
  assert.equal(c.retryable, false);
  assert.match(c.detail, /没见过的错误/, "原始信息要保留，别吞掉");
});

test("合并键带上 action：429 的两种形态不许合并（否则按钮和语义对不上）", () => {
  assert.notEqual(errorMergeKey("rate_429", "retry"), errorMergeKey("rate_429", "settings"));
  const now = Date.now();
  const prev = { code: "rate_429", action: "retry", at: now - 1000 };
  assert.equal(shouldMergeError(prev, { code: "rate_429", action: "retry" }, now), true, "同类应当合并");
  assert.equal(
    shouldMergeError(prev, { code: "rate_429", action: "settings" }, now),
    false,
    "限流与额度用尽不能合并——用户会看到「重试」按钮却对应额度用尽",
  );
});

test("合并有时间窗：超过 5 分钟重新落卡（旧错误不该吃掉新错误的可见性）", () => {
  const now = Date.now();
  const fresh = { code: "timeout", action: "retry", at: now - 1000 };
  const stale = { code: "timeout", action: "retry", at: now - ERROR_MERGE_WINDOW_MS - 1 };
  assert.equal(shouldMergeError(fresh, { code: "timeout", action: "retry" }, now), true);
  assert.equal(shouldMergeError(stale, { code: "timeout", action: "retry" }, now), false);
});

test("没有上一条错误时不合并（第一次必须落卡）", () => {
  assert.equal(shouldMergeError(null, { code: "timeout", action: "retry" }, Date.now()), false);
  assert.equal(shouldMergeError(undefined, { code: "timeout", action: "retry" }, Date.now()), false);
});