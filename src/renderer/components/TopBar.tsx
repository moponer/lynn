import type { PermissionMode, SessionSnapshot } from "../../shared/contract";

const HINTS: Record<PermissionMode, string> = {
  plan: "只读分析：她只能看和想，动手前必须先出计划",
  ask: "写操作、外联、越权都先问你",
  auto: "普通工作区操作自动执行，越权时先问她、她再问你",
  full: "关闭工作区沙箱——只给你完全信任的项目",
};

const MODES: PermissionMode[] = ["plan", "ask", "auto", "full"];

export function TopBar({
  snap,
  theme,
  onMode,
  onTheme,
}: {
  snap: SessionSnapshot;
  theme: "dark" | "light";
  onMode: (m: PermissionMode) => void;
  onTheme: () => void;
}) {
  return (
    <header className="topbar">
      <div className="ws">
        <span className="dot" />
        {snap.workspace.project}
        <small>/ {snap.workspace.subdir}</small>
      </div>
      <div className="perm">
        {MODES.map((m) => (
          <button key={m} className={snap.permission === m ? "on" : ""} onClick={() => onMode(m)}>
            {m}
          </button>
        ))}
      </div>
      <span className="perm-hint">{HINTS[snap.permission]}</span>
      <div className="top-right">
        <span className="model-chip">
          模型 <b>{snap.model.name}</b>
          {snap.model.thinking ? " · 思考" : ""}
        </span>
        <span className="cost">
          本月 <b>¥{snap.board.budget.costYuan.toFixed(2)}</b>
        </span>
        <button className="iconbtn" onClick={onTheme} title="明暗主题">
          {theme === "dark" ? "☾" : "☀"}
        </button>
        <button className="iconbtn" title="待机 /standby">铃</button>
      </div>
    </header>
  );
}
