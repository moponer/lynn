import { useMemo, useRef, useState } from "react";
import type { FeedCard, PermissionMode, QueueItem } from "../../shared/contract";
import { Icon, type IconName } from "../components/Icon";
import { WindowControls } from "../components/WindowControls";
import type { Desk, DeskDiff, DeskJob, DeskMember } from "./model";
import { Slot, SandboxAction, SandboxHtml } from "./ui-host";
import { AmbientLayer } from "./AmbientLayer";
import type { AmbientMode, AmbientParams } from "../../shared/ambient";
import { STAGES, STAGE_KEYS, STATUS_KEY, MEMBER_STATUS_KEY, fmtTime } from "./model";
import { FeedView } from "./Feed";
import { useT } from "../i18n";

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

export function fmtTokens(n: number): string {
  if (n <= 0) return "0";
  return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
}

function statusChipClass(job: DeskJob): string {
  if (job.status === "in_review" || job.status === "blocked") return "st-wait";
  if (job.status === "in_progress") return "st-live";
  if (job.status === "done") return "st-done";
  return "st-idle";
}

// ============================ TOP RAIL ============================

function TopRail({
  desk,
  current,
  permission,
  onPermission,
  onOpenSettings,
  onNew,
  onUndo,
  mode = "desk",
}: {
  desk: Desk;
  current?: DeskJob;
  permission: PermissionMode;
  onPermission: (m: PermissionMode) => void;
  onOpenSettings: () => void;
  onNew?: () => void;
  onUndo?: () => void;
  mode?: "desk" | "review";
}) {
  const ctx = desk.usage.contextWindow > 0 ? Math.min(1, desk.usage.contextTokens / desk.usage.contextWindow) : 0;
  const contextPct = Math.round(ctx * 100);
  const filled = Math.min(12, Math.max(0, Math.round(ctx * 12)));
  const t = useT();
  return (
    <header
      className="rail-top"
      onDoubleClick={() => {
        // 拖拽区双击 = 最大化/还原（no-drag 控件不受影响）
        void window.lynn.rpc("window.control", { action: "maximize" });
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
      <div className="crumbs">
        <span className="crumb-chip">
          <Icon name="folder" size="sm" /> {desk.project}
        </span>
        <Icon name="chev" size="sm" />
        <span className="seg">{mode === "review" ? t("top.crumbReview") : t("top.crumbJob")}</span>
        <Icon name="chev" size="sm" />
        <span className="cur mono">{current?.id ?? "—"}</span>
      </div>
      <div className="spacer" />

      <div className="seg">
        <span className="seg-label">{t("top.permission")}</span>
        {PERMISSIONS.map((p) => (
          <button
            type="button"
            key={p.mode}
            aria-pressed={permission === p.mode}
            className={`seg-item${permission === p.mode ? " on" : ""}`}
            onClick={() => onPermission(p.mode)}
            title={t("top.switchTo", { label: t(p.labelKey) })}
          >
            {t(p.labelKey)}
          </button>
        ))}
      </div>

      <div className="vr" />

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

      <div
        className={`gauge${contextPct >= 90 ? " warn" : contextPct >= 70 ? " near" : ""}`}
        title={`${t("top.contextTitle", {
          used: desk.usage.contextTokens,
          total: desk.usage.contextWindow,
          tokens: fmtTokens(desk.tokensUsed),
        })}${contextPct >= 70 ? ` · ${t("top.contextHint")}` : ""}`}
      >
        <div className="gauge-read">
          <div className="v">{contextPct}%</div>
          <div className="k">{t("top.contextLabel")}</div>
        </div>
        <div className="gauge-bar">
          {Array.from({ length: 12 }, (_, i) => (
            <i
              key={i}
              className={`${i < filled ? "on" : ""}${contextPct >= 90 && i < filled ? " hot" : ""}`}
              style={{ height: `${8 + i}px` }}
            />
          ))}
        </div>
      </div>

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
      <button className="ghost-btn" onClick={onNew} title={t("top.newThread")}>
        <Icon name="plus" size="sm" /> {t("top.newThread")}
      </button>
      <button className="ghost-btn" onClick={onOpenSettings} title={t("top.settings")}>
        <Icon name="user" size="sm" /> {t("top.settings")}
      </button>
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
}: {
  desk: Desk;
  activeId?: string;
  onSelect: (id: string) => void;
  onThread?: (id: string) => void;
  onThreadNew?: () => void;
  onThreadSearch?: (q: string) => Promise<{ id: string; title: string; hits: string[] }[]>;
}) {
  const [q, setQ] = useState("");
  const [threadsOpen, setThreadsOpen] = useState(false);
  const [tq, setTq] = useState("");
  const [hits, setHits] = useState<{ id: string; title: string; hits: string[] }[]>([]);
  const t = useT();
  const match = (j: DeskJob) => !q || `${j.id} ${j.title} ${j.member ?? ""}`.toLowerCase().includes(q.toLowerCase());

  const waiting = desk.jobs.filter((j) => (j.status === "in_review" || j.status === "blocked") && match(j));
  const running = desk.jobs.filter((j) => !["in_review", "blocked", "done", "canceled"].includes(j.status) && match(j));
  const archived = desk.archived.filter((a) => !q || `${a.id} ${a.title}`.toLowerCase().includes(q.toLowerCase()));
  const activeCount = desk.jobs.filter((j) => j.status !== "done" && j.status !== "canceled").length;

  return (
    <aside className="ledger">
      <div className="ledger-head">
        <span className="h-cap">{t("ledger.title")}</span>
        <span className="h-count">{t("ledger.summary", { active: activeCount, archived: desk.archived.length })}</span>
      </div>
      <div className="thread-bar">
        <button
          type="button"
          className="thread-cur"
          onClick={() => setThreadsOpen((v) => !v)}
          title={t("ledger.switchThread")}
        >
          <Icon name="layers" size="sm" />
          <span className="t">{desk.thread.title}</span>
        </button>
        <button type="button" className="icon-btn" onClick={onThreadNew} title={t("top.newThread")}>
          <Icon name="plus" size="sm" />
        </button>
      </div>

      {threadsOpen && (
        <div className="thread-panel">
          <input
            className="thread-q"
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
          {tq.trim()
            ? hits.map((h) => (
                <button
                  type="button"
                  key={h.id}
                  className="thread-row"
                  onClick={() => {
                    onThread?.(h.id);
                    setThreadsOpen(false);
                  }}
                >
                  <b>{h.title}</b>
                  <small>{h.hits[0]}</small>
                </button>
              ))
            : desk.threads.map((t) => (
                <button
                  type="button"
                  key={t.id}
                  className={`thread-row${t.id === desk.thread.id ? " on" : ""}`}
                  onClick={() => {
                    onThread?.(t.id);
                    setThreadsOpen(false);
                  }}
                >
                  <b>{t.title}</b>
                  <small className="mono">{t.updatedAt.slice(5, 16).replace("T", " ")}</small>
                </button>
              ))}
          {tq.trim() && hits.length === 0 && <p className="sf-empty">没有匹配的历史。</p>}
        </div>
      )}

      <label className="search">
        <Icon name="search" size="sm" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t("top.searchBoard")}
          style={{ background: "none", border: 0, outline: 0, color: "inherit", font: "inherit", flex: 1, minWidth: 0 }}
        />
      </label>

      <div className="ledger-scroll">
        <div className="grp-label">
          <span className="dot" style={{ background: "var(--seal)" }} /> {t("ledger.awaiting", { n: waiting.length })}
        </div>
        {waiting.length === 0 && <div className="ledger-empty">{t("ledger.awaitingEmpty")}</div>}
        {waiting.map((j) => (
          <JobRow key={j.id} job={j} active={j.id === activeId} onClick={() => onSelect(j.id)} />
        ))}

        <div className="grp-label">
          <span className="dot" style={{ background: "var(--blue)" }} /> 进行中 · {running.length}
        </div>
        {running.length === 0 && <div className="ledger-empty">派第一件需要动手的活，她会自己招人组队</div>}
        {running.map((j) => (
          <JobRow key={j.id} job={j} active={j.id === activeId} onClick={() => onSelect(j.id)} />
        ))}

        {archived.length > 0 && (
          <div className="archive-band">
            <div className="ab-h">
              <Icon name="archive" size="sm" />
              <span>{t("ledger.archiveStrip")}</span>
              <span className="mono" style={{ marginLeft: "auto" }}>
                {archived.length}
              </span>
            </div>
            <ol>
              {archived.slice(0, 20).map((a) => (
                <li key={a.id} title={`~/.lynn/tasks/${a.id}/`}>
                  {a.id} <span className="mono">{a.title}</span>
                </li>
              ))}
            </ol>
          </div>
        )}

      </div>
    </aside>
  );
}

function JobRow({ job, active, onClick }: { job: DeskJob; active: boolean; onClick: () => void }) {
  const t = useT();
  return (
    <button type="button" className={`job${active ? " on" : ""}`} onClick={onClick}>
      <div className="job-top">
        <span className="job-id">{job.id}</span>
        <span className={`st ${statusChipClass(job)}`}>
          {job.status === "in_progress" && <span className="pip" />}
          {t(STATUS_KEY[job.status] ?? "status.todo")}
        </span>
      </div>
      <div className="job-title">{job.title}</div>
      <div className="job-meta">
        <Icon name="user" size="sm" /> {job.member ?? t("sheet.lynn")}
        <span style={{ color: "var(--ink-4)" }}>·</span>
        <span className="mono">{job.at ?? "—"}</span>
      </div>
    </button>
  );
}

// ============================ SHEET ============================

const FEED_TAB = { k: "feed", labelKey: "sheet.tabFeed", icon: "bell" as IconName };

function Sheet({
  job,
  feed,
  onFeedAction,
  onExample,
}: {
  job?: DeskJob;
  feed: FeedCard[];
  onFeedAction?: (c: FeedCard) => void;
  onExample?: (text: string) => void;
}) {
  const [tab, setTab] = useState("feed");
  const channel = useMemo(() => feed.filter((c) => !c.jobId), [feed]);
  const t = useT();

  if (!job) {
    return (
      <div className="sheet">
        <span className="crop tl" />
        <span className="crop tr" />
        <span className="crop bl" />
        <span className="crop br" />
        <div className="sheet-head">
          <div className="sheet-eyebrow">
            <span>{t("sheet.channel")}</span>
            <span style={{ opacity: 0.4 }}>/</span>
            <span>{t("sheet.noJob")}</span>
          </div>
          <h1 className="sheet-title">{t("sheet.emptyTitle")}</h1>
          <div className="sheet-sub">{t("sheet.emptySub")}</div>
        </div>
        <div className="sheet-body">
          <div className="work feed-work">
            <FeedView
              cards={channel}
              onAction={onFeedAction}
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
          </div>
        </div>
        <div className="titleblock">
          <div className="tb-cell">
            <div className="k">工单</div>
            <div className="v">—</div>
          </div>
          <div className="tb-cell">
            <div className="k">版本</div>
            <div className="v">—</div>
          </div>
          <div className="tb-cell hi">
            <div className="k">阶段</div>
            <div className="v">待受理</div>
          </div>
          <div className="tb-cell">
            <div className="k">成员</div>
            <div className="v">—</div>
          </div>
          <div className="tb-cell">
            <div className="k">提交</div>
            <div className="v">—</div>
          </div>
          <div className="tb-cell">
            <div className="k">验收</div>
            <div className="v">—</div>
          </div>
        </div>
      </div>
    );
  }

  const evidence = job.evidence;
  const jobFeed = useMemo(() => feed.filter((c) => c.jobId === job.id || !c.jobId), [feed, job.id]);

  return (
    <div className="sheet">
      <span className="crop tl" />
      <span className="crop tr" />
      <span className="crop bl" />
      <span className="crop br" />

      <div className="sheet-head">
        <div className="sheet-eyebrow">
          <span>工单 {job.id}</span>
          <span style={{ opacity: 0.4 }}>/</span>
          <span>{job.teamName ?? job.teamId}</span>
          <span style={{ opacity: 0.4 }}>/</span>
          <span>
            {t("sheet.assignedTo", { who: job.member ?? t("sheet.lynn") })} · {job.memberRole ?? t("sheet.roleDispatch")}
          </span>
        </div>
        <h1 className="sheet-title">{job.title}</h1>
        <div className="sheet-sub">
          {t(STATUS_KEY[job.status] ?? "status.todo")} · {t("sheet.evidenceCount", { n: job.evidenceCount })} ·{" "}
          {t("sheet.rejectLimit", { n: job.rejectLimit, used: job.rejections })}
          {job.budget && (
            <>
              {" "}
              · {t("sheet.budgetLabel")}{" "}
              <span className="mono">
                {job.budgetKind === "money"
                  ? `¥${job.budget.used.toFixed(2)} / ¥${job.budget.total.toFixed(2)}`
                  : `${job.budget.used}K / ${job.budget.total}K tokens`}
              </span>
            </>
          )}
        </div>

        <div className="steps">
          {STAGE_KEYS.map((key, i) => {
            const done = i < job.stage;
            const now = i === job.stage;
            return (
              <span key={key} style={{ display: "flex", alignItems: "center" }}>
                <span className={`step${done ? " done" : now ? " now" : ""}`}>
                  <span className="n">{done ? "✓" : i + 1}</span>
                  <span className="l">{t(key)}</span>
                </span>
                {i < STAGE_KEYS.length - 1 && <span className={`step-line${done ? " done" : ""}`} />}
              </span>
            );
          })}
        </div>
      </div>

      <div className="tabs">
        {[
          FEED_TAB,
          ...(job.diff ? [{ k: "diff", labelKey: "sheet.tabDiff", icon: "diff" as IconName }] : []),
          ...(job.artifact ? [{ k: "artifact", labelKey: "sheet.tabArtifact", icon: "table" as IconName }] : []),
        ].map((tabDef) => {
          const count = tabDef.k === "feed" ? jobFeed.length : 0;
          return (
            <button
              type="button"
              key={tabDef.k}
              className={`tab${tab === tabDef.k ? " on" : ""}`}
              onClick={() => setTab(tabDef.k)}
            >
              <Icon name={tabDef.icon} size="sm" /> {t(tabDef.labelKey)}
              {count > 0 && <span className="tag">{count}</span>}
            </button>
          );
        })}
      </div>

      <div className="sheet-body">
        <div className="work feed-work">
          {tab === "feed" && <FeedView cards={jobFeed} onAction={onFeedAction} empty={t("sheet.jobFeedEmpty")} />}
          {tab === "diff" && job.diff && <DiffView diff={job.diff} />}
          {tab === "artifact" && job.artifact && <ArtifactView job={job} />}
        </div>

        <div className="spine">
          <div className="spine-h">
            <span>{t("sheet.evidenceChain")}</span>
            <span className="mono">
              {evidence.filter((e) => e.level !== "pending").length} / {evidence.length}
            </span>
          </div>
          {evidence.length === 0 && <div className="spine-empty">{t("sheet.evidenceEmpty")}</div>}
          {evidence.map((e, i) => (
            <button
              type="button"
              key={i}
              disabled={!e.ref}
              title={e.ref ? `打开 ${e.ref}` : "没有可打开的证据"}
              className={`ev${e.level === "ok" ? " ok" : e.level === "warn" ? " warn" : " pending"}${e.ref ? " openable" : ""}`}
              onClick={() => {
                if (!e.ref) return;
                void window.lynn.rpc("evidence.open", { taskId: job.id, ref: e.ref });
              }}
            >
              <div className="t">{e.title}</div>
              <div className="d prewrap">{e.detail}</div>
            </button>
          ))}
        </div>
      </div>

      <div className="titleblock">
        <div className="tb-cell">
          <div className="k">工单</div>
          <div className="v">{job.id}</div>
        </div>
        <div className="tb-cell">
          <div className="k">版本</div>
          <div className="v">v{job.version}</div>
        </div>
        <div className="tb-cell hi">
          <div className="k">阶段</div>
          <div className="v">{STAGES[job.stage]}</div>
        </div>
        <div className="tb-cell">
          <div className="k">成员</div>
          <div className="v">{job.member ?? "风铃"}</div>
        </div>
        <div className="tb-cell">
          <div className="k">提交</div>
          <div className="v">{fmtTime(job.at)}</div>
        </div>
        <div className={`tb-cell${job.status === "in_review" || job.status === "blocked" ? " sealv" : ""}`}>
          <div className="k">验收</div>
          <div className="v">{job.status === "done" ? "已归档" : job.status === "in_review" ? "待你" : job.statusLabel}</div>
        </div>
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
  onAccept,
  onReject,
  onPlan,
  onAnswer,
}: {
  desk: Desk;
  onAccept: (taskId: string) => void;
  onReject: (taskId: string) => void;
  onPlan: (id: string, action: "start" | "revise" | "reject", text?: string) => void;
  onAnswer: (id: string, text: string) => void;
}) {
  const t = useT();
  const active = desk.members.filter((m) => m.status !== "idle");
  const idle = desk.members.filter((m) => m.status === "idle");
  const decision = desk.decision;
  const reviewJob = desk.jobs.find((j) => j.status === "in_review" || j.status === "blocked");

  return (
    <aside className="right">
      <div className="right-scroll">
        <div className="panel-h">
          <div className="l">
            <span className="t">{t("roster.title")}</span>
            <span className="n">{t("roster.capacity", { n: desk.members.length })}</span>
          </div>
          <span className="cap">{t("roster.split", { a: active.length, b: idle.length })}</span>
        </div>

        {desk.members.length === 0 && (
          <div className="note" style={{ boxShadow: "none" }}>
            <Icon name="users" size="sm" />
            <span>{t("roster.empty")}</span>
          </div>
        )}

        {desk.members.map((m) => (
          <MemberCard key={m.name} m={m} active={!!decision?.jobId && m.jobId === decision.jobId} />
        ))}

        {decision?.kind === "plan" && decision.plan ? (
          <PlanSeal decision={decision} onPlan={onPlan} />
        ) : decision?.kind === "approval" ? (
          <ApprovalSeal decision={decision} onPlan={onPlan} />
        ) : decision ? (
          <QuestionSeal decision={decision} onAnswer={onAnswer} />
        ) : reviewJob ? (
          <AcceptSeal job={reviewJob} onAccept={() => onAccept(reviewJob.id)} onReject={() => onReject(reviewJob.id)} />
        ) : (
          <div className="sealcard-empty">
            <Icon name="shield" size="sm" />
            <div>
              <b>{t("roster.noDecision")}</b>
            </div>
          </div>
        )}
      </div>
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

function SealChecks({ checks }: { checks: { ok: boolean; text: string }[] }) {
  if (checks.length === 0) return null;
  return (
    <div className="accept">
      <div className="k">验收标准</div>
      <ul>
        {checks.map((c, i) => (
          <li key={i} className={c.ok ? "ok" : "bad"}>
            <Icon name={c.ok ? "check" : "warn"} size="sm" />
            <span>{c.text}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** 任务契约：开始 / 改一版 / 先不做 */
function PlanSeal({
  decision,
  onPlan,
}: {
  decision: NonNullable<Desk["decision"]>;
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
  decision: NonNullable<Desk["decision"]>;
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
  decision: NonNullable<Desk["decision"]>;
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

/** 工单交付：验收归档 / 打回（打回走审查台三要素） */
function AcceptSeal({ job, onAccept, onReject }: { job: DeskJob; onAccept: () => void; onReject: () => void }) {
  const t = useT();
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
      <SealChecks checks={job.evidence.filter((e) => e.verified).map((e) => ({ ok: true, text: e.title }))} />
      <div className="seal-actions">
        <button type="button" className="btn btn-accept" onClick={onAccept}>
          <Icon name="check" size="sm" /> {t("seal.accept")}
        </button>
        <button type="button" className="btn btn-reject" onClick={onReject}>
          <Icon name="undo" size="sm" /> {t("seal.rejectRedo")}
        </button>
      </div>
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

function MemberCard({ m, active }: { m: DeskMember; active: boolean }) {
  const t = useT();
  const chip = m.status === "delivered" ? "st-wait" : m.status === "running" || m.status === "stuck" ? "st-live" : "st-idle";
  return (
    <div className={`mcard${active ? " active" : ""}`}>
      <div className="mcard-top">
        <div className={`mcard-avatar${m.status !== "idle" ? " on" : ""}`}>{m.name.slice(0, 1)}</div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="mcard-name">{m.name}</div>
          <div className="mcard-role">
            {m.role} · {m.model}
          </div>
        </div>
        <span className={`st ${chip}`}>
          {m.status === "running" && <span className="pip" />}
          {t(MEMBER_STATUS_KEY[m.status] ?? "memberStatus.idle")}
        </span>
      </div>
      <div className="mcard-job">
        {m.jobId ? `${m.jobId} · ` : ""}
        {m.jobTitle ?? "—"}
      </div>
      <div className="mcard-spec">
        {m.tools.slice(0, 4).map((tool) => (
          <span key={tool} className="chip b">
            {tool}
          </span>
        ))}
        <span className="chip r">{t("member.turnLimit", { n: m.turnLimit ?? "—" })}</span>
      </div>
      <div className="mcard-foot">
        <div className="pbar">
          <i style={{ width: `${Math.max(0, Math.min(100, m.progress))}%` }} />
        </div>
        <span className="mono" style={{ fontSize: 9.5, color: "var(--ink-4)" }}>
          {m.foot}
        </span>
      </div>
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
}) {
  const [draft, setDraft] = useState("");
  const [mode, setMode] = useState<"queue" | "steer">("queue");
  const busy = turn.busy;
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const t = useT();
  // 本轮随附（M1-16）：发送前可见、逐片可裁剪
  const [attFiles, setAttFiles] = useState<string[]>([]);
  const [attImages, setAttImages] = useState<{ name: string; data: string }[]>([]);
  // @ 文件提及补全
  const [mention, setMention] = useState<{ start: number; q: string } | null>(null);
  const [mentionItems, setMentionItems] = useState<{ path: string; size: number }[]>([]);
  const [mentionIdx, setMentionIdx] = useState(0);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const imgSeq = useRef(0);
  const hasAtt = attFiles.length > 0 || attImages.length > 0;
  const canSend = (draft.trim().length > 0 || hasAtt) && configured;

  const detectMention = (value: string, caret: number) => {
    const before = value.slice(0, caret);
    const m = /(^|\s)@([^\s@]{0,80})$/.exec(before);
    if (m && onFileSearch) {
      const q = m[2];
      const start = caret - q.length - 1;
      setMention({ start, q });
      setMentionIdx(0);
      if (searchTimer.current) clearTimeout(searchTimer.current);
      searchTimer.current = setTimeout(() => {
        void onFileSearch(q).then((files) => {
          setMentionItems(files);
        });
      }, 200);
    } else {
      setMention(null);
      setMentionItems([]);
    }
  };

  const pickMention = (p: string) => {
    if (!mention) return;
    // 从草稿里摘掉 @token：文件进随附条，不留在正文里
    setDraft((d) => d.slice(0, mention.start) + d.slice(mention.start + mention.q.length + 1));
    setAttFiles((f) => (f.includes(p) ? f : [...f, p]));
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
      if (pick) pickMention(pick.path);
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
          <div className="mention-pop" role="listbox" aria-label="文件补全">
            {mentionItems.map((f, i) => (
              <button
                type="button"
                key={f.path}
                role="option"
                aria-selected={i === mentionIdx}
                className={`mention-item${i === mentionIdx ? " on" : ""}`}
                onMouseEnter={() => setMentionIdx(i)}
                onClick={() => pickMention(f.path)}
              >
                <span className="p">@{f.path}</span>
                <span className="s">{fmtSize(f.size)}</span>
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
                pickMention(mentionItems[mentionIdx]?.path ?? "");
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
}: {
  desk: Desk;
  job: DeskJob;
  onBack: () => void;
  onApprove: () => void;
  onReject: (reason: { what: string; expect: string; deadline: string }) => void;
}) {
  const r = reviewOf(job);
  const [what, setWhat] = useState(r.reject.what);
  const [expect, setExpect] = useState(r.reject.expect);
  const [deadline, setDeadline] = useState(r.reject.deadline);
  const [sent, setSent] = useState(false);

  const ac = r.ac;
  const canReject = what.trim() !== "" && expect.trim() !== "" && deadline.trim() !== "";

  return (
    <div className="scene">
      <TopRail
        desk={desk}
        current={job}
        permission="ask"
        onPermission={() => {}}
        onOpenSettings={() => {}}
        mode="review"
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
                <span className="st st-wait">待你</span>
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

            <div className="ledger-empty" style={{ marginTop: 8 }}>
              <a onClick={onBack} style={{ color: "var(--blue)", cursor: "pointer" }}>
                ← 返回值台
              </a>
            </div>
          </div>
        </aside>

        <main className="center">
          <div className="sheet-wrap">
            <div className="sheet">
              <span className="crop tl" />
              <span className="crop tr" />
              <span className="crop bl" />
              <span className="crop br" />

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

              <div className="titleblock">
                <div className="tb-cell">
                  <div className="k">验收包</div>
                  <div className="v">{job.id}</div>
                </div>
                <div className="tb-cell">
                  <div className="k">版本</div>
                  <div className="v">v{job.version}</div>
                </div>
                <div className="tb-cell">
                  <div className="k">轮次</div>
                  <div className="v">
                    {Math.min(job.rejections + 1, job.rejectLimit)} / {job.rejectLimit}
                  </div>
                </div>
                <div className="tb-cell">
                  <div className="k">成员</div>
                  <div className="v">{job.member ?? "—"}</div>
                </div>
                <div className="tb-cell">
                  <div className="k">提交</div>
                  <div className="v">{fmtTime(job.at)}</div>
                </div>
                <div className="tb-cell sealv">
                  <div className="k">验收</div>
                  <div className="v">{sent ? "已打回" : "待你"}</div>
                </div>
              </div>
            </div>
          </div>

        </main>

        <aside className="right" style={{ width: 360 }}>
          <div className="right-scroll">
            <div className="panel-h">
              <div className="l">
                <span className="t">你的裁定</span>
                <span className="n">{job.id}</span>
              </div>
              <span className="cap">
                第 {job.rejections + 1} 轮 / 共 {job.rejectLimit} 轮
              </span>
            </div>

            <div className="sealcard" style={{ marginTop: 2 }}>
              <div className="sealcard-h">
                <span className="k">等你拍板</span>
                <span className="mono" style={{ fontSize: 9.5, color: "var(--ink-4)" }}>
                  {job.at ?? ""}
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
                              if (ref) void window.lynn.rpc("evidence.open", { taskId: job.id, ref });
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
                  <span className="mono" style={{ fontSize: 10, color: "var(--ink-3)" }}>
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
  onStandby,
  onNew,
  onUndo,
  onThread,
  onThreadNew,
  onThreadSearch,
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
  onStandby: () => void;
  onNew?: () => void;
  onUndo?: () => void;
  /** 会话线程（M1-14） */
  onThread?: (id: string) => void;
  onThreadNew?: () => void;
  onThreadSearch?: (q: string) => Promise<{ id: string; title: string; hits: string[] }[]>;
  /** 发送/新建失败时的可见提示（不允许静默失败） */
  notice?: string | null;
}) {
  const waitingFirst = useMemo(() => {
    const w = desk.jobs.find((j) => j.status === "in_review" || j.status === "blocked");
    return w ?? desk.jobs[0];
  }, [desk.jobs]);
  const [activeId, setActiveId] = useState<string | undefined>(waitingFirst?.id);
  const [reviewId, setReviewId] = useState<string | null>(null);
  const current = desk.jobs.find((j) => j.id === activeId) ?? waitingFirst;
  const reviewJob = desk.jobs.find((j) => j.id === reviewId);

  if (reviewJob) {
    return (
      <ReviewDesk
        desk={desk}
        job={reviewJob}
        onBack={() => setReviewId(null)}
        onApprove={() => {
          onDecision(reviewJob.id, "approve");
          setReviewId(null);
        }}
        onReject={(reason) => {
          onDecision(reviewJob.id, "reject", reason);
        }}
      />
    );
  }

  return (
    <div className="scene">
      <AmbientLayer params={ambient} mode={ambientMode} standby={false} />
      <TopRail
        desk={desk}
        current={current}
        permission={permission}
        onPermission={onPermission}
        onOpenSettings={onOpenSettings}
        onNew={onNew}
        onUndo={onUndo}
      />
      <div className="body">
        <Ledger
          desk={desk}
          activeId={current?.id}
          onSelect={setActiveId}
          onThread={onThread}
          onThreadNew={onThreadNew}
          onThreadSearch={onThreadSearch}
        />
        <main className="center">
          <div className="sheet-wrap">
            <Sheet job={current} feed={desk.feed} onFeedAction={onFeedAction} onExample={(t) => onSend(t, "queue")} />
          </div>
          <ComposerZone
            configured={configured}
            turn={desk.turn}
            queue={desk.queue}
            onStandby={onStandby}
            onSend={onSend}
            onFileSearch={onFileSearch}
            onAbort={onAbort}
            onQueue={onQueue}
          />
          {notice && <p className="composer-notice">{notice}</p>}
        </main>
        <Roster
          desk={desk}
          onAccept={(id) => onDecision(id, "approve")}
          onReject={(id) => setReviewId(id)}
          onPlan={(id, action, text) => onDecisionResolve(id, action, text)}
          onAnswer={(id, text) => onDecisionResolve(id, "answer", text)}
        />
      </div>
    </div>
  );
}
 