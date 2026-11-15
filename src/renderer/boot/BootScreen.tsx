// 启动页（方案 C · 字标排版）：画面上只有 Lynn 字标、底色和一条进度线。
// 不加细线、菱形、tagline —— 那套装饰不属于项目现有的视觉语言。
//
// 进度不是假动画：0→90% 按时间推进后**停住等**，只有 session.snapshot 就绪
// （ready=true）才补到 100%，随后由 App 延迟卸载完成淡出交接。
import { useEffect, useState } from "react";

export function BootScreen({ ready }: { ready: boolean }) {
  const [pct, setPct] = useState(0);

  useEffect(() => {
    if (ready) {
      setPct(100);
      return;
    }
    const t0 = performance.now();
    let raf = 0;
    const tick = () => {
      const v = Math.min(90, ((performance.now() - t0) / 1100) * 90);
      setPct(v);
      if (v < 90) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [ready]);

  return (
    <div className={`boot${ready ? " boot-ready" : ""}`} role="status" aria-label="Lynn 正在启动">
      <div className="boot-wordmark">Lynn</div>
      <div className="boot-progress" aria-hidden="true">
        <i style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
