import { useEffect, useRef, useState } from "react";
import type { FeedCard, KernelEvent, TurnPhase } from "../../shared/contract";
import { jobsInThread, type Desk } from "../desk/model";

/**
 * 控制台事件归约：把内核推送压成「数据流行 + 印章状态」。
 *
 * 2026-11-15 重做（用户：控制台不能因为简化就丢重要信息）：
 *  - **进视图先回填权威 feed**：切到控制台 / 换群时，流水直接拿 `desk.feed` 的历史，
 *    不再从空白开始等新事件（此前"刚才发生了什么"在切视图瞬间全部消失）；
 *  - **一律以 card 事件建行**：内核 `emit()` 保证每条工具事件都会先落一张卡，
 *    所以 card 是超集；此前只认 tool 事件、把非流式的卡直接丢掉，结果成员回报、
 *    她的汇报、进度里程碑、卡住告警在控制台一个字都看不到；
 *  - 流式卡：开头建一行、delta 就地补字、终态用 replaced 卡收尾，不另起一行。
 *
 * 其余纪律不变：只订阅 `window.lynn.onEvent`，**不额外发 rpc**；rAF 合帧；
 * 行数封顶 400，超出丢最旧。
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
/** 进视图回填的历史条数：够看懂"刚才发生了什么"，不把 400 行全搬进流水 */
const SEED_LINES = 80;
/** 单行正文上限：成员回报动辄上千字，流水只留能一眼读完的一段 */
const TEXT_CAP = 240;

/** 事件里的 badge → 行类型（badge 是契约里的中文枚举，映射表就这么短） */
function kindOfBadge(badge: string): ConsoleLineKind {
  if (badge === "需要你拍板") return "alert";
  if (badge === "已拦截" || badge === "崩溃" || badge === "未完成") return "alert";
  if (badge === "派单" || badge === "组队") return "cmd";
  if (badge === "工具" || badge === "出站") return "tool";
  return "say";
}

function kindOfCard(card: FeedCard): ConsoleLineKind {
  const badge = card.badge ?? "";
  if (badge) return kindOfBadge(badge);
  if (card.kind === "system") return "alert";
  if (card.kind === "user") return "cmd";
  if (card.kind === "tool") return "tool";
  return "say";
}

/** 错误卡：契约里没有 error 文本字段，错误码落 `code`、可读句子落 `text` */
function isErrorCard(card: FeedCard): boolean {
  return Boolean(card.code) || card.action === "settings" || card.action === "reload";
}

/** 这张卡是谁在说：作者字段优先，其次成员，最后按类型兜底 */
function whoOfCard(card: FeedCard): string {
  if (card.kind === "user") return "你";
  if (card.author?.name) return card.author.name;
  const member = card.members?.[0]?.name;
  if (member) return member;
  if (card.kind === "tool") return "";
  if (card.kind === "system") return "系统";
  return "风铃";
}

/** 一行正文：正文 > 四段汇报 > body > 标题（不拼工单号与路径） */
function textOfCard(card: FeedCard): string {
  const report = card.report;
  if (!card.text && report) {
    const parts = [report.conclusion, report.decision].filter((x) => x && x.trim());
    if (parts.length) return parts.join("｜");
  }
  const raw = card.text || card.body || card.title || "";
  const one = raw.replace(/\s*\n+\s*/g, " ／ ").trim();
  return one.length > TEXT_CAP ? `${one.slice(0, TEXT_CAP)}…` : one;
}

/** 卡片的 createdAt 只有 "HH:MM"：按今天的时钟还原成时间戳，别把历史全标成"现在" */
function atOfCard(card: FeedCard): number {
  const m = /^(\d{1,2}):(\d{2})/.exec(card.createdAt ?? "");
  const d = new Date();
  if (m) {
    d.setHours(Number(m[1]), Number(m[2]), 0, 0);
    return d.getTime();
  }
  return Date.now();
}

function trim(list: ConsoleLine[]): ConsoleLine[] {
  return list.length > MAX_LINES ? list.slice(list.length - MAX_LINES) : list;
}

/** 权威 feed → 初始流水（控制台打开就有历史，不必等新事件） */
function seedFromFeed(feed: FeedCard[]): ConsoleLine[] {
  return feed.slice(-SEED_LINES).map((c, i) => ({
    id: `seed-${c.id || i}`,
    at: atOfCard(c),
    kind: kindOfCard(c),
    who: whoOfCard(c),
    text: textOfCard(c),
    jobId: c.jobId,
    live: false,
  }));
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
    // 有成员卡在同一个工单上报错，就是在干预（只认本群：别群的卡点不该改本群印章）
    if (desk.members.some((m) => m.status === "stuck")) return "intervene";
    return "dispatch";
  }
  if (turn === "done") return "done";
  if (desk.decisions.length > 0) return "decide";
  // 单子卡住（blocked）同样要印章抬头：用户不需要动手，但必须知道有人在撞墙
  if (jobsInThread(desk).some((j) => j.group === "stuck")) return "intervene";
  return "listen";
}

export function useConsoleFeed(desk: Desk): ConsoleFeed {
  const [lines, setLines] = useState<ConsoleLine[]>(() => seedFromFeed(desk.feed));
  const [busy, setBusy] = useState(false);
  /** 已回填过哪个群的历史：换群才重新回填，同群内不覆盖事件流 */
  const seededThread = useRef<string>(desk.thread.id);
  /** 回填时的历史条数：为 0 时（启动首次快照还没回来）下次有历史再补一次 */
  const seededCount = useRef(0);
  /** 正在流式的那条行 id（delta 只改它，不新增行） */
  const liveId = useRef<string | null>(null);
  const pending = useRef<{ id: string; text?: string; thinking?: string } | null>(null);
  const frame = useRef<number | null>(null);
  const seq = useRef(0);

  // 进视图 / 换群：用权威 feed 回填历史（此前切进控制台是一片空白）
  useEffect(() => {
    const tid = desk.thread.id;
    const changed = seededThread.current !== tid;
    // 同群且已经用非空历史回填过 → 不覆盖事件流；首次空历史（快照未到）留一次补填机会
    if (!changed && seededCount.current > 0) return;
    seededThread.current = tid;
    seededCount.current = desk.feed.length;
    liveId.current = null;
    setLines(seedFromFeed(desk.feed));
  }, [desk.feed, desk.thread.id]);

  useEffect(() => {
    const newId = (): string => `ln-${(seq.current += 1)}`;

    const push = (
      kind: ConsoleLineKind,
      who: string,
      text: string,
      jobId?: string,
      live = false,
    ): string => {
      const id = newId();
      setLines((prev) => trim([...prev, { id, at: Date.now(), kind, who, text, jobId, live }]));
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

      if (ev.type === "card") {
        const card = ev.card;
        setBusy(Boolean(card.streaming));
        if (card.streaming) {
          // 流式卡的开头：建一行，后续 delta 填字
          if (!liveId.current) liveId.current = push(kindOfCard(card), whoOfCard(card), textOfCard(card), card.jobId, true);
          return;
        }
        const wasLive = liveId.current;
        liveId.current = null;
        if (ev.replaced) {
          // 流式卡收尾 / 已有卡的字段更新：就地补正文，不另起一行
          if (wasLive) {
            const final = textOfCard(card);
            setLines((prev) => prev.map((l) => (l.id === wasLive ? { ...l, text: final || l.text, live: false } : l)));
          }
          return;
        }
        // 非流式卡一律入流水：成员回报、她的汇报、进度里程碑、卡住告警都从这里来。
        // 内核 emit() 会先把工具事件落成一张卡，所以这里已经覆盖了 tool 事件的全部内容。
        if (isErrorCard(card)) {
          push("alert", "错误", textOfCard(card) || card.code || "出错", card.jobId);
          return;
        }
        push(kindOfCard(card), whoOfCard(card), textOfCard(card), card.jobId);
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
