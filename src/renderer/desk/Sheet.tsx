// 中栏（2026-11-14）：Sheet（对话流 / 工单页）+ 项目条 + diff/证据/产物三个视图。
//
// 20 个 props 全是"数据 + 回调"，没有与右栏双向绑定的可变状态，所以可以整块搬。
// 右键菜单的坐标状态仍在 DeskView（Sheet 只负责触发 onRefMenu）。
import { useEffect, useMemo, useState } from "react";
import { useT } from "../i18n";
import { Icon } from "../components/Icon";
import { FeedScroller, FeedView } from "./Feed";
import { RefMenu } from "./Menus";
import { STAGE_KEYS, fmtTime } from "./model";
import type { DeskDiff, DeskEvidence, DeskJob, OpenPreview } from "./model";
import type { I18nKey } from "../../shared/i18n-strings";
import type { FeedCard } from "../../shared/contract";
import type { IconName } from "../components/Icon";

/**
 * 「终止任务」（2026-11-15）：整群止损是重动作，不做"点一下就全停"——
 * 第一次点亮成「确认终止」，3.6 秒内不点第二下自动收回；失焦同样收回。
 * 这两下都在同一颗按钮里，不弹窗、不遮对话。
 */
function HaltButton({ onHalt }: { onHalt: () => void }) {
  const t = useT();
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const timer = window.setTimeout(() => setArmed(false), 3600);
    return () => window.clearTimeout(timer);
  }, [armed]);
  return (
    <button
      type="button"
      className={`halt-btn${armed ? " armed" : ""}`}
      title={armed ? t("sheet.haltConfirmHint") : t("sheet.haltHint")}
      onClick={() => {
        if (armed) {
          setArmed(false);
          onHalt();
          return;
        }
        setArmed(true);
      }}
      onBlur={() => setArmed(false)}
    >
      <Icon name="stop" size="sm" />
      {armed ? t("sheet.haltConfirm") : t("sheet.halt")}
    </button>
  );
}

export function Sheet({
  job,
  feed,
  threadId,
  threadTitle,
  channelTitle,
  halted,
  onHalt,
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
  project,
  onPickProject,
  onRenameProject,
  onRefMenu,
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
  /** 当前群的标题（2026-11-13）：频道页头要报群名，而不是一句空态引导 */
  channelTitle?: string;
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
  /** 当前项目（2026-11-12）：对话里始终看得见这段话在动哪个项目 */
  project?: {
    id?: string;
    name?: string;
    primary?: string;
    extras: { path: string; mode: "rw" | "ro"; label?: string }[];
  };
  /** 换项目目录 */
  onPickProject?: () => void;
  /** 改项目显示名（跟着项目走，所有群一起变） */
  onRenameProject?: (name: string) => void;
  /** 右键产物：定位文件 / 复制路径（2026-11-13） */
  onRefMenu?: (taskId: string, ref: string, label: string, x: number, y: number) => void;
  /** 本群是否已被「终止任务」停住（2026-11-15）：按钮换成状态，发一条消息恢复 */
  halted?: boolean;
  onHalt?: () => void;
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
          {/* 眉标删掉（2026-11-13）：它和下面的标题说的是同一个名字，一个页面两个标题就是噪音。
              有群就报群名（此前永远写「还没有选中工单」，下面还压着常驻的「说吧，要办什么」——
              那本来是空态引导，有对话时还挂着，整栏看着像一个没开始过的页面）。 */}
          {/* 标题右侧是整群唯一的止损入口（2026-11-15）：本群成员/心跳/验收叫醒一次全停 */}
          <div className="sheet-head-row">
            <h1 className="sheet-title">{channelTitle || t("sheet.emptyTitle")}</h1>
            {onHalt &&
              (halted ? (
                <span className="halt-state" title={t("sheet.haltStateHint")}>
                  <Icon name="stop" size="sm" />
                  {t("sheet.halted")}
                </span>
              ) : (
                <HaltButton onHalt={onHalt} />
              ))}
          </div>
          {!channelTitle && <div className="sheet-sub">{t("sheet.emptySub")}</div>}
          {halted && <div className="sheet-sub">{t("sheet.haltStateBody")}</div>}
          {pendingJob && (
            <div className="sheet-sub" style={{ marginTop: 8 }}>
              {t("sheet.pendingJob", { n: 1 })}{" "}
              <button type="button" className="strip-link" title={pendingJob.title} onClick={() => onOpenJob?.(pendingJob.id)}>
                {t("sheet.openJob")} →
              </button>
            </div>
          )}
          <ProjectBar project={project} onPick={onPickProject} onRename={onRenameProject} />
        </div>
        <div className="sheet-body">
          <FeedScroller resetKey={threadId ?? "channel"}>
            <FeedView
              cards={channel}
              onAction={onFeedAction}
              collapseHistory
              runningIds={running}
              onRefMenu={onRefMenu}
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
        <ProjectBar project={project} onPick={onPickProject} onRename={onRenameProject} />
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
            ...(job.diff ? [{ k: "diff", labelKey: "sheet.tabDiff" as I18nKey, icon: "diff" as IconName }] : []),
            ...(job.artifact ? [{ k: "artifact", labelKey: "sheet.tabArtifact" as I18nKey, icon: "table" as IconName }] : []),
            // 交付物优先：有交付物或核对记录就出现，用户先看结果
            ...(evidence.length > 0 || (job.deliverables?.length ?? 0) > 0
              ? [{ k: "evidence", labelKey: "sheet.tabEvidence" as I18nKey, icon: "list" as IconName }]
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
              onRefMenu={onRefMenu}
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
              onRefMenu={onRefMenu}
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

export function DiffView({ diff }: { diff: DeskDiff }) {
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
export function EvidenceView({
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
  /** 右键菜单（2026-11-13）：证据与产物共用一个「文件」菜单（打开/定位/复制路径） */
  const [refMenu, setRefMenu] = useState<{ ref: string; label?: string; x: number; y: number } | null>(null);
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
                onContextMenu={(e) => {
                  e.preventDefault();
                  setRefMenu({ ref: d.ref, label: d.path, x: e.clientX, y: e.clientY });
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
                onContextMenu={(ev) => {
                  if (!e.ref) return;
                  ev.preventDefault();
                  setRefMenu({ ref: e.ref, label: e.title, x: ev.clientX, y: ev.clientY });
                }}
              >
                <span className="t">{e.title}</span>
              </button>
            ))}
          </div>
        </details>
      )}
      {refMenu && (
        <RefMenu
          taskId={taskId}
          fileRef={refMenu.ref}
          label={refMenu.label}
          x={refMenu.x}
          y={refMenu.y}
          onClose={() => setRefMenu(null)}
          onOpen={() => {
            void window.lynn.rpc("evidence.open", { taskId, ref: refMenu.ref });
            setRefMenu(null);
          }}
          onReveal={() => {
            void window.lynn.rpc("app.revealPath", { taskId, ref: refMenu.ref });
            setRefMenu(null);
          }}
        />
      )}
    </div>
  );
}

export function ArtifactView({ job }: { job: DeskJob }) {
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

/**
 * 项目条（2026-11-12）：这段对话在动哪个项目，必须一直看得见。
 * 名字可改（改的是项目本身，绑在它上面的群一起变）；路径与只读根是事实，不藏。
 */
export function ProjectBar({
  project,
  onPick,
  onRename,
}: {
  project?: {
    id?: string;
    name?: string;
    primary?: string;
    extras: { path: string; mode: "rw" | "ro"; label?: string }[];
  };
  onPick?: () => void;
  onRename?: (name: string) => void;
}) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const name = project?.name ?? "";
  const primary = project?.primary ?? "";
  const extras = project?.extras ?? [];
  if (!primary) {
    return (
      <div className="proj-bar proj-bar-empty">
        <Icon name="folder" size="sm" />
        <span className="proj-none">{t("project.none")}</span>
        {onPick && (
          <button type="button" className="proj-act" onClick={onPick}>
            {t("project.pick")}
          </button>
        )}
      </div>
    );
  }
  return (
    <div className="proj-bar">
      <Icon name="folder" size="sm" />
      {editing ? (
        <input
          className="proj-input"
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            setEditing(false);
            if (draft.trim()) onRename?.(draft.trim());
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              if (draft.trim()) onRename?.(draft.trim());
              setEditing(false);
            }
            if (e.key === "Escape") setEditing(false);
          }}
        />
      ) : (
        <button
          type="button"
          className="proj-name"
          title={t("project.renameHint")}
          onClick={() => {
            setDraft(name);
            setEditing(true);
          }}
        >
          {name}
        </button>
      )}
      <span className="proj-path mono" title={primary}>
        {primary}
      </span>
      {extras.length > 0 && (
        <span
          className="proj-extra"
          title={extras.map((e) => `${e.path}（${e.mode === "rw" ? "可写" : "只读"}）`).join("\n")}
        >
          +{extras.length} {t("project.extraRoots")}
        </span>
      )}
      {/* 换目录只有顶栏那一个入口（那里还带只读根管理）——同一功能不摆两个入口 */}
    </div>
  );
}

const CHANNEL_TAB = { k: "channel", labelKey: "sheet.tabChannel", icon: "term" as IconName } as const;
const FEED_TAB = { k: "feed", labelKey: "sheet.tabFeed", icon: "bell" as IconName } as const;

/** 卷宗事件类型 → 人话（详情区状态时间线；kind 由内核 taskCase 固定） */
const TIMELINE_LABEL: Record<string, string> = {
  created: "建单", assign: "派单", report: "回报", reject: "打回", approve: "验收",
  transition: "状态", artifact: "产物", note: "记录", session: "会话",
};
