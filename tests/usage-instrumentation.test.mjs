// 用量埋点（2026-11-14）：台账能区分运行路径、端点是否回报缓存字段、前缀断点原因。
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { appendUsage, readUsage } from "../dist/main/budget.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lynn-usage-meta-"));

test("台账带 source / cacheFieldsReported / cacheBreakReason，读回不丢", () => {
  const root = tmp();
  appendUsage(root, {
    at: new Date().toISOString(),
    kind: "turn",
    in: 1200,
    out: 30,
    model: "m-1",
    cacheRead: 900,
    cacheWrite: 0,
    source: "pi",
    cacheFieldsReported: null,
    cacheBreakReason: "thread_switch",
  });
  const [row] = readUsage(root, 10);
  assert.equal(row.source, "pi");
  assert.equal(row.cacheFieldsReported, null, "Pi 拿不到端点原始字段，明确记 null");
  assert.equal(row.cacheBreakReason, "thread_switch");
  assert.equal(row.cacheRead, 900);
});

test("成员跑单也进台账（kind=member），且带缓存读数", () => {
  const root = tmp();
  appendUsage(root, {
    at: new Date().toISOString(),
    kind: "member",
    in: 800,
    out: 60,
    model: "m-1",
    cacheRead: 640,
    cacheWrite: 0,
    source: "member",
    cacheFieldsReported: false,
  });
  const [row] = readUsage(root, 10);
  assert.equal(row.kind, "member");
  assert.equal(row.source, "member");
  assert.equal(row.cacheFieldsReported, false, "端点没报字段，别把 640 当成通用结论");
  assert.equal(row.cacheRead, 640);
});

test("按次台账写的是本轮增量：两行求和 = 总量，不能把会话累计值逐行重复落", () => {
  const root = tmp();
  // 模拟 Pi 路径：第 1 轮 prompt=1000 命中 0，第 2 轮 prompt=1000 命中 900
  appendUsage(root, { at: "t1", kind: "turn", in: 1000, out: 20, model: "m", cacheRead: 0, source: "pi" });
  appendUsage(root, { at: "t2", kind: "turn", in: 1000, out: 20, model: "m", cacheRead: 900, source: "pi" });
  const rows = readUsage(root, 10);
  const totalPrompt = rows.reduce((a, r) => a + r.in, 0);
  const totalRead = rows.reduce((a, r) => a + (r.cacheRead ?? 0), 0);
  assert.equal(totalPrompt, 2000);
  assert.equal(totalRead, 900, "若写成累计值，第 2 行会变成 900、第 3 行 1800…求和翻倍");
});
