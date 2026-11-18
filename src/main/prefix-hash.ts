/**
 * 前缀指纹（2026-11-17 / P1-5）。
 *
 * 用途：判断"这次请求的前缀与上次是否一致"。命中率掉下来时，
 * 光看 usage 的 hitRate 只能知道"掉了"，不知道"从哪条开始掉的"。
 * 有了指纹 + 变动原因，日志里能直接回答：
 *   cache_prefix_changed{ from:"a1b2", to:"c3d4", reason:"fold" }
 *
 * 只做轻量哈希（djb2），不上 crypto：每次请求都要算，同步开销必须可忽略。
 */

import type { ChatMessage, ToolSchema } from "./llm";

function djb2(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i += 1) {
    h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  }
  // 转无符号 + 36 进制，取 10 位，够区分且短
  return (h >>> 0).toString(36).padStart(7, "0").slice(-10);
}

/**
 * 前缀指纹：system + 工具名序列 + 消息（role:content 拼接）。
 * 不包含 usage 之类不影响前缀的字段；工具只取名字（描述变化同属前缀，但极少变）。
 */
export function prefixFingerprint(input: {
  messages: ChatMessage[];
  tools?: ToolSchema[];
  messageLimit?: number;
}): string {
  const limit = Math.max(1, input.messageLimit ?? input.messages.length);
  const parts: string[] = [];
  for (let i = 0; i < input.messages.length && i < limit; i += 1) {
    const m = input.messages[i];
    const content = typeof m.content === "string" ? m.content : "";
    parts.push(`${m.role}:${content.length}:${djb2(content)}`);
    const calls = (m as { tool_calls?: { function?: { name?: string } }[] }).tool_calls;
    if (calls?.length) parts.push(`calls:${calls.map((c) => c.function?.name ?? "").join(",")}`);
    if (m.role === "tool") parts.push(`tool:${(m as { tool_call_id?: string }).tool_call_id ?? ""}`);
  }
  const tools = (input.tools ?? []).map((t) => t.function.name).join(",");
  return djb2(`${tools}|${parts.join("|")}`);
}
