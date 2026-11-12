import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { type CaptureShot, type FeedCard, type PermissionMode, type QueueItem, type TaskStatus, cacheHitRate } from "../../shared/contract";
import { Icon, type IconName } from "../components/Icon";
import { WindowControls } from "../components/WindowControls";
import type { Desk, DeskDecision, DeskDiff, DeskEvidence, DeskJob, DeskMember } from "./model";
import type { JobGroup } from "../../shared/task-groups";
import { Slot, SandboxAction, SandboxHtml } from "./ui-host";
import { AmbientLayer } from "./AmbientLayer";
import type { AmbientMode, AmbientParams } from "../../shared/ambient";
import { STAGE_KEYS, STATUS_KEY, fmtTime } from "./model";
import { groupArchived } from "../../shared/archive-groups";
import { FeedScroller, FeedView } from "./Feed";
import { MemberAvatar } from "./MemberAvatar";
import { PreviewDrawer } from "../components/PreviewDrawer";
import { useT } from "../i18n";

/** 点交付物 / 证据：一律进内置预览，不再拉起外部关联程序 */
type OpenPreview = (taskId: string, ref: string) => void;

/**
 * 值台（Dispatch Desk）—— 设计规范 §4 的三栏骨架：
 * 台账 258 / 图纸 flex / 编制表 384，底部指令台。
 * 三种声音：成员产出（等宽）/ 风铃（纸边批注）/ 你（朱砂印章）。
 */

const PERMISSIONS: { mode: PermissionMode; labelKey: string; en: string }[] = [
  { mode: "plan", labelKey: "perm.plan", en: "PLAN" },
  { mode: "ask", labelKey: "perm.ask", en: "ASK" },
  { mode: "auto", labelKey: "perm.auto", en: "AUTO" },
  { mode: "full", labelKey: "perm.full", en: "FULL" },
];

/** 归档带默认只露最近 5 条：历史列表不占满整条左栏，其余走「查看全部」 */
const ARCHIVE_PREVIEW = 5;

/** 台账分组（数组顺序即渲染顺序）；空组直接不渲染，不留占位假条目 */
const GROUP_META: { k: Exclude<JobGroup, "archived">; labelKey: string; color: string; stoppable: boolean }[] = [
  { k: "waiting", labelKey: "ledger.awaiting", color: "var(--seal)", stoppable: false },
  { k: "stuck", labelKey: "ledger.stuck", color: "var(--brass)", stoppable: true },
  { k: "running", labelKey: "ledger.running", color: "var(--blue)", stoppable: true },
  { k: "queued", labelKey: "ledger.queued", color: "var(--ink-4)", stoppable: false },
];

export function fmtTokens(n: number): string {
  if (n <= 0) return "0";
  return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
}

/**
 * 状态行计时（对齐蓝本 tether-ai 的 Elapsed：500ms 一跳）。
 * 只在这一轮真的在跑时才开定时器，结束后停掉——不留空转 interval。
 */
function useTick(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(id);
  }, [active]);
  return now;
}

function statusChipClass(job: DeskJob): string {
  // A6：朱砂只留给右栏印章；台账里"等你拍板"用蓝（st-hold），blocked 仍朱砂（要你止损，印章同样会出现）
  // 派给成员的活正在等风铃验：对你是"有人在弄"，按执行中上色，别冒充你的待办
  if (job.status === "in_review") return job.reviewer === "lynn" ? "st-live" : "st-hold";
  if (job.status === "blocked") return "st-wait";
  if (job.status === "in_progress") return "st-live";
  if (job.status === "done") return "st-done";
  return "st-idle";
}

// ============================ TOP RAIL ============================

function TopRail({
  desk,
  permission,
  onPermission,
  onOpenSettings,
  onUndo,
  pending,
  rightOpen,
  onToggleRight,
  mode = "desk",
  onBack,
  onPickProject,
  onClearWorkspace,
  onAddReadRoots,
  onRemoveReadRoot,
}: {
  desk: Desk;
  permission: PermissionMode;
  onPermission: (m: PermissionMode) => void;
  onOpenSettings: () => void;
  onUndo?: () => void;
  /** 等你的件数（只在窄窗显示成按钮，宽屏右栏本来就一直看得见） */
  pending?: number;
  rightOpen?: boolean;
  onToggleRight?: () => void;
  mode?: "desk" | "review";
  /** 审查台返回值台（E2）：唯一的深页面必须有显式出口，不能靠空态里的斜体链接 */
  onBack?: () => void;
  /** 换当前会话的工作区（项目根） */
  onPickProject?: () => void;
  /** 这次不用工作区（主根清空，产出落卷宗沙箱） */
  onClearWorkspace?: () => void;
  /** 给当前会话加只读目录（可多选） */
  onAddReadRoots?: () => void;
  /** 撤掉一个会话附加根 */
  onRemoveReadRoot?: (path: string) => void;
}) {
  const [wsMenu, setWsMenu] = useState(false);
  /** 菜单用 fixed 定位：顶栏与图纸都有 overflow / 层叠上下文，absolute 会被裁掉或盖住 */
  const [wsPos, setWsPos] = useState({ top: 0, left: 0 });
  const wsRef = useRef<HTMLDivElement | null>(null);
  const wsBtnRef = useRef<HTMLButtonElement | null>(null);
  const wsMenuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!wsMenu) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      // 菜单已 portal 到 body，不在 wsRef 里：两处都要判，否则点菜单项会被当成「点外面」
      if (wsRef.current?.contains(t) || wsMenuRef.current?.contains(t)) return;
      setWsMenu(false);
    };
    const close = () => setWsMenu(false);
    document.addEventListener("mousedown", onDown);
    // fixed 菜单不跟滚动/缩放走：位置一变就关掉，避免悬在错的地方
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [wsMenu]);
  const shortName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;
  const extras = desk.workspaceExtras;
  const ctx = desk.usage.contextWindow > 0 ? Math.min(1, desk.usage.contextTokens / desk.usage.contextWindow) : 0;
  const contextPct = Math.round(ctx * 100);
  const filled = Math.min(12, Math.max(0, Math.round(ctx * 12)));
  const t = useT();
  return (
    <header
      className="rail-top"
      onDoubleClick={() => {
        // 拖拽区双击 = 最大化/还原（no-drag 控件不受影响）
        try {
          Promise.resolve(window.lynn.rpc("window.control", { action: "maximize" })).catch(() => undefined);
        } catch {
          /* 假桥环境下忽略 */
        }
      }}
    >
      <div className="brand">
        <div className="brand-mark">
          <Icon name="bell" />
        </div>
        <div>
          <div className="brand-name">{t("top.brand")}</div>
          <div className="brand-sub">Lynn</div>
        </div>
      </div>
      <div className="vr" />
      {mode === "review" && onBack && (
        <button type="button" className="ghost-btn" onClick={onBack} title={t("top.backTitle")}>
          <Icon name="undo" size="sm" /> {t("top.back")}
        </button>
      )}
      <div className="crumbs">
        {/* 工作区 chip：点开是"换目录 / 不用工作区 / 可读目录"三件事，不再只跳一次目录框 */}
        <div className="wsmenu-wrap" ref={wsRef}>
          <button
            type="button"
            ref={wsBtnRef}
            className="crumb-chip crumb-btn"
            onClick={() => {
              const r = wsBtnRef.current?.getBoundingClientRect();
              if (r) setWsPos({ top: r.bottom + 6, left: r.left });
              setWsMenu((v) => !v);
            }}
            title={desk.workspacePrimary ?? t("top.projectHint", { dir: desk.project })}
          >
            <Icon name="folder" size="sm" /> {desk.project}
            {extras.length > 0 && <span className="wsmenu-badge">{extras.length}</span>}
            <Icon name="chev" size="sm" />
          </button>
          {wsMenu &&
            createPortal(
            <div ref={wsMenuRef} className="wsmenu" role="menu" style={{ top: wsPos.top, left: wsPos.left }}>
              <button
                type="button"
                className="jobmenu-item"
                onClick={() => {
                  setWsMenu(false);
                  onPickProject?.();
                }}
              >
                换工作区…
              </button>
              <button
                type="button"
                className="jobmenu-item"
                onClick={() => {
                  setWsMenu(false);
                  onClearWorkspace?.();
                }}
              >
                这次不用工作区
              </button>
              <div className="wsmenu-cap">可读目录</div>
              {extras.length === 0 && <div className="wsmenu-empty">还没有；需要读外部资料时加一个。</div>}
              {extras.map((x) => (
                <div className="wsmenu-row" key={x.path}>
                  <span className="nm" title={`${x.path}（${x.mode === "rw" ? "可写" : "只读"}）`}>
                    {x.label ?? shortName(x.path)}
                    {x.mode === "rw" && <b className="rw">可写</b>}
                  </span>
                  <button
                    type="button"
                    className="wsmenu-x"
                    title="撤掉这个目录的访问"
                    onClick={() => onRemoveReadRoot?.(x.path)}
                  >
                    ×
                  </button>
                </div>
              ))}
              <button
                type="button"
                className="jobmenu-item"
                onClick={() => {
                  setWsMenu(false);
                  onAddReadRoots?.();
                }}
              >
                添加只读目录…
              </button>
            </div>,
            document.body,
            )}
        </div>
      </div>
      <div className="spacer" />

      {/* 顶栏不再印工单号：左栏台账 + 右栏动态已经各有一处，第三个入口只是「—」这样的空占位 */}

      {/* 窄窗：右栏收成抽屉后，"等你拍板"必须有个进得去的入口（悬停边缘不算入口） */}
      {pending !== undefined && pending > 0 && onToggleRight && (
        <button
          type="button"
          className={`ghost-btn only-narrow pending-btn${rightOpen ? " on" : ""}`}
          onClick={onToggleRight}
          aria-pressed={rightOpen}
          title={t("top.pendingHint")}
        >
          <Icon name="shield" size="sm" /> {t("top.pending", { n: pending })}
        </button>
      )}

      {/* 审查台是深页面：权限档在这里是死按钮，干脆不渲染（E2） */}
      {mode !== "review" && (
        <>
          <div className="seg">
            {PERMISSIONS.map((p) => (
              <button
                type="button"
                key={p.mode}
                aria-pressed={permission === p.mode}
                className={`seg-item${p.mode === "full" ? " danger" : ""}${permission === p.mode ? " on" : ""}`}
                onClick={() => onPermission(p.mode)}
                title={t("top.switchTo", { label: t(p.labelKey) })}
              >
                {t(p.labelKey)}
              </button>
            ))}
          </div>

          <div className="vr" />
        </>
      )}

      {/* status.bar 卡槽：官方受限组件（用量读数） */}
      <Slot
        slot="status.bar"
        render={(p) =>
          p.html ? (
            <SandboxHtml plugin={p} width={132} height={22} />
          ) : p.sandbox ? null : (
            <span className="st st-idle" title={p.description ?? p.name}>
              {p.name} {fmtTokens(desk.tokensUsed)}
            </span>
          )
        }
      />

      {/* D3：会话级预算——真的配了软上限才出现（黄铜=预算的唯一样式归属，不画假数据） */}
      {desk.budget && (
        <span
          className={`budget-chip${desk.budget.spent >= desk.budget.soft ? " over" : ""}`}
          title={t("top.budgetTitle", {
            used: fmtTokens(desk.budget.spent),
            total: fmtTokens(desk.budget.soft),
          })}
        >
          {t("top.budget")} {Math.round((desk.budget.spent / desk.budget.soft) * 100)}%
        </span>
      )}

      {/* D3：33% 必须自带名字，不能靠 hover 才知道是上下文 */}
      <span className="gauge-label">{t("top.contextLabel")}</span>
      <div
        className={`gauge${contextPct >= 90 ? " warn" : contextPct >= 70 ? " near" : ""}`}
        title={`${t("top.contextTitle", {
          used: desk.usage.contextTokens,
          total: desk.usage.contextWindow,
          tokens: fmtTokens(desk.tokensUsed),
        })}${contextPct >= 70 ? ` · ${t("top.contextHint")}` : ""}`}
      >
        {/* 只留百分比：含义由 title 说明，顶栏不再为一个标签挤出竖排 */}
        <div className="gauge-read">
          <div className="v">{contextPct}%</div>
        </div>
        <div className="gauge-bar">
          {Array.from({ length: 12 }, (_, i) => (
            <i
              key={i}
              className={i < filled ? "on" : ""}
              style={{ height: `${8 + i}px` }}
            />
          ))}
        </div>
      </div>

      {/* 缓存命中率：来自 Pi 的 session stats（cacheRead / (uncachedInput + cacheRead + cacheWrite)）；prompt 为 0 时隐藏，不显示假 0 */}
      {(() => {
        const rate = cacheHitRate(desk.usage);
        if (rate === undefined) return null;
        return (
          <span
            className="cache-badge"
            title={t("top.cacheTitle", {
              rate: rate.toFixed(0),
              read: fmtTokens(desk.usage.cacheRead),
              write: fmtTokens(desk.usage.cacheWrite),
            })}
          >
            <i className="cache-dot" />
            {t("top.cache")} {rate.toFixed(0)}%
          </span>
        );
      })()}

      <div className="vr" />
      {desk.turn.canUndo && onUndo && (
        <button
          className="ghost-btn"
          onClick={onUndo}
          title={t("top.undoTitle", { files: (desk.turn.changedFiles ?? []).join("、") })}
        >
          <Icon name="undo" size="sm" /> {t("top.undo")}
        </button>
      )}
      {mode !== "review" && (
        <>
          <button className="ghost-btn" onClick={onOpenSettings} title={t("top.settings")}>
            <Icon name="user" size="sm" /> {t("top.settings")}
          </button>
        </>
      )}
      {/* 自绘窗口按钮（frame:false）：拖拽由 .rail-top 的 -webkit-app-region: drag 提供 */}
      <WindowControls />
    </header>
  );
}

// ============================ LEDGER ============================

function Ledger({
  desk,
  activeId,
  onSelect,
  onThread,
  onThreadNew,
  onThreadSearch,
  onThreadRename,
  onThreadRemove,
  onThreadPin,
  onCancelTask,
  onDismissTask,
  onRemoveTask,
  onGrantRead,
  onRevokeRead,
  onSnapshotProject,
  onExportTask,
  onPreview,
}: {
  desk: Desk;
  activeId?: string;
  /** 交付物点开走内置预览 */
  onPreview?: OpenPreview;
  onSelect: (id: string) => void;
  onThread?: (id: string) => void;
  onThreadNew?: () => void;
  onThreadSearch?: (q: string) => Promise<{ id: string; title: string; hits: string[] }[]>;
  /** 会话改名 / 删除（C5：列表只增不减、按时间找不到人） */
  onThreadRename?: (id: string, title: string) => void;
  onThreadRemove?: (id: string) => void;
  /** 置顶 / 取消置顶（群列表微信式） */
  onThreadPin?: (id: string, pinned: boolean) => void;
  /** 停一张在跑的单（此前只能解散全队止损） */
  onCancelTask?: (taskId: string) => void;
  /** 取消一张单（→ 归档带）/ 彻底删除（不可恢复） */
  onDismissTask?: (taskId: string) => void;
  onRemoveTask?: (taskId: string) => void;
  /** 只读授权：成员能读这个目录，写仍限工作区 */
  onGrantRead?: (taskId: string) => void;
  onRevokeRead?: (taskId: string) => void;
  /** 审查快照：拷进任务沙箱再跑测试 */
  onSnapshotProject?: (taskId: string) => void;
  /** 导出卷宗 zip */
  onExportTask?: (taskId: string) => void;
}) {
  const [q, setQ] = useState("");
  const [showAllArchive, setShowAllArchive] = useState(false);
  /** 归档删除两段确认：第一次点亮「确认」，第二次才真删 */
  const [archDeleting, setArchDeleting] = useState<string | null>(null);
  /** 归档折叠：按「会话 + 归一化标题」分组，多记录的组默认收起；只影响展示，不合并、不删除数据 */
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  /** 左栏三视图：会话 / 工单 / 交付箱（跨任务汇总的交付物） */
  const [view, setView] = useState<"threads" | "jobs" | "outputs">("threads");
  const [tq, setTq] = useState("");
  const [hits, setHits] = useState<{ id: string; title: string; hits: string[] }[]>([]);
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  /** 工单卡右键菜单：卡住的单原来只能在台账里干瞪眼 */
  const [menu, setMenu] = useState<{ job: DeskJob; x: number; y: number } | null>(null);
  const t = useT();
  const match = (j: DeskJob) => !q || `${j.id} ${j.title} ${j.member ?? ""}`.toLowerCase().includes(q.toLowerCase());

  // 分组只认 desk.jobs[].group（shared/task-groups）：等你的只有 in_review，
  // 卡住是单独一组，未开工的 backlog/todo 不再混进"进行中"。
  const visible = desk.jobs.filter(match);
  const byGroup = (g: JobGroup) => visible.filter((j) => j.group === g);
  const archived = desk.archived.filter((a) => !q || `${a.id} ${a.title}`.toLowerCase().includes(q.toLowerCase()));
  // 分组只用于渲染；archived 里的每一条仍原样保留，展开后可逐张打开 / 删除。
  const archiveGroups = groupArchived(archived);
  const activeCount = desk.jobs.filter((j) => j.group !== "archived").length;
  // 交付箱：跨任务汇总「用户要带走的东西」，物理文件不搬家
  const outputs = desk.jobs.flatMap((j) =>
    (j.deliverables ?? []).map((d) => ({ job: j, path: d.path, ref: d.ref, bytes: d.bytes })),
  );
  const openableRef = (ref: string) => !!ref && !/^[a-zA-Z]:[\\/]/.test(ref) && !ref.startsWith("/");
  const fmtB = (n?: number) =>
    !n ? "" : n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB` : n >= 1024 ? `${Math.round(n / 1024)}KB` : `${n}B`;

  return (
    <aside className="ledger">
      {/* 左栏第一屏就是"会话"：对话历史不再藏在一个按钮后面 */}
      <div className="rail-seg">
        <button
          type="button"
          className={`rail-seg-item${view === "threads" ? " on" : ""}`}
          onClick={() => setView("threads")}
        >
          {t("rail.threads")}
          <span className="n">{desk.threads.length}</span>
        </button>
        <button
          type="button"
          className={`rail-seg-item${view === "jobs" ? " on" : ""}`}
          onClick={() => setView("jobs")}
        >
          {t("rail.jobs")}
          <span className="n">{activeCount}</span>
        </button>
        <button
          type="button"
          className={`rail-seg-item${view === "outputs" ? " on" : ""}`}
          onClick={() => setView("outputs")}
          title="交付箱：所有验收过的交付物（物理文件仍在原处）"
        >
          {t("rail.outputs")}
          <span className="n">{outputs.length}</span>
        </button>
        <button
          type="button"
          className="icon-btn rail-new"
          onClick={onThreadNew}
          title={t("top.newThread")}
          aria-label={t("top.newThread")}
        >
          <Icon name="plus" size="sm" />
        </button>
      </div>

      {view === "threads" && (
        <>
          <label className="search qrow">
            <Icon name="search" size="sm" />
            {/* E4：同族搜索框必须亮明搜索范围，不然用户把工单号敲进全文框还以为数据丢了 */}
            <span className="scope-tag">{t("top.scopeThreads")}</span>
            <input
              className="thread-q qin"
              value={tq}
              placeholder={t("top.searchHistory")}
              onChange={(e) => {
                const v = e.target.value;
                setTq(v);
                if (!v.trim()) {
                  setHits([]);
                  return;
                }
                void (onThreadSearch?.(v) ?? Promise.resolve([])).then(setHits);
              }}
            />
          </label>
          <div className="ledger-scroll thread-scroll">
          {tq.trim()
            ? hits.map((h) => (
                <button
                  type="button"
                  key={h.id}
                  className="thread-row"
                  onClick={() => onThread?.(h.id)}
                >
                  <b>{h.title}</b>
                  <small>{h.hits[0]}</small>
                </button>
              ))
            : [...desk.threads]
                // 微信式群列表：置顶的排最前，其余按最近动的排
                .sort(
                  (a, b) =>
                    Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) ||
                    (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""),
                )
                .map((th) => {
                const on = th.id === desk.thread.id;
                // C5：会话列表要能改名/删除，否则列表只增不减、按时间也找不到人
                const edit = renaming && renaming.id === th.id ? renaming : null;
                return (
                  <div className="thread-line" key={th.id}>
                    {edit ? (
                      <input
                        className="thread-q thread-rename"
                        autoFocus
                        value={edit.title}
                        aria-label={t("ledger.threadRename")}
                        placeholder={t("ledger.threadRenameHint")}
                        onChange={(e) => setRenaming({ id: th.id, title: e.target.value })}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            const title = edit.title.trim();
                            if (title) onThreadRename?.(th.id, title);
                            setRenaming(null);
                          } else if (e.key === "Escape") {
                            setRenaming(null);
                          }
                        }}
                      />
                    ) : (
                      <>
                        <button
                          type="button"
                          className={`thread-row${on ? " on" : ""}`}
                          onClick={() => onThread?.(th.id)}
                        >
                          <span className="thread-av" aria-hidden>
                            {(th.title || "群").slice(0, 1)}
                          </span>
                          <span className="thread-main">
                            <span className="thread-row1">
                              <span className="thread-name">
                                {th.title || t("ledger.untitled")}
                                {th.pinned && <span className="thread-pin">置顶</span>}
                              </span>
                              <span className="thread-time mono">{fmtTime(th.updatedAt)}</span>
                            </span>
                            <span className="thread-prev">{th.lastPreview ?? ""}</span>
                          </span>
                          {th.unread ? (
                            <span className="thread-badge">{th.unread > 99 ? "99+" : th.unread}</span>
                          ) : (
                            th.counts &&
                            th.counts.active > 0 && (
                              <span className="thread-counts mono">{th.counts.active}</span>
                            )
                          )}
                        </button>
                        <span className="thread-acts">
                          <button
                            type="button"
                            className="thread-act"
                            title={th.pinned ? "取消置顶" : "置顶"}
                            onClick={() => onThreadPin?.(th.id, !th.pinned)}
                          >
                            <Icon name="target" size="sm" />
                          </button>
                          <button
                            type="button"
                            className="thread-act"
                            title={t("ledger.threadRename")}
                            onClick={() => {
                              setDeleting(null);
                              setRenaming({ id: th.id, title: th.title });
                            }}
                          >
                            <Icon name="pen" size="sm" />
                          </button>
                          <button
                            type="button"
                            className="thread-act"
                            title={t("ledger.threadDelete")}
                            onClick={() => {
                              setRenaming(null);
                              setDeleting(deleting === th.id ? null : th.id);
                            }}
                          >
                            <Icon name="x" size="sm" />
                          </button>
                        </span>
                      </>
                    )}
                    {deleting === th.id && (
                      <div className="thread-ask">
                        <span>{t("ledger.threadDeleteAsk")}</span>
                        <span className="thread-ask-acts">
                          <button type="button" className="ghost-btn" onClick={() => setDeleting(null)}>
                            {t("common.cancel")}
                          </button>
                          <button
                            type="button"
                            className="ghost-btn thread-danger"
                            onClick={() => {
                              setDeleting(null);
                              onThreadRemove?.(th.id);
                            }}
                          >
                            {t("ledger.threadDelete")}
                          </button>
                        </span>
                      </div>
                    )}
                  </div>
                );
              })}
          {tq.trim() && hits.length === 0 && <p className="sf-empty">没有匹配的历史。</p>}
          {/* 会话删光了：列表不能只剩一个搜索框，给一句说明 + 顺手开的动作 */}
          {!tq.trim() && desk.threads.length === 0 && (
            <div className="thread-none">
              <p>{t("rail.threadsNone")}</p>
              <button type="button" className="ghost-btn" onClick={onThreadNew}>
                {t("rail.threadsNoneCta")}
              </button>
            </div>
          )}
          </div>
        </>
      )}

      {view === "jobs" && (
        <>
      <label className="search">
        <Icon name="search" size="sm" />
        {/* E4：与「会话全文」框同族，必须亮明这里是本台账范围 */}
        <span className="scope-tag">{t("ledger.scopeBoard")}</span>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t("top.searchBoard")}
          style={{ background: "none", border: 0, outline: 0, color: "inherit", font: "inherit", flex: 1, minWidth: 0 }}
        />
      </label>

      <div className="ledger-scroll">
        {/* 空组不占位（原来每组一句斜体提示，读起来像一条工单）；首屏空态居中成引导，不像一条被禁用的记录（D5） */}
        {desk.jobs.length === 0 && (
          <div className="ledger-lede">
            <span className="t">{t("ledger.ledeTitle")}</span>
            <span className="h">{t("ledger.runningEmpty")}</span>
          </div>
        )}
        {desk.jobs.length > 0 && visible.length === 0 && <div className="ledger-empty">{t("ledger.noMatch")}</div>}
        {GROUP_META.map((g) => {
          const items = byGroup(g.k);
          if (items.length === 0) return null;
          return (
            <div key={g.k}>
              <div className="grp-label">
                <span className="dot" style={{ background: g.color }} /> {t(g.labelKey, { n: items.length })}
              </div>
              {items.map((j) => (
                <JobRow
                  key={j.id}
                  job={j}
                  active={j.id === activeId}
                  showTeam={desk.teamCount > 1}
                  onClick={() => onSelect(j.id)}
                  onCancel={desk.running.includes(j.id) ? onCancelTask : undefined}
                  onMenu={(e) => setMenu({ job: j, x: e.clientX, y: e.clientY })}
                />
              ))}
            </div>
          );
        })}

        {archived.length > 0 && (
          <div className="archive-band">
            <div className="ab-h">
              <Icon name="archive" size="sm" />
              <span>{t("ledger.archiveStrip")}</span>
              <span
                className="mono"
                style={{ marginLeft: "auto" }}
                title={`共 ${archived.length} 条 · ${archiveGroups.length} 组；折叠只影响展示，记录与卷宗一张不少`}
              >
                {archived.length}
              </span>
            </div>
            <ol>
              {(showAllArchive ? archiveGroups : archiveGroups.slice(0, ARCHIVE_PREVIEW)).map((g) => {
                const open = expandedGroups.has(g.key);
                const toggle = () =>
                  setExpandedGroups((prev) => {
                    const next = new Set(prev);
                    if (next.has(g.key)) next.delete(g.key);
                    else next.add(g.key);
                    return next;
                  });
                // 组内每一条仍是独立归档行：可点开、可逐张删除；右键本行也能进入删除确认。
                const rows = g.items.map((a) => (
                  <li
                    className="arch-row"
                    key={a.id}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setArchDeleting(a.id);
                    }}
                  >
                    <button
                      type="button"
                      className={`arch-item${a.id === activeId ? " on" : ""}`}
                      title={`打开 ${a.id}（~/.lynn/tasks/${a.id}/）`}
                      onClick={() => onSelect(a.id)}
                    >
                      <span className="arch-title">{a.title || a.id}</span>
                      <span className="arch-state">{t(STATUS_KEY[(a.status ?? "done") as TaskStatus], {})}</span>
                    </button>
                    <button
                      type="button"
                      className={`arch-del${archDeleting === a.id ? " sure" : ""}`}
                      title={archDeleting === a.id ? "再点一次：连卷宗一起彻底删掉" : "删除这张归档单（也可右键本行）"}
                      aria-label={archDeleting === a.id ? "确认删除" : "删除这张归档单"}
                      onClick={() => {
                        if (archDeleting !== a.id) {
                          setArchDeleting(a.id);
                          return;
                        }
                        onRemoveTask?.(a.id);
                        setArchDeleting(null);
                      }}
                    >
                      {archDeleting === a.id ? "确认删除" : <Icon name="x" size="sm" />}
                    </button>
                  </li>
                ));
                // 单条组没有折叠意义，直接显示，不额外增加一次点击。
                if (g.count === 1) return rows[0];
                return (
                  <li className="arch-group" key={g.key}>
                    <button
                      type="button"
                      className="arch-group-h"
                      aria-expanded={open}
                      title={open ? t("ledger.archiveLess") : t("ledger.archiveExpand", { n: g.count })}
                      onClick={toggle}
                    >
                      <span className="arch-caret" aria-hidden>{open ? "▾" : "▸"}</span>
                      <span className="arch-title">{g.title}</span>
                      <span className="arch-count mono">×{g.count}</span>
                    </button>
                    {open && <ol className="arch-sub">{rows}</ol>}
                  </li>
                );
              })}
            </ol>
            {archiveGroups.length > ARCHIVE_PREVIEW && (
              <button type="button" className="strip-link" onClick={() => setShowAllArchive((v) => !v)}>
                {showAllArchive ? t("ledger.archiveLess") : t("ledger.archiveAll", { n: archived.length })}
              </button>
            )}
          </div>
        )}

      </div>
        </>
      )}
      {menu && (
        <JobMenu
          job={menu.job}
          x={menu.x}
          y={menu.y}
          running={desk.running.includes(menu.job.id)}
          onClose={() => setMenu(null)}
          onOpen={() => {
            onSelect(menu.job.id);
            setMenu(null);
          }}
          onThread={
            menu.job.threadId && onThread
              ? () => {
                  onThread(menu.job.threadId!);
                  setMenu(null);
                }
              : undefined
          }
          onStop={
            onCancelTask && desk.running.includes(menu.job.id)
              ? () => {
                  onCancelTask(menu.job.id);
                  setMenu(null);
                }
              : undefined
          }
          onDismiss={
            onDismissTask
              ? () => {
                  onDismissTask(menu.job.id);
                  setMenu(null);
                }
              : undefined
          }
          onRemove={
            onRemoveTask
              ? () => {
                  onRemoveTask(menu.job.id);
                  setMenu(null);
                }
              : undefined
          }
          onGrantRead={
            onGrantRead
              ? () => {
                  onGrantRead(menu.job.id);
                  setMenu(null);
                }
              : undefined
          }
          onRevokeRead={
            onRevokeRead && (menu.job.readRoots?.length ?? 0) > 0
              ? () => {
                  onRevokeRead(menu.job.id);
                  setMenu(null);
                }
              : undefined
          }
          onSnapshotProject={
            onSnapshotProject
              ? () => {
                  onSnapshotProject(menu.job.id);
                  setMenu(null);
                }
              : undefined
          }
          onExport={
            onExportTask
              ? () => {
                  onExportTask(menu.job.id);
                  setMenu(null);
                }
              : undefined
          }
        />
      )}

      {view === "outputs" && (
        <div className="ledger-scroll">
          {outputs.length === 0 && (
            <div className="ledger-empty">
              <span>还没有交付物。成员回报时会单独列出「要给你带走的东西」，验收后永久保留。</span>
            </div>
          )}
          {outputs.map((o, i) => {
            const openable = openableRef(o.ref);
            return (
              <button
                type="button"
                key={`${o.job.id}-${o.path}-${i}`}
                className="thread-row"
                disabled={!openable}
                title={`${o.path}\n${o.ref}${o.bytes ? `\n${fmtB(o.bytes)}` : ""}${openable ? "\n点击内置预览" : "\n（外部路径，去原位置查看）"}`}
                onClick={() => {
                  if (openable) onPreview?.(o.job.id, o.ref);
                }}
              >
                <b>{o.path.split(/[\\/]/).filter(Boolean).pop() ?? o.path}</b>
                <small className="mono">
                  {o.job.id}
                  {o.bytes ? ` · ${fmtB(o.bytes)}` : ""}
                </small>
              </button>
            );
          })}
        </div>
      )}

      {/* 自动化 / 能力与插件 / 编制统一从「我的风铃」进（相同功能入口只留一个） */}
    </aside>
  );
}

function JobRow({
  job,
  active,
  showTeam,
  onClick,
  onCancel,
  onMenu,
}: {
  job: DeskJob;
  active: boolean;
  /** 多团队时首行显示团队名（=这张单属于哪条任务线）；单团队不啰嗦 */
  showTeam?: boolean;
  onClick: () => void;
  onCancel?: (taskId: string) => void;
  onMenu?: (e: React.MouseEvent) => void;
}) {
  const t = useT();
  const running = job.status === "in_progress";
  return (
    // 外层用 div：里面要放「停」按钮，button 套 button 是非法结构
    <div
      className={`job${active ? " on" : ""}`}
      data-status={job.status}
      data-group={job.group}
      data-running={running ? "1" : undefined}
      role="button"
      tabIndex={0}
      // 工单号不再占据首行（没人记得 WO-2418）：需要时悬停看，审计在图纸里
      title={`${job.id}${job.teamName ? ` · ${job.teamName}` : ""}`}
      onClick={onClick}
      onContextMenu={(e) => {
        if (!onMenu) return;
        e.preventDefault();
        onMenu(e);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
    >
      <div className="job-top">
        <span className="job-mark" />
        {showTeam && job.teamName ? (
          <span className="job-team">
            <Icon name="users" size="sm" /> {job.teamName}
          </span>
        ) : (
          <span className="job-id">{job.id}</span>
        )}
        <span className={`st ${statusChipClass(job)}`}>
          {running && <span className="pip" />}
          {t(STATUS_KEY[job.status] ?? "status.todo")}
        </span>
      </div>
      <div className="job-title" title={job.title}>{job.title}</div>
      <div className="job-meta">
        <MemberAvatar name={job.member ?? t("sheet.lynn")} size={20} />
        <span className="job-who">{job.member ?? t("sheet.lynn")}</span>
        <span className="job-dot">·</span>
        <span className="mono">{fmtTime(job.at)}</span>
        {running && onCancel && (
          <button
            type="button"
            className="ghost-btn"
            title={t("ledger.stopTitle")}
            style={{ marginLeft: "auto" }}
            onClick={(e) => {
              e.stopPropagation();
              onCancel(job.id);
            }}
          >
            {t("ledger.stop")}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * 工单卡右键菜单（2026-11-04）：
 * 卡住的单一度只能挂在台账里——「停」只 abort 成员、不改状态，「新对话」也不动后台。
 * 这里给四件事：打开 / 去出发会话 / 停成员 / 取消或删除（二次确认）。
 */
function JobMenu({
  job,
  x,
  y,
  running,
  onClose,
  onOpen,
  onThread,
  onStop,
  onDismiss,
  onRemove,
  onGrantRead,
  onRevokeRead,
  onSnapshotProject,
  onExport,
}: {
  job: DeskJob;
  x: number;
  y: number;
  running: boolean;
  onClose: () => void;
  onOpen: () => void;
  onThread?: () => void;
  onStop?: () => void;
  onDismiss?: () => void;
  onRemove?: () => void;
  /** 只读授权（用户亲手选目录；写仍限工作区） */
  onGrantRead?: () => void;
  onRevokeRead?: () => void;
  /** 把工作区复制进任务沙箱再跑测试（原项目不动） */
  onSnapshotProject?: () => void;
  /** 导出卷宗 zip */
  onExport?: () => void;
}) {
  const t = useT();
  const [confirm, setConfirm] = useState<null | "dismiss" | "remove">(null);
  const box = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const done = job.status === "done" || job.status === "canceled";
  const style = {
    left: Math.max(8, Math.min(x, (window.innerWidth || 1200) - 240)),
    top: Math.max(8, Math.min(y, (window.innerHeight || 800) - 232)),
  };
  return (
    <div className="jobmenu" ref={box} style={style} role="menu" aria-label={job.id}>
      <div className="jobmenu-h">
        {/* 菜单头也用任务名：工单号放下面一行小字，审计时再认 */}
        <span className="jobmenu-title" title={job.title}>
          {job.title}
        </span>
        <span className={`st ${statusChipClass(job)}`}>{t(STATUS_KEY[job.status] ?? "status.todo")}</span>
      </div>
      <div className="jobmenu-sub mono" title={t("tov.idHint")}>
        {job.id}
        {job.teamName ? ` · ${job.teamName}` : ""}
      </div>
      {confirm ? (
        <>
          <p className="jobmenu-ask">{confirm === "dismiss" ? t("menu.dismissAsk") : t("menu.removeAsk")}</p>
          <button
            type="button"
            className={`jobmenu-item${confirm === "remove" ? " danger" : ""}`}
            onClick={() => {
              if (confirm === "dismiss") onDismiss?.();
              else onRemove?.();
              onClose();
            }}
          >
            {t("menu.confirm")}
          </button>
          <button type="button" className="jobmenu-item" onClick={() => setConfirm(null)}>
            {t("common.cancel")}
          </button>
        </>
      ) : (
        <>
          <button type="button" className="jobmenu-item" onClick={onOpen}>
            {t("menu.open")}
          </button>
          {onThread && (
            <button type="button" className="jobmenu-item" onClick={onThread}>
              {t("menu.thread")}
            </button>
          )}
          {onStop && (
            <button type="button" className="jobmenu-item" onClick={onStop}>
              {t("menu.stop")}
            </button>
          )}
          {onGrantRead && (
            <button type="button" className="jobmenu-item" onClick={onGrantRead}>
              {t("menu.grantRead")}
            </button>
          )}
          {onRevokeRead && (
            <button type="button" className="jobmenu-item" onClick={onRevokeRead}>
              {t("menu.revokeRead")}
            </button>
          )}
          {onSnapshotProject && (
            <button type="button" className="jobmenu-item" onClick={onSnapshotProject}>
              拷进任务沙箱跑测试…
            </button>
          )}
          {onExport && (
            <button type="button" className="jobmenu-item" onClick={onExport}>
              导出卷宗 zip…
            </button>
          )}
          {!done && onDismiss && (
            <button type="button" className="jobmenu-item" onClick={() => setConfirm("dismiss")}>
              {t("menu.dismiss")}
            </button>
          )}
          {!running && job.status !== "in_progress" && onRemove && (
            <button type="button" className="jobmenu-item danger" onClick={() => setConfirm("remove")}>
              {t("menu.remove")}
            </button>
          )}
        </>
      )}
    </div>
  );
}

// ============================ SHEET ============================

const CHANNEL_TAB = { k: "channel", labelKey: "sheet.tabChannel", icon: "term" as IconName };
const FEED_TAB = { k: "feed", labelKey: "sheet.tabFeed", icon: "bell" as IconName };

/** 卷宗事件类型 → 人话（详情区状态时间线；kind 由内核 taskCase 固定） */
const TIMELINE_LABEL: Record<string, string> = {
  created: "建单", assign: "派单", report: "回报", reject: "打回", approve: "验收",
  transition: "状态", artifact: "产物", note: "记录", session: "会话",
};

function Sheet({
  job,
  feed,
  threadId,
  threadTitle,
  onTaskFeed,
  onThread,
  onFeedAction,
  onExample,
  onNewThread,
  onBackToChannel,
  pendingJob,
  onOpenJob,
  onPreview,
  running,
}: {
  job?: DeskJob;
  feed: FeedCard[];
  onPreview?: OpenPreview;
  /** 真正在跑的任务 id（desk.running）：进度卡据此亮起"执行中"脉冲 */
  running?: string[];
  /** 当前会话 id：工单的出发会话不同时，往来要去那边读 */
  threadId?: string;
  /** 工单出发会话的标题（C3：眉标要能"回到会话"，标题比 id 好认） */
  threadTitle?: string;
  onTaskFeed?: (taskId: string) => Promise<{ cards: FeedCard[]; threadId?: string; threadTitle?: string }>;
  onThread?: (id: string) => void;
  onFeedAction?: (c: FeedCard) => void;
  onExample?: (text: string) => void;
  /** 空场里的「开一条会话」 */
  onNewThread?: () => void;
  /** 从工单详情回到本会话频道（清掉选中态，而不是切线程） */
  onBackToChannel?: () => void;
  /** 有待拍板的单时，频道里给一个显式入口，不自动抢走主区 */
  pendingJob?: { id: string; title: string };
  onOpenJob?: (id: string) => void;
}) {
  // 打开工单先看「本会话对话」：用户要改口/调简报时，得先看见自己与风铃说了什么
  const [tab, setTab] = useState("channel");
  /** 来自另一个会话的往来（当前 feed 里没有） */
  const [foreign, setForeign] = useState<{ cards: FeedCard[]; threadId: string; title?: string } | null>(null);
  // 频道 = 群。除了无归属的对话，带作者的动作卡（成员交付、风铃调度）也要在群里出现：
  // 否则成员干完活只在工单详情里看得见，群里像没人干过活（群聊模式的核心）。
  const channel = useMemo(() => feed.filter((c) => !c.jobId || c.author), [feed]);
  const t = useT();
  const jobId = job?.id;
  const jobThread = job?.threadId;

  useEffect(() => {
    setForeign(null);
    if (!jobId || !jobThread || jobThread === threadId || !onTaskFeed) return;
    let alive = true;
    void onTaskFeed(jobId)
      .then((r) => {
        if (!alive || !r.cards.length) return;
        setForeign({ cards: r.cards, threadId: r.threadId ?? jobThread, title: r.threadTitle });
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [jobId, jobThread, threadId, onTaskFeed]);

  // 空场优先于工单详情：没有会话时不该还挂着某张单的往来（真数据里那些单已被级联清掉）
  if (!threadId) {
    // 空场：最后一条会话被删掉之后的样子。这不是"新建了一条空会话"，
    // 所以不能说「说吧，要办什么」——先给一个明确的开场动作。
    return (
      <div className="sheet blank-sheet">
        <div className="sheet-head">
          <div className="sheet-eyebrow">
            <span>{t("sheet.lynn")}</span>
            <span style={{ opacity: 0.4 }}>/</span>
            <span>{t("sheet.blank")}</span>
          </div>
          <h1 className="sheet-title">{t("sheet.blankTitle")}</h1>
          <div className="sheet-sub">{t("sheet.blankSub")}</div>
        </div>
        <div className="sheet-body blank-body">
          <button type="button" className="blank-cta" onClick={onNewThread}>
            <Icon name="plus" size="sm" />
            {t("sheet.blankCta")}
          </button>
          <p className="blank-hint">{t("sheet.blankHint")}</p>
        </div>
        {/* 空场不画 titleblock：六格全是「—」等于把没有的信息画了一遍 */}
      </div>
    );
  }

  if (!job) {
    return (
      <div className="sheet">
        <div className="sheet-head">
          <div className="sheet-eyebrow">
            <span>{t("sheet.channel")}</span>
            <span style={{ opacity: 0.4 }}>/</span>
            <span>{t("sheet.noJob")}</span>
          </div>
          <h1 className="sheet-title">{t("sheet.emptyTitle")}</h1>
          <div className="sheet-sub">{t("sheet.emptySub")}</div>
          {pendingJob && (
            <div className="sheet-sub" style={{ marginTop: 8 }}>
              {t("sheet.pendingJob", { n: 1 })}{" "}
              <button type="button" className="strip-link" title={pendingJob.title} onClick={() => onOpenJob?.(pendingJob.id)}>
                {t("sheet.openJob")} →
              </button>
            </div>
          )}
        </div>
        <div className="sheet-body">
          <FeedScroller resetKey={threadId ?? "channel"}>
            <FeedView
              cards={channel}
              onAction={onFeedAction}
              collapseHistory
              runningIds={running}
              onPreview={onPreview}
              empty={
                <>
                  {t("sheet.feedEmpty")}
                  <span className="feed-examples">
                    <button type="button" onClick={() => onExample?.(t("sheet.exampleCsv"))}>
                      {t("sheet.exampleCsvBtn")}
                    </button>
                    <button type="button" onClick={() => onExample?.(t("sheet.exampleRepo"))}>
                      {t("sheet.exampleRepoBtn")}
                    </button>
                  </span>
                </>
              }
            />
          </FeedScroller>
        </div>
      </div>
    );
  }

  const evidence = job.evidence;
  const overBudget = !!job.budget && job.budget.used > job.budget.total;
  // 时间线只留有信息量的最近两条：session 是内部会话 ID；最后一条 transition 与上面的
  // 「状态」重复；回报正文可能很长，压成一句摘要（全文仍在 hover title 与卷宗里）。
  const timelineEvents = (job.timeline ?? [])
    .filter((e) => e.kind !== "session")
    .filter((e, i, arr) => !(e.kind === "transition" && i === arr.length - 1))
    .slice(-2)
    .reverse();
  const timelineBrief = (e: { kind: string; text: string }) => {
    const text = String(e.text ?? "");
    return e.kind === "report" && text.length > 44 ? `${text.slice(0, 44)}…` : text;
  };
  // 工作区已经单独显示过一次：只读授权里与它重复的目录不再报一遍（同一路径两行是噪音）
  const extraReadRoots = (job.readRoots ?? []).filter((d) => d !== job.workspaceRoot);
  // 只收本单的卡：频道消息不该混进工单往来（原来 `|| !c.jobId` 把全局对话塞进每张单）
  const ownCards = feed.filter((c) => c.jobId === job.id);
  const jobCards = ownCards.length > 0 ? ownCards : (foreign?.cards ?? []);

  return (
    <div className="sheet">
      <div className="sheet-head">
        <div className="sheet-eyebrow">
          {/* D2 信息唯一归属：工单号只在 crumbs + titleblock，眉标不再报一遍；角色归右栏成员卡（同屏两遍就是噪音） */}
          <span className="team">{job.teamName ?? job.teamId}</span>
          <span className="sep">/</span>
          <span title={job.memberRole ? `${job.member} · ${job.memberRole}` : job.member}>
            {t("sheet.assignedTo", { who: job.member ?? t("sheet.lynn") })}
          </span>
          {/* 回程入口只留一个：跨会话单回「派单会话」，同会话单回「本会话对话」。
              两个「← 回到对话」并排出现在同一条眉标里，比没有入口还乱。 */}
          {job.threadId && job.threadId !== threadId ? (
            <button
              type="button"
              className="eyebrow-link"
              title={t("sheet.backToThreadTitle", { title: threadTitle ?? job.threadId })}
              onClick={() => onThread?.(job.threadId!)}
            >
              ← {t("sheet.backToThread")}
              {threadTitle ? `《${threadTitle}》` : ""}
            </button>
          ) : (
            <button
              type="button"
              className="eyebrow-link"
              title={t("sheet.backToChannelTitle")}
              onClick={() => onBackToChannel?.()}
            >
              ← {t("sheet.backToChannel")}
            </button>
          )}
        </div>

        {/* 标题只当标题用：最多两行，完整原文放 title；正文不再被一段话霸屏 */}
        <h1 className="sheet-title" title={job.title}>
          {job.title}
        </h1>

        {/* 主信息：这张单走到第几轮、现在什么状态、最近发生了什么。优先于一切计数与预算。 */}
        <div className="sheet-primary">
          <div className="sp-head">
            <span className="sp-round">第 {job.round ?? 1} 轮</span>
            <span className="sp-state">{job.statusLabel}</span>
            <span className="sp-at mono">{job.at ? fmtTime(job.at) : ""}</span>
            {job.group === "archived" && <span className="sp-state">已归档</span>}
          </div>
          {timelineEvents.length > 0 && (
            <ol className="sp-timeline" aria-label={t("sheet.timelineLabel")}>
              {timelineEvents.map((e, i) => (
                <li key={`${e.kind}-${i}`} title={e.text}>
                  <span className="sp-t mono">{fmtTime(e.at)}</span>
                  <span className="sp-k">{TIMELINE_LABEL[e.kind] ?? e.kind}</span>
                  <span className="sp-v">{timelineBrief(e)}</span>
                </li>
              ))}
            </ol>
          )}
        </div>

        {/* 次级信息一律收进折叠区：预算明细（含超额）、工作区、只读授权、证据与往来计数。
            页签仍可点，计数改在下面汇总，不再铺满标题区。 */}
        <details className="sheet-stats">
          <summary>
            <span>{t("sheet.statsToggle")}</span>
            {overBudget && <span className="sp-warn">{t("sheet.budgetOver")}</span>}
          </summary>
          <div className="sp-grid">
            {job.budget && (
              <div className="sp-cell">
                <span className="sp-k">{t("sheet.budgetLabel")}</span>
                <b className="mono">
                  {job.budgetKind === "money"
                    ? `¥${job.budget.used.toFixed(2)} / ¥${job.budget.total.toFixed(2)}`
                    : `${job.budget.used}K / ${job.budget.total}K`}
                </b>
                {overBudget && <span className="sp-warn">{t("sheet.budgetOver")}</span>}
              </div>
            )}
            {job.workspaceRoot && (
              <div className="sp-cell" title={job.workspaceRoot}>
                <span className="sp-k">{t("sheet.workspace")}</span>
                <span className="mono">{job.workspaceRoot.split(/[\\/]/).filter(Boolean).pop()}</span>
              </div>
            )}
            {extraReadRoots.length > 0 && (
              <div className="sp-cell" title={extraReadRoots.join("\n")}>
                <span className="sp-k">只读授权</span>
                <span className="mono">{extraReadRoots.join("、")}</span>
              </div>
            )}
            <div className="sp-cell">
              <span className="sp-k">{t("sheet.deliverables")}</span>
              <span className="mono">{job.deliverables?.length ?? 0}</span>
            </div>
            <div className="sp-cell">
              <span className="sp-k">{t("sheet.statsCounts")}</span>
              <span className="mono">
                {t("sheet.statsCountsValue", { channel: channel.length, feed: jobCards.length, evidence: evidence.length })}
              </span>
            </div>
          </div>
        </details>
      </div>

      {/* 阶段与页签合成一条"导航带"：两行并一行，标题区才不被挤成糊 */}
      <div className="sheet-toolbar">
        {/* 阶段压成一行刻度：只有当前这一步会转。已完成的用勾，其余用淡点，
            编号底圆和逐段连线都是重复噪音，去掉后靠留白分节奏。 */}
        <div className="steps" aria-label={t("sheet.stageFlow")}>
          {STAGE_KEYS.map((key, i) => {
            const done = i < job.stage;
            const now = i === job.stage;
            // 只有真有成员在跑才转：待审查/卡住时转圈会让人以为还在执行
            const live = now && job.group === "running";
            return (
              <span
                key={key}
                className={`step${done ? " done" : now ? " now" : ""}${live ? " live" : ""}`}
                aria-current={now ? "step" : undefined}
              >
                <span className="step-mark" aria-hidden="true">
                  {live ? (
                    <svg className="step-ring" viewBox="0 0 16 16">
                      <circle className="track" cx="8" cy="8" r="6" />
                      <circle className="arc" cx="8" cy="8" r="6" />
                    </svg>
                  ) : (
                    // 完成态只给一个实心点：六段各挂一个对勾，符号比阶段名还抢眼
                    <span className={`step-dot${done ? " on" : ""}`} />
                  )}
                </span>
                <span className="l">{t(key)}</span>
              </span>
            );
          })}
        </div>
        <div className="tabs">
          {[
            CHANNEL_TAB,
            FEED_TAB,
            ...(job.diff ? [{ k: "diff", labelKey: "sheet.tabDiff", icon: "diff" as IconName }] : []),
            ...(job.artifact ? [{ k: "artifact", labelKey: "sheet.tabArtifact", icon: "table" as IconName }] : []),
            // 交付物优先：有交付物或核对记录就出现，用户先看结果
            ...(evidence.length > 0 || (job.deliverables?.length ?? 0) > 0
              ? [{ k: "evidence", labelKey: "sheet.tabEvidence", icon: "list" as IconName }]
              : []),
          ].map((tabDef) => {
            const count =
              tabDef.k === "channel"
                ? channel.length
                : tabDef.k === "feed"
                  ? jobCards.length
                  : tabDef.k === "evidence"
                    ? (job.deliverables?.length ?? evidence.length)
                    : 0;
            return (
              <button
                type="button"
                key={tabDef.k}
                className={`tab${tab === tabDef.k ? " on" : ""}`}
                aria-pressed={tab === tabDef.k}
                title={`${t(tabDef.labelKey)}${count > 0 ? ` · ${count}` : ""}`}
                onClick={() => setTab(tabDef.k)}
              >
                <Icon name={tabDef.icon} size="sm" /> {t(tabDef.labelKey)}
              </button>
            );
          })}
        </div>
      </div>

      <div className="sheet-body">
        {/* 对话是唯一主角：常驻单列；差异 / 产物 / 证据链都收进页签，按需展开。
            页签视图和 FeedScroller 互斥渲染——两个 flex:1 并排会把中间栏劈成两半 */}
        {tab === "channel" && (
          <FeedScroller resetKey={`channel-${job.id}`}>
            <FeedView
              cards={channel}
              onAction={onFeedAction}
              runningIds={running}
              onPreview={onPreview}
              empty={t("sheet.channelEmpty")}
            />
          </FeedScroller>
        )}

        {tab === "feed" && (
          <FeedScroller resetKey={job.id}>
            <>
              {foreign && (
                <div className="note" style={{ boxShadow: "none", marginBottom: 8 }}>
                  <Icon name="layers" size="sm" />
                  <span>
                    {t("sheet.fromThread")}
                    <b>{foreign.title ?? "…"}</b>
                  </span>
                  <button type="button" className="strip-link" onClick={() => onThread?.(foreign.threadId)}>
                    {t("sheet.gotoThread")}
                  </button>
                </div>
              )}
              <FeedView
                cards={jobCards}
                onAction={onFeedAction}
                collapseHistory
                runningIds={running}
                onPreview={onPreview}
                empty={t("sheet.jobFeedEmpty")}
              />
            </>
          </FeedScroller>
        )}

        {tab !== "feed" && tab !== "channel" && (
          <div className="work feed-work">
            {tab === "diff" && job.diff && <DiffView diff={job.diff} />}
            {tab === "artifact" && job.artifact && <ArtifactView job={job} />}
            {tab === "evidence" && (
              <EvidenceView taskId={job.id} evidence={evidence} deliverables={job.deliverables} onPreview={onPreview} />
            )}
            {tab === "diff" && !job.diff && <div className="spine-empty">{t("sheet.evidenceEmpty")}</div>}
            {tab === "artifact" && !job.artifact && <div className="spine-empty">{t("sheet.evidenceEmpty")}</div>}
            {tab === "evidence" && evidence.length === 0 && <div className="spine-empty">{t("sheet.evidenceEmpty")}</div>}
          </div>
        )}
      </div>

    </div>
  );
}

function DiffView({ diff }: { diff: DeskDiff }) {
  return (
    <div className="diff">
      <div className="f">
        <span className="s">{diff.file}</span>
        <span>{diff.hunk}</span>
      </div>
      {diff.lines.map((l, i) => (
        <div key={i} className={`l${l.t === "add" ? " add" : l.t === "del" ? " del" : l.t === "hunk" ? " hunk" : ""}`}>
          <span className="ln">{l.no}</span>
          {l.t === "del" ? "-" : l.t === "add" ? "+" : " "}
          {l.text}
        </div>
      ))}
    </div>
  );
}

/** 证据链整页（原右侧细栏改为页签）：一行一条，宽屏自动多列，不再挤压对话列 */
function EvidenceView({
  taskId,
  evidence,
  deliverables,
  onPreview,
}: {
  taskId: string;
  evidence: DeskEvidence[];
  /** 交付物（与证据分开：交付物是用户要带走的，证据是"我核对过"） */
  deliverables?: { path: string; ref: string; bytes?: number }[];
  onPreview?: OpenPreview;
}) {
  const t = useT();
  const list = deliverables ?? [];
  if (evidence.length === 0 && list.length === 0) return <div className="spine-empty">{t("sheet.deliverablesEmpty")}</div>;
  // 卷宗内的 artifacts/ 可点开；只读根里的外部绝对路径不在证据目录内，不给假按钮
  const openable = (ref: string) => !!ref && !/^[a-zA-Z]:[\\/]/.test(ref) && !ref.startsWith("/");
  const size = (b?: number) =>
    !b ? "" : b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)}MB` : b >= 1024 ? `${Math.round(b / 1024)}KB` : `${b}B`;
  return (
    <div className="evidence-view">
      {list.length > 0 && (
        <>
          <div className="ev-cap">
            {t("sheet.deliverables")}
            <span className="mono">{list.length}</span>
          </div>
          <div className="ev-grid">
            {list.map((d, i) => (
              <button
                type="button"
                key={i}
                disabled={!openable(d.ref)}
                title={`${d.path}\n${d.ref}${d.bytes ? `\n${size(d.bytes)}` : ""}`}
                className={`evr ok${openable(d.ref) ? " openable" : ""}`}
                onClick={() => {
                  if (openable(d.ref)) onPreview?.(taskId, d.ref);
                }}
              >
                <span className="t">{d.path}</span>
              </button>
            ))}
          </div>
        </>
      )}
      {evidence.length > 0 && (
        // 核对记录留在后台可查，默认收起：用户要的是结果，不是核对过程
        <details className="ev-audit">
          <summary>
            {t("sheet.auditTrail")}
            <span className="mono">{evidence.length}</span>
          </summary>
          <div className="ev-grid" style={{ marginTop: 8 }}>
            {evidence.map((e, i) => (
              <button
                type="button"
                key={i}
                disabled={!e.ref}
                title={e.ref ? `${e.title}\n${e.detail}\n点击打开` : e.detail}
                className={`evr${e.level === "ok" ? " ok" : e.level === "warn" ? " warn" : " pending"}${e.ref ? " openable" : ""}`}
                onClick={() => {
                  if (e.ref) onPreview?.(taskId, e.ref);
                }}
              >
                <span className="t">{e.title}</span>
              </button>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

function ArtifactView({ job }: { job: DeskJob }) {
  const a = job.artifact!;
  return (
    <div className="artifact">
      <div className="artifact-h">
        <Icon name="table" size="sm" />
        <span>产物预览</span>
        <span className="nm">
          <b>{a.name}</b> · {a.section}
        </span>
      </div>
      <div className="art-table">
        <div className="art-row head">
          {a.head.map((h) => (
            <span key={h}>{h}</span>
          ))}
        </div>
        {a.rows.map((r, i) => (
          <div className="art-row" key={i}>
            {r.map((c, j) => (
              <span key={j} className={j === 0 ? "no" : j === 1 ? "ti" : "stt"}>
                {c}
              </span>
            ))}
          </div>
        ))}
        <div className="art-foot">
          {a.foot.map((f, i) => (
            <span key={i} className={f.warn ? "warn" : undefined} style={i === a.foot.length - 1 ? { marginLeft: "auto" } : undefined}>
              {f.text}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

// ============================ ROSTER + SEAL ============================

function Roster({
  desk,
  current,
  onAccept,
  onReject,
  onOpenReview,
  onPlan,
  onAnswer,
  onSelectJob,
  onCreateTeam,
  onManageTeam,
  onThread,
  /** @某人：把名字插进输入框（群聊模式） */
  onAt,
  open,
  onClose,
}: {
  desk: Desk;
  /** 当前在图纸上打开的那张单：印章优先对它，不再"取全局第一条" */
  current?: DeskJob;
  /** 成员卡 → 打开他手上的那张单 */
  onSelectJob?: (taskId: string) => void;
  /** C3：印章头显示"来自会话"，并可切回去 */
  onThread?: (id: string) => void;
  /** 窄窗抽屉态 */
  open?: boolean;
  onClose?: () => void;
  onAccept: (taskId: string) => void;
  /** 打回带三要素（E3）：印章就地展开表单，不再先跳审查台 */
  onReject: (taskId: string, reason: { what: string; expect: string; deadline: string }) => void;
  /** 打开完整验收包（查看证据链/产物） */
  onOpenReview?: (taskId: string) => void;
  onPlan: (id: string, action: "start" | "revise" | "reject", text?: string) => void;
  onAnswer: (id: string, text: string) => void;
  /** 建团队：这里只要名字，ID 由系统生成（§4.10.3 修正） */
  onCreateTeam?: (name: string) => void;
  /** 手动管理编制：改岗位 / 移出成员 / 解散团队 */
  onManageTeam?: () => void;
  /** @某人：把名字插进输入框（群聊模式） */
  onAt?: (name: string) => void;
}) {
  const t = useT();
  // 成员状态由成员卡自己表达（排序 + 状态色），标题栏不再报两套互相打架的总数
  // 多条挂起裁决：当前索引钳在有效范围内——处理完一条快照刷新后自动落到下一条（A5）
  const decisions = desk.decisions;
  const [dIdx, setDIdx] = useState(0);
  const dPos = Math.min(dIdx, Math.max(0, decisions.length - 1));
  const decision = decisions[dPos];
  /** 新裁决到达即自动翻到那一条：审批不该等用户自己点面板翻页才发现 */
  const seenRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const fresh = decisions.find((d) => !seenRef.current.has(d.id));
    for (const d of decisions) seenRef.current.add(d.id);
    if (fresh) setDIdx(Math.max(0, decisions.findIndex((d) => d.id === fresh.id)));
  }, [decisions]);
  // 只有 in_review 可验收；blocked 只给"停掉/继续"，绝不出现"验收归档"
  const sealJob = current && current.action !== "none" ? current : desk.jobs.find((j) => j.action !== "none");
  // C3：印章头要报"这张单来自哪个会话"——跨会话时给回程入口，同会话不啰嗦
  const sealSource =
    sealJob?.threadId && sealJob.threadId !== desk.thread.id
      ? { id: sealJob.threadId, title: desk.threads.find((x) => x.id === sealJob.threadId)?.title }
      : null;
  const [naming, setNaming] = useState(false);
  const [teamName, setTeamName] = useState("");
  /** 编制规模上来之后先收敛：按状态筛人、团队卡可折叠、同岗位空闲成员聚合 */
  const [rosterFilter, setRosterFilter] = useState<"all" | "running" | "review" | "idle">("all");
  const [openRoles, setOpenRoles] = useState<Set<string>>(new Set());
  /**
   * 群聊模式（2026-11-12）：本群的队置顶展开，别群折叠在下面。
   * 一个群 = 一支班底——右栏第一眼要看到"这个群里有哪些人在干活"。
   */
  const [teamOpenOverride, setTeamOpenOverride] = useState<Record<string, boolean>>({});
  const [memberMenu, setMemberMenu] = useState<{ member: DeskMember; x: number; y: number } | null>(null);
  const [detail, setDetail] = useState<MemberDetailState | null>(null);
  const [rosterNote, setRosterNote] = useState<string | null>(null);
  /** 本群的队伍：本会话工单所属的队（他群折叠在下面） */
  const groupTeamIds = useMemo(() => {
    const s = new Set<string>();
    for (const j of desk.jobs) if (j.threadId === desk.thread.id && j.teamId) s.add(j.teamId);
    return s;
  }, [desk.jobs, desk.thread.id]);
  const isTeamOpen = (teamId: string) => teamOpenOverride[teamId] ?? groupTeamIds.has(teamId);
  const visibleMembers = useMemo(() => {
    if (rosterFilter === "all") return desk.members;
    const want = rosterFilter === "running" ? "running" : rosterFilter === "review" ? "delivered" : "idle";
    return desk.members.filter((m) => m.status === want);
  }, [desk.members, rosterFilter]);
  /** 多团队分组：团队名 + 未归档单数 + 在跑/待审/空闲人数（先看统计，再决定展开哪队） */
  const memberGroups = useMemo(() => {
    const map = new Map<string, RosterGroup>();
    for (const m of visibleMembers) {
      const g = map.get(m.teamId) ?? {
        teamName: m.teamName ?? m.teamId,
        active: desk.jobs.filter((j) => j.teamId === m.teamId && j.status !== "done" && j.status !== "canceled").length,
        running: 0,
        review: 0,
        idle: 0,
        members: [],
      };
      g.members.push(m);
      if (m.status === "running") g.running += 1;
      else if (m.status === "delivered") g.review += 1;
      else if (m.status === "idle") g.idle += 1;
      map.set(m.teamId, g);
    }
    return map;
  }, [visibleMembers, desk.jobs]);
  const toggleTeam = (teamId: string) =>
    setTeamOpenOverride((prev) => ({ ...prev, [teamId]: !(prev[teamId] ?? groupTeamIds.has(teamId)) }));
  const toggleRole = (key: string) =>
    setOpenRoles((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const submitTeam = () => {
    const name = teamName.trim();
    if (!name) return;
    onCreateTeam?.(name);
    setNaming(false);
    setTeamName("");
  };
  /** 队内排序：该拍板的排最前，其次在跑 / 卡住 / 待拍板。排序代替单独的「动态」区——同一个人不画两遍。 */
  const memberRank = (m: DeskMember) =>
    decision?.jobId && m.jobId === decision.jobId ? 0 : m.status === "running" ? 1 : m.status === "stuck" ? 2 : m.status === "delivered" ? 3 : 4;

  /** 右键成员：看资料（岗位说明书 + 战绩 + 手上那张单） */
  const showProfile = async (m: DeskMember) => {
    try {
      const r = await window.lynn.rpc("team.member.detail", { teamId: m.teamId, name: m.name });
      setDetail({ kind: "profile", member: m, profile: r.profile, record: r.record, job: r.job });
    } catch {
      setDetail({ kind: "profile", member: m });
    }
  };
  /** 右键成员：任务目标 + 进度（派单时冻结的判卷口径 + 卷宗时间线） */
  const showJob = async (m: DeskMember) => {
    if (!m.jobId) return;
    try {
      const r = await window.lynn.rpc("task.detail", { taskId: m.jobId });
      setDetail({ kind: "job", member: m, detail: r.detail });
    } catch {
      setDetail({ kind: "job", member: m });
    }
  };
  /** 右键成员：催一下（话转给他，下一轮生效；不越权，返工与否由风铃定） */
  const nudge = async (m: DeskMember) => {
    if (!m.jobId) return;
    try {
      const r = await window.lynn.rpc("task.nudge", { taskId: m.jobId, note: "用户催了一下进度" });
      setRosterNote(r.ok ? `已催 ${m.name}：话转过去了，下一轮生效` : r.error ?? "催不动");
    } catch {
      setRosterNote("催不动：请求没送到");
    }
  };

  /** 一支队的组卡：本群默认展开并标"本群"，他群折叠 */
  const renderTeamGroup = (teamId: string, g: RosterGroup) => {
    const collapsed = !isTeamOpen(teamId);
    const split = splitRoster(g.members);
    const isGroup = groupTeamIds.has(teamId);
    return (
      <section className="tgroup-card" key={teamId}>
        <div className="tgroup-h">
          <button
            type="button"
            className="tgroup-toggle"
            aria-expanded={!collapsed}
            onClick={() => toggleTeam(teamId)}
            title={collapsed ? "展开这支队" : "收起这支队"}
          >
            <span className="tg-caret" aria-hidden>{collapsed ? "▸" : "▾"}</span>
            <span className="t">{g.teamName}</span>
            {isGroup && <span className="tg-tag">本群</span>}
          </button>
          <span className="tgroup-stat">
            {g.running > 0 && <span className="s run">在跑 {g.running}</span>}
            {g.review > 0 && <span className="s review">待审 {g.review}</span>}
            {g.idle > 0 && <span className="s idle">空闲 {g.idle}</span>}
          </span>
        </div>
        {!collapsed && (
          <div className="tgroup-list">
            {[...split.active]
              .sort((a, b) => memberRank(a) - memberRank(b))
              .map((m) => (
                <MemberCard
                  key={`${m.teamId}:${m.name}`}
                  m={m}
                  active={!!decision?.jobId && m.jobId === decision.jobId}
                  onSelect={onSelectJob}
                  onManage={onManageTeam}
                  onMenu={(e) => {
                    e.preventDefault();
                    setMemberMenu({ member: m, x: e.clientX, y: e.clientY });
                  }}
                />
              ))}
            {split.groups.map((rg) => {
              const key = `${teamId}::${rg.role}`;
              const opened = openRoles.has(key);
              return (
                <div className="role-group" key={key}>
                  <button type="button" className="role-h" aria-expanded={opened} onClick={() => toggleRole(key)}>
                    <span className="tg-caret" aria-hidden>{opened ? "▾" : "▸"}</span>
                    <span className="t">{rg.role}</span>
                    <span className="n">×{rg.members.length}</span>
                  </button>
                  {opened &&
                    rg.members.map((m) => (
                      <MemberCard
                        key={`${m.teamId}:${m.name}`}
                        m={m}
                        active={!!decision?.jobId && m.jobId === decision.jobId}
                        onSelect={onSelectJob}
                        onManage={onManageTeam}
                        onMenu={(e) => {
                          e.preventDefault();
                          setMemberMenu({ member: m, x: e.clientX, y: e.clientY });
                        }}
                      />
                    ))}
                </div>
              );
            })}
          </div>
        )}
      </section>
    );
  };

  return (
    <aside className={`right${open ? " open" : ""}`}>
      <div className="right-scroll">
        {detail && <MemberDetail data={detail} onClose={() => setDetail(null)} />}
        {rosterNote && (
          <p className="roster-note" onClick={() => setRosterNote(null)}>
            {rosterNote}
          </p>
        )}
        <div className="panel-h">
          <div className="l">
            <span className="t">{t("roster.title")}</span>
            <span className="n">{t("roster.count", { n: desk.members.length })}</span>
          </div>
          {onClose && (
            <button
              type="button"
              className="icon-btn only-narrow"
              onClick={onClose}
              title={t("common.close")}
              aria-label={t("common.close")}
            >
              <Icon name="x" size="sm" />
            </button>
          )}
        </div>

        {/* 规模上来先按状态收敛：26 人平铺时，找「在跑 / 待审」比翻名单快 */}
        <div className="roster-filter" role="tablist" aria-label="编制筛选">
          {(
            [
              ["all", "全部"],
              ["running", "在跑"],
              ["review", "待审"],
              ["idle", "空闲"],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={rosterFilter === k}
              className={`rf-chip${rosterFilter === k ? " on" : ""}`}
              onClick={() => setRosterFilter(k)}
            >
              {label}
            </button>
          ))}
        </div>

        {/* 建团队：给名字就行，ID 由系统生成——不让用户在面板里找 ID */}
        {onCreateTeam && (
          <div className="roster-actions">
            {naming ? (
              <>
                <input
                  className="seal-input"
                  style={{ flex: 1 }}
                  autoFocus
                  value={teamName}
                  placeholder={t("roster.newPlaceholder")}
                  onChange={(e) => setTeamName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") submitTeam();
                    if (e.key === "Escape") {
                      setNaming(false);
                      setTeamName("");
                    }
                  }}
                />
                <button type="button" className="ghost-btn" onClick={submitTeam}>
                  {t("common.create")}
                </button>
              </>
            ) : (
              <>
                <button type="button" className="ghost-btn" onClick={() => setNaming(true)}>
                  <Icon name="users" size="sm" /> {t("roster.new")}
                </button>
                {onManageTeam && (
                  <button type="button" className="ghost-btn" onClick={onManageTeam} title={t("team.hint")}>
                    <Icon name="pen" size="sm" /> {t("team.manage")}
                  </button>
                )}
              </>
            )}
          </div>
        )}

        {desk.members.length === 0 && (
          <div className="note" style={{ boxShadow: "none" }}>
            <Icon name="users" size="sm" />
            <span>{t("roster.empty")}</span>
          </div>
        )}

        {/* 印章排在最前：它是"该你拍板"的唯一落点，不能藏在成员卡下面要滚动才看见 */}
        <div className="seal-slot">
          {sealSource && (
            <div className="seal-source">
              <Icon name="layers" size="sm" />
              <span>
                {t("sheet.fromThreadShort")}
                <b>{sealSource.title ?? sealSource.id}</b>
              </span>
              <button type="button" className="strip-link" onClick={() => onThread?.(sealSource.id)}>
                {t("sheet.gotoThread")}
              </button>
            </div>
          )}
          {decisions.length > 1 && (
            <div className="seal-pager">
              <span className="chip">{t("seal.pendingCount", { i: dPos + 1, n: decisions.length })}</span>
              <button
                type="button"
                className="icon-btn"
                aria-label={t("seal.nextDecision")}
                title={t("seal.nextDecision")}
                onClick={() => setDIdx((dPos + 1) % decisions.length)}
              >
                ›
              </button>
            </div>
          )}
          {decision?.kind === "plan" && decision.plan ? (
            <PlanSeal decision={decision} onPlan={onPlan} />
          ) : decision?.kind === "approval" ? (
            <ApprovalSeal decision={decision} onPlan={onPlan} />
          ) : decision ? (
            <QuestionSeal decision={decision} onAnswer={onAnswer} />
          ) : sealJob?.action === "accept" ? (
            <AcceptSeal
              job={sealJob}
              onAccept={() => onAccept(sealJob.id)}
              onReject={(reason) => onReject(sealJob.id, reason)}
              onOpenReview={onOpenReview ? () => onOpenReview(sealJob.id) : undefined}
            />
          ) : sealJob?.action === "unblock" ? (
            <BlockedSeal job={sealJob} />
          ) : (
            <div className="sealcard-empty">
              <Icon name="shield" size="sm" />
              <div>
                <b>{t("roster.noDecision")}</b>
              </div>
            </div>
          )}
        </div>

        {/* 团队卡组：一队一张分组卡，队内是成员小卡。
            不折叠：折叠箭头会让一队人藏起来，而右栏本来就是为了一眼看清编制。
            也不再单列「动态」区：在跑的排到队内前面，同一个人不画两遍。 */}
        {(() => {
          const groups = [...memberGroups.entries()].sort(
            (a, b) => Number(groupTeamIds.has(b[0])) - Number(groupTeamIds.has(a[0])),
          );
          const mine = groups.filter(([id]) => groupTeamIds.has(id));
          const others = groups.filter(([id]) => !groupTeamIds.has(id));
          return (
            <>
              {mine.map(([id, g]) => renderTeamGroup(id, g))}
              {others.length > 0 && (
                <div className="tgroup-others">
                  <div className="tgroup-others-h">其他团队（{others.length}）</div>
                  {others.map(([id, g]) => renderTeamGroup(id, g))}
                </div>
              )}
            </>
          );
        })()}
      </div>
      {memberMenu && (
        <MemberMenu
          member={memberMenu.member}
          x={memberMenu.x}
          y={memberMenu.y}
          onClose={() => setMemberMenu(null)}
          onProfile={() => void showProfile(memberMenu.member)}
          onJob={() => void showJob(memberMenu.member)}
          onProgress={() => void showJob(memberMenu.member)}
          onAt={() => onAt?.(memberMenu.member.name)}
          onNudge={() => void nudge(memberMenu.member)}
        />
      )}
    </aside>
  );
}

function SealHead({ k, id }: { k: string; id?: string }) {
  return (
    <div className="sealcard-h">
      <span className="k">{k}</span>
      {id && <span className="mono seal-id">{id}</span>}
    </div>
  );
}

function SealChecks({ checks, label }: { checks: { ok: boolean; text: string }[]; label?: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  if (checks.length === 0) return null;
  // 22 条路径铺满整张卡就是"一坨"：先给 5 条，其余点开；每行单行省略，全文进 title
  const LIMIT = 5;
  const shown = open ? checks : checks.slice(0, LIMIT);
  return (
    <div className="accept">
      <div className="k">
        {label ?? t("seal.acceptance")}
        <span className="n">{checks.length}</span>
      </div>
      <ul>
        {shown.map((c, i) => (
          <li key={i} className={c.ok ? "ok" : "bad"} title={c.text}>
            <Icon name={c.ok ? "check" : "warn"} size="sm" />
            <span>{c.text}</span>
          </li>
        ))}
      </ul>
      {checks.length > LIMIT && (
        <button type="button" className="accept-more" onClick={() => setOpen((v) => !v)}>
          {open ? t("seal.checksLess") : t("seal.checksMore", { n: checks.length })}
        </button>
      )}
    </div>
  );
}

/** 任务契约：开始 / 改一版 / 先不做 */
function PlanSeal({
  decision,
  onPlan,
}: {
  decision: DeskDecision;
  onPlan: (id: string, action: "start" | "revise" | "reject", text?: string) => void;
}) {
  const [revise, setRevise] = useState<string | null>(null);
  const t = useT();
  const plan = decision.plan!;
  return (
    <div className="sealcard">
      <SealHead k={t("seal.contract")} id={plan.taskId} />
      <div className="sealcard-body">
        <SealGlyph />
        <div className="sealcard-text">
          <div className="who">
            <b>{plan.member ?? t("seal.tbd")}</b>
            {plan.deadline ? ` · ${t("seal.deadline", { d: plan.deadline })}` : ""}
            {plan.budgetTokens ? ` · ${t("seal.budget", { k: Math.round(plan.budgetTokens / 1000) })}` : ""}
          </div>
          <div className="ask">{plan.title}</div>
        </div>
      </div>
      <SealChecks checks={decision.checks} />
      {revise === null ? (
        <div className="seal-actions">
          <button type="button" className="btn btn-accept" onClick={() => onPlan(decision.id, "start")}>
            <Icon name="check" size="sm" /> {t("seal.start")}
          </button>
          <button type="button" className="btn" onClick={() => setRevise("")}>
            <Icon name="undo" size="sm" /> {t("seal.revise")}
          </button>
          <button type="button" className="btn btn-reject" onClick={() => onPlan(decision.id, "reject")}>
            {t("seal.later")}
          </button>
        </div>
      ) : (
        <div className="seal-revise">
          <textarea
            className="seal-input"
            value={revise}
            onChange={(e) => setRevise(e.target.value)}
            placeholder={t("seal.revisePlaceholder")}
          />
          <div className="seal-actions">
            <button
              type="button"
              className="btn btn-accept"
              disabled={!revise.trim()}
              onClick={() => onPlan(decision.id, "revise", revise)}
            >
              {t("seal.reviseSubmit")}
            </button>
            <button type="button" className="btn" onClick={() => setRevise(null)}>
              {t("common.cancel")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** 工具审批：批准这一动作，或拒绝（拒绝不算错误轮） */
function ApprovalSeal({
  decision,
  onPlan,
}: {
  decision: DeskDecision;
  onPlan: (id: string, action: "start" | "revise" | "reject", text?: string) => void;
}) {
  const t = useT();
  return (
    <div className="sealcard">
      <SealHead k={t("seal.approveHead")} id={decision.jobId} />
      <div className="sealcard-body">
        <SealGlyph />
        <div className="sealcard-text">
          <div className="who">{t("seal.permAskMode")}</div>
          <div className="ask">{decision.question}</div>
        </div>
      </div>
      <div className="seal-actions">
        <button type="button" className="btn btn-accept" onClick={() => onPlan(decision.id, "start")}>
          <Icon name="check" size="sm" /> {t("seal.allow")}
        </button>
        <button type="button" className="btn btn-reject" onClick={() => onPlan(decision.id, "reject")}>
          {t("seal.reject")}
        </button>
      </div>
    </div>
  );
}

/** 她的问题：回答会作为新一回合的输入回到模型 */
function QuestionSeal({
  decision,
  onAnswer,
}: {
  decision: DeskDecision;
  onAnswer: (id: string, text: string) => void;
}) {
  const [text, setText] = useState("");
  const t = useT();
  return (
    <div className="sealcard">
      <SealHead k={t("seal.questionHead")} id={decision.jobId} />
      <div className="sealcard-body">
        <SealGlyph />
        <div className="sealcard-text">
          <div className="who">{decision.who}</div>
          <div className="ask">{decision.question}</div>
        </div>
      </div>
      <textarea
        className="seal-input"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={t("seal.answerPlaceholder")}
      />
      <div className="seal-actions">
        <button type="button" className="btn btn-accept" disabled={!text.trim()} onClick={() => onAnswer(decision.id, text)}>
          {t("seal.submitAnswer")}
        </button>
      </div>
    </div>
  );
}

/** 工单交付：验收 / 打回都在印章完成（E3：两条路合一，不再为打回跳全屏审查台；审查台降级为查看页） */
function AcceptSeal({
  job,
  onAccept,
  onReject,
  onOpenReview,
}: {
  job: DeskJob;
  onAccept: () => void;
  onReject: (reason: { what: string; expect: string; deadline: string }) => void;
  onOpenReview?: () => void;
}) {
  const t = useT();
  const [rejecting, setRejecting] = useState(false);
  // 预填她留下的打回三要素草稿：改完直接发，不从零写
  const [what, setWhat] = useState(job.rejectDraft?.what ?? "");
  const [expect, setExpect] = useState(job.rejectDraft?.expect ?? "");
  const [deadline, setDeadline] = useState(job.rejectDraft?.deadline ?? "15 分钟");
  const canReject = what.trim() !== "" && expect.trim() !== "" && deadline.trim() !== "";
  return (
    <div className="sealcard">
      <SealHead k={t("seal.acceptHead")} id={job.id} />
      <div className="sealcard-body">
        <SealGlyph />
        <div className="sealcard-text">
          <div className="who">
            <b>{job.member ?? t("seal.member")}</b> {t("seal.submitted")}
            {job.at ? ` · ${fmtTime(job.at)}` : ""}
          </div>
          <div className="ask">{job.title}</div>
        </div>
      </div>
      <SealChecks
        checks={job.evidence.filter((e) => e.verified).map((e) => ({ ok: true, text: e.title }))}
        label={t("seal.verifiedEvidence")}
      />
      {rejecting ? (
        <div className="seal-reject">
          {[
            { k: t("seal.rejectWhat"), v: what, set: setWhat, ph: t("seal.rejectWhatPh"), rows: 2 },
            { k: t("seal.rejectExpect"), v: expect, set: setExpect, ph: t("seal.rejectExpectPh"), rows: 2 },
            { k: t("seal.rejectDeadline"), v: deadline, set: setDeadline, ph: t("seal.rejectDeadlinePh"), rows: 1 },
          ].map((f) => (
            <label className="seal-field" key={f.k}>
              <span>{f.k}</span>
              <textarea
                className="seal-input"
                value={f.v}
                rows={f.rows}
                onChange={(e) => f.set(e.target.value)}
                placeholder={f.ph}
              />
            </label>
          ))}
          <div className="seal-actions">
            <button
              type="button"
              className="btn btn-reject"
              disabled={!canReject}
              onClick={() => onReject({ what: what.trim(), expect: expect.trim(), deadline: deadline.trim() })}
            >
              <Icon name="undo" size="sm" /> {t("seal.rejectGo")}
            </button>
            <button type="button" className="btn" onClick={() => setRejecting(false)}>
              {t("common.cancel")}
            </button>
          </div>
        </div>
      ) : (
        <div className="seal-actions">
          <button type="button" className="btn btn-accept" onClick={onAccept}>
            <Icon name="check" size="sm" /> {t("seal.accept")}
          </button>
          <button type="button" className="btn btn-reject" onClick={() => setRejecting(true)}>
            <Icon name="undo" size="sm" /> {t("seal.rejectRedo")}
          </button>
        </div>
      )}
      {onOpenReview && !rejecting && (
        <button type="button" className="seal-review-link" onClick={onOpenReview}>
          {t("seal.openReview")}
        </button>
      )}
      <div className="rounds">
        <span>{t("seal.rounds")}</span>
        {[0, 1, 2].map((i) => (
          <span key={i} className={`sq${i < job.rejections ? " on" : ""}`} />
        ))}
        <span className="rounds-note">
          {job.rejections >= job.rejectLimit
            ? t("seal.roundsFull")
            : t("seal.roundsUsed", { a: job.rejections, b: job.rejectLimit })}
        </span>
      </div>
    </div>
  );
}

/**
 * 卡住（blocked）：她连续两个节点没交新证据。
 * 这里不能出现"验收归档"——没有交付物，收下就是在没有证据的情况下把单推成 done。
 */
function BlockedSeal({ job }: { job: DeskJob }) {
  const t = useT();
  return (
    <div className="sealcard">
      <SealHead k={t("seal.blockedHead")} id={job.id} />
      <div className="sealcard-body">
        <SealGlyph />
        <div className="sealcard-text">
          <div className="who">
            <b>{job.member ?? t("seal.member")}</b>
            {job.at ? ` · ${fmtTime(job.at)}` : ""}
          </div>
          <div className="ask">{t("seal.blockedBody")}</div>
          {/* 真实成因（用户手动停机 / 没交回报 / 打回 3 轮 / 进程重启对账）由工单记录提供 */}
          {job.statusNote && <div className="ask ask-sub">{job.statusNote}</div>}
        </div>
      </div>
      <div className="rounds">
        <span className="rounds-note">{t("seal.blockedNote")}</span>
      </div>
    </div>
  );
}

/**
 * 队内拆分（2026-11-12）：有活的人单独露出；都空闲的同岗位收成「岗位 ×N」。
 * 26 人、单队 14 人时平铺等于让用户滚动找自己人，先把同岗的重复项收掉。
 */
function splitRoster(members: DeskMember[]): {
  active: DeskMember[];
  groups: { role: string; members: DeskMember[] }[];
} {
  const active: DeskMember[] = [];
  const byRole = new Map<string, DeskMember[]>();
  for (const m of members) {
    if (m.status === "running" || m.status === "delivered" || m.status === "stuck" || m.jobId) {
      active.push(m);
      continue;
    }
    const role = m.role || "未标注岗位";
    const arr = byRole.get(role) ?? [];
    arr.push(m);
    byRole.set(role, arr);
  }
  const groups: { role: string; members: DeskMember[] }[] = [];
  for (const [role, arr] of byRole) {
    if (arr.length > 1) groups.push({ role, members: arr });
    else active.push(arr[0]);
  }
  return { active, groups };
}

/**
 * 成员小卡：只讲三件事——哪张脸、叫什么、手上什么活。
 * 角色 / 模型 / 工具白名单 / 步数预算 / 状态文字都不在这里重复：
 * 岗位档案归设置页，边界读数归工单帐本，右栏只负责一眼看清编制。
 * 在跑与否由头像底色深浅表达（MemberAvatar 的 active），不另占一行。
 */
function MemberCard({
  m,
  active,
  onSelect,
  onManage,
  onMenu,
}: {
  m: DeskMember;
  active: boolean;
  onSelect?: (jobId: string) => void;
  onManage?: () => void;
  /** 右键：看资料 / 目标 / 进度 / @他 / 催一下（群聊模式） */
  onMenu?: (e: React.MouseEvent) => void;
}) {
  const t = useT();
  const brief = m.jobTitle || m.role;
  // 有单就开工单，没单就打开岗位档案：成员卡不再是「点了没反应」的展示件
  const action = Boolean(m.jobId || onManage);
  // 战绩按需拉：快照每几秒一次，扫 assignments/*.jsonl 太贵，放到用户点开时再算
  const [showRecord, setShowRecord] = useState(false);
  const [record, setRecord] = useState<{ tasks: number; accepted: number; rejected: number; escalations: number } | null>(
    null,
  );
  const [recordBusy, setRecordBusy] = useState(false);
  const toggleRecord = async () => {
    const next = !showRecord;
    setShowRecord(next);
    if (!next || record || recordBusy) return;
    setRecordBusy(true);
    try {
      setRecord(await window.lynn.rpc("team.member.record", { teamId: m.teamId, name: m.name }));
    } catch {
      setRecord({ tasks: 0, accepted: 0, rejected: 0, escalations: 0 });
    } finally {
      setRecordBusy(false);
    }
  };
  const open = () => {
    if (m.jobId) onSelect?.(m.jobId);
    else onManage?.();
  };
  return (
    <div
      className={`mcard${active ? " active" : ""}${action ? " linkable" : ""}`}
      data-state={m.status === "running" ? "running" : undefined}
      role={action ? "button" : undefined}
      tabIndex={action ? 0 : undefined}
      title={m.jobId ? t("member.openJob", { id: m.jobId }) : onManage ? "空闲：查看岗位档案" : brief}
      onClick={open}
      onContextMenu={onMenu}
      onKeyDown={(e) => {
        if (!action) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          open();
        }
      }}
    >
      <MemberAvatar name={m.name} avatarId={m.avatarId} size={36} />
      <div className="mcard-txt">
        <div className="mcard-name">
          {m.name}
          {m.status === "running" && <span className="mcard-live" aria-label={t("feed.live")} />}
        </div>
        <div className="mcard-brief" title={brief}>
          {brief}
        </div>
        {showRecord && (
          <div className="mcard-stat mono">
            {record
              ? `参与 ${record.tasks} · 通过 ${record.accepted} · 打回 ${record.rejected} · 升级 ${record.escalations}`
              : "读取中…"}
          </div>
        )}
      </div>
      <button
        type="button"
        className="mcard-record-btn"
        aria-expanded={showRecord}
        title="这个岗位历次验收战绩"
        onClick={(e) => {
          e.stopPropagation();
          void toggleRecord();
        }}
      >
        {showRecord ? "收起" : "战绩"}
      </button>
    </div>
  );
}

/** 成员档案（群聊模式：右键看"他是谁"） */
interface MemberProfileView {
  name: string;
  role: string;
  goal: string;
  boundaries: string[];
  tools: string[];
  model: string;
  limits: { maxTurns: number; budgetTokens: number; wallClockMin: number };
  outputContract: { deliverable: string; evidence: string[]; acceptance: string[] };
  escalateWhen: string;
  body: string;
  avatarId?: string;
}

/** 工单详情（群聊模式：右键看"他在做什么"） */
interface TaskDetailView {
  id: string;
  title: string;
  member?: string;
  teamId: string;
  status: string;
  statusNote: string;
  goal?: string;
  brief?: string;
  acceptance: string[];
  workspaceRoot?: string;
  deliverables: { label: string; ref: string; bytes?: number }[];
  timeline: { at: string; kind: string; text: string }[];
}

type MemberDetailState =
  | {
      kind: "profile";
      member: DeskMember;
      profile?: MemberProfileView;
      record?: { tasks: number; accepted: number; rejected: number; escalations: number };
      job?: { id: string; title: string; status: string };
    }
  | { kind: "job"; member: DeskMember; detail?: TaskDetailView };

/** 右栏编制表里的一支队 */
interface RosterGroup {
  teamName: string;
  active: number;
  running: number;
  review: number;
  idle: number;
  members: DeskMember[];
}

/**
 * 成员右键菜单（群聊模式）：资料 / 目标 / 进度 / @他 / 催一下。
 * 形态照工单卡右键（JobMenu）：fixed 定位 + 点外面关闭 + Esc 关闭。
 */
function MemberMenu({
  member,
  x,
  y,
  onClose,
  onProfile,
  onJob,
  onProgress,
  onAt,
  onNudge,
}: {
  member: DeskMember;
  x: number;
  y: number;
  onClose: () => void;
  onProfile: () => void;
  onJob: () => void;
  onProgress: () => void;
  onAt: () => void;
  onNudge: () => void;
}) {
  const box = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);
  const style = {
    left: Math.max(8, Math.min(x, (window.innerWidth || 1200) - 240)),
    top: Math.max(8, Math.min(y, (window.innerHeight || 800) - 220)),
  };
  const items: { label: string; hint: string; on: () => void; off?: boolean }[] = [
    { label: "查看资料", hint: "岗位档案 · 战绩", on: onProfile },
    { label: "任务目标", hint: member.jobId ? "他被要求做什么" : "他手上没单", on: onJob, off: !member.jobId },
    { label: "进度", hint: "最近在干什么 · 卷宗时间线", on: onProgress, off: !member.jobId },
    { label: "@他说话", hint: "插到输入框里", on: onAt },
    { label: "催一下", hint: "话转给他，下一轮生效", on: onNudge, off: !member.jobId || member.status !== "running" },
  ];
  return (
    <div className="jobmenu" ref={box} style={style} role="menu" aria-label={member.name}>
      <div className="jobmenu-h">
        <span className="jobmenu-title">{member.name}</span>
        <span className="st">{member.role}</span>
      </div>
      <div className="jobmenu-sub mono">
        {member.teamName ?? member.teamId}
        {member.jobId ? ` · ${member.jobId}` : ""}
      </div>
      {items.map((it) => (
        <button
          key={it.label}
          type="button"
          className="jobmenu-item"
          disabled={it.off}
          title={it.hint}
          onClick={() => {
            if (it.off) return;
            it.on();
            onClose();
          }}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}

/**
 * 成员详情（群聊模式）：右键成员后在右栏顶部展开。
 * 资料看"他是谁"，目标看"他被要求做什么"，进度看"他最近在干什么"。
 */
function MemberDetail({ data, onClose }: { data: MemberDetailState; onClose: () => void }) {
  const t = useT();
  const m = data.member;
  return (
    <div className="mdetail">
      <div className="mdetail-h">
        <MemberAvatar name={m.name} avatarId={m.avatarId} size={28} />
        <div className="mdetail-name">
          <b>{m.name}</b>
          <span className="mdetail-role">{m.role}</span>
        </div>
        <button type="button" className="icon-btn" onClick={onClose} aria-label={t("common.close")}>
          <Icon name="x" size="sm" />
        </button>
      </div>
      {data.kind === "profile" ? (
        data.profile ? (
          <div className="mdetail-body">
            <div className="mdetail-row">
              <span className="k">目标</span>
              <span className="v">{data.profile.goal || "（未写）"}</span>
            </div>
            <div className="mdetail-row">
              <span className="k">边界</span>
              <span className="v">{data.profile.boundaries.join("、") || "（未写）"}</span>
            </div>
            <div className="mdetail-row">
              <span className="k">工具</span>
              <span className="v mono">{data.profile.tools.join("、") || "（无）"}</span>
            </div>
            <div className="mdetail-row">
              <span className="k">上限</span>
              <span className="v mono">
                {data.profile.limits.maxTurns} 轮 · {data.profile.limits.budgetTokens} tok · {data.profile.limits.wallClockMin} 分
              </span>
            </div>
            <div className="mdetail-row">
              <span className="k">产出</span>
              <span className="v">{data.profile.outputContract.deliverable || "（未写）"}</span>
            </div>
            <div className="mdetail-row">
              <span className="k">何时升级</span>
              <span className="v">{data.profile.escalateWhen || "（未写）"}</span>
            </div>
            {data.profile.body && (
              <div className="mdetail-row">
                <span className="k">做事方式</span>
                <span className="v">{data.profile.body}</span>
              </div>
            )}
            {data.record && (
              <div className="mdetail-row">
                <span className="k">战绩</span>
                <span className="v mono">
                  参与 {data.record.tasks} · 通过 {data.record.accepted} · 打回 {data.record.rejected} · 升级 {data.record.escalations}
                </span>
              </div>
            )}
            {data.job && (
              <div className="mdetail-row">
                <span className="k">手上</span>
                <span className="v mono">
                  {data.job.id} · {data.job.title}
                </span>
              </div>
            )}
          </div>
        ) : (
          <p className="mdetail-empty">没有读到这份档案。</p>
        )
      ) : data.detail ? (
        <div className="mdetail-body">
          <div className="mdetail-row">
            <span className="k">单</span>
            <span className="v mono">
              {data.detail.id} · {data.detail.title}
            </span>
          </div>
          {data.detail.goal && (
            <div className="mdetail-row">
              <span className="k">目标</span>
              <span className="v">{data.detail.goal}</span>
            </div>
          )}
          <div className="mdetail-row">
            <span className="k">完成标准</span>
            <span className="v">{data.detail.acceptance.join("；") || "（未写）"}</span>
          </div>
          <div className="mdetail-row">
            <span className="k">状态</span>
            <span className="v">
              {data.detail.status}
              {data.detail.statusNote ? ` · ${data.detail.statusNote}` : ""}
            </span>
          </div>
          {data.detail.workspaceRoot && (
            <div className="mdetail-row">
              <span className="k">工作区</span>
              <span className="v mono">{data.detail.workspaceRoot}</span>
            </div>
          )}
          {data.detail.deliverables.length > 0 && (
            <div className="mdetail-row">
              <span className="k">产物</span>
              <span className="v mono">{data.detail.deliverables.map((d) => d.label).join("、")}</span>
            </div>
          )}
          {data.detail.timeline.length > 0 && (
            <div className="mdetail-row">
              <span className="k">最近</span>
              <span className="v">
                {data.detail.timeline
                  .slice(-4)
                  .reverse()
                  .map((e) => e.text)
                  .join(" / ")}
              </span>
            </div>
          )}
        </div>
      ) : (
        <p className="mdetail-empty">没有读到这张单。</p>
      )}
    </div>
  );
}

function SealGlyph({ big }: { big?: boolean }) {
  const c = "var(--seal)";
  return (
    <div className="seal-glyph" style={big ? { width: 84, height: 84 } : undefined}>
      <svg viewBox="0 0 100 100">
        <g transform="rotate(-7 50 50)" opacity="0.92">
          <rect x="6" y="6" width="88" height="88" rx="5" fill="none" stroke={c} strokeWidth="5.5" />
          <rect x="13" y="13" width="74" height="74" rx="3" fill="none" stroke={c} strokeWidth="1.3" opacity="0.65" />
          {[
            ["等", 33, 43],
            ["你", 67, 43],
            ["拍", 33, 79],
            ["板", 67, 79],
          ].map(([t, x, y]) => (
            <text
              key={t as string}
              x={x as number}
              y={y as number}
              textAnchor="middle"
              fontFamily="Noto Sans SC, sans-serif"
              fontSize="26"
              fontWeight="700"
              fill={c}
            >
              {t}
            </text>
          ))}
        </g>
      </svg>
    </div>
  );
}

// ============================ COMPOSER ============================

/**
 * @ 补全候选：成员（@ 留在正文，是群里的定向诉求）还是文件（@ 摘掉，进随附条）。
 * 两者混在一张列表里会让人误点——成员名和文件路径长得太像。
 */
type MentionItem =
  | { kind: "member"; name: string; role?: string }
  | { kind: "file"; path: string; size: number };

function ComposerZone({
  configured,
  turn,
  queue,
  variant = "desk",
  onStandby,
  onSend,
  onFileSearch,
  onAbort,
  onQueue,
  captureShot,
  members,
  pendingAt,
}: {
  configured: boolean;
  turn: Desk["turn"];
  queue: QueueItem[];
  variant?: "desk" | "review";
  onStandby?: () => void;
  onSend: (text: string, mode: "queue" | "steer", attachments?: { files?: string[]; images?: { name: string; data: string }[] }) => void;
  /** @ 提及的项目文件检索（M1-16） */
  onFileSearch?: (q: string) => Promise<{ path: string; size: number }[]>;
  onAbort: () => void;
  onQueue: (action: "clear" | "remove", id?: string) => void;
  /** 全局快捷键截好的图：按 id 注入本轮随附，用户自己决定发不发 */
  captureShot?: CaptureShot | null;
  /** 群里可点名的人（本群成员排前面，由 DeskView 排好序） */
  members?: { name: string; role?: string }[];
  /** 右键成员「@他说话」：把名字插进输入框 */
  pendingAt?: { name: string; nonce: number } | null;
}) {
  const [draft, setDraft] = useState("");
  const [mode, setMode] = useState<"queue" | "steer">("queue");
  const busy = turn.busy;
  const now = useTick(busy && Boolean(turn.activity));
  const elapsed = turn.activityAt ? Math.max(0, Math.floor((now - turn.activityAt) / 1000)) : 0;
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const t = useT();
  // 本轮随附（M1-16）：发送前可见、逐片可裁剪
  const [attFiles, setAttFiles] = useState<string[]>([]);
  const [attImages, setAttImages] = useState<{ name: string; data: string }[]>([]);
  // @ 补全：群里的人（成员）+ 项目文件
  const [mention, setMention] = useState<{ start: number; q: string } | null>(null);
  const [mentionItems, setMentionItems] = useState<MentionItem[]>([]);
  const [mentionIdx, setMentionIdx] = useState(0);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const imgSeq = useRef(0);
  const lastShot = useRef<string | null>(null);
  const [captureErr, setCaptureErr] = useState<string | null>(null);
  const hasAtt = attFiles.length > 0 || attImages.length > 0;
  const canSend = (draft.trim().length > 0 || hasAtt) && configured;

  // 截图进随附条：与粘贴图片同一条可见链；按 id 去重，StrictMode 双跑也不会加两片
  useEffect(() => {
    if (!captureShot || lastShot.current === captureShot.id) return;
    lastShot.current = captureShot.id;
    setAttImages((imgs) => [...imgs, { name: captureShot.name, data: captureShot.data }]);
    taRef.current?.focus();
  }, [captureShot]);

  // 右键成员「@他说话」：把 @名字 插进草稿（群聊模式的定向入口）
  useEffect(() => {
    if (!pendingAt) return;
    setDraft((d) => `${d && !/\s$/.test(d) ? `${d} ` : d}@${pendingAt.name} `);
    taRef.current?.focus();
  }, [pendingAt?.nonce]);

  const detectMention = (value: string, caret: number) => {
    const before = value.slice(0, caret);
    const m = /(^|\s)@([^\s@]{0,80})$/.exec(before);
    if (m) {
      const q = m[2];
      const start = caret - q.length - 1;
      setMention({ start, q });
      setMentionIdx(0);
      // 群里的人优先：他就在眼前，比翻文件路径更可能是想要的
      const people = (members ?? [])
        .filter((mm) => (q ? mm.name.includes(q) || q.includes(mm.name) : true))
        .slice(0, 8)
        .map((mm) => ({ kind: "member" as const, name: mm.name, role: mm.role }));
      if (people.length) {
        setMentionItems(people);
        return;
      }
      if (!onFileSearch) {
        setMentionItems([]);
        return;
      }
      if (searchTimer.current) clearTimeout(searchTimer.current);
      searchTimer.current = setTimeout(() => {
        void onFileSearch(q).then((files) => {
          setMentionItems(files.map((f) => ({ kind: "file" as const, path: f.path, size: f.size })));
        });
      }, 200);
    } else {
      setMention(null);
      setMentionItems([]);
    }
  };

  const pickMention = (p: MentionItem) => {
    if (!mention) return;
    if (p.kind === "member") {
      // 成员 @ 留在正文里：这才是"对某个人说的话"，摘掉就丢了定向语义
      setDraft((d) => d.slice(0, mention.start) + `@${p.name} ` + d.slice(mention.start + mention.q.length + 1));
    } else {
      // 文件：从草稿里摘掉 @token，进随附条，不留在正文里
      setDraft((d) => d.slice(0, mention.start) + d.slice(mention.start + mention.q.length + 1));
      setAttFiles((f) => (f.includes(p.path) ? f : [...f, p.path]));
    }
    setMention(null);
    setMentionItems([]);
    taRef.current?.focus();
  };

  const addImage = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const data = String(reader.result ?? "");
      if (data.startsWith("data:image/")) {
        setAttImages((imgs) => [...imgs, { name: file.name || `图片${++imgSeq.current}`, data }]);
      }
    };
    reader.readAsDataURL(file);
  };

  const submit = () => {
    if (mention) {
      const pick = mentionItems[mentionIdx];
      if (pick) pickMention(pick);
      return;
    }
    const text = draft.trim();
    if (!text && !hasAtt) return;
    if (text === "/standby") {
      setDraft("");
      onStandby?.();
      return;
    }
    const attachments = hasAtt ? { files: attFiles, images: attImages } : undefined;
    onSend(text, busy ? mode : "queue", attachments);
    setDraft("");
    setAttFiles([]);
    setAttImages([]);
    setMention(null);
  };

  const fmtSize = (n: number): string => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB` : n >= 1024 ? `${Math.round(n / 1024)}KB` : `${n}B`);

  return (
    <div className="composer">
      {busy && (
        <div className="dispatch-strip">
          <span className="lbl">{t("composer.inProgress")}</span>
          <span className="dchip b">
            <span className="pip" /> {turn.phase === "review" ? t("composer.awaiting") : t("composer.running")}
          </span>
          {/* 状态行：串行工具轮期间必须看得见"在做什么 + 已用时"，否则像卡死 */}
          {turn.activity && (
            <span className="dchip">
              {turn.activity === "tool"
                ? t("composer.actTool", { name: turn.activityName ?? "" })
                : t("composer.actModel")}
              {elapsed > 0 ? ` · ${t("composer.elapsed", { s: elapsed })}` : ""}
            </span>
          )}
          {queue.length > 0 && (
            <>
              <span className="dchip">{t("composer.queued", { n: queue.length })}</span>
              {queue.map((q) => (
                <span key={q.id} className="dchip" title={q.text}>
                  {q.text.slice(0, 12)}
                  <button type="button" className="x" onClick={() => onQueue("remove", q.id)} title={t("composer.withdraw")}>
                    ×
                  </button>
                </span>
              ))}
              <button type="button" className="strip-link" onClick={() => onQueue("clear")}>
                {t("common.clear")}
              </button>
            </>
          )}
        </div>
      )}

      {/* 本轮随附条（M1-16）：发送前看得见她将带走的东西，每片可裁剪 */}
      {hasAtt && (
        <div className="attach-strip" role="list" aria-label="本轮随附">
          <span className="lbl">本轮随附</span>
          {attFiles.map((f) => (
            <span key={f} className="attach-chip" role="listitem" title={`将携带文件 ${f}`}>
              @{f}
              <button
                type="button"
                className="x"
                aria-label={`移除 ${f}`}
                onClick={() => setAttFiles((fs2) => fs2.filter((x) => x !== f))}
              >
                ×
              </button>
            </span>
          ))}
          {attImages.map((img, i) => (
            <span key={`${img.name}-${i}`} className="attach-chip img" role="listitem" title={`将携带图片 ${img.name}`}>
              <img src={img.data} alt={img.name} />
              {img.name}
              <button
                type="button"
                className="x"
                aria-label={`移除 ${img.name}`}
                onClick={() => setAttImages((imgs) => imgs.filter((_, j) => j !== i))}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="composer-row" style={{ position: "relative" }}>
        {mention && mentionItems.length > 0 && (
          <div className="mention-pop" role="listbox" aria-label="@ 补全">
            {mentionItems.map((it, i) => (
              <button
                type="button"
                key={it.kind === "member" ? `m:${it.name}` : `f:${it.path}`}
                role="option"
                aria-selected={i === mentionIdx}
                className={`mention-item${i === mentionIdx ? " on" : ""}${it.kind === "member" ? " who" : ""}`}
                onMouseEnter={() => setMentionIdx(i)}
                onClick={() => pickMention(it)}
              >
                <span className="p">
                  {it.kind === "member" ? <Icon name="users" size="sm" /> : null}
                  @{it.kind === "member" ? it.name : it.path}
                </span>
                <span className="s">{it.kind === "member" ? (it.role ?? "成员") : fmtSize(it.size)}</span>
              </button>
            ))}
          </div>
        )}
        <textarea
          ref={taRef}
          className="composer-in"
          rows={1}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            detectMention(e.target.value, e.target.selectionStart ?? e.target.value.length);
          }}
          onPaste={(e) => {
            const imgs = Array.from(e.clipboardData?.items ?? []).filter((it) => it.kind === "file" && it.type.startsWith("image/"));
            if (imgs.length > 0) {
              e.preventDefault();
              for (const it of imgs) {
                const f = it.getAsFile();
                if (f) addImage(f);
              }
            }
          }}
          onKeyDown={(e) => {
            if (mention && mentionItems.length > 0) {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setMentionIdx((i) => (i + 1) % mentionItems.length);
                return;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setMentionIdx((i) => (i - 1 + mentionItems.length) % mentionItems.length);
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setMention(null);
                return;
              }
              if (e.key === "Enter" || e.key === "Tab") {
                e.preventDefault();
                const pick = mentionItems[mentionIdx];
                if (pick) pickMention(pick);
                return;
              }
            }
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={
            configured
              ? busy
                ? mode === "steer"
                  ? "插话：会打断当前方向…"
                  : "排队：这一轮结束后执行…"
                : variant === "review"
                  ? "告诉她怎么改，或直接回答她…"
                  : "交给风铃去做，或 @ 提及文件、粘贴图片…"
              : "先配置模型（我的风铃 → 模型）"
          }
        />
        {busy && (
          <div className="mode-toggle">
            <button type="button" className={`av-vbtn${mode === "queue" ? " on" : ""}`} onClick={() => setMode("queue")}>
              排队
            </button>
            <button type="button" className={`av-vbtn${mode === "steer" ? " on" : ""}`} onClick={() => setMode("steer")}>
              插话
            </button>
          </div>
        )}
        <Slot
          slot="composer.action"
          render={(p) =>
            p.sandbox ? (
              <SandboxAction plugin={p} onAction={(label) => setDraft((d) => `${d}!${label} `)} />
            ) : null
          }
        />
        {busy ? (
          <button type="button" className="send stop" onClick={onAbort} title={t("composer.stop")}>
            <i />
          </button>
        ) : (
          <button type="button" className="send" onClick={submit} disabled={!canSend} title={t("composer.send")}>
            <Icon name="send" />
          </button>
        )}
      </div>

      <div className="composer-hint">
        <span className="mono">{t("composer.keys")}</span>
        {busy && (
          <>
            <span className="sep">·</span>
            <span className="mono">生成中可排队或插话</span>
          </>
        )}
        <button
          type="button"
          className="capture-trigger"
          title={t("capture.composerHint")}
          onClick={() => {
            setCaptureErr(null);
            void window.lynn
              .rpc("capture.start")
              .then((r) => {
                if (!r.ok) setCaptureErr(r.error ?? t("capture.failed"));
              })
              .catch((err: unknown) => setCaptureErr(`${t("capture.failed")}：${err instanceof Error ? err.message : String(err)}`));
          }}
        >
          {t("capture.trigger")}
        </button>
        {captureErr && <span className="capture-err">{captureErr}</span>}
      </div>
    </div>
  );
}

// ============================ REVIEW DESK（场景 2） ============================

/** 把真实工单装配成审查台需要的形状（没有的字段就留空，不编造内容） */
function reviewOf(job: DeskJob) {
  const ev = job.evidence.filter((e) => e.level !== "pending");
  return {
    product: {
      title: `交付 · ${job.member ?? "成员"}`,
      note: `结论　${job.report?.conclusion ?? job.statusNote}`,
      lines: ev.map((e, i) => ({
        no: String(i + 1),
        text: `${e.verified ? "✓" : "?"} ${e.title} — ${e.ref ?? e.detail}`,
      })),
    },
    source: {
      title: "证据索引",
      note: `${ev.length} 项　可点开验证`,
      lines: job.evidence.map((e) => ({ no: e.verified ? "✓" : e.level === "warn" ? "!" : "—", text: e.detail })),
    },
    reject: job.rejectDraft ?? { what: "", expect: "", deadline: "15 分钟" },
    report: job.report ?? { conclusion: "", evidence: "", unfinished: "", decision: "" },
    ac: ev.map((e) => ({ ok: !!e.verified, text: e.title })),
  };
}

function ReviewDesk({
  desk,
  job,
  onBack,
  onApprove,
  onReject,
  onPreview,
}: {
  desk: Desk;
  job: DeskJob;
  onBack: () => void;
  onApprove: () => void;
  onReject: (reason: { what: string; expect: string; deadline: string }) => void;
  onPreview?: OpenPreview;
}) {
  const r = reviewOf(job);
  const [what, setWhat] = useState(r.reject.what);
  const [expect, setExpect] = useState(r.reject.expect);
  const [deadline, setDeadline] = useState(r.reject.deadline);
  const [sent, setSent] = useState(false);
  const t = useT();

  // Esc = 返回值台（审查台唯一的深页面，必须有键盘出口）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onBack();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onBack]);

  const ac = r.ac;
  const canReject = what.trim() !== "" && expect.trim() !== "" && deadline.trim() !== "";

  return (
    <div className="scene">
      <TopRail
        desk={desk}
        permission="ask"
        onPermission={() => {}}
        onOpenSettings={() => {}}
        mode="review"
        onBack={onBack}
      />
      <div className="body">
        <aside className="ledger" style={{ width: 230 }}>
          <div className="ledger-head">
            <span className="h-cap">验收包</span>
            <span className="h-count">
              {job.id} · v{job.version}
            </span>
          </div>
          <div className="ledger-scroll" style={{ paddingTop: 4 }}>
            <div className="grp-label" style={{ paddingTop: 8 }}>
              成员
            </div>
            <div className="job on">
              <div className="job-top">
                <span className="job-id">交付人</span>
                <span className="st st-wait">{job.action === "none" ? "风铃在验" : "等你拍板"}</span>
              </div>
              <div className="job-title">
                {job.member ?? "风铃"} · {job.memberRole ?? "调度"}
              </div>
              <div className="job-meta">
                <span className="mono">{fmtTime(job.at)}</span>
              </div>
            </div>

            <div className="grp-label">验收标准 · {ac.length}</div>
            {ac.map((c, i) => (
              <div className="job" key={i}>
                <div className="job-top">
                  <span className="job-id">AC-{i + 1}</span>
                  <span className={`st ${c.ok ? "st-done" : "st-wait"}`}>{c.ok ? "满足" : "存疑"}</span>
                </div>
                <div className="job-title">{c.text}</div>
              </div>
            ))}

            {job.artifact && (
              <>
                <div className="grp-label">产物 · 1</div>
                <div className="job">
                  <div className="job-top">
                    <span className="job-id">FILE</span>
                    <span className="st st-done">已入库</span>
                  </div>
                  <div className="job-title">{job.artifact.name}</div>
                </div>
              </>
            )}

            <div className="grp-label">简报包 · {job.member ?? "成员"}收到的</div>
            <div className="job">
              <div className="job-top">
                <span className="job-id">BRIEF</span>
                <span className="st st-done">已投递</span>
              </div>
              <div className="job-title">{job.statusNote}</div>
            </div>

            {/* 次要出口：主出口在顶栏「返回值台」+ Esc；这里不再用斜体空态样式伪装 */}
            <div className="grp-label" style={{ paddingTop: 10 }}>
              <a onClick={onBack} style={{ color: "var(--blue)", cursor: "pointer" }}>
                ← {t("top.back")}
              </a>
            </div>
          </div>
        </aside>

        <main className="center">
          <div className="sheet-wrap">
            <div className="sheet">
              <div className="sheet-head">
                <div className="sheet-eyebrow">
                  <span>验收包 · {job.id}</span>
                  <span style={{ opacity: 0.4 }}>/</span>
                  <span>提交于 {fmtTime(job.at)}</span>
                  <span style={{ opacity: 0.4 }}>/</span>
                  <span>无证据不算完成</span>
                </div>
                <h1 className="sheet-title">{job.title}</h1>
                <div className="sheet-sub">{job.statusNote}</div>
              </div>

              <div className="sheet-body">
                <div className="work" style={{ paddingTop: 16 }}>
                  <div className="rev-pair">
                      <div>
                        <div className="h-cap" style={{ marginBottom: 8 }}>
                          {r.product.title}
                        </div>
                        <div className="diff" style={{ marginTop: 0 }}>
                          <div className="f">
                            <span className="s">{r.product.note.split("　")[0]}</span>
                            <span>{r.product.note.split("　")[1] ?? ""}</span>
                          </div>
                          {r.product.lines.map((l, i) => (
                            <div key={i} className="l">
                              <span className="ln">{l.no}</span>
                              {l.text}
                            </div>
                          ))}
                        </div>
                      </div>
                      <div>
                        <div className="h-cap" style={{ marginBottom: 8 }}>
                          {r.source.title}
                        </div>
                        <div className="diff" style={{ marginTop: 0 }}>
                          <div className="f">
                            <span className="s">{r.source.note.split("　")[0]}</span>
                            <span>{r.source.note.split("　")[1] ?? ""}</span>
                          </div>
                          {r.source.lines.map((l, i) => (
                            <div key={i} className="l">
                              <span className="ln">{l.no}</span>
                              {l.text}
                            </div>
                          ))}
                        </div>
                      </div>
                  </div>



                  <div className="artifact" style={{ maxWidth: 660 }}>
                    <div className="artifact-h">
                      <Icon name="pen" size="sm" />
                      <span>打回必须写清</span>
                      <span className="nm">风铃已替你填好，改完直接发</span>
                    </div>
                    <div className="art-table">
                      {[
                        { k: "哪里不合格", v: what, set: setWhat, ph: "填：哪里不合格（不带理由的打回算她的失职）" },
                        { k: "期望是什么", v: expect, set: setExpect, ph: "填：期望怎么改、补什么" },
                        { k: "多久内重交", v: deadline, set: setDeadline, ph: "如 15 分钟" },
                      ].map((f) => (
                        <div className="art-row rev-row" key={f.k}>
                          <span className="no rev-k">{f.k}</span>
                          <textarea
                            className="rev-field"
                            value={f.v}
                            onChange={(e) => f.set(e.target.value)}
                            placeholder={f.ph}
                            rows={f.k === "多久内重交" ? 1 : 2}
                          />
                        </div>
                      ))}
                      <div className="art-foot">
                        <span>不带理由的打回，算她的失职</span>
                        <span style={{ marginLeft: "auto" }}>这一轮是第 {job.rejections + 1} 次打回</span>
                      </div>
                    </div>
                  </div>
                </div>

              </div>

            </div>
          </div>

        </main>

        <aside className="right" style={{ width: 360 }}>
          <div className="right-scroll">
            <div className="panel-h">
              <div className="l">
                <span className="t">{job.action === "none" ? "风铃在验" : "你的裁定"}</span>
                <span className="n">{job.id}</span>
              </div>
              <span className="cap">
                第 {job.rejections + 1} 轮 / 共 {job.rejectLimit} 轮
              </span>
            </div>

            <div className="sealcard" style={{ marginTop: 2 }}>
              <div className="sealcard-h">
                <span className="k">{job.action === "none" ? "这张单不占你的待办" : "等你拍板"}</span>
                <span className="mono" style={{ fontSize: "var(--fs-label)", color: "var(--ink-4)" }}>
                  {fmtTime(job.at)}
                </span>
              </div>
              <div className="sealcard-body">
                <SealGlyph big />
                <div className="sealcard-text">
                  <div className="who">
                    <b>{job.member ?? "风铃"}</b> 提交 · {job.memberRole ?? "调度"}
                  </div>
                  <div className="ask">这份交付能不能收？</div>
                </div>
              </div>

              {ac.length > 0 && (
                <div className="accept">
                  <div className="k">她已核对 · {ac.length} 项验收标准</div>
                  <ul>
                    {ac.map((c, i) => {
                      const ref = job.evidence[i]?.ref;
                      return (
                        <li key={i} className={c.ok ? "ok" : "bad"}>
                          <button
                            type="button"
                            className="ac-link"
                            disabled={!ref}
                            title={ref ? `打开 ${ref}` : "这项没有可打开的文件"}
                            onClick={() => {
                              if (ref) onPreview?.(job.id, ref);
                            }}
                          >
                            <Icon name={c.ok ? "check" : "warn"} size="sm" />
                            <span>{c.text}</span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}

              <div className="seal-actions" style={{ flexDirection: "column" }}>
                <button type="button" className="btn btn-accept" onClick={onApprove}>
                  <Icon name="check" size="sm" /> 验收归档
                </button>
                <button
                  type="button"
                  className="btn btn-reject"
                  disabled={!canReject}
                  style={{ justifyContent: "space-between", padding: "8px 12px" }}
                  onClick={() => {
                    if (!canReject) return;
                    setSent(true);
                    onReject({ what: what.trim(), expect: expect.trim(), deadline: deadline.trim() });
                  }}
                >
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                    <Icon name="undo" size="sm" /> 打回重做
                  </span>
                  <span className="mono" style={{ fontSize: "var(--fs-label)", color: "var(--ink-3)" }}>
                    {canReject ? "理由已填好" : "三要素必填"}
                  </span>
                </button>
              </div>

              <div className="rounds">
                <span>打回轮次</span>
                {Array.from({ length: job.rejectLimit }, (_, i) => (
                  <span key={i} className={`sq${i < job.rejections ? " on" : ""}`} />
                ))}
                <span style={{ marginLeft: "auto" }}>连打 {job.rejectLimit} 轮未过，她会来问你</span>
              </div>
            </div>

            {sent && <div className="sf-result ok" style={{ margin: "0 0 12px" }}>已打回：理由已记入卷宗。</div>}
          </div>
        </aside>
      </div>
    </div>
  );
}

// ============================ COMMAND PALETTE (E6) ============================

type CmdItem = { key: string; group: string; label: string; hint?: string; run: () => void };

/** Ctrl+K：跳工单 / 会话 / 动作。键盘上下选择，Enter 执行。 */
function CommandPalette({
  desk,
  onClose,
  onSelectJob,
  onThread,
  onOpenSettings,
  onStandby,
  onNew,
  onPickProject,
  onClearWorkspace,
  onAddReadRoots,
}: {
  desk: Desk;
  onClose: () => void;
  onSelectJob: (id: string) => void;
  onThread?: (id: string) => void;
  onOpenSettings: () => void;
  onStandby: () => void;
  onNew?: () => void;
  onPickProject?: () => void;
  onClearWorkspace?: () => void;
  onAddReadRoots?: () => void;
}) {
  const t = useT();
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  const items = useMemo<CmdItem[]>(() => {
    const list: CmdItem[] = [];
    for (const j of desk.jobs) {
      list.push({ key: `job:${j.id}`, group: t("cmdk.jobs"), label: `${j.id} · ${j.title}`, run: () => onSelectJob(j.id) });
    }
    for (const th of desk.threads) {
      list.push({ key: `th:${th.id}`, group: t("cmdk.threads"), label: th.title, hint: fmtTime(th.updatedAt), run: () => onThread?.(th.id) });
    }
    list.push(
      { key: "a:new", group: t("cmdk.actions"), label: t("cmdk.newThread"), run: () => onNew?.() },
      { key: "a:settings", group: t("cmdk.actions"), label: t("cmdk.settings"), run: () => onOpenSettings() },
      { key: "a:standby", group: t("cmdk.actions"), label: t("cmdk.standby"), run: () => onStandby() },
      { key: "a:workdir", group: "工作区", label: "换工作区…", run: () => onPickProject?.() },
      { key: "a:nowork", group: "工作区", label: "这次不用工作区", run: () => onClearWorkspace?.() },
      { key: "a:readroot", group: "工作区", label: "加只读目录…", run: () => onAddReadRoots?.() },
    );
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [desk.jobs, desk.threads, t]);
  const filtered = q.trim() ? items.filter((i) => i.label.toLowerCase().includes(q.trim().toLowerCase())) : items;
  const sel = Math.min(idx, Math.max(0, filtered.length - 1));

  useEffect(() => {
    // capture：面板开着时键盘事件在这里先处理，不吃到底层
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setIdx((i) => Math.min(i + 1, filtered.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setIdx((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        filtered[sel]?.run();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [filtered, sel, onClose]);

  // 分组保持 jobs → threads → actions 顺序
  const groups: { name: string; items: CmdItem[] }[] = [];
  for (const it of filtered) {
    const g = groups.find((x) => x.name === it.group);
    if (g) g.items.push(it);
    else groups.push({ name: it.group, items: [it] });
  }
  let flat = -1;

  return (
    <div className="cmdk-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="cmdk" role="dialog" aria-label={t("cmdk.title")}>
        <div className="cmdk-inrow">
          <Icon name="search" size="sm" />
          <input
            autoFocus
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setIdx(0);
            }}
            placeholder={t("cmdk.placeholder")}
          />
        </div>
        <div className="cmdk-list">
          {filtered.length === 0 && <div className="cmdk-empty">{t("cmdk.empty")}</div>}
          {groups.map((g) => (
            <div key={g.name}>
              <div className="cmdk-grp">{g.name}</div>
              {g.items.map((it) => {
                flat += 1;
                const on = flat === sel;
                return (
                  <button
                    type="button"
                    key={it.key}
                    className={`cmdk-item${on ? " on" : ""}`}
                    onMouseEnter={() => setIdx(filtered.indexOf(it))}
                    onClick={() => {
                      it.run();
                      onClose();
                    }}
                  >
                    <span className="l">{it.label}</span>
                    {it.hint && <span className="hint mono">{it.hint}</span>}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Ctrl+/：快捷键清单（截图键从壳层实况读，改键后不漂移） */
function KeymapOverlay({ onClose }: { onClose: () => void }) {
  const t = useT();
  const [captureKey, setCaptureKey] = useState("Alt+Shift+S");
  useEffect(() => {
    let dead = false;
    void window.lynn
      .rpc("capture.status")
      .then((r) => {
        if (!dead && r?.hotkey) setCaptureKey(r.hotkey);
      })
      .catch(() => {
        /* 拿不到就显示默认键，不阻塞面板 */
      });
    return () => {
      dead = true;
    };
  }, []);
  const rows: { k: string; d: string }[] = [
    { k: "Ctrl+K", d: t("keymap.palette") },
    { k: "Ctrl+/", d: t("keymap.keymap") },
    { k: "Ctrl+.", d: t("keymap.standby") },
    { k: "Alt+Shift+L", d: t("keymap.global") },
    { k: captureKey, d: t("keymap.capture") },
    { k: "Esc", d: t("keymap.close") },
    { k: "Enter", d: t("keymap.send") },
    { k: "Shift+Enter", d: t("keymap.newline") },
    { k: "@", d: t("keymap.mention") },
  ];
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  return (
    <div className="cmdk-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="cmdk" role="dialog" aria-label={t("keymap.title")}>
        <div className="cmdk-head">{t("keymap.title")}</div>
        <div className="cmdk-list">
          {rows.map((r) => (
            <div className="keymap-row" key={r.k}>
              <span className="mono">{r.k}</span>
              <span>{r.d}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ============================ DESK ============================

export function DeskView({
  desk,
  permission,
  configured,
  ambient,
  ambientMode,
  onPermission,
  onSend,
  onAbort,
  onQueue,
  onDecision,
  onDecisionResolve,
  onFileSearch,
  onFeedAction,
  onOpenSettings,
  onPickProject,
  onClearWorkspace,
  onAddReadRoots,
  onRemoveReadRoot,
  onStandby,
  onNew,
  onUndo,
  onThread,
  onThreadNew,
  onThreadSearch,
  onThreadRename,
  onThreadRemove,
  onThreadPin,
  onTaskFeed,
  onCreateTeam,
  onManageTeam,
  onCancelTask,
  onDismissTask,
  onRemoveTask,
  onGrantRead,
  onRevokeRead,
  onSnapshotProject,
  onExportTask,
  captureShot,
  notice,
}: {
  desk: Desk;
  permission: PermissionMode;
  configured: boolean;
  ambient: AmbientParams;
  ambientMode: AmbientMode;
  onPermission: (m: PermissionMode) => void;
  onSend: (text: string, mode: "queue" | "steer", attachments?: { files?: string[]; images?: { name: string; data: string }[] }) => void;
  /** 项目工作区文件检索（@ 提及补全，M1-16） */
  onFileSearch?: (q: string) => Promise<{ path: string; size: number }[]>;
  onAbort: () => void;
  onQueue: (action: "clear" | "remove", id?: string) => void;
  onDecision: (taskId: string, action: "approve" | "reject", reason?: { what: string; expect: string; deadline: string }) => void;
  onDecisionResolve: (id: string, action: "answer" | "start" | "revise" | "reject", text?: string) => void;
  onFeedAction: (card: FeedCard) => void;
  onOpenSettings: () => void;
  /** 换当前会话的工作区 */
  onPickProject?: () => void;
  /** 这次不用工作区（产出落卷宗沙箱） */
  onClearWorkspace?: () => void;
  /** 给当前会话加只读目录（可多选） */
  onAddReadRoots?: () => void;
  onRemoveReadRoot?: (path: string) => void;
  onStandby: () => void;
  onNew?: () => void;
  onUndo?: () => void;
  /** 会话线程（M1-14） */
  onThread?: (id: string) => void;
  onThreadNew?: () => void;
  onThreadSearch?: (q: string) => Promise<{ id: string; title: string; hits: string[] }[]>;
  onThreadRename?: (id: string, title: string) => void;
  onThreadRemove?: (id: string) => void;
  /** 置顶 / 取消置顶（群列表微信式） */
  onThreadPin?: (id: string, pinned: boolean) => void;
  /** 工单往来（跨会话追溯）：工单出发会话 ≠ 当前会话时按 threadId 回读 */
  onTaskFeed?: (taskId: string) => Promise<{ cards: FeedCard[]; threadId?: string; threadTitle?: string }>;
  /** 建团队（§4.10.3 修正）：用户只给名字，ID 由系统生成 */
  onCreateTeam?: (name: string) => void;
  /** 打开「我的风铃 → 团队」：手动改岗位 / 移出成员 / 解散团队 */
  onManageTeam?: () => void;
  /** 停一张在跑的单 */
  onCancelTask?: (taskId: string) => void;
  /** 取消一张单（→ 归档带）/ 彻底删除（不可恢复） */
  onDismissTask?: (taskId: string) => void;
  onRemoveTask?: (taskId: string) => void;
  /** 只读授权：成员能读这个目录，写仍限工作区 */
  onGrantRead?: (taskId: string) => void;
  onRevokeRead?: (taskId: string) => void;
  /** 审查快照：把工作区复制进任务沙箱再跑测试（原项目不动） */
  onSnapshotProject?: (taskId: string) => void;
  /** 导出卷宗 zip */
  onExportTask?: (taskId: string) => void;
  /** 全局快捷键截好的图（只进本轮随附） */
  captureShot?: CaptureShot | null;
  /** 发送/新建失败时的可见提示（不允许静默失败） */
  notice?: string | null;
}) {
  const waitingFirst = useMemo(() => {
    // 归档/已取消的单不能再被默认选中：否则左栏「工单 0」，主区却霸着一张旧单的详情，
    // 看起来像"凭空冒出一张单"（2026-11-11 修）。用户显式点归档项仍可打开。
    const live = desk.jobs.filter((j) => j.group !== "archived");
    return live.find((j) => j.action !== "none") ?? live[0];
  }, [desk.jobs]);
  /**
   * 群里可点名的人（@ 补全候选）：本群工单的承办成员排前面。
   * 本群先、别群后——群里 @ 一个听不见的人没有意义。
   */
  const mentionMembers = useMemo(() => {
    const inGroup = new Set(
      desk.jobs.filter((j) => j.threadId === desk.thread.id && j.member).map((j) => j.member as string),
    );
    return [...desk.members]
      .sort((a, b) => Number(inGroup.has(b.name)) - Number(inGroup.has(a.name)))
      .map((m) => ({ name: m.name, role: m.role }));
  }, [desk.jobs, desk.members, desk.thread.id]);
  /** 右键成员「@他说话」：把名字插进输入框（群聊模式） */
  const [atTarget, setAtTarget] = useState<{ name: string; nonce: number } | null>(null);
  // 默认永远是「会话频道」：用户与风铃的完整对话不会被任何工单抢走。
  // 需要拍板的单走右栏/频道提示，用户点开才切工单详情（2026-11-11 修）。
  const [activeId, setActiveId] = useState<string | undefined>(undefined);
  const [reviewId, setReviewId] = useState<string | null>(null);
  /** 窄窗（≤1280）右栏抽屉：顶栏「待办 (n)」开关 */
  const [rightOpen, setRightOpen] = useState(false);
  /**
   * 有新的「要你动手」的事到达时自动展开右栏：藏在抽屉里等于没看见。
   * 不只裁决——成员交了**待验收**的活同样要弹出来，否则用户只知道顶栏数字变了，还得自己找单。
   */
  const prevPending = useRef(0);
  useEffect(() => {
    const n = desk.decisions.length + desk.jobs.filter((j) => j.action === "accept").length;
    if (n > prevPending.current) setRightOpen(true);
    prevPending.current = n;
  }, [desk.decisions.length, desk.jobs]);
  // E6：Ctrl+K 命令面板 / Ctrl+/ 快捷键清单——能力实际存在就必须可发现
  const [cmdkOpen, setCmdkOpen] = useState(false);
  const [keymapOpen, setKeymapOpen] = useState(false);
  /** 内置预览抽屉：交付箱 / 证据链 / 验收标准三处共用，不启外部程序 */
  const [preview, setPreview] = useState<{ taskId: string; ref: string } | null>(null);
  const openPreview = useCallback<OpenPreview>((taskId, ref) => setPreview({ taskId, ref }), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setCmdkOpen((v) => !v);
      } else if ((e.ctrlKey || e.metaKey) && e.key === "/") {
        e.preventDefault();
        setKeymapOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const current = activeId ? desk.jobs.find((j) => j.id === activeId) : undefined;
  const reviewJob = desk.jobs.find((j) => j.id === reviewId);
  const pendingCount = desk.decisions.length + desk.jobs.filter((j) => j.action === "accept").length;

  // 选中的单被删掉/不再上台账时回到频道，别留一张"幽灵详情"在中间。
  useEffect(() => {
    if (activeId && !desk.jobs.some((j) => j.id === activeId)) setActiveId(undefined);
  }, [activeId, desk.jobs]);

  useEffect(() => {
    if (!rightOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setRightOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rightOpen]);

  if (reviewJob) {
    return (
      <>
        <ReviewDesk
        desk={desk}
        job={reviewJob}
        onBack={() => setReviewId(null)}
        onPreview={openPreview}
        onApprove={() => {
          onDecision(reviewJob.id, "approve");
          setReviewId(null);
        }}
        onReject={(reason) => {
          onDecision(reviewJob.id, "reject", reason);
        }}
        />
        {preview && (
          <PreviewDrawer taskId={preview.taskId} fileRef={preview.ref} onClose={() => setPreview(null)} />
        )}
      </>
    );
  }

  return (
    <div className="scene">
      <AmbientLayer params={ambient} mode={ambientMode} standby={false} />
      <TopRail
        desk={desk}
        permission={permission}
        onPermission={onPermission}
        onOpenSettings={onOpenSettings}
        onUndo={onUndo}
        pending={pendingCount}
        rightOpen={rightOpen}
        onToggleRight={() => setRightOpen((v) => !v)}
        onPickProject={onPickProject}
        onClearWorkspace={onClearWorkspace}
        onAddReadRoots={onAddReadRoots}
        onRemoveReadRoot={onRemoveReadRoot}
      />
      {rightOpen && <button type="button" className="right-backdrop only-narrow" aria-label="close" onClick={() => setRightOpen(false)} />}
      <div className="body">
        <Ledger
          desk={desk}
          activeId={current?.id}
          onSelect={setActiveId}
          onThread={onThread}
          onThreadNew={onThreadNew}
          onThreadSearch={onThreadSearch}
          onThreadRename={onThreadRename}
          onThreadRemove={onThreadRemove}
          onThreadPin={onThreadPin}
          onCancelTask={onCancelTask}
          onDismissTask={onDismissTask}
          onRemoveTask={onRemoveTask}
          onGrantRead={onGrantRead}
          onRevokeRead={onRevokeRead}
          onSnapshotProject={onSnapshotProject}
          onExportTask={onExportTask}
          onPreview={openPreview}
          />
        <main className="center">
          <div className="sheet-wrap">
            <Sheet
              key={current?.id ?? "none"}
              job={current}
              feed={desk.feed}
              threadId={desk.thread.id}
              threadTitle={desk.threads.find((x) => x.id === current?.threadId)?.title}
              onTaskFeed={onTaskFeed}
              onThread={onThread}
              onFeedAction={onFeedAction}
              onExample={(t) => onSend(t, "queue")}
              onNewThread={onThreadNew}
              onBackToChannel={() => setActiveId(undefined)}
              pendingJob={waitingFirst ? { id: waitingFirst.id, title: waitingFirst.title } : undefined}
              onOpenJob={setActiveId}
              onPreview={openPreview}
              running={desk.running}
            />
          </div>
          <ComposerZone
            configured={configured}
            turn={desk.turn}
            queue={desk.queue}
            members={mentionMembers}
            pendingAt={atTarget}
            onStandby={onStandby}
            onSend={onSend}
            onFileSearch={onFileSearch}
            onAbort={onAbort}
            onQueue={onQueue}
            captureShot={captureShot}
          />
          {notice && <p className="composer-notice">{notice}</p>}
        </main>
        <Roster
          desk={desk}
          current={current}
          onAccept={(id) => onDecision(id, "approve")}
          onReject={(id, reason) => onDecision(id, "reject", reason)}
          onOpenReview={(id) => setReviewId(id)}
          onPlan={(id, action, text) => onDecisionResolve(id, action, text)}
          onAnswer={(id, text) => onDecisionResolve(id, "answer", text)}
          onSelectJob={(id) => {
            setActiveId(id);
            setRightOpen(false);
          }}
          onCreateTeam={onCreateTeam}
          onManageTeam={onManageTeam}
          onAt={(name) => setAtTarget({ name, nonce: Date.now() })}
          onThread={(id) => {
            setRightOpen(false);
            onThread?.(id);
          }}
          open={rightOpen}
          onClose={() => setRightOpen(false)}
        />
      </div>
      {cmdkOpen && (
        <CommandPalette
          desk={desk}
          onClose={() => setCmdkOpen(false)}
          onSelectJob={(id) => {
            setReviewId(null);
            setActiveId(id);
          }}
          onThread={(id) => {
            onThread?.(id);
          }}
          onOpenSettings={onOpenSettings}
          onStandby={onStandby}
          onNew={onNew}
          onPickProject={onPickProject}
          onClearWorkspace={onClearWorkspace}
          onAddReadRoots={onAddReadRoots}
        />
      )}
      {keymapOpen && <KeymapOverlay onClose={() => setKeymapOpen(false)} />}
      {preview && (
        <PreviewDrawer taskId={preview.taskId} fileRef={preview.ref} onClose={() => setPreview(null)} />
      )}
    </div>
  );
}
 