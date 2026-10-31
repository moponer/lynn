import type { BoardData, Member } from "../../shared/contract";

function statusDot(s: Member["status"]): string {
  return s === "running" ? "st-run" : s === "delivered" ? "st-wait" : "st-idle";
}

export function Board({
  board,
  onDecision,
}: {
  board: BoardData;
  onDecision: (id: string, action: "approve" | "reject" | "ask") => void;
}) {
  const { team, track, decisions, budget } = board;
  const pct = Math.round((budget.teamUsed / budget.teamTotal) * 100);
  return (
    <aside className="board">
      {team && (
        <div className="panel">
          <h3>在编团队 · {team.name}</h3>
          <div className="team-name">
            <b>{team.name}</b>
            <small>
              在职 {team.members.filter((m) => m.status !== "idle").length} · 空闲{" "}
              {team.members.filter((m) => m.status === "idle").length}
            </small>
          </div>
          {team.members.map((m) => (
            <div className="member" key={m.id}>
              <div className="m-avatar" style={{ background: m.color }}>
                {m.name[0]}
              </div>
              <div className="m-info">
                <div className="m-name">
                  {m.name} <span className={`st-dot ${statusDot(m.status)}`} />
                  <small>{m.role}</small>
                </div>
                <div className="m-role">{m.statusNote}</div>
                <div className={`meter${m.rejections > 0 ? " warn" : ""}`}>
                  <i style={{ width: `${m.progress}%` }} />
                </div>
                <div className="meter-cap">
                  <span>
                    预算 {m.budgetUsed}K / {m.budgetTotal}K tok
                  </span>
                  {m.rejections > 0 ? <span>打回 {m.rejections}/3</span> : <span>回合 12/40</span>}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="panel">
        <h3>任务轨道</h3>
        {track.map((t) => (
          <div className="task-item" key={t.id}>
            <div className={`t-pip ${t.status === "running" ? "t-run" : t.status === "waiting" ? "t-wait" : "t-done"}`} />
            <div>
              <b>{t.title}</b>
              <small>{t.statusNote}</small>
            </div>
          </div>
        ))}
      </div>

      <div className="panel">
        <h3>
          待你拍板<span className="cnt">{decisions.length}</span>
        </h3>
        {decisions.map((d) => (
          <div
            className="decision"
            key={d.id}
            onClick={() => onDecision(d.id, "approve")}
            title="点击批准；在频道内的审批卡里可选拒绝/问她"
          >
            <div className="d-title">
              <span className="from">{d.from}</span>
              {d.title}
            </div>
            <p>{d.detail}</p>
          </div>
        ))}
        {decisions.length === 0 && <p className="dim" style={{ fontSize: 12 }}>暂无待办，她在盯着。</p>}
      </div>

      <div className="panel">
        <h3>本周预算 · 双预算制</h3>
        <div className="meter" style={{ height: 6 }}>
          <i style={{ width: `${pct}%` }} />
        </div>
        <div className="meter-cap" style={{ marginTop: 5 }}>
          <span>
            团队 {budget.teamUsed}K / {budget.teamTotal}K tok
          </span>
          <span style={{ color: "var(--accent-2)" }}>软阈值 60%</span>
        </div>
        <div style={{ display: "flex", gap: 14, marginTop: 8, fontSize: 11.5, color: "var(--text-dim)" }}>
          <span>
            她（强模型）<b style={{ color: "var(--lynn)" }}> {budget.lynnUsed}K</b>
          </span>
          <span>
            成员（中档）<b style={{ color: "var(--text)" }}> {budget.membersUsed}K</b>
          </span>
          <span style={{ marginLeft: "auto" }}>¥{budget.costYuan.toFixed(2)}</span>
        </div>
      </div>
    </aside>
  );
}
