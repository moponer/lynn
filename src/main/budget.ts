// M2-11：成本记账（按次落盘）+ 软上限降级（§4.4 L605–606）。
//  - 记账：每次 API 调用一行 usage.jsonl（轮次/出入/模型），未知价如实——不估假费用。
//  - 软上限：超过 softBudgetTokens → 落卡提示 + 配置了备用模型才切换；**不静默停机**。
//  - 未配置预算（0）如实说"未设预算"，不做假保护。
import * as fs from "node:fs";
import * as path from "node:path";

export type BudgetMode = "none" | "normal" | "soft";

/** 软上限判定（纯函数）：预算 0 = 未配置（none，不做假保护） */
export function evaluateBudget(spentTokens: number, softBudgetTokens: number): { mode: BudgetMode; ratio: number } {
  if (!softBudgetTokens || softBudgetTokens <= 0) return { mode: "none", ratio: 0 };
  const ratio = spentTokens / softBudgetTokens;
  return { mode: ratio >= 1 ? "soft" : "normal", ratio };
}

export interface UsageLine {
  at: string;
  kind: "turn" | "schedule";
  in: number;
  out: number;
  model: string;
  /** 软超限后这一轮是否用了降级模型 */
  fallback?: boolean;
}

/** 按次记账：append 一行（损坏不炸，只是这条没记上——如实容忍） */
export function appendUsage(dataRoot: string, line: UsageLine): void {
  try {
    fs.mkdirSync(path.join(dataRoot, "logs"), { recursive: true });
    fs.appendFileSync(path.join(dataRoot, "logs", "usage.jsonl"), JSON.stringify(line) + "\n", "utf-8");
  } catch {
    /* 磁盘问题不阻塞对话 */
  }
}

export function readUsage(dataRoot: string, lastN = 50): UsageLine[] {
  try {
    const lines = fs.readFileSync(path.join(dataRoot, "logs", "usage.jsonl"), "utf-8").split("\n").filter((x) => x.trim());
    return lines.slice(-lastN).map((l) => JSON.parse(l) as UsageLine);
  } catch {
    return [];
  }
}

/** 降级决策：软超限 + 有备用模型才切；没有备用模型如实返回原因（不静默停机也不假装切换） */
export function pickModel(
  cfg: { model: string },
  fallback: string | undefined,
  mode: BudgetMode,
): { model: string; fallback: boolean; note?: string } {
  if (mode === "soft" && fallback && fallback.trim() && fallback.trim() !== cfg.model) {
    return { model: fallback.trim(), fallback: true, note: `已达软上限，本轮改用备用模型 ${fallback.trim()}（可继续工作，不静默停机）。` };
  }
  if (mode === "soft" && !fallback) {
    return { model: cfg.model, fallback: false, note: "已达软上限；未配置备用模型（prefs.fallbackModel），继续用当前模型。预算只能提示，不会自动停机。" };
  }
  return { model: cfg.model, fallback: false };
}
