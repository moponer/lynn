import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type CaptureShot, type FeedCard, type PermissionMode } from "../../shared/contract";
import { jobsInThread, type Desk, type OpenPreview } from "./model";

import { AmbientLayer } from "./AmbientLayer";
import type { AmbientMode, AmbientParams } from "../../shared/ambient";
import { PreviewDrawer } from "../components/PreviewDrawer";
import { RefMenu } from "./Menus";
import { Ledger } from "./Ledger";
import { Roster } from "./Roster";
import { Sheet } from "./Sheet";
import { ComposerZone } from "./Composer";
import { ReviewDesk } from "./Review";
import { TopRail } from "./TopRail";
import { CommandPalette, KeymapOverlay } from "./Palette";

// ============================ LEDGER ============================

// ============================ SHEET ============================

// ============================ ROSTER + SEAL ============================


// ============================ COMPOSER ============================

// ============================ REVIEW DESK（场景 2） ============================

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
  onRenameProject,
  onClearWorkspace,
  onAddReadRoots,
  onRemoveReadRoot,
  onTrustProject,
  onStandby,
  onNew,
  onUndo,
  onThread,
  onThreadNew,
  onThreadSearch,
  onThreadRename,
  onThreadRemove,
  onThreadPin,
  onAnnounce,
  onDraftNotice,
  onHalt,
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
  onOpenDeliverable,
  onRevealDeliverable,
  onRemoveDeliverable,
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
  onDecisionResolve: (id: string, action: "answer" | "start" | "revise" | "reject", text?: string, always?: boolean) => void;
  onFeedAction: (card: FeedCard) => void;
  onOpenSettings: () => void;
  /** 换当前会话的工作区 */
  onPickProject?: () => void;
  /** 改项目显示名（跟着项目走：所有绑在它上面的群一起变） */
  onRenameProject?: (name: string) => void;
  /** 这次不用工作区（产出落卷宗沙箱） */
  onClearWorkspace?: () => void;
  /** 给当前会话加只读目录（可多选） */
  onAddReadRoots?: () => void;
  onRemoveReadRoot?: (path: string) => void;
  /** 改当前项目的信任（项目级 MCP 与技能只在信任时生效） */
  onTrustProject?: (trusted: boolean) => void;
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
  /** 写群公告（全局段） */
  onAnnounce?: (text: string) => void;
  /** 请风铃起草群公告 */
  onDraftNotice?: () => void;
  /** 终止本群所有进行中的工作（2026-11-15）：成员停机 + 心跳/巡检/验收叫醒全停 */
  onHalt?: () => void;
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
  /** 交付物右键菜单（2026-11-13）：打开文件 / 定位目录 / 移除 */
  onOpenDeliverable?: (taskId: string, ref: string) => void;
  onRevealDeliverable?: (taskId: string, ref: string) => void;
  onRemoveDeliverable?: (taskId: string, ref: string, deleteFile: boolean) => void;
  /** 全局快捷键截好的图（只进本轮随附） */
  captureShot?: CaptureShot | null;
  /** 发送/新建失败时的可见提示（不允许静默失败） */
  notice?: string | null;
}) {
  /** 本群的活（2026-11-15）：右栏印章、顶栏待办数、频道提示都只认它，别群的单不串进来。
   *  口径统一在 model.jobsInThread——控制台与态势球也走同一处，避免各写一遍后漂移。 */
  const jobsHere = useMemo(() => jobsInThread(desk), [desk]);
  const waitingFirst = useMemo(() => {
    // 归档/已取消的单不能再被默认选中：否则左栏「工单 0」，主区却霸着一张旧单的详情，
    // 看起来像"凭空冒出一张单"（2026-11-11 修）。用户显式点归档项仍可打开。
    const live = jobsHere.filter((j) => j.group !== "archived");
    return live.find((j) => j.action !== "none") ?? live[0];
  }, [jobsHere]);
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
    const n = desk.decisions.length + jobsHere.filter((j) => j.action === "accept").length;
    if (n > prevPending.current) setRightOpen(true);
    prevPending.current = n;
  }, [desk.decisions.length, jobsHere]);
  // E6：Ctrl+K 命令面板 / Ctrl+/ 快捷键清单——能力实际存在就必须可发现
  const [cmdkOpen, setCmdkOpen] = useState(false);
  const [keymapOpen, setKeymapOpen] = useState(false);
  /** 内置预览抽屉：交付箱 / 证据链 / 验收标准三处共用，不启外部程序 */
  const [preview, setPreview] = useState<{ taskId: string; ref: string } | null>(null);
  const openPreview = useCallback<OpenPreview>((taskId, ref) => setPreview({ taskId, ref }), []);
  /** 产物右键菜单（2026-11-13）：对话里的产物 chip 也能定位文件 / 复制路径 */
  const [refMenu, setRefMenu] = useState<{ taskId: string; ref: string; label: string; x: number; y: number } | null>(null);

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
  const pendingCount = desk.decisions.length + jobsHere.filter((j) => j.action === "accept").length;

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
        onTrustProject={onTrustProject}
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
          onOpenDeliverable={onOpenDeliverable}
          onRevealDeliverable={onRevealDeliverable}
          onRemoveDeliverable={onRemoveDeliverable}
          />
        <main className="center">
          <div className="sheet-wrap">
            <Sheet
              key={current?.id ?? "none"}
              job={current}
              feed={desk.feed}
              threadId={desk.thread.id}
              threadTitle={desk.threads.find((x) => x.id === current?.threadId)?.title}
              channelTitle={desk.thread.title}
              halted={desk.thread.halted}
              onHalt={onHalt}
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
              project={{
                id: desk.workspaceProjectId,
                name: desk.workspaceProjectName ?? (desk.workspacePrimary ? desk.project : undefined),
                primary: desk.workspacePrimary,
                extras: desk.workspaceExtras,
              }}
              onPickProject={onPickProject}
              onRenameProject={onRenameProject}
              onRefMenu={(taskId, ref, label, x, y) => setRefMenu({ taskId, ref, label, x, y })}
            />
          </div>
          <ComposerZone
            configured={configured}
            turn={desk.turn}
            queue={desk.queue}
            members={mentionMembers}
            pendingAt={atTarget}
            usage={desk.usage}
            tokensUsed={desk.tokensUsed}
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
          onPlan={(id, action, text, always) => onDecisionResolve(id, action, text, always)}
          onAnswer={(id, text) => onDecisionResolve(id, "answer", text)}
          onSelectJob={(id) => {
            setActiveId(id);
            setRightOpen(false);
          }}
          onCreateTeam={onCreateTeam}
          onManageTeam={onManageTeam}
          onAt={(name) => setAtTarget({ name, nonce: Date.now() })}
          onAnnounce={(text) => onAnnounce?.(text)}
          onDraftNotice={() => onDraftNotice?.()}
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
      {refMenu && (
        <RefMenu
          taskId={refMenu.taskId}
          fileRef={refMenu.ref}
          label={refMenu.label}
          x={refMenu.x}
          y={refMenu.y}
          onClose={() => setRefMenu(null)}
          onOpen={() => {
            void window.lynn.rpc("evidence.open", { taskId: refMenu.taskId, ref: refMenu.ref });
            setRefMenu(null);
          }}
          onReveal={() => {
            void window.lynn.rpc("app.revealPath", { taskId: refMenu.taskId, ref: refMenu.ref });
            setRefMenu(null);
          }}
        />
      )}
    </div>
  );
}
 