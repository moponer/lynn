// 工单分组与"该你做什么"的唯一定义（渲染层只读这里，不各自 if/else）。
//
// 背景：台账曾把 backlog/todo 归进"进行中"，又把 blocked 并进"等你拍板"，
// 结果"进行中"里坐着待受理的单、"等你拍板"里躺着根本没法验收的单。
// 分组语义必须与状态机一一对应，且"可验收"只在 in_review 成立。
//
// 2026-11-15 追加「已终止」组：用户按了「终止任务」之后，本群那些本来"等你拍板"的单
// 不再催人（印章整块消失、待办计数归零），但它们没被销毁——发一条消息恢复后回到原组。

import type { TaskStatus } from "./contract";

/** 台账分组：等你拍板 / 卡住 / 进行中 / 未开工 / 已终止 / 已归档 */
export type JobGroup = "waiting" | "stuck" | "running" | "queued" | "halted" | "archived";

/** 用户在界面上唯一要做的事：验收 / 解卡 / 不用管 */
export type JobAction = "accept" | "unblock" | "none";

const GROUP_OF: Record<TaskStatus, JobGroup> = {
  in_review: "waiting",
  blocked: "stuck",
  in_progress: "running",
  backlog: "queued",
  todo: "queued",
  done: "archived",
  canceled: "archived",
};

/** 台账里按这个顺序渲染（归档单独走归档带）；已终止排最后——它不需要你动手 */
export const GROUP_ORDER: Exclude<JobGroup, "archived">[] = ["waiting", "stuck", "running", "queued", "halted"];

/**
 * @param halted 这张单所属的群被用户终止了（2026-11-15）。
 * 终止是"停住"不是"销毁"：还在办的单归「已终止」组，恢复后自己回到原来的组。
 * 已结案的照旧进归档带——终止不该把历史单翻出来。
 */
export function groupOf(status: TaskStatus, reviewer?: "lynn" | "user", halted = false): JobGroup {
  if (halted) {
    if (status === "done" || status === "canceled") return "archived";
    return "halted";
  }
  /* 派给成员的活正在等风铃验：对用户来说是"有人正在弄"，不该占用他的待办 */
  if (status === "in_review" && reviewer === "lynn") return "running";
  return GROUP_OF[status] ?? "queued";
}

/**
 * 只有 in_review 能验收：blocked 是"她卡住了、要新证据"，
 * 把它当交付会让用户在没产物时点下"验收归档"。
 * reviewer=lynn 的单由风铃验，用户没有动作。
 * 群已终止时一律无动作：没人会来点，摆一张"等你拍板"就是骗人的。
 */
export function actionOf(status: TaskStatus, reviewer?: "lynn" | "user", halted = false): JobAction {
  if (halted) return "none";
  if (status === "in_review") return reviewer === "lynn" ? "none" : "accept";
  if (status === "blocked") return "unblock";
  return "none";
}
