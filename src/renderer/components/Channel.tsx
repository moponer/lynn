import type { FeedCard } from "../../shared/contract";

const BADGE_CLASS: Record<string, string> = {
  组队: "k-report",
  派单: "k-dispatch",
  回报: "k-report",
  审查: "k-review",
  汇报: "k-final",
  需要你拍板: "k-approve",
  工具: "k-dispatch",
};

export function Feed({
  feed,
  liveText,
  liveTools,
  scrollRef,
}: {
  feed: FeedCard[];
  liveText: string | null;
  liveTools: FeedCard[];
  scrollRef: React.RefObject<HTMLDivElement>;
}) {
  const empty = feed.length === 0 && liveText === null && liveTools.length === 0;
  return (
    <div className="feed" ref={scrollRef}>
      {empty && (
        <div className="feed-empty">
          <div className="feed-empty-title">风过铃响，事事有应。</div>
          <p>
            在下面派第一件活。她会先写清「要做什么、什么算完成」，再决定是自己答还是组队——
            动手的永远是成员，判断的永远是风铃。
          </p>
        </div>
      )}

      {feed.map((c) => {
        if (c.kind === "user") {
          return (
            <div key={c.id} className="row me">
              <div className="msg">{c.text}</div>
            </div>
          );
        }
        if (c.kind === "lynn") {
          return (
            <div key={c.id} className="row lynn">
              <div className="msg">
                <div className="who"><b>风铃</b>{c.streaming && <span>· 正在说</span>}</div>
                <div className="text">{c.text}</div>
              </div>
            </div>
          );
        }
        if (c.kind === "system") {
          return (
            <div key={c.id} className="row sys">
              <div className="sys-note">{c.text}</div>
            </div>
          );
        }
        // 工具卡
        return (
          <div key={c.id} className="row">
            <div className={`op-card ${BADGE_CLASS[c.badge ?? "工具"] ?? "k-dispatch"}`} style={{ flex: 1 }}>
              <div className="op-head">
                <span className="op-kind">{c.badge}</span>
                <span className="op-title">{c.title}</span>
                {c.meta && <span className="op-meta">{c.meta}</span>}
              </div>
              {c.body && <div className="op-body pre-line">{c.body}</div>}
              {c.members && (
                <div style={{ marginTop: 6 }}>
                  {c.members.map((m) => (
                    <span key={m.name} className="member-chip">
                      <span className="m-av" style={{ background: m.color }}>{m.name[0]}</span>
                      {m.name} <small>{m.role}</small>
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        );
      })}

      {liveTools.map((c) => (
        <div key={c.id} className="row">
          <div className={`op-card ${BADGE_CLASS[c.badge ?? "工具"] ?? "k-dispatch"}`} style={{ flex: 1 }}>
            <div className="op-head">
              <span className="op-kind">{c.badge}</span>
              <span className="op-title">{c.title}</span>
              {c.meta && <span className="op-meta">{c.meta}</span>}
            </div>
            {c.body && <div className="op-body pre-line">{c.body}</div>}
          </div>
        </div>
      ))}

      {liveText !== null && (
        <div className="row lynn">
          <div className="msg">
            <div className="who"><b>风铃</b><span>· 正在说</span></div>
            <div className="text">
              {liveText}
              {liveText === "" && <span className="typing-dots"><i /><i /><i /></span>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
