// 对话面 RPC（2026-11-14）：thread.* 八件，从 kernel.handle 的巨型 switch 里抽出来。
//
// 依赖是 7 个成员：对话存储、当前 id（读写）、切群、持久化、空会话、清理工单。
// （2026-11-16 删掉 draftNotice：群公告由风铃自己写，那个"让风铃起草"按钮是多余的入口）
import type { ThreadStore } from "../threads";

export interface ThreadRpcDeps {
  threads: ThreadStore;
  currentThreadId(): string;
  /** 删群后要断开旧会话（否则落盘会把已删的群写成孤儿文件） */
  setCurrentThreadId(id: string): void;
  switchThread(id: string): void;
  persistThread(): void;
  enterEmptySession(): void;
  /** 删群时把名下工单一起清掉，不留"无主单" */
  purgeThreadTasks(threadId: string): { removed: number; kept: number };
}

export interface ThreadRpc {
  list(): unknown;
  create(params: unknown): unknown;
  switchTo(params: unknown): unknown;
  rename(params: unknown): unknown;
  pin(params: unknown): unknown;
  announce(params: unknown): unknown;
  remove(params: unknown): unknown;
  search(params: unknown): unknown;
}

export function createThreadRpc(deps: ThreadRpcDeps): ThreadRpc {
  const { threads } = deps;
  return {
    list(): unknown {
      return (threads.list().map((t) => ({ id: t.id, title: t.title, updatedAt: t.updatedAt })) ??
        []);
    },
    create(params: unknown): unknown {
      const p = params as { title?: string };
      deps.persistThread();
      const meta = threads.create(p?.title);
      deps.switchThread(meta.id);
      return { ok: true, thread: { id: meta.id, title: meta.title } };
    },
    switchTo(params: unknown): unknown {
      const p = params as { id: string };
      deps.switchThread(p.id);
      return { ok: true, thread: { id: p.id, title: threads.get(p.id)?.title ?? "" } };
    },
    rename(params: unknown): unknown {
      const p = params as { id: string; title: string };
      const t = threads.rename(p.id, p.title);
      return { ok: true, title: t.title };
    },
    pin(params: unknown): unknown {
      const p = params as { id: string; pinned: boolean };
      try {
        const t = threads.setPinned(String(p.id ?? ""), Boolean(p.pinned));
        return { ok: true, pinned: Boolean(t.pinned) };
      } catch {
        return { ok: false, pinned: false };
      }
    },
    announce(params: unknown): unknown {
      const p = params as { id: string; text: string };
      const id = String(p.id ?? "");
      try {
        threads.setAnnouncement(id, String(p.text ?? ""));
        const t = threads.get(id);
        return { ok: true, text: t?.announcement ?? "" };
      } catch {
        return { ok: false, text: "" };
      }
    },
    remove(params: unknown): unknown {
      const p = params as { id: string };
      const wasCurrent = p.id === deps.currentThreadId();
      // 先把当前会话落盘，再删——顺序反了会把刚删的会话又写回来
      if (wasCurrent) deps.persistThread();
      // 会话 = 任务容器：删会话必须连带撤掉它名下的工单（在跑的先停）。
      // 只删对话记录会把工单留成"无主单"——台账照列、动态区照动，用户看不懂。
      const purged = deps.purgeThreadTasks(p.id);
      threads.remove(p.id);
      if (wasCurrent) {
        // 断开旧会话再切：否则 switchThread 的落盘会把已删的会话写成孤儿文件
        deps.setCurrentThreadId("");
        const rest = threads.list();
        if (rest.length) deps.switchThread(rest[0].id);
        else deps.enterEmptySession();
      }
      return {
        ok: true,
        removedTasks: purged.removed,
        keptTasks: purged.kept,
        threadsLeft: threads.list().length,
      };
    },
    search(params: unknown): unknown {
      const p = params as { q: string };
      return { results: threads.search(p.q) };
    },
  };
}
