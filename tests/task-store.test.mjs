import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TaskStore, TaskConflictError, TaskRuleError, TASK_STATUSES } from "../dist/main/task-store.js";

/**
 * 工单实体（§4.8 / §4.10.4 / §4.10.5）：
 * 权威 status、version 乐观并发、parent 单亲、evidence 准入、七态迁移。
 */

function newStore() {
  return new TaskStore(fs.mkdtempSync(path.join(os.tmpdir(), "lynn-task-")));
}

const ev = (over = {}) => ({ kind: "command", label: "pytest 24 passed", ref: "tests/test_collect.py", verified: true, ...over });

function toReview(store, id) {
  store.transition(id, "todo");
  store.transition(id, "in_progress");
  store.addEvidence(id, ev());
  return store.transition(id, "in_review");
}

test("建单：backlog + v1，落盘后能读回", () => {
  const store = newStore();
  const rec = store.create({ id: "WO-1", title: "抓取 issues", teamId: "t1" });
  assert.equal(rec.status, "backlog");
  assert.equal(rec.version, 1);
  assert.equal(rec.parentId, null);
  assert.ok(fs.existsSync(path.join(store.dataRoot, "tasks", "WO-1", "task.json")));
  const again = new TaskStore(store.dataRoot).get("WO-1");
  assert.equal(again?.title, "抓取 issues");
});

test("七态完整流转：受理→派单→执行→审查→归档（每步 version 递增）", () => {
  const store = newStore();
  store.create({ id: "WO-2", title: "周报", teamId: "t1" });
  assert.equal(store.transition("WO-2", "todo").status, "todo");
  assert.equal(store.transition("WO-2", "in_progress", { member: "顾明" }).member, "顾明");
  store.addEvidence("WO-2", ev());
  const review = store.transition("WO-2", "in_review");
  assert.equal(review.status, "in_review");
  assert.equal(review.evidence.length, 1);

  store.approve("WO-2", "user", "验收");
  const done = store.transition("WO-2", "done");
  assert.equal(done.status, "done");
  assert.equal(done.version, 7, "建单 + 5 次迁移 + 1 次登记证据");
});

test("进审查必须带已验证证据：无证据 / 未验证都不可达", () => {
  const store = newStore();
  store.create({ id: "WO-3", title: "x", teamId: "t1" });
  store.transition("WO-3", "todo");
  store.transition("WO-3", "in_progress");
  assert.throws(() => store.transition("WO-3", "in_review"), /≥1 项已验证证据/);

  store.addEvidence("WO-3", ev({ verified: false }));
  assert.throws(() => store.transition("WO-3", "in_review"), /≥1 项已验证证据/);

  store.addEvidence("WO-3", ev());
  assert.equal(store.transition("WO-3", "in_review").status, "in_review");
});

test("进归档必须有用户拍板记录", () => {
  const store = newStore();
  store.create({ id: "WO-4", title: "x", teamId: "t1" });
  toReview(store, "WO-4");
  assert.throws(() => store.transition("WO-4", "done"), /显式拍板/);
  assert.throws(() => store.approve("WO-4", "user", undefined, { expectedVersion: 999 }), TaskConflictError);
  store.approve("WO-4", "user");
  assert.equal(store.transition("WO-4", "done").status, "done");
});

test("非法迁移被拒（backlog 不能直接 done，done 是终态）", () => {
  const store = newStore();
  store.create({ id: "WO-5", title: "x", teamId: "t1" });
  assert.throws(() => store.transition("WO-5", "done"), /不允许的迁移/);
  toReview(store, "WO-5");
  store.approve("WO-5");
  store.transition("WO-5", "done");
  assert.throws(() => store.transition("WO-5", "in_progress"), /不允许的迁移/);
});

test("version 乐观并发：旧版本写被拒，不覆盖别人的写", () => {
  const store = newStore();
  const rec = store.create({ id: "WO-6", title: "x", teamId: "t1" });
  const stale = rec.version; // 两个写者都读到 v1
  store.transition("WO-6", "todo", { expectedVersion: stale });
  assert.throws(
    () => store.transition("WO-6", "in_progress", { expectedVersion: stale }),
    (err) => err instanceof TaskConflictError && err.actual === 2,
  );
  assert.equal(store.get("WO-6")?.status, "todo");
});

test("打回：轮次 +1，满 3 轮转 blocked 并标记升级", () => {
  const store = newStore();
  store.create({ id: "WO-7", title: "x", teamId: "t1" });
  toReview(store, "WO-7");
  const reason = { what: "少了 #2411", expect: "按 number 去重", deadline: "15 分钟" };
  assert.throws(() => store.reject("WO-7", { what: "", expect: "", deadline: "" }), /必须写清/);

  for (let i = 1; i <= 2; i++) {
    if (store.get("WO-7").status !== "in_review") {
      store.addEvidence("WO-7", ev());
      store.transition("WO-7", "in_review");
    }
    const r = store.reject("WO-7", reason);
    assert.equal(r.escalated, false);
    assert.equal(r.record.rejectRounds, i);
    assert.equal(r.record.status, "in_progress");
  }
  store.addEvidence("WO-7", ev());
  store.transition("WO-7", "in_review");
  const third = store.reject("WO-7", reason);
  assert.equal(third.escalated, true);
  assert.equal(third.record.status, "blocked");
  assert.equal(third.record.rejectRounds, 3);
});

test("父子关系：单亲、父必须存在；父工单进度可汇总", () => {
  const store = newStore();
  store.create({ id: "P-1", title: "父", teamId: "t1" });
  const child = store.create({ id: "C-1", title: "子", teamId: "t1", parentId: "P-1" });
  assert.equal(child.parentId, "P-1");
  assert.throws(() => store.create({ id: "C-2", title: "子2", teamId: "t1", parentId: "NOPE" }), /父工单不存在/);
  store.create({ id: "G-1", title: "孙", teamId: "t1", parentId: "C-1" });

  const children = store.list().filter((r) => r.parentId === "P-1");
  assert.equal(children.length, 1);
});

test("七态枚举与计划书一致", () => {
  assert.deepEqual(TASK_STATUSES, ["backlog", "todo", "in_progress", "in_review", "blocked", "done", "canceled"]);
});

test("取消：任何非终态可取消，取消后不可再迁移", () => {
  const store = newStore();
  store.create({ id: "WO-8", title: "x", teamId: "t1" });
  store.transition("WO-8", "canceled");
  assert.throws(() => store.transition("WO-8", "todo"), TaskRuleError);
});

test("归档：完成超 14 天才进归档带；进行中的不动", () => {
  const store = newStore();
  // 一个已完成、一个已取消、一个进行中
  const done = store.create({ id: "A-1", title: "完成的", teamId: "t1" });
  toReview(store, "A-1");
  store.approve("A-1");
  store.transition("A-1", "done");

  store.create({ id: "C-1", title: "取消的", teamId: "t1" });
  store.transition("C-1", "canceled");

  store.create({ id: "P-1", title: "在跑的", teamId: "t1" });
  store.transition("P-1", "todo");
  store.transition("P-1", "in_progress");

  // 把更新时间改成 20 天前（模拟陈旧）
  for (const id of ["A-1", "C-1", "P-1"]) {
    const f = path.join(store.dataRoot, "tasks", id, "task.json");
    const rec = JSON.parse(fs.readFileSync(f, "utf-8"));
    rec.updatedAt = new Date(Date.now() - 20 * 86_400_000).toISOString();
    fs.writeFileSync(f, JSON.stringify(rec, null, 2));
  }

  const moved = store.archiveOld(14);
  assert.deepEqual(moved.sort(), ["A-1", "C-1"]);
  assert.equal(store.get("A-1"), null, "归档后从台账消失");
  assert.equal(store.list().some((r) => r.id === "A-1"), false);
  assert.equal(store.archived().some((r) => r.id === "A-1"), true, "归档带仍可查到");
  assert.ok(store.get("P-1"), "进行中的工单不动");

  // 刚完成的不该被归档
  store.create({ id: "A-2", title: "刚完成", teamId: "t1" });
  toReview(store, "A-2");
  store.approve("A-2");
  store.transition("A-2", "done");
  assert.deepEqual(store.archiveOld(14), []);
});
