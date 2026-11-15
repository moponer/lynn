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

/**
 * 按任务规模与型态取阶段模板（2026-11-15 接入内核）。
 *
 * 为什么不一律用 7 段：写一篇散文也架「勘察 + 独立验收 + 并行子任务 + 失败路径」四支队，
 * 用户看到的就是顺序混乱、角色重叠、多轮空转。**阶段数跟规模与型态走**：
 *  - 小任务（execute，判据 ≤2 条）：契约 → 产出（含自检） → 汇报。不另设验收角色。
 *  - 中/大任务（execute）：契约 → 产出 → 独立验收 → 汇报。多出的是「别人来看」这一段。
 *  - 探索型（explore）：契约 → 勘察（结论+依据） → 汇报。硬凑产物不是完成。
 *
 * 注：execute 任务不单设"勘察"段——核对材料本来就是产出前的第一步，
 * 拆成独立阶段只会让一个成员在两张单之间来回交接（实机里"顺序混乱"的一半来自这里）。
 * 需要"先查清再动手"时用 mode=explore 派一张勘察单，查清了再派执行单。
 */
export function stageDefsFor(input: { scale: "small" | "medium" | "large"; mode: "execute" | "explore" }): StageDef[] {
  const verify = input.mode !== "explore" && input.scale !== "small";
  const defs: StageDef[] = [
    { id: "contract", title: "契约与口径", acceptance: "目标、判据、材料位置、工作区四项已定且可逐条核对" },
  ];
  if (input.mode === "explore") {
    defs.push({
      id: "survey",
      title: "勘察与结论",
      acceptance: "结论都有原始材料或命令输出支撑；缺什么、要向谁要，写明",
      dependsOn: ["contract"],
    });
    defs.push({
      id: "report",
      title: "结论汇报",
      acceptance: "结论、依据、不确定项三项齐全，未验证处如实标注",
      dependsOn: ["survey"],
    });
    return defs;
  }
  defs.push({
    id: "produce",
    title: "产出落盘",
    acceptance: "产物存在，且写入回执或自检记录可查",
    dependsOn: ["contract"],
  });
  if (verify) {
    defs.push({
      id: "verify",
      title: "独立验收",
      acceptance: "每条判据都有结论与依据；未过项写明改什么",
      dependsOn: ["produce"],
    });
  }
  defs.push({
    id: "report",
    title: "汇报收尾",
    acceptance: "结论、交付物、未完成、待拍板四项齐全",
    dependsOn: [verify ? "verify" : "produce"],
  });
  return defs;
}

/**
 * 安全推进（内核专用）：不在执行中、没证据时**不抛**，返回 null。
 * 阶段账是辅助事实源，不能因为它写不进去就让回报/验收的主流程失败。
 */
export function tryCompleteStage(
  plan: StagePlan,
  stageId: string,
  evidence: readonly string[],
  now = new Date().toISOString(),
): StagePlan | null {
  const s = plan.stages.find((x) => x.id === stageId);
  if (!s || s.status !== "active") return null;
  try {
    return completeStage(plan, stageId, evidence, now);
  } catch {
    return null;
  }
}

/**
 * 打回重做：把某阶段拉回执行中，下游阶段退回 pending 并清空证据。
 * 语义是「**只重做这一段**」——不新建阶段、不新建工单，下游（如独立验收）必须重验。
 */
export function reopenStage(plan: StagePlan, stageId: string, note: string, now = new Date().toISOString()): StagePlan {
  const next = clone(plan);
  const s = find(next.stages, stageId);
  // 已收尾的单被用户重开再来一轮：收尾标记必须撤销，否则计划里出现"已收尾但仍有执行中段"
  next.finalized = false;
  s.status = "active";
  s.round += 1;
  s.evidence = [];
  s.note = note;
  s.updatedAt = now;
  const reset = findAllDownstream(next.stages, stageId);
  for (const d of next.stages) {
    if (!reset.has(d.id) || d.status === "pending") continue;
    d.status = "pending";
    d.evidence = [];
    d.updatedAt = now;
  }
  next.updatedAt = now;
  return next;
}

/** 依赖树上的所有下游（含传递闭包） */
function findAllDownstream(stages: readonly Stage[], stageId: string): Set<string> {
  const out = new Set<string>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const s of stages) {
      if (out.has(s.id)) continue;
      if ((s.dependsOn ?? []).some((d) => d === stageId || out.has(d))) {
        out.add(s.id);
        grew = true;
      }
    }
  }
  return out;
}

/**
 * 阶段摘要（给界面用，2026-11-15）：台账一行就能看出"走到第几段、这段叫什么"。
 * 只给事实，不给形容词——用户看的是进展，不是心情。
 */
export function stageBrief(plan: StagePlan): { done: number; total: number; current?: string; finalized?: boolean } {
  const done = plan.stages.filter((s) => s.status === "done" || s.status === "skipped").length;
  const active = plan.stages.filter((s) => s.status === "active");
  const blocked = plan.stages.find((s) => s.status === "blocked");
  const current = blocked?.title ?? active[0]?.title;
  return {
    done,
    total: plan.stages.length,
    ...(current ? { current } : {}),
    ...(plan.finalized ? { finalized: true } : {}),
  };
}

/**
 * 一句话进度：写进提示词与卡片，让模型不用自己数（它会数错，也会反复查）。
 * 形如「阶段 2/5 · 勘察与前提（进行中）；下一步：产出落盘」。
 */
export function stageLine(plan: StagePlan): string {
  const total = plan.stages.length;
  const done = plan.stages.filter((s) => s.status === "done" || s.status === "skipped").length;
  const active = plan.stages.filter((s) => s.status === "active");
  const blocked = plan.stages.find((s) => s.status === "blocked");
  const nextId = stagePlanProgress(plan).next;
  const nextTitle = nextId ? plan.stages.find((s) => s.id === nextId)?.title ?? nextId : "";
  const label = `阶段 ${done}/${total}`;
  if (plan.finalized) return `${label} · 已收尾`;
  if (blocked) return `${label} · 「${blocked.title}」受阻：${blocked.note ?? "未写原因"}`;
  if (active.length) {
    const cur = active.map((s) => `「${s.title}」`).join("、");
    return `${label} · ${cur}进行中${nextTitle && nextTitle !== active[0]?.title ? `；下一步：${nextTitle}` : ""}`;
  }
  return nextTitle ? `${label} · 下一步：${nextTitle}` : `${label} · 全部阶段已结束，待收尾`;
}

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
