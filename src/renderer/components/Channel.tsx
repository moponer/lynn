import type {
  Evidence,
  FeedCard,
  Task,
} from "../../shared/contract";

const STAGES: { key: Task["stage"]; label: string }[] = [
  { key: "accept", label: "受理" },
  { key: "decompose", label: "拆解" },
  { key: "staffing", label: "组队" },
  { key: "dispatch", label: "派单" },
  { key: "execute", label: "执行" },
  { key: "review", label: "审查" },
  { key: "report", label: "汇报" },
];

export function ChannelHead({ task }: { task: Task }) {
  const doneOrder = STAGES.findIndex((s) => s.key === task.stage);
  const running = task.status === "running";
  return (
    <div className="channel-head">
      <div className="task-title">
        <h1>{task.title}</h1>
        <span className="tag">任务 #{task.id}</span>
        {task.status === "waiting" && <span className="tag warn">1 项待你拍板</span>}
      </div>
      <div className="pipeline">
        {STAGES.map((s, i) => {
          const cls =
            i < doneOrder ? "done" : i === doneOrder ? (running ? "run" : "wait") : "";
          const label = s.key === "execute" && i === doneOrder ? `${s.label} ${task.stageProgress}` : s.label;
          return (
            <span key={s.key} style={{ display: "contents" }}>
              {i > 0 && <div className="stage-line" />}
              <div className={`stage ${cls}`}>
                <div className="pip" />
                <span>{label}</span>
              </div>
            </span>
          );
        })}
      </div>
    </div>
  );
}

function MemberChips({ members }: { members: NonNullable<FeedCard["members"]> }) {
  return (
    <div style={{ marginTop: 6 }}>
      {members.map((m) => (
        <span key={m.id} className="member-chip">
          <span className="m-av" style={{ background: m.color }}>
            {m.name[0]}
          </span>
          {m.name} <small>{m.role}</small>
        </span>
      ))}
    </div>
  );
}

function EvidenceChips({ evidence, onOpen }: { evidence: Evidence[]; onOpen: (e: Evidence) => void }) {
  return (
    <div>
      {evidence.map((e) => (
        <span key={e.id} className="ev-chip" onClick={() => onOpen(e)}>
          {e.kind === "file" ? "📄" : e.kind === "brief" ? "📋" : "⌨"} {e.label}
        </span>
      ))}
      <div className="ev-note">证据由风铃核验：文件存在、命令可复跑 —— 无证据不算完成。</div>
    </div>
  );
}

export function Feed({
  cards,
  onEvidence,
  onDecision,
}: {
  cards: FeedCard[];
  onEvidence: (e: Evidence) => void;
  onDecision: (id: string, action: "approve" | "reject" | "ask") => void;
}) {
  return (
    <div className="feed">
      {cards.map((c) => {
        if (c.kind === "user") {
          return (
            <div key={c.id} className="row me">
              <div className="msg">{c.text}</div>
            </div>
          );
        }
        if (c.kind === "accept" || c.kind === "lynn_report") {
          return (
            <div key={c.id} className="row lynn">
              <div className="msg">
                <div className="who">
                  <b>{c.title ?? "风铃"}</b>
                  {c.badge && <span>· {c.badge}</span>}
                </div>
                <div className="text">{c.text}</div>
                {c.body && <div className="op-body dim" style={{ marginTop: 6, fontSize: 12 }}>{c.body}</div>}
                {c.members && <MemberChips members={c.members} />}
              </div>
            </div>
          );
        }
        if (c.kind === "typing") {
          return (
            <div key={c.id} className="row lynn">
              <div className="msg">
                <div className="who">
                  <b>{c.title ?? "风铃"}</b>
                </div>
                <div className="text dim" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  {c.text} <span className="typing-dots"><i /><i /><i /></span>
                </div>
              </div>
            </div>
          );
        }
        // 组织动作卡
        const kindCls =
          c.kind === "dispatch"
            ? "k-dispatch"
            : c.kind === "member_report"
              ? "k-report"
              : c.kind === "review_reject"
                ? "k-review"
                : c.kind === "approval"
                  ? "k-approve"
                  : "k-final";
        return (
          <div key={c.id} className="row">
            <div className={`op-card ${kindCls}`} style={{ flex: 1 }}>
              <div className="op-head">
                <span className="op-kind">{c.badge}</span>
                <span className="op-title">{c.title}</span>
                {c.meta && <span className="op-meta">{c.meta}</span>}
              </div>
              {c.body && <div className="op-body">{c.body}</div>}
              {c.members && <MemberChips members={c.members} />}
              {c.evidence && <EvidenceChips evidence={c.evidence} onOpen={onEvidence} />}
              {c.kind === "member_report" && !c.evidence && (
                <div className="ev-note">等待证据……</div>
              )}
              {c.actions && (
                <div className="op-actions">
                  <button className="btn primary" onClick={() => onDecision(c.id, "approve")}>批准</button>
                  <button className="btn" onClick={() => onDecision(c.id, "reject")}>拒绝</button>
                  <button className="btn ghost" onClick={() => onDecision(c.id, "ask")}>问她一句</button>
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
