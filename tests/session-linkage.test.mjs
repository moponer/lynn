// C3/C4/C5 工单↔会话缝合的回归点：
//  - 新会话必须在"还有单在跑"时点名并给停机动作（不能假装从头开始）
//  - 会话行的在办/已归档计数按 task.threadId 汇总，老单没记就不归到任何会话
//  - 会话累计用量按线程落盘，切回来读数还对得上（不是一刀清零）
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Kernel, newSessionNotice, countTasksByThread } from "../dist/main/kernel.js";
import { ThreadStore } from "../dist/main/threads.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lynn-link-"));

test("C4：新会话提示——没有在跑的单就不提停机；有就点名并给动作", () => {
  const quiet = newSessionNotice([]);
  assert.match(quiet.text, /新群已开始/);
  assert.equal(quiet.action, undefined, "没在跑的单不该冒出一个停机按钮");

  const busy = newSessionNotice(["WO-2418", "WO-2419"]);
  assert.match(busy.text, /2 张单在后台跑/);
  assert.match(busy.text, /WO-2418/);
  assert.match(busy.text, /WO-2419/);
  assert.equal(busy.action, "stopRunning");
});

test("C3：会话计数按 threadId 汇总，在办与已归档分开；无 threadId 不归任何会话", () => {
  const counts = countTasksByThread([
    { threadId: "th-a", status: "in_progress" },
    { threadId: "th-a", status: "in_review" },
    { threadId: "th-a", status: "done" },
    { threadId: "th-b", status: "canceled" },
    { status: "in_progress" },
  ]);
  assert.deepEqual(counts.get("th-a"), { active: 2, archived: 1 });
  assert.deepEqual(counts.get("th-b"), { active: 0, archived: 1 });
  assert.equal(counts.size, 2, "没记 threadId 的老单不该凭空归到某个会话");
});

test("C4：会话用量按线程保存/恢复（ThreadStore 层）", () => {
  const root = tmp();
  const s = new ThreadStore(root);
  const a = s.create("甲");
  s.saveState(a.id, { feed: [], history: [], usage: { sessionIn: 1200, sessionOut: 300, tokensUsed: 1500 } });
  assert.deepEqual(s.loadState(a.id).usage, { sessionIn: 1200, sessionOut: 300, tokensUsed: 1500 });
  const b = s.create("乙");
  assert.equal(s.loadState(b.id).usage, undefined, "新线程没有借用别人的读数");
});

test("版本握手：app.info 给出可解析的构建时间（前端据此判断内核新旧）", async () => {
  const root = tmp();
  const kernel = new Kernel(root);
  try {
    await kernel.init();
    const info = kernel.handle("app.info");
    assert.ok(info.buildAt, "必须给出构建时间，否则前端无法判断新旧");
    assert.ok(!Number.isNaN(Date.parse(info.buildAt)));
  } finally {
    await kernel.dispose();
  }
});

test("C4：切会话再切回来，顶栏用量跟着线程走；session.new 的卡不带假的停机按钮", async () => {
  const root = tmp();
  const kernel = new Kernel(root);
  try {
    await kernel.init();
    const first = kernel.handle("session.snapshot").thread.id;

    // 直接改运行态（测试里没有真模型调用）：模拟这一轮累计
    kernel.usage = { ...kernel.usage, sessionIn: 1200, sessionOut: 300 };
    kernel.tokensUsed = 1500;

    const created = kernel.handle("session.new");
    assert.equal(kernel.handle("session.snapshot").usage.sessionIn, 0, "新线程从 0 起，不继承甲会话的累计");

    const notice = kernel.handle("session.snapshot").feed.find((c) => (c.text ?? "").includes("新群已开始"));
    assert.ok(notice, "新会话有系统卡");
    assert.notEqual(notice.action, "stopRunning", "没有成员在跑就不该出现停机按钮");

    kernel.handle("thread.switch", { id: first });
    assert.equal(kernel.handle("session.snapshot").usage.sessionIn, 1200, "切回甲会话，读数恢复");
    assert.equal(kernel.handle("session.snapshot").board.tokensUsed, 1500);

    const stopped = kernel.handle("task.cancelAll");
    assert.deepEqual(stopped, { ok: true, stopped: 0 }, "没在跑的单就如实回 0，不假装停过");
    assert.ok(created.threadId);
  } finally {
    await kernel.dispose();
  }
});
