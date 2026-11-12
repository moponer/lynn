// 任务规模与证据策略（2026-11-11）。
//
// 实机问题：小任务也按 15 轮 / 300K 预算跑，证据缺失直接把工单卡在执行中；
// 而关键任务（审计/对账/安全）又确实需要证据兜底。这里把两件事拆开：
//  - 规模 → 轮次/预算/时限（小任务不该拿大任务的配置）
//  - 证据 → 默认可选，只有关键任务强制；推荐由 assign_task 自动判定，也允许显式覆盖
//
// 纯函数，不读盘、不碰状态，便于单测与被内核/管理工具共用。

export type TaskScale = "small" | "medium" | "large";
export type EvidencePolicy = "required" | "optional";

/** 多阶段/长流程信号：命中就不再当小任务。 */
const MULTI_STAGE = /阶段|流水线|并行|分别|同时完成|端到端|全流程|验收表|整套|多个子任务/;
/** 关键任务信号：这些活没有证据就没法判断对错，强制证据。 */
const EVIDENCE_HINT = /证据|核实|复核|可验证|复跑|复现|对账|审计|安全|合规|留痕|可追溯/;

/**
 * 粗略规模判定（宁可保守）：
 * - small：简报 ≤400 字、验收项 ≤2、没有多阶段信号
 * - large：简报 ≥1200 字，或多阶段信号，或验收项 ≥4
 * - 其余 medium
 */
export function estimateTaskScale(brief: string, acceptance: readonly string[] = []): TaskScale {
  const text = String(brief ?? "");
  const multi = MULTI_STAGE.test(text) || acceptance.length >= 4;
  if (text.length >= 1200 || multi) return "large";
  if (text.length <= 400 && acceptance.length <= 2) return "small";
  return "medium";
}

export interface ScaleLimits {
  maxTurns: number;
  budgetTokens: number;
  wallClockMin: number;
  /** 建议并行成员上限（只作提示，不替代 maxParallelMembers 的全局闸） */
  suggestMembers: number;
}

/** 按规模给执行预算：小任务 8 轮 120K，避免一上来就 15 轮 300K。 */
export function scaleLimits(scale: TaskScale): ScaleLimits {
  switch (scale) {
    case "small":
      return { maxTurns: 8, budgetTokens: 120_000, wallClockMin: 15, suggestMembers: 1 };
    case "large":
      return { maxTurns: 18, budgetTokens: 300_000, wallClockMin: 30, suggestMembers: 3 };
    default:
      return { maxTurns: 12, budgetTokens: 200_000, wallClockMin: 20, suggestMembers: 2 };
  }
}

/** 证据是否强制：显式优先；否则看简报/验收里有没有关键任务信号。 */
export function requiresEvidence(
  brief: string,
  acceptance: readonly string[] = [],
  explicit?: EvidencePolicy,
): boolean {
  if (explicit) return explicit === "required";
  return EVIDENCE_HINT.test(`${brief ?? ""}\n${acceptance.join("\n")}`);
}

export function resolveEvidencePolicy(
  brief: string,
  acceptance: readonly string[] = [],
  explicit?: EvidencePolicy,
): EvidencePolicy {
  return requiresEvidence(brief, acceptance, explicit) ? "required" : "optional";
}
