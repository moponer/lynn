// 日志分类与限流（2026-11-11）。
//
// 实机问题：排查「成员跑完未交付」时，agent.log 里只有命令审计，看不到成员工具调用；
// 但直接全量记录工具往返，一次长任务就能写出几十 MB。这里做三件事：
//  - 按 kind 前缀自动归类，新增调用点不用改日志函数；
//  - 每类可单独开关、每类有每分钟上限（超了丢弃并写一条汇总，不刷屏）；
//  - 单条事件字段截断，5MB 轮转保留 2 份，最坏情况总量可控。

export type LogCategory = "member" | "tool" | "task" | "heartbeat" | "system";

export const LOG_CATEGORIES: readonly LogCategory[] = ["member", "tool", "task", "heartbeat", "system"];

/** kind 前缀 → 类别。没命中的走 system，保证不会因为新增 kind 就漏记。 */
export function categoryOf(kind: string): LogCategory {
  const k = String(kind ?? "");
  // 工具调用单独归 tool：排查完「成员到底调没调工具」后可以只关这一类，
  // 不影响成员生命周期与工单状态日志。
  if (k === "member_tool" || k.startsWith("tool_") || k.startsWith("cmd_")) return "tool";
  if (k.startsWith("member_")) return "member";
  if (k.startsWith("heartbeat_")) return "heartbeat";
  if (k.startsWith("task_")) return "task";
  return "system";
}

export interface LogPrefs {
  /** 总开关：false 时一条都不写（排查完可以彻底关掉） */
  enabled?: boolean;
  /** 分类开关；缺省按 DEFAULT_LOG_PREFS */
  categories?: Partial<Record<LogCategory, boolean>>;
  /** 每类每分钟上限；0 = 不限，缺省按 DEFAULT_LOG_PREFS */
  perMinute?: Partial<Record<LogCategory, number>>;
  /** 单条事件里字符串字段的最大长度 */
  maxChars?: number;
}

export const DEFAULT_LOG_PREFS = {
  enabled: true,
  categories: {
    // 心跳本身会落卡，日志默认关：它是最高频、最低信息量的一类
    heartbeat: false,
    member: true,
    tool: true,
    task: true,
    system: true,
  } as Record<LogCategory, boolean>,
  perMinute: {
    member: 60,
    tool: 120,
    task: 60,
    heartbeat: 20,
    system: 60,
  } as Record<LogCategory, number>,
  maxChars: 400,
};

interface Window {
  start: number;
  count: number;
  dropped: number;
}

/**
 * 日志闸：判断某类是否还能写，并负责字段截断。
 * 纯内存、O(1)，不读盘；状态按类别各一个一分钟滚动窗口。
 */
export class LogGate {
  private windows = new Map<LogCategory, Window>();

  constructor(
    private readonly prefs: () => LogPrefs | undefined,
    private readonly now: () => number = Date.now,
  ) {}

  /** 这类日志现在能不能写；不能写时返回 null，能写时返回类别。 */
  allow(kind: string): LogCategory | null {
    const p = this.prefs();
    if (p?.enabled === false) return null;
    const cat = categoryOf(kind);
    if (p?.categories?.[cat] === false) return null;
    if (DEFAULT_LOG_PREFS.categories[cat] === false && p?.categories?.[cat] !== true) return null;
    const limit = p?.perMinute?.[cat] ?? DEFAULT_LOG_PREFS.perMinute[cat];
    if (!limit || limit <= 0) return cat;
    const t = this.now();
    const w = this.windows.get(cat);
    if (!w || t - w.start >= 60_000) {
      this.windows.set(cat, { start: t, count: 1, dropped: 0 });
      return cat;
    }
    if (w.count < limit) {
      w.count += 1;
      return cat;
    }
    w.dropped += 1;
    return null;
  }

  /** 取该类别在当前窗口内被丢弃的条数（调用方写一条汇总后要清零）。 */
  takeDropped(cat: LogCategory): number {
    const w = this.windows.get(cat);
    const n = w?.dropped ?? 0;
    if (w) w.dropped = 0;
    return n;
  }

  /** 截断事件里的字符串字段，避免一条命令输出把日志撑爆。 */
  trim(data: Record<string, unknown>): Record<string, unknown> {
    const max = this.prefs()?.maxChars ?? DEFAULT_LOG_PREFS.maxChars;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data ?? {})) {
      if (typeof v === "string") out[k] = v.length > max ? `${v.slice(0, max)}…(${v.length})` : v;
      else out[k] = v;
    }
    return out;
  }
}

// ---------- 渲染层日志（logs/renderer.log）限流（2026-11-13 审计 #8） ----------
// renderer.log 此前是裸 appendFileSync：无轮转、无截断、无限流，渲染进程高频
// 上报能把磁盘打满并淹没真实错误。这里与 agent.log 的 LogGate 同思路，
// 单独做一个每分钟窗口的闸（渲染层日志不分 kind 类别，一条闸就够）。

export const RENDERER_LOG_LIMITS = {
  /** 每分钟最多写入条数；超限丢弃并计数 */
  maxPerMinute: 120,
  /** 单条日志行的最大字符数 */
  entryMaxChars: 16_000,
  /** 轮转阈值：超过挪到 renderer.old.log（只留一份，最坏两份共 10MB） */
  rotateBytes: 5 * 1024 * 1024,
} as const;

export interface RendererLogGateState {
  windowStart: number;
  count: number;
  dropped: number;
}

export function newRendererLogGate(): RendererLogGateState {
  return { windowStart: 0, count: 0, dropped: 0 };
}

/**
 * 每分钟限流闸：返回是否放行 + 新状态；窗口翻转时若上一窗口有丢弃，
 * 返回 droppedSummary 让调用方落一条汇总行（丢失多少条要有交代）。
 */
export function rendererLogGate(
  state: RendererLogGateState,
  now: number,
  maxPerMinute = RENDERER_LOG_LIMITS.maxPerMinute,
): { state: RendererLogGateState; write: boolean; droppedSummary?: number } {
  if (!state.windowStart || now - state.windowStart >= 60_000) {
    const droppedSummary = state.dropped > 0 ? state.dropped : undefined;
    return {
      state: { windowStart: now, count: 1, dropped: 0 },
      write: true,
      ...(droppedSummary !== undefined ? { droppedSummary } : {}),
    };
  }
  if (state.count >= maxPerMinute) {
    return { state: { ...state, dropped: state.dropped + 1 }, write: false };
  }
  return { state: { ...state, count: state.count + 1 }, write: true };
}
