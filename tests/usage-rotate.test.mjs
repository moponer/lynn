// 记账文件轮转（2026-11-14）：usage.jsonl 过去只增不减（cleanup 只清 *.log）。
// 现在超阈值保留一份历史，读侧跨文件合并，cleanup 按 TTL 清历史。
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { appendUsage, readUsage } from "../dist/main/budget.js";
import { runCleanup } from "../dist/main/cleanup.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lynn-usage-"));
const line = (model) => ({ at: new Date().toISOString(), kind: "turn", in: 10, out: 5, model });

test("超阈值轮转，只保留一份历史", () => {
  const root = tmp();
  for (let i = 0; i < 5; i += 1) appendUsage(root, line(`m${i}`), 1);
  const dir = path.join(root, "logs");
  const main = fs.readFileSync(path.join(dir, "usage.jsonl"), "utf8").trim().split("\n");
  assert.equal(main.length, 1, "主文件只剩刚写的那一行");
  assert.ok(fs.existsSync(path.join(dir, "usage.1.jsonl")), "历史保留一份");
});

test("轮转后读最近 N 条：跨文件合并不丢", () => {
  const root = tmp();
  appendUsage(root, line("a"), 1e9);
  appendUsage(root, line("b"), 1e9);
  appendUsage(root, line("c"), 1); // 触发轮转：a、b 进历史
  assert.deepEqual(readUsage(root, 3).map((l) => l.model), ["a", "b", "c"]);
});

test("lastN<=0 返回空（边界探测抓到的真 bug：slice(-0) 会返回全部）", () => {
  const root = tmp();
  appendUsage(root, line("a"));
  assert.deepEqual(readUsage(root, 0), []);
  assert.deepEqual(readUsage(root, -5), []);
});

test("坏行跳过，不整段失败", () => {
  const root = tmp();
  const dir = path.join(root, "logs");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "usage.jsonl"), `${JSON.stringify(line("ok"))}\n{坏行\n${JSON.stringify(line("ok2"))}\n`);
  assert.deepEqual(readUsage(root, 10).map((l) => l.model), ["ok", "ok2"]);
});

test("cleanup 按 TTL 清历史文件，但绝不动正在写的 usage.jsonl", () => {
  const root = tmp();
  const dir = path.join(root, "logs");
  fs.mkdirSync(dir, { recursive: true });
  const main = path.join(dir, "usage.jsonl");
  const rotated = path.join(dir, "usage.1.jsonl");
  fs.writeFileSync(main, `${JSON.stringify(line("now"))}\n`);
  fs.writeFileSync(rotated, `${JSON.stringify(line("old"))}\n`);
  const old = Date.now() - 30 * 86_400_000;
  fs.utimesSync(rotated, new Date(old), new Date(old));

  runCleanup(root, { scratchDays: 14, checkpointDays: 7, logDays: 7 }, Date.now());
  assert.equal(fs.existsSync(rotated), false, "历史按 TTL 清掉");
  assert.equal(fs.existsSync(main), true, "正在写的文件不能删");
});
