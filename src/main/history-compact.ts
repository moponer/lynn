/**
 * 工具历史折叠（2026-11-16 日志复盘的第二块根因）。
 *
 * 实测：一张 30 轮的单累计 135.9 万 prompt，其中约 74% 是"把前面读过的内容
 * 重新发一遍"——messages 只增不减，第 n 轮要重放前 n-1 轮的全部工具输出。
 * 低成本改法不是删消息（会破坏 assistant.tool_calls ↔ tool 的配对，端点直接 400），
 * 而是**把较早的 tool 结果原地折成开头+结尾**：消息还在、id 还在、content 非空。
 *
 * 两个必须注意的点：
 *  1. 折叠文本必须**确定性**（只依赖原文，不带轮次号/时间）——否则每次折叠出来的
 *     内容都不同，前缀缓存逐轮失效，省下的重放又按全价付回去。
 *  2. 折叠后模型若想重看，read_file 必须能重新给出全文。Toolkit 的"内容未变"
 *     记忆是同一实例级的，所以调用方折叠后要清一次（see Toolkit.forgetReads）。
 */

import type { ChatMessage } from "./llm";

/** 折叠标记：判定"这条已经折过"靠它，别在别处改这段文案 */
export const FOLD_MARK = "[已折叠]";

/**
 * 折叠窗口（保留最近多少条工具结果原文）。
 * 默认 6（约 2–3 个工具轮）：再小会让成员"忘了刚读过什么"而重读，反而更贵；
 * 再大则重放成本回升。实机调参用 LYNN_COMPACT_KEEP，无需改 UI。
 */
export function compactKeepRecent(env: Record<string, string | undefined> = process.env): number {
  const raw = Number(env.LYNN_COMPACT_KEEP);
  if (!Number.isFinite(raw) || raw < 2) return 6;
  return Math.min(Math.floor(raw), 20);
}

/**
 * 未折叠的工具结果条数（判定"该不该折"用）。
 * 已折的以 FOLD_MARK 开头，所以这个数就是"自上次折叠以来新增了多少条"。
 */
export function countUnfoldedTools(messages: ChatMessage[], fromIndex = 0): number {
  let n = 0;
  for (let i = Math.max(0, fromIndex); i < messages.length; i += 1) {
    const m = messages[i];
    if (m.role !== "tool") continue;
    if (!String(m.content ?? "").startsWith(FOLD_MARK)) n += 1;
  }
  return n;
}

/**
 * 分代折叠阈值（2026-11-17 缓存修复 B2）。
 *
 * 滑窗每轮折一次 = **每轮一个缓存断点**（实测成员命中率被压到 81.5% 的主因）。
 * 改成"未折满 N 条才折一次"后，断点频率降到约 1/N，两次折叠之间前缀完全稳定。
 */
export function compactThreshold(env: Record<string, string | undefined> = process.env): number {
  return compactKeepRecent(env) * 2; // 默认 12
}

export interface CompactOptions {
  /** 保留最近多少条工具结果原文（默认 6：约 2–3 个工具轮） */
  keepRecent?: number;
  headChars?: number;
  tailChars?: number;
  /** 短于此长度的结果不折——短结果本身就是结论，折了只剩噪音 */
  minChars?: number;
  /**
   * 只处理这个下标及之后的消息（默认 0）。
   * 巡检轮用它把"历史前缀"排除在外：历史是缓存主体，折它等于让前缀失效。
   */
  fromIndex?: number;
}

export interface CompactOutcome {
  messages: ChatMessage[];
  folded: number;
  savedChars: number;
}

/**
 * 纯函数：返回**新数组**（折叠过的位置换新对象，其余位置保持原引用）。
 * 不修改入参，调用方要原地生效需自行 splice（见成员运行时与巡检路径）。
 */
export function compactToolHistory(messages: ChatMessage[], opts: CompactOptions = {}): CompactOutcome {
  const keepRecent = Math.max(0, opts.keepRecent ?? 6);
  const headChars = Math.max(0, opts.headChars ?? 400);
  const tailChars = Math.max(0, opts.tailChars ?? 300);
  const minChars = Math.max(0, opts.minChars ?? 1200);
  const fromIndex = Math.max(0, opts.fromIndex ?? 0);

  const toolIdx: number[] = [];
  for (let i = fromIndex; i < messages.length; i += 1) {
    if (messages[i].role === "tool") toolIdx.push(i);
  }
  if (toolIdx.length <= keepRecent) return { messages, folded: 0, savedChars: 0 };

  const cutoff = toolIdx.length - keepRecent;
  const out = messages.slice();
  let folded = 0;
  let savedChars = 0;

  for (let k = 0; k < cutoff; k += 1) {
    const at = toolIdx[k];
    const msg = out[at];
    const text = String(msg.content ?? "");
    if (text.startsWith(FOLD_MARK)) continue;
    if (text.length < minChars) continue;
    const head = text.slice(0, headChars);
    const tail = text.slice(Math.max(headChars, text.length - tailChars));
    const note =
      `${FOLD_MARK}早期工具结果（原文 ${text.length} 字符）已折叠，只保留开头与本条结尾。\n` +
      `${head}\n…\n${tail}\n` +
      "需要原文请重新调用对应工具（文件未改动时会重新给出全文）。";
    out[at] = { ...msg, content: note };
    folded += 1;
    savedChars += text.length - note.length;
  }

  return { messages: out, folded, savedChars };
}
