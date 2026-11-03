// 全站唯一词表：状态 / 阶段 / 成员态的措辞与索引都在这里，渲染层不再各自写一套。
//
// 起因（见诊断清单 B4/D4）：
//  · 同一件事有三种写法（工单"待审查"、成员"待拍板"、印章"等你拍板"）；
//  · 阶段流七步里"汇报"没有任何状态映射到它，永远不点亮；
//  · "轮"同时指回合上限、打回轮次，界面上并排出现会被读成同一个额度。

import type { TaskStatus, TurnPhase } from "./contract";

// ---------- 工单状态（七态，规范 §6.1） ----------

export const STATUS_LABEL: Record<TaskStatus, string> = {
  backlog: "待受理",
  todo: "待派单",
  in_progress: "执行中",
  in_review: "待审查",
  blocked: "卡住",
  done: "已归档",
  canceled: "已取消",
};

/** i18n key（渲染层用 t() 取词；STATUS_LABEL 是中文兜底） */
export const STATUS_KEY: Record<TaskStatus, string> = {
  backlog: "status.backlog",
  todo: "status.todo",
  in_progress: "status.in_progress",
  in_review: "status.in_review",
  blocked: "status.blocked",
  done: "status.done",
  canceled: "status.canceled",
};

// ---------- 阶段流（图纸上那排进度点） ----------

/**
 * 六步：受理 → 拆解 → 派单 → 执行 → 审查 → 归档。
 * "汇报"已并进"审查"——它原来没有任何 TaskStatus 会落到索引 5，等于永远点不亮。
 */
export const STAGES = ["受理", "拆解", "派单", "执行", "审查", "归档"] as const;

export const STAGE_KEYS = [
  "stage.intake",
  "stage.breakdown",
  "stage.dispatch",
  "stage.execute",
  "stage.review",
  "stage.archive",
] as const;

export const STAGE_OF: Record<TaskStatus, number> = {
  backlog: 0,
  todo: 1,
  in_progress: 3,
  blocked: 3,
  in_review: 4,
  done: 5,
  canceled: 0,
};

/** 本轮进行到哪一步（回合相位也映射到同一套阶段，避免"相位"成为第二套坐标） */
export const PHASE_STAGE: Record<TurnPhase, number> = {
  idle: 0,
  accepted: 0,
  planning: 1,
  awaiting_plan: 2,
  working: 3,
  review: 4,
  done: 5,
  failed: 3,
};

// ---------- 成员态 ----------

/**
 * 成员态只表达"他手上那张单到哪了"，措辞与台账分组一致：
 * 进行中 / 等你拍板 / 卡住 / 空闲。不再另起"待拍板/执行中"这套近义词。
 */
export type MemberState = "running" | "delivered" | "stuck" | "idle";

export const MEMBER_STATE_LABEL: Record<MemberState, string> = {
  running: "进行中",
  delivered: "等你拍板",
  stuck: "卡住",
  idle: "空闲",
};

export const MEMBER_STATE_KEY: Record<MemberState, string> = {
  running: "memberStatus.running",
  delivered: "memberStatus.delivered",
  stuck: "memberStatus.stuck",
  idle: "memberStatus.idle",
};
