// M2-03：通知投递 —— 提醒必达双通道（应用内卡 + 系统通知），通知失败不炸
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Kernel } from "../dist/main/kernel.js";

test("提醒必达：scan 触发通知+落卡；不重复；通知抛错不炸扫描", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-ntf-"));
  const kernel = new Kernel(root);
  const fired = [];
  kernel.setNotifier((title, body) => {
    fired.push({ title, body });
    if (title === "炸") throw new Error("通知服务挂了");
  });
  try {
    await kernel.init();
    const cards = [];
    kernel.onEvent((ev) => {
      if (ev.type === "card") cards.push(ev.card);
    });

    kernel.handle("calendar.add", { text: "两分钟前该站会" });
    kernel.handle("calendar.add", { text: "一小时前交报表" });

    kernel.handle("calendar.scan", {});
    assert.equal(fired.length, 2, "两条到期都发系统通知");
    assert.ok(cards.some((c) => c.badge === "提醒"), "应用内提醒卡必落");
    const before = fired.length;

    kernel.handle("calendar.scan", {});
    assert.equal(fired.length, before, "同一事件不重复提醒");

    // 通知失败不影响扫描（真实窗口场景 notifyOnce 也可能抛）
    kernel.handle("calendar.add", { text: "两分钟前炸一下" });
    kernel.handle("calendar.scan", {});
    assert.equal(fired.length, before + 1, "抛错的也调了（失败在内部记日志）");
    assert.ok(cards.some((c) => c.title === "炸一下"), "卡片照落——必达不依赖通知服务");
  } finally {
    await kernel.dispose();
  }
});

test("定时任务触发走同一条双通道", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-ntf2-"));
  const kernel = new Kernel(root);
  const fired = [];
  kernel.setNotifier((title) => fired.push(title));
  try {
    await kernel.init();
    const cards = [];
    kernel.onEvent((ev) => {
      if (ev.type === "card") cards.push(ev.card);
    });

    kernel.handle("schedule.add", { name: "每小时盘点", prompt: "盘点未完成事项", kind: "interval", intervalMin: 60 });
    kernel.handle("schedule.tick", {});
    assert.ok(fired.some((t) => t.includes("每小时盘点")), "系统通知已发");
    assert.ok(cards.some((c) => c.title?.includes("定时任务")), "应用内卡已落");
    // 单飞：锁在 turn 结束前释放（submitTurn 同步路径），再 tick 立即续跑下一轮间隔后才有 due
    const before = fired.length;
    kernel.handle("schedule.tick", {});
    assert.equal(fired.length, before, "刚跑过的 interval 不立即重复");
  } finally {
    await kernel.dispose();
  }
});
