/**
 * 工具二级加载（2026-11-17 P4-2 / 10 章 §4，D7）。
 *
 * 问题：工具面是**每次调用都要付**的固定成本，而绝大多数成员只用得上其中几件。
 * 一个写文档的成员不该每轮背着 `ssh_run` 和 7 个 browser_* 的 schema。
 *
 * 做法：热路径工具常驻，长尾工具按需（`tool_search` 搜到 → 下一轮起可调）。
 *
 * **与计划书的偏差，以及为什么**（10 章 §4 写的是「核心 6 件 + ≤700 tokens」）：
 *
 * 基线实测（`bench:tool-usage`，37 张单）的工具分布是
 * `read_file×878 · grep×487 · list_dir×418 · glob×64`。`list_dir` 与 `glob` 是**热路径**，
 * 把它们藏到 tool_search 后面，等于让成员每用一次"看目录"就多花一轮——而轮次正是
 * 另一个要压的指标（53 → ≤12）。省 token 却多一轮，是笔赔本买卖。
 *
 * 所以这里定的是**按实测热路径**的常驻集，而不是照抄六件套；并且只在
 * **工具面本来就大**（> LAZY_THRESHOLD）时才启用二级加载：工具有限时它省不了多少，
 * 却要把每一次调用都赌在"模型会不会想到去搜"上。
 */

import type { ToolSchema } from "./llm";

/**
 * 常驻工具（热路径）。依据：baseline 日志里的实际调用分布 + 回报通道必须在。
 * `submit_report` / `post_message` 是通道，不进 toolkit schema，由 member-runner 另行附加。
 */
export const HOT_TOOLS: readonly string[] = [
  "read_file",
  "write_file",
  "edit_file",
  "list_dir",
  "glob",
  "grep",
  "run_command",
];

/**
 * 只有工具面超过这个数才启用二级加载。
 * 等于这个数或更少时全量发送——那点 token 不值得拿"每次调用多一轮"去换。
 */
export const LAZY_THRESHOLD = 8;

/** `tool_search` 自身的 schema（常驻，很小） */
export const TOOL_SEARCH_SCHEMA: ToolSchema = {
  type: "function",
  function: {
    name: "tool_search",
    description:
      "搜本次没发下来的工具（长尾工具按需加载）。传一句话说明你要干什么，命中后**下一轮就能直接调用**。" +
      "例：`写 Word`、`抓网页`、`翻表格`、`按符号找函数`。两个都搜不到就直接干或回报说缺工具，不要反复搜。",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "你要做的事（用动词说，别只写工具名）" },
      },
      required: ["query"],
    },
  },
};

export interface ToolMatch {
  name: string;
  /** 命中说明（给模型看：为什么这件工具符合） */
  why: string;
}

/**
 * 在一个候选集里按自然语言搜工具。
 *
 * 排序刻意简单可解释：工具名直接命中 > 描述里的关键词命中 > 单字重合。
 * 不搞 embedding——离线、确定性、一次调用就要出结果，且要能回答"为什么是它"。
 */
export function searchTools(query: string, candidates: readonly ToolSchema[], limit = 4): ToolMatch[] {
  const q = String(query ?? "").trim().toLowerCase();
  if (!q) return [];
  // 中英混排：按非字词切，丢掉太短的虚词
  const tokens = q.split(/[\s,，。、/\\()（）:：;；"'`]+/).filter((t) => t.length >= 2);
  const scored: { name: string; score: number; why: string }[] = [];
  for (const t of candidates) {
    const name = t.function.name.toLowerCase();
    const desc = String(t.function.description ?? "").toLowerCase();
    let score = 0;
    const why: string[] = [];
    if (name === q) {
      score += 100;
      why.push("名字完全一致");
    } else if (name.includes(q) || q.includes(name)) {
      score += 40;
      why.push(`名字相关（${t.function.name}）`);
    }
    for (const tok of tokens) {
      if (name.includes(tok)) {
        score += 12;
        why.push(`名字含「${tok}」`);
      } else if (desc.includes(tok)) {
        score += 4;
        why.push(`描述含「${tok}」`);
      }
    }
    if (score > 0) scored.push({ name: t.function.name, score, why: [...new Set(why)].slice(0, 2).join("；") });
  }
  return scored
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map((s) => ({ name: s.name, why: s.why }));
}

export interface MemberSurface {
  /** 本次该发给模型的工具名（已按热路径 + 已解锁 + 通道算好） */
  names: string[];
  /** 是否启用了二级加载 */
  lazy: boolean;
  /** 还没加载、可用 tool_search 搜到的工具名 */
  hidden: string[];
}

/**
 * 算成员这一轮的工具面。
 *
 * @param assigned 本次派单分配的执行工具（白名单已收窄过）
 * @param unlocked 之前通过 tool_search 解锁的
 * @param lazyOn   设置开关（关掉就全量发送，用于回退）
 */
export function memberSurface(assigned: readonly string[], unlocked: ReadonlySet<string>, lazyOn: boolean): MemberSurface {
  const unique = [...new Set(assigned)];
  if (!lazyOn || unique.length <= LAZY_THRESHOLD) {
    return { names: unique.sort(), lazy: false, hidden: [] };
  }
  const resident = unique.filter((n) => HOT_TOOLS.includes(n) || unlocked.has(n));
  const hidden = unique.filter((n) => !resident.includes(n)).sort();
  return { names: resident.sort(), lazy: true, hidden };
}