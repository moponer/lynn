import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useT } from "../i18n";
import type { FeedCard } from "../../shared/contract";
import { Icon } from "../components/Icon";
import { MarkdownText } from "./MarkdownText";

/**
 * 滚动容器（参考 tether-ai 的 stick-to-bottom）：
 *  - 新卡 / 流式补字时自动贴底；
 *  - 用户主动上翻后不再抢滚动，回到底部附近才恢复跟随；
 *  - 换会话 / 换工单时强制回到底部。
 */
export function FeedScroller({ resetKey, children }: { resetKey?: string; children: React.ReactNode }) {
  const box = useRef<HTMLDivElement | null>(null);
  const stick = useRef(true);
  const toEnd = () => {
    const node = box.current;
    if (node) node.scrollTop = node.scrollHeight;
  };
  // 换线程/换单：回到最新一条
  useLayoutEffect(() => {
    stick.current = true;
    toEnd();
  }, [resetKey]);
  // 每次渲染（含流式补字）都贴底；上翻过就不动
  useLayoutEffect(() => {
    if (stick.current) toEnd();
  });
  return (
    <div
      className="work feed-work"
      ref={box}
      data-feed-scroll=""
      onScroll={(e) => {
        const node = e.currentTarget;
        // 离底 96px 内算"还在看最新"：阈值太小会被长文高度变化误判成上翻
        stick.current = node.scrollHeight - node.scrollTop - node.clientHeight < 96;
      }}
    >
      {children}
    </div>
  );
}

/**
 * 思考块：与正文分开的一段。
 * 还没产出正文时默认展开（能看见她在想什么），正文一开始就自动收起；
 * 用户自己点过之后不再自动收（不跟用户抢控制权）。
 */
function ThinkingBlock({ text, live }: { text: string; live: boolean }) {
  const [open, setOpen] = useState(live);
  const touched = useRef(false);
  useEffect(() => {
    if (!touched.current) setOpen(live);
  }, [live]);
  if (!text.trim()) return null;
  return (
    <div className={`feed-think${open ? " open" : ""}`}>
      <button
        type="button"
        className="feed-think-h"
        aria-expanded={open}
        onClick={() => {
          touched.current = true;
          setOpen((v) => !v);
        }}
      >
        <Icon name="chev" size="sm" />
        <span className="k">思考</span>
        <span className="hint">{live ? "进行中" : `${text.trim().length} 字`}</span>
      </button>
      {open && <p className="feed-think-body">{text}</p>}
    </div>
  );
}

/**
 * 三种声音的落点：你说的话（普通正文）/ 她的判断（正文正常字重，只有"思考"是旁注语气）/ 工具与系统（等宽审计线）。
 * 不做聊天气泡（设计规范 §2.1），层级靠底色与字距。
 */
export function FeedView({
  cards,
  empty,
  onAction,
  collapseHistory,
}: {
  cards: FeedCard[];
  empty?: React.ReactNode;
  onAction?: (card: FeedCard) => void;
  /** 回合聚焦：默认只展开"你最近一次说话"之后的往来，更早的收进一条折叠行 */
  collapseHistory?: boolean;
}) {
  const [showHistory, setShowHistory] = useState(false);
  const t = useT();
  // 分割点 = 最后一条"你"的消息：它之前的全是上一回合的账
  let split = -1;
  if (collapseHistory) {
    for (let i = cards.length - 1; i >= 0; i -= 1) {
      if (cards[i].kind === "user") {
        split = i;
        break;
      }
    }
  }
  const historyCount = split > 0 ? split : 0;
  const visible = collapseHistory && !showHistory && split > 0 ? cards.slice(split) : cards;
  if (cards.length === 0) return <div className="feed-empty">{empty ?? "还没有往来。"}</div>;
  return (
    <div className="feed">
      {historyCount > 0 && (
        <button
          type="button"
          className="feed-history"
          onClick={() => {
            setShowHistory(true);
            // 展开后跳回最前面读：贴底跟随会被这次程序化滚动关掉
            requestAnimationFrame(() => {
              const node = document.querySelector<HTMLElement>("[data-feed-scroll]");
              if (node) node.scrollTop = 0;
            });
          }}
        >
          {t("feed.earlier", { n: historyCount })}
        </button>
      )}
      {visible.map((c) => {
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
              {c.thinking && <ThinkingBlock text={c.thinking} live={Boolean(c.streaming) && !(c.text ?? "").trim()} />}
              {/* 输出走极简 Markdown：模型写的 **重点** / 编号 / 列表不再是一坨星号 */}
              <div className="feed-text md-wrap">
                <MarkdownText text={c.text ?? ""} />
                {c.streaming && <span className="caret" />}
              </div>
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
        // 回报卡默认展开：交付结果是对话流里最重要的信息，不该折叠着等人点开
        return (
          <details className="feed-item tool" key={c.id} open={Boolean(c.report)}>
            <summary>
              <span className="feed-badge">
                {c.badge ?? "工具"}
                {c.count && c.count > 1 ? ` ×${c.count}` : ""}
              </span>
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
