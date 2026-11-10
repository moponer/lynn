import { useEffect, useMemo, useRef, useState } from "react";
import type { PermissionMode } from "../../shared/contract";
import type { Desk, DeskDecision, DeskEvidence, DeskJob } from "../desk/model";
import { fmtTime } from "../desk/model";
import { WindowControls } from "../components/WindowControls";
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
  const [draft, setDraft] = useState("");
  /** cd 回执（成功/失败都写在底栏，不吞） */
  const [cdMsg, setCdMsg] = useState("");
  /** 球面锁定卡：位置在点击时按容器尺寸算好，跟着节点走 */
  const [picked, setPicked] = useState<{ job: DeskJob; left: number; top: number } | null>(null);
  /** 已上膛的删除（第一下上膛、第二下执行）：不可恢复的动作不做静默单击 */
  const [armedRemove, setArmedRemove] = useState<string | null>(null);
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

  const active = useMemo(() => desk.jobs.filter((j) => j.group !== "archived"), [desk.jobs]);
  /** 能直接拍板的单（in_review）：验收 / 打回 */
  const waiting = useMemo(() => active.filter((j) => j.group === "waiting"), [active]);
  const pending = desk.decisions;
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
   * 产出柜 = 真实落盘的文件。
   * 模型里 DeskJob.artifact 从来没被赋值，能拿到的只有证据链上的 ref（artifacts/xxx），
   * 所以这里按证据条目出卡，不按"工单标题"假装交付物。
   */
  const outputs = useMemo(
    () =>
      active
        .flatMap((j) => j.evidence.filter((e) => e.ref).map((e) => ({ job: j, ev: e })))
        .slice(-6)
        .reverse(),
    [active],
  );

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
    if (job.group === "stuck") {
      out.push({ key: "stop", label: "停掉止损", tone: "bad", run: () => onCancelTask(job.id) });
    }
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
          <span className={`cs-live${turnBusy ? " on" : ""}`}>
            <i />
            {turnBusy ? "在跑" : "侦听"}
          </span>
          {/* 军印的顶栏缩写：窄窗才出现（宽窗右栏有完整军印，不重复） */}
          <button
            type="button"
            className={`cs-seal-mini${pending.length ? " hot" : ""}`}
            onClick={() => setDrawer(pending.length ? "decide" : "result")}
            title={pending.length ? "有待你拍板的裁决" : "她很安静，点开看最近战果"}
          >
            {pending.length ? `待判 ${pending.length}` : "侦听中"}
          </button>
        </div>
        <div className="cs-top-r">
          <span className="cs-readout">
            任务<b>{active.length}</b>
          </span>
          <span className={`cs-readout hot${pending.length ? " on" : ""}`}>
            待判<b>{pending.length}</b>
          </span>
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

            {/* 球心告警：有待判就压在球心；一旦锁定某张单，让位给详情卡（Esc 关掉再回来） */}
            {pending.length > 0 && !picked && (
              <div className="cs-alert">
                <div className="cs-alert-top">
                  <i className="cs-alert-led" />
                  ALERT / 需介入
                  <span className="n mono">{String(pending.length).padStart(2, "0")}</span>
                </div>
                <div className="cs-alert-t">
                  {pending.length > 1
                    ? `${pending.length} 项待你拍板 · 风铃已停在卡点`
                    : "风铃已停在当前节点，等待拍板"}
                </div>
                <div className="cs-alert-d mono">
                  {pending[0].who} · {pending[0].question}
                </div>
                <div className="cs-alert-acts">
                  <button type="button" onClick={() => setDrawer("decide")}>
                    查看并处置
                  </button>
                  <button type="button" className="ghost" onClick={() => openResult()}>
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
              <LynnCore phase={phase} onClick={() => setDrawer(pending.length ? "decide" : "result")} />
            </div>
            <div className="cs-lynn-foot">
              <span className="cs-lynn-state">
                <b>{phase === "decide" ? "待你拍板" : turnBusy ? "在推进" : "侦听中"}</b>
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
                全部 {outputs.length} 件
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
                      key={`${o.job.id}-${o.ev.ref}`}
                      name={o.ev.title || o.ev.ref || o.job.title}
                      jobId={o.job.id}
                      verified={Boolean(o.ev.verified)}
                      onClick={() => openResult(o.job.id, o.ev.ref)}
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
              aria-pressed={permission === m}
              onClick={() => onPermission(m)}
              title={`切到 ${m}`}
            >
              {m}
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
                  ? `${pending.length} 项待你拍板`
                  : drawer === "result"
                    ? resultJob
                      ? (desk.jobs.find((j) => j.id === resultJob.id)?.title ?? "这张单的战果")
                      : "本轮交付"
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
                />
              )}
              {drawer === "decide" &&
                (pending.length === 0 && waiting.length === 0 ? (
                  <div className="cs-note">没有待判的事，她在自己推进。</div>
                ) : (
                  <>
                    {/* 先给能直接拍板的单：验收 / 打回，不用再去值台找 */}
                    {waiting.map((j) => (
                      <div className="cs-dj" key={j.id}>
                        <div className="cs-dj-h">
                          <span className="mono">{shortId(j.id)}</span>
                          <span className="cs-dj-t">{j.title}</span>
                          <span className="cs-dj-m mono">{j.member ?? "未派"}</span>
                        </div>
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
                    ))}
                    {pending.map((d) => (
                      <DecisionCard key={d.id} d={d} onResolve={onDecisionResolve} />
                    ))}
                  </>
                ))}
              {drawer === "usage" && <UsageTab desk={desk} />}
              {drawer === "config" && <ConfigTab desk={desk} onOpenSettings={onOpenSettings} />}
              {drawer === "archive" && <ArchiveTab desk={desk} onPurgeOrphans={onPurgeOrphans} />}
            </div>
          </aside>
        </div>
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
        <button type="button" className="cs-act ok" onClick={onSubmit} disabled={!ready}>
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
        <span className="cs-t-note">
          {job.member ?? "未派"} · 证据 {job.evidenceCount} · v{job.version}
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
        {cmds.length} 命令 · {job.evidenceCount} 证据 · v{job.version}
      </div>
    </div>
  );
}

/** 产出卡：缩略图在上（形状随机的东西不画，只按类型给一个版面骨架） */
function outTypeOf(name: string): "code" | "sheet" | "image" | "slides" | "link" {
  const n = name.toLowerCase();
  if (/\.(xlsx?|csv)$/.test(n)) return "sheet";
  if (/\.(png|jpe?g|webp|svg)$/.test(n)) return "image";
  if (/\.(pptx?|key)$/.test(n)) return "slides";
  if (/^https?:/.test(n)) return "link";
  return "code";
}

const OUT_LABEL: Record<string, string> = {
  code: "文档",
  sheet: "表格",
  image: "图片",
  slides: "演示",
  link: "链接",
};

function OutCard({
  name,
  jobId,
  verified,
  onClick,
}: {
  name: string;
  jobId: string;
  verified: boolean;
  onClick: () => void;
}) {
  const type = outTypeOf(name);
  return (
    <button type="button" className="cs-out" onClick={onClick} title={name}>
      <span className={`cs-thumb ${type}`} aria-hidden="true">
        {type === "sheet"
          ? Array.from({ length: 16 }, (_, i) => <i key={i} />)
          : type === "image"
            ? Array.from({ length: 4 }, (_, i) => <i key={i} />)
            : type === "slides"
              ? Array.from({ length: 3 }, (_, i) => <i key={i} />)
              : type === "link"
                ? [<i key={0} />, <i key={1} />]
                : Array.from({ length: 5 }, (_, i) => <i key={i} />)}
      </span>
      <span className="cs-oname">{name}</span>
      <span className="cs-ometa">
        <span className="cs-otype mono">{OUT_LABEL[type]}</span>
        {!verified && <span className="cs-otype">未核</span>}
        <span className="cs-osrc mono">{shortId(jobId)}</span>
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

  return (
    <div className={`cs-dec kind-${d.kind}`}>
      <div className="cs-dec-top">
        <span className="cs-dec-who">{d.who}</span>
        <span className="cs-dec-at mono">{hhmm(d.at)}</span>
      </div>
      <div className="cs-dec-q">{d.question}</div>
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
          </>
        )}
      </div>
    </div>
  );
}

/** 一件落盘的东西：名字 + 位置 + 核没核。汇总视角再标一句"这来自哪张单" */
function EvRow({ ev, on, src }: { ev: DeskEvidence; on?: boolean; src?: string }) {
  return (
    <div className={`cs-ev-row${on ? " on" : ""}`}>
      <span className={`cs-ev-d${ev.verified ? " ok" : ""}`} aria-hidden="true" />
      <span className="cs-ev-n">{ev.title}</span>
      <span className="cs-ev-t mono">{ev.verified ? "已核" : "未核"}</span>
      <span className="cs-ev-p mono">{src ? `${src} · ${ev.ref}` : ev.ref}</span>
    </div>
  );
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
}: {
  desk: Desk;
  lines: ConsoleLine[];
  jobId?: string;
  focusRef?: string;
  acts?: Act[];
  onMore?: () => void;
}) {
  const job = jobId ? desk.jobs.find((j) => j.id === jobId) : undefined;

  /* ---------------- 单张单 ---------------- */
  if (jobId) {
    if (!job) return <div className="cs-note">这张单已经不在台账里了（可能被删除或合并）。</div>;
    const evs = job.evidence;
    const verified = evs.filter((e) => e.verified).length;
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
            <b className="mono">{evs.length}</b>
            <span>落盘产物</span>
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

        {evs.length > 0 && (
          <>
            <div className="cs-sec mono">产物清单</div>
            <div className="cs-evs">
              {evs.map((e) => (
                <EvRow key={e.ref} ev={e} on={Boolean(focusRef) && e.ref === focusRef} />
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

  /* ---------------- 本轮汇总 ---------------- */
  const done = desk.jobs.filter((j) => j.group === "archived");
  const withReport = done.filter((j) => j.report);
  const files = desk.jobs.flatMap((j) => j.evidence.filter((e) => e.ref).map((e) => ({ j, e })));
  return (
    <>
      <div className="cs-lead">
        <div className="cs-lead-k mono">本轮结论</div>
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
          <span>落盘产物</span>
        </div>
        <div className="cs-cell">
          <b className="mono">{desk.members.length}</b>
          <span>在编席位</span>
        </div>
      </div>

      {files.length > 0 && (
        <>
          <div className="cs-sec mono">本轮产物</div>
          <div className="cs-evs">
            {files.map(({ j, e }) => (
              <EvRow key={`${j.id}-${e.ref}`} ev={e} src={j.id} />
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
  return (
    <>
      <div className="cs-kv">
        <dt>工作区</dt>
        <dd>{desk.project}</dd>
        <dt>子目录</dt>
        <dd>{desk.subdir || "—"}</dd>
        <dt>自动开工</dt>
        <dd>{desk.autoStart ? "开" : "关"}</dd>
        <dt>软预算</dt>
        <dd>{desk.budget ? `${desk.budget.spent} / ${desk.budget.soft}` : "未设上限"}</dd>
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
}: {
  desk: Desk;
  onPurgeOrphans?: () => void;
}) {
  /** 批量删除不可恢复：第一次点只换文案，第二次才真删（不弹窗打断沉浸） */
  const [armed, setArmed] = useState(false);
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
          <div className="cs-ar-row static" key={a.id}>
            <span className="cs-ar-id mono">{shortId(a.id)}</span>
            <span className="cs-ar-t">{a.title}</span>
            <span className="cs-ar-m mono">{a.status ?? ""}</span>
          </div>
        ))}
      </div>
    </>
  );
}
