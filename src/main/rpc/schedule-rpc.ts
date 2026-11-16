// 定时任务域 RPC（2026-11-16 第三批）：schedule.* 五件。
//
// tick 是回调：扫一遍到期任务要起一轮对话（内核编排），调度器自己只负责"什么时候该跑"。
import type { SchedulerStore } from "../scheduler";

export interface ScheduleRpcDeps {
  scheduler: Pick<SchedulerStore, "add" | "list" | "remove" | "toggle">;
  tickSchedules(): void;
}

export interface ScheduleRpc {
  tick(): unknown;
  add(params: unknown): unknown;
  list(): unknown;
  remove(params: unknown): unknown;
  toggle(params: unknown): unknown;
}

export function createScheduleRpc(deps: ScheduleRpcDeps): ScheduleRpc {
  const { scheduler } = deps;
  return {
    tick(): unknown {
      deps.tickSchedules();
      return { ok: true };
    },

    add(params: unknown): unknown {
      const p = params as {
        name: string;
        prompt: string;
        kind: "once" | "daily" | "interval";
        at?: string;
        time?: string;
        intervalMin?: number;
      };
      try {
        const task = scheduler.add({
          name: String(p.name).trim() || "未命名任务",
          prompt: String(p.prompt),
          kind: p.kind,
          at: p.at,
          time: p.time,
          intervalMin: p.intervalMin,
        });
        return { ok: true, task: { id: task.id, name: task.name, nextRun: task.nextRun } };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },

    list(): unknown {
      return {
        tasks: scheduler.list().map((t) => ({
          id: t.id,
          name: t.name,
          kind: t.kind,
          enabled: t.enabled,
          nextRun: t.nextRun,
          lastRun: t.lastRun,
          lastStatus: t.lastStatus,
        })),
      };
    },

    remove(params: unknown): unknown {
      const { id } = params as { id: string };
      return { ok: scheduler.remove(String(id)) };
    },

    toggle(params: unknown): unknown {
      const { id } = params as { id: string };
      const t = scheduler.toggle(String(id));
      if (!t) return { ok: false, error: `没有这个定时任务：${id}` };
      return { ok: true, enabled: t.enabled };
    },
  };
}
