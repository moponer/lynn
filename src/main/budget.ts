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
  /** 命中缓存的前缀 token（端点没报就是缺省——不估假数） */
  cacheRead?: number;
  /** 写入缓存 / 未命中的输入 token */
  cacheWrite?: number;
}

const USAGE_FILE = "usage.jsonl";
const USAGE_ROTATED = "usage.1.jsonl";
/** 记账文件轮转阈值（2026-11-14）：cleanup 只清 *.log，这个 .jsonl 过去只增不减 */
const USAGE_MAX_BYTES = 5 * 1024 * 1024;

/** 按次记账：append 一行（损坏不炸，只是这条没记上——如实容忍） */
export function appendUsage(dataRoot: string, line: UsageLine, maxBytes = USAGE_MAX_BYTES): void {
  try {
    const dir = path.join(dataRoot, "logs");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, USAGE_FILE);
    // 轮转：只保留一份历史（读侧只取最后 N 行，"最近用量"不受影响）
    try {
      if (fs.statSync(file).size > maxBytes) fs.renameSync(file, path.join(dir, USAGE_ROTATED));
    } catch {
      /* 首次没有文件 */
    }
    fs.appendFileSync(file, JSON.stringify(line) + "\n", "utf-8");
  } catch {
    /* 磁盘问题不阻塞对话 */
  }
}

export function readUsage(dataRoot: string, lastN = 50): UsageLine[] {
  // lastN<=0 要返回空：`slice(-0)` 等于 `slice(0)`，会返回**全部**（边界探测抓到的）
  const n = Math.max(0, Math.trunc(lastN) || 0);
  if (n === 0) return [];
  const dir = path.join(dataRoot, "logs");
  const readLines = (name: string): string[] => {
    try {
      return fs.readFileSync(path.join(dir, name), "utf-8").split("\n").filter((x) => x.trim());
    } catch {
      return [];
    }
  };
  const main = readLines(USAGE_FILE);
  // 主文件不够 N 行时补上轮转文件的历史（刚轮转过的那一小段不该丢）
  const lines = main.length >= n ? main : [...readLines(USAGE_ROTATED), ...main];
  const out: UsageLine[] = [];
  for (const l of lines.slice(-n)) {
    try {
      out.push(JSON.parse(l) as UsageLine);
    } catch {
      /* 坏行跳过，不整段失败 */
    }
  }
  return out;
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
