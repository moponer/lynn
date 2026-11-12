// 派单内容级去重（2026-11-11 长任务实测：同一阶段反复重派 24 次、招募 16 人、
// check_progress 空转 246 次）。并发闸只按 taskId，模型每次重派都拿新 ID，全部绕开。
// 这里按「同团队 + 同成员 + 相似标题」识别"其实就是同一件事又派了一遍"。

export interface ExistingAssignment {
  taskId: string;
  title: string;
  member: string;
  teamId?: string;
  status: string;
}

const TERMINAL = new Set(["done", "canceled", "cancelled", "archived", "accepted"]);
// 重派标题里的噪声：「（workspace 重派）」「（A2 承接）」「（最终版）」「·并行备份」…
const NOISE = /重派|替补|承接|备份|并行|最终版|第一版|复核|前置|最小调用集|workspace|重开|再次|重新|第?\d+版|[（(][^）)]*[）)]|[\s·、，,。:：\-_/\\]/g;

/** 归一化标题：去掉重派后缀与标点，让「阶段5-A 统计…」与「阶段5-A 统计…（A2 承接）」可比。 */
export function normalizeAssignmentTitle(s: string): string {
  return String(s ?? "").toLowerCase().replace(NOISE, "");
}

function bigrams(s: string): Set<string> {
  const t = normalizeAssignmentTitle(s);
  const out = new Set<string>();
  for (let i = 0; i < t.length - 1; i += 1) out.add(t.slice(i, i + 2));
  if (!out.size && t) out.add(t);
  return out;
}

/** 包含式相似度：短标题是长标题的子串时接近 1（重派标题常更短）。 */
export function assignmentSimilarity(a: string, b: string): number {
  const A = bigrams(a);
  const B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter += 1;
  return inter / Math.min(A.size, B.size);
}

/**
 * 找到「同一件事」的未终态工单；命中时调用方应拒绝新派单，提示改用
 * nudge_member / check_progress / review_result / stop_task。
 */
export function findDuplicateAssignment(
  existing: readonly ExistingAssignment[],
  input: { title: string; member: string; teamId?: string },
  threshold = 0.72,
): ExistingAssignment | null {
  for (const t of existing) {
    if (TERMINAL.has(t.status)) continue;
    if (t.member !== input.member) continue;
    if (input.teamId && t.teamId && t.teamId !== input.teamId) continue;
    if (assignmentSimilarity(t.title, input.title) >= threshold) return t;
  }
  return null;
}
