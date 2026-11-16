/**
 * 凭据打码的唯一实现（2026-11-16 合并）。
 *
 * 背景：原先 `src/main/endpoint.ts`（错误体/日志）与 `src/main/memory.ts`（项目记忆落盘）
 * 各写了一份 redactSecrets，覆盖的令牌形态不一样——endpoint 认得 Bearer 与 `xx key=value`，
 * memory 认得 ghp_/xox/AKIA，同一个 Key 在一处被打码、在另一处照样落盘。
 * 现在只有这一份，任何新形态往 RULES 里加，别在调用方就地写正则。
 *
 * 规则顺序有讲究：先干掉整个 Bearer/Basic/PEM 块，再按前缀打码（sk-/ghp_/xox/AKIA），
 * 最后才做 `key=value` 兜底——反过来的话前缀令牌会被兜底规则先切成半截。
 */

/** [正则, 替换]；替换文本里的 $1 保留键名/前缀，便于人看出"这里原本是什么" */
const RULES: Array<[RegExp, string]> = [
  // 整块凭据：PEM 私钥先于其它规则（内部含大量 -/_，避免被后续规则切碎）
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[私钥内容已打码]"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{6,}/gi, "Bearer ***"],
  [/\bBasic\s+[A-Za-z0-9+/=]{12,}/gi, "Basic ***"],
  // 带前缀的公开形态令牌
  [/\bsk-[A-Za-z0-9_-]{8,}/g, "sk-***"],
  [/\bgh[pousr]_[A-Za-z0-9]{16,}\b/g, "ghp_***"],
  [/\bxox[baprs]-[A-Za-z0-9-]{8,}\b/g, "xox*-***"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "AKIA***"],
  // key=value 兜底。负向断言是必须的：`max_tokens=100000`、`total_tokens` 这类计数键
  // 不是凭据，按 \b 边界会在 `_` 处成立而误伤（此前错误体里的数值被吞过）。
  [
    /(?<![A-Za-z0-9_-])(api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|auth[_-]?token|id[_-]?token|token|secret|client[_-]?secret|password|passwd|pwd)["']?\s*[:=]\s*["']?([^\s"',;}\]]{6,})/gi,
    "$1=***",
  ],
];

export function redactSecrets(text: string): string {
  let out = String(text ?? "");
  for (const [re, to] of RULES) out = out.replace(re, to);
  return out;
}
