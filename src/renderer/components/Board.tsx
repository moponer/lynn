import type { BoardData, Decision } from "../../shared/contract";

function statusDot(s: Member["status"]): string {
  return s === "running" ? "st-run" : s === "delivered" ? "st-wait" : "st-idle";
}

type Member = BoardData["teams"][number]["members"][number];

function onDecisionClick(d: Decision, onDecision: (id: string, a: "approve" | "reject" | "ask") => void) {
  void onDecision(d.id, "approve");
}

export function Board({
  board,
  onDecision,
}: {
  board: BoardData;
  onDecision: (id: string, action: "approve" | "reject" | "ask") => void;
}) {
  const activeTeams = board.teams.filter((t) => t.status !== "dissolved");
  return (
    <aside className="board">
      <div className="panel">
        <h3>在编团队</h3>
        {activeTeams.length === 0 ? (
          <p className="dim panel-empty">
            她还没有编制。派第一件需要动手的活，她会自己招人组队——岗位档案都在 ~/.lynn/team/ 里，你可以直接打开改。
          </p>
        ) : (
          activeTeams.map((t) => (
            <div key={t.id} style={{ marginBottom: t.id === activeTeams[activeTeams.length - 1].id ? 0 : 10 }}>
              <div className="team-name">
                <b>{t.name}</b>
                <small>{t.members.length} 名成员</small>
              </div>
              {t.members.map((m) => (
                <div className="member" key={m.name}>
                  <div className="m-avatar" style={{ background: m.color }}>{m.name[0]}</div>
                  <div className="m-info">
                    <div className="m-name">
                      {m.name} <span className={`st-dot ${statusDot(m.status)}`} />
                      <small>{m.role}</small>
                    </div>
                    <div className="m-role">{m.statusNote}</div>
                    <div className="meter">
                      <i style={{ width: `${m.progress}%` }} />
                    </div>
                    <div className="meter-cap">
                      <span>白名单 {m.toolWhitelist.length} 工具</span>
                      {m.rejections > 0 ? <span>打回 {m.rejections}/3</span> : null}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ))
        )}
      </div>

      <div className="panel">
        <h3>任务轨道</h3>
        {board.track.length === 0 ? (
          <p className="dim panel-empty">还没有任务在轨道上。卷宗按任务归档在 ~/.lynn/tasks/。</p>
        ) : (
          board.track.map((t) => (
            <div className="task-item" key={`${t.teamId}-${t.id}`}>
              <div className={`t-pip ${t.status === "running" ? "t-run" : t.status === "waiting" ? "t-wait" : "t-done"}`} />
              <div>
                <b>{t.title}</b>
                <small>{t.statusNote}</small>
              </div>
            </div>
          ))
        )}
      </div>

      <div className="panel">
        <h3>
          待你拍板
          {board.decisions.length > 0 && <span className="cnt">{board.decisions.length}</span>}
        </h3>
        {board.decisions.length === 0 ? (
          <p className="dim panel-empty">暂无待办。她卡住或超预算时会升级到这里。</p>
        ) : (
          board.decisions.map((d) => (
            <div
              className="decision"
              key={d.id}
              onClick={() => onDecisionClick(d, onDecision)}
              title="点击批准；在频道里的卡片可选拒绝/追问"
            >
              <div className="d-title">
                <span className="from">{d.from}</span>
                {d.title}
              </div>
              <p>{d.detail}</p>
            </div>
          ))
        )}
      </div>

      <div className="panel">
        <h3>会话用量</h3>
        {board.tokensUsed > 0 ? (
          <div style={{ fontSize: 12, color: "var(--text-dim)" }}>
            本次会话累计 <b style={{ color: "var(--text)" }}>{(board.tokensUsed / 1000).toFixed(1)}K</b> tokens
            <div className="meter-cap" style={{ marginTop: 3 }}>
              <span>来自模型返回的真实 usage</span>
            </div>
          </div>
        ) : (
          <p className="dim panel-empty">用量来自模型返回的 usage，聊过才有数——不造假。</p>
        )}
      </div>
    </aside>
  );
}
