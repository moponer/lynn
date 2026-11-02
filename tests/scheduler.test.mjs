// M2-02：定时任务调度器 —— 单飞 / 陈旧在途清理 / 休眠补跑 / 关窗恢复
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { collectDue, nextRunAt, recover } from "../dist/main/scheduler.js";
import { SchedulerStore } from "../dist/main/scheduler.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lynn-sch-"));
const T = (over) => ({
  id: "t1", name: "日报", prompt: "跑日报", kind: "daily", time: "09:00",
  enabled: true, createdAt: "2026-11-01T00:00:00.000Z", ...over,
});

test("nextRunAt：daily/interval/once 三种；配置不完整如实 null", () => {
  const now = new Date(2026, 10, 3, 10, 0);
  assert.equal(new Date(nextRunAt(T({}), now)).getDate(), 4, "今天的 9 点已过 → 明天");
  const iv = nextRunAt(T({ kind: "interval", intervalMin: 30, lastRun: "2026-11-03T09:50:00" }), now);
  assert.equal(new Date(iv).getMinutes(), 20, "30 分钟间隔");
  const once = nextRunAt(T({ kind: "once", at: "2026-11-03T12:00:00" }), now);
  assert.equal(new Date(once).getHours(), 12);
  assert.equal(nextRunAt(T({ enabled: false }), now), null, "停用不排");
  assert.equal(nextRunAt(T({ kind: "interval", intervalMin: 0 }), now), null, "坏配置如实 null");
});

test("三边界：断网延迟 tick 不丢、睡醒补跑标 missed、关窗重启 recover 清陈旧", () => {
  const now = new Date(2026, 10, 3, 10, 0);
  // 1) tick 晚了几分钟（断网/挂起）：due 仍然命中
  const late = collectDue([T({ kind: "interval", intervalMin: 5, lastRun: "2026-11-03T09:50:00" })], now);
  assert.equal(late.length, 1);
  assert.equal(late[0].missed, false, "5 分钟内不算错过（抖动容忍）");
  // 2) 睡醒：错过 2 小时 → missed=true，任务还在（不丢）
  const woke = collectDue([T({ kind: "once", at: "2026-11-03T08:00:00" })], now);
  assert.equal(woke.length, 1);
  assert.equal(woke[0].missed, true);
  // 3) 关窗重启：在途锁陈旧（startedAt 超过 MAX_RUN_MIN）→ 释放并标 stale
  const state = {
    tasks: [T({ id: "stuck" })],
    running: "stuck",
    runningStartedAt: new Date(now.getTime() - 40 * 60_000).toISOString(),
  };
  const r = recover(state, now);
  assert.deepEqual(r.released, ["stuck"]);
  assert.equal(state.running, null);
  assert.equal(state.tasks[0].lastStatus, "stale");
  // 3b) 在途未超时（刚崩的进程）：锁保留，但任务下次照常可被 acquire 判定
  const fresh = { tasks: [T({ id: "live" })], running: "live", runningStartedAt: new Date(now.getTime() - 60_000).toISOString() };
  assert.deepEqual(recover(fresh, now).released, [], "没超时不误杀");
});

test("SchedulerStore：单飞抢锁/释放/missed 状态落盘；坏配置拒绝创建", () => {
  const root = tmp();
  const s = new SchedulerStore(root);
  const t = s.add({ name: "抓报表", prompt: "去后台导出", kind: "interval", intervalMin: 30 });
  assert.ok(t.id);
  assert.throws(() => s.add({ name: "坏", prompt: "x", kind: "interval", intervalMin: 0 }), /不完整/, "坏配置如实拒绝");

  const now = new Date();
  assert.equal(s.due(now).length, 1, "interval 无 lastRun → 立即到期");
  assert.equal(s.acquire(t.id, now), true);
  assert.equal(s.acquire(t.id, now), false, "单飞：第二个抢不到");
  s.release(t.id, "ok");
  assert.equal(s.get().running, null);
  assert.equal(s.get().tasks[0].lastStatus, "ok");

  // 持久化往返：新实例读到同一份（关窗不丢）
  const s2 = new SchedulerStore(root);
  assert.equal(s2.list().length, 1);
  assert.equal(s2.list()[0].lastStatus, "ok");

  const tg = s.toggle(t.id);
  assert.equal(tg.enabled, false);
  assert.equal(s.due(new Date()).length, 0, "停用后不再到期");
  assert.equal(s.remove(t.id), true);
  assert.equal(s.remove("nope"), false);
});
