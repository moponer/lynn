// 自绘标题栏按钮（frame:false）：最小化 / 最大化-还原 / 关闭。
// 状态由壳层广播（window 事件）+ 初次 query；关闭走 win.close()，尊重"关窗进托盘"设置。
import { useEffect, useState } from "react";
import { Icon } from "./Icon";
import { useT } from "../i18n";

export function WindowControls({ className = "" }: { className?: string }) {
  const t = useT();
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    let alive = true;
    void window.lynn
      .rpc("window.control", { action: "query" })
      .then((r) => {
        if (alive) setMaximized(r.maximized);
      })
      .catch(() => undefined);
    const off = window.lynn.onEvent((ev) => {
      if (ev.type === "window") setMaximized(ev.maximized);
    });
    return () => {
      alive = false;
      off();
    };
  }, []);

  const ctl = (action: "minimize" | "maximize" | "close") => {
    void window.lynn
      .rpc("window.control", { action })
      .then((r) => setMaximized(r.maximized))
      .catch(() => undefined);
  };

  return (
    <div className={`win-ctl${className ? ` ${className}` : ""}`}>
      <button type="button" className="win-btn" onClick={() => ctl("minimize")} title={t("win.minimize")} aria-label={t("win.minimize")}>
        <Icon name="minimize" size="sm" />
      </button>
      <button
        type="button"
        className="win-btn"
        onClick={() => ctl("maximize")}
        title={maximized ? t("win.restore") : t("win.maximize")}
        aria-label={maximized ? t("win.restore") : t("win.maximize")}
      >
        <Icon name={maximized ? "restore" : "maximize"} size="sm" />
      </button>
      <button type="button" className="win-btn close" onClick={() => ctl("close")} title={t("win.close")} aria-label={t("win.close")}>
        <Icon name="x" size="sm" />
      </button>
    </div>
  );
}
