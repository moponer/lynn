// M2-01：本地日历 —— 自然语言解析、存储、提醒判定、RPC 闭环
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseNaturalDate, dueReminders } from "../dist/main/calendar.js";
import { Kernel } from "../dist/main/kernel.js";

const AT = new Date(2026, 10, 2, 10, 30, 0); // 2026-11-02 周一 10:30
const day = (y, m, d, h = 9, mi = 0) => new Date(y, m - 1, d, h, mi).toISOString();
const h = (iso) => new Date(iso).getHours();
const min = (iso) => new Date(iso).getMinutes();

test("parseNaturalDate：相对/今天明天/周几/日期/时刻 全覆盖", () => {
  let r = parseNaturalDate("两小时后交周报", AT);
  assert.equal(new Date(r.at).getTime(), AT.getTime() + 7_200_000);
  assert.equal(r.rest, "交周报");

  r = parseNaturalDate("明天下午三点整理周报", AT);
  assert.deepEqual([new Date(r.at).getDate(), h(r.at), min(r.at)], [3, 15, 0]);
  assert.equal(r.rest, "整理周报");

  r = parseNaturalDate("明天上午9点半站会", AT);
  assert.deepEqual([new Date(r.at).getDate(), h(r.at), min(r.at)], [3, 9, 30]);

  r = parseNaturalDate("下周三下午两点评审", AT); // 2026-11-02 周一 → 下周三 = 11-11
  assert.deepEqual([new Date(r.at).getDate(), h(r.at)], [11, 14]);

  r = parseNaturalDate("周三晚上8点健身", AT); // 裸周几 = 未来最近（11-04）
  assert.deepEqual([new Date(r.at).getDate(), h(r.at)], [4, 20]);

  r = parseNaturalDate("3月5号上午九点体检", AT);
  assert.deepEqual([new Date(r.at).getMonth() + 1, new Date(r.at).getDate(), h(r.at)], [3, 5, 9]);

  r = parseNaturalDate("周五复盘", AT); // 无时刻 → 默认 09:00 并注明
  assert.deepEqual([new Date(r.at).getDate(), h(r.at)], [6, 9]);
  assert.equal(r.defaultedTime, true);

  r = parseNaturalDate("大后天 14:00 发版", AT);
  assert.deepEqual([new Date(r.at).getDate(), h(r.at), min(r.at)], [5, 14, 0]);

  assert.equal(parseNaturalDate("随便聊聊", AT), null, "识别不了如实返回 null");
  assert.equal(parseNaturalDate("", AT), null);
});

test("dueReminders：到期/提前量/已提醒/已完成 的判定", () => {
  const now = new Date(2026, 10, 2, 10, 0, 0);
  const mk = (id, at, lead = 0, notified = 0, status = "open") => ({ id, title: `e${id}`, at, remindLead: lead, notified, status, createdAt: at });
  const events = [
    mk(1, day(2026, 11, 2, 9, 50)),                       // 已到点 → 提醒
    mk(2, day(2026, 11, 2, 10, 5), 10),                   // 10:05 提前 10 分钟 → 现在就该提
    mk(3, day(2026, 11, 2, 11, 0)),                       // 还没到
    mk(4, day(2026, 11, 2, 9, 0), 0, 1),                  // 已提醒过
    mk(5, day(2026, 11, 2, 9, 0), 0, 0, "done"),          // 已完成
  ];
  const due = dueReminders(events, now);
  assert.deepEqual(due.map((e) => e.id), [1, 2]);
});

test("Kernel：calendar.* RPC 闭环；解析不了如实报错；提醒落卡", async () => {
  const kernel = new Kernel((await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "lynn-cal-")));
  try {
    await kernel.init();
    const cards = [];
    kernel.onEvent((ev) => {
      if (ev.type === "card") cards.push(ev.card);
    });

    const r1 = kernel.handle("calendar.add", { text: "明天下午三点整理周报" });
    assert.equal(r1.ok, true);
    assert.equal(r1.event.title, "整理周报");
    assert.ok(r1.matched.includes("明天"));

    const bad = kernel.handle("calendar.add", { text: "下周某天再说" });
    assert.equal(bad.ok, false);
    assert.ok(bad.error.includes("没识别出时间"));

    const list = kernel.handle("calendar.list", {});
    assert.equal(list.events.length, 1);
    assert.ok(["sqlite", "json"].includes(list.backend), "backend 如实标注");

    // 到点 → 扫描落"提醒"卡，且不重复
    const past = kernel.handle("calendar.add", { text: "两小时前就该开会" });
    assert.equal(past.ok, true);
    kernel.handle("calendar.finish", { id: past.event.id });
    const ev2 = kernel.handle("calendar.add", { text: "两分钟前该站会" });
    assert.ok(new Date(ev2.event.at) < new Date(), "过去时刻允许录入，提醒扫描会立即触发");

    const todo = kernel.handle("calendar.todo.add", { text: "买打印机墨" });
    assert.equal(kernel.handle("calendar.todo.list", {}).todos.length, 1);
    kernel.handle("calendar.todo.finish", { id: todo.id });
    assert.equal(kernel.handle("calendar.todo.list", {}).todos.length, 0);
  } finally {
    await kernel.dispose();
  }
});
