/**
 * 事件映射（2026-11-18 P15-3，按 vendor 实测重写）。
 *
 * 把 Lynn 的 `KernelEvent` 翻译成 vendored 渠道期待的事件流。
 *
 * ## 帧形状（`harness-client.mjs:2564-2575` 的实测校验）
 *
 * 渠道**不是**直接收裸事件，而是收包在 `session/event` 里的帧：
 *
 * ```js
 * {
 *   type: 'server-request',
 *   method: 'session/event',            // 必须等于 payload.type
 *   payload: {
 *     type: 'session/event',
 *     sessionId: '<会话 id>',            // 必须有
 *     event: { type: 'turn/start', data } // 必须是有 type 的对象
 *   }
 * }
 * ```
 *
 * 第一版我发的是 `{ method: 'turn/start', payload: { type: 'turn/start' } }`——
 * 少了 `session/event` 这层包装，客户端全丢掉，表现为"发消息没反应"。
 *
 * ## 两个事件模型的对应
 *
 * | Lynn | DSH（`event.type`） |
 * |---|---|
 * | `delta { text }` | `assistant/chunk { chunk: { type:'text-delta', text } }` |
 * | `delta { thinking }` | `assistant/chunk { chunk: { type:'thinking-delta', text } }` |
 * | `turn { busy:true }` | `turn/start { turn }` |
 * | `turn { busy:false }` / `done` | `turn/end { turn }` |
 * | `tool { title }` | `tool/call { callId, turn, name }` |
 *
 * 没有对应物的事件**不发**——假事件会让渠道基于错的数据更新状态。
 */
import type { KernelEvent } from "../shared/contract";

/** mux 帧（与 vendor 的 harness-cell 校验对齐） */
export interface MuxEnvelope {
  type: "server-request";
  rpcId: string;
  method: "session/event";
  payload: {
    type: "session/event";
    sessionId: string;
    event: { type: string; data?: Record<string, unknown> };
  };
}

/** 一轮的标识：Lynn 没有 turn id，用自己的递增序号 */
let turnSeq = 0;
let currentTurn: string | null = null;

/** 重置（新一轮或服务重启） */
export function resetTurnSeq(): void {
  turnSeq = 0;
  currentTurn = null;
}

/**
 * 把一个 `KernelEvent` 翻译成 0 个或多个 mux 帧。
 *
 * `sessionId` 必须由调用方给——Lynn 的事件本身不带会话 id（它总是"当前会话"）。
 */
export function mapKernelEvent(ev: KernelEvent, sessionId: string, rpcId = "lynn-events"): MuxEnvelope[] {
  const out: MuxEnvelope[] = [];
  if (!sessionId) return out;

  const wrap = (type: string, data?: Record<string, unknown>) => {
    out.push({
      type: "server-request",
      rpcId,
      method: "session/event",
      payload: {
        type: "session/event",
        sessionId,
        event: { type, ...(data ? { data } : {}) },
      },
    });
  };

  switch (ev.type) {
    case "delta": {
      const d = ev as { text?: string; thinking?: string };
      if (typeof d.thinking === "string" && d.thinking) {
        wrap("assistant/chunk", {
          chunk: { type: "thinking-delta", text: d.thinking },
          ...(currentTurn ? { turn: currentTurn } : {}),
        });
      }
      /**
       * **text-delta 不再发 WS 帧**。
       *
       * 原因（真实事故）：delta 走 WS 推一次、账本走 history 轮询又推一次，
       * 同一段正文在飞书卡片里出现两遍。
       *
       * WS 只保留 `turn/start`、`turn/end`、`tool/call` 等**控制面**事件；
       * 正文统一由账本的 `assistant/message` 在轮询时一次性给全。
       * 代价是失去实时流式——但 300ms 的轮询间隔已经足够快。
       */
      break;
    }

    case "turn": {
      const t = (ev as { turn?: { busy?: boolean } }).turn;
      const busy = t?.busy === true;
      if (busy && !currentTurn) {
        turnSeq += 1;
        currentTurn = `turn-${turnSeq}`;
        wrap("turn/start", { turn: currentTurn });
      } else if (!busy && currentTurn) {
        const turn = currentTurn;
        currentTurn = null;
        wrap("turn/end", { turn });
      }
      break;
    }

    case "done": {
      // 收尾：turn 还开着就补一个 turn/end，否则渠道一直停在"正在生成"
      if (currentTurn) {
        const turn = currentTurn;
        currentTurn = null;
        wrap("turn/end", { turn });
      }
      break;
    }

    case "tool": {
      const t = ev as { title?: string; badge?: string };
      const name = String(t.title ?? t.badge ?? "").trim();
      if (name && currentTurn) {
        wrap("tool/call", { turn: currentTurn, callId: `${currentTurn}-${name}`, name });
      }
      break;
    }

    default:
      // card / thread / window / capture … 没有 DSH 对应物：不发（见头注）
      break;
  }
  return out;
}