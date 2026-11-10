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
}

export interface HeartbeatScheduleFact {
  id: string;
  name: string;
  lastStatus: string;
}

export interface HeartbeatFacts {
  /** 待审查：成员已回报等验收 */
  awaitingReview: HeartbeatTaskFact[];
  /** 停滞工单：没人跟、不在等用户确认契约 */
  stalledTasks: HeartbeatTaskFact[];
  /** 定时任务上次执行异常 */
  scheduleIssues: HeartbeatScheduleFact[];
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
  tasks: { id: string; title?: string; status: string; member?: string }[];
  runningTaskIds: readonly string[];
  pendingPlanTaskIds: readonly string[];
  schedules: { id: string; name: string; enabled?: boolean; lastStatus?: string }[];
}): HeartbeatFacts {
  const running = new Set(input.runningTaskIds);
  const awaitingPlan = new Set(input.pendingPlanTaskIds);
  const awaitingReview: HeartbeatTaskFact[] = [];
  const stalledTasks: HeartbeatTaskFact[] = [];
  for (const t of input.tasks) {
    if (running.has(t.id) || awaitingPlan.has(t.id)) continue;
    if (REVIEWABLE.has(t.status)) {
      awaitingReview.push({ taskId: t.id, title: t.title ?? t.id, status: t.status, member: t.member });
      continue;
    }
    if (STALLED.has(t.status)) {
      stalledTasks.push({ taskId: t.id, title: t.title ?? t.id, status: t.status, member: t.member });
    }
  }
  const scheduleIssues = input.schedules
    .filter((s) => s.enabled !== false && SCHEDULE_BAD.has(String(s.lastStatus)))
    .map((s) => ({ id: s.id, name: s.name, lastStatus: String(s.lastStatus) }));
  return { awaitingReview, stalledTasks, scheduleIssues };
}

/** 同一批事实的去重键：内容没变就不重复打扰（30 分钟窗口由调用方控制） */
export function heartbeatSignature(facts: HeartbeatFacts): string {
  const part = (list: { taskId?: string; id?: string }[]) =>
    list
      .map((x) => x.taskId ?? x.id ?? "")
      .sort()
      .join(",");
  return [part(facts.awaitingReview), part(facts.stalledTasks), part(facts.scheduleIssues)].join("|");
}

export function heartbeatIsEmpty(facts: HeartbeatFacts): boolean {
  return facts.awaitingReview.length === 0 && facts.stalledTasks.length === 0 && facts.scheduleIssues.length === 0;
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
  if (facts.stalledTasks.length) {
    lines.push(
      "- 停滞工单（没人跟，也不在等用户拍板）：" +
        facts.stalledTasks.map((t) => `${t.taskId}「${t.title}」（${t.status}${t.member ? `·原 ${t.member}` : ""}）`).join("、"),
    );
  }
  if (facts.scheduleIssues.length) {
    lines.push(
      "- 定时任务上次执行异常：" +
        facts.scheduleIssues.map((s) => `${s.name}（${s.lastStatus}）`).join("、"),
    );
  }
  lines.push(
    "",
    "处置参考（不强制，你来判断）：",
    "- 待审查：check_progress 看细节 → review_result 验收或 accept_or_reject 打回；",
    "- 停滞工单：目标仍成立就推进（重新派单，brief 按四段写全）；目标过时或捡不动就向用户说明并建议取消；",
    "- 定时任务异常：如实转告用户（missed=错过的补跑说明、stale=在途被清理），让它下次正常跑；",
    "- 拿不准的先 ask_user。没有需要干预的就一句话说明现状，不要编造工作、不要为走流程起任务。",
  );
  return lines.join("\n");
}
