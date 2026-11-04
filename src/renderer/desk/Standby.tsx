import { useEffect, useState } from "react";
import type { AmbientMode, AmbientParams } from "../../shared/ambient";
import { AmbientLayer } from "./AmbientLayer";
import { WindowControls } from "../components/WindowControls";
import type { Desk } from "./model";

/**
 * 待机模式（计划书 §2.4 的"应用内屏保"）：
 * 全窗口动效 + 时间/日程浮层；任意输入回到工作界面。不接管系统屏保/壁纸。
 */
export function Standby({
  desk,
  ambient,
  mode,
  onExit,
}: {
  desk: Desk;
  ambient: AmbientParams;
  mode: AmbientMode;
  onExit: () => void;
}) {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    // 点任意位置唤醒；唯独窗口按钮区不唤醒（否者点关闭前就先把自己叫醒）
    const wake = (e: Event) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest?.(".win-ctl")) return;
      onExit();
    };
    window.addEventListener("keydown", wake);
    window.addEventListener("pointerdown", wake);
    return () => {
      window.removeEventListener("keydown", wake);
      window.removeEventListener("pointerdown", wake);
    };
  }, [onExit]);

  const waiting = desk.jobs.filter((j) => j.status === "in_review" || j.status === "blocked").length;
  const running = desk.jobs.filter((j) => j.status === "in_progress").length;
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const date = now.toLocaleDateString("zh-CN", { month: "long", day: "numeric", weekday: "long" });

  return (
    <div className="standby">
      <AmbientLayer params={ambient} mode={mode} standby />
      {/* 自绘标题栏：无边框窗口在待机页也要能拖动与关闭 */}
      <div className="sb-drag" />
      <WindowControls className="sb-win" />
      <div className="sb-center">
        <div className="sb-clock">
          {hh}
          <span>:</span>
          {mm}
        </div>
        <div className="sb-date">{date}</div>
        <div className="sb-stats">
          {waiting > 0 ? <span className="sb-wait">等你拍板 {waiting}</span> : <span>没有等你的事</span>}
          <span className="sb-sep">·</span>
          <span>进行中 {running}</span>
          {desk.archived.length > 0 && (
            <>
              <span className="sb-sep">·</span>
              <span>已归档 {desk.archived.length}</span>
            </>
          )}
        </div>
        {desk.decisions[0] && (
          <div className="sb-decide">
            {desk.decisions[0].question}
            {desk.decisions.length > 1 ? `（待处理 ${desk.decisions.length}）` : ""}
          </div>
        )}
      </div>
      <div className="sb-hint">
        <span className="mono">任意输入回到工作界面</span>
        <span className="sb-sep">·</span>
        <span className="mono">动效 {mode === "off" ? "已关闭" : mode === "low" ? "低配" : "全开"}</span>
      </div>
    </div>
  );
}
