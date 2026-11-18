// 工单域 RPC（2026-11-18 第五批）：从 kernel.handle 的 switch 里搬出来的 task.* 十四件。
//
// 依赖只声明"用到的能力"，不接收 Kernel——与 calendar/thread/schedule/kb 同一套模式。
//
// 为什么这一批值得搬：这 14 个 case 在 switch 里各占 3–7 行、合计 51 行，
// 但真正的实现在 `rpcTask*` 方法里（合计 326 行）。搬走之后 kernel 少 370 行，
// 且"工单域能做什么"变成一份可读的清单，不用在 1 万行里翻。
//
// 三个方法刻意留在 kernel：
//  - `cancelMemberTask` / `grantReadRoots` / `revokeReadRoot` / `snapshotProject` /
//    `exportTask` / `removeTask` / `dismissTask` / `purgeOrphanTasks` —— 它们是**编排**，
//    要动成员运行时、只读根、磁盘与卡片，不属于"工单域的查询与决策"。
//    这里只做**转发**，与它们在 kernel 里时的行为逐字一致。
import * as fs from "node:fs";
import * as path from "node:path";
import { stageLine } from "../stage-plan";

/** 工单存储只取用到的部分 */
export type TaskStorePort = {
  get(id: string): TaskRecordLike | null;
  setDeliverables(id: string, list: DeliverableLike[]): void;
  transition(id: string, status: string): { status: string };
  setReviewer(id: string, who: "user" | "member"): void;
  approve(id: string, by: "user" | "member", note: string): void;
  reject(id: string, by: "user" | "member", reason?: unknown): void;
};

/** 工单记录的形状（只声明这个域读到的字段） */
export interface TaskRecordLike {
  id: string;
  title: string;
  member?: string;
  teamId: string;
  status: string;
  statusNote?: string;
  brief?: string;
  acceptance?: unknown[];
  stagePlan?: {
    stages: {
      id: string;
      title: string;
      status: string;
      round: number;
      evidence: string[];
      note?: string;
    }[];
  };
  scale?: unknown;
  reworkFocus?: { items: string[] };
  workspaceRoot?: string;
  projectName?: string;
  threadId?: string;
  deliverables?: DeliverableLike[];
}

export interface DeliverableLike {
  path: string;
  ref: string;
  bytes: number;
}

/** 卷宗（时间线）只取读的能力 */
export type TaskCasePort = {
  readTimeline(id: string): { at: string; kind: string; text: string }[];
  append(id: string, entry: { kind: string; member: string; text: string }): void;
  appendSummary(id: string, text: string): void;
};

export interface TaskRpcDeps {
  taskStore: TaskStorePort;
  taskCase: TaskCasePort;
  /** 数据根（删除交付物时要判断是否在 tasks/<id>/artifacts 内） */
  dataRoot: string;
  /** 当前会话 id（落卡用） */
  currentThreadId(): string;
  /** 落卡到指定会话 */
  cardTo(threadId: string, card: { kind: "system"; jobId?: string; text: string }): void;
  log(event: string, detail: Record<string, unknown>): void;

  // ---- 以下由 kernel 提供（编排能力，不搬）----
  cancelMemberTask(taskId: string): { ok: boolean };
  memberRunIds(): string[];
  grantReadRoots(taskId: string, dirs: string[], opts: { allowDriveRoot?: boolean }): unknown;
  revokeReadRoot(taskId: string, dir?: string): unknown;
  dismissTask(taskId: string): unknown;
  snapshotProject(taskId: string): unknown;
  exportTask(taskId: string): unknown;
  removeTask(taskId: string): unknown;
  purgeOrphanTasks(): { removed: number; kept: number };

}

/** 与其它域一致：入参/返回值仍是 unknown，契约收口在 Kernel.taskRpcDeps() 一处 */
export interface TaskRpc {
  cancel(params: unknown): unknown;
  cancelAll(): unknown;
  grantRead(params: unknown): unknown;
  revokeRead(params: unknown): unknown;
  dismiss(params: unknown): unknown;
  snapshotProject(params: unknown): unknown;
  export(params: unknown): unknown;
  remove(params: unknown): unknown;
  purgeOrphans(): unknown;
  removeDeliverable(params: unknown): unknown;
  detail(params: unknown): unknown;

}

export function createTaskRpc(deps: TaskRpcDeps): TaskRpc {
  const { taskStore, taskCase } = deps;

  return {
    // ---------- 九个薄封装：行为与留在 kernel 时逐字一致 ----------
    cancel(params: unknown): unknown {
      const { taskId } = params as { taskId: string };
      return deps.cancelMemberTask(String(taskId));
    },

    cancelAll(): unknown {
      // C4：新会话提示卡上的一键止损；逐张停，失败的不假装成功（计数如实）
      const ids = deps.memberRunIds();
      let stopped = 0;
      for (const id of ids) {
        if (deps.cancelMemberTask(id).ok) stopped += 1;
      }
      return { ok: true, stopped };
    },

    grantRead(params: unknown): unknown {
      const { taskId, dir, dirs, allowDriveRoot } = params as {
        taskId: string;
        dir?: string;
        dirs?: string[];
        allowDriveRoot?: boolean;
      };
      const list = dirs?.length ? dirs : dir ? [dir] : [];
      return deps.grantReadRoots(String(taskId), list, { allowDriveRoot });
    },

    revokeRead(params: unknown): unknown {
      const { taskId, dir } = params as { taskId: string; dir?: string };
      return deps.revokeReadRoot(String(taskId), dir ? String(dir) : undefined);
    },

    dismiss(params: unknown): unknown {
      const { taskId } = params as { taskId: string };
      return deps.dismissTask(String(taskId));
    },

    snapshotProject(params: unknown): unknown {
      const { taskId } = params as { taskId: string };
      return deps.snapshotProject(String(taskId));
    },

    export(params: unknown): unknown {
      const { taskId } = params as { taskId: string };
      return deps.exportTask(String(taskId));
    },

    remove(params: unknown): unknown {
      const { taskId } = params as { taskId: string };
      return deps.removeTask(String(taskId));
    },

    purgeOrphans(): unknown {
      const r = deps.purgeOrphanTasks();
      return { ok: true, removed: r.removed, kept: r.kept };
    },

    // ---------- 下面五个自带逻辑，是这次搬迁的主要价值 ----------

    removeDeliverable(params: unknown): unknown {
      const { taskId, ref, deleteFile } = params as { taskId: string; ref: string; deleteFile?: boolean };
      const rec = taskStore.get(String(taskId ?? ""));
      if (!rec) return { ok: false, error: "没有这张单" };
      const list = rec.deliverables ?? [];
      const hit = list.find((d) => d.ref === ref || d.path === ref);
      if (!hit) return { ok: false, error: "交付箱里没有这条交付物" };
      let removedFile = false;
      if (deleteFile) {
        const wsRoot = rec.workspaceRoot ? path.resolve(rec.workspaceRoot) : "";
        const abs = path.isAbsolute(hit.path) ? path.resolve(hit.path) : wsRoot ? path.resolve(wsRoot, hit.path) : "";
        const artDir = path.join(deps.dataRoot, "tasks", rec.id, "artifacts");
        const inside = (root: string) => Boolean(root) && (abs === root || abs.startsWith(root + path.sep));
        if (!abs || (!inside(wsRoot) && !inside(artDir))) {
          return { ok: false, error: `为安全起见不删工作区外的文件：${abs || hit.path}` };
        }
        try {
          if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
            fs.unlinkSync(abs);
            removedFile = true;
          }
        } catch (err) {
          return { ok: false, error: `删文件失败：${err instanceof Error ? err.message : String(err)}` };
        }
      }
      taskStore.setDeliverables(rec.id, list.filter((d) => d !== hit));
      const name = hit.path.split(/[\\/]/).filter(Boolean).pop() ?? hit.path;
      deps.cardTo(rec.threadId ?? deps.currentThreadId(), {
        kind: "system",
        jobId: rec.id,
        text: `已从交付箱移除「${name}」${removedFile ? "，磁盘文件已删除。" : "（磁盘文件保留）。"}`,
      });
      deps.log("deliverable_removed", { taskId: rec.id, ref: hit.ref, deleteFile: Boolean(deleteFile), removedFile });
      return { ok: true, removedFile };
    },

    detail(params: unknown): unknown {
      const { taskId } = params as { taskId: string };
      const id = String(taskId ?? "").trim();
      const rec = taskStore.get(id);
      if (!rec) return { ok: false, error: `没有这张单：${id}` };
      const brief = rec.brief ?? "";
      const acceptance = rec.acceptance ?? [];
      let timeline: { at: string; kind: string; text: string }[] = [];
      try {
        timeline = taskCase.readTimeline(id).slice(-20).map((e) => ({ at: e.at, kind: e.kind, text: e.text }));
      } catch {
        timeline = [];
      }
      return {
        ok: true,
        detail: {
          id: rec.id,
          title: rec.title,
          ...(rec.member ? { member: rec.member } : {}),
          teamId: rec.teamId,
          status: rec.status,
          statusNote: rec.statusNote ?? "",
          ...(brief ? { brief, goal: brief.split("\n")[0]?.replace(/^【目标】/, "").trim() ?? "" } : {}),
          acceptance,
          // 阶段账（2026-11-15）：详情区能看出走到哪一段、哪一段被打回、只重做哪几条
          ...(rec.stagePlan
            ? {
                stages: rec.stagePlan.stages.map((s) => ({
                  id: s.id,
                  title: s.title,
                  status: s.status,
                  round: s.round,
                  evidence: s.evidence.slice(0, 3),
                  ...(s.note ? { note: s.note } : {}),
                })),
                stageLine: stageLine(rec.stagePlan as never),
              }
            : {}),
          ...(rec.scale ? { scale: rec.scale } : {}),
          ...(rec.reworkFocus?.items.length ? { reworkFocus: rec.reworkFocus.items } : {}),
          ...(rec.workspaceRoot ? { workspaceRoot: rec.workspaceRoot } : {}),
          ...(rec.projectName ? { projectName: rec.projectName } : {}),
          deliverables: (rec.deliverables ?? []).map((d) => ({ label: d.path, ref: d.ref, bytes: d.bytes })),
          timeline,
        },
      };
    },


  };
}
