/**
 * 提示词编译器（2026-11-17 P2-1c）。
 *
 * 为什么要有这一层：system prompt 此前是在 `kernel.systemPrompt()` 里用 `+`
 * 拼起来的匿名字符串——没人能回答"它现在多少字、哪一段最贵、改了之后变化在哪"。
 * 每次改 persona 或记忆格式，只能靠肉眼比对整段输出，改完也不知道是不是只动了想动的那一段。
 *
 * 这里把「组装」抽成纯函数：
 *  - **纯**：不读磁盘、不读设置、不依赖时间——同样的输入永远同样的输出（可快照、可断言）；
 *  - **有序**：段的顺序固定，改动必须显式调换（顺序决定前缀缓存的稳定性）；
 *  - **可量**：返回每段的字符数，能直接看出"谁在吃预算"。
 *
 * 注意：**不在这里做瘦身**。这一段只负责"让现状可测"；
 * 压缩某段时必须先有 golden 快照兜底，否则改坏了没人知道。
 */

import { createHash } from "node:crypto";

/** 组成 system prompt 的各段（顺序即最终拼接顺序，不要随意调换） */
export interface LynnPromptParts {
  /** 固定头 + 用户 persona + 固定尾（见 persona.composeSystemPrompt） */
  persona: string;
  /** 记忆两层（助理记忆 + 用户记忆 + 项目记忆），会话内冻结 */
  memory: string;
  /** 项目身份与指代纪律 */
  project: string;
  /** 环境事实（真实路径，防猜） */
  environment: string;
  /** 写作规则（外部插件；未装/关闭时为空串） */
  rules: string;
}

export interface PromptSegment {
  name: keyof LynnPromptParts;
  chars: number;
}

export interface CompiledPrompt {
  text: string;
  segments: PromptSegment[];
  chars: number;
  /** 内容指纹（sha256 前 16 位）：用于"同一份提示词"的跨会话比对 */
  digest: string;
}

/** 拼接顺序：身份 → 记忆 → 项目 → 环境 → 规则。改动这里等于改所有会话的前缀。 */
const ORDER: (keyof LynnPromptParts)[] = ["persona", "memory", "project", "environment", "rules"];

/**
 * 编译 system prompt。空段原样跳过（不产生多余空行）——
 * 比如没装写作规则插件时，输出与"从来没这个功能"完全一致。
 */
export function compileLynnPrompt(parts: LynnPromptParts): CompiledPrompt {
  const segments: PromptSegment[] = [];
  let text = "";
  for (const name of ORDER) {
    const s = parts[name] ?? "";
    segments.push({ name, chars: s.length });
    text += s;
  }
  return { text, segments, chars: text.length, digest: promptDigest(text) };
}

/** 内容指纹：只用于比对"是不是同一份"，不做安全用途 */
export function promptDigest(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex").slice(0, 16);
}

/**
 * 粗略 token 估算（与我们的脚本/日志同口径）：CJK 一字≈1 token，其余≈4 字符 1 token。
 * 只用于"这段贵不贵"的判断，不用于计费。
 */
export function estimateTokens(text: string): number {
  const cjk = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
  return Math.round(cjk + (text.length - cjk) / 4);
}
