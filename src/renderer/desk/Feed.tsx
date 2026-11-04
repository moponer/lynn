import type { FeedCard } from "../../shared/contract";
import { Icon } from "../components/Icon";

/**
 * 三种声音的落点：你说的话（普通正文）/ 她的判断（纸边语气，斜体）/ 工具与系统（等宽审计线）。
 * 不做聊天气泡（设计规范 §2.1），层级靠底色与字距。
 */
export function FeedView({
  cards,
  empty,
  onAction,
}: {
  cards: FeedCard[];
  empty?: React.ReactNode;
  onAction?: (card: FeedCard) => void;
}) {
  if (cards.length === 0) return <div className="feed-empty">{empty ?? "还没有往来。"}</div>;
  return (
    <div className="feed">
      {cards.map((c) => {
        if (c.kind === "user") {
          return (
            <div className="feed-item user" key={c.id}>
              <span className="feed-who">你</span>
              <span className="feed-text">{c.text}</span>
              {c.meta && <span className="feed-meta mono">{c.meta}</span>}
            </div>
          );
        }
        if (c.kind === "lynn") {
          return (
            <div className="feed-item lynn" key={c.id}>
              <span className="feed-who">
                <Icon name="bell" size="sm" /> 风铃
              </span>
              <p className="feed-text">
                {c.text}
                {c.streaming && <span className="caret" />}
              </p>
            </div>
          );
        }
        if (c.kind === "system") {
          return (
            <div className={`feed-item system${c.code ? " bad" : ""}`} key={c.id}>
              <span className="feed-badge">{c.code ? "需要注意" : "系统"}</span>
              <span className="feed-text">{c.text}</span>
              {c.action && c.action !== "none" && (
                <button type="button" className="feed-action" onClick={() => onAction?.(c)}>
                  {ACTION_LABEL[c.action]}
                </button>
              )}
            </div>
          );
        }
        // tool
        return (
          <details className="feed-item tool" key={c.id}>
            <summary>
              <span className="feed-badge">{c.badge ?? "工具"}</span>
              <span className="feed-title">{c.title}</span>
              {c.meta && <span className="feed-meta mono">{c.meta}</span>}
            </summary>
            {c.report ? (
              <div className="feed-report">
                <div className="rp-k">结论</div>
                <p>{c.report.conclusion || "—"}</p>
                <div className="rp-k">证据</div>
                <p>{c.report.evidence || "—"}</p>
                <div className="rp-k">未完成</div>
                <p>{c.report.unfinished || "—"}</p>
                <div className="rp-k">等你拍板</div>
                <p className="seal-text">{c.report.decision || "—"}</p>
              </div>
            ) : (
              c.body && <pre className="feed-body">{c.body}</pre>
            )}
          </details>
        );
      })}
    </div>
  );
}

const ACTION_LABEL: Record<NonNullable<FeedCard["action"]>, string> = {
  settings: "去设置",
  retry: "重试",
  logs: "看日志",
  reload: "重启运行时",
  stopRunning: "全部停掉",
  none: "",
};
