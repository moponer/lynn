import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ContextStore } from "../dist/main/context-store.js";

/** 温层（§4.8）：摘要 + 最近 N 轮；超阈值压缩，冷层原文不动（冷层在 kernel 侧）。 */

function newStore() {
  return new ContextStore(fs.mkdtempSync(path.join(os.tmpdir(), "lynn-ctx-")));
}

test("追加与恢复：没有摘要时按顺序给回最近若干轮", () => {
  const s = newStore();
  s.append("user", "帮我把这张表整理成月报");
  s.append("assistant", "好，我先看看表头");
  const msgs = s.asMessages(10);
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].role, "user");
  assert.match(msgs[1].content, /表头/);
});

test("超过轮次阈值就压缩：只留最近 N 轮，摘要记早期请求", () => {
  const s = newStore();
  for (let i = 1; i <= 30; i++) {
    s.append("user", `第 ${i} 个请求：整理第 ${i} 份数据`);
    s.append("assistant", `第 ${i} 个回复`);
  }
  const r = s.maybeCompact({ keepRecent: 10, maxTurns: 24 });
  assert.equal(r.compacted, true);
  assert.equal(r.total, 10);
  assert.equal(r.moved, 50);

  const c = s.read();
  assert.equal(c.recent.length, 10);
  assert.ok(c.summarizedTurns >= 50);
  assert.match(c.summary, /第 1 个请求/);
  assert.match(c.summary, /第 20 个请求/); // 被移出的都进了摘要
});

test("恢复上下文时摘要作为一条前置说明，不混进最近轮", () => {
  const s = newStore();
  for (let i = 1; i <= 14; i++) {
    s.append("user", `请求 ${i}`);
    s.append("assistant", `回复 ${i}`);
  }
  s.maybeCompact({ keepRecent: 4, maxTurns: 8 });
  const msgs = s.asMessages(10);
  assert.equal(msgs.length, 5, "1 条摘要 + 最近 4 轮");
  assert.match(msgs[0].content, /压缩成摘要/);
  assert.equal(msgs[1].content, "请求 13");
  assert.equal(msgs[4].content, "回复 14");
});

test("阈值内不压缩", () => {
  const s = newStore();
  s.append("user", "你好");
  const r = s.maybeCompact({ maxTurns: 24 });
  assert.equal(r.compacted, false);
});

test("clear 清空温层，冷层不受影响（冷层由 kernel 管）", () => {
  const s = newStore();
  s.append("user", "x");
  s.clear();
  assert.equal(s.read().recent.length, 0);
});
