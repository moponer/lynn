/**
 * 心跳巡检（纯逻辑，M3-01）：机械层只做一件事——把"需要风铃看一眼的机器事实"
 * 聚合成一份巡检简报；**没事就不注入（token 消耗 = 0）**，有事才起一轮，
 * 判断与处置完全由她做主（停/催/捡/问/汇报），代码不写死动作。
 *
 * 固定的巡检事项（边界写死在这里，防止心跳漂移成"自由发挥"）：
 *  1. 待审查：成员已交回报，等她验收（in_review）
 *  2. 停滞工单：backlog/blocked/todo，没有成员在跟、也不在等用户拍板契约
 *  3. 定时任务异常：上次 missed / stale / error
 * 成员卡死的实时跟进不在这层（supervisorTick 已覆盖，见 kernel.ts）。
 */

export interface HeartbeatTaskFact {
  taskId: string;
  title: string;
  status: string;
  member?: string;
  /** 卡住的机读成因（user_stop / no_report / reject_limit / reconcile / crash）：她按因判断，不是只看个 blocked */
  reason?: string;
}

export interface HeartbeatScheduleFact {
  id: string;
  name: string;
  lastStatus: string;
}

/** 群里 @ 了人但还没回应的诉求（2026-11-12 群聊模式） */
export interface HeartbeatMentionFact {
  /** 被点名的成员 */
  member: string;
  /** 用户原话摘要 */
  text: string;
  /** 什么时候点的（卡片时刻） */
  at: string;
}

export interface HeartbeatFacts {
  /** 待审查：成员已回报等验收 */
  awaitingReview: HeartbeatTaskFact[];
  /** 停滞工单：没人跟、不在等用户确认契约 */
  stalledTasks: HeartbeatTaskFact[];
  /**
   * 状态在跑但没人跟（2026-11-11 补）：成员崩了 / 进程重启后状态没回退。
   * 这类单以前不属于任何集合，会永远停在「执行中」，心跳也看不见。
   */
  orphanTasks: HeartbeatTaskFact[];
  /** 定时任务上次执行异常 */
  scheduleIssues: HeartbeatScheduleFact[];
  /**
   * 群里 @ 了成员但风铃还没接住（2026-11-12 群聊模式）。
   * 用户 @某人 = 对这个人的定向诉求；用户已定：走心跳兜底，不强制当轮回应。
   */
  unansweredMentions: HeartbeatMentionFact[];
}

const REVIEWABLE = new Set(["in_review"]);
const STALLED = new Set(["backlog", "blocked", "todo"]);
const SCHEDULE_BAD = new Set(["missed", "stale", "error"]);

/**
 * 从机器状态收集心跳事实。排除规则：
 *  - 在跑的单（memberRuns）与等待用户拍板的契约单（pendingPlans）不算停滞；
 *  - done/canceled 永远不进事实；disabled 的定时任务不算异常。
 */
export function collectHeartbeatFacts(input: {
  tasks: { id: string; title?: string; status: string; member?: string; blockedReason?: string }[];
  runningTaskIds: readonly string[];
  pendingPlanTaskIds: readonly string[];
  schedules: { id: string; name: string; enabled?: boolean; lastStatus?: string }[];
  /** 群里 @ 了人但风铃还没回应的（由内核从对话流派生） */
  pendingMentions?: { member: string; text: string; at: string }[];
}): HeartbeatFacts {
  const running = new Set(input.runningTaskIds);
  const awaitingPlan = new Set(input.pendingPlanTaskIds);
  const awaitingReview: HeartbeatTaskFact[] = [];
  const stalledTasks: HeartbeatTaskFact[] = [];
  const orphanTasks: HeartbeatTaskFact[] = [];
  for (const t of input.tasks) {
    if (running.has(t.id) || awaitingPlan.has(t.id)) continue;
    if (REVIEWABLE.has(t.status)) {
      awaitingReview.push({ taskId: t.id, title: t.title ?? t.id, status: t.status, member: t.member });
      continue;
    }
    if (t.status === "in_progress") {
      // 在跑集合里已排除：状态在跑但没人跟，交给风铃判断是崩了还是没交接完
      orphanTasks.push({ taskId: t.id, title: t.title ?? t.id, status: t.status, member: t.member });
      continue;
    }
    if (STALLED.has(t.status)) {
      stalledTasks.push({
        taskId: t.id,
        title: t.title ?? t.id,
        status: t.status,
        member: t.member,
        reason: t.blockedReason,
      });
    }
  }
  const scheduleIssues = input.schedules
    .filter((s) => s.enabled !== false && SCHEDULE_BAD.has(String(s.lastStatus)))
    .map((s) => ({ id: s.id, name: s.name, lastStatus: String(s.lastStatus) }));
  return {
    awaitingReview,
    stalledTasks,
    orphanTasks,
    scheduleIssues,
    unansweredMentions: (input.pendingMentions ?? []).map((m) => ({
      member: m.member,
      text: m.text,
      at: m.at,
    })),
  };
}

/** 同一批事实的去重键：内容没变就不重复打扰（30 分钟窗口由调用方控制） */
export function heartbeatSignature(facts: HeartbeatFacts): string {
  const part = (list: { taskId?: string; id?: string }[]) =>
    list
      .map((x) => x.taskId ?? x.id ?? "")
      .sort()
      .join(",");
  return [
    part(facts.awaitingReview),
    part(facts.orphanTasks),
    part(facts.stalledTasks),
    part(facts.scheduleIssues),
    facts.unansweredMentions.map((m) => `${m.member}@${m.at}`).sort().join(","),
  ].join("|");
}

export function heartbeatIsEmpty(facts: HeartbeatFacts): boolean {
  return (
    facts.awaitingReview.length === 0 &&
    facts.stalledTasks.length === 0 &&
    facts.orphanTasks.length === 0 &&
    facts.scheduleIssues.length === 0 &&
    facts.unansweredMentions.length === 0
  );
}

/**
 * 堆积闸裁剪：单子堆太多时不能整轮跳过——跳了就没人清，堆积冻在原地，界面上只剩
 * 每 5 分钟一条一模一样的提示；但也不能把 15+ 张全塞进上下文（实测模型会在超长上
 * 下文里复读）。折中：一轮只给她最靠前的几张去清，其余只报数，下一轮接着清。
 * 待审优先——验收是压低堆积最快的一步，停滞单往往还要重做/关单，更慢。
 */
export function capHeartbeatFacts(
  facts: HeartbeatFacts,
  limit: number,
): { facts: HeartbeatFacts; dropped: number } {
  const cap = Math.max(0, limit);
  const awaitingReview = facts.awaitingReview.slice(0, cap);
  const orphanTasks = facts.orphanTasks.slice(0, Math.max(0, cap - awaitingReview.length));
  const stalledTasks = facts.stalledTasks.slice(0, Math.max(0, cap - awaitingReview.length - orphanTasks.length));
  const unansweredMentions = facts.unansweredMentions.slice(
    0,
    Math.max(0, cap - awaitingReview.length - orphanTasks.length - stalledTasks.length),
  );
  const dropped =
    facts.awaitingReview.length -
    awaitingReview.length +
    (facts.orphanTasks.length - orphanTasks.length) +
    (facts.stalledTasks.length - stalledTasks.length) +
    (facts.unansweredMentions.length - unansweredMentions.length);
  return {
    facts: { awaitingReview, orphanTasks, stalledTasks, scheduleIssues: facts.scheduleIssues, unansweredMentions },
    dropped,
  };
}

/**
 * 秒级探针的自适应间隔（2026-11-11）：
 * 只在内存里看成员运行态，有成员在跑就按用户配置（默认 1s）看，空闲退避到 15s。
 * 这样既有秒级感知，又不会让 1s 定时器常驻耗电。
 */
export function probeDelayMs(activeMembers: number, baseMs: number): number {
  if (activeMembers > 0) return Math.min(5_000, Math.max(500, Math.round(baseMs) || 1_000));
  return 15_000;
}

/** 事件驱动唤醒闸的状态（只存内存，不落盘） */
export interface WakeGateState {
  lastWakeAt: number;
  windowStart: number;
  windowCount: number;
  lastSig: string;
  lastSigAt: number;
}

/**
 * 事件驱动唤醒的三道闸（2026-11-11）：
 * - busy / 合并窗口（默认 20s）：同一波事件只叫醒一次
 * - 同批事实冷却（默认 30 分钟）：事实没变就不重复烧上下文
 * - 每小时配额（默认 12 次）：防止异常刷屏把预算打穿
 * 秒级感知 + 这三道闸 = 响应快，但 token 消耗仍然只有分钟级心跳的量级。
 */
export function heartbeatWakeDecision(input: {
  now: number;
  busy: boolean;
  sig: string;
  state: WakeGateState;
  minGapMs: number;
  cooldownMs: number;
  perHour: number;
}): { wake: boolean; reason: string; next: WakeGateState } {
  const { now, busy, sig, state, minGapMs, cooldownMs, perHour } = input;
  if (busy) return { wake: false, reason: "busy", next: { ...state } };
  if (now - state.lastWakeAt < Math.max(0, minGapMs)) {
    return { wake: false, reason: "merge_window", next: { ...state } };
  }
  if (state.lastSig && state.lastSig === sig && now - state.lastSigAt < Math.max(0, cooldownMs)) {
    return { wake: false, reason: "same_facts", next: { ...state } };
  }
  let windowStart = state.windowStart;
  let windowCount = state.windowCount;
  if (!windowStart || now - windowStart >= 60 * 60_000) {
    windowStart = now;
    windowCount = 0;
  }
  if (windowCount >= Math.max(1, perHour)) {
    return { wake: false, reason: "hour_quota", next: { ...state, windowStart, windowCount } };
  }
  return {
    wake: true,
    reason: "wake",
    next: {
      lastWakeAt: now,
      windowStart,
      windowCount: windowCount + 1,
      lastSig: sig,
      lastSigAt: now,
    },
  };
}

/** 巡检简报：只摆事实与处置工具面，判断权在她 */
export function heartbeatPrompt(facts: HeartbeatFacts): string {
  const lines: string[] = ["【心跳巡检】以下是当前需要你关注的机器事实，判断与处置由你做主："];
  if (facts.awaitingReview.length) {
    lines.push(
      "- 待审查（成员已交回报，等你验收）：" +
        facts.awaitingReview.map((t) => `${t.taskId}「${t.title}」（${t.member ?? "成员"}）`).join("、"),
    );
  }
  if (facts.orphanTasks.length) {
    lines.push(
      "- 状态在跑但没人跟（成员已结束或进程重启）：" +
        facts.orphanTasks
          .map((t) => `${t.taskId}「${t.title}」${t.member ? `（原 ${t.member}）` : ""}`)
          .join("、"),
    );
  }
  if (facts.stalledTasks.length) {
    lines.push(
      "- 停滞工单（没人跟，也不在等用户拍板）：" +
        facts.stalledTasks
          .map(
            (t) =>
              `${t.taskId}「${t.title}」（${t.status}${t.reason ? `/${t.reason}` : ""}${t.member ? `·原 ${t.member}` : ""}）`,
          )
          .join("、"),
    );
  }
  if (facts.scheduleIssues.length) {
    lines.push(
      "- 定时任务上次执行异常：" +
        facts.scheduleIssues.map((s) => `${s.name}（${s.lastStatus}）`).join("、"),
    );
  }
  if (facts.unansweredMentions.length) {
    lines.push(
      "- 群里有 @ 还没接住（用户点名了某人，这是对他的定向诉求）：" +
        facts.unansweredMentions.map((m) => `@${m.member}「${m.text}」`).join("、"),
    );
  }
  lines.push(
    "",
    "处置参考（不强制，你来判断）：",
    "- 群里的 @ 还没回应：在跑就 nudge_member 补话（带上用户原话），已交就 assign_task 带 reworkTaskId 返工，没单就 assign_task；并在群里 @他 回一句——别只在别处办；",
    "- 待审查：check_progress 看细节 → review_result 验收或 accept_or_reject 打回；同一张单连续查 3 次没变化就别再查了；",
    "- 同一件事只在一张单上：重做用 assign_task 带 reworkTaskId，关单用 stop_task 带 dismiss=true，都由你决定，不要问用户要不要取消；",
    "- 状态在跑但没人跟：先 check_progress 看有没有回报；有就验收，没有就 assign_task 带 reworkTaskId 在原单重做，做不了就 stop_task 带 dismiss=true 关单；",
    "- 定时任务异常：如实转告用户（missed=错过的补跑说明、stale=在途被清理），让它下次正常跑；",
    "- 只有花钱、删用户数据、对外发送、口径无法判断时才 ask_user；其余自己定。没有需要干预的就一句话说明现状，不要编造工作、不要为走流程起任务，也不要反复复述上下文摘要。",
  );
  return lines.join("\n");
}
