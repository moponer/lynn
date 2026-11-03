// 工单分组与"该你做什么"的唯一定义（渲染层只读这里，不各自 if/else）。
//
// 背景：台账曾把 backlog/todo 归进"进行中"，又把 blocked 并进"等你拍板"，
// 结果"进行中"里坐着待受理的单、"等你拍板"里躺着根本没法验收的单。
// 分组语义必须与状态机一一对应，且"可验收"只在 in_review 成立。

import type { TaskStatus } from "./contract";

/** 台账分组：等你拍板 / 卡住 / 进行中 / 未开工 / 已归档 */
export type JobGroup = "waiting" | "stuck" | "running" | "queued" | "archived";

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

/** 台账里按这个顺序渲染（归档单独走归档带） */
export const GROUP_ORDER: Exclude<JobGroup, "archived">[] = ["waiting", "stuck", "running", "queued"];

export function groupOf(status: TaskStatus): JobGroup {
  return GROUP_OF[status] ?? "queued";
}

/**
 * 只有 in_review 能验收：blocked 是"她卡住了、要新证据"，
 * 把它当交付会让用户在没产物时点下"验收归档"。
 */
export function actionOf(status: TaskStatus): JobAction {
  if (status === "in_review") return "accept";
  if (status === "blocked") return "unblock";
  return "none";
}
