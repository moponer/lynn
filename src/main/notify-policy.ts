/**
 * 系统通知白名单（2026-11-11）：
 * 只有「用户必须动手」的错误才发桌面通知；5xx/429/网络抖动/超时都是运行期瞬态，
 * 落 feed 即可，否则右下角会反复弹「风铃遇到了问题」。
 */
const NEEDS_USER = new Set(["auth_401", "no_model", "worker_crashed"]);

export function needsUserAttention(code?: string | null): boolean {
  return Boolean(code) && NEEDS_USER.has(String(code));
}
