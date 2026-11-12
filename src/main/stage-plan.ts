// 多阶段任务的阶段状态机（2026-11-11 交付：逻辑层 + 只读数据通路）。
//
// 为什么需要它：7 阶段长任务实测里，阶段顺序完全靠模型在上下文里自己记；两次自动压缩后
// 它开始反复复述摘要、查 246 次进度、重派 24 次，最终没交出验收表。阶段进度必须由代码持有，
// 压缩上下文不能把它抹掉。
//
// 本轮落地范围（明确边界，避免影响现有功能）：
//   ✅ 阶段清单、合法迁移、证据闸、依赖闸、打回重试不新建阶段、全部完成才允许收尾——纯函数，可单测
//   ✅ 只读数据通路：kernel.buildTrack 把卷宗派单轮次与状态时间线带进快照，详情区已优先展示
//   ❌ 不改 TOOL_JSON / 工具面（仍 15 件）、不改 TaskStatus 七态、不改 agent loop、不新增 RPC
//   ❌ 不自动在成员回报时推进阶段（下一轮接 registerReport / accept_or_reject 时做）
//
// 下一轮接入与验收方式见文末 VALIDATION_NOTE，或本轮回复的「阶段状态机」小节。

export type StageStatus = "pending" | "active" | "done" | "blocked" | "skipped";

export interface StageDef {
  id: string;
  title: string;
  /** 完成判据：必须是可验证的验收点，不是「像结论的话」 */
  acceptance: string;
  /** 前置阶段 id：未全部完成/跳过不得激活 */
  dependsOn?: string[];
}

export interface Stage extends StageDef {
  status: StageStatus;
  /** 证据引用（文件 / 命令输出 / 测试结果）；空证据不得判完成 */
  evidence: string[];
  /** 在这一阶段内打回重做的轮次；重试不新建阶段、不新建工单 */
  round: number;
  note?: string;
  updatedAt: string;
}

export interface StagePlan {
  id: string;
  title: string;
  stages: Stage[];
  createdAt: string;
  updatedAt: string;
  /** 全部阶段结束后由代码置位；在此之前不允许生成最终验收表 */
  finalized: boolean;
}

/** 通用 7 段模板：描述能力/验收形态，不写任何具体路径、文件名或数字目标。 */
export const DEFAULT_STAGE_DEFS: readonly StageDef[] = [
  { id: "premise", title: "前提与记忆确认", acceptance: "关键前提已记录且可回查" },
  { id: "analyze", title: "材料与结构分析", acceptance: "分析结论有原始材料或命令输出支撑", dependsOn: ["premise"] },
  { id: "write", title: "写入与落盘", acceptance: "产物存在且写入回执可查", dependsOn: ["analyze"] },
  { id: "readback", title: "读回验证", acceptance: "读回原文与写入内容一致", dependsOn: ["write"] },
  { id: "parallel", title: "并行子任务", acceptance: "各子任务均交出带证据的回报", dependsOn: ["analyze"] },
  { id: "negative", title: "失败路径验证", acceptance: "真实错误原文已记录且未伪造成功", dependsOn: ["premise"] },
  {
    id: "final",
    title: "自检与汇报",
    acceptance: "验收表逐阶段可核对，未完成项如实列出",
    dependsOn: ["write", "readback", "parallel", "negative"],
  },
];

/** 下一轮接入的验收口径（代码内留一份，避免口头约定漂移）。 */
export const VALIDATION_NOTE = `接入验收：① 重跑 7 阶段评测任务，阶段清单落盘可回查；
② 每阶段必须有证据才推进，无证据当场拒；③ 7/7 后由代码触发最终验收表，不再靠模型自觉收尾；
④ 不产生新工单风暴与思考复读；⑤ 上下文压缩/会话恢复后阶段状态不丢。
回归入口：tests/stage-plan.test.mjs（本轮纯函数）+ 下一轮内核集成与端到端评测。`;

function clone(plan: StagePlan): StagePlan {
  return {
    ...plan,
    stages: plan.stages.map((s) => ({ ...s, evidence: [...s.evidence], dependsOn: s.dependsOn ? [...s.dependsOn] : undefined })),
  };
}

function find(stages: Stage[], id: string): Stage {
  const s = stages.find((x) => x.id === id);
  if (!s) throw new Error(`阶段不存在：${id}`);
  return s;
}

function depsSatisfied(plan: StagePlan, s: Stage): boolean {
  return (s.dependsOn ?? []).every((id) => {
    const dep = plan.stages.find((x) => x.id === id);
    return !!dep && (dep.status === "done" || dep.status === "skipped");
  });
}

/** 建计划：无依赖的首阶段自动激活，其余 pending。结构不合法直接抛。 */
export function createStagePlan(id: string, title: string, defs: readonly StageDef[], now = new Date().toISOString()): StagePlan {
  const plan: StagePlan = {
    id,
    title,
    createdAt: now,
    updatedAt: now,
    finalized: false,
    stages: defs.map((d) => ({
      ...d,
      dependsOn: d.dependsOn ? [...d.dependsOn] : undefined,
      status: "pending" as StageStatus,
      evidence: [],
      round: 0,
      updatedAt: now,
    })),
  };
  const bad = validateStagePlan(plan);
  if (bad) throw new Error(bad);
  for (const s of plan.stages) {
    if (!s.dependsOn?.length) {
      s.status = "active";
      break;
    }
  }
  return plan;
}

/** 激活：只允许 pending → active，且所有前置阶段已完成或跳过。 */
export function activateStage(plan: StagePlan, stageId: string, now = new Date().toISOString()): StagePlan {
  const next = clone(plan);
  const s = find(next.stages, stageId);
  if (s.status !== "pending") throw new Error(`阶段 ${stageId} 不是待办状态（${s.status}），不能激活`);
  if (!depsSatisfied(next, s)) throw new Error(`阶段 ${stageId} 的前置还没完成`);
  s.status = "active";
  s.updatedAt = now;
  next.updatedAt = now;
  return next;
}

/** 完成：必须处于 active 且带至少一条证据；完成后自动激活所有依赖已满足的待办阶段。 */
export function completeStage(plan: StagePlan, stageId: string, evidence: readonly string[], now = new Date().toISOString()): StagePlan {
  const next = clone(plan);
  const s = find(next.stages, stageId);
  if (s.status !== "active") throw new Error(`阶段 ${stageId} 不在执行中（${s.status}），不能判完成`);
  const ev = evidence.map((e) => String(e ?? "").trim()).filter(Boolean);
  if (!ev.length) throw new Error(`阶段 ${stageId} 没有证据，不能判完成`);
  s.status = "done";
  s.evidence = ev;
  s.updatedAt = now;
  for (const other of next.stages) {
    if (other.status !== "pending" || !depsSatisfied(next, other)) continue;
    other.status = "active";
    other.updatedAt = now;
  }
  next.updatedAt = now;
  return next;
}

/** 受阻：只改状态，记录原因；下一轮 retryStage 仍在同一阶段内。 */
export function blockStage(plan: StagePlan, stageId: string, note: string, now = new Date().toISOString()): StagePlan {
  const next = clone(plan);
  const s = find(next.stages, stageId);
  if (s.status !== "active") throw new Error(`阶段 ${stageId} 不在执行中，不能标受阻`);
  s.status = "blocked";
  s.note = note;
  s.updatedAt = now;
  next.updatedAt = now;
  return next;
}

/** 重做：blocked → active，轮次 +1，不新建阶段、不新建工单，证据清空重来。 */
export function retryStage(plan: StagePlan, stageId: string, note?: string, now = new Date().toISOString()): StagePlan {
  const next = clone(plan);
  const s = find(next.stages, stageId);
  if (s.status !== "blocked") throw new Error(`阶段 ${stageId} 不是受阻状态，不能重做`);
  s.status = "active";
  s.round += 1;
  s.evidence = [];
  s.note = note ?? s.note;
  s.updatedAt = now;
  next.updatedAt = now;
  return next;
}

/** 跳过：确实不适用时显式跳过，并写明原因（不允许静默跳过）。 */
export function skipStage(plan: StagePlan, stageId: string, note: string, now = new Date().toISOString()): StagePlan {
  const next = clone(plan);
  const s = find(next.stages, stageId);
  if (s.status === "done") throw new Error(`阶段 ${stageId} 已完成，不能跳过`);
  if (!note.trim()) throw new Error("跳过阶段必须写明原因");
  s.status = "skipped";
  s.note = note;
  s.updatedAt = now;
  for (const other of next.stages) {
    if (other.status !== "pending" || !depsSatisfied(next, other)) continue;
    other.status = "active";
    other.updatedAt = now;
  }
  next.updatedAt = now;
  return next;
}

export interface StageProgress {
  done: number;
  skipped: number;
  total: number;
  active: string[];
  next: string | null;
  percent: number;
}

export function stagePlanProgress(plan: StagePlan): StageProgress {
  const done = plan.stages.filter((s) => s.status === "done").length;
  const skipped = plan.stages.filter((s) => s.status === "skipped").length;
  const active = plan.stages.filter((s) => s.status === "active").map((s) => s.id);
  const next = plan.stages.find((s) => s.status === "pending" || s.status === "blocked")?.id ?? null;
  return {
    done,
    skipped,
    total: plan.stages.length,
    active,
    next,
    percent: plan.stages.length ? Math.round(((done + skipped) / plan.stages.length) * 100) : 0,
  };
}

/** 只有全部阶段 done/skipped 且尚未收尾时才允许生成最终验收表。 */
export function shouldFinalize(plan: StagePlan): boolean {
  return !plan.finalized && plan.stages.length > 0 && plan.stages.every((s) => s.status === "done" || s.status === "skipped");
}

export function finalizeStagePlan(plan: StagePlan, now = new Date().toISOString()): StagePlan {
  if (!shouldFinalize(plan)) throw new Error("还有阶段未结束，不能生成最终验收表");
  return { ...clone(plan), finalized: true, updatedAt: now };
}

/** 结构校验：id 唯一、依赖存在、依赖不成环、终态一致（多个 active 是合法的并行阶段，不拦）。 */
export function validateStagePlan(plan: StagePlan): string | null {
  const ids = new Set<string>();
  for (const s of plan.stages) {
    if (!s.id.trim()) return "阶段 id 不能为空";
    if (ids.has(s.id)) return `阶段 id 重复：${s.id}`;
    ids.add(s.id);
  }
  for (const s of plan.stages) {
    for (const dep of s.dependsOn ?? []) {
      if (!ids.has(dep)) return `阶段 ${s.id} 的前置不存在：${dep}`;
      if (dep === s.id) return `阶段 ${s.id} 不能依赖自己`;
    }
  }
  // 依赖环检测（DFS）
  const state = new Map<string, 0 | 1 | 2>();
  const visit = (id: string): boolean => {
    if (state.get(id) === 1) return true;
    if (state.get(id) === 2) return false;
    state.set(id, 1);
    const s = plan.stages.find((x) => x.id === id);
    for (const dep of s?.dependsOn ?? []) if (visit(dep)) return true;
    state.set(id, 2);
    return false;
  };
  for (const s of plan.stages) if (visit(s.id)) return `阶段依赖成环：${s.id}`;
  if (plan.finalized && !plan.stages.every((s) => s.status === "done" || s.status === "skipped")) {
    return "已收尾的计划里不能有未结束阶段";
  }
  return null;
}
