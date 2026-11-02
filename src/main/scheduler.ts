// M2-02：Agent 定时任务调度器（§3.4 L301：核心，插件没装就不响 = 不可接受）。
//  - 调度在内核主进程，不在任何插件里。
//  - 单飞：同一时刻至多一个任务在跑；陈旧在途（超过 maxRunMin 没回来）强制释放并如实记 stale。
//  - 休眠补跑：错过的任务醒来后补跑一次，lastStatus 如实标 missed（不谎报"准点"）。
//  - 关窗恢复：状态落 schedules.json，重启后 recover() 照常补跑——任务不丢。
import * as fs from "node:fs";
import * as path from "node:path";

export interface ScheduleTask {
  id: string;
  name: string;
  /** 到点后交给风铃的指令（原样入对话流，全程留痕） */
  prompt: string;
  kind: "once" | "daily" | "interval";
  /** once：ISO 时刻 */
  at?: string;
  /** daily：HH:MM */
  time?: string;
  /** interval：分钟 */
  intervalMin?: number;
  enabled: boolean;
  lastRun?: string;
  /** ok=准点跑过 | missed=醒来补跑 | stale=上次在途被清理 | error=执行回调抛错 */
  lastStatus?: "ok" | "missed" | "stale" | "error";
  nextRun?: string;
  createdAt: string;
}

/** 错过超过这个时长才算 missed（抖动/秒级延迟不算） */
const MISSED_AFTER_MS = 10 * 60_000;
/** 在途任务超过这个时长视为陈旧，强制释放（单飞清理） */
export const MAX_RUN_MIN = 30;

/** 任务的下次触发时刻；disabled / 配置不完整 → null */
export function nextRunAt(task: ScheduleTask, now: Date): Date | null {
  if (!task.enabled) return null;
  if (task.kind === "once") {
    if (!task.at) return null;
    const at = new Date(task.at);
    // 一次性任务：跑过（lastRun 晚于 at）就不再排
    if (task.lastRun && new Date(task.lastRun) >= at) return null;
    return at;
  }
  if (task.kind === "daily") {
    const m = /^(\d{1,2}):(\d{2})$/.exec(task.time ?? "");
    if (!m) return null;
    const d = new Date(now);
    d.setHours(+m[1], +m[2], 0, 0);
    if (d <= now) d.setDate(d.getDate() + 1);
    return d;
  }
  if (task.kind === "interval") {
    if (!task.intervalMin || task.intervalMin < 1) return null;
    if (!task.lastRun) return now;
    return new Date(new Date(task.lastRun).getTime() + task.intervalMin * 60_000);
  }
  return null;
}

export interface DueItem {
  task: ScheduleTask;
  dueAt: Date;
  /** true = 醒来/重启后补跑（超过 MISSED_AFTER_MS） */
  missed: boolean;
}

/** 收集到期任务（含补跑判定）；按到期时间升序。调度器单飞：一次 tick 只派第一个。 */
export function collectDue(tasks: ScheduleTask[], now: Date): DueItem[] {
  const out: DueItem[] = [];
  for (const t of tasks) {
    const next = nextRunAt(t, now);
    if (!next || next > now) continue;
    out.push({ task: t, dueAt: next, missed: now.getTime() - next.getTime() > MISSED_AFTER_MS });
  }
  return out.sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime());
}

/**
 * 启动恢复（关窗/崩溃后）：清陈旧在途锁、修正 nextRun。
 * 只做清理与标注，不触发执行——执行由第一次 tick 统一走补跑路径。
 */
export function recover(state: SchedulerState, now: Date): { released: string[] } {
  const released: string[] = [];
  if (state.running) {
    const started = state.runningStartedAt ? new Date(state.runningStartedAt) : null;
    const stale = !started || now.getTime() - started.getTime() > MAX_RUN_MIN * 60_000;
    if (stale) {
      const t = state.tasks.find((x) => x.id === state.running);
      if (t) t.lastStatus = "stale";
      released.push(state.running);
      state.running = null;
      state.runningStartedAt = null;
    }
  }
  for (const t of state.tasks) t.nextRun = nextRunAt(t, now)?.toISOString();
  return { released };
}

export interface SchedulerState {
  tasks: ScheduleTask[];
  /** 单飞锁：当前在跑的任务 id（持久化——崩溃后 recover 清理） */
  running: string | null;
  runningStartedAt: string | null;
}

export class SchedulerStore {
  readonly file: string;
  private state: SchedulerState;

  constructor(dataRoot: string) {
    this.file = path.join(dataRoot, "schedules.json");
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf-8")) as SchedulerState;
      this.state = { tasks: raw.tasks ?? [], running: raw.running ?? null, runningStartedAt: raw.runningStartedAt ?? null };
    } catch {
      this.state = { tasks: [], running: null, runningStartedAt: null };
    }
  }

  get(): SchedulerState {
    return this.state;
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.state, null, 2));
  }

  add(input: Omit<ScheduleTask, "id" | "createdAt" | "enabled"> & { enabled?: boolean }): ScheduleTask {
    const task: ScheduleTask = {
      ...input,
      id: `sch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      enabled: input.enabled ?? true,
      createdAt: new Date().toISOString(),
    };
    if (nextRunAt(task, new Date()) === null && task.enabled) {
      throw new Error(`定时任务 ${task.name} 的触发配置不完整（kind=${task.kind}），已拒绝创建`);
    }
    this.state.tasks.push(task);
    this.persist();
    return task;
  }

  remove(id: string): boolean {
    const before = this.state.tasks.length;
    this.state.tasks = this.state.tasks.filter((t) => t.id !== id);
    const changed = this.state.tasks.length !== before;
    if (changed) this.persist();
    return changed;
  }

  toggle(id: string): ScheduleTask | null {
    const t = this.state.tasks.find((x) => x.id === id);
    if (!t) return null;
    t.enabled = !t.enabled;
    t.nextRun = nextRunAt(t, new Date())?.toISOString();
    this.persist();
    return t;
  }

  list(): ScheduleTask[] {
    return [...this.state.tasks];
  }

  /** 到期集合（含补跑标记）；持久化 nextRun 供诊断 */
  due(now: Date): DueItem[] {
    const due = collectDue(this.state.tasks, now);
    if (due.length) {
      for (const t of this.state.tasks) t.nextRun = nextRunAt(t, now)?.toISOString();
      this.persist();
    }
    return due;
  }

  /** 单飞锁；抢不到返回 false */
  acquire(taskId: string, now: Date): boolean {
    if (this.state.running) {
      const started = this.state.runningStartedAt ? new Date(this.state.runningStartedAt).getTime() : 0;
      if (now.getTime() - started <= MAX_RUN_MIN * 60_000) return false;
      // 陈旧在途：清理（tick 内也会清理，这里兜底）
      const stale = this.state.tasks.find((x) => x.id === this.state.running);
      if (stale) stale.lastStatus = "stale";
    }
    this.state.running = taskId;
    this.state.runningStartedAt = now.toISOString();
    this.persist();
    return true;
  }

  /** 执行完毕：解锁 + 记录结果状态 */
  release(taskId: string, status: "ok" | "missed" | "error"): void {
    const t = this.state.tasks.find((x) => x.id === taskId);
    if (t) {
      t.lastRun = new Date().toISOString();
      t.lastStatus = status;
      t.nextRun = nextRunAt(t, new Date())?.toISOString();
    }
    if (this.state.running === taskId) {
      this.state.running = null;
      this.state.runningStartedAt = null;
    }
    this.persist();
  }
}
