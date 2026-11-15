// 回归：同一毫秒内连续 save，版本 id 不能互相覆盖（Linux 高频写入曾必现版本丢失）。
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MemoryStore } from "../dist/main/memory.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lynn-mem-ms-"));

test("同毫秒连续 save：每一版都独立留存，rollback 逐版回内容", () => {
  const root = tmp();
  const s = new MemoryStore(root);
  s.load("user");
  // 不 sleep、不 mock 时间：连续写入天然覆盖同毫秒场景
  const ids = [];
  for (const text of ["偏好暗色主题", "偏好暗色主题；叫老陈", "偏好暗色主题；叫老陈；周四交月报"]) {
    ids.push(s.save("user", text));
  }
  assert.equal(new Set(ids).size, ids.length, "每次 save 的版本 id 必须唯一");

  const vs = s.versions("user");
  const byId = new Map(vs.map((v) => [v.id, v]));
  for (const id of ids) assert.ok(byId.has(id), `版本 ${id} 应留存（不能被同毫秒覆盖）`);

  const rolled = s.rollback("user", ids[0]);
  assert.ok(rolled.includes("暗色主题"), `回滚内容应是第一版，实际：${rolled.slice(0, 60)}`);
  assert.ok(!rolled.includes("老陈"), "第一版不该含后续修改");
});

test("同毫秒连续 save：diff 基线稳定，能看到逐版新增行", () => {
  const root = tmp();
  const s = new MemoryStore(root);
  s.load("user");
  s.save("user", "用户在开发风铃");
  s.save("user", "用户在开发风铃；周四要交月报");
  const d = s.diff("user");
  assert.ok(
    d.changes.some((c) => c.t === "add" && c.line.includes("周四")),
    `diff 应能看到新增行，实际：${JSON.stringify(d.changes).slice(0, 200)}`,
  );
});
