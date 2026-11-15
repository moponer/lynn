import { useEffect, useMemo, useRef, useState } from "react";
import type { PermissionMode } from "../../shared/contract";
import {
  STATUS_LABEL,
  fmtTime,
  fmtTokens,
  jobsInThread,
  outputsOf,
  type Desk,
  type DeskDecision,
  type DeskEvidence,
  type DeskJob,
  type DeskOutput,
} from "../desk/model";
import { WindowControls } from "../components/WindowControls";
import { PreviewDrawer } from "../components/PreviewDrawer";
import { Field } from "./Field";
import { LynnCore } from "./Seal";
import { Stream } from "./Stream";
import { useConsoleFeed } from "./useConsoleFeed";
import type { ConsoleLine } from "./useConsoleFeed";
import type { ConsoleViewProps } from "./types";
import "./console.css";

/**
 * 沉浸控制台（`stage.console` 卡槽的内置视图 `console`）。
 *
 * 布局照 2026-11-08 原型走，一个字都不省：
 *   顶栏  品牌 / 会话 / 侦听  ┃ 任务·待判读数 / 档案 / 用量 / 配置 / 流水 / 时钟 / 值台 / 窗口键
 *   左栏  来令（200px 定高，含累计-已捞-在池）→ 战局（拆解条 + 任务卡 + 归档条）
 *   中栏  态势球（全量/节点 · 图例 · 节点-链路-帧读数 · 两侧数据流 · 球心 ALERT · 锁定卡）→ 流水栏
 *   右栏  风铃（核心动效 + 军印 + 状态）→ 产出柜（缩略图在上）
 *   底栏  权限档 / 下令行 + Enter / 派出
 *
 * 数据纪律：所有数字来自 Desk；模型里没有的一律不画（预算、耗时、吞吐都不编）。
 */

/** 单号显示：短的整条给（WO-2418 一眼能认），长的只给尾巴（…a1b2c3），绝不切出 "O-2418" 这种半截 */
function shortId(id: string): string {
  return id.length <= 8 ? id : `…${id.slice(-6)}`;
}

function hhmm(at?: string): string {
  if (!at) return "—";
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return "—";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function clock(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const PERMISSIONS: PermissionMode[] = ["plan", "ask", "auto", "full"];
/** 底栏印中文档位：`plan/ask/auto/full` 是枚举值，不是给人读的字（与值台一致） */
const PERMISSION_LABEL: Record<PermissionMode, string> = {
  plan: "计划",
  ask: "询问",
  auto: "自动",
  full: "全权",
};

type Drawer = "result" | "decide" | "usage" | "config" | "archive" | null;

/** 卡片上的一个动作：只描述"做什么"，不关心是哪个 RPC */
type Act = { key: string; label: string; tone?: "ok" | "bad"; run: () => void };

export function ConsoleDesk(props: ConsoleViewProps) {
  const {
    desk,
    permission,
    configured,
    onExit,
    onSend,
    onCd,
    onAbort,
    onHalt,
    onOpenSettings,
    onPermission,
    onDecisionResolve,
    onDecision,
    onCancelTask,
    onDismissTask,
    onRemoveTask,
    onGrantRead,
    onReopenTask,
    onPurgeOrphans,
  } = props;
  const { lines, phase } = useConsoleFeed(desk);
  const [now, setNow] = useState(clock);
  const [drawer, setDrawer] = useState<Drawer>(null);
  /**
   * 战果抽屉的粒度：null = 本轮全部，给了单号 = 只看这一张单的战果。
   * 四个入口（告警 / 锁定卡 / 产出卡 / 全部）点开必须看到不同东西，
   * 否则"每张单的战果都长一样" —— 那是没传上下文，不是数据重复。
   */
  const [resultJob, setResultJob] = useState<{ id: string; ref?: string } | null>(null);
  /** 打开战果：不传单号就是本轮汇总；传 ref 就连那件产物一起标出来 */
  const openResult = (jobId?: string, ref?: string) => {
    setResultJob(jobId ? { id: jobId, ref } : null);
    setDrawer("result");
  };
  /**
   * 产物预览：点产出卡直接开内置预览（md/代码渲染、图片内嵌、csv 出表），
   * 不再跳到"这张单的战果"里让用户自己点第二下。
   */
  const [previewFile, setPreviewFile] = useState<{ taskId: string; ref: string } | null>(null);
  const [draft, setDraft] = useState("");
  /** cd 回执（成功/失败都写在底栏，不吞） */
  const [cdMsg, setCdMsg] = useState("");
  /** 球面锁定卡：位置在点击时按容器尺寸算好，跟着节点走 */
  const [picked, setPicked] = useState<{ job: DeskJob; left: number; top: number } | null>(null);
  /** 已上膛的删除（第一下上膛、第二下执行）：不可恢复的动作不做静默单击 */
  const [armedRemove, setArmedRemove] = useState<string | null>(null);
  /** 终止本群同样两段确认：3.6 秒内不点第二下自动收回（与值台标题栏同一手感） */
  const [armedHalt, setArmedHalt] = useState(false);
  /** 全量 / 节点（只留锁定那一簇） */
  const [scope, setScope] = useState<"all" | "node">("all");
  /** 中列流水栏：与原型一致，默认收着（A/B 用顶栏「流水」切换） */
  const [streamOn, setStreamOn] = useState(false);
  const [stats, setStats] = useState({ nodes: 0, links: 0, fps: 0 });
  /** 打回三要素：后端强制要求，有预填就带出来让用户改，没有就空着等他写 */
  const [reject, setReject] = useState<{
    id: string;
    what: string;
    expect: string;
    deadline: string;
  } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const mapRef = useRef<HTMLDivElement>(null);

  // 时钟：1 秒一跳，卸载即清（禁用插件后不留定时器）
  useEffect(() => {
    const t = window.setInterval(() => setNow(clock()), 1000);
    return () => window.clearInterval(t);
  }, []);

  // 「确认终止」3.6 秒后自己收回：上膛不能永久挂着
  useEffect(() => {
    if (!armedHalt) return;
    const t = window.setTimeout(() => setArmedHalt(false), 3600);
    return () => window.clearTimeout(t);
  }, [armedHalt]);

  // Esc：先收抽屉 → 再解锁节点 → 最后退值台
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (drawer) setDrawer(null);
      else if (picked) setPicked(null);
      else onExit();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawer, picked, onExit]);

  /** 本群的单（2026-11-15）：控制台不再把别群的单算进任务/待办/球面 */
  const mine = useMemo(() => jobsInThread(desk), [desk]);
  const active = useMemo(() => mine.filter((j) => j.group !== "archived"), [mine]);
  /** 能直接拍板的单（in_review）：验收 / 打回 */
  const waiting = useMemo(() => active.filter((j) => j.group === "waiting"), [active]);
  /**
   * 卡住的单（blocked）：用户不必动手，但必须知道。值台把它放在右栏印章的第一等位置，
   * 控制台此前既不算待办、也不触发告警，卡到半小时用户可能永远看不见。
   */
  const stuck = useMemo(() => active.filter((j) => j.group === "stuck"), [active]);
  /** 别群在办的张数：只报个数（不混进待办、不参与播报），点开值台才能管 */
  const others = desk.jobs.filter((j) => j.group !== "archived" && j.threadId && j.threadId !== desk.thread.id).length;
  const pending = desk.decisions;
  const halted = Boolean(desk.thread.halted);
  /**
   * 有效相位：只要有单在等你验收、或有事等你拍板，印章就必须先报「待你拍板」。
   * 光靠 turn.phase 不够——成员交完回报后 turn 可能已经回 idle，单子却还挂在台账里等验收，
   * 那时印章显示「侦听中」会让人以为没事，实际全在主界面上等你。
   * 没有待判的事、但有单卡住时，印章报「卡点」——那也是用户在等的一个答案。
   */
  const phaseEff = pending.length > 0 || waiting.length > 0 ? "decide" : stuck.length > 0 ? "intervene" : phase;
  /** 只有卡住（没有待拍板/待验收）：文案说"卡点"，颜色仍是朱砂（用户 2026-11-15 拍板：卡住=朱砂） */
  const stuckOnly = stuck.length > 0 && pending.length === 0 && waiting.length === 0;
  const turnBusy = desk.turn.busy;
  const ctxPct = desk.usage.contextPercent ?? null;
  const currentJobId = desk.turn.taskId ?? null;

  /** 风铃头上的读数：在跑就报本轮已用时（真实 startedAt），闲着报上下文占用 */
  const since = useMemo(() => {
    if (!turnBusy || !desk.turn.startedAt) return ctxPct === null ? "待命" : `${ctxPct}%`;
    const t = new Date(desk.turn.startedAt).getTime();
    if (Number.isNaN(t)) return "—";
    // now 每秒跳一次，这里只是让"已用时"跟着走（不做假数据，起点就是后端的 startedAt）
    const sec = Math.max(0, Math.floor((Date.now() - t) / 1000));
    return `${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`;
  }, [turnBusy, desk.turn.startedAt, ctxPct, now]);

  /**
   * 「来令」= 你下达、她还没捞走的命令。
   * 累计 = 会话里你说过的话 + 池里待捞；已捞 = 两者之差（后端没有单独的"已捞"计数，别编一个）。
   */
  const orders = useMemo(() => {
    const live = desk.queue.map((x) => ({ id: x.id, text: x.text, at: fmtTime(x.at) }));
    const said = desk.feed.filter((c) => c.kind === "user").length;
    const total = said + live.length;
    return { live, total, taken: Math.max(0, total - live.length) };
  }, [desk.queue, desk.feed]);

  /** 每张单底下挂的命令支线：来自真实对话流里带 jobId 的你说的话 */
  const cmdsOf = (jobId: string) =>
    desk.feed
      .filter((c) => c.kind === "user" && c.jobId === jobId)
      .slice(-3)
      .map((c) => ({ id: c.id, text: c.text ?? "" }));

  /** 每张单真实吃进的命令条数（归并刻度用，不截断，但单块最多画 8 格） */
  const cmdCount = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of desk.feed) {
      if (c.kind !== "user" || !c.jobId) continue;
      m.set(c.jobId, (m.get(c.jobId) ?? 0) + 1);
    }
    return m;
  }, [desk.feed]);
  const mergeCmds = active.reduce((n, j) => n + (cmdCount.get(j.id) ?? 0), 0);

  /**
   * 产出柜 = 真实落盘的交付物，与值台交付箱同一口径（model.outputsOf，2026-11-15 抽出）：
   *  1. 只认 deliverables（用户要带走的东西），command 证据不是产物；
   *  2. 按**解析后的绝对路径**合并 —— 此前按 ref（artifacts/report.md）合并，会把
   *     两张单的同名产物并成一张，点开看到的是别人的副本；
   *  3. **含归档单**：验收归档之后产物不会从柜子里消失（此前只扫非归档单）。
   */
  const allOutputs = useMemo(() => outputsOf(desk), [desk]);
  /** 柜面只铺最近 6 件（一屏看得完），全部在「全部 N 件」的战果抽屉里 */
  const outputs = useMemo(() => allOutputs.slice(0, 6), [allOutputs]);

  /** 流水栏：优先锁定单，其次当前回合单，最后是第一张在办单 */
  const streamJobId = picked?.job.id ?? currentJobId ?? active[0]?.id ?? null;
  const streamLines = useMemo(() => {
    if (!streamJobId) return lines.slice(-5);
    const mine = lines.filter((l) => l.jobId === streamJobId);
    // 事件里很多行没有 jobId（频道级的工具/思考）：按单过滤为空就退回最近 5 条
    return (mine.length ? mine : lines).slice(-5);
  }, [lines, streamJobId]);

  /** 节点视图要有锁定目标，没有就退回全量 */
  const focusJobId = picked?.job.id ?? currentJobId ?? null;

  /**
   * 一张单现在**真的需要你做的事**（口径与值台印章一致）：
   *   waiting（待判）→ 验收 / 打回
   *   stuck（卡住）→ 只能止损停下：没有交付物，收下等于无证据归档，所以绝不出现"验收"
   *   running / queued → 停下
   * 「授权目录」不是解卡手段，放锁定卡里当附加工具。
   */
  const actsOf = (job?: DeskJob): Act[] => {
    const out: Act[] = [];
    if (!job) return out;
    if (job.group === "waiting") {
      out.push({ key: "ok", label: "验收", tone: "ok", run: () => onDecision(job.id, "approve") });
      out.push({
        key: "no",
        label: "打回",
        run: () =>
          setReject({
            id: job.id,
            what: job.rejectDraft?.what ?? "",
            expect: job.rejectDraft?.expect ?? "",
            deadline: job.rejectDraft?.deadline ?? "",
          }),
      });
    }
    // 卡住由风铃处置（同一单重做 / 换策略 / 关单 / 汇报），不再把「取消归档」摆给用户。
    if (job.group === "running" || job.group === "queued") {
      out.push({ key: "stop", label: "停下", run: () => onCancelTask(job.id) });
    }
    return out;
  };

  /**
   * 战果抽屉底部能就地办的事：验收 / 停掉止损 / 停下，归档单给「重开」。
   * 打回要填三要素，不在这放（转处置抽屉），免得点了没反应。
   */
  const resultActs = ((): Act[] => {
    if (!resultJob) return [];
    const j = desk.jobs.find((x) => x.id === resultJob.id);
    const list = actsOf(j);
    if (j && j.group === "archived") {
      list.push({ key: "reopen", label: "重开这张单", run: () => onReopenTask(j.id) });
    }
    return list.filter((a) => a.key !== "no");
  })();

  /** 卡住的单最怕"看着像在干活其实早停了"：把卡了多久直接写在卡上，过 30 分钟转红。
   *  时间取 Date.now()，`now` 只是每秒跳一次的触发器（它变了这张卡才会重算）。 */
  const staleOf = (job: DeskJob): { text: string; hot: boolean } | null => {
    if (job.group !== "stuck" || !job.at) return null;
    const t = new Date(job.at).getTime();
    if (Number.isNaN(t)) return null;
    const min = Math.floor((Date.now() - t) / 60000);
    if (min < 1) return { text: "刚刚", hot: false };
    const h = Math.floor(min / 60);
    // 状态标签已经是「卡住」了，这里只补时长，不重复那两个字
    const text = h >= 1 ? `${h} 时${min % 60 ? ` ${min % 60} 分` : ""}` : `${min} 分`;
    return { text, hot: min >= 30 };
  };

  const submitReject = () => {
    if (!reject) return;
    const what = reject.what.trim();
    const expect = reject.expect.trim();
    const deadline = reject.deadline.trim();
    if (!what || !expect || !deadline) return;
    onDecision(reject.id, "reject", { what, expect, deadline });
    setReject(null);
  };

  /** 空命令也允许点：不发送，只把焦点放回输入框（原型里这枚按钮永远实心，不做灰化） */
  const send = () => {
    const text = draft.trim();
    if (!text) {
      inputRef.current?.focus();
      return;
    }
    // 控制台也认 `cd`：不改命令，只改这个会话的工作区（与顶栏 chip 同一个 RPC）
    const cd = /^\/?cd(?:\s+([\s\S]*))?$/i.exec(text);
    if (cd && onCd) {
      setDraft("");
      setCdMsg("…");
      void onCd((cd[1] ?? "").trim())
        .then((msg) => setCdMsg(msg))
        .catch((err) => setCdMsg(`cd 失败：${err instanceof Error ? err.message : String(err)}`));
      inputRef.current?.focus();
      return;
    }
    onSend(text);
    setDraft("");
    inputRef.current?.focus();
  };

  const pickJob = (jobId: string | null, at?: { x: number; y: number }) => {
    // 换单就复位"确认删除"：上膛状态不能跨单留在界面上
    setArmedRemove(null);
    if (!jobId) {
      setPicked(null);
      return;
    }
    const job = active.find((j) => j.id === jobId);
    if (!job) return;
    const box = mapRef.current;
    const W = box?.clientWidth ?? 0;
    const H = box?.clientHeight ?? 0;
    // 从左侧台账点进来没有坐标：贴球面右侧，避开球心告警
    const x = at?.x ?? W * 0.6;
    const y = at?.y ?? H * 0.2;
    const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
    setPicked({
      job,
      left: clamp(x + 22, 12, Math.max(12, W - 292)),
      top: clamp(y - 56, 12, Math.max(12, H - 340)),
    });
  };

  return (
    <div className="cs-shell">
      <header className="cs-top">
        <div className="cs-top-l">
          <span className="cs-brand">LYNN</span>
          <span className="cs-div" />
          <span className="cs-thread" title={desk.thread.title || "没有会话"}>
            {desk.thread.title || "没有会话"}
          </span>
          {/* 项目身份（2026-11-15）：在控制台发一条命令，得知道它动的是哪个目录 */}
          <span
            className="cs-proj mono"
            title={[
              desk.workspaceProjectName ? `项目：${desk.workspaceProjectName}` : "",
              desk.workspacePrimary ?? "本次不用工作区（产出落任务卷宗）",
              desk.workspaceExtras.length ? `+${desk.workspaceExtras.length} 个只读/附加根` : "",
            ]
              .filter(Boolean)
              .join("\n")}
          >
            {desk.workspaceProjectName || desk.project || "未选目录"}
          </span>
          {halted ? (
            <span className="cs-live halted" title="本群已终止：成员、心跳、巡检与验收叫醒都停了。发一条消息即可恢复。">
              <i />
              已终止
            </span>
          ) : (
            <span className={`cs-live${turnBusy ? " on" : ""}`}>
              <i />
              {turnBusy ? "在跑" : "侦听"}
            </span>
          )}
          {/* 军印的顶栏缩写：窄窗才出现（宽窗右栏有完整军印，不重复） */}
          <button
            type="button"
            className={`cs-seal-mini${pending.length + waiting.length + stuck.length ? " hot" : ""}`}
            onClick={() => setDrawer(pending.length || waiting.length || stuck.length ? "decide" : "result")}
            title={
              pending.length + waiting.length
                ? "有需要你动手的事（拍板 / 验收）"
                : stuck.length
                  ? `${stuck.length} 张单卡住了，点开看是重做还是收尾`
                  : "她很安静，点开看最近战果"
            }
          >
            {pending.length + waiting.length
              ? `待办 ${pending.length + waiting.length}`
              : stuck.length
                ? `卡点 ${stuck.length}`
                : "侦听中"}
          </button>
        </div>
        <div className="cs-top-r">
          <span className="cs-readout">
            任务<b>{active.length}</b>
          </span>
          <span className={`cs-readout hot${pending.length + waiting.length ? " on" : ""}`}>
            待办<b>{pending.length + waiting.length}</b>
          </span>
          {/* 卡住的单：不动手，但必须看得见（此前既不计数也不告警） */}
          {stuck.length > 0 && (
            <span className="cs-readout bad" title="成员卡住了：点开看是哪张单，风铃会处置">
              卡住<b>{stuck.length}</b>
            </span>
          )}
          {/* 别群在办的张数：只报个数，不混进待办（语音也只播本群，避免"屏幕上有、耳朵里没有"） */}
          {others > 0 && (
            <span className="cs-readout quiet" title={`其他群还有 ${others} 张在办：切到那个群才管得了，也不会播报`}>
              别群<b>{others}</b>
            </span>
          )}
          <button
            type="button"
            className={`cs-tool${desk.orphans > 0 ? " alert" : ""}`}
            onClick={() => setDrawer("archive")}
            title={
              desk.orphans > 0
                ? `档案里有 ${desk.orphans} 张无主单（所属会话已删），可以一起清掉`
                : "已完成任务档案"
            }
          >
            档案
            {desk.orphans > 0 && <i className="cs-tool-dot" />}
          </button>
          <button type="button" className="cs-tool" onClick={() => setDrawer("usage")}>
            用量
          </button>
          <button type="button" className="cs-tool" onClick={() => setDrawer("config")}>
            配置
          </button>
          <button
            type="button"
            className={`cs-tool${streamOn ? " on" : ""}`}
            aria-pressed={streamOn}
            onClick={() => setStreamOn(!streamOn)}
            title="中列流水栏：显示 / 去掉"
          >
            流水
          </button>
          <span className="cs-clock mono">{now}</span>
          <button type="button" className="cs-tool back" onClick={onExit} title="退回值台（Esc）">
            <span aria-hidden="true">‹</span> 值台
          </button>
          {/* 自绘窗口按钮（frame:false）：拖动由 .cs-top 的 -webkit-app-region: drag 提供 */}
          <WindowControls />
        </div>
      </header>

      <div className="cs-cols">
        {/* ================= 左：来令 + 战局 ================= */}
        <section className="cs-col left">
          <div className="cs-panel intel">
            <div className="cs-panel-h">
              <h2>来令</h2>
              <span className="sub mono">{orders.live.length} 条</span>
            </div>
            <div className="cs-panel-b">
              {orders.live.length === 0 ? (
                <div className="cs-idle">
                  <div className="cs-radar" aria-hidden="true">
                    <span className="ring" />
                    <span className="sweep" />
                  </div>
                  <div className="cs-idle-t">
                    侦听中 <b>···</b>
                  </div>
                  <div className="cs-idle-s mono">最后信号 {hhmm(desk.queue[desk.queue.length - 1]?.at)}</div>
                </div>
              ) : (
                orders.live.map((c) => (
                  <div className="cs-order" key={c.id}>
                    <div className="cs-order-r1">
                      <span className="cs-cid mono">{shortId(c.id)}</span>
                      <span className="cs-ctime mono">{c.at.slice(-8)}</span>
                    </div>
                    <div className="cs-order-t">{c.text}</div>
                    <div className="cs-order-r2">
                      <i />
                      待风铃捞取
                    </div>
                  </div>
                ))
              )}
            </div>
            <div className="cs-panel-foot mono">
              累计 <b>{orders.total}</b> · 已捞 <b>{orders.taken}</b> · 在池 <b>{orders.live.length}</b>
            </div>
          </div>

          <div className="cs-panel grow">
            <div className="cs-panel-h">
              <h2>战局</h2>
              <span className="sub mono">
                {active.length} 在办 / {desk.archived.length} 归档
              </span>
            </div>
            <div className="cs-panel-b">
              {turnBusy && (
                <div className="cs-analyzing">
                  <i />
                  <span>
                    {desk.turn.taskId ? shortId(desk.turn.taskId) : "新令"} 已受理 · 参谋拆解中
                  </span>
                  <span className="mono">ANALYZING</span>
                </div>
              )}
              {active.length === 0 ? (
                <div className="cs-idle small">
                  <div className="cs-idle-t">还没有受理的单</div>
                  <div className="cs-idle-s mono">NO ACTIVE TASK</div>
                </div>
              ) : (
                active.map((j) => (
                  <TaskCard
                    key={j.id}
                    job={j}
                    cmds={cmdsOf(j.id)}
                    picked={picked?.job.id === j.id}
                    onPick={() => pickJob(j.id)}
                    acts={actsOf(j)}
                    stale={staleOf(j)}
                    reject={reject?.id === j.id ? reject : null}
                    onRejectChange={(patch) =>
                      setReject((cur) => (cur && cur.id === j.id ? { ...cur, ...patch } : cur))
                    }
                    onRejectSubmit={submitReject}
                    onRejectCancel={() => setReject(null)}
                  />
                ))
              )}
              {active.length > 0 && (
                <div className="cs-ms">
                  <div className="cs-ms-h mono">
                    归并刻度 / {mergeCmds} 命令 → {active.length} 任务
                  </div>
                  <div className="cs-ms-track">
                    {active.map((j) => {
                      const n = Math.min(8, Math.max(1, cmdCount.get(j.id) ?? 0));
                      const k =
                        j.group === "running"
                          ? "live"
                          : j.group === "stuck"
                            ? "bad"
                            : j.group === "queued"
                              ? "off"
                              : "";
                      return (
                        <span className="cs-ms-seg" key={j.id} title={j.title}>
                          {Array.from({ length: n }, (_, i) => (
                            <i key={i} className={k} />
                          ))}
                        </span>
                      );
                    })}
                  </div>
                </div>
              )}
              {desk.archived.length > 0 && (
                <div className="cs-arc-strip">
                  <div className="cs-arc-h mono">归档 · {desk.archived.length} 项 · 点开看结果</div>
                  {desk.archived.slice(-4).map((a) => (
                    <button
                      type="button"
                      key={a.id}
                      className="cs-ar-row"
                      onClick={() => setDrawer("archive")}
                    >
                      <span className="cs-ar-id mono">{shortId(a.id)}</span>
                      <span className="cs-ar-t">{a.title}</span>
                      <span className="cs-ar-m mono">档</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </section>

        {/* ================= 中：态势球 + 流水 ================= */}
        <section className="cs-col center">
          <div className="cs-map-wrap" ref={mapRef}>
            <Field
              desk={desk}
              scope={scope}
              focusId={picked?.job.id ?? currentJobId}
              onPick={pickJob}
              onStats={setStats}
            />

            <div className="cs-map-head">
              <h2>态势</h2>
              <button
                type="button"
                className={`cs-linkbtn${scope === "all" ? " on" : ""}`}
                onClick={() => setScope("all")}
              >
                全量
              </button>
              <button
                type="button"
                className={`cs-linkbtn${scope === "node" ? " on" : ""}`}
                onClick={() => focusJobId && setScope("node")}
                disabled={!focusJobId}
                title={focusJobId ? "只看锁定节点那一簇" : "先在战局里点一张单，或点球面上的节点"}
              >
                节点
              </button>
            </div>
            <div className="cs-map-hint mono">
              点节点锁定 · 拖动拨动球面 <kbd>Esc</kbd>
            </div>
            <div className="cs-map-legend">
              <span>
                <i className="lg done" />
                已核
              </span>
              <span>
                <i className="lg live" />
                推进
              </span>
              <span>
                <i className="lg alert" />
                卡点
              </span>
              <span>
                <i className="lg idle" />
                待办
              </span>
            </div>
            <div className="cs-map-sig mono">
              节点 <b>{stats.nodes}</b> · 链路 <b>{stats.links}</b> · 帧 <b>{stats.fps}</b>
            </div>

            <Stream side="left" lines={lines.filter((l) => l.kind !== "cmd")} max={7} />
            <Stream side="right" lines={lines.filter((l) => l.kind === "cmd" || l.kind === "tool")} max={5} />

            {/* 球心告警：待判 / 待验收 / 卡住三类都压在球心；一旦锁定某张单，让位给详情卡。
                凡是需要用户动手（或必须知情）的，都必须在这里一步直达——不能只藏在角落里让人到处找。 */}
            {(pending.length > 0 || waiting.length > 0 || stuck.length > 0) && !picked && (
              <div className="cs-alert">
                <div className="cs-alert-top">
                  <i className="cs-alert-led" />
                  {stuckOnly ? "ALERT / 卡点" : "ALERT / 需介入"}
                  <span className="n mono">{String(pending.length + waiting.length + stuck.length).padStart(2, "0")}</span>
                </div>
                <div className="cs-alert-t">
                  {pending.length > 0
                    ? pending.length > 1
                      ? `${pending.length} 项待你拍板 · 风铃已停在卡点`
                      : "风铃已停在当前节点，等待拍板"
                    : waiting.length > 0
                      ? `${waiting.length} 张交付等你验收 · 成员已交回报`
                      : `${stuck.length} 张单卡住了 · 风铃会自己判断重做还是收尾`}
                </div>
                <div className="cs-alert-d mono">
                  {pending.length > 0
                    ? `${pending[0].who} · ${pending[0].question}`
                    : waiting.length > 0
                      ? `${shortId(waiting[0].id)} · ${waiting[0].title}`
                      : `${shortId(stuck[0].id)} · ${stuck[0].title}${stuck[0].statusNote ? ` · ${stuck[0].statusNote}` : ""}`}
                </div>
                <div className="cs-alert-acts">
                  <button
                    type="button"
                    onClick={() => (pending.length > 0 || waiting.length > 0 ? setDrawer("decide") : pickJob(stuck[0].id))}
                  >
                    {pending.length > 0 ? "查看并处置" : waiting.length > 0 ? "去验收" : "看这张单"}
                  </button>
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => openResult(pending.length === 0 && waiting.length === 0 ? stuck[0].id : undefined)}
                  >
                    看战果
                  </button>
                </div>
              </div>
            )}

            {/* 锁定卡：贴在点中的节点旁边，不铺满球面 */}
            {picked && (
              <div className="cs-focus" style={{ left: picked.left, top: picked.top }}>
                <div className="cs-focus-h">
                  <span className="mono">{shortId(picked.job.id)}</span>
                  <span className="cs-focus-tag">锁定</span>
                  <button type="button" className="cs-x" onClick={() => setPicked(null)}>
                    解锁
                  </button>
                </div>
                <div className="cs-focus-t">{picked.job.title}</div>
                <dl className="cs-focus-grid">
                  <dt>状态</dt>
                  <dd>{picked.job.statusLabel}</dd>
                  <dt>席位</dt>
                  <dd>{picked.job.member ?? "未派"}</dd>
                  <dt>阶段</dt>
                  <dd>{picked.job.stage}/4</dd>
                  <dt>证据</dt>
                  <dd>{picked.job.evidenceCount} 条</dd>
                  <dt>打回</dt>
                  <dd>
                    {picked.job.rejections}/{picked.job.rejectLimit}
                  </dd>
                </dl>
                {picked.job.statusNote && <div className="cs-focus-note">{picked.job.statusNote}</div>}
                <div className="cs-focus-acts">
                  {actsOf(picked.job).map((a) => (
                    <button
                      key={a.key}
                      type="button"
                      className={`cs-act${a.tone ? ` ${a.tone}` : ""}`}
                      onClick={a.run}
                    >
                      {a.label}
                    </button>
                  ))}
                  <button type="button" className="cs-act" onClick={() => openResult(picked.job.id)}>
                    战果
                  </button>
                  <button
                    type="button"
                    className="cs-act"
                    title="给她授权一个只读目录（目录由你在系统选择框里点）"
                    onClick={() => onGrantRead(picked.job.id)}
                  >
                    授权目录
                  </button>
                  {/* 撤下 vs 删除：撤下只从台账拿走，卷宗还在；删除连卷宗一起没，所以放最后 */}
                  <button
                    type="button"
                    className="cs-act"
                    title="从台账撤下这张单，卷宗保留"
                    onClick={() => {
                      onDismissTask(picked.job.id);
                      setPicked(null);
                    }}
                  >
                    撤下
                  </button>
                  <button
                    type="button"
                    className="cs-act bad"
                    title="彻底删除这张单（含卷宗）"
                    onClick={() => {
                      // 不可恢复：第一下只上膛，第二下才删（同一张单之外点别的单会自动复位）
                      if (armedRemove !== picked.job.id) {
                        setArmedRemove(picked.job.id);
                        return;
                      }
                      onRemoveTask(picked.job.id);
                      setArmedRemove(null);
                      setPicked(null);
                    }}
                  >
                    {armedRemove === picked.job.id ? "确认删除" : "删除"}
                  </button>
                </div>
              </div>
            )}
          </div>

          {streamOn && (
            <div className="cs-stream">
              <div className="cs-stream-h">
                <h3>流水</h3>
                <span className="loc mono">
                  {streamJobId ? shortId(streamJobId) : "—"} / 执行
                </span>
              </div>
              <div className={`cs-stream-lines${streamLines.length === 0 ? " is-empty" : ""}`}>
                {streamLines.length === 0 ? (
                  <div className="cs-line empty">该节点暂无流水 · 点图上节点可调阅其他节点</div>
                ) : (
                  streamLines.map((l) => (
                    <div className={`cs-line lv-${l.kind === "alert" ? "hot" : l.kind === "done" ? "ok" : ""}`} key={l.id}>
                      <span className="cs-line-ts mono">{hhmm(new Date(l.at).toISOString())}</span>
                      <span className="cs-line-tx">{l.text || "…"}</span>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </section>

        {/* ================= 右：风铃 + 产出 ================= */}
        <section className="cs-col right">
          <div className="cs-panel lynn-panel">
            <div className="cs-panel-h">
              <h2>风铃</h2>
              <span className="sub mono" title={turnBusy ? "本轮已用时" : "上下文占用"}>
                {since}
              </span>
            </div>
            <div className="cs-lynn">
              <LynnCore
                phase={phaseEff}
                onClick={() => setDrawer(pending.length || waiting.length || stuck.length ? "decide" : "result")}
              />
            </div>
            <div className="cs-lynn-foot">
              <span className="cs-lynn-state">
                <b>
                  {phaseEff === "decide"
                    ? "待你拍板"
                    : phaseEff === "intervene"
                      ? "卡点"
                      : turnBusy
                        ? "在推进"
                        : "侦听中"}
                </b>
                <span className="cs-beat" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>
              </span>
              <button type="button" className="cs-linkbtn" onClick={onOpenSettings}>
                提示词
              </button>
            </div>
          </div>

          <div className="cs-panel grow">
            <div className="cs-panel-h">
              <h2>产出</h2>
              <button type="button" className="cs-linkbtn" onClick={() => openResult()}>
                全部 {allOutputs.length} 件
              </button>
            </div>
            <div className="cs-panel-b">
              {outputs.length === 0 ? (
                <div className="cs-idle small">
                  <div className="cs-idle-t">还没有产物</div>
                  <div className="cs-idle-s mono">NO ARTIFACT YET</div>
                </div>
              ) : (
                <div className="cs-out-grid">
                  {outputs.map((o) => (
                    <OutCard
                      key={o.abs}
                      item={o}
                      onOpen={() => setPreviewFile({ taskId: o.job.id, ref: o.ref })}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>
        </section>
      </div>

      {/* ================= 底栏：权限档 + 下令 ================= */}
      <footer className="cs-bottom">
        <div className="cs-modes" role="group" aria-label="权限档">
          {PERMISSIONS.map((m) => (
            <button
              type="button"
              key={m}
              className={m === "full" ? "danger" : undefined}
              aria-pressed={permission === m}
              onClick={() => onPermission(m)}
              title={`切到 ${PERMISSION_LABEL[m]}（${m}）`}
            >
              {PERMISSION_LABEL[m]}
            </button>
          ))}
        </div>
        <div className="cs-cmdline">
          <input
            ref={inputRef}
            value={draft}
            placeholder={configured ? "下达命令" : "还没配置模型：先去设置填 Key"}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
          />
          <span className="cs-keycap mono">Enter</span>
          {cdMsg && (
            <span className="cs-cdmsg mono" title={cdMsg}>
              {cdMsg}
            </span>
          )}
        </div>
        {/* 整群止损：已终止时只报状态（发一条消息即恢复），没终止才给两段确认的按钮 */}
        {halted ? (
          <span className="cs-halt-note mono" title="成员、心跳、巡检与验收叫醒都停了；在这个群发一条消息即可恢复。">
            已终止 · 发消息恢复
          </span>
        ) : onHalt ? (
          <button
            type="button"
            className={`cs-halt${armedHalt ? " armed" : ""}`}
            title={armedHalt ? "再点一次：本群所有在跑的成员与后台巡检立即停机" : "终止本群（不只是这一轮）"}
            onClick={() => {
              if (armedHalt) {
                setArmedHalt(false);
                onHalt();
                return;
              }
              setArmedHalt(true);
            }}
          >
            {armedHalt ? "确认终止" : "终止本群"}
          </button>
        ) : null}
        {turnBusy ? (
          <button type="button" className="cs-send stop" onClick={onAbort}>
            停止
          </button>
        ) : (
          <button type="button" className="cs-send" onClick={send}>
            派出
          </button>
        )}
      </footer>

      {/* ================= 抽屉：一层直达 ================= */}
      {drawer && (
        <div className="cs-scrim" onClick={() => setDrawer(null)} role="presentation">
          <aside className="cs-drawer" onClick={(e) => e.stopPropagation()}>
            <div className="cs-drawer-h">
              <span className="cs-cap mono">
                {drawer === "result"
                  ? resultJob
                    ? shortId(resultJob.id)
                    : "战果"
                  : drawer === "decide"
                    ? "处置"
                    : drawer === "usage"
                      ? "用量"
                      : drawer === "config"
                        ? "配置"
                        : "档案"}
              </span>
              <h2>
                {drawer === "decide"
                  ? `${pending.length + waiting.length + stuck.length} 件等你处置`
                  : drawer === "result"
                    ? resultJob
                      ? (desk.jobs.find((j) => j.id === resultJob.id)?.title ?? "这张单的战果")
                      : "全部交付"
                    : drawer === "usage"
                      ? "Token 与缓存"
                      : drawer === "config"
                        ? "运行 / 界面"
                        : "归档清单"}
              </h2>
              <button type="button" className="cs-x" onClick={() => setDrawer(null)}>
                关闭
              </button>
            </div>
            <div className="cs-drawer-b">
              {drawer === "result" && (
                <ResultTab
                  desk={desk}
                  lines={lines}
                  jobId={resultJob?.id}
                  focusRef={resultJob?.ref}
                  /* 单张战果底部能就地办的事：验收 / 停掉止损 / 停下 / 重开（打回要填三要素，转处置抽屉） */
                  acts={resultActs}
                  onMore={() => setDrawer("decide")}
                  onOpenFile={(taskId, ref) => setPreviewFile({ taskId, ref })}
                />
              )}
              {drawer === "decide" &&
                (pending.length === 0 && waiting.length === 0 && stuck.length === 0 ? (
                  <div className="cs-note">没有待判的事，她在自己推进。</div>
                ) : (
                  <>
                    {/* 先给能直接拍板的单：验收 / 打回，不用再去值台找。
                        验收前必须看得见**要收什么**：交付物、证据核了几条、这是第几次打回。 */}
                    {waiting.map((j) => {
                      const verified = j.evidence.filter((e) => e.verified).length;
                      const files = (j.deliverables ?? []).map((d) => baseName(d.path || d.ref));
                      return (
                        <div className="cs-dj" key={j.id}>
                          <div className="cs-dj-h">
                            <span className="mono">{shortId(j.id)}</span>
                            <span className="cs-dj-t">{j.title}</span>
                            <span className="cs-dj-m mono">{j.member ?? "未派"}</span>
                          </div>
                          <div className="cs-dj-proof mono">
                            第 {j.round ?? 1} 轮 · 打回 {j.rejections}/{j.rejectLimit} · 证据已核{" "}
                            {verified}/{j.evidenceCount} · 交付物 {files.length} 件
                          </div>
                          {files.length > 0 && (
                            <div className="cs-dj-files mono" title={files.join("\n")}>
                              {files.slice(0, 3).join("、")}
                              {files.length > 3 ? ` 等 ${files.length} 件` : ""}
                            </div>
                          )}
                          {j.statusNote && <div className="cs-dj-note">{j.statusNote}</div>}
                          {reject?.id === j.id ? (
                            <RejectForm
                              reject={reject}
                              onChange={(patch) =>
                                setReject((cur) => (cur && cur.id === j.id ? { ...cur, ...patch } : cur))
                              }
                              onSubmit={submitReject}
                              onCancel={() => setReject(null)}
                            />
                          ) : (
                            <div className="cs-dj-acts">
                              <button
                                type="button"
                                className="cs-act"
                                onClick={() => {
                                  setResultJob({ id: j.id });
                                  setDrawer("result");
                                }}
                              >
                                看交付物
                              </button>
                              {actsOf(j).map((a) => (
                                <button
                                  key={a.key}
                                  type="button"
                                  className={`cs-act${a.tone ? ` ${a.tone}` : ""}`}
                                  onClick={a.run}
                                >
                                  {a.label}
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                    {/* 卡住的单：不用你动手，但必须看得见是谁、卡了多久、为什么（此前整块不出现在处置里） */}
                    {stuck.map((j) => (
                      <div className="cs-dj" key={j.id}>
                        <div className="cs-dj-h">
                          <span className="mono">{shortId(j.id)}</span>
                          <span className="cs-dj-t">{j.title}</span>
                          <span className="cs-dj-m mono">{j.member ?? "未派"}</span>
                        </div>
                        <div className="cs-dj-proof mono">
                          卡住{staleOf(j) ? ` ${staleOf(j)!.text}` : ""} · 证据 {j.evidenceCount} 条 · 交付物{" "}
                          {(j.deliverables ?? []).length} 件
                        </div>
                        {j.statusNote && <div className="cs-dj-note">{j.statusNote}</div>}
                        <div className="cs-dj-acts">
                          <button
                            type="button"
                            className="cs-act"
                            onClick={() => {
                              setDrawer(null);
                              pickJob(j.id);
                            }}
                          >
                            看这张单
                          </button>
                          <button
                            type="button"
                            className="cs-act"
                            title="给卡住的单授权一个只读目录（目录由你在系统选择框里点）"
                            onClick={() => onGrantRead(j.id)}
                          >
                            授权目录
                          </button>
                          <button type="button" className="cs-act" onClick={() => onCancelTask(j.id)}>
                            停下
                          </button>
                        </div>
                      </div>
                    ))}
                    {pending.map((d) => (
                      <DecisionCard key={d.id} d={d} onResolve={onDecisionResolve} />
                    ))}
                  </>
                ))}
              {drawer === "usage" && <UsageTab desk={desk} />}
              {drawer === "config" && <ConfigTab desk={desk} onOpenSettings={onOpenSettings} />}
              {drawer === "archive" && (
                <ArchiveTab
                  desk={desk}
                  onPurgeOrphans={onPurgeOrphans}
                  onRemoveTask={onRemoveTask}
                  onOpen={(id) => {
                    setResultJob({ id });
                    setDrawer("result");
                  }}
                />
              )}
            </div>
          </aside>
        </div>
      )}

      {/* ================= 产物预览：点产出卡直接开，不跳二级 ================= */}
      {previewFile && (
        <PreviewDrawer
          taskId={previewFile.taskId}
          fileRef={previewFile.ref}
          onClose={() => setPreviewFile(null)}
        />
      )}
    </div>
  );
}

/** 打回三要素：后端强制要求（哪里不合格 / 期望是什么 / 多久内重交），缺一项发不出去 */
function RejectForm({
  reject,
  onChange,
  onSubmit,
  onCancel,
}: {
  reject: { what: string; expect: string; deadline: string };
  onChange: (patch: Partial<{ what: string; expect: string; deadline: string }>) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const ready = Boolean(reject.what.trim() && reject.expect.trim() && reject.deadline.trim());
  return (
    <div className="cs-reject" onClick={(e) => e.stopPropagation()} role="presentation">
      <label className="cs-rj-row">
        <span>哪里不合格</span>
        <input
          value={reject.what}
          onChange={(e) => onChange({ what: e.target.value })}
          placeholder="例：比价只覆盖两家"
        />
      </label>
      <label className="cs-rj-row">
        <span>期望是什么</span>
        <input
          value={reject.expect}
          onChange={(e) => onChange({ expect: e.target.value })}
          placeholder="例：补到五家并标交期"
        />
      </label>
      <label className="cs-rj-row">
        <span>多久内重交</span>
        <input
          value={reject.deadline}
          onChange={(e) => onChange({ deadline: e.target.value })}
          placeholder="例：今天 18:00 前"
        />
      </label>
      <div className="cs-rj-acts">
        {/* 打回是次级动作（值台 .btn-reject 也是中性），红只落在"第几次打回"这个读数上 */}
        <button type="button" className="cs-act" onClick={onSubmit} disabled={!ready}>
          发回去
        </button>
        <button type="button" className="cs-act" onClick={onCancel}>
          算了
        </button>
      </div>
    </div>
  );
}

/** 战局里的一张单：环形进度 + 目标 + 命令支线 + 动作 + 底脚 */
function TaskCard({
  job,
  cmds,
  picked,
  onPick,
  acts,
  stale,
  reject,
  onRejectChange,
  onRejectSubmit,
  onRejectCancel,
}: {
  job: DeskJob;
  cmds: { id: string; text: string }[];
  picked: boolean;
  onPick: () => void;
  acts: Act[];
  stale: { text: string; hot: boolean } | null;
  /** 非空 = 这张单正在填打回三要素 */
  reject: { what: string; expect: string; deadline: string } | null;
  onRejectChange: (patch: Partial<{ what: string; expect: string; deadline: string }>) => void;
  onRejectSubmit: () => void;
  onRejectCancel: () => void;
}) {
  const progress = Math.max(0, Math.min(1, job.stage / 4));
  const dash = 2 * Math.PI * 12;
  const blocked = job.status === "blocked";
  const done = job.status === "done";
  return (
    <div
      className={`cs-task${picked ? " on" : ""}${blocked ? " alert" : ""}`}
      role="button"
      tabIndex={0}
      onClick={onPick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onPick();
        }
      }}
      data-task={job.id}
    >
      <div className="cs-t-head">
        <span className="cs-t-id mono">{shortId(job.id)}</span>
        <span className="cs-t-title">{job.title}</span>
        <span className="cs-arc-wrap" aria-hidden="true">
          <svg className="cs-arc" viewBox="0 0 30 30">
            <circle cx="15" cy="15" r="12" />
            <circle
              className="f"
              cx="15"
              cy="15"
              r="12"
              strokeDasharray={dash}
              strokeDashoffset={dash * (1 - progress)}
            />
          </svg>
          <span className="cs-pct mono">{Math.round(progress * 100)}</span>
        </span>
      </div>
      {/* 状态与读数同一行：标题行只留编号 + 标题 + 进度环，窄列也读得全 */}
      <div className="cs-t-goal">
        <span className={`cs-t-state${blocked ? " blocked" : done ? " done" : ""}`}>
          {/* 待风铃验的单不能写「待审查」：那四个字在用户眼里等于"该我上了" */}
          {job.status === "in_review" && job.reviewer === "lynn" ? "风铃验中" : job.statusLabel}
        </span>
        {stale && <span className={`cs-t-stale${stale.hot ? " hot" : ""}`}>{stale.text}</span>}
        <span className="cs-t-note" title="第几轮 · 承办 · 证据 · 打回（剩下的重交次数）">
          {job.member ?? "未派"} · 第 {job.round ?? 1} 轮 · 证据 {job.evidenceCount} ·{" "}
          <span className={`cs-t-rej${job.rejections > 0 ? " hot" : ""}`}>
            打回 {job.rejections}/{job.rejectLimit}
          </span>
        </span>
      </div>
      {cmds.length > 0 && (
        <div className="cs-t-cmds">
          {cmds.map((c) => (
            <div className={`cs-cmd-row${done ? " on" : ""}${blocked ? " hot" : ""}`} key={c.id}>
              <span className="cs-cr-id mono">{c.id.slice(-4)}</span>
              <span className="cs-cr-txt">{c.text}</span>
              <span className="cs-ticks" aria-hidden="true">
                {[0, 1, 2, 3].map((i) => (
                  <i key={i} className={i < job.stage ? "on" : i === job.stage ? "live" : ""} />
                ))}
              </span>
              {done && <span className="cs-stamp ok">已完成</span>}
              {blocked && <span className="cs-stamp bad">需介入</span>}
            </div>
          ))}
        </div>
      )}

      {/* 打回三要素就地填：后端会校验，缺一项不许发 */}
      {reject && (
        <RejectForm
          reject={reject}
          onChange={onRejectChange}
          onSubmit={onRejectSubmit}
          onCancel={onRejectCancel}
        />
      )}

      {(acts.length > 0 || stale) && !reject && (
        <div className="cs-t-acts" onClick={(e) => e.stopPropagation()} role="presentation">
          {acts.map((a) => (
            <button
              key={a.key}
              type="button"
              className={`cs-act${a.tone ? ` ${a.tone}` : ""}`}
              onClick={a.run}
            >
              {a.label}
            </button>
          ))}
        </div>
      )}

      <div className="cs-t-foot mono">
        {cmds.length} 命令 · {job.evidenceCount} 证据 · {(job.deliverables ?? []).length} 交付
      </div>
    </div>
  );
}

/**
 * 证据的 ref 有两种形态：`artifacts/xxx` 是真文件；`kind: "command"` 那种是一整句命令输出。
 * 只有前者算产物 —— 把整句话当文件名画出来，就是上一版那屏「成员回报正文结论：…」噪音的来源。
 */
function isFileRef(ref: string | undefined): boolean {
  if (!ref) return false;
  if (/^artifacts\//.test(ref)) return true;
  if (/\s/.test(ref)) return false;
  return /\.[a-z0-9]{1,8}$/i.test(ref);
}

function baseName(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p;
}

function extOf(name: string): string {
  const m = /\.([a-z0-9]{1,8})$/i.exec(name);
  return m ? m[1].toLowerCase() : "";
}

/** 字节数 → 人能读的大小（不知道就留空，不写 0B 骗人） */
function fmtBytes(n?: number): string {
  if (!n || n <= 0) return "";
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
  if (n >= 1024) return `${Math.round(n / 1024)}KB`;
  return `${n}B`;
}

/**
 * 长文件名去掉没信息量的中段：「上海第二工业大学继续教育学院_毕业实习四方协议书_25工企Z11(2).docx」
 * 这类四张卡前缀完全一样，真正区分它们的是后段，扩展名必须保住。
 */
function shortName(name: string, max = 30): string {
  if (name.length <= max) return name;
  const ext = extOf(name);
  const stem = ext ? name.slice(0, name.length - ext.length - 1) : name;
  const tail = Math.max(10, max - ext.length - 8);
  return `${stem.slice(0, 6)}…${stem.slice(-tail)}${ext ? `.${ext}` : ""}`;
}

type FileKind = "image" | "text" | "doc" | "sheet" | "slides" | "pdf" | "code" | "other";

function fileKindOf(name: string): FileKind {
  const ext = extOf(name);
  if (/^(png|jpe?g|gif|webp|bmp|svg|avif)$/.test(ext)) return "image";
  if (/^(md|markdown|txt|log|csv|tsv|json|ya?ml|xml|ini)$/.test(ext)) return "text";
  if (/^(docx?|rtf|odt|wps)$/.test(ext)) return "doc";
  if (/^(xlsx?|xlsm|ods|et)$/.test(ext)) return "sheet";
  if (/^(pptx?|key|dps)$/.test(ext)) return "slides";
  if (ext === "pdf") return "pdf";
  if (/^(ts|tsx|js|jsx|mjs|cjs|rs|py|go|java|c|h|cpp|sh|ps1|sql|css|html?)$/.test(ext)) return "code";
  return "other";
}

/** 文本缩略：只留前 3 行非空内容再截断（卡面很小，塞多了就是糊） */
function excerptOf(text: string): string {
  return text
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+$/, ""))
    .filter((l) => l.trim())
    .slice(0, 3)
    .join("\n")
    .slice(0, 90);
}

/** 卡面缩略图：图片真渲染、文本给真摘要、其余给类型牌子。不再画随机骨架条——那不是预览，是装饰。 */
function useThumb(item: DeskOutput, kind: FileKind) {
  const [thumb, setThumb] = useState<{ dataUrl?: string; text?: string; bytes?: number }>({});
  useEffect(() => {
    if (kind !== "image" && kind !== "text" && kind !== "code") {
      setThumb({});
      return;
    }
    let gone = false;
    void window.lynn
      .rpc("preview.read", { taskId: item.job.id, ref: item.ref })
      .then((r) => {
        if (gone) return;
        const bytes = typeof r.bytes === "number" ? r.bytes : undefined;
        // 证据类产物没登记字节数：读一次顺手把真实大小补上，省掉再 stat 一趟
        if (r.ok === false) return setThumb({ bytes });
        if (r.kind === "image" && r.dataUrl) setThumb({ dataUrl: r.dataUrl, bytes });
        else if (r.kind === "text" && r.text) setThumb({ text: excerptOf(r.text), bytes });
        else setThumb({ bytes });
      })
      .catch(() => {
        /* 读不到就退回类型牌子，不在卡上报错 */
      });
    return () => {
      gone = true;
    };
  }, [item.job.id, item.ref, kind]);
  return thumb;
}

/** 产出卡：缩略图在上（真内容），下面是文件名 + 类型/大小；点开就是内置预览 */
function OutCard({ item, onOpen }: { item: DeskOutput; onOpen: () => void }) {
  const name = baseName(item.abs);
  const kind = fileKindOf(name);
  const ext = extOf(name);
  const thumb = useThumb(item, kind);
  const size = fmtBytes(item.bytes ?? thumb.bytes);
  const updated = item.updatedAt ? fmtTime(item.updatedAt) : "";
  return (
    <button
      type="button"
      className={`cs-out k-${kind}`}
      onClick={onOpen}
      title={[
        item.abs,
        `来自：${item.job.title || item.job.id}`,
        item.jobs > 1 ? `这个文件被更新过 ${item.jobs} 次` : "",
        updated ? `最近更新 ${updated}` : "",
      ]
        .filter(Boolean)
        .join("\n")}
    >
      <span className="cs-thumb" aria-hidden="true">
        {thumb.dataUrl ? (
          <img className="cs-thumb-img" src={thumb.dataUrl} alt="" />
        ) : thumb.text ? (
          <span className="cs-thumb-txt mono">{thumb.text}</span>
        ) : (
          <span className="cs-thumb-ext mono">{(ext || "FILE").toUpperCase()}</span>
        )}
      </span>
      <span className="cs-oname">{shortName(name)}</span>
      <span className="cs-ometa">
        <span className="cs-otype mono">{ext ? ext.toUpperCase() : "文件"}</span>
        {size && <span className="cs-osize mono">{size}</span>}
        {item.jobs > 1 && <span className="cs-ojobs mono">更新 {item.jobs} 次</span>}
      </span>
    </button>
  );
}

/** 一条待判：回答 / 批准 / 打回，输入框自管自的状态 */
function DecisionCard({
  d,
  onResolve,
}: {
  d: DeskDecision;
  onResolve: ConsoleViewProps["onDecisionResolve"];
}) {
  const [answering, setAnswering] = useState(false);
  const [text, setText] = useState("");
  const submit = () => {
    onResolve(d.id, "answer", text.trim());
    setAnswering(false);
    setText("");
  };

  // 契约卡：拍板前得看清「谁做、什么时候要、多少钱、动哪个项目、落在哪个目录」。
  // 值台的 PlanSeal 一直有这几项，控制台此前只有一句标题——用户等于闭眼点「批准」。
  const plan = d.kind === "plan" ? d.plan : undefined;
  const planMeta = plan
    ? [
        plan.member ? `承接 ${plan.member}` : "",
        plan.deadline ? `截止 ${plan.deadline}` : "",
        plan.budgetTokens ? `预算 ${Math.round(plan.budgetTokens / 1000)}K tok` : "",
      ]
        .filter(Boolean)
        .join(" · ")
    : "";
  const planWhere = plan
    ? [plan.projectName ? `项目 ${plan.projectName}` : "", plan.workspaceRoot ?? ""].filter(Boolean).join(" · ")
    : "";
  return (
    <div className={`cs-dec kind-${d.kind}`}>
      <div className="cs-dec-top">
        <span className="cs-dec-who">{d.who}</span>
        <span className="cs-dec-at mono">{hhmm(d.at)}</span>
      </div>
      <div className="cs-dec-q">{d.question}</div>
      {planMeta && <div className="cs-dec-meta mono">{planMeta}</div>}
      {planWhere && (
        <div className="cs-dec-meta mono" title={plan?.workspaceRoot ?? ""}>
          {planWhere}
        </div>
      )}
      {d.checks.length > 0 && (
        <ul className="cs-dec-checks">
          {d.checks.map((c, i) => (
            <li key={i} className={c.ok ? "ok" : "bad"}>
              {c.text}
            </li>
          ))}
        </ul>
      )}
      <div className="cs-dec-acts">
        {d.kind === "question" ? (
          answering ? (
            <>
              <input
                className="cs-inline"
                autoFocus
                value={text}
                placeholder="回复她…"
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submit();
                  if (e.key === "Escape") setAnswering(false);
                }}
              />
              <button type="button" className="cs-act primary" onClick={submit}>
                发出
              </button>
            </>
          ) : (
            <button type="button" className="cs-act primary" onClick={() => setAnswering(true)}>
              回答
            </button>
          )
        ) : (
          <>
            <button type="button" className="cs-act primary" onClick={() => onResolve(d.id, "start")}>
              {d.kind === "plan" ? "批准开工" : "准"}
            </button>
            <button
              type="button"
              className="cs-act"
              onClick={() => onResolve(d.id, d.kind === "plan" ? "revise" : "reject")}
            >
              {d.kind === "plan" ? "打回" : "驳"}
            </button>
            {/* 审批：这一类命令以后都放行（值台一直有，控制台漏了就会逼用户反复点） */}
            {d.kind === "approval" && d.family && (
              <button type="button" className="cs-act" onClick={() => onResolve(d.id, "start", undefined, true)}>
                这类以后都准
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * 一件落盘的东西：文件名 + 位置 + 核没核。汇总视角再标一句"这来自哪张单"。
 * 能预览的文件整行可点（点开就是内置预览）；`title` 里常是原始全路径，卡面只留末段。
 */
function EvRow({
  ev,
  on,
  src,
  onOpen,
}: {
  ev: DeskEvidence;
  on?: boolean;
  src?: string;
  onOpen?: () => void;
}) {
  const name = shortName(baseName(ev.title || ev.ref || ""));
  // 第二行只放"名字之外"的信息：来源单号、原始路径（原始路径和文件名一样时就不重复写一遍）
  const orig = ev.title && /[\\/]/.test(ev.title) ? ev.title : "";
  const sub = [src, orig].filter(Boolean).join(" · ");
  const body = (
    <>
      <span className={`cs-ev-d${ev.verified ? " ok" : ""}`} aria-hidden="true" />
      <span className="cs-ev-n">{name}</span>
      <span className="cs-ev-t mono">{ev.verified ? "已核" : "未核"}</span>
      {sub && <span className="cs-ev-p mono">{sub}</span>}
    </>
  );
  if (onOpen) {
    return (
      <button
        type="button"
        className={`cs-ev-row cs-ev-btn${on ? " on" : ""}`}
        onClick={onOpen}
        title={orig || ev.ref || name}
      >
        {body}
      </button>
    );
  }
  return <div className={`cs-ev-row${on ? " on" : ""}`}>{body}</div>;
}

/** 时间戳 → 时:分（往来记录用不到秒） */
function hmOf(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 战果抽屉。两个粒度，别混：
 *   传了 jobId → 只看这一张单（从锁定卡 / 产出卡点进来）
 *   没传      → 本轮汇总（从告警「看战果」/ 产出柜「全部」点进来）
 */
function ResultTab({
  desk,
  lines,
  jobId,
  focusRef,
  acts,
  onMore,
  onOpenFile,
}: {
  desk: Desk;
  lines: ConsoleLine[];
  jobId?: string;
  focusRef?: string;
  acts?: Act[];
  onMore?: () => void;
  /** 点产物行 → 开内置预览（渲染层只递 ref，字节由主进程守门） */
  onOpenFile?: (taskId: string, ref: string) => void;
}) {
  const job = jobId ? desk.jobs.find((j) => j.id === jobId) : undefined;

  /* ---------------- 单张单 ---------------- */
  if (jobId) {
    if (!job) return <div className="cs-note">这张单已经不在台账里了（可能被删除或合并）。</div>;
    const evs = job.evidence;
    // 产物 = 真文件；command 那类证据的 ref 是一整句话，归到"核对记录"，不混进产物清单
    const fileEvs = evs.filter((e) => isFileRef(e.ref));
    const otherEvs = evs.filter((e) => !isFileRef(e.ref));
    const verified = fileEvs.filter((e) => e.verified).length;
    // 交付物优先：那是用户要带走的东西；证据只是"我核对过"的记录
    const products: DeskEvidence[] = (job.deliverables ?? []).length
      ? (job.deliverables ?? []).map((d) => ({
          level: "ok" as const,
          title: d.path || d.ref,
          detail: d.path || d.ref,
          ref: d.ref,
          verified: true,
        }))
      : fileEvs;
    return (
      <>
        <div className="cs-lead">
          <div className="cs-lead-k mono">
            {job.id} · {job.statusLabel}
          </div>
          <div className="cs-lead-v">
            {job.report?.conclusion ?? `${job.member ?? "未派"} 在办，进度 ${job.stage}/4。`}
          </div>
        </div>
        <div className="cs-cells">
          <div className="cs-cell">
            <b className="mono">{products.length}</b>
            <span>交付物</span>
          </div>
          <div className="cs-cell">
            <b className="mono">{verified}</b>
            <span>已核</span>
          </div>
          <div className="cs-cell">
            <b className="mono">
              {job.rejections}/{job.rejectLimit}
            </b>
            <span>打回</span>
          </div>
        </div>

        {job.report && (
          <div className="cs-doc">
            <p>
              <b>证据</b>：{job.report.evidence}
            </p>
            <p>
              <b>未完成</b>：{job.report.unfinished}
            </p>
            <p>
              <b>待你决定</b>：{job.report.decision}
            </p>
          </div>
        )}

        {products.length > 0 && (
          <>
            <div className="cs-sec mono">交付物</div>
            <div className="cs-evs">
              {products.map((e) => (
                <EvRow
                  key={e.ref}
                  ev={e}
                  on={Boolean(focusRef) && e.ref === focusRef}
                  onOpen={onOpenFile ? () => onOpenFile(job.id, e.ref ?? "") : undefined}
                />
              ))}
            </div>
          </>
        )}

        {/* 命令输出、核对结论这些是"她说做过什么"，不是可带走的产物：单独一段，别混进清单 */}
        {otherEvs.length > 0 && (
          <>
            <div className="cs-sec mono">核对记录</div>
            <div className="cs-doc">
              {otherEvs.map((e) => (
                <p key={e.ref}>
                  <b className="mono">{e.verified ? "已核" : "未核"}</b> {e.title}
                </p>
              ))}
            </div>
          </>
        )}

        {/* 状态说明只在"为什么停在这"时才有信息量；在办的单上面三格已经说清了 */}
        {job.statusNote && (job.group === "stuck" || job.group === "archived") && (
          <div className="cs-note">{job.statusNote}</div>
        )}

        {/* 既没战报也没产物时，至少给这单的往来记录——否则每张空单点开都长一个样 */}
        {evs.length === 0 && !job.report && (
          <>
            <div className="cs-sec mono">往来</div>
            {(() => {
              const mine = lines.filter((l) => l.jobId === job.id).slice(-8);
              return mine.length === 0 ? (
                <div className="cs-note">这单没留战报，也没有落盘的产物和往来记录。</div>
              ) : (
                <div className="cs-doc">
                  {mine.map((l) => (
                    <p key={l.id}>
                      <b className="mono">{hmOf(l.at)}</b> {l.kind} · {l.text}
                    </p>
                  ))}
                </div>
              );
            })()}
          </>
        )}

        {/* 就地能办的就办；要填三要素的打回转处置抽屉（这里不放，免得点了没反应） */}
        {(acts?.length || onMore) && (
          <div className="cs-res-acts">
            {acts?.map((a) => (
              <button
                key={a.key}
                type="button"
                className={`cs-act${a.tone ? ` ${a.tone}` : ""}`}
                onClick={a.run}
              >
                {a.label}
              </button>
            ))}
            {/* 处置抽屉只列待判的单：别组给了按钮点进去是空页 */}
            {onMore && job.group === "waiting" && (
              <button type="button" className="cs-act" onClick={onMore}>
                处置与打回
              </button>
            )}
          </div>
        )}
      </>
    );
  }

  /* ---------------- 全部汇总（本群） ---------------- */
  const scope = jobsInThread(desk);
  const done = scope.filter((j) => j.group === "archived");
  const withReport = done.filter((j) => j.report);
  // 交付物口径与值台交付箱一致（按绝对路径合并、含归档单）。
  // **不按群过滤**：交付物是文件不是群内记录——柜面写「全部 N 件」就必须真的列全部，
  // 否则点进去是空的（此前汇总与柜面用了两种口径）。
  const files = outputsOf(desk);
  return (
    <>
      <div className="cs-lead">
        <div className="cs-lead-k mono">最近结论</div>
        <div className="cs-lead-v">
          {withReport[0]?.report?.conclusion ??
            (files.length > 0
              ? `还没有归档的战报，先看落盘的 ${files.length} 件。`
              : "这一轮还没有产出。")}
        </div>
      </div>
      <div className="cs-cells">
        <div className="cs-cell">
          <b className="mono">{done.length}</b>
          <span>已归档</span>
        </div>
        <div className="cs-cell">
          <b className="mono">{files.length}</b>
          <span>交付物</span>
        </div>
        <div className="cs-cell">
          <b className="mono">{desk.members.length}</b>
          <span>在编席位</span>
        </div>
      </div>

      {files.length > 0 && (
        <>
          <div className="cs-sec mono">全部交付物</div>
          <div className="cs-evs">
            {files.map((o) => (
              <EvRow
                key={o.abs}
                ev={{ level: "ok", title: o.abs, detail: o.abs, ref: o.ref, verified: true }}
                src={o.job.id}
                onOpen={onOpenFile ? () => onOpenFile(o.job.id, o.ref) : undefined}
              />
            ))}
          </div>
        </>
      )}

      {withReport.length > 0 && <div className="cs-sec mono">战报</div>}
      {withReport.map((j) => (
        <div key={j.id} className="cs-rep">
          {/* 单号 + 标题用正文色而不是又一条灰 cap：「战报」下面再套一层小标题会看成两段重复 */}
          <div className="cs-rep-t">
            <span className="mono">{j.id}</span> {j.title}
          </div>
          <div className="cs-doc">
            <p>
              <b>证据</b>：{j.report?.evidence}
            </p>
            <p>
              <b>未完成</b>：{j.report?.unfinished}
            </p>
            <p>
              <b>待你决定</b>：{j.report?.decision}
            </p>
          </div>
        </div>
      ))}
    </>
  );
}

function UsageTab({ desk }: { desk: Desk }) {
  const u = desk.usage;
  const promptTotal = u.sessionIn + u.cacheRead + u.cacheWrite;
  const hit = promptTotal > 0 ? (u.cacheRead / promptTotal) * 100 : undefined;
  return (
    <>
      <div className="cs-usage-bar">
        <i style={{ width: `${Math.min(100, u.contextPercent ?? 0)}%` }} />
      </div>
      <div className="cs-usage-row">
        <span>上下文</span>
        <b className="mono">
          {u.contextTokens} / {u.contextWindow}
        </b>
      </div>
      <div className="cs-usage-row">
        <span>本轮输入 / 输出</span>
        <b className="mono">
          {u.turnIn} / {u.turnOut}
        </b>
      </div>
      <div className="cs-usage-row">
        <span>会话输入 / 输出</span>
        <b className="mono">
          {u.sessionIn} / {u.sessionOut}
        </b>
      </div>
      <div className="cs-usage-row">
        <span>缓存命中率</span>
        <b className="mono">{hit === undefined ? "—" : `${hit.toFixed(1)}%`}</b>
      </div>
      <div className="cs-usage-row">
        <span>累计费用</span>
        <b className="mono">{u.cost > 0 ? u.cost.toFixed(4) : "—"}</b>
      </div>
      {hit === undefined && (
        <div className="cs-note">
          这一轮还没有缓存读数（提示词为 0 时后端不返回命中率）——不显示 0% 冒充"没命中"。
        </div>
      )}
    </>
  );
}

function ConfigTab({ desk, onOpenSettings }: { desk: Desk; onOpenSettings: () => void }) {
  const gated = desk.projectGated;
  const trustNeed = Boolean(gated?.mcp || gated?.skills);
  return (
    <>
      <div className="cs-kv">
        <dt>项目</dt>
        <dd>{desk.workspaceProjectName || desk.project || "未选"}</dd>
        <dt>主根</dt>
        <dd className="mono">{desk.workspacePrimary ?? "本次不用工作区（产出落任务卷宗）"}</dd>
        <dt>附加根</dt>
        <dd className="mono">
          {desk.workspaceExtras.length
            ? desk.workspaceExtras.map((x) => `${x.path}（${x.mode === "rw" ? "可写" : "只读"}）`).join("；")
            : "—"}
        </dd>
        {/* 信任：只有目录里真有「被信任才生效」的东西时才说，别对普通目录报警 */}
        <dt>信任</dt>
        <dd>{trustNeed ? (desk.projectTrusted ? "已信任（项目级 MCP/技能生效）" : "未信任（项目级 MCP/技能不加载）") : "无需信任"}</dd>
        <dt>自动开工</dt>
        <dd>{desk.autoStart ? "开" : "关"}</dd>
        <dt>软预算</dt>
        <dd>{desk.budget ? `${fmtTokens(desk.budget.spent)} / ${fmtTokens(desk.budget.soft)}` : "未设上限"}</dd>
        <dt>会话</dt>
        <dd>{desk.thread.title || "没有会话"}</dd>
      </div>
      <button type="button" className="cs-act" onClick={onOpenSettings}>
        打开设置面板
      </button>
    </>
  );
}

function ArchiveTab({
  desk,
  onPurgeOrphans,
  onRemoveTask,
  onOpen,
}: {
  desk: Desk;
  onPurgeOrphans?: () => void;
  onRemoveTask?: (taskId: string) => void;
  /** 点开一张归档单的战果（风铃代验可能判错，「重开」是唯一回退路） */
  onOpen?: (taskId: string) => void;
}) {
  /** 批量删除不可恢复：第一次点只换文案，第二次才真删（不弹窗打断沉浸） */
  const [armed, setArmed] = useState(false);
  /** 单项删除同样两段确认：归档清单不该只能看不能收尾 */
  const [delId, setDelId] = useState<string | null>(null);
  const orphanNote =
    desk.orphans > 0 ? (
      <div className="cs-orphan">
        <div className="cs-orphan-t">
          <b>{desk.orphans}</b> 张单的会话已被删除
        </div>
        <div className="cs-orphan-s">这些单没有会话可回看往来，留着只会占台账。</div>
        {onPurgeOrphans && (
          <button
            type="button"
            className="cs-act bad"
            onClick={() => (armed ? onPurgeOrphans() : setArmed(true))}
          >
            {armed ? `确认清掉 ${desk.orphans} 张` : "清掉无主单"}
          </button>
        )}
      </div>
    ) : null;
  if (!desk.archived.length) {
    return (
      <>
        {orphanNote}
        <div className="cs-note">还没有归档的工单。</div>
      </>
    );
  }
  return (
    <>
      {orphanNote}
      <div className="cs-archive">
        {desk.archived.map((a) => (
          <div
            className={`cs-ar-row${onOpen ? " openable" : " static"}`}
            key={a.id}
            role={onOpen ? "button" : undefined}
            tabIndex={onOpen ? 0 : undefined}
            title={onOpen ? "打开这张单的战果（可重开）" : undefined}
            onClick={() => onOpen?.(a.id)}
            onKeyDown={(e) => {
              if (!onOpen) return;
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onOpen(a.id);
              }
            }}
          >
            <span className="cs-ar-id mono">{shortId(a.id)}</span>
            <span className="cs-ar-t">{a.title}</span>
            {/* 状态用中文标签（此前直接印 done / canceled 原码） */}
            <span className="cs-ar-m mono">{a.status ? (STATUS_LABEL[a.status] ?? a.status) : ""}</span>
            {onRemoveTask && (
              <button
                type="button"
                className={`cs-ar-del${delId === a.id ? " sure" : ""}`}
                title={delId === a.id ? "再点一次：连卷宗一起彻底删掉" : "删除这张归档单"}
                onClick={(e) => {
                  e.stopPropagation();
                  if (delId !== a.id) {
                    setDelId(a.id);
                    return;
                  }
                  onRemoveTask(a.id);
                  setDelId(null);
                }}
              >
                {delId === a.id ? "确认" : "×"}
              </button>
            )}
          </div>
        ))}
      </div>
    </>
  );
}
