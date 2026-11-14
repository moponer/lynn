// 计时 hook（2026-11-14 独立成文件）：Desk 与 Composer 都用它，留在 Desk 里会形成循环引用。
import { useEffect, useState } from "react";

/**
 * 状态行计时（对齐蓝本 tether-ai 的 Elapsed：500ms 一跳）。
 * 只在这一轮真的在跑时才开定时器，结束后停掉——不留空转 interval。
 */
export function useTick(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(id);
  }, [active]);
  return now;
}
