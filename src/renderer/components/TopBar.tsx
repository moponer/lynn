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
  onSettings,
}: {
  snap: SessionSnapshot;
  theme: "dark" | "light";
  onMode: (m: PermissionMode) => void;
  onTheme: () => void;
  onSettings: () => void;
}) {
  const { model, board } = snap;
  return (
    <header className="topbar">
      <div className="ws">
        <span className="dot" style={{ background: model.configured ? "var(--accent)" : "var(--danger)" }} />
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
        <span className="model-chip" onClick={onSettings} title="点击配置模型">
          {model.configured ? (
            <>
              模型 <b>{model.model}</b>
              <small style={{ color: "var(--text-faint)" }}> · {model.provider}</small>
            </>
          ) : (
            <b style={{ color: "var(--danger)" }}>未配置模型 · 点此设置</b>
          )}
        </span>
        {board.tokensUsed > 0 && (
          <span className="cost">
            会话 <b>{(board.tokensUsed / 1000).toFixed(1)}K</b> tok
          </span>
        )}
        <button className="iconbtn" onClick={onTheme} title="明暗主题">
          {theme === "dark" ? "☾" : "☀"}
        </button>
        <button className="iconbtn" onClick={onSettings} title="设置">⚙</button>
      </div>
    </header>
  );
}
