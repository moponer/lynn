/**
 * 错误卡的可行动口径（2026-11-17 P6-6 / 18 章 §5 F7）。
 *
 * 问题不是"错误没文案"，而是**文案给了一个必然失败的按钮**：
 * `classifyError` 把 429 一律映射成 `retry`，但额度用尽时点"重试"只会再撞一次 429，
 * 用户点三次、烧三次请求配额，最后还是得去充值。18 章把这叫「必然失败的重试」。
 *
 * 这里做两件事：
 *  1. **按 code 决定动作**：有些错能重试（超时、5xx、网络抖动），有些不能（额度用尽、Key 无效）；
 *  2. **按 code 合并**：同一类错误 5 分钟内只留一张卡并计数，不刷屏。
 *
 * 判据只有一条：**这个按钮点下去，成功概率是不是接近零**。接近零就不给按钮，改成指路。
 */

import type { FeedCard } from "../shared/contract";

export type ErrorAction = NonNullable<FeedCard["action"]>;

export interface ErrorCopy {
  /** 一句话说清发生了什么（用户视角，不是错误码） */
  title: string;
  /** 补充说明：为什么会这样、现在是什么状态 */
  detail: string;
  action: ErrorAction;
  /** 按钮上写什么（action 为 none 时不显示） */
  actionLabel?: string;
  /**
   * 点这个按钮是否**真的可能成功**。
   * false 时界面不该给"重试"——那是让人白点。
   */
  retryable: boolean;
}

/** 同一类错误在这个窗口内合并成一张卡（18 章 §5） */
export const ERROR_MERGE_WINDOW_MS = 5 * 60_000;

/**
 * 按 code 给文案与动作。
 *
 * `context` 里的东西都是**内核已经知道的事实**（熔断还剩多久、有没有配备用模型），
 * 传给这里是为了让文案说具体数字，而不是"请稍后再试"这种没法行动的废话。
 */
export function errorCopy(
  code: string,
  message: string,
  context: { cooldownMinutes?: number; hasBackupModel?: boolean; quotaExhausted?: boolean } = {},
): ErrorCopy {
  switch (code) {
    case "rate_429": {
      // 关键分岔：额度用尽 ≠ 限流。前者重试必失败，后者等一会儿可能就通。
      if (context.quotaExhausted) {
        const mins = context.cooldownMinutes ?? 5;
        return {
          title: "额度已用尽，自动巡检已暂停",
          detail:
            `端点回的是额度上限/欠费类错误。已暂停巡检、验收叫醒与自动派单 ${mins} 分钟——` +
            "继续重试只会把请求配额也烧掉。充值或换 Key 之后**直接发一条消息**即可继续（你的消息不受熔断限制）。",
          action: "settings",
          actionLabel: "去设置",
          retryable: false,
        };
      }
      return {
        title: "端点限流，稍等再试",
        detail: `${message}这是临时限流，等几十秒再试通常就通。`,
        action: "retry",
        actionLabel: "重试",
        retryable: true,
      };
    }
    case "auth_401":
      return {
        title: "API Key 被端点拒绝",
        detail: `${message}重试没有意义——Key 不对就是不对。去设置里核对 Key 与端点地址。`,
        action: "settings",
        actionLabel: "去设置",
        retryable: false,
      };
    case "no_model":
      return {
        title: "还没有可用的模型配置",
        detail: `${message}填好 Base URL / 模型 / API Key 之后就能开始用；重试不会凭空变出配置来。`,
        action: "settings",
        actionLabel: "去设置",
        retryable: false,
      };
    case "network":
      return {
        title: "连不上模型端点",
        detail: `${message}先确认网络与端点地址；断网时本地功能仍可用，但派单与对话需要端点。`,
        action: "retry",
        actionLabel: "重试",
        retryable: true,
      };
    case "timeout":
    case "timeout_idle":
      return {
        title: "模型太久没有输出",
        detail: `${message}已产出的内容不会丢；重试会接着做，不用从头开始。`,
        action: "retry",
        actionLabel: "重试",
        retryable: true,
      };
    case "endpoint_5xx":
      return {
        title: "端点返回服务端错误",
        detail: `${message}${context.hasBackupModel ? "已配置备用模型，可在设置里切换。" : "没有配置备用模型——要么等端点恢复，要么去设置里加一个。"}`,
        action: "retry",
        actionLabel: "重试",
        retryable: true,
      };
    case "worker_crashed":
      return {
        title: "运行时进程异常退出",
        detail: `${message}已写出的文件都还在。重启运行时会接回当前会话。`,
        action: "reload",
        actionLabel: "重启运行时",
        retryable: true,
      };
    case "sandbox_violation":
      return {
        title: "被沙箱挡住了",
        detail: `${message}这不是故障，是权限边界。换一个在授权范围内的路径，或在回报里写 ESCALATE 申请。`,
        action: "none",
        retryable: false,
      };
    default:
      return {
        title: "出错了",
        detail: message || "没有更多信息。",
        action: "logs",
        actionLabel: "看日志",
        retryable: false,
      };
  }
}

/**
 * 合并判定的键：同一 code **且**同一动作才算同一类。
 *
 * 为什么带上 action：429 限流（retry）与额度用尽（settings）是同一个 code 的两种形态，
 * 合并成一张会让用户看到"重试"按钮却对应着额度用尽——正好是我们想消灭的那种误导。
 */
export function errorMergeKey(code: string, action: ErrorAction): string {
  return `${code}::${action}`;
}

/** 该不该把这条错误并进上一条（时间窗 + 同键） */
export function shouldMergeError(
  prev: { code?: string; action?: ErrorAction; at?: number } | null | undefined,
  next: { code: string; action: ErrorAction },
  now: number,
): boolean {
  if (!prev || !prev.code || !prev.at) return false;
  if (errorMergeKey(prev.code, prev.action ?? "none") !== errorMergeKey(next.code, next.action)) return false;
  return now - prev.at < ERROR_MERGE_WINDOW_MS;
}