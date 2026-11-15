// 语音播报（2026-11-13）：只念值得听的，且配置真落盘、关开关真静音
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Kernel } from "../dist/main/kernel.js";
import {
  VOICE_DEFAULT_PREFS,
  VOICE_OPTIONS,
  VOICE_GATE_INITIAL,
  normalizeVoicePrefs,
  isValidVoiceId,
  isProsody,
  cleanSpeechText,
  isMeaningfulSpeech,
  pickCardSpeech,
  pickReplySpeech,
  gateSpeech,
} from "../dist/main/voice-policy.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lynn-voice-"));
const prefs = (patch = {}) => normalizeVoicePrefs({ ...VOICE_DEFAULT_PREFS, ...patch });

test("默认音色是晓晓；非法配置与旧档位收敛，音色 ID 不许塞 SSML 字符", () => {
  const p = prefs();
  assert.equal(p.voiceId, "zh-CN-XiaoxiaoNeural");
  assert.equal(p.voiceScope, "brief");
  assert.equal(p.voiceWhenHidden, false);
  assert.ok(VOICE_OPTIONS.some((v) => v.id === p.voiceId));

  const bad = normalizeVoicePrefs({
    voiceId: "zh-CN-XiaoxiaoNeural\"><voice/>",
    voiceRate: "fast",
    voiceVolume: "200%",
    voiceScope: "everything",
    voiceMaxChars: 99999,
  });
  assert.equal(bad.voiceId, p.voiceId);
  assert.equal(bad.voiceRate, "+0%");
  assert.equal(bad.voiceVolume, "+0%");
  assert.equal(bad.voiceScope, "brief");
  assert.equal(bad.voiceMaxChars, 300);
  // 上一版三档（key/all/alerts）读旧 settings.json 不能炸，统一回落简洁
  for (const old of ["key", "all", "alerts"]) {
    assert.equal(normalizeVoicePrefs({ voiceScope: old }).voiceScope, "brief");
  }
  assert.equal(normalizeVoicePrefs({ voiceScope: "detail" }).voiceScope, "detail");
  assert.equal(isValidVoiceId("zh-CN-YunxiNeural"), true);
  assert.equal(isValidVoiceId("a b"), false);
  assert.equal(isProsody("+10%"), true);
  assert.equal(isProsody("+10%;alert(1)"), false);
});

test("文本清洗：代码块 / 链接 / 路径 / 段标签都不进耳朵，超长截到句子边界", () => {
  const raw = [
    "**结论**：三张订单核对完成。",
    "```bash\nnpm test -- --grep 404\n```",
    "证据：[核对表](https://example.com/a.md) 与 C:\\work\\tasks\\WO-2418\\out.csv",
    "待你拍板：要不要把这张单归档？",
    "未完成：无",
  ].join("\n");
  const s = cleanSpeechText(raw, 120);
  assert.ok(s.includes("三张订单核对完成"));
  assert.ok(s.includes("要不要把这张单归档"));
  assert.ok(!s.includes("npm test"), "代码块不能念");
  assert.ok(!s.includes("https://"), "链接不能念");
  assert.ok(!s.includes("C:\\"), "路径不能念");
  assert.ok(!s.includes("证据："), "段标签不念");
  assert.ok(!s.includes("未完成"), "未完成段不念");

  const long = "第一句话已经说完。第二句话也已经说完。第三句话说到一半被截断";
  assert.equal(cleanSpeechText(long, 20), "第一句话已经说完。第二句话也已经说完。");
  const cleaned = cleanSpeechText("## 标题\n\n| --- | --- |\n\n`code`", 50);
  assert.ok(cleaned.includes("标题") && cleaned.includes("code"));
  assert.ok(!cleaned.includes("|"), "表格骨架不念");
  assert.ok(!/[，。；、]\s*[，。；、]/.test(cleaned), "不留连续空停顿");
});

test("有效性：客套话、工具回执、纯符号一律不播", () => {
  assert.equal(isMeaningfulSpeech("好的。"), false);
  assert.equal(isMeaningfulSpeech("汇报已呈给用户。"), false);
  assert.equal(isMeaningfulSpeech("已完成"), false);
  assert.equal(isMeaningfulSpeech("……"), false);
  assert.equal(isMeaningfulSpeech("WO-2418"), false);
  assert.equal(isMeaningfulSpeech("三张订单已核对完成，等你审查。"), true);
});

test("汇报卡：只播结论与待拍板，证据和未完成留在界面上", () => {
  const card = {
    kind: "tool",
    badge: "汇报",
    title: "WO-2418 · 汇报",
    report: {
      conclusion: "三张订单金额全部核对一致。",
      evidence: "orders.csv、recheck.log",
      unfinished: "还没导出汇总表",
      decision: "请确认是否归档。",
    },
  };
  const got = pickCardSpeech(card, prefs());
  assert.ok(got);
  assert.equal(got.priority, "high");
  assert.equal(got.reason, "report");
  assert.ok(got.text.includes("三张订单金额全部核对一致"));
  assert.ok(got.text.includes("请确认是否归档"));
  assert.ok(!got.text.includes("orders.csv"), "证据不念");
  assert.ok(!got.text.includes("导出汇总表"), "未完成段不念");
});

test("系统兜底汇报（没有 report 字段）也能从「结论：」行抽出结论", () => {
  const got = pickCardSpeech({
    kind: "tool",
    badge: "汇报",
    title: "系统汇总 · Q3 订单核对",
    body: "结论：Q3 订单已验收归档。\n交付物：report.xlsx\n未完成：（她没有单独写汇报）",
  }, prefs());
  assert.ok(got);
  assert.ok(got.text.includes("Q3 订单已验收归档"));
  assert.ok(!got.text.includes("report.xlsx"), "文件名不念");
});

test("需要你拍板：问句照播；只有工单 ID 的契约卡改成人话，不念 ID", () => {
  const q = pickCardSpeech({ kind: "tool", badge: "需要你拍板", title: "对账口径用含税还是不含税？", body: "两份材料口径不一致。" }, prefs());
  assert.ok(q);
  assert.equal(q.priority, "high");
  assert.ok(q.text.includes("含税还是不含税"));

  const plan = pickCardSpeech({ kind: "tool", badge: "需要你拍板", title: "待你确认 · WO-2418", body: "简报很长，控制台里有。" }, prefs());
  assert.ok(plan);
  assert.ok(!plan.text.includes("WO-2418"), "工单 ID 不念");
  assert.ok(plan.text.includes("等你拍板"));
});

test("成员回报与进度里程碑改写成短句，不念回报正文和步骤明细", () => {
  const delivery = pickCardSpeech({
    kind: "tool", badge: "回报", title: "阿明 回报 · WO-2418",
    body: "第一步读了材料，第二步复算了金额，第三步写了表格，全文一千五百字……",
  }, prefs());
  assert.equal(delivery.text, "阿明交回了结果，等我验收。");

  const progress = pickCardSpeech({
    kind: "tool", badge: "进度", title: "阿明 第 3 步 · WO-2418", body: "读材料\n复算\n写表格",
  }, prefs());
  assert.equal(progress.text, "阿明已推进到第 3 步。");
});

test("简洁档也播任务进度：派单开工、里程碑、卡住与无交付物关单（2026-11-15）", () => {
  const brief = prefs();

  // 开工：默认档就要听见「派给谁了」，否则第一条进度永远是"交回了结果"
  const dispatch = pickCardSpeech(
    { kind: "tool", badge: "派单", title: "阿明 开工 · task-20261115-a1b2c3", meta: "工具：read_file" },
    brief,
  );
  assert.ok(dispatch);
  assert.equal(dispatch.text, "我已把任务派给阿明，开始处理。");
  assert.notEqual(dispatch.priority, "high", "开工不打断汇报");

  const milestone = pickCardSpeech(
    { kind: "tool", badge: "进度", title: "阿计 第 2 步 · task-20261115-a1b2c3", meta: "已用时 132s" },
    brief,
  );
  assert.equal(milestone.text, "阿计已推进到第 2 步。");

  // 卡住是 system + 进度：此前被 systemAllowed 整类拦掉——开着语音也听不到任务停了
  const stuck = pickCardSpeech(
    { kind: "system", badge: "进度", text: "task-20261115-a1b2c3 卡住了（连续两个节点没交新证据）。我会自己判断：重做 / 换策略 / 关单。" },
    brief,
  );
  assert.ok(stuck, "卡住必须播");
  assert.ok(stuck.text.includes("卡住"));
  assert.ok(!stuck.text.includes("task-"), "任务号不念");

  const empty = pickCardSpeech(
    { kind: "system", badge: "进度", text: "未完成：task-20261115-a1b2c3 没有任何交付物，已关单（卷宗保留）。" },
    brief,
  );
  assert.ok(empty, "没交付物关单必须播");
  assert.ok(empty.text.includes("没交出交付物"));

  // 其余 system 内务仍然闭嘴：压缩、心跳（详细档才念）、停止
  assert.equal(pickCardSpeech({ kind: "system", badge: "心跳", text: "巡检发现 8 张单待处理" }, brief), null);
  assert.equal(pickCardSpeech({ kind: "system", text: "上下文接近上限，正在压缩" }, brief), null);
  assert.equal(pickCardSpeech({ kind: "system", text: "已停止本轮（已产出的内容保留）。" }, brief), null);
});

test("简洁档：提醒照播；过程明细、系统内务、用户卡、内部巡检只留在界面上", () => {
  const reminder = pickCardSpeech({ kind: "system", badge: "提醒", title: "定时任务 · 日报", meta: "该交日报了" }, prefs());
  assert.ok(reminder);
  assert.ok(reminder.text.includes("该交日报了"));

  const silent = [
    { kind: "user", text: "帮我核对订单" },
    { kind: "lynn", text: "", streaming: true },
    { kind: "tool", badge: "组队", title: "已建团队" },
    { kind: "tool", badge: "工具", title: "read_file", body: "a.json" },
    { kind: "tool", badge: "已拦截", title: "rm -rf" },
    { kind: "tool", badge: "记忆", title: "已沉淀记忆" },
    { kind: "tool", badge: "心跳", title: "心跳巡检", body: "8 张单堆着" },
    { kind: "system", text: "上下文接近上限，正在压缩" },
    { kind: "system", text: "已停止本轮（已产出的内容保留）。" },
  ];
  for (const card of silent) {
    assert.equal(pickCardSpeech(card, prefs()), null, `${card.badge ?? card.kind} 不该播：${card.title ?? card.text}`);
  }
});

test("两档切换：简洁只念结论；详细加念她的分析，internal 巡检轮永远不念", () => {
  const text = "三张订单都已核对完成，金额一致，可以归档了。";
  assert.equal(pickReplySpeech(text, prefs(), false), null, "简洁档不念正文");
  assert.equal(pickReplySpeech(text, prefs({ voiceScope: "detail" }), true), null, "巡检轮不念");
  const got = pickReplySpeech(text, prefs({ voiceScope: "detail" }), false);
  assert.ok(got);
  assert.equal(got.reason, "reply");
  assert.equal(pickReplySpeech("好的，我来看一下。", prefs({ voiceScope: "detail" }), false), null, "纯开场白不念");
  // 两档都保留结论类播报（这是简洁档的全部内容）
  assert.ok(pickCardSpeech({ kind: "tool", badge: "汇报", report: { conclusion: "三张订单核对完成。" } }, prefs()));
  assert.ok(pickCardSpeech({ kind: "tool", badge: "汇报", report: { conclusion: "三张订单核对完成。" } }, prefs({ voiceScope: "detail" })));
});

test("详细档：过程卡改写成中文短句，命令 / 路径 / 工单号 / 思考一律不念", () => {
  const brief = prefs();
  const detailed = prefs({ voiceScope: "detail" });
  const cases = [
    [{ kind: "tool", badge: "组队", title: "招募 阿明 · 数据整理", body: "目标：核对 Q3\n边界：只读" }, "我已组建小组，阿明负责数据整理。"],
    [{ kind: "tool", badge: "派单", title: "阿明 开工 · WO-2418", body: "工作区：C:\\work\\tasks\\WO-2418\n只读授权：D:\\data" }, "我已把任务派给阿明，开始处理。"],
    [{ kind: "tool", badge: "工具", title: "技能激活 · 订单核对" }, "技能激活，订单核对。"],
    [{ kind: "tool", badge: "出站", title: "阿明 · WO-2418", body: "出站命令已审计：curl https://x" }, "有一次外部请求已审计。"],
    [{ kind: "tool", badge: "放行", title: "阿明 · WO-2418", body: "删除类命令自动放行：rm -rf /tmp/x" }, "低风险操作已自动放行。"],
    [{ kind: "tool", badge: "已拦截", title: "阿明 · WO-2418", body: "命令被纵深防御规则拦下：rm -rf /" }, "有一条命令被拦下，详情看卡片。"],
    [{ kind: "tool", badge: "记忆", title: "已沉淀记忆", text: "已沉淀到助理记忆：用户偏好喝咖啡" }, "我记下了一件事。"],
    [{ kind: "tool", badge: "已停止", title: "阿明 已停止 · WO-2418", body: "用户中止" }, "阿明已停止。"],
    [{ kind: "system", badge: "心跳", text: "有 8 张单堆着（待审 3 / 停滞 5）。WO-2418、WO-2419" }, "巡检发现 8 张单待处理，我已开始跟进。"],
  ];
  for (const [card, expected] of cases) {
    const got = pickCardSpeech(card, detailed);
    assert.ok(got, `详细档要播 ${card.badge}`);
    assert.equal(got.text, expected);
    assert.notEqual(got.priority, "high", "过程卡不打断汇报");
    assert.ok(!got.text.includes("WO-2418") && !got.text.includes("rm -rf") && !got.text.includes("C:\\"), "不能念 ID / 命令 / 路径");
    // 简洁档仍不念过程明细；只有「派单」因为是任务进度的起点被放行（见下一条用例）
    if (card.badge !== "派单") assert.equal(pickCardSpeech(card, brief), null, `简洁档不念 ${card.badge}`);
  }
  // 英文工具名 / 插件 ID / 系统内务 / 用户卡 / 思考：详细档也不念
  for (const card of [
    { kind: "tool", badge: "工具", title: "read_file 失败", body: "ENOENT" },
    { kind: "tool", badge: "工具", title: "L1 插件 · lynn.tool.dice" },
    { kind: "system", text: "上下文接近上限，正在压缩" },
    { kind: "system", text: "已停止本轮（已产出的内容保留）。" },
    { kind: "user", text: "帮我核对订单" },
    { kind: "lynn", text: "", streaming: true, thinking: "内部推理一大段" },
  ]) {
    assert.equal(pickCardSpeech(card, detailed), null, `详细档也不该播：${card.title ?? card.text}`);
  }
});

test("播报是她本人在说话：模板一律第一人称，不出现「她 / 风铃」旁白口吻", () => {
  const detailed = prefs({ voiceScope: "detail" });
  const samples = [
    { kind: "tool", badge: "组队", title: "招募 阿明 · 数据整理" },
    { kind: "tool", badge: "派单", title: "阿明 开工 · WO-2418" },
    { kind: "tool", badge: "记忆", title: "已沉淀记忆" },
    { kind: "tool", badge: "回报", title: "阿明 回报 · WO-2418" },
    { kind: "system", badge: "心跳", text: "有 8 张单堆着" },
    { kind: "tool", badge: "需要你拍板", title: "待你确认 · WO-2418" },
    { kind: "tool", badge: "已拦截", title: "阿明 · WO-2418", body: "rm -rf /" },
    { kind: "system", badge: "提醒", title: "定时任务 · 日报", meta: "该交日报了" },
  ];
  for (const card of samples) {
    const got = pickCardSpeech(card, detailed);
    assert.ok(got, `${card.badge} 该有播报`);
    assert.ok(!/她|风铃/.test(got.text), `${card.badge} 不该用第三人称：${got.text}`);
  }
  assert.ok(pickCardSpeech({ kind: "tool", badge: "回报", title: "阿明 回报 · WO-2418" }, detailed).text.includes("等我验收"));
  assert.ok(pickCardSpeech({ kind: "system", badge: "心跳", text: "有 8 张单堆着" }, detailed).text.includes("我已开始跟进"));
  // 简洁档同样适用：回报卡是两档共用的
  assert.ok(pickCardSpeech({ kind: "tool", badge: "回报", title: "阿明 回报 · WO-2418" }, prefs()).text.includes("我"));
});

test("播报不念工单号：真单号是 base36（task-mf3k9x2a-1），剥完只剩人名就不播（2026-11-15 实机投诉）", () => {
  const brief = prefs();
  // 里程碑仍要播，但一个字符的工单号都不许进耳朵
  const step = pickCardSpeech({ kind: "tool", badge: "进度", title: "阿计 第 3 步 · task-mf3k9x2a-1" }, brief);
  assert.equal(step.text, "阿计已推进到第 3 步。");
  assert.ok(!/task-/.test(step.text));

  // 旧版把「阿计 · task-…」念成一声「阿计」——那不是进度，是噪音
  assert.equal(
    pickCardSpeech({ kind: "tool", badge: "进度", title: "阿计 · task-mf3k9x2a-1", text: "阿计 · task-mf3k9x2a-1" }, brief),
    null,
  );

  // 审查卡旧版会把标题+正文首句整段念出来（"验收通过 · 阿计，阿计 回报 · task-… 交付了 report."）
  assert.equal(pickCardSpeech({ kind: "tool", badge: "审查", title: "验收通过 · 阿计", body: "@阿计" }, brief), null);
  const rejected = pickCardSpeech(
    { kind: "tool", badge: "审查", title: "打回 · 阿计", body: "@阿计\n不合格：金额单位没统一\n期望：统一成万元" },
    brief,
  );
  assert.equal(rejected.text, "阿计这单被打回了：金额单位没统一。");
});

test("回报要说得清结果如何：完成 / 有保留 / 受阻 / 缺材料（四种收尾口径）", () => {
  const brief = prefs();
  const cases = [
    ["【完成】三张订单核对完了。", "阿计交回了结果，说已经做完，等我验收。"],
    ["【完成有保留】汇总表还没导出。", "阿计交回了结果，说有几处没做到，等我验收。"],
    ["【受阻】orders.csv 读不出来。", "阿计做不下去，报了受阻，我去看卡在哪。"],
    ["【缺上下文】没拿到口径文档。", "阿计说材料不够，没往下做，我去补齐。"],
  ];
  for (const [body, expected] of cases) {
    const got = pickCardSpeech({ kind: "tool", badge: "回报", title: "阿计 · task-mf3k9x2a-1", body }, brief);
    assert.equal(got.text, expected);
  }
  // 交付待补充不是一次正常回报：说的是缺什么，不能念成"交付待补充交回了结果"
  const pending = pickCardSpeech({ kind: "tool", badge: "回报", title: "交付待补充 · 阿计 · task-mf3k9x2a-1" }, brief);
  assert.equal(pending.text, "阿计交的东西还差核验记录，我让他补上。");
});

test("落卡时写的 speak 优先：开工说清做什么，完成说清哪件事完了；写坏了就回落", () => {
  const brief = prefs();
  const dispatch = pickCardSpeech(
    { kind: "tool", badge: "派单", title: "阿计 开工 · task-mf3k9x2a-1", speak: "我把「Q3 订单核对」交给阿计了，他开始做。" },
    brief,
  );
  assert.equal(dispatch.text, "我把「Q3 订单核对」交给阿计了，他开始做。");
  // speak 只有人名（等于没说）→ 不采信，回落到按字段推导的句子
  const bad = pickCardSpeech(
    { kind: "tool", badge: "派单", title: "阿计 开工 · task-mf3k9x2a-1", speak: "阿计。" },
    brief,
  );
  assert.equal(bad.text, "我已把任务派给阿计，开始处理。");
  const done = pickCardSpeech(
    { kind: "tool", badge: "汇报", title: "系统汇总 · Q3 订单核对", speak: "「Q3 订单核对」做完了，阿计交的活我已经验收归档。" },
    brief,
  );
  assert.equal(done.reason, "report");
  assert.ok(done.text.includes("Q3 订单核对"));
});

test("闸口：重复不播、密集不补播、高优先级可打断、同轮汇报后不再念收尾白话", () => {
  const c = { text: "三张订单核对完成。", priority: "normal", reason: "delivery" };
  const now = 1_000_000;
  const first = gateSpeech(c, VOICE_GATE_INITIAL, now, 0);
  assert.equal(first.ok, true);
  assert.equal(gateSpeech(c, first.next, now + 1000, 0).ok, false, "一分钟内重复不播");

  const dense = gateSpeech({ ...c, text: "另一句进度。" }, first.next, now + 1000, 0);
  assert.equal(dense.ok, false, "普通播报 4 秒内不叠加");
  const urgent = gateSpeech({ text: "有一件事等你拍板", priority: "high", reason: "decision" }, first.next, now + 1000, 0);
  assert.equal(urgent.ok, true);
  assert.equal(urgent.interrupt, true);

  const reported = gateSpeech({ text: "结论已播", priority: "high", reason: "report" }, VOICE_GATE_INITIAL, now, 0);
  assert.equal(gateSpeech({ text: "好的，我汇报完了。", priority: "normal", reason: "reply" }, reported.next, now + 5000, 0).ok, false);
  assert.equal(gateSpeech(c, VOICE_GATE_INITIAL, now, 3).ok, false, "队列满了丢弃普通播报");
  assert.ok(gateSpeech({ ...c, priority: "high" }, VOICE_GATE_INITIAL, now, 3).ok, "高优先级仍可入");

  // 详细档的过程短句：不排队、8 秒一条、同类 25 秒一条，工具流冲不进耳朵
  const low = { text: "我已派单，开始处理。", priority: "low", reason: "dispatch" };
  const lowFirst = gateSpeech(low, VOICE_GATE_INITIAL, now, 0);
  assert.equal(lowFirst.ok, true);
  assert.equal(gateSpeech(low, lowFirst.next, now + 9000, 0).ok, false, "同类 25 秒内只播一条");
  assert.equal(gateSpeech({ ...low, reason: "tool", text: "技能激活，订单核对。" }, lowFirst.next, now + 9000, 1).ok, false, "有队列就不补播过程短句");
  assert.equal(gateSpeech({ ...low, reason: "team", text: "已组建执行小组。" }, lowFirst.next, now + 1000, 0).ok, false, "8 秒内不叠加");
});

test("内核落卡带上 speak：语音念的是人话，不是「成员 + 工单号」", async () => {
  const kernel = new Kernel(tmp());
  const said = [];
  kernel.setVoice({
    sayCard: (card) => said.push(pickCardSpeech(card, prefs())?.text ?? null),
    sayReply: () => {},
    stop: () => {},
  });
  try {
    await kernel.init();
    kernel.emit({
      type: "tool",
      badge: "派单",
      title: "阿计 开工 · task-mf3k9x2a-1",
      speak: "我把「Q3 订单核对」交给阿计了，他开始做。",
    });
    assert.equal(said.at(-1), "我把「Q3 订单核对」交给阿计了，他开始做。");
    assert.ok(!/task-/.test(said.at(-1)), "单号不能进耳朵");
  } finally {
    await kernel.dispose();
  }
});

test("内核接线：落卡过语音端口、配置真落盘、关开关立刻静音", async () => {
  const root = tmp();
  const kernel = new Kernel(root);
  const calls = { cards: 0, replies: 0, stops: 0 };
  kernel.setVoice({
    sayCard: () => { calls.cards += 1; },
    sayReply: () => { calls.replies += 1; },
    stop: () => { calls.stops += 1; },
  });
  try {
    await kernel.init();
    const r = kernel.handle("config.prefs", {
      autoStart: true,
      voiceEnabled: false,
      voiceId: "zh-CN-YunxiNeural",
      voiceScope: "detail",
      voiceMaxChars: 80,
      voiceWhenHidden: true,
      voiceProxy: "http://127.0.0.1:7890",
    });
    assert.equal(r.voiceEnabled, false);
    assert.equal(r.voiceId, "zh-CN-YunxiNeural");
    assert.equal(r.voiceScope, "detail");
    assert.equal(r.voiceMaxChars, 80);
    assert.equal(r.voiceWhenHidden, true);
    assert.equal(r.voiceProxy, "http://127.0.0.1:7890");
    assert.equal(calls.stops, 1, "关开关要立刻静音");

    const illegal = kernel.handle("config.prefs", { autoStart: true, voiceProxy: "javascript:alert(1)" });
    assert.equal(illegal.ok, false, "代理格式要拒");

    kernel.card({ kind: "tool", badge: "汇报", report: { conclusion: "已完成核对。", evidence: "", unfinished: "", decision: "" } });
    assert.equal(calls.cards, 1, "落卡要过语音端口");
    kernel.handle("session.abort");
    assert.equal(calls.stops, 2, "停止对话也要静音");
  } finally {
    await kernel.dispose();
  }

  const again = new Kernel(root);
  try {
    await again.init();
    assert.equal(again.getPrefs().voiceId, "zh-CN-YunxiNeural", "重启后音色保留");
    assert.equal(again.getPrefs().voiceEnabled, false, "重启后开关保留");
  } finally {
    await again.dispose();
  }
});
