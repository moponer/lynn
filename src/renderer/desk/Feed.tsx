import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useT } from "../i18n";
import type { FeedCard, FeedMention } from "../../shared/contract";
import { Icon, type IconName } from "../components/Icon";
import { RichText } from "../components/RichText";
import { MemberAvatar } from "./MemberAvatar";

/**
 * 滚动容器（参考 tether-ai 的 stick-to-bottom）：
 *  - 新卡 / 流式补字时自动贴底；
 *  - 用户主动上翻后不再抢滚动，回到底部附近才恢复跟随；
 *  - 换会话 / 换工单时强制回到底部。
 */
export function FeedScroller({ resetKey, children }: { resetKey?: string; children: React.ReactNode }) {
  const box = useRef<HTMLDivElement | null>(null);
  const stick = useRef(true);
  /** 只有用户自己滚过才算"上翻"；内容长高造成的离底不该被误判成主动上翻 */
  const userScroll = useRef(false);
  const toEnd = () => {
    const node = box.current;
    if (node) node.scrollTop = node.scrollHeight;
  };
  // 换线程/换单：回到最新一条
  useLayoutEffect(() => {
    stick.current = true;
    userScroll.current = false;
    toEnd();
  }, [resetKey]);
  // 每次渲染（含流式补字）都贴底；用户主动上翻过就不抢
  useLayoutEffect(() => {
    if (stick.current) toEnd();
  });
  // 内容异步长高（思考块流式补字/展开、字体落位、图片加载）时继续贴底
  useEffect(() => {
    const node = box.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    let raf = 0;
    const ro = new ResizeObserver(() => {
      if (!stick.current) return;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(toEnd);
    });
    // 容器高度固定，变的是里面那一列；换过子元素就重新挂观察
    const watchContent = () => {
      ro.disconnect();
      ro.observe(node.firstElementChild ?? node);
    };
    watchContent();
    const mo = new MutationObserver(watchContent);
    mo.observe(node, { childList: true });
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      mo.disconnect();
    };
  }, []);
  return (
    <div
      className="work feed-work"
      ref={box}
      data-feed-scroll=""
      onWheel={() => { userScroll.current = true; }}
      onTouchStart={() => { userScroll.current = true; }}
      onKeyDown={() => { userScroll.current = true; }}
      onScroll={(e) => {
        const node = e.currentTarget;
        // 离底 96px 内算"还在看最新"：阈值太小会被长文高度变化误判成上翻
        if (node.scrollHeight - node.scrollTop - node.clientHeight < 96) {
          stick.current = true;
          userScroll.current = false;
        } else if (userScroll.current) {
          stick.current = false;
        }
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

/** 谁在说话：图标 + 名字 + 时间，五种对象各有各的记号，不靠猜 */
function Who({
  icon,
  name,
  tone,
  meta,
  avatarId,
  role,
}: {
  icon: IconName;
  name: string;
  tone: "user" | "lynn" | "system" | "tool" | "progress" | "member";
  meta?: string;
  /** 成员头像（群里成员有自己的脸，不再只是一行标题） */
  avatarId?: string;
  /** 岗位（能力域），显示在成员名后面 */
  role?: string;
}) {
  return (
    <div className={`fv-who ${tone}`}>
      {avatarId ? <MemberAvatar name={name} avatarId={avatarId} size={20} /> : <Icon name={icon} size="sm" />}
      <span className="fv-name">{name}</span>
      {role && <span className="fv-role">{role}</span>}
      {meta && <span className="fv-time mono">{meta}</span>}
    </div>
  );
}

/**
 * 群里点名：这条消息 @ 了谁。
 * 定向诉求不能只藏在正文里——用户要一眼看见"这话是对谁说的"。
 */
function Mentions({ mentions }: { mentions?: FeedMention[] }) {
  if (!mentions || !mentions.length) return null;
  return (
    <div className="feed-at">
      {mentions.map((m) => (
        <span className="at-chip" key={`${m.kind}:${m.name}`}>
          <Icon name="users" size="sm" />
          {m.kind === "lynn" ? "风铃" : m.name}
        </span>
      ))}
    </div>
  );
}

/** 跟踪进度按步骤逐行排，最新一行落在最下面（不再是一坨挤在顶部的纯文本） */
function TrackLines({ text }: { text: string }) {
  const lines = String(text ?? "").split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return null;
  return (
    <ol className="track-lines">
      {lines.map((line, i) => (
        <li className={`track-line${i === lines.length - 1 ? " now" : ""}`} key={i}>
          <span className="track-dot" />
          <span className="track-text">{line}</span>
        </li>
      ))}
    </ol>
  );
}

function fmtBytes(n?: number): string {
  if (!n) return "";
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
  return n >= 1024 ? `${Math.round(n / 1024)}KB` : `${n}B`;
}

const BADGE_ICON: Record<string, IconName> = {
  进度: "target", 回报: "pkg", 派单: "send", 组队: "users", 审查: "check",
  汇报: "clip", "需要你拍板": "warn", 工具: "term", 已拦截: "shield",
  出站: "globe", 提醒: "clock", 心跳: "clock", 记忆: "brain",
  已停止: "x", 未完成: "warn", 崩溃: "warn", 放行: "check",
};

/**
 * 五种声音：你 / 风铃 / 系统 / 工具 / 成员进度。
 * 正文一律走 Markdown（标题、列表、表格、代码块），纯文本直出只会出现在思考块里。
 * 不做聊天气泡（设计规范 §2.1），层级靠底色、字距与左侧的细色条。
 */
export function FeedView({
  cards,
  empty,
  onAction,
  collapseHistory,
  runningIds,
  onPreview,
}: {
  cards: FeedCard[];
  empty?: React.ReactNode;
  onAction?: (card: FeedCard) => void;
  /** 回合聚焦：默认只展开"你最近一次说话"之后的往来，更早的收进一条折叠行 */
  collapseHistory?: boolean;
  /** 真正在跑的任务 id（desk.running）：进度卡据此亮起"执行中"脉冲 */
  runningIds?: string[];
  /** 汇报卡上的产物：点一下进内置预览（taskId 取自卡片的 jobId） */
  onPreview?: (taskId: string, ref: string) => void;
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
  const base = collapseHistory && !showHistory && split > 0 ? cards.slice(split) : cards;
  // 带可行动作的错误卡即使被折叠成「历史」也要留在屏上：用户刚发了新消息，
  // 上一条 429/5xx 的「重试」入口不能凭空消失（2026-11-11 修）。
  const pinned = cards
    .filter((c) => c.kind === "system" && Boolean(c.code) && Boolean(c.action) && c.action !== "none")
    .slice(-1);
  const visible = pinned.length && !base.some((c) => c.id === pinned[0].id) ? [...pinned, ...base] : base;
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
      {visible.map((c, i) => {
        if (c.kind === "user") {
          return (
            <div className="feed-item user" key={c.id}>
              <Who icon="user" name="你" tone="user" meta={c.meta || c.createdAt} />
              <Mentions mentions={c.mentions} />
              <div className="feed-text md-wrap">
                <RichText text={c.text ?? ""} />
                {c.meta && <span className="feed-meta mono">{c.meta}</span>}
              </div>
            </div>
          );
        }
        if (c.kind === "lynn") {
          return (
            <div className="feed-item lynn" key={c.id}>
              <Who
                icon="bell"
                name={c.author?.name ?? "风铃"}
                tone="lynn"
                meta={c.createdAt}
                avatarId={c.author?.avatarId}
              />
              <Mentions mentions={c.mentions} />
              {c.thinking && <ThinkingBlock text={c.thinking} live={Boolean(c.streaming) && !(c.text ?? "").trim()} />}
              <div className="feed-text md-wrap">
                <RichText text={c.text ?? ""} streaming={c.streaming} />
                {c.streaming && <span className="caret" />}
              </div>
            </div>
          );
        }
        if (c.kind === "system") {
          // 系统消息按类别区分：清理 / 预算 / 恢复 / 巡检 / 授权 / 错误，各有图标、标签底色与整条淡底
          const tone = c.systemTone ?? (c.code ? "error" : "notice");
          const meta = SYSTEM_META[tone];
          return (
            <div className={`feed-item system tone-${tone}${c.code ? " bad" : ""}`} key={c.id}>
              <Who icon={meta.icon} name={c.title ?? meta.label} tone="system" meta={c.createdAt} />
              <div className="feed-text md-wrap">
                <RichText text={c.text ?? ""} />
                {c.action && c.action !== "none" && (
                  <button type="button" className="feed-action" onClick={() => onAction?.(c)}>
                    {ACTION_LABEL[c.action]}
                  </button>
                )}
              </div>
            </div>
          );
        }
        // tool：进度 / 回报 / 拦截 / 派单…都用同一张卡，但记号与正文形态不同
        const badge = c.badge ?? "工具";
        const progress = badge === "进度";
        const live = progress && c.jobId != null && runningIds?.includes(c.jobId) === true;
        // 同一工单的连续工具卡视觉成组：读起来是一条工单时间线，不是一堆散卡
        const prev = visible[i - 1];
        const sameJob = Boolean(c.jobId && prev?.kind === "tool" && prev.jobId === c.jobId);
        // 群里有作者的动作卡 = 群里的一次发言（成员的交付、风铃的调度）：不折叠，带头像
        if (c.author) {
          const a = c.author;
          return (
            <div className={`feed-item talk author-${a.kind}`} key={c.id}>
              <Who
                icon={a.kind === "member" ? "users" : a.kind === "lynn" ? "bell" : "term"}
                name={a.name ?? (a.kind === "member" ? "成员" : a.kind === "lynn" ? "风铃" : "系统")}
                tone={a.kind === "member" ? "member" : a.kind === "lynn" ? "lynn" : "system"}
                meta={c.createdAt}
                avatarId={a.avatarId}
                role={a.role}
              />
              <div className="talk-head">
                <span className="feed-badge">
                  <Icon name={BADGE_ICON[badge] ?? "term"} size="sm" />
                  {badge}
                  {c.count && c.count > 1 ? ` ×${c.count}` : ""}
                </span>
                {c.title && <span className="feed-title">{c.title}</span>}
                {c.meta && <span className="feed-meta mono">{c.meta}</span>}
              </div>
              <Mentions mentions={c.mentions} />
              {c.report ? (
                <ReportBlock card={c} onPreview={onPreview} />
              ) : c.body ? (
                <div className="feed-body md-wrap"><RichText text={c.body} /></div>
              ) : (
                <ReportBlock card={c} onPreview={onPreview} />
              )}
            </div>
          );
        }
        return (
          <details
            className={`feed-item tool${progress ? " progress" : ""}${live ? " live" : ""}${sameJob ? " same-job" : ""}`}
            key={c.id}
            open
          >
            <summary>
              <span className="feed-badge">
                {live && <span className="live-dot" aria-hidden />}
                <Icon name={BADGE_ICON[badge] ?? "term"} size="sm" />
                {badge}
                {c.count && c.count > 1 ? ` ×${c.count}` : ""}
              </span>
              <span className="feed-title">{c.title}</span>
              {c.meta && <span className="feed-meta mono">{c.meta}</span>}
              {live && <span className="feed-live-text">{t("feed.live")}</span>}
            </summary>
            {c.members && c.members.length > 0 && (
              <div className="feed-members">
                {c.members.map((m) => (
                  <span className="feed-member" key={m.name} title={`${m.name} · ${m.role}`}>
                    <MemberAvatar name={m.name} avatarId={m.avatarId} size={24} />
                    <span>{m.name}</span>
                  </span>
                ))}
              </div>
            )}
            {c.report ? (
              <ReportBlock card={c} onPreview={onPreview} />
            ) : progress ? (
              <TrackLines text={c.body ?? ""} />
            ) : (
              c.body && <div className="feed-body md-wrap"><RichText text={c.body} /></div>
            )}
          </details>
        );
      })}
    </div>
  );
}

// 用户只看结果：结论 / 未完成 / 待拍板。证据是内部核对记录，不在回报卡上占位置。
const REPORT_ROWS: [string, "conclusion" | "unfinished" | "decision"][] = [
  ["结论", "conclusion"],
  ["未完成", "unfinished"],
  ["等你拍板", "decision"],
];

/**
 * 汇报四段 + 产物清单：结论在前，产物点一下进内置预览。
 * 只给绝对路径字符串等于让用户自己去翻文件夹——实机她就这么干过。
 */
function ReportBlock({
  card,
  onPreview,
}: {
  card: FeedCard;
  onPreview?: (taskId: string, ref: string) => void;
}) {
  const hasReport = Boolean(card.report);
  const hasFiles = Boolean(card.artifacts?.length);
  if (!hasReport && !hasFiles) return null;
  return (
    <div className="feed-report">
      {hasReport &&
        REPORT_ROWS.map(([k, key]) => (
          <div className="rp-row" key={key}>
            <div className="rp-k">{k}</div>
            <div className={`rp-v${key === "decision" ? " seal-text" : ""}`}>
              <RichText text={card.report?.[key] || "—"} />
            </div>
          </div>
        ))}
      {hasFiles && (
        <div className="rp-row">
          <div className="rp-k">产物</div>
          <div className="rp-v">
            <div className="rp-files">
              {card.artifacts?.map((a) => (
                <button
                  type="button"
                  key={a.ref}
                  className="rp-file"
                  title={`${a.ref}${a.bytes ? `\n${fmtBytes(a.bytes)}` : ""}\n点击内置预览`}
                  onClick={() => {
                    if (card.jobId) onPreview?.(card.jobId, a.ref);
                  }}
                >
                  <Icon name="eye" size="sm" />
                  <span>{a.label}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** 系统消息的类别元数据：标签 + 图标；底色与字色在 CSS 的 .tone-* 里 */
const SYSTEM_META: Record<
  "cleanup" | "budget" | "recover" | "patrol" | "auth" | "notice" | "error",
  { label: string; icon: IconName }
> = {
  cleanup: { label: "清理", icon: "archive" },
  budget: { label: "预算", icon: "target" },
  recover: { label: "恢复", icon: "undo" },
  patrol: { label: "巡检", icon: "bell" },
  auth: { label: "授权", icon: "lock" },
  error: { label: "需要注意", icon: "warn" },
  notice: { label: "系统", icon: "term" },
};

const ACTION_LABEL: Record<NonNullable<FeedCard["action"]>, string> = {
  settings: "去设置",
  retry: "重试",
  logs: "看日志",
  reload: "重启运行时",
  stopRunning: "全部停掉",
  none: "",
};
