// 右栏（2026-11-14）：Roster（编制/印章区）+ MemberCard + MemberDetail + GroupNotice。
//
// 依凭：只有 3 个数据 props（desk / current / open）+ 13 个回调，没有与中栏双向绑定的可变状态，
// 所以可以整块搬。跨区状态（右键菜单位置、时钟）仍留在 DeskView，通过回调进出。
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useT } from "../i18n";
import { Icon } from "../components/Icon";
import { MemberAvatar } from "./MemberAvatar";
import { ApprovalSeal, AcceptSeal, BlockedSeal, PlanSeal, QuestionSeal } from "./Seals";
import { MemberMenu } from "./Menus";
import type { Desk, DeskJob, DeskMember } from "./model";
import { cacheHitRate } from "../../shared/contract";

export function Roster({
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
  onAnnounce,
  onDraftNotice,
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
  onPlan: (id: string, action: "start" | "revise" | "reject", text?: string, always?: boolean) => void;
  onAnswer: (id: string, text: string) => void;
  /** 建团队：这里只要名字，ID 由系统生成（§4.10.3 修正） */
  onCreateTeam?: (name: string) => void;
  /** 手动管理编制：改岗位 / 移出成员 / 解散团队 */
  onManageTeam?: () => void;
  /** @某人：把名字插进输入框（群聊模式） */
  onAt?: (name: string) => void;
  /** 写群公告（全局段）：保存后风铃下一轮就看得见 */
  onAnnounce?: (text: string) => void;
  /** 请风铃起草群公告（用户不该只能自己写） */
  onDraftNotice?: () => void;
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
  // 只有 in_review 可验收；blocked 只给"停掉/继续"，绝不出现"验收归档"。
  // 用户从台账主动点开别群的单时才跟着走（印章头带回程入口）；自动兜底只挑本群的单，
  // 否则新建群会莫名其妙冒出别群的验收/卡住印章（2026-11-15）。
  const sealJob =
    current && current.action !== "none"
      ? current
      : desk.jobs.find((j) => j.action !== "none" && (!j.threadId || j.threadId === desk.thread.id));
  // C3：印章头要报"这张单来自哪个会话"——跨会话时给回程入口，同会话不啰嗦
  const sealSource =
    sealJob?.threadId && sealJob.threadId !== desk.thread.id
      ? { id: sealJob.threadId, title: desk.threads.find((x) => x.id === sealJob.threadId)?.title }
      : null;
  const [naming, setNaming] = useState(false);
  const [teamName, setTeamName] = useState("");
  /** 编制规模上来之后先收敛：按状态筛人、团队卡可折叠、同岗位空闲成员聚合 */
  const [rosterFilter, setRosterFilter] = useState<"all" | "running" | "review" | "stuck" | "idle">("all");
  const [openRoles, setOpenRoles] = useState<Set<string>>(new Set());
  /**
   * 群聊模式（2026-11-12）：本群的队置顶展开，别群折叠在下面。
   * 一个群 = 一支班底——右栏第一眼要看到"这个群里有哪些人在干活"。
   */
  const [teamOpenOverride, setTeamOpenOverride] = useState<Record<string, boolean>>({});
  const [memberMenu, setMemberMenu] = useState<{ member: DeskMember; x: number; y: number } | null>(null);
  const [detail, setDetail] = useState<MemberDetailState | null>(null);
  const [rosterNote, setRosterNote] = useState<string | null>(null);
  /** 群公告起草中（风铃写好了就停） */
  const [draftingNotice, setDraftingNotice] = useState(false);
  const noticeText = desk.threads.find((x) => x.id === desk.thread.id)?.announcement;
  useEffect(() => {
    // 公告内容变了 = 起草完成
    if (noticeText) setDraftingNotice(false);
  }, [noticeText]);
  /** 编制全景：按群分家（2026-11-12）。
   *  队→群的绑定内核一直有（TeamRecord.threadId），此前没暴露给渲染层，
   *  十几支队只能平铺成一列——看不出哪支队是谁的，也跳不过去。 */
  const teamIndex = useMemo(() => {
    const map = new Map<string, RosterGroup>();
    for (const m of desk.members) {
      const g =
        map.get(m.teamId) ??
        ({
          teamName: m.teamName ?? m.teamId,
          threadId: m.teamThreadId,
          active: desk.jobs.filter((j) => j.teamId === m.teamId && j.status !== "done" && j.status !== "canceled").length,
          running: 0,
          review: 0,
          idle: 0,
          stuck: 0,
          members: [],
        } as RosterGroup);
      g.members.push(m);
      if (m.status === "running") g.running += 1;
      else if (m.status === "delivered") g.review += 1;
      else if (m.status === "stuck") g.stuck += 1;
      else g.idle += 1;
      map.set(m.teamId, g);
    }
    return map;
  }, [desk.members, desk.jobs]);
  /** 本群的队：**显式绑定优先**；没绑定的老队才用「本群有单」兜底推。
   *  2026-11-12：此前两者并集——一支明确绑给 A 群、却在 B 群有一张单的队，
   *  会在 B 群也显示成"本群"，用户看着像两处都归它。 */
  const groupTeamIds = useMemo(() => {
    const s = new Set<string>();
    for (const [id, g] of teamIndex) {
      if (g.threadId) {
        if (g.threadId === desk.thread.id) s.add(id);
        continue; // 已绑别的群：不再被单据牵回来
      }
    }
    for (const j of desk.jobs) {
      if (j.threadId === desk.thread.id && j.teamId && !teamIndex.get(j.teamId)?.threadId) s.add(j.teamId);
    }
    return s;
  }, [desk.jobs, desk.thread.id, teamIndex]);
  const isTeamOpen = (teamId: string) => teamOpenOverride[teamId] ?? groupTeamIds.has(teamId);
  /**
   * 右栏只显示**本群**的编制（2026-11-13 用户拍板）：
   * 一个群 = 一件事，别的群的人出现在这里只会添乱；全部编制在「设置 → 团队」里看。
   */
  const rosterMembers = useMemo(() => desk.members.filter((m) => groupTeamIds.has(m.teamId)), [desk.members, groupTeamIds]);
  /** 状态计数：筛选 chip 上写清楚点下去还剩几个，免得点了才知道 */
  const statusCounts = useMemo(() => {
    const c = { all: rosterMembers.length, running: 0, review: 0, stuck: 0, idle: 0 };
    for (const m of rosterMembers) {
      if (m.status === "running") c.running += 1;
      else if (m.status === "delivered") c.review += 1;
      else if (m.status === "stuck") c.stuck += 1;
      else c.idle += 1;
    }
    return c;
  }, [rosterMembers]);
  const visibleMembers = useMemo(() => {
    if (rosterFilter === "all") return rosterMembers;
    const want =
      rosterFilter === "running" ? "running" : rosterFilter === "review" ? "delivered" : rosterFilter === "stuck" ? "stuck" : "idle";
    return rosterMembers.filter((m) => m.status === want);
  }, [rosterMembers, rosterFilter]);
  /** 筛选后的编制（队本身保留；队里没人匹配就不画这支队） */
  const memberGroups = useMemo(() => {
    const map = new Map<string, RosterGroup>();
    for (const m of visibleMembers) {
      const src = teamIndex.get(m.teamId);
      if (!src) continue;
      const g = map.get(m.teamId) ?? { ...src, members: [] };
      g.members.push(m);
      map.set(m.teamId, g);
    }
    return map;
  }, [visibleMembers, teamIndex]);
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
        {/* 群公告是"这个群"的事：没有当前群时不渲染（2026-11-12）——
            空场里摆一个"还没写群公告"的编辑器，写进去也没有群可写。 */}
        {onAnnounce && desk.thread.id && (
          <GroupNotice
            text={desk.threads.find((x) => x.id === desk.thread.id)?.announcement}
            onSave={(text) => onAnnounce(text)}
            onDraft={onDraftNotice ? () => { setDraftingNotice(true); onDraftNotice(); } : undefined}
            drafting={draftingNotice}
          />
        )}
        {/* 没有会话时不装懂：右栏如实说这是"可复用的编制"，不是一个群的人 */}
        {!desk.thread.id && (
          <p className="roster-note roster-note-quiet">{t("roster.noSessionHint")}</p>
        )}
        {rosterNote && (
          <p className="roster-note" onClick={() => setRosterNote(null)}>
            {rosterNote}
          </p>
        )}

        {/* 印章排在最前：它是"该你拍板"的唯一落点，不能藏在成员卡下面要滚动才看见。
            2026-11-12：原先它排在编制标题之后（注释说"最前"但代码没做到），
            现在真放到编制区之前：有活要先看见活，再看人。 */}
        <div className="seal-slot">
          {/* 「来自会话 X · 切过去」不再单独占一行（2026-11-13）：并进分页头那一行，
              没活要拍板时整块连头带身体都不出现。 */}
          {(sealSource || decisions.length > 1) && (
            <div className="seal-pager">
              {decisions.length > 1 && (
                <span className="chip">{t("seal.pendingCount", { i: dPos + 1, n: decisions.length })}</span>
              )}
              {sealSource && (
                <button
                  type="button"
                  className="strip-link seal-origin"
                  title={t("sheet.fromThreadShort")}
                  onClick={() => onThread?.(sealSource.id)}
                >
                  {t("seal.fromOtherGroup", { name: sealSource.title ?? sealSource.id })}
                </button>
              )}
              {decisions.length > 1 && (
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={t("seal.nextDecision")}
                  title={t("seal.nextDecision")}
                  onClick={() => setDIdx((dPos + 1) % decisions.length)}
                >
                  ›
                </button>
              )}
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
            /* 没活要拍板就什么都不画（2026-11-13）：连"暂无待你拍板"这一行也是噪音——
               编制标题紧接着就说明下面是什么，不需要先声明"这里现在没东西"。 */
            null
          )}
        </div>

        <div className="panel-h">
          <div className="l">
            <span className="t">{t("roster.title")}</span>
            <span className="n">{t("roster.count2", { n: rosterMembers.length, m: new Set(rosterMembers.map((m) => m.teamId)).size })}</span>
          </div>
          {/* 模块标题右侧的动作（2026-11-13）：新建/管理收成图标按钮，
              不再孤零零吊在筛选条下面——图标按钮没有文字，靠 title 说明是什么。 */}
          <div className="panel-h-acts">
            {onCreateTeam && (
              <button
                type="button"
                className="icon-btn icon-btn-quiet"
                onClick={() => setNaming(true)}
                title={t("roster.new")}
                aria-label={t("roster.new")}
              >
                <Icon name="users" size="sm" />
              </button>
            )}
            {onManageTeam && (
              <button
                type="button"
                className="icon-btn icon-btn-quiet"
                onClick={onManageTeam}
                title={t("team.manage")}
                aria-label={t("team.manage")}
              >
                <Icon name="pen" size="sm" />
              </button>
            )}
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
        </div>

        {/* 规模上来先按状态收敛：26 人平铺时，找「在跑 / 待审」比翻名单快。
            chip 上带计数：点了才知道会剩几个，别靠"筛完才发现是空的"。 */}
        {/* 筛选条只在"真有得筛"时出现（2026-11-13）：空档不再占一个淡化 chip，
            只剩"全部"一个时整行都不画——那种情况下它等于把标题的人数又说一遍。 */}
        {(() => {
          const chips = (
            [
              ["all", "全部", statusCounts.all],
              ["running", "在跑", statusCounts.running],
              ["review", "待审", statusCounts.review],
              ["stuck", "卡住", statusCounts.stuck],
              ["idle", "空闲", statusCounts.idle],
            ] as const
          ).filter(([k, , n]) => k === "all" || n > 0);
          // 只剩一个状态档（全在跑 / 全空闲）时，筛它等于没筛 → 整行不画
          if (chips.filter(([k]) => k !== "all").length <= 1) return null;
          return (
            <div className="roster-filter" role="tablist" aria-label="编制筛选">
              {chips.map(([k, label, n]) => (
                <button
                  key={k}
                  type="button"
                  role="tab"
                  aria-selected={rosterFilter === k}
                  className={`rf-chip${rosterFilter === k ? " on" : ""}`}
                  onClick={() => setRosterFilter(k)}
                  title={`${label} ${n} 人`}
                >
                  {label}
                  <span className="n">{n}</span>
                </button>
              ))}
            </div>
          );
        })()}

        {/* 消耗看板（2026-11-13）：风铃的上下文与缓存命中率 + 本群成员的 token 消耗。
            只在真有读数时出现——没人跑过活就一行都不画，不摆空表格。 */}
        {(() => {
          const u = desk.usage;
          const rawHit = cacheHitRate(u);
          const lynnHit = rawHit === undefined ? undefined : Math.round(rawHit * 1000) / 10;
          // 计费 token（不含缓存写）；上下文占比单独成一行
          const lynnTokens = u.sessionIn + u.sessionOut;
          const lynnTokensK = lynnTokens / 1000;
          const ctxPct = u.contextPercent;
          const members = rosterMembers.filter((m) => (m.budgetUsed ?? 0) > 0 || m.hitRate !== undefined);
          if (lynnTokens <= 0 && lynnHit === undefined && members.length === 0) return null;
          const fmtK = (k: number) => `${Math.round(k * 10) / 10}`;
          const tokenMax = Math.max(lynnTokensK, ...members.map((m) => m.budgetUsed ?? 0), 0.001);
          const barW = (k: number) => `${Math.max(2, Math.round((k / tokenMax) * 100))}%`;
          return (
            <div className="usage-board" aria-label={t("board.cap")}>
              {/* 模块一：Token 消耗（风铃指挥 + 各成员，带占比条） */}
              <div className="ub-mod">
                <div className="ub-mod-cap">{t("board.token")}</div>
                {lynnTokens > 0 && (
                  <div
                    className="ub-row lynn"
                    title={`${t("board.ctx")} ${fmtK(lynnTokensK)}K / ${Math.round(u.contextWindow / 1000)}K`}
                  >
                    <span className="ub-name">
                      <span className="ub-tag">{t("board.lead")}</span>
                      {t("board.lynn")}
                    </span>
                    <span className="ub-bar">
                      <i style={{ width: barW(lynnTokensK) }} />
                    </span>
                    <span className="ub-val">
                      {fmtK(lynnTokensK)}
                      <i className="u">K</i>
                    </span>
                  </div>
                )}
                {ctxPct != null && ctxPct > 0 && lynnTokens > 0 && (
                  <div className="ub-sub">
                    {t("board.ctx")} {Math.round(ctxPct)}%
                  </div>
                )}
                {members
                  .filter((m) => (m.budgetUsed ?? 0) > 0)
                  .map((m) => (
                    <div className="ub-row" key={`${m.teamId}::${m.name}`} title={m.role}>
                      <span className="ub-name">
                        {m.name}
                        {m.acceptor && <span className="ub-tag accept">{t("roster.acceptor")}</span>}
                      </span>
                      <span className="ub-bar">
                        <i style={{ width: barW(m.budgetUsed ?? 0) }} />
                      </span>
                      <span className="ub-val">
                        {fmtK(m.budgetUsed ?? 0)}
                        <i className="u">K</i>
                      </span>
                    </div>
                  ))}
              </div>
              {/* 模块二：缓存命中（风铃指挥 + 各成员） */}
              <div className="ub-mod">
                <div className="ub-mod-cap">{t("board.cache")}</div>
                {lynnHit !== undefined && (
                  <div className="ub-row lynn">
                    <span className="ub-name">
                      <span className="ub-tag">{t("board.lead")}</span>
                      {t("board.lynn")}
                    </span>
                    <span className="ub-bar cache">
                      <i style={{ width: `${lynnHit}%` }} />
                    </span>
                    <span className="ub-val">
                      {typeof lynnHit === "number" ? (
                        <>
                          {lynnHit}
                          <i className="u">%</i>
                        </>
                      ) : (
                        "—"
                      )}
                    </span>
                  </div>
                )}
                {members
                  .filter((m) => m.hitRate !== undefined)
                  .map((m) => (
                    <div className="ub-row" key={`${m.teamId}::${m.name}`} title={m.role}>
                      <span className="ub-name">
                        {m.name}
                        {m.acceptor && <span className="ub-tag accept">{t("roster.acceptor")}</span>}
                      </span>
                      <span className="ub-bar cache">
                        <i style={{ width: `${m.hitRate}%` }} />
                      </span>
                      <span className="ub-val">
                        {typeof m.hitRate === "number" ? (
                          <>
                            {m.hitRate}
                            <i className="u">%</i>
                          </>
                        ) : (
                          "—"
                        )}
                      </span>
                    </div>
                  ))}
              </div>
            </div>
          );
        })()}

        {/* 建团队：给名字就行，ID 由系统生成——不让用户在面板里找 ID。
            入口已收进模块标题右侧的图标按钮（2026-11-13），这里只在命名时出现输入行。 */}
        {onCreateTeam && naming && (
          <div className="roster-actions">
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
            <button
              type="button"
              className="ghost-btn"
              onClick={() => {
                setNaming(false);
                setTeamName("");
              }}
            >
              {t("common.cancel")}
            </button>
          </div>
        )}

        {/* 右栏只画**本群**的编制（2026-11-13 用户拍板）：一个群 = 一件事，
            别群的队不在这里出现——全部编制在「设置 → 团队」里看（标题右侧的 ✎ 就是入口）。 */}
        {memberGroups.size === 0 && (
          <div className="note" style={{ boxShadow: "none" }}>
            <Icon name="users" size="sm" />
            <span>{t("roster.emptyGroup")}</span>
          </div>
        )}
        {[...memberGroups.entries()].map(([id, g]) => renderTeamGroup(id, g))}
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

/**
 * 成员小卡：只讲三件事——哪张脸、叫什么、手上什么活。
 * 角色 / 模型 / 工具白名单 / 步数预算 / 状态文字都不在这里重复：
 * 岗位档案归设置页，边界读数归工单帐本，右栏只负责一眼看清编制。
 * 在跑与否由头像底色深浅表达（MemberAvatar 的 active），不另占一行。
 */
export function MemberCard({
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
      {/* 在跑的人要“看得出在动”（2026-11-13）：头像外一圈雷达扩散环 + 卡底真实进度线。
          静态截图里它是一圈蓝环，动起来才是“她此刻正在干活”。 */}
      <span className="mcard-face">
        <MemberAvatar name={m.name} avatarId={m.avatarId} size={36} />
        {m.status === "running" && <i className="mcard-ping" aria-hidden />}
      </span>
      <div className="mcard-txt">
        <div className="mcard-name">
          {m.name}
          {m.acceptor && <span className="mcard-badge acceptor">{t("roster.acceptor")}</span>}
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
      {/* 卡底真实进度：有百分比就按比例，刚开工（0%）用来回扫描表示“还没到第一步” */}
      {m.status === "running" && (
        <span className={`mcard-prog${m.progress > 0 ? "" : " indet"}`} aria-hidden>
          <i style={m.progress > 0 ? { width: `${Math.min(100, Math.max(0, m.progress))}%` } : undefined} />
        </span>
      )}
    </div>
  );
}

/**
 * 成员资料卡（群聊模式：右键成员 → 弹出卡片）。
 * 分层：他是谁 / 他能干什么 / 战绩 / 手上的活——一层一件事，别糊成一张表。
 * 用 portal 挂到 body：右栏窄屏态是 transform 定位的，fixed 会被它当包含块裁掉。
 */
export function MemberDetail({ data, onClose }: { data: MemberDetailState; onClose: () => void }) {
  const t = useT();
  const m = data.member;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const profile = data.kind === "profile" ? data.profile : undefined;
  const detail = data.kind === "job" ? data.detail : undefined;
  const record = data.kind === "profile" ? data.record : undefined;
  const job = data.kind === "profile" ? data.job : undefined;

  const sections: { title: string; rows: { k: string; v: string }[] }[] = [];
  if (profile) {
    sections.push({
      title: "他是谁",
      rows: [
        { k: "目标", v: profile.goal || "（未写）" },
        { k: "边界", v: profile.boundaries.join("、") || "（未写）" },
        ...(profile.body ? [{ k: "做事方式", v: profile.body }] : []),
      ],
    });
    sections.push({
      title: "他能干什么",
      rows: [
        { k: "工具", v: profile.tools.join("、") || "（无）" },
        {
          k: "上限",
          v: `${profile.limits.maxTurns} 轮 · ${profile.limits.budgetTokens} tok · ${profile.limits.wallClockMin} 分`,
        },
        { k: "交付物", v: profile.outputContract.deliverable || "（未写）" },
        { k: "何时升级", v: profile.escalateWhen || "（未写）" },
      ],
    });
  }
  if (detail) {
    sections.push({
      title: "手上的活",
      rows: [
        { k: "单", v: `${detail.id} · ${detail.title}` },
        ...(detail.goal ? [{ k: "目标", v: detail.goal }] : []),
        { k: "完成标准", v: detail.acceptance.join("；") || "（未写）" },
        { k: "状态", v: `${detail.status}${detail.statusNote ? ` · ${detail.statusNote}` : ""}` },
        ...(detail.workspaceRoot ? [{ k: "工作区", v: detail.workspaceRoot }] : []),
        ...(detail.deliverables.length ? [{ k: "产物", v: detail.deliverables.map((d) => d.label).join("、") }] : []),
        ...(detail.timeline.length
          ? [{ k: "最近", v: detail.timeline.slice(-3).reverse().map((e) => e.text).join(" / ") }]
          : []),
      ],
    });
  }
  if (job && data.kind === "profile") {
    sections.push({ title: "手上的活", rows: [{ k: "单", v: `${job.id} · ${job.title}` }] });
  }
  if (record) {
    sections.push({
      title: "战绩",
      rows: [
        {
          k: "统计",
          v: `参与 ${record.tasks} · 通过 ${record.accepted} · 打回 ${record.rejected} · 升级 ${record.escalations}`,
        },
      ],
    });
  }

  return createPortal(
    <div className="mdetail-overlay" onClick={onClose} role="presentation">
      <div className="mdetail-card" role="dialog" aria-label={`${m.name} 的资料`} onClick={(e) => e.stopPropagation()}>
        <header className="mdetail-hd">
          <MemberAvatar name={m.name} avatarId={m.avatarId} size={40} />
          <div className="mdetail-id">
            <b>{m.name}</b>
            {/* 名字与岗位一样时不必重复（实测截图里两行一模一样） */}
            {m.role !== m.name && <span className="mdetail-role">{m.role}</span>}
          </div>
          <span className="mdetail-state" data-state={m.status}>
            <Icon
              name={m.status === "running" ? "play" : m.status === "delivered" ? "check" : m.status === "idle" ? "clock" : "bell"}
              size="sm"
            />
            {m.statusLabel}
          </span>
          <button type="button" className="icon-btn" onClick={onClose} aria-label={t("common.close")}>
            <Icon name="x" size="sm" />
          </button>
        </header>
        <div className="mdetail-body">
          {sections.length === 0 && <p className="mdetail-empty">没读到这份资料。</p>}
          {sections.map((sec) => (
            <section className="mdetail-sec" key={sec.title}>
              <h4 className="mdetail-sec-h">{sec.title}</h4>
              <dl className="mdetail-dl">
                {sec.rows.map((r) => (
                  <div className="mdetail-row" key={r.k}>
                    <dt>{r.k}</dt>
                    <dd>{r.v}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * 群公告 = 这个群的全局段（整体干什么 / 谁管哪段 / 接缝在哪 / 共享写入点归谁）。
 * leader 那句「接缝没人接是头号事故」——所以接缝得是群级可见、能改的事实。
 */
export function GroupNotice({
  text,
  onSave,
  onDraft,
  drafting,
}: {
  text?: string;
  onSave: (t: string) => void;
  /** 让风铃起草（用户不该只能自己写） */
  onDraft?: () => void;
  drafting?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [collapsed, setCollapsed] = useState(true);
  const [draft, setDraft] = useState(text ?? "");
  useEffect(() => {
    setDraft(text ?? "");
    // 公告内容变了（风铃起草完成 / 别人改了）= 重新折叠，别让长公告一直顶着
    setCollapsed(true);
  }, [text]);
  return (
    <div className="gnotice">
      <div className="gnotice-h">
        <span className="k">群公告</span>
        <span className="gnotice-btns">
          {onDraft && (
            <button type="button" className="gnotice-toggle" onClick={onDraft} disabled={drafting}>
              {drafting ? "起草中…" : "让风铃起草"}
            </button>
          )}
          <button type="button" className="gnotice-toggle" onClick={() => setEditing((v) => !v)}>
            {editing ? "收起" : text ? "改" : "我自己写"}
          </button>
        </span>
      </div>
      {editing ? (
        <>
          <textarea
            className="gnotice-in"
            value={draft}
            placeholder="整体干什么 · 谁管哪段 · 接缝在哪 · 共享写入点归谁"
            onChange={(e) => setDraft(e.target.value)}
          />
          <div className="gnotice-acts">
            <button type="button" className="ghost-btn" onClick={() => setEditing(false)}>
              取消
            </button>
            <button
              type="button"
              className="ghost-btn"
              onClick={() => {
                onSave(draft);
                setEditing(false);
              }}
            >
              保存
            </button>
          </div>
        </>
      ) : (
        (() => {
          const long = !!text && text.length > 120;
          return (
            <>
              <p className={`gnotice-t${collapsed && long ? " clamp" : ""}`}>
                {text ||
                  "还没写：这个群整体干什么、谁管哪段、接缝在哪——让风铃起草一版，或者你自己写一句（它每轮都看得见，会照着它分工）。"}
              </p>
              {long && (
                <button
                  type="button"
                  className="gnotice-toggle gnotice-more"
                  onClick={() => setCollapsed((v) => !v)}
                >
                  {collapsed ? "展开" : "收起"}
                </button>
              )}
            </>
          );
        })()
      )}
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
  /** 这支队属于哪个群（2026-11-12）：右栏按群分家，组头可跳转 */
  threadId?: string;
  active: number;
  running: number;
  review: number;
  idle: number;
  /** 卡住的人（2026-11-12：此前没有入口能筛到他们） */
  stuck: number;
  members: DeskMember[];
}
