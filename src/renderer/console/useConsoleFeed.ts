import { useEffect, useRef, useState } from "react";
import type { FeedCard, KernelEvent, TurnPhase } from "../../shared/contract";
import type { Desk } from "../desk/model";

/**
 * 控制台事件归约：把内核推送压成「数据流行 + 印章状态」。
 *
 * 三条纪律：
 *  - 只订阅 `window.lynn.onEvent`，**不额外发 rpc**（快照由 App 拉好，视图只做投影）；
 *  - 流式补字用 rAF 合帧（每个 delta 都 setState 会让长回复一顿一顿）；
 *  - 行数封顶 400，超出丢最旧——事件堆积不能让内存涨。
 */

export type ConsoleLineKind = "think" | "tool" | "say" | "cmd" | "alert" | "done";

export interface ConsoleLine {
  id: string;
  at: number;
  kind: ConsoleLineKind;
  who: string;
  text: string;
  /** 归属工单（流水栏按它过滤；没有归属就是频道级事件） */
  jobId?: string;
  /** 正在逐字生成（行尾光标） */
  live?: boolean;
}

const MAX_LINES = 400;

/** 事件里的 badge → 行类型（badge 是契约里的中文枚举，映射表就这么短） */
function kindOfBadge(badge: string): ConsoleLineKind {
  if (badge === "需要你拍板") return "alert";
  if (badge === "已拦截" || badge === "崩溃") return "alert";
  if (badge === "派单" || badge === "组队") return "cmd";
  if (badge === "工具" || badge === "出站") return "tool";
  return "say";
}

function kindOfCard(card: FeedCard): ConsoleLineKind {
  if (card.kind === "system") return "alert";
  if (card.kind === "user") return "cmd";
  if (card.kind === "tool") return "tool";
  return "say";
}

/** 错误卡：契约里没有 error 文本字段，错误码落 `code`、可读句子落 `text` */
function isErrorCard(card: FeedCard): boolean {
  return Boolean(card.code) || card.action === "settings" || card.action === "reload";
}

function trim(list: ConsoleLine[]): ConsoleLine[] {
  return list.length > MAX_LINES ? list.slice(list.length - MAX_LINES) : list;
}

export interface ConsoleFeed {
  lines: ConsoleLine[];
  /** 与 Seal 联动的状态：空闲 / 拆解 / 派单 / 待判 / 卡点 */
  phase: SealedPhase;
  /** 当前是否有回合在跑 */
  busy: boolean;
}

export type SealedPhase = "listen" | "pick" | "analyze" | "dispatch" | "decide" | "intervene" | "done";

export function phaseOf(turn: TurnPhase, desk: Desk): SealedPhase {
  // 有待判的事，印章永远先报「待你拍板」——它比模型此刻在做什么更要紧
  if (turn === "review" || turn === "awaiting_plan") return "decide";
  if (turn === "failed") return "intervene";
  if (turn === "accepted") return "pick";
  if (turn === "planning") return "analyze";
  if (turn === "working") {
    // 有成员卡在同一个工单上报错，就是在干预
    if (desk.members.some((m) => m.status === "stuck")) return "intervene";
    return "dispatch";
  }
  if (turn === "done") return "done";
  if (desk.decisions.length > 0) return "decide";
  return "listen";
}

export function useConsoleFeed(desk: Desk): ConsoleFeed {
  const [lines, setLines] = useState<ConsoleLine[]>([]);
  const [busy, setBusy] = useState(false);
  /** 正在流式的那条行 id（delta 只改它，不新增行） */
  const liveId = useRef<string | null>(null);
  const pending = useRef<{ id: string; text?: string; thinking?: string } | null>(null);
  const frame = useRef<number | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    const newId = (): string => `ln-${(seq.current += 1)}`;

    const push = (kind: ConsoleLineKind, who: string, text: string, jobId?: string) => {
      const id = newId();
      liveId.current = kind === "say" ? id : null;
      setLines((prev) =>
        trim([...prev, { id, at: Date.now(), kind, who, text, jobId, live: kind === "say" }]),
      );
      return id;
    };

    const onEvent = (ev: KernelEvent) => {
      if (ev.type === "delta") {
        // 累计全文：同一行就地替换，不追加
        const id = liveId.current;
        if (!id) return;
        pending.current = { id, text: ev.text, thinking: ev.thinking };
        if (frame.current === null) {
          frame.current = window.requestAnimationFrame(() => {
            frame.current = null;
            const p = pending.current;
            pending.current = null;
            if (!p) return;
            setLines((prev) =>
              prev.map((l) =>
                l.id === p.id
                  ? {
                      ...l,
                      text: p.text !== undefined ? p.text : l.text,
                      live: true,
                    }
                  : l,
              ),
            );
          });
        }
        return;
      }

      if (ev.type === "tool") {
        // 没有成员时不要把 badge 再当人名写一遍（界面会出现「工具 工具」）
        const who = ev.members?.length ? ev.members.map((m) => m.name).join("、") : "";
        push(kindOfBadge(ev.badge), who, ev.body || ev.title, ev.jobId);
        return;
      }

      if (ev.type === "card") {
        setBusy(Boolean(ev.card.streaming));
        if (ev.card.streaming) {
          // 流式卡的开头：建一行，后续 delta 填字
          if (!liveId.current)
            push(kindOfCard(ev.card), ev.card.kind === "user" ? "你" : "阿黎", ev.card.text ?? "", ev.card.jobId);
          return;
        }
        liveId.current = null;
        if (isErrorCard(ev.card)) push("alert", "错误", ev.card.text ?? ev.card.code ?? "出错", ev.card.jobId);
        return;
      }

      if (ev.type === "turn") {
        setBusy(ev.turn.busy);
        if (!ev.turn.busy) {
          liveId.current = null;
          setLines((prev) => prev.map((l) => (l.live ? { ...l, live: false } : l)));
        }
        return;
      }

      if (ev.type === "done") {
        liveId.current = null;
        push("done", "回合结束", `本轮 ${ev.tokens} token`);
        return;
      }

      if (ev.type === "error") {
        liveId.current = null;
        push("alert", "错误", ev.message);
      }
    };

    const off = window.lynn.onEvent(onEvent);
    return () => {
      off();
      if (frame.current !== null) {
        window.cancelAnimationFrame(frame.current);
        frame.current = null;
      }
    };
  }, []);

  return { lines, phase: phaseOf(desk.turn.phase, desk), busy };
}
