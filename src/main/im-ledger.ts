/**
 * IM 事件账本（2026-11-18 P15-6）。
 *
 * ## 为什么必须有它
 *
 * vendored 渠道的 `HarnessClient.ask()` **不是靠 WebSocket 等回复**，
 * 而是每 300ms 轮询 `session.history`，从返回的 `history.events` 里读事件
 * （见 vendor/shared/harness-client.mjs:2282-2292）。
 *
 * 所以 `session.history` 必须返回**事件格式**的账本，而不是"消息列表"。
 * 第一版我返回 `{ messages }`，结果 `history.events` 恒为 undefined，
 * 渠道永远等不到自己的 turn，报 `harness-reply-timeout`
 * ——用户看到的就是"发消息没反应"。
 *
 * ## 协议要求（逐条来自 vendor 的实测）
 *
 * 每次轮询返回 `{ events: [{ seq, event }] }`，其中 `event`：
 *
 * | 类型 | 必须字段 | 作用 |
 * |---|---|---|
 * | `turn/start` | `data.turn` | 开轮 |
 * | `user/message` | `data.source.rpcId` + `data.turn` | **把这一轮绑定到某次 prompt** |
 * | `assistant/chunk` | `data.chunk.type='text-delta'` + `data.chunk.text` | 正文增量 |
 * | `assistant/message` | `data.text` | 完整正文 |
 * | `turn/end` | `data.turn` + `data.reason` | 收轮 |
 *
 * `seq` 必须**严格递增**：vendor 用 `if (seq <= lastSeq) continue` 跳过旧事件，
 * 没有 seq 会被当成 -1 全部丢掉。
 *
 * ## 内存账本够不够
 *
 * 够。它的生命周期只需要覆盖"一次 prompt 的等待窗口"（默认 10 分钟）。
 * 落盘反而会带来清理问题；崩溃丢失的代价是那一轮报超时，可接受。
 * 每人保留最近 {@link MAX_TURNS} 轮，防止长时间运行内存增长。
 */
import type { KernelEvent } from "../shared/contract";

/** 一轮在账本里的样子 */
interface TurnRecord {
  sessionId: string;
  /** 这一轮的标识（Lynn 没有 turn id，自己生成） */
  turnId: string;
  /** 提交这次 prompt 的 rpcId——渠道靠它认领这一轮 */
  promptRpcId: string;
  /** 用户的原文 */
  text: string;
  /** 累积的回答正文 */
  answer: string;
  /** 累积的思考内容 */
  thinking: string;
  /**
   * 这一轮的 seq 基准。每轮占 10 个号，轮内固定偏移：
   * `+1` 开轮 / `+2` 用户消息 / `+3` 正文增量 / `+4` 完整正文 / `+9` 收轮。
   *
   * 为什么用号段而不是"每次调 nextSeq()"：第一版就是这样，
   * 结果 `assistant/message` 用的 `chunkSeq+1` 与 `endSeq` 撞号，
   * 去重时把 `turn/end` 丢掉了 —— 渠道于是永远等不到收轮信号。
   */
  seqBase: number;
  /** 是否已有正文（决定要不要发 chunk/message） */
  hasText: boolean;
  endSeq: number | null;
  /** 这一轮是否已结束 */
  done: boolean;
  /** 结束原因：vendor 的 `harnessTurnSucceeded` 只认 `done`/`stop` 等几种 */
  reason: string;
}

/** 每个会话最多保留多少轮 */
const MAX_TURNS = 50;

/** 计数器：seq 全局递增，跨会话共用（vendor 只要求单调） */
let seqCounter = 0;
const nextSeq = (): number => (seqCounter += 1);

/** sessionId → 该会话的轮次（时间序） */
const ledger = new Map<string, TurnRecord[]>();

/** 开一轮，返回 turnId */
export function beginTurn(sessionId: string, promptRpcId: string, text: string): string {
  const seqBase = nextSeq() * 10;
  const turnId = `t-${seqBase}`;
  const rec: TurnRecord = {
    sessionId,
    turnId,
    promptRpcId,
    text,
    answer: "",
    thinking: "",
    seqBase,
    hasText: false,
    endSeq: null,
    done: false,
    /** 结束原因：vendor 的 `harnessTurnSucceeded` 只认 `completed` */
    reason: "completed",
  };
  const list = ledger.get(sessionId) ?? [];
  list.push(rec);
  // 只留最近 MAX_TURNS 轮
  if (list.length > MAX_TURNS) list.splice(0, list.length - MAX_TURNS);
  ledger.set(sessionId, list);
  return turnId;
}

/** 找到当前有未结束轮次的那一条 */
export function openTurn(sessionId: string): TurnRecord | undefined {
  const list = ledger.get(sessionId);
  if (!list) return undefined;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (!list[i]!.done) return list[i];
  }
  return undefined;
}

/**
 * 把一个 `KernelEvent` 记进账本。
 *
 * 返回是否消费了它——调用方据此决定要不要再走 WebSocket 广播。
 */
export function recordEvent(ev: KernelEvent, sessionId: string): boolean {
  const rec = openTurn(sessionId);
  if (!rec) return false;

  switch (ev.type) {
    case "delta": {
      const d = ev as { text?: string; thinking?: string };
      /**
       * **覆盖，不累加**（2026-11-19 修：手机飞书同一条消息内片段重复）。
       *
       * `KernelEvent.delta.text` 的契约是「本轮到目前为止的**完整正文**」，
       * 不是新增片段——内核每帧都发 `liveCard.text`（`kernel.ts` 的
       * `onAgentEvent` / `patchLive` / `guardRepetition` 四处全是全文，
       * 且节流到 ~80ms 一帧）。
       *
       * 第一版这里写的是 `rec.answer += d.text`，于是：
       *   帧1 文本「已停掉」        → rec.answer =「已停掉」
       *   帧2 文本「已停掉，已关单」  → rec.answer =「已停掉」+「已停掉，已关单」
       *   帧3 …… 再把从头到尾的全文拼一遍
       * 几千字回复 ≈ 几十帧 → 同一段被拼几十遍，用户看到正文在一条消息里
       * 反复出现、甚至插进句子中间（最新全文接到旧全文的尾部）。
       *
       * 覆盖同时正确处理「重复拦截后裁剪」：`guardRepetition` 发出的是
       * 裁剪后的全文（可能比上一帧短），覆盖能让账本跟着回退；累加做不到。
       */
      if (typeof d.text === "string" && d.text) {
        rec.answer = d.text;
        rec.hasText = true;
      }
      // thinking 同为全文语义（`liveCard.thinking`），同样覆盖；
      // 虽然 historyEvents 不发思考，但保持一致，避免将来开放时重蹈覆辙。
      if (typeof d.thinking === "string" && d.thinking) rec.thinking = d.thinking;
      return true;
    }
    case "turn": {
      const t = (ev as { turn?: { busy?: boolean } }).turn;
      if (t?.busy === false && !rec.done) {
        rec.done = true;
        rec.endSeq = rec.seqBase + 9;
        return true;
      }
      return false;
    }
    case "done": {
      if (!rec.done) {
        rec.done = true;
        rec.endSeq = rec.seqBase + 9;
      }
      return true;
    }
    default:
      return false;
  }
}

/**
 * 结束一轮（`session.prompt` 的 handler 在 waitTurn 之后调）。
 */
export function endTurn(sessionId: string, reason = "completed"): void {
  const rec = openTurn(sessionId);
  if (!rec || rec.done) return;
  rec.done = true;
  rec.reason = reason;
  rec.endSeq = rec.seqBase + 9;
}

/**
 * 生成 `session.history` 的事件数组（vendor 的 `history.events`）。
 *
 * `afterSeq` 是 vendor 传的 `tracker.lastSeq`——它只要比这个大的事件。
 * 我们仍然返回全部（它自己会过滤），但按 seq 升序排列。
 */
export function historyEvents(sessionId: string, afterSeq = -1): { seq: number; event: Record<string, unknown> }[] {
  const list = ledger.get(sessionId) ?? [];
  const out: { seq: number; event: Record<string, unknown> }[] = [];
  for (const rec of list) {
    /**
     * **`seq` 必须同时放在事件对象内部**。
     *
     * vendor 会先做 `entry?.event ?? entry` 再读 `event.seq`
     * （harness-client.mjs:710-716）。只放在外层包装上时，
     * 解包后的 `event.seq` 是 undefined → 取 -1 → `seq <= lastSeq` 全部跳过
     * → tracker 永远认不到自己的 turn → `harness-reply-timeout`。
     *
     * 这个坑很隐蔽：事件看起来"发了"，但消费端一个都没收。
     */
    // 1) 开轮
    out.push({ seq: rec.seqBase + 1, event: { type: "turn/start", seq: rec.seqBase + 1, data: { turn: rec.turnId } } });
    /**
     * 2) **关键**：`user/message` 带 `source.rpcId`，vendor 靠它认领这一轮
     *    （harness-client.mjs:547）。少了这条，它会认为这轮不属于它。
     */
    out.push({
      seq: rec.seqBase + 2,
      event: {
        type: "user/message",
        seq: rec.seqBase + 2,
        data: { turn: rec.turnId, source: { rpcId: rec.promptRpcId }, text: rec.text },
      },
    });
    // 3) 正文
    if (rec.hasText && rec.answer) {
      /**
       * 只发 `assistant/message`（完整定稿），**不再发 `assistant/chunk`**。
       *
       * 原因（真实事故）：之前两条都发，且 chunk 携带的是 `rec.answer`
       * （累积全文）。vendor 的 history 路径（harness-client.mjs:783-813）
       * 先 `appendDelta` 再 `commitText`（推一次 update），
       * 然后 `setCanonical` + `commitText`（再推一次 update）+
       * `pushUpdate({type:'assistant-message'})`（又推一次）。
       *
       * 飞书 bot 对每次 update 都调 `#appendStepCardUpdate` 追加内容，
       * 结果卡片里同一段正文出现两遍——用户看到的"回复重复"。
       *
       * 去掉 chunk 后只剩 message 一条路径。
       *
       * **data 格式必须带 `message.content`**：
       * vendor 的 `accumulateFinalAssistantText`（:481-483）读的是
       * `event.data.message.content`（harness content 数组），
       * `assistantMessageText`（:803）也是。
       * 之前只给 `data.text`，vendor 读不到 → `finalAnswer` 为空 →
       * `ask()` 返回"没有文本回复"。
       */
      out.push({
        seq: rec.seqBase + 4,
        event: {
          type: "assistant/message",
          seq: rec.seqBase + 4,
          data: {
            turn: rec.turnId,
            message: { content: [{ type: "text", text: rec.answer }] },
          },
        },
      });
    }
    // 4) 收轮
    if (rec.done && rec.endSeq !== null) {
      out.push({
        seq: rec.endSeq,
        event: {
          type: "turn/end",
          seq: rec.seqBase + 9,
          data: { turn: rec.turnId, reason: { kind: rec.reason } },
        },
      });
    }
  }
  /**
   * 过滤 + 去重 + 升序。
   *
   * `afterSeq` 来自 vendor 的 `tracker.lastSeq`——它已经消费过的事件不必再发。
   * 但**不能只发增量**：`turn/end` 的号段在末尾（`+9`），如果只按"新产生的"
   * 过滤，收轮信号可能因为基准太早而被漏掉。所以这里按 `afterSeq` 严格过滤，
   * 由 vendor 自己再按 seq 判断——它的判断是权威的。
   */
  const seen = new Set<number>();
  return out
    .filter((e) => e.seq > afterSeq)
    .filter((e) => (seen.has(e.seq) ? false : (seen.add(e.seq), true)))
    .sort((a, b) => a.seq - b.seq);
}

/** 一轮的最终回答（给不需要轮询的调用方用） */
export function answerOf(sessionId: string, promptRpcId: string): string | null {
  const list = ledger.get(sessionId) ?? [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (list[i]!.promptRpcId === promptRpcId) return list[i]!.answer;
  }
  return null;
}

/** 清空（测试与重启用） */
export function resetLedger(): void {
  ledger.clear();
  seqCounter = 0;
}