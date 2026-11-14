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

/**
 * 长正文折叠（2026-11-13）：成员回报动辄 1000+ 字，全铺开时一屏就只剩这张卡，
 * 后面的动作全被挤到看不见。超过一屏的量先收成前几行，要读全文再点开。
 */
function FoldBody({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const LIMIT = 420;
  if (text.length <= LIMIT) {
    return (
      <div className="feed-body md-wrap">
        <RichText text={text} />
      </div>
    );
  }
  return (
    <div className="feed-fold">
      <div className={`feed-body md-wrap${open ? " open" : ""}`}>
        <RichText text={open ? text : `${text.slice(0, LIMIT)}…`} />
      </div>
      {/* 开关放在正文框外：放在里面会被 260px 的滚动框吞掉，用户根本看不到「展开」 */}
      <button type="button" className="feed-more" onClick={() => setOpen((v) => !v)}>
        {open ? "收起" : `展开全文（${text.length} 字）`}
      </button>
    </div>
  );
}

/**
 * 谁在说话：**一行**说完（2026-11-13）。
 *
 * 用户的对照是对的：飞书群、微信群一条消息只有「名字 + 时间」一行头，然后是正文。
 * 我们此前一条成员消息要占三行头——头像/名字/岗位/时间、徽标/标题/轮次、@提及，
 * 正文还没开始半屏就没了。现在合成一行：头像 · 名字 · 动作标签 · 做什么/多久 · 时间，
 * 岗位降级进 tooltip（它本来就和名字经常重复）。
 */
function Who({
  icon,
  name,
  tone,
  meta,
  avatarId,
  role,
  tag,
  sub,
}: {
  icon: IconName;
  name: string;
  tone: "user" | "lynn" | "system" | "tool" | "progress" | "member";
  meta?: string;
  /** 成员头像（群里成员有自己的脸，不再只是一行标题） */
  avatarId?: string;
  /** 岗位（能力域）：只在 tooltip 里出现，不再单独占位 */
  role?: string;
  /** 动作标签（派单/回报/汇报…）：一行头的中间段，弱化着色 */
  tag?: string;
  /** 这件事叫什么/多久（任务号、轮次、耗时）：一行头的尾部，可省略号截断 */
  sub?: string;
}) {
  const hint = role && role !== name ? `${name} · ${role}` : name;
  return (
    <div className={`fv-who ${tone}`}>
      {avatarId ? <MemberAvatar name={name} avatarId={avatarId} size={20} /> : <Icon name={icon} size="sm" />}
      <span className="fv-name" title={hint}>
        {name}
      </span>
      {tag && <span className="fv-tag">{tag}</span>}
      {sub && (
        <span className="fv-sub mono" title={sub}>
          {sub}
        </span>
      )}
      {meta && <span className="fv-time mono">{meta}</span>}
    </div>
  );
}

/**
 * 群里点名：这条消息 @ 了谁。
 * 定向诉求不能只藏在正文里——用户要一眼看见"这话是对谁说的"。
 * pending = 这条 @ 还没人接（等风铃）：标出来，别让人干等。
 */
function Mentions({ mentions, pending }: { mentions?: FeedMention[]; pending?: boolean }) {
  if (!mentions || !mentions.length) return null;
  return (
    <div className="feed-at">
      {mentions.map((m) => (
        <span className="at-chip" key={`${m.kind}:${m.name}`}>
          <Icon name="users" size="sm" />
          {m.kind === "lynn" ? "风铃" : m.name}
        </span>
      ))}
      {pending && <span className="at-pending">待风铃处理</span>}
    </div>
  );
}

/**
 * 跟踪进度按步骤逐行排，最新一行落在最下面。
 *
 * 2026-11-13：跑到后期一张进度卡能铺七八行，把整段对话顶下去。
 * 默认只留**最新一步**，要复盘再展开——进度是"她现在在哪"，不是工作日志。
 */
function TrackLines({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const lines = String(text ?? "").split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return null;
  const many = lines.length > 2;
  const last = lines.length - 1;
  const shown = open || !many ? lines.map((line, i) => ({ line, now: i === last })) : [{ line: lines[last], now: true }];
  return (
    <>
      <ol className="track-lines">
        {shown.map((s, i) => (
          <li className={`track-line${s.now ? " now" : ""}`} key={i}>
            <span className="track-dot" />
            <span className="track-text">{s.line}</span>
          </li>
        ))}
      </ol>
      {many && (
        <button type="button" className="feed-more" onClick={() => setOpen((v) => !v)}>
          {open ? "只看最新一步" : `展开全部 ${lines.length} 步`}
        </button>
      )}
    </>
  );
}

function fmtBytes(n?: number): string {
  if (!n) return "";
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
  return n >= 1024 ? `${Math.round(n / 1024)}KB` : `${n}B`;
}

const BADGE_ICON: Record<string, IconName> = {
  进度: "target", 回报: "pkg", 派单: "send", 组队: "users", 审查: "check",
  顾问: "eye", 汇报: "clip", "需要你拍板": "warn", 工具: "term", 已拦截: "shield",
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
  onRefMenu,
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
  /** 右键产物：打开所在目录 / 复制路径（2026-11-13） */
  onRefMenu?: (taskId: string, ref: string, label: string, x: number, y: number) => void;
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
  /**
   * 群里被 @ 的消息是否还没人接（群聊模式）：
   * 其后还没有风铃的回应 → 标「待风铃处理」。纯界面判断，不额外烧 token。
   * 判定与内核 pendingMentions 一致：出错的卡不算回应（模型挂掉的重试提示也是 lynn 卡）。
   */
  const awaitingLynn = (() => {
    const set = new Set<string>();
    let answered = false;
    for (let i = visible.length - 1; i >= 0; i -= 1) {
      const c = visible[i];
      if (c.code) continue;
      if (c.author?.kind === "lynn" || (c.kind === "lynn" && (c.text ?? "").trim())) {
        answered = true;
        continue;
      }
      if (c.kind === "user" && c.mentions?.length && !answered) set.add(c.id);
    }
    return set;
  })();
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
              <Mentions mentions={c.mentions} pending={awaitingLynn.has(c.id)} />
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
          const speaker = a.name ?? (a.kind === "member" ? "成员" : a.kind === "lynn" ? "风铃" : "系统");
          /**
           * 标题里常把「谁 + 动作」又写一遍（"代码审计员 回报 · task-x"），
           * 而这两件事一行头已经说了 → 剥掉前缀，只留真正的新信息（任务号/多久）。
           */
          let what = (c.title ?? "").trim();
          if (what.startsWith(speaker)) what = what.slice(speaker.length).trim();
          if (badge && what.startsWith(badge)) what = what.slice(badge.length).trim();
          what = what.replace(/^[·\-—:：\s]+/, "");
          const tail = [what, c.meta].filter(Boolean).join(" · ");
          const headTag = `${badge}${c.count && c.count > 1 ? ` ×${c.count}` : ""}`;
          return (
            <div className={`feed-item talk author-${a.kind}`} key={c.id}>
              <Who
                icon={a.kind === "member" ? "users" : a.kind === "lynn" ? "bell" : "term"}
                name={speaker}
                tone={a.kind === "member" ? "member" : a.kind === "lynn" ? "lynn" : "system"}
                meta={c.createdAt}
                avatarId={a.avatarId}
                role={a.role}
                tag={headTag}
                sub={tail}
              />
              {c.report ? (
                <ReportBlock card={c} onPreview={onPreview} onRefMenu={onRefMenu} />
              ) : c.body ? (
                <FoldBody text={c.body} />
              ) : (
                <ReportBlock card={c} onPreview={onPreview} onRefMenu={onRefMenu} />
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
              <ReportBlock card={c} onPreview={onPreview} onRefMenu={onRefMenu} />
            ) : progress ? (
              <TrackLines text={c.body ?? ""} />
            ) : (
              c.body && <FoldBody text={c.body} />
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
  onRefMenu,
}: {
  card: FeedCard;
  onPreview?: (taskId: string, ref: string) => void;
  /** 右键产物：打开所在目录 / 复制路径（2026-11-13） */
  onRefMenu?: (taskId: string, ref: string, label: string, x: number, y: number) => void;
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
                  title={`${a.ref}${a.bytes ? `\n${fmtBytes(a.bytes)}` : ""}\n点击内置预览 · 右键可定位文件`}
                  onClick={() => {
                    if (card.jobId) onPreview?.(card.jobId, a.ref);
                  }}
                  onContextMenu={(ev) => {
                    if (!card.jobId || !onRefMenu) return;
                    ev.preventDefault();
                    onRefMenu(card.jobId, a.ref, a.label, ev.clientX, ev.clientY);
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
