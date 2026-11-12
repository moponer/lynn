// 心跳巡检（M3-01）+ 主动工作闭环工具（save_memory / create_plugin_draft）：
//  - 机械层聚合事实：没事零 token；待审查/停滞工单/定时任务异常三类
//  - 同一批事实 30 分钟不重复注入；busy 跳过；判断权在风铃（prompt 只摆事实）
//  - 风铃能沉淀记忆（写进系统提示词）、能自开插件草稿（产物进草稿区永不自动生效）
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Kernel } from "../dist/main/kernel.js";
import { collectHeartbeatFacts, heartbeatSignature, heartbeatPrompt, heartbeatIsEmpty, capHeartbeatFacts } from "../dist/main/heartbeat.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lynn-hb-"));

// ---------- collectHeartbeatFacts 纯函数 ----------

test("事实聚合：in_review 进待审查；backlog/blocked/todo 进停滞；在跑与待拍板不算", () => {
  const facts = collectHeartbeatFacts({
    tasks: [
      { id: "r1", title: "已回报", status: "in_review", member: "林工" },
      { id: "s1", title: "blocked 单", status: "blocked" },
      { id: "s2", title: "backlog 单", status: "backlog" },
      { id: "p1", title: "等用户拍板", status: "todo" },
      { id: "g1", title: "在跑", status: "in_progress" },
      { id: "d1", title: "完结", status: "done" },
    ],
    runningTaskIds: ["g1"],
    pendingPlanTaskIds: ["p1"],
    schedules: [],
  });
  assert.deepEqual(facts.awaitingReview.map((t) => t.taskId), ["r1"]);
  assert.deepEqual(facts.stalledTasks.map((t) => t.taskId).sort(), ["s1", "s2"]);
});

test("定时任务：missed/stale/error 算异常；ok 与停用的不算", () => {
  const facts = collectHeartbeatFacts({
    tasks: [],
    runningTaskIds: [],
    pendingPlanTaskIds: [],
    schedules: [
      { id: "a", name: "日报", lastStatus: "missed" },
      { id: "b", name: "备份", lastStatus: "stale" },
      { id: "c", name: "抓取", lastStatus: "error" },
      { id: "d", name: "准点", lastStatus: "ok" },
      { id: "e", name: "停用", lastStatus: "missed", enabled: false },
    ],
  });
  assert.deepEqual(facts.scheduleIssues.map((s) => s.id).sort(), ["a", "b", "c"]);
});

test("签名：同一批事实键稳定；内容变了键就变；空事实 → isEmpty", () => {
  const f1 = collectHeartbeatFacts({ tasks: [{ id: "a", status: "blocked" }], runningTaskIds: [], pendingPlanTaskIds: [], schedules: [] });
  const f2 = collectHeartbeatFacts({ tasks: [{ id: "a", status: "blocked" }], runningTaskIds: [], pendingPlanTaskIds: [], schedules: [] });
  const f3 = collectHeartbeatFacts({ tasks: [{ id: "b", status: "blocked" }], runningTaskIds: [], pendingPlanTaskIds: [], schedules: [] });
  assert.equal(heartbeatSignature(f1), heartbeatSignature(f2));
  assert.notEqual(heartbeatSignature(f1), heartbeatSignature(f3));
  assert.ok(!heartbeatIsEmpty(f1));
  assert.ok(heartbeatIsEmpty(collectHeartbeatFacts({ tasks: [], runningTaskIds: [], pendingPlanTaskIds: [], schedules: [] })));
});

test("巡检简报：只摆事实 + 处置参考，判断权在风铃（不写死动作）", () => {
  const facts = collectHeartbeatFacts({
    tasks: [{ id: "w1", title: "周报", status: "in_review", member: "林工" }],
    runningTaskIds: [],
    pendingPlanTaskIds: [],
    schedules: [{ id: "c", name: "日报", lastStatus: "missed" }],
  });
  const prompt = heartbeatPrompt(facts);
  assert.match(prompt, /【心跳巡检】/);
  assert.match(prompt, /w1「周报」/);
  assert.match(prompt, /日报（missed）/);
  assert.match(prompt, /处置参考/);
  assert.match(prompt, /不要编造工作/);
});

test("堆积闸裁剪：只给一批（待审优先），其余只报数；不超限则原样返回", () => {
  const facts = collectHeartbeatFacts({
    tasks: [
      { id: "r1", status: "in_review" },
      { id: "r2", status: "in_review" },
      { id: "r3", status: "in_review" },
      { id: "s1", status: "blocked" },
      { id: "s2", status: "blocked" },
      { id: "s3", status: "blocked" },
      { id: "s4", status: "blocked" },
    ],
    runningTaskIds: [],
    pendingPlanTaskIds: [],
    schedules: [],
  });
  // 限额 3：先塞满待审（验收最快降堆积），停滞单让位到下一轮
  const capped = capHeartbeatFacts(facts, 3);
  assert.deepEqual(capped.facts.awaitingReview.map((t) => t.taskId), ["r1", "r2", "r3"]);
  assert.equal(capped.facts.stalledTasks.length, 0);
  assert.equal(capped.dropped, 4);
  // 待审不够则用停滞补位
  const mixed = capHeartbeatFacts(facts, 5);
  assert.equal(mixed.facts.awaitingReview.length, 3);
  assert.equal(mixed.facts.stalledTasks.length, 2);
  assert.equal(mixed.dropped, 2);
  // 未超限：整份给，不丢
  const whole = capHeartbeatFacts(facts, 10);
  assert.equal(whole.dropped, 0);
  assert.equal(whole.facts.stalledTasks.length, 4);
  // 裁过的简报仍只列这批，不泄露全表
  const prompt = heartbeatPrompt(capped.facts);
  assert.match(prompt, /r1/);
  assert.doesNotMatch(prompt, /s4/);
});

test("孤儿执行单：in_progress 但没人在跑也进心跳，且排在停滞之前", () => {
  const facts = collectHeartbeatFacts({
    tasks: [
      { id: "o1", title: "执行中没人跟", status: "in_progress" },
      { id: "g1", title: "在跑", status: "in_progress" },
      { id: "s1", title: "卡住", status: "blocked" },
    ],
    runningTaskIds: ["g1"],
    pendingPlanTaskIds: [],
    schedules: [],
  });
  assert.deepEqual(facts.orphanTasks.map((t) => t.taskId), ["o1"]);
  assert.ok(!facts.orphanTasks.some((t) => t.taskId === "g1"), "还在跑的不算孤儿");
  const prompt = heartbeatPrompt(facts);
  assert.match(prompt, /状态在跑但没人跟/);
  const capped = capHeartbeatFacts(facts, 1);
  assert.deepEqual(capped.facts.orphanTasks.map((t) => t.taskId), ["o1"], "待审为空时先给孤儿单");
  assert.equal(capped.facts.stalledTasks.length, 0);
});

// ---------- kernel 集成：有事才注入、同批去重 ----------

function seedKernel(root) {
  fs.writeFileSync(
    path.join(root, "settings.json"),
    JSON.stringify({
      model: { provider: "t", baseUrl: "http://127.0.0.1:9/v1", model: "m", apiKey: { encrypted: false, data: "k" }, updatedAt: new Date().toISOString() },
      prefs: { heartbeat: true },
    }),
    "utf-8",
  );
  return new Kernel(root);
}

const until = async (fn, ms, what) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`等待超时：${what}`);
};

// 巡检轮是 ephemeral（结束后从 history 摘掉），所以用内核的注入计数来观测，
// 不再数 history 里的消息条数。
const heartbeatTurns = (kernel) => kernel.heartbeatRunCount();

test("心跳：有停滞工单才起巡检轮；同批事实 30 分钟内不重复；没事零注入", async () => {
  const root = tmp();
  const kernel = seedKernel(root);
  try {
    await kernel.init();
    kernel.taskStore.create({ id: "wo-9", title: "卡住的审查单", teamId: "t1", member: "林工" });
    kernel.taskStore.transition("wo-9", "blocked");

    // 间隔闸：刚 init 完（lastHeartbeatAt=now）先静默一个间隔 → 不注入
    kernel.heartbeatTick();
    assert.equal(heartbeatTurns(kernel), 0, "间隔内不注入");

    // 放行间隔闸 → 有事：注入一轮心跳巡检（卡上看得见事实，prompt 进 history）
    kernel.lastHeartbeatAt = 0;
    kernel.heartbeatTick();
    const feed = kernel.handle("session.snapshot").feed.map((c) => c.text ?? "").join("\n");
    assert.match(feed, /心跳巡检（停滞 wo-9「卡住的审查单」（blocked））/);
    assert.equal(heartbeatTurns(kernel), 1, "巡检 prompt 应进入对话历史");
    assert.ok(kernel.heartbeatNoted.size === 1, "同批事实已登记去重");

    // 等这轮（注定失败的）模型调用收尾，busy 回落，再验证去重闸
    // 真实 Pi worker 冷启动 + 失败重试在并行测试负载下会超过 8s：给到 20s，
    // 断言的是"最终会收尾"，不是"多快收尾"。
    await until(() => !kernel.busy, 20000, "巡检轮收尾");
    kernel.lastHeartbeatAt = 0;
    kernel.heartbeatTick();
    assert.equal(heartbeatTurns(kernel), 1, "同批事实 30 分钟内不重复注入");

    // 事实消失（工单被处置掉）→ 再 tick 无事零注入
    kernel.taskStore.transition("wo-9", "canceled");
    kernel.heartbeatNoted.clear();
    kernel.lastHeartbeatAt = 0;
    kernel.heartbeatTick();
    assert.equal(heartbeatTurns(kernel), 1, "没事零 token");
  } finally {
    await kernel.dispose();
  }
});

test("堆积闸：不再整轮跳过——一轮只交一批真去清，同一堆积量不重复刷屏", async () => {
  const root = tmp();
  const kernel = seedKernel(root);
  const feedText = () => kernel.handle("session.snapshot").feed.map((c) => c.text ?? "").join("\n");
  try {
    await kernel.init();
    // 8 张单：4 待审 + 4 停滞（正是用户截图里那个规模）
    for (let i = 1; i <= 4; i++) {
      kernel.taskStore.create({ id: `r${i}`, title: `待审 ${i}`, teamId: "t1" });
      kernel.taskStore.transition(`r${i}`, "todo");
      kernel.taskStore.transition(`r${i}`, "in_progress");
      kernel.taskStore.transition(`r${i}`, "in_review");
    }
    for (let i = 1; i <= 4; i++) {
      kernel.taskStore.create({ id: `s${i}`, title: `停滞 ${i}`, teamId: "t1" });
      kernel.taskStore.transition(`s${i}`, "blocked");
    }

    kernel.lastHeartbeatAt = 0;
    kernel.heartbeatTick();
    assert.equal(heartbeatTurns(kernel), 1, "堆积超限也必须真清一轮，不能整轮跳过");
    const prompt = String(kernel.history.filter((h) => h.role === "user").pop().content);
    assert.match(prompt, /只清一批/);
    assert.equal((prompt.match(/「待审 /g) ?? []).length, 3, "一轮只交 3 张");
    assert.doesNotMatch(prompt, /停滞 \d/, "超出一批的单不塞进上下文");
    let feed = feedText();
    assert.match(feed, /有 8 张单堆着/);
    assert.doesNotMatch(feed, /已跳过本轮自动巡检/, "不再吐「我跳过了」这种内务话");

    // 同一堆积量：清不动时按 5 分钟间隔节流，且卡不重复（用户看到的就是这条在刷屏）
    await until(() => !kernel.busy, 20000, "首轮收尾");
    kernel.lastHeartbeatAt = 0;
    kernel.heartbeatTick();
    assert.equal(heartbeatTurns(kernel), 1, "间隔内不再注入");

    // 过了间隔仍没清掉 → 会再试一次，但退避到 10 分钟；卡不再重复
    await until(() => !kernel.busy, 20000, "节流轮收尾");
    kernel.lastHeartbeatAt = 0;
    kernel.backlogGate.at = Date.now() - 6 * 60_000;
    kernel.heartbeatTick();
    assert.equal(heartbeatTurns(kernel), 2, "清不动也要再试");
    assert.equal(kernel.backlogGate.waitMin, 10, "没清动 → 间隔翻倍");
    assert.equal((feedText().match(/有 8 张单堆着/g) ?? []).length, 1, "同一堆积量只提示一次");

    // 清掉一张 → 恢复常速（退避清零）
    await until(() => !kernel.busy, 20000, "退避轮收尾");
    kernel.taskStore.transition("r1", "canceled");
    kernel.lastHeartbeatAt = 0;
    kernel.backlogGate.at = Date.now() - 11 * 60_000;
    kernel.heartbeatTick();
    assert.equal(kernel.backlogGate.waitMin, 0, "清动了立刻恢复常速");
    assert.match(feedText(), /有 7 张单堆着/, "堆积量变了才再说一句");
  } finally {
    await kernel.dispose();
  }
});

// ---------- 主动工作闭环工具 ----------

test("save_memory：追加进助理记忆并热同步；scope=user 写用户记忆；空 entry 拒", async () => {
  const root = tmp();
  const kernel = seedKernel(root);
  try {
    await kernel.init();
    const r1 = kernel.runTool("save_memory", { entry: "周报任务的材料固定在工作区 orders.csv" });
    assert.match(r1, /已写入助理记忆/);
    const r2 = kernel.runTool("save_memory", { entry: "用户喜欢简洁的汇报", scope: "user" });
    assert.match(r2, /已写入用户记忆/);
    const mem = kernel.memory.load("memory");
    assert.match(mem, /orders\.csv/);
    assert.match(mem, /^\- \d{4}-\d{2}-\d{2} \d{2}:\d{2} /m, "带时间戳");
    assert.match(kernel.memory.load("user"), /简洁的汇报/);
    const empty = kernel.runTool("save_memory", { entry: "  " });
    assert.match(empty, /entry 不能为空/);
    const again = kernel.runTool("save_memory", { entry: "第二条" });
    assert.match(again, /已写入助理记忆/);
    assert.ok(kernel.memory.load("memory").includes("orders.csv"), "追加不覆盖");
  } finally {
    await kernel.dispose();
  }
});

test("create_plugin_draft：开草稿返回 draftDir；产物区存在；spec 缺失如实拒", async () => {
  const root = tmp();
  const kernel = seedKernel(root);
  try {
    await kernel.init();
    const bad = kernel.runTool("create_plugin_draft", { title: "x", kind: "L1", spec: " " });
    assert.match(bad, /title 与 spec 都必填/);
    const out = kernel.runTool("create_plugin_draft", {
      title: "周报图表卡",
      kind: "L0",
      spec: "解决什么：周报数据渲染成静态卡片\n输入输出：CSV → 卡槽 HTML\n边界：不写代码\n验收用例：spec 用例可走通",
    });
    const parsed = JSON.parse(out);
    assert.match(parsed.draftId, /^d-/);
    assert.ok(fs.existsSync(path.join(parsed.draftDir, "spec.md")), "规格落盘");
    assert.ok(fs.existsSync(parsed.draftDir), "草稿目录已建（派单 workspace 校验能通过）");
    assert.match(parsed.next, /ship_plugin/);
    assert.match(parsed.next, /workspace/);
  } finally {
    await kernel.dispose();
  }
});
