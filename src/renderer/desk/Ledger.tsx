// 左栏（2026-11-14）：从 Desk.tsx 拆出的 Ledger —— 群列表 / 工单台账 / 交付箱。
//
// 它自己持有少量纯视图状态（搜索词、台账分组、重命名输入、右键菜单位置），
// 不碰中栏与右栏的编排状态，所以可以整块搬。
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useT } from "../i18n";
import type { I18nKey } from "../../shared/i18n-strings";
import { Icon } from "../components/Icon";
import { MemberAvatar } from "./MemberAvatar";
import type { TaskStatus } from "../../shared/contract";
import type { JobGroup } from "../../shared/task-groups";
import {
  STATUS_KEY,
  fmtTime,
  statusChipClass,
  type Desk,
  type DeskJob,
  type DeskOutput,
  type OpenPreview,
} from "./model";
import { JobMenu, OutputMenu, ThreadMenu } from "./Menus";
import { groupArchived } from "../../shared/archive-groups";


export function Ledger({
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
  onOpenDeliverable,
  onRevealDeliverable,
  onRemoveDeliverable,
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
  /** 交付物：用系统程序打开 / 在文件管理器里定位 / 从交付箱移除（2026-11-13） */
  onOpenDeliverable?: (taskId: string, ref: string) => void;
  onRevealDeliverable?: (taskId: string, ref: string) => void;
  onRemoveDeliverable?: (taskId: string, ref: string, deleteFile: boolean) => void;
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
  /** 群操作菜单（群列表行尾的 ⋯ 或右键群行都走它） */
  const [threadMenu, setThreadMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  /** 工单卡右键菜单：卡住的单原来只能在台账里干瞪眼 */
  const [menu, setMenu] = useState<{ job: DeskJob; x: number; y: number } | null>(null);
  /** 交付箱行的右键菜单与「查看所属」资料卡（2026-11-13） */
  const [outMenu, setOutMenu] = useState<{ out: DeskOutput; x: number; y: number } | null>(null);
  const [outInfo, setOutInfo] = useState<DeskOutput | null>(null);
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
  /**
   * 交付箱：跨任务汇总「用户要带走的东西」，物理文件不搬家。
   *
   * 2026-11-13 修重复：此前按**任务**平铺，于是「后一张单原地更新了同一个文件」会列成两行
   * （实机：audit-report.md 出现两次，任务号不同）。产出是**文件**不是记录——
   * 按物理路径合并成一条，后更新的那张单上位，并标出被更新过几次。
   */
  const outputs = useMemo<DeskOutput[]>(() => {
    /**
     * 去重键必须是**解析后的绝对路径**：`d.path` 存的是成员交上来的原始串，
     * 有时是相对工作区的 "audit-report.md"，有时是绝对路径——直接拿字符串比会漏合并。
     * 同目录同名 = 同一个文件（用户 2026-11-13 确认的口径）。
     */
    const resolvePath = (workspaceRoot: string | undefined, p: string): string => {
      const isAbs = /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith("/") || p.startsWith("\\\\");
      const base = (workspaceRoot ?? "").replace(/[\\/]+$/, "");
      return isAbs || !base ? p : `${base}/${p.replace(/^[\\/]+/, "")}`;
    };
    const byPath = new Map<string, DeskOutput>();
    for (const j of desk.jobs) {
      for (const d of j.deliverables ?? []) {
        const path = d.path || d.ref;
        if (!path) continue;
        const abs = resolvePath(j.workspaceRoot, path);
        const key = abs.replace(/\\/g, "/").replace(/\/{2,}/g, "/").toLowerCase();
        // 固化时刻优先（同一文件被两张单更新过时，它才知道谁更晚）
        const stamp = d.at ?? j.at;
        const hit = byPath.get(key);
        if (!hit) {
          byPath.set(key, { path, abs, ref: d.ref, bytes: d.bytes, job: j, jobs: 1, updatedAt: stamp });
          continue;
        }
        hit.jobs += 1;
        // 后写入的那张单上位：它的 ref/大小才是文件现在的样子
        if ((stamp ?? "") >= (hit.updatedAt ?? "")) {
          hit.job = j;
          hit.abs = abs;
          hit.ref = d.ref;
          hit.bytes = d.bytes ?? hit.bytes;
          hit.updatedAt = stamp;
        }
      }
    }
    return [...byPath.values()].sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  }, [desk.jobs]);
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
                          onContextMenu={(e) => {
                            e.preventDefault();
                            setThreadMenu({ id: th.id, x: e.clientX, y: e.clientY });
                          }}
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
                            {th.projectName && (
                              <span className="thread-proj" title={t("thread.projectHint", { name: th.projectName })}>
                                <Icon name="folder" size="sm" /> {th.projectName}
                              </span>
                            )}
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
                            className="thread-act thread-more"
                            title="群操作"
                            aria-haspopup="menu"
                            onClick={(e) => {
                              const r = e.currentTarget.getBoundingClientRect();
                              setThreadMenu({ id: th.id, x: r.left, y: r.bottom });
                            }}
                          >
                            ⋯
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
      {threadMenu &&
        (() => {
          const th = desk.threads.find((x) => x.id === threadMenu.id);
          if (!th) return null;
          return (
            <ThreadMenu
              title={th.title || t("ledger.untitled")}
              pinned={th.pinned}
              x={threadMenu.x}
              y={threadMenu.y}
              onClose={() => setThreadMenu(null)}
              onPin={(p) => onThreadPin?.(th.id, p)}
              onRename={() => {
                setDeleting(null);
                setRenaming({ id: th.id, title: th.title });
              }}
              onDelete={() => {
                setRenaming(null);
                setDeleting(th.id);
              }}
            />
          );
        })()}
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
      {outMenu && (
        <OutputMenu
          out={outMenu.out}
          x={outMenu.x}
          y={outMenu.y}
          onClose={() => setOutMenu(null)}
          onOpen={() => {
            onOpenDeliverable?.(outMenu.out.job.id, outMenu.out.ref);
            setOutMenu(null);
          }}
          onReveal={() => {
            onRevealDeliverable?.(outMenu.out.job.id, outMenu.out.ref);
            setOutMenu(null);
          }}
          onInfo={() => {
            setOutInfo(outMenu.out);
            setOutMenu(null);
          }}
          onRemove={(deleteFile) => {
            onRemoveDeliverable?.(outMenu.out.job.id, outMenu.out.ref, deleteFile);
            setOutMenu(null);
          }}
        />
      )}
      {outInfo && <OutputInfo out={outInfo} onClose={() => setOutInfo(null)} />}

      {view === "outputs" && (
        <div className="ledger-scroll">
          {outputs.length === 0 && (
            <div className="ledger-empty">
              <span>还没有交付物。成员回报时会单独列出「要给你带走的东西」，验收后永久保留。</span>
            </div>
          )}
          {outputs.map((o) => {
            const openable = openableRef(o.ref);
            const name = o.abs.split(/[\\/]/).filter(Boolean).pop() ?? o.path;
            return (
              <button
                type="button"
                key={o.abs}
                className="thread-row out-row"
                disabled={!openable}
                title={
                  `${o.abs}\n这是「${o.job.title}」的产出` +
                  (o.jobs > 1 ? `（后续任务原地更新过，共 ${o.jobs} 次）` : "") +
                  `${o.bytes ? `\n${fmtB(o.bytes)}` : ""}${openable ? "\n点击内置预览" : "\n（外部路径，去原位置查看）"}`
                }
                onClick={() => {
                  if (openable) onPreview?.(o.job.id, o.ref);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setOutMenu({ out: o, x: e.clientX, y: e.clientY });
                }}
              >
                {/* 第一行只放文件名：此前 <b> 不截断，长名字被挤成 "audit-" / "report.md" 两行 */}
                <b title={o.abs}>{name}</b>
                {/* 第二行回答"这是什么"：出自哪张单（标题占满一行，时间移到第三行，
                    否则长标题会把时间挤成省略号，两个都读不出来） */}
                <small title={o.job.title}>{o.job.title}</small>
                <small className="mono out-meta">
                  {[
                    o.jobs > 1 ? `更新 ${o.jobs} 次` : "",
                    o.updatedAt ? fmtTime(o.updatedAt) : "",
                    o.bytes ? fmtB(o.bytes) : "",
                  ]
                    .filter(Boolean)
                    .join(" · ")}
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

export function JobRow({
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

/** 归档带默认只露最近 5 条：历史列表不占满整条左栏，其余走「查看全部」 */
const ARCHIVE_PREVIEW = 5;

/** 台账分组（数组顺序即渲染顺序）；空组直接不渲染，不留占位假条目 */
const GROUP_META: { k: Exclude<JobGroup, "archived">; labelKey: I18nKey; color: string; stoppable: boolean }[] = [
  { k: "waiting", labelKey: "ledger.awaiting", color: "var(--seal)", stoppable: false },
  { k: "stuck", labelKey: "ledger.stuck", color: "var(--brass)", stoppable: true },
  { k: "running", labelKey: "ledger.running", color: "var(--blue)", stoppable: true },
  { k: "queued", labelKey: "ledger.queued", color: "var(--ink-4)", stoppable: false },
];

/**
 * 「查看所属」资料卡（2026-11-13）：这个文件是谁、为了什么、什么时候产出的。
 * 内容全是权威工单里的事实，不推测。
 */
function OutputInfo({ out, onClose }: { out: DeskOutput; onClose: () => void }) {
  const t = useT();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const name = out.abs.split(/[\\/]/).filter(Boolean).pop() ?? out.path;
  const rows: { k: string; v: string }[] = [
    { k: "项目", v: out.job.projectName || "（旧单没有记录项目）" },
    { k: "目标", v: out.job.title },
    {
      k: "产出者",
      v: out.job.member ? `${out.job.member}${out.job.memberRole ? ` · ${out.job.memberRole}` : ""}` : "—",
    },
    { k: "最后更新", v: fmtTime(out.updatedAt) },
    {
      k: "大小",
      v:
        out.bytes == null
          ? "—"
          : out.bytes < 1024
            ? `${out.bytes} B`
            : out.bytes < 1048576
              ? `${(out.bytes / 1024).toFixed(1)} KB`
              : `${(out.bytes / 1048576).toFixed(1)} MB`,
    },
    {
      k: "产出次数",
      v: out.jobs > 1 ? `${out.jobs} 次（后一轮在原文件上更新）` : "1 次",
    },
    { k: "工单", v: `${out.job.id}${out.job.teamName ? ` · ${out.job.teamName}` : ""}` },
    { k: "文件名", v: name },
  ];
  return createPortal(
    <div className="mdetail-overlay" onClick={onClose} role="presentation">
      <div className="mdetail-card" role="dialog" aria-label="交付物所属" onClick={(e) => e.stopPropagation()}>
        <header className="mdetail-hd">
          <Icon name="pkg" size="sm" />
          <div className="mdetail-id">
            <b>{name}</b>
            <span className="mdetail-role">{out.job.projectName || "未关联项目"}</span>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label={t("common.close")}>
            <Icon name="x" size="sm" />
          </button>
        </header>
        <div className="mdetail-body">
          <section className="mdetail-sec">
            <h4 className="mdetail-sec-h">它是谁产出的</h4>
            <dl className="mdetail-dl">
              {rows.map((r) => (
                <div className="mdetail-row" key={r.k}>
                  <dt>{r.k}</dt>
                  <dd>{r.v}</dd>
                </div>
              ))}
            </dl>
          </section>
          <section className="mdetail-sec">
            <h4 className="mdetail-sec-h">磁盘上的位置</h4>
            <dl className="mdetail-dl">
              <div className="mdetail-row">
                <dt>路径</dt>
                <dd className="mono">{out.abs}</dd>
              </div>
            </dl>
          </section>
        </div>
      </div>
    </div>,
    document.body,
  );
}
