import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useT } from "../i18n";
import type { FeedCard, FeedMention } from "../../shared/contract";
import { Icon, type IconName } from "../components/Icon";
import { RichText } from "../components/RichText";
import { MemberAvatar } from "./MemberAvatar";
import { FEED_MAX_VISIBLE, FEED_PAGE_SIZE, feedWindow, feedAwaitingLynn, nextVisibleCount } from "./feed-window";
import type { I18nKey } from "../../shared/i18n-strings";

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
  /**
   * 「暂停贴底跟随」（2026-11-17 P6-2 / 18 章 C4）。
   *
   * 原来的毛病：点「更早的往来」把 scrollTop 归零，但贴底跟随还开着——
   * 下一次内容变化又把你拽回底部，**展开历史等于没展开**。
   * 这里给滚动容器一个明确的"我主动去读历史了"的入口：关掉跟随，
   * 用户自己滚回底部时 onScroll 会重新打开（离底 <96px 就算回到底部）。
   *
   * 用 window 事件而不是 ref 传递：FeedScroller 与 FeedView 不是父子，
   * 为了一个开关去穿透几层 props 不划算，事件语义也更清楚。
   */
  useEffect(() => {
    const pause = () => {
      stick.current = false;
      userScroll.current = true;
    };
    window.addEventListener("lynn:feed-pause-follow", pause);
    return () => window.removeEventListener("lynn:feed-pause-follow", pause);
  }, []);
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
  const t = useT();
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
        <span className="k">{t("feed.thinking")}</span>
        <span className="hint">{live ? t("feed.inProgress") : t("feed.thinkChars", { n: text.trim().length })}</span>
      </button>
      {open && <p className="feed-think-body">{text}</p>}
    </div>
  );
}

/**
 * 长正文折叠（2026-11-15 重做）：
 *  - 收起 = 按块裁切（CSS 限高 + 底部渐隐），不再按 420 字硬切——
 *    硬切会把 Markdown 表格从半行切开，渲染出一张残表，那才是"展开后也不完整"的根源；
 *  - 展开 = 彻底解除限高：此前展开态被 `.feed-item.tool .feed-body` 的 320px 限高盖住
 *    （那条选择器更具体），点了「展开全文」还是半截、还看不到滚动条；
 *  - 双击正文即可展开 / 收起，按钮旁写明这条捷径（按钮本身也留着，键盘可达）。
 */
function FoldBody({ text }: { text: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const long = text.length > 420;
  const toggle = () => setOpen((v) => !v);
  return (
    <div
      className={`feed-fold${long ? " long" : ""}${open ? " open" : ""}`}
      onDoubleClick={(e) => {
        if (!long) return;
        // 正文里的链接/开关有自己的双击语义（选中、打开），不跟它们抢
        if ((e.target as HTMLElement).closest("a, button, input, textarea")) return;
        toggle();
      }}
    >
      <div className="feed-body md-wrap">
        <RichText text={text} />
      </div>
      {long && (
        <div className="feed-fold-bar">
          <span className="feed-fold-hint">{open ? t("feed.foldHintLess") : t("feed.foldHintMore")}</span>
          <button type="button" className="feed-more" aria-expanded={open} onClick={toggle}>
            {open ? t("feed.foldLess") : t("feed.foldMore", { n: text.length })}
          </button>
        </div>
      )}
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
  channel,
}: {
  icon: IconName;
  name: string;
  tone: "user" | "lynn" | "system" | "tool" | "progress" | "member";
  meta?: string;
  /** 外部渠道（飞书 / 钉钉 / 企微 / 微信 / QQ）：独立徽标，不塞进名字里 */
  channel?: string;
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
      {channel && <ChannelBadge source={channel} />}
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
 * 渠道徽标：外部 IM 来的消息挂在谁身上。
 *
 * 为什么是"方块 + 一个字"而不是完整渠道名：
 *  · 名字行只有 42% 宽，写"飞书"就必然截断（2026-11-19 现场就是这个 bug）；
 *  · 品牌色 + 单字在 16px 下仍可辨，悬停给完整名字。
 *
 * 六个渠道的品牌色是各自的官方色，不用语义色——用户认的是品牌。
 */
const CHANNEL_META: Record<string, { short: string; name: string; color: string }> = {
  feishu: { short: "飞", name: "飞书", color: "#3370FF" },
  wecom: { short: "企", name: "企业微信", color: "#2D7BFF" },
  "wecom-app": { short: "企", name: "企业微信（自建）", color: "#1E63D6" },
  dingtalk: { short: "钉", name: "钉钉", color: "#0089FF" },
  weixin: { short: "微", name: "微信", color: "#07C160" },
  qq: { short: "Q", name: "QQ", color: "#12B7F5" },
};

/** 沙箱执行徽章（2026-11-19）：显示这条命令在哪个沙箱档跑、工作目录在哪 */
const SANDBOX_LABEL: Record<string, I18nKey> = {
  appcontainer: "feed.sandbox.appcontainer",
  restricted: "feed.sandbox.restricted",
  jobonly: "feed.sandbox.jobonly",
  off: "feed.sandbox",
};

function SandboxBadge({ sandbox }: { sandbox: NonNullable<FeedCard["sandbox"]> }) {
  const t = useT();
  const labelKey = SANDBOX_LABEL[sandbox.mode] ?? "feed.sandbox";
  const titleParts = [t("feed.sandbox.title").replace("{mode}", t(labelKey))];
  if (sandbox.cwd) titleParts.push(t("feed.sandbox.cwd").replace("{cwd}", sandbox.cwd));
  return (
    <span className={`feed-sandbox sandbox-${sandbox.mode}`} title={titleParts.join("\n")}>
      <Icon name="shield" size="sm" />
      {t(labelKey)}
    </span>
  );
}

function ChannelBadge({ source }: { source: string }) {
  const t = useT();
  const meta = CHANNEL_META[source] ?? { short: source.slice(0, 1), name: source, color: "#7A808A" };
  return (
    <span
      className="fv-chan"
      style={{ background: meta.color }}
      title={`${meta.name} · ${t("feed.viaChannel")}`}
    >
      {meta.short}
    </span>
  );
}

/**
 * 群里点名：这条消息 @ 了谁。
 * 定向诉求不能只藏在正文里——用户要一眼看见"这话是对谁说的"。
 * pending = 这条 @ 还没人接（等风铃）：标出来，别让人干等。
 */
function Mentions({ mentions, pending }: { mentions?: FeedMention[]; pending?: boolean }) {
  const t = useT();
  if (!mentions || !mentions.length) return null;
  return (
    <div className="feed-at">
      {mentions.map((m) => (
        <span className="at-chip" key={`${m.kind}:${m.name}`}>
          <Icon name="users" size="sm" />
          {m.kind === "lynn" ? "风铃" : m.name}
        </span>
      ))}
      {pending && <span className="at-pending">{t("feed.awaitLynn")}</span>}
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
  // 成员的中途发言（2026-11-16）：进展=在推、结论=想清了、疑问=要人答、风险=前提有问题
  进展: "target", 结论: "check", 疑问: "info", 风险: "warn",
};

/**
 * 五种声音：你 / 风铃 / 系统 / 工具 / 成员进度。
 * 正文一律走 Markdown（标题、列表、表格、代码块），纯文本直出只会出现在思考块里。
 * 不做聊天气泡（设计规范 §2.1），层级靠底色、字距与左侧的细色条。
 */
// 窗口相关的常量与纯函数都在 ./feed-window.ts（P6-2 抽出去的：C1/C2/C3/C5 都在那里）

function FeedViewInner({
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
  const [visibleCount, setVisibleCount] = useState(FEED_PAGE_SIZE);
  const t = useT();
  /**
   * 窗口计算全部交给纯函数 `feedWindow`（P6-2）。
   *
   * 组件只留一行 useMemo：依赖是 (cards, collapseHistory, showHistory, visibleCount)，
   * 别的一概不参与——这样 C3（每帧从尾扫）与 C5（渲染内现算）都不再随渲染跑，
   * 而且那份逻辑现在可以被单测钉住（项目还没有 RTL）。
   */
  const win = useMemo(
    () => feedWindow(cards, { collapseHistory, showHistory, visibleCount }),
    [cards, collapseHistory, showHistory, visibleCount],
  );
  const { historyCount, base, visible, capped, moreAvailable } = win;
  /**
   * "这条 @ 还没人接"必须基于**全量 cards**判定（2026-11-19 修 F4）。
   *
   * 之前传 `visible`：若"风铃已回应"的那张卡因为折叠/分页/400 上限被切出窗口，
   * answered 永远为 false → 那条 @ 一直挂着"等风铃"红标，用户以为消息丢了。
   * 全量扫描还与内核 pendingMentions（同样扫全量 feed）口径一致。
   */
  const awaitingLynn = useMemo(() => feedAwaitingLynn(cards), [cards]);
  if (cards.length === 0) return <div className="feed-empty">{empty ?? "还没有往来。"}</div>;
  return (
    <div className="feed">
      {historyCount > 0 && !showHistory && (
        <button
          type="button"
          className="feed-history"
          onClick={() => {
            setShowHistory(true);
            // 展开是要**读历史**：先明确暂停贴底跟随，否则下一次内容变化就把刚翻出来的内容拽回底部
            window.dispatchEvent(new Event("lynn:feed-pause-follow"));
            requestAnimationFrame(() => {
              const node = document.querySelector<HTMLElement>("[data-feed-scroll]");
              if (node) node.scrollTop = 0;
            });
          }}
        >
          {t("feed.earlier", { n: historyCount })}
        </button>
      )}
      {moreAvailable > 0 && (
        <button
          type="button"
          className="feed-history"
          onClick={() => {
            // C2：步进有上限，否则翻几次历史就把整段历史挂进 DOM，流式期每帧重排整棵树
            setVisibleCount((count) => nextVisibleCount(count));
            // 同上：补回更早的内容也是"读历史"，先暂停贴底跟随
            window.dispatchEvent(new Event("lynn:feed-pause-follow"));
            requestAnimationFrame(() => {
              const node = document.querySelector<HTMLElement>("[data-feed-scroll]");
              if (node) node.scrollTop = 0;
            });
          }}
        >
          {t("feed.earlier", { n: Math.min(FEED_PAGE_SIZE, moreAvailable) })}
        </button>
      )}
      {capped && base.length > visibleCount && (
        // 到上限了要**说出来**：不给按钮却也不解释，用户只会以为界面坏了
        <div className="feed-history feed-history-cap">
          {t("feed.capped", { n: FEED_MAX_VISIBLE })}
        </div>
      )}
      {visible.map((c, i) => {
        if (c.kind === "user") {
          return (
            <div className="feed-item user" key={c.id}>
              {/* 外部渠道来的消息要标出来（P20-1）：否则手机问的和本地敲的分不清。
                  2026-11-19 修：渠道原来塞进名字里（"你（飞书）"），被 fv-name 的 42% 截断成"你（飞…"。
                  现在拆成独立徽标：名字只写"你"，渠道用带品牌色的小方块跟在后面，永不截断。 */}
              <Who
                icon="user"
                name={t("feed.you")}
                tone="user"
                channel={c.author?.source}
                meta={c.meta || c.createdAt}
              />
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
              <Who icon={meta.icon} name={c.title ?? t(meta.key)} tone="system" meta={c.createdAt} />
              <div className="feed-text md-wrap">
                <RichText text={c.text ?? ""} />
                {c.action && c.action !== "none" && (
                  <button type="button" className="feed-action" onClick={() => onAction?.(c)}>
                    {t(ACTION_KEY[c.action as Exclude<NonNullable<FeedCard["action"]>, "none">])}
                  </button>
                )}
              </div>
            </div>
          );
        }
        // tool：进度 / 回报 / 拦截 / 派单…都用同一张卡，但记号与正文形态不同
        const badge = c.badge ?? "工具";
        const progress = badge === "进度";
        /**
         * F1（2026-11-19）：进度卡的"执行中"不能只看外部 desk.running——
         * 任务结束时 running 移除有滞后，进度卡会一直脉冲"执行中"，用户以为还在跑。
         * 这里加一道**基于卡片流的终态判定**：同一 job 在**本卡之后**已出现非"进度"卡
         * （回报/审查/拦截等），说明这单已经有后续结论 → 本进度卡不再是"进行中"。
         * 两者取与：外部 running 里有它 且 后面还没有该 job 的终态卡。
         */
        const hasLaterFinal = progress && c.jobId != null
          ? visible.slice(i + 1).some((x) => x.jobId === c.jobId && (x.badge ?? "工具") !== "进度")
          : false;
        const live = progress && c.jobId != null && runningIds?.includes(c.jobId) === true && !hasLaterFinal;
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
            <div className={`feed-item talk author-${a.kind}`} data-badge={badge} key={c.id}>
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
              {/**
               * 三分支的取舍（2026-11-19 修 F5）。
               *
               * 原来的写法是"report ? ReportBlock : body ? 正文 : ReportBlock"——
               * ① 第三分支与第一分支重复，读起来像 dead code；
               * ② 更实际的问题：**有 artifacts + body、但没有 report** 的卡会走第二分支，
               *    产物行被吞掉（用户看不到可点开的交付物）。
               *
               * 现在的规则：
               *  - 有 report（汇报卡）→ 只渲染 ReportBlock：它的 body 就是四段报告的文字复述，
               *    再显示一遍等于同一份内容画两遍（2026-11-13 实机截图）；
               *  - 没 report 但有 artifacts → ReportBlock（文件行）+ 正文（若有），两者都要；
               *  - 只有正文 → FoldBody；
               *  - 都没有 → 什么都不渲染。
               */}
              {c.report ? (
                <ReportBlock card={c} onPreview={onPreview} onRefMenu={onRefMenu} />
              ) : c.artifacts?.length ? (
                <>
                  <ReportBlock card={c} onPreview={onPreview} onRefMenu={onRefMenu} />
                  {c.body ? <FoldBody text={c.body} /> : null}
                </>
              ) : c.body ? (
                <FoldBody text={c.body} />
              ) : null}
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
              {c.sandbox && <SandboxBadge sandbox={c.sandbox} />}
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

/**
 * 加 memo（P6-2 / 18 章 F2）：同一个 feed 引用不变时别整块重渲。
 *
 * 效果取决于调用方：`Sheet` 里的 `channel` 是 `useMemo([feed])`（稳定，命中 memo），
 * 而 `jobCards` 是行内派生（每帧新数组，memo 会被击穿）。这一点**如实记在 PROGRESS 里**，
 * 不假装一处 memo 就把所有入口都优化了。
 */
export const FeedView = memo(FeedViewInner);

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
  const t = useT();
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
          <div className="rp-k">{t("feed.artifact")}</div>
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
/* 系统消息的分类元数据：**只存 key**，不存文案。
   2026-11-18：此前这里直接写中文标签，等于绕过了 i18n ——
   英文环境下系统消息永远显示中文。现在渲染时用 t(meta.key)。 */
const SYSTEM_META: Record<
  "cleanup" | "budget" | "recover" | "patrol" | "auth" | "notice" | "error",
  { key: I18nKey; icon: IconName }
> = {
  cleanup: { key: "sys.cleanup", icon: "archive" },
  budget: { key: "sys.budget", icon: "target" },
  recover: { key: "sys.recover", icon: "undo" },
  patrol: { key: "sys.patrol", icon: "bell" },
  auth: { key: "sys.auth", icon: "lock" },
  error: { key: "sys.error", icon: "warn" },
  notice: { key: "sys.notice", icon: "term" },
};

/** 系统卡上的动作按钮：同样只存 key（理由见 SYSTEM_META） */
const ACTION_KEY: Record<Exclude<NonNullable<FeedCard["action"]>, "none">, I18nKey> = {
  settings: "act.settings",
  retry: "act.retry",
  logs: "act.logs",
  reload: "act.reload",
  stopRunning: "act.stopRunning",
};
