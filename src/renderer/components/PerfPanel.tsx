import { useT } from "../i18n";
import { usePerfStats } from "../desk/perf-monitor";
import { describePerf, LONG_TASK_BUDGET_PER_MIN } from "../desk/perf";

/**
 * 性能面板（2026-11-17 P6-7 / 18 章 F6「设置页可见」）。
 *
 * 为什么单独成一个组件而不是塞进 SettingsModal：那一个文件已经 2,956 行，
 * 再往里加会让 F4（拆分）更难做。这里只依赖一个 hook，边界干净。
 *
 * 显示口径要诚实：
 *  - 长任务按**滚动 60 秒**算，不是"这一分钟"（清零法在边界上会骗人）；
 *  - 没采集到首屏就写"未采集到"，不写 0——0 看起来像"很快"；
 *  - 没有 PerformanceObserver 的环境（SSR/测试）显示"本环境不支持"，不装成有数据。
 *
 * 文案全走 t()（P6-8）：这个组件是 F8 lint 上线后新写的，不该一开始就留债。
 */
export function PerfPanel() {
  const t = useT();
  const { longTasks, fcpMs } = usePerfStats();
  const supported = typeof PerformanceObserver !== "undefined";
  const text = describePerf({ longTasks, fcpMs });

  return (
    <div className="sf-group">
      <div className="sf-group-head">
        <b>{t("perf.title")}</b>
        <small>{t("perf.budget", { n: LONG_TASK_BUDGET_PER_MIN })}</small>
      </div>
      {!supported ? (
        <p className="sf-empty">{t("perf.unsupported")}</p>
      ) : (
        <>
          <p className="sf-lede">{text}</p>
          {!longTasks.withinBudget && <p className="sf-empty">{t("perf.overBudget")}</p>}
          <p className="sf-empty">{t("perf.total", { n: longTasks.total })}</p>
        </>
      )}
    </div>
  );
}