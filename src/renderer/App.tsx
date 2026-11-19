import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  CaptureShot,
  FeedCard,
  KernelEvent,
  PermissionMode,
  RpcContracts,
  RpcMethod,
  SessionSnapshot,
} from "../shared/contract";
import { DELTA_FRAME_MIN_GAP_MS } from "../shared/stream";
import { SettingsModal } from "./components/SettingsModal";
import { Icon } from "./components/Icon";
import { DeskView } from "./desk/Desk";
import { useUiPlugins } from "./desk/ui-host";
import { pluginsForSlot } from "../shared/ui-plugin";
import { consoleViewOf } from "./console/registry";
import { deskFromSnapshot, type Desk } from "./desk/model";
import { startPerfMonitor } from "./desk/perf-monitor";
import { applyPluginStyle, applyPluginTokens, applyTheme, loadTheme, normalizeThemeId, type ThemeId, type ThemeMode } from "./desk/theme";
import type { LynnPack } from "./desk/lynnpack";
import { Wizard, type WizardResult } from "./desk/Wizard";
import { Standby } from "./desk/Standby";
// 桌宠暂时停用（2026-11-15）：素材 20 MB 不入库，渲染一并关掉。
// 恢复：取消本行注释 + 下方 ?pet=1 分支里的 <Pet /> 注释。
// import { Pet } from "./desk/Pet";
import { BootScreen } from "./boot/BootScreen";
import { ambientForTheme, type AmbientMode } from "../shared/ambient";
import { ZH_STRINGS } from "../shared/i18n-strings";
import { useVoicePlayer } from "./voice/useVoicePlayer";
import { AskHost, askConfirm } from "./components/ConfirmCard";
import { Wallpaper } from "./components/Wallpaper";

/** 舞台视图选择（跨会话记住）：值台 = 原来的桌面，控制台 = stage.console 视图 */
const STAGE_KEY = "lynn.stage.view";
type StageView = "desk" | "console";

function readStageView(): StageView {
  try {
    return localStorage.getItem(STAGE_KEY) === "desk" ? "desk" : "console";
  } catch {
    return "console";
  }
}
import { mergeStrings } from "../shared/i18n";
import { I18nProvider } from "./i18n";

/** 渲染层只认 contract.ts 里的类型化 RPC；不感知内核实现是直连还是 Pi。 */
async function rpc<M extends RpcMethod>(
  method: M,
  ...args: RpcContracts[M]["params"] extends void ? [] : [RpcContracts[M]["params"]]
): Promise<RpcContracts[M]["result"]> {
  return window.lynn.rpc(method, ...args);
}

/** 前端构建时间（vite define 注入）：与内核的 buildAt 比对，发现"界面新、内核旧" */
declare const __LYNN_BUILD_AT__: string;
/** 前端构建号（vite define 注入，git 提交计数）：优先用它判新旧（审计 #19） */
declare const __LYNN_BUILD_ID__: string;

/**
 * RPC 失败的可读文案：后端是旧版本时别把 `unknown rpc method: task.remove` 直接甩给用户，
 * 那看起来像"删除坏了"，实际只是应用没重启。
 */
function rpcErrorText(err: unknown, fallback: string): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/unknown rpc method/i.test(msg)) return "这个操作需要重启应用后生效（后台还是旧版本）。";
  return `${fallback}：${msg}`;
}

/** 同一个口径，但输入是 `{ error }` 形式的 RPC 结果（壳层把内核异常包成返回值，不会 reject） */
function rpcResultError(res: { error?: string } | undefined, fallback: string): string {
  const msg = res?.error ?? "";
  if (!msg) return fallback;
  return rpcErrorText(new Error(msg), fallback);
}

/** 增量事件合并：同 id 的卡就地替换，不整表重拉 */
function upsertCard(feed: FeedCard[], card: FeedCard): FeedCard[] {
  const i = feed.findIndex((c) => c.id === card.id);
  if (i < 0) {
    /**
     * 与内核同一条排序纪律（2026-11-16）：她的实时输出卡永远留在末尾，
     * 新到的动作卡 / 成员回报插在它**前面**。此前双方都是 append，
     * 长任务里她的话被后来的回报一路顶到上面，读起来就是"早期消息穿插在下面"。
     */
    const live = feed.findIndex((c) => c.kind === "lynn" && c.streaming);
    if (live >= 0 && live !== feed.length) {
      const next = feed.slice();
      next.splice(live, 0, card);
      return next;
    }
    return [...feed, card];
  }
  const next = feed.slice();
  next[i] = card;
  /**
   * 就地更新后跟着 live 卡走（2026-11-19 F2 修：与内核 floatAboveLive 逐条对齐）。
   *
   * 之前的 bug：前端对每次就地更新都 `i>live` 就挪，而内核 floatAboveLive 用
   * `i<l && i!==l-1` 的边界（已紧邻 / 已在 live 后都不动）。两边边界不同 →
   * 前端把卡挪了、内核快照又把它打回原位，用户看到卡片"跳一下又弹回去"。
   * 现在完全照内核的边界：只有卡在 live 之前、且不紧邻 live 时才挪到 live 前。
   */
  const liveIdx = next.findIndex((c) => c.kind === "lynn" && c.streaming && c.id !== card.id);
  if (liveIdx >= 0) {
    const iNow = next.findIndex((c) => c.id === card.id);
    // 与内核一致：i < live 且不紧邻（i !== live-1）才挪
    if (iNow >= 0 && iNow < liveIdx && iNow !== liveIdx - 1) {
      next.splice(iNow, 1);
      const l = next.findIndex((c) => c.kind === "lynn" && c.streaming && c.id !== card.id);
      if (l >= 0) next.splice(l, 0, card);
      else next.push(card);
    }
  }
  return next;
}

export default function App() {
  // 语音播报：只订阅一次，桌宠窗口收不到 lynn:voice（主进程只投主窗）
  useVoicePlayer();
  /** 桌宠小窗：同一个渲染层，只挂形象 */
  const isPet = typeof location !== "undefined" && new URLSearchParams(location.search).get("pet") === "1";
  const [snap, setSnap] = useState<SessionSnapshot | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** 从编制表「管理」直达团队页；undefined = 按默认（概览）打开 */
  const [settingsTab, setSettingsTab] = useState<"team" | "auto" | undefined>(undefined);
  const [theme, setTheme] = useState(() => loadTheme());
  const [wizardOpen, setWizardOpen] = useState(() => !localStorage.getItem("lynn.onboarded"));
  const [standby, setStandby] = useState(false);
  const [ambientMode, setAmbientMode] = useState<AmbientMode>(
    () => (localStorage.getItem("lynn.ambient") as AmbientMode) || "low",
  );
  const ambient = useMemo(() => ambientForTheme(theme.id), [theme.id]);
  const [avatar, setAvatar] = useState(() => localStorage.getItem("lynn.avatar") !== "0");
  const [notice, setNotice] = useState<string | null>(null);
  const [fullAsk, setFullAsk] = useState(false);
  /**
   * 信任询问（2026-11-13）：用户刚选了一个目录，那目录里带项目级 MCP/技能。
   * 在这一当场问「信任并加载 / 先不信任」——此前只甩一句"没被信任"，
   * 用户既不知道在哪点、也不知道那里到底有什么被拦着。
   */
  const [trustAsk, setTrustAsk] = useState<{
    root: string;
    withheld: string[];
    /** 项目级 MCP server 清单全文（审计 #7：信任前让用户看到会跑什么命令） */
    servers: { id: string; command: string; args: string[]; envKeys: string[] }[];
  } | null>(null);
  /**
   * `stage.console` 卡槽：哪个插件占了它、用注册表里的哪个视图。
   * 启用状态来自主进程（_state.json），不在本地记「当前是不是大屏」——
   * 禁用插件 → 卡槽空 → 自动回落值台，不存在被暗开关卡在空视图里的情况。
   */
  const { enabled: uiPlugins } = useUiPlugins();
  const consoleSlot = pluginsForSlot(uiPlugins, "stage.console")[0];
  /**
   * 值台 / 控制台二选一。选择记在本地（不是插件启停状态）：
   * 插件被禁用 → 卡槽空 → 无论记的是什么都回落值台，不会卡在空视图里。
   */
  const [stageView, setStageView] = useState<StageView>(readStageView);
  const chooseStage = useCallback((v: StageView) => {
    setStageView(v);
    try {
      localStorage.setItem(STAGE_KEY, v);
    } catch {
      /* 隐私模式下不记住也不影响本次切换 */
    }
  }, []);
  const ConsoleHost = consoleSlot && stageView === "console" ? consoleViewOf(consoleSlot.view) : null;
  /**
   * 截图结果：只进输入框的「本轮随附」，不自动发送。
   * 记录所属会话（threadId）：截图只落进当时那个会话的输入台，切会话不带着走。
   */
  const [captureShot, setCaptureShot] = useState<{ shot: CaptureShot; threadId: string } | null>(null);
  /** onSend 是回调不是渲染：用 ref 读最新截图，免得把它列进依赖反复重建回调 */
  const captureShotRef = useRef<{ shot: CaptureShot; threadId: string } | null>(null);
  useEffect(() => {
    captureShotRef.current = captureShot;
  }, [captureShot]);
  /**
   * 性能采集启动一次（P6-7 / 18 章 F6）。
   * `startPerfMonitor` 是幂等的；React 严格模式双跑 effect 不会重复挂观察者。
   * 没有 PerformanceObserver 的环境里它自己静默返回，不影响任何功能。
   */
  useEffect(() => {
    startPerfMonitor();
  }, []);
  /** 截图到达时的当前会话：事件回调里读快照外的最新 thread.id */
  const threadIdRef = useRef("");
  const seenShots = useRef(new Set<string>());
  /** 事件 / 待取队列双通道共用，按 id 去重（窗口刚起来或焦点切换时可能同时收到） */
  const acceptShot = useCallback((shot: CaptureShot) => {
    if (!shot?.id || seenShots.current.has(shot.id)) return;
    seenShots.current.add(shot.id);
    setCaptureShot({ shot, threadId: threadIdRef.current });
    const clip = shot.copied ? "，并已复制到剪贴板" : shot.copied === false ? "（剪贴板写入失败）" : "";
    setNotice(`截图 ${shot.width}×${shot.height} 已放进本轮随附${clip}（处理 ${shot.ms}ms），发送前可以移除。`);
  }, []);
  /** M3-08：界面语言字典（内置 ⊕ 语言包插件），lang 变化即重拉 */
  const [i18nStrings, setI18nStrings] = useState<Record<string, string>>(ZH_STRINGS);
  /** 版本握手：内核比界面旧（改了代码没重启）时给一条可见提示 + 一键重启 */
  const [staleBackend, setStaleBackend] = useState(false);
  const lang = snap?.prefs.lang ?? "zh";
  useEffect(() => {
    let dead = false;
    rpc("i18n.get")
      .then((r) => {
        // 拿不到字典就保持内置中文；拿到了也**叠在内置中文之上**——
        // 主进程字典可能比界面旧（只重建了 renderer / 应用没重启），缺的键必须回退中文而不是露 `menu.open`
        if (!dead && r?.strings && Object.keys(r.strings).length > 0) {
          setI18nStrings(mergeStrings(ZH_STRINGS, r.strings));
        }
      })
      .catch(() => {
        /* 拉不到就用内置 zh，不阻塞界面 */
      });
    return () => {
      dead = true;
    };
  }, [lang]);

  // 版本握手：旧内核没有 app.info（返回 {error}）或构建落后于界面 → 顶部提示「重启应用」。
  // 审计 #19：优先比构建号（git 计数，单调可靠）；两侧任一不是 git-N 形状才退回时间戳。
  useEffect(() => {
    let dead = false;
    const isGitId = (s: string | undefined): s is string => !!s && /^git-\d+$/.test(s);
    const staleByTimestamp = (): boolean => {
      const fe = typeof __LYNN_BUILD_AT__ === "string" ? Date.parse(__LYNN_BUILD_AT__) : Number.NaN;
      return Number.isFinite(fe); // 后端连可比时间都没有 → 当作旧
    };
    rpc("app.info")
      .then((r) => {
        if (dead) return;
        const res = r as { buildAt?: string; buildId?: string; error?: string };
        if (res.error) {
          setStaleBackend(true);
          return;
        }
        const feId = typeof __LYNN_BUILD_ID__ === "string" ? __LYNN_BUILD_ID__ : undefined;
        if (isGitId(feId) && isGitId(res.buildId)) {
          if (Number(res.buildId.slice(4)) < Number(feId.slice(4))) setStaleBackend(true);
          return;
        }
        // 回落：旧内核没有 buildId / 无 git 环境——按时间戳比（旧行为）
        if (!res.buildAt) {
          if (staleByTimestamp()) setStaleBackend(true);
          return;
        }
        const fe = typeof __LYNN_BUILD_AT__ === "string" ? Date.parse(__LYNN_BUILD_AT__) : Number.NaN;
        const be = Date.parse(res.buildAt);
        if (Number.isFinite(fe) && Number.isFinite(be) && be + 60_000 < fe) setStaleBackend(true);
      })
      .catch(() => {
        if (!dead) setStaleBackend(true);
      });
    return () => {
      dead = true;
    };
  }, []);

  useEffect(() => {
    applyTheme(theme.id, theme.mode);
  }, [theme]);

  // Ctrl+. 进待机；待机里任意输入退出（Standby 自己监听）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === ".") {
        e.preventDefault();
        setStandby(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const changeTheme = useCallback((id: ThemeId, mode: ThemeMode) => {
    applyPluginTokens(undefined); // 换基础主题就清掉插件 Token 覆盖
    applyPluginStyle(null); // 形态层一并卸载，避免插件样式悬空
    setTheme({ id, mode });
  }, []);

  const changeAvatar = useCallback((on: boolean) => {
    setAvatar(on);
    localStorage.setItem("lynn.avatar", on ? "1" : "0");
  }, []);

  /** .lynnpack 导入：只应用配置（主题 / 形象），不含 Key、不含记忆 */
  const applyPack = useCallback(
    (p: LynnPack) => {
      // 旧包里可能是已下线的主题 id：归一后再应用
      changeTheme(normalizeThemeId(p.theme.id), p.theme.mode);
      changeAvatar(p.avatar);
    },
    [changeAvatar, changeTheme],
  );

  /**
   * 快照请求序号：done/error 会连续触发多次 refresh，旧响应不能覆盖新状态。
   * 之前「恢复后的回复偶发不进 DOM」正是两次 refresh 乱序 + rAF 旧 delta 覆写终态卡。
   */
  const refreshSeq = useRef(0);
  const refresh = useCallback(async () => {
    const seq = ++refreshSeq.current;
    try {
      const next = await rpc("session.snapshot");
      if (seq === refreshSeq.current) setSnap(next);
    } catch (err) {
      if (seq === refreshSeq.current) setNotice(`读取会话失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }, []);

  /**
   * 合并式刷新（2026-11-16 实机「Lynn 未响应」）：
   * 每个工具事件/后台会话动静都拉一次全量快照，而快照要同步读全量工单与卷宗。
   * 卡片本身已经由 card 事件增量送达，这类刷新只是为了对齐台账与编排状态——
   * 合并到一个窗口里做一次就够，不必一事件一拉。
   */
  const refreshSoonTimer = useRef<number | null>(null);
  const refreshSoon = useCallback(() => {
    if (refreshSoonTimer.current !== null) return;
    refreshSoonTimer.current = window.setTimeout(() => {
      refreshSoonTimer.current = null;
      void refresh();
    }, 400);
  }, [refresh]);

  /** 造铃完成：主题立即生效；改了端点/模型也要写盘（不能只在填了 Key 时才保存） */
  const finishWizard = useCallback(
    async (r: WizardResult) => {
      changeTheme(r.theme, r.mode);
      const customChanged =
        r.baseUrl.trim() !== (snap?.model.baseUrl ?? "").trim() ||
        r.model.trim() !== (snap?.model.model ?? "").trim();
      if (r.provider && r.baseUrl && r.model && (r.apiKey || customChanged)) {
        try {
          const saved = await rpc("config.save", {
            provider: r.provider,
            baseUrl: r.baseUrl,
            model: r.model,
            apiKey: r.apiKey,
          });
          // 换端点没填 Key / 首次没填 Key 会被如实拒绝；向导不阻塞，设置页可补
          if (!saved.ok) console.warn(`[wizard] 模型配置未保存：${saved.error}`);
        } catch {
          // 存 Key 失败不阻塞进入主界面；用户可在「我的风铃」里重填
        }
      }
      localStorage.setItem("lynn.onboarded", "1");
      changeAvatar(r.avatar);
      setWizardOpen(false);
      await refresh();
    },
    [changeAvatar, changeTheme, refresh, snap?.model.baseUrl, snap?.model.model],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /**
   * 已经配好模型就绝不再拦向导：引导只服务首次使用。
   * （localStorage 丢过一次就会永远卡在第 1 步，而向导里没有输入框——表现为「什么都点不动」）
   */
  useEffect(() => {
    if (snap?.model.configured && wizardOpen) {
      localStorage.setItem("lynn.onboarded", "1");
      setWizardOpen(false);
    }
  }, [snap?.model.configured, wizardOpen]);

  // 流式补字合帧（2026-11-16 从 rAF 改为定间隔）：
  // 每个 delta 都要 setState → 整棵 feed 与右栏重算。长回复时模型每秒吐几十个 delta，
  // 每帧一次在长任务（几十张卡）上会把渲染进程压到"未响应"。40ms 合并人眼无感，
  // 重渲染次数降到 1/3 左右。
  const pendingDelta = useRef<{ id: string; text?: string; thinking?: string } | null>(null);
  const deltaTimer = useRef<number | null>(null);
  // 合并间隔用契约里的单一来源（2026-11-19 修 消息#11）：原来主进程 16ms / RPC 80ms /
  // 前端 80ms 三个魔数，两条模型路径行为差 5 倍，多推的帧全在这里被丢掉。

  useEffect(() => {
    // 终态（card / done / error）到达时，先丢弃还没跑的合并帧：
    // 否则旧的半截补字会在终态卡之后回写，把「恢复成功」又覆盖成半句话。
    const clearPendingDelta = () => {
      if (deltaTimer.current !== null) {
        window.clearTimeout(deltaTimer.current);
        deltaTimer.current = null;
      }
      pendingDelta.current = null;
    };
    // 增量事件：卡片 upsert / 流式补字 / 回合状态；只有完成与错误才拉权威快照
    const off = window.lynn.onEvent((ev: KernelEvent) => {
      if (ev.type === "card") {
        clearPendingDelta();
        setSnap((s) => (s ? { ...s, feed: upsertCard(s.feed, ev.card) } : s));
        return;
      }
      if (ev.type === "delta" && ev.cardId) {
        pendingDelta.current = { id: ev.cardId, text: ev.text, thinking: ev.thinking };
        if (deltaTimer.current === null) {
          deltaTimer.current = window.setTimeout(() => {
            deltaTimer.current = null;
            const d = pendingDelta.current;
            pendingDelta.current = null;
            if (!d) return;
            // 思考与正文各落各的字段：正文永远不把思考混进去
            setSnap((s) =>
              s
                ? {
                    ...s,
                    feed: s.feed.map((c) =>
                      c.id === d.id
                        ? {
                            ...c,
                            ...(d.text !== undefined ? { text: d.text } : {}),
                            ...(d.thinking !== undefined ? { thinking: d.thinking } : {}),
                          }
                        : c,
                    ),
                  }
                : s,
            );
          }, DELTA_FRAME_MIN_GAP_MS);
        }
        return;
      }
      if (ev.type === "turn") {
        setSnap((s) => (s ? { ...s, turn: ev.turn } : s));
        return;
      }
      // 窗口事件只关系到自绘标题栏的按钮态，不触发快照重拉
      if (ev.type === "window") return;
      // 工具事件：卡已经随 card 事件增量落地（emit 先落卡再广播），
      // 这里只为对齐台账/编排状态，走合并刷新——一事件一拉全量快照会把主进程拖死。
      if (ev.type === "tool") {
        refreshSoon();
        return;
      }
      // 别的会话有动静：同理，合并刷新即可
      if (ev.type === "thread") {
        refreshSoon();
        return;
      }
      // 截图只进随附条，不拉快照（拉了会重渲染整张指挥台，输入框草稿会抖）
      if (ev.type === "capture") {
        acceptShot(ev.shot);
        return;
      }
      if (ev.type === "done" || ev.type === "error") {
        // 终态一律以权威快照为准，且 refresh 有序号保护，旧响应不会覆盖新状态
        clearPendingDelta();
        void refresh();
        return;
      }
      refreshSoon();
    });
    return () => {
      off();
      if (refreshSoonTimer.current !== null) {
        window.clearTimeout(refreshSoonTimer.current);
        refreshSoonTimer.current = null;
      }
      if (deltaTimer.current !== null) {
        window.clearTimeout(deltaTimer.current);
        deltaTimer.current = null;
      }
    };
  }, [refresh, refreshSoon, acceptShot]);

  // 兜底：窗口刚起来 / 重新获得焦点时取回没接到的截图；与事件按 id 去重
  useEffect(() => {
    const pull = () => {
      void rpc("capture.pending")
        .then((r) => {
          for (const s of r.shots ?? []) acceptShot(s);
        })
        .catch(() => {
          /* 旧内核没有这个 RPC：截图仍走事件，不打扰用户 */
        });
    };
    pull();
    window.addEventListener("focus", pull);
    return () => window.removeEventListener("focus", pull);
  }, [acceptShot]);

  const desk: Desk | null = useMemo(() => (snap ? deskFromSnapshot(snap) : null), [snap]);

  // 当前会话 id 同步给截图事件回调用（acceptShot 不随快照重建）
  useEffect(() => {
    threadIdRef.current = desk?.thread.id ?? "";
  }, [desk?.thread.id]);

  /** 启动页 → 值台的交接：快照就绪后让进度补满并淡出，再切主界面（不是直接闪过去） */
  const [bootDone, setBootDone] = useState(false);
  useEffect(() => {
    if (!desk || !snap) return;
    const t = window.setTimeout(() => setBootDone(true), 280);
    return () => window.clearTimeout(t);
  }, [desk, snap]);

  const applyPermission = useCallback(
    async (mode: PermissionMode) => {
      await rpc("permission.set", { mode });
      await refresh();
    },
    [refresh],
  );

  /** 全权 = 不再逐项征询：误点一次就把门禁全撤了，代价太大，先问一句 */
  const onPermission = useCallback(
    (mode: PermissionMode) => {
      if (mode === "full" && snap?.permission !== "full") {
        setFullAsk(true);
        return;
      }
      void applyPermission(mode);
    },
    [applyPermission, snap?.permission],
  );

  useEffect(() => {
    if (!fullAsk) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFullAsk(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullAsk]);

  /**
   * 发送结果约定：null = 成功，字符串 = 失败原因（Composer 等它回来才清草稿，失败原样保留）。
   * 两种失败都要接住：RPC reject，以及壳层把内核异常包成 {error} 返回值（不 reject）。
   */
  const onSend = useCallback(
    async (
      text: string,
      mode: "queue" | "steer" = "queue",
      attachments?: { files?: string[]; images?: { name: string; data: string }[] },
    ): Promise<string | null> => {
      setNotice(null);
      // 只消费"这一发携带"的截图：发送途中新到的截图（id 不同）必须留下
      const shotAtStart = captureShotRef.current;
      const sentShotId =
        shotAtStart && attachments?.images?.some((img) => img.name === shotAtStart.shot.name && img.data === shotAtStart.shot.data)
          ? shotAtStart.shot.id
          : null;
      try {
        const r = await rpc("feed.send", { text, mode, ...(attachments ? { attachments } : {}) });
        const resError = (r as { error?: string } | undefined)?.error;
        if (resError) {
          const msg = rpcErrorText(new Error(resError), "发送失败");
          setNotice(msg);
          return msg;
        }
        if (r.queued) setNotice(`已排队（${text.slice(0, 20)}${text.length > 20 ? "…" : ""}）`);
        if (sentShotId) {
          setCaptureShot((cur) => (cur && cur.shot.id === sentShotId ? null : cur));
        }
        await refresh();
        return null;
      } catch (err) {
        const msg = `发送失败：${err instanceof Error ? err.message : String(err)}`;
        setNotice(msg);
        return msg;
      }
    },
    [refresh],
  );

  const onAbort = useCallback(async () => {
    try {
      const r = await rpc("session.abort");
      setNotice(r.aborted ? "已停止本轮。" : "没有正在运行的回合。");
      await refresh();
    } catch (err) {
      setNotice(`停止失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }, [refresh]);

  /**
   * 终止本群（2026-11-15）：成员停机 + 当前回合中断 + 心跳/巡检/验收叫醒/定时任务全停，
   * 直到用户在这个群发出新消息。与「停止本轮」（只停当前回合）是两件事。
   */
  const onHalt = useCallback(async () => {
    setNotice(null);
    try {
      const r = await rpc("thread.halt", {});
      if (!r.ok) {
        setNotice(r.error ?? "终止失败");
        return;
      }
      setNotice(
        r.stopped > 0
          ? `已终止本群：${r.stopped} 张在跑的单已停机，心跳与巡检也停了。发一条消息即可恢复。`
          : "已终止本群：心跳、巡检、验收叫醒与排队全部暂停。发一条消息即可恢复。",
      );
      await refresh();
    } catch (err) {
      setNotice(`终止失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }, [refresh]);

  const onQueue = useCallback(
    async (action: "clear" | "remove", id?: string) => {
      await rpc("session.queue", { action, id });
      await refresh();
    },
    [refresh],
  );

  /**
   * 新对话：不弹目录框（2026-11-10）。
   * 默认继承当前会话的根；要换就点顶栏的项目 chip——选择不再挡在"开新会话"这一步。
   */
  const onNew = useCallback(async () => {
    setNotice(null);
    try {
      await rpc("session.new", {});
      await refresh();
    } catch (err) {
      setNotice(`新对话失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }, [refresh]);

  /**
   * 只读授权（2026-11-10）：一次可选多个目录；盘符根需要二次确认。
   * 目录只能由用户在原生对话框里点选，模型不能替用户授权。
   */
  const onGrantRead = useCallback(
    async (taskId: string) => {
      setNotice(null);
      try {
        const picked = await rpc("app.pickDirs", { title: i18nStrings["app.pickReadDirs"] });
        const paths = picked?.paths ?? [];
        if (!paths.length) return;
        const drives = paths.filter((p) => /^[a-zA-Z]:[\\/]?$/.test(p));
        let allowDriveRoot = false;
        if (drives.length) {
          const ok = await askConfirm({
            title: i18nStrings["app.grantDriveTitle"],
            body: i18nStrings["app.grantDriveBody"].replace("{drives}", drives.join("、")),
            note: i18nStrings["app.grantDriveNote"],
            confirmLabel: i18nStrings["app.stillGrant"],
            danger: true,
          });
          if (!ok) return;
          allowDriveRoot = true;
        }
        const r = await rpc("task.grantRead", { taskId, dirs: paths, allowDriveRoot });
        if (!r.ok) setNotice(rpcResultError(r, "授权失败"));
        await refresh();
      } catch (err) {
        setNotice(rpcErrorText(err, "授权失败"));
      }
    },
    [refresh],
  );

  /** 这次不用工作区：主根清空，任务产出落卷宗沙箱 */
  const onClearWorkspace = useCallback(async () => {
    setNotice(null);
    try {
      const r = await rpc("project.clearRoot");
      if (!r.ok) setNotice(r.error ?? "清空工作区失败");
      await refresh();
    } catch (err) {
      setNotice(rpcErrorText(err, "清空工作区失败"));
    }
  }, [refresh]);

  /** 控制台 `cd`：空 = 选目录；- = 回默认；--none = 不用工作区；其它按路径（相对基于当前根） */
  const onCd = useCallback(
    async (arg: string): Promise<string> => {
      const a = arg.trim();
      try {
        if (!a) {
          const picked = await rpc("app.pickDir", { title: i18nStrings["app.pickWorkspaceTitle"] });
          if (!picked?.path) return i18nStrings["app.canceled"];
          const r = await rpc("project.setRoot", { root: picked.path });
          await refresh();
          return r.ok ? `工作区：${r.root}` : (r.error ?? "切换失败");
        }
        if (a === "--none") {
          const r = await rpc("project.clearRoot");
          await refresh();
          return r.ok ? "这次不用工作区（产出落任务卷宗）" : (r.error ?? "失败");
        }
        if (a === "-") {
          const prefs = await rpc("workspace.prefs");
          const def = prefs.defaultWorkspace;
          if (!def) return "没有设置默认工作区（可在设置 → 数据 → 工作区里设）";
          const r = await rpc("project.setRoot", { root: def });
          await refresh();
          return r.ok ? `工作区：${r.root}` : (r.error ?? "切换失败");
        }
        const r = await rpc("project.setRoot", { root: a });
        await refresh();
        return r.ok ? `工作区：${r.root}` : (r.error ?? "切换失败");
      } catch (err) {
        return `cd 失败：${err instanceof Error ? err.message : String(err)}`;
      }
    },
    [refresh],
  );

  /** 给当前会话加只读目录（可多选；整盘要确认） */
  const onAddReadRoots = useCallback(async () => {
    setNotice(null);
    try {
      const picked = await rpc("app.pickDirs", { title: i18nStrings["app.addReadDirs"] });
      const paths = picked?.paths ?? [];
      if (!paths.length) return;
      const isDrive = (p: string) => /^[a-zA-Z]:[\\/]?$/.test(p);
      const drives = paths.filter(isDrive);
      if (drives.length) {
        const ok = await askConfirm({
          title: i18nStrings["app.readRootDriveTitle"],
          body: i18nStrings["app.readRootDriveBody"].replace("{drives}", drives.join("、")),
          note: i18nStrings["app.readRootNote"],
          confirmLabel: i18nStrings["app.stillAdd"],
          danger: true,
        });
        if (!ok) return;
      }
      for (const p of paths) {
        const r = await rpc("workspace.addRoot", {
          path: p,
          mode: "ro",
          ...(isDrive(p) ? { allowDriveRoot: true } : {}),
        });
        if (!r.ok) {
          setNotice(r.error ?? "添加只读目录失败");
          break;
        }
      }
      await refresh();
    } catch (err) {
      setNotice(rpcErrorText(err, "添加只读目录失败"));
    }
  }, [refresh]);

  /** 审查快照：把工作区复制进任务沙箱再跑测试（原项目不动） */
  const onSnapshotProject = useCallback(
    async (taskId: string) => {
      setNotice(null);
      const ok = await askConfirm({
        title: i18nStrings["app.snapshotTitle"],
        body: i18nStrings["app.snapshotBody"],
        confirmLabel: i18nStrings["app.snapshotConfirm"],
      });
      if (!ok) return;
      try {
        const r = await rpc("task.snapshotProject", { taskId });
        if (!r.ok) setNotice(r.error ?? "快照失败");
        else setNotice(`已复制进任务沙箱：${r.root ?? ""}`);
        await refresh();
      } catch (err) {
        setNotice(rpcErrorText(err, "快照失败"));
      }
    },
    [refresh],
  );

  /** 导出任务卷宗 zip（交付物 + 时间线 + 摘要），导出后用系统程序打开 */
  const onExportTask = useCallback(
    async (taskId: string) => {
      setNotice(null);
      try {
        const r = await rpc("task.export", { taskId });
        if (!r.ok) {
          setNotice(r.error ?? "导出失败");
        } else {
          setNotice(`已导出 ${r.path ?? ""}`);
          if (r.path) await rpc("app.openPath", { path: r.path });
        }
        await refresh();
      } catch (err) {
        setNotice(rpcErrorText(err, "导出失败"));
      }
    },
    [refresh],
  );

  /** 交付物右键菜单（2026-11-13）：打开文件 / 打开所在目录 / 移除 */
  const onOpenDeliverable = useCallback(
    async (taskId: string, ref: string) => {
      setNotice(null);
      try {
        const r = await rpc("evidence.open", { taskId, ref });
        if (!r.ok) setNotice(rpcResultError(r, "打开失败"));
      } catch (err) {
        setNotice(rpcErrorText(err, "打开失败"));
      }
    },
    [],
  );

  const onRevealDeliverable = useCallback(
    async (taskId: string, ref: string) => {
      setNotice(null);
      try {
        const r = await rpc("app.revealPath", { taskId, ref });
        if (!r.ok) setNotice(rpcResultError(r, "定位失败"));
      } catch (err) {
        setNotice(rpcErrorText(err, "定位失败"));
      }
    },
    [],
  );

  const onRemoveDeliverable = useCallback(
    async (taskId: string, ref: string, deleteFile: boolean) => {
      setNotice(null);
      // 确认已经在交付箱的确认卡片里点过了（"只移除记录"与"连文件一起删"是卡片上的两个按钮），
      // 这里不再叠第二次系统弹窗（2026-11-15）。
      try {
        const r = await rpc("task.removeDeliverable", { taskId, ref, deleteFile });
        if (!r.ok) setNotice(rpcResultError(r, "移除失败"));
        else setNotice(r.removedFile ? "已移除并删除文件。" : "已从交付箱移除（文件保留）。");
        await refresh();
      } catch (err) {
        setNotice(rpcErrorText(err, "移除失败"));
      }
    },
    [refresh],
  );

  const onRemoveReadRoot = useCallback(
    async (p: string) => {
      setNotice(null);
      try {
        const r = await rpc("workspace.removeRoot", { path: p });
        if (!r.ok) setNotice(r.error ?? "撤销失败");
        await refresh();
      } catch (err) {
        setNotice(rpcErrorText(err, "撤销失败"));
      }
    },
    [refresh],
  );

  /** 换当前会话的工作区（点顶栏面包屑里的项目名）
   *
   * 2026-11-13：不再甩一句"这个目录还没被信任"就完事。
   * 信任闸门只管两样东西（项目级 MCP 配置与项目级技能）——
   *  目录里两样都没有 → 信任与否毫无区别 → 什么都不用说；
   *  有 → 当场问一句「信任并加载 / 先不信任」，让用户在这一步就决定完。
   */
  const onPickProject = useCallback(async () => {
    setNotice(null);
    try {
      const picked = await rpc("app.pickDir", { title: i18nStrings["app.pickThreadWorkspace"] });
      if (!picked?.path) return;
      const r = await rpc("project.setRoot", { root: picked.path });
      if (!r.ok) {
        setNotice(r.error ?? "换工作区失败");
        return;
      }
      const gated = r.gated ?? { mcp: false, skills: false };
      const withheld: string[] = [];
      if (gated.mcp) withheld.push("项目级 MCP 配置");
      if (gated.skills) withheld.push("项目级技能");
      if (r.trusted || !withheld.length) {
        // 已信任，或这个目录压根没有要闸的东西 → 不用打扰
        await refresh();
        return;
      }
      setTrustAsk({ root: r.root ?? picked.path, withheld, servers: r.mcpServers ?? [] });
    } catch (err) {
      setNotice(rpcErrorText(err, "换工作区失败"));
    }
  }, [refresh]);

  /** 信任当前项目：加载项目级 MCP 与技能 */
  const onTrustProject = useCallback(
    async (trusted: boolean) => {
      setTrustAsk(null);
      setNotice(null);
      try {
        const r = await rpc("trust.set", { trusted });
        if (!r.ok) setNotice(r.error ?? "设置信任失败");
        else setNotice(trusted ? "已信任当前项目：项目级 MCP 与技能已加载。" : "已取消信任：项目级 MCP 与技能不再加载。");
        await refresh();
      } catch (err) {
        setNotice(rpcErrorText(err, "设置信任失败"));
      }
    },
    [refresh],
  );

  /** 改项目显示名（改的是项目：绑在它上面的群一起变） */
  const onRenameProject = useCallback(
    async (name: string) => {
      setNotice(null);
      const id = desk?.workspaceProjectId;
      if (!id) {
        setNotice("还没有项目可改名：先选一个工作目录。");
        return;
      }
      try {
        const r = await rpc("project.rename", { id, name });
        if (!r.ok) setNotice(r.error ?? "改名失败");
        await refresh();
      } catch (err) {
        setNotice(rpcErrorText(err, "改名失败"));
      }
    },
    [desk?.workspaceProjectId, refresh],
  );

  /** 撤销上一轮文件改动（M1-12）：改过的还原、新建的删掉，结果必须可见 */
  const onUndo = useCallback(async () => {
    setNotice(null);
    try {
      const r = await rpc("session.undo", {});
      if (!r.ok) setNotice(r.error ?? "没有可撤销的改动");
      await refresh();
    } catch (err) {
      setNotice(`撤销失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }, [refresh]);

  /**
   * 裁决结果约定：null = 已受理，字符串 = 失败原因。
   * 审查台打回靠它决定"显示成功还是保留三要素"；规则不允许（证据缺失/三要素不全）如实回显。
   */
  const onDecision = useCallback(
    async (
      taskId: string,
      action: "approve" | "reject",
      reason?: { what: string; expect: string; deadline: string },
    ): Promise<string | null> => {
      if (!taskId) return "没有指定工单";
      let failure: string | null = null;
      try {
        const r = await rpc("task.decide", { taskId, action, reason });
        if (!r.ok) failure = `裁不了：${r.error}`;
      } catch (err) {
        failure = `裁决失败：${err instanceof Error ? err.message : String(err)}`;
      }
      if (failure) setNotice(failure);
      await refresh();
      return failure;
    },
    [refresh],
  );

  const onDecisionResolve = useCallback(
    async (id: string, action: "answer" | "start" | "revise" | "reject", text?: string, always?: boolean) => {
      try {
        const r = await rpc("decision.resolve", { id, action, text, always });
        if (!r.ok) setNotice(r.error);
      } catch (err) {
        setNotice(`处理失败：${err instanceof Error ? err.message : String(err)}`);
      }
      await refresh();
    },
    [refresh],
  );

  /** 错误卡上的一个动作：设置 / 重试 / 日志 / 重启运行时 */
  const onFeedAction = useCallback(
    (card: FeedCard) => {
      if (card.action === "settings") {
        setSettingsOpen(true);
        return;
      }
      if (card.action === "reload") {
        void rpc("session.reload").then(() => refresh());
        return;
      }
      if (card.action === "logs") {
        void rpc("app.openData", { kind: "logs" });
        return;
      }
      if (card.action === "retry") {
        const lastUser = [...(snap?.feed ?? [])].reverse().find((c) => c.kind === "user");
        if (lastUser?.text) void onSend(lastUser.text, "queue");
      }
      if (card.action === "stopRunning") {
        // C4：新会话提示卡上的"全部停掉"——后台成员不因换会话而自己收手
        void rpc("task.cancelAll")
          .then(async (r) => {
            setNotice(r.stopped > 0 ? `已停 ${r.stopped} 张在跑的单。` : "没有在跑的单。");
            await refresh();
          })
          .catch((err) => setNotice(rpcErrorText(err, "停机失败")));
      }
    },
    [onSend, refresh, snap?.feed],
  );

  // 桌宠暂时停用（2026-11-15）：?pet=1 不再渲染，返回空（旧链接不会白屏报错）。
  // 恢复：改回 if (isPet) return <Pet />; 并取消顶部 Pet 的 import 注释。
  if (isPet) return null;

  // ?boot=1 是走查夹具：让启动页常驻（进度停在 90% 等真实快照），方便截图检查版式与动效
  const bootPreview = typeof location !== "undefined" && new URLSearchParams(location.search).get("boot") === "1";
  // 同时保留 !desk || !snap 这个收窄：下方所有分支都依赖 desk/snap 非空
  if (!bootDone || bootPreview || !desk || !snap)
    return <BootScreen ready={!!(desk && snap) && !bootPreview} label={i18nStrings["boot.starting"]} />;

  if (wizardOpen) {
    // 向导也要包 I18nProvider：WindowControls 的 tooltip 走 useT，
    // 没有 Provider 时字典为空，按钮上会直接露出 "win.minimize" 这种键名
    return (
      <I18nProvider strings={i18nStrings}>
        <Wizard
          current={snap.model}
          theme={theme.id}
          mode={theme.mode}
          onTheme={changeTheme}
          onDone={(r) => void finishWizard(r)}
          onSkip={() => {
            localStorage.setItem("lynn.onboarded", "1");
            setWizardOpen(false);
          }}
        />
      </I18nProvider>
    );
  }

  if (standby) {
    return <Standby desk={desk} ambient={ambient} mode={ambientMode} onExit={() => setStandby(false)} />;
  }

  return (
    <I18nProvider strings={i18nStrings}>
      {/* 桌面壁纸（2026-11-19）：**两层**——壁纸 + 磨砂遮罩，组件本身保持不透明。
          为什么不是"给每张卡调透明度"：实测白卡 60% 不透明叠在黑壁纸上，ink-3 只有
          2.9:1（要 4.5）。遮罩把壁纸压到安全亮度区间，卡片里的字一个像素都不用妥协。
          性能：全屏就这 2 个图层，模糊只发生 1 次；绝不给每张卡加 backdrop-filter（那是 O(卡片数)）。 */}
      <Wallpaper />
      {/* 确认卡片宿主：所有"做了就回不去"的动作都走这一张卡（2026-11-15） */}
      <AskHost />
      {/* 右下角提示堆叠（2026-11-16）：版本提示与错误条同时出现时按列排、按内容各自长高，
          不再靠两条各自写死 bottom 错开（错误文案换行变高就会压到上一条）。
          两条都复用 stale-bar 骨相；err-bar 把图标换成红线色——铜色读作"提示"，出事要一眼看出来。 */}
      {(staleBackend || notice) && (
        <div className="toast-stack">
          {staleBackend && (
            <div className="stale-bar" role="status">
              <Icon name="warn" size="sm" />
              <span>{i18nStrings["app.stale"] ?? "后台是旧版本（界面已更新，内核还没重启）：新加的操作可能不生效。"}</span>
              <button
                type="button"
                className="ghost-btn"
                onClick={() => {
                  void rpc("app.restart").catch(() => setStaleBackend(false));
                }}
              >
                {i18nStrings["app.restart"] ?? "重启应用"}
              </button>
              <button
                type="button"
                className="icon-btn"
                onClick={() => setStaleBackend(false)}
                aria-label={i18nStrings["common.close"] ?? "关闭"}
              >
                <Icon name="x" size="sm" />
              </button>
            </div>
          )}
          {/* 全局错误条：发送/裁决等失败必须值台、审查台、控制台都看得见——
              此前只挂在值台输入框下面，审查台与控制台里失败等于静默。 */}
          {notice && (
            <div className="stale-bar err-bar" role="alert">
              <Icon name="warn" size="sm" />
              <span>{notice}</span>
              <button
                type="button"
                className="icon-btn"
                onClick={() => setNotice(null)}
                aria-label={i18nStrings["common.close"] ?? "关闭"}
              >
                <Icon name="x" size="sm" />
              </button>
            </div>
          )}
        </div>
      )}
      {ConsoleHost ? (
        <ConsoleHost
          desk={desk}
          permission={snap.permission}
          configured={snap.model.configured}
          onExit={() => chooseStage("desk")}
          onSend={(t) => void onSend(t, "queue")}
          onCd={onCd}
          onAbort={() => void onAbort()}
          onHalt={() => void onHalt()}
          onPermission={(m) => void onPermission(m)}
          onOpenSettings={() => {
            setSettingsTab(undefined);
            setSettingsOpen(true);
          }}
          onDecisionResolve={(id, a, t, always) => void onDecisionResolve(id, a, t, always)}
          onDecision={(taskId, action, reason) => void onDecision(taskId, action, reason)}
          onCancelTask={(taskId) => {
            void rpc("task.cancel", { taskId }).then(async (r) => {
              if (!r.ok) setNotice(rpcResultError(r, "停不下来"));
              await refresh();
            });
          }}
          onDismissTask={(taskId) => {
            void rpc("task.dismiss", { taskId }).then(async (r) => {
              if (!r.ok) setNotice(rpcResultError(r, "取消失败"));
              await refresh();
            });
          }}
          onRemoveTask={(taskId) => {
            setNotice(null);
            void rpc("task.remove", { taskId })
              .then(async (r) => {
                if (!r.ok) setNotice(rpcResultError(r, "删除失败"));
                else if (r.kept?.length) setNotice(`已删工单与卷宗；${r.kept.join("、")} 里的文件没动。`);
                await refresh();
              })
              .catch((err) => setNotice(rpcErrorText(err, "删除失败")));
          }}
          onGrantRead={onGrantRead}
          onReopenTask={(taskId) => {
            setNotice(null);
            void rpc("task.decide", { taskId, action: "reopen" })
              .then(async (r) => {
                if (!r.ok) setNotice(rpcResultError(r, "重开失败"));
                await refresh();
              })
              .catch((err) => setNotice(rpcErrorText(err, "重开失败")));
          }}
          onPurgeOrphans={() => {
            setNotice(null);
            void rpc("task.purgeOrphans")
              .then(async (r) => {
                setNotice(
                  `清掉 ${r.removed} 张无主单${r.kept ? `，${r.kept} 张目录被占用没删掉` : ""}。`,
                );
                await refresh();
              })
              .catch((err) => setNotice(rpcErrorText(err, "清理失败")));
          }}
        />
      ) : (
      <DeskView
        desk={desk}
        permission={snap.permission}
        configured={snap.model.configured}
        ambient={ambient}
        ambientMode={ambientMode}
        onPermission={(m) => void onPermission(m)}
        onSend={(t, mode, att) => onSend(t, mode, att)}
        onFileSearch={(q) => rpc("files.search", { q }).then((r) => r.files)}
        onAbort={() => void onAbort()}
        onQueue={(a, id) => void onQueue(a, id)}
        onDecision={(id, a, reason) => onDecision(id, a, reason)}
        onDecisionResolve={(id, a, text) => void onDecisionResolve(id, a, text)}
        onFeedAction={onFeedAction}
        onHalt={() => void onHalt()}
        onOpenSettings={() => {
          setSettingsTab(undefined);
          setSettingsOpen(true);
        }}
        onManageTeam={() => {
          setSettingsTab("team");
          setSettingsOpen(true);
        }}
        onPickProject={() => void onPickProject()}
        onTrustProject={(trusted) => void onTrustProject(trusted)}
        onRenameProject={(name) => void onRenameProject(name)}
        onClearWorkspace={() => void onClearWorkspace()}
        onAddReadRoots={() => void onAddReadRoots()}
        onRemoveReadRoot={(p) => void onRemoveReadRoot(p)}
        onSnapshotProject={(id) => void onSnapshotProject(id)}
        onExportTask={(id) => void onExportTask(id)}
        onOpenDeliverable={(id, ref) => void onOpenDeliverable(id, ref)}
        onRevealDeliverable={(id, ref) => void onRevealDeliverable(id, ref)}
        onRemoveDeliverable={(id, ref, del) => void onRemoveDeliverable(id, ref, del)}
        onStandby={() => setStandby(true)}
        onNew={() => void onNew()}
        onUndo={() => void onUndo()}
        onThread={(id) => {
          setNotice(null);
          void rpc("thread.switch", { id }).then(() => refresh());
        }}
        onThreadNew={() => void onNew()}
        onThreadSearch={(q) => rpc("thread.search", { q }).then((r) => r.results)}
        onThreadRename={(id, title) => {
          setNotice(null);
          void rpc("thread.rename", { id, title })
            .then(() => refresh())
            .catch((err) => setNotice(`会话改名失败：${err instanceof Error ? err.message : String(err)}`));
        }}
        onThreadPin={(id, pinned) => {
          setNotice(null);
          void rpc("thread.pin", { id, pinned })
            .then(() => refresh())
            .catch((err) => setNotice(`置顶失败：${err instanceof Error ? err.message : String(err)}`));
        }}
        onAnnounce={(text) => {
          setNotice(null);
          const id = desk.thread.id;
          void rpc("thread.announcement", { id, text })
            .then(() => refresh())
            .catch((err) => setNotice(`群公告没存上：${err instanceof Error ? err.message : String(err)}`));
        }}
        onThreadRemove={(id) => {
          setNotice(null);
          void rpc("thread.remove", { id })
            .then((r) => {
              // 会话=任务容器：删会话会连带清掉它名下的工单，清了几张必须说出来，
              // 否则用户只会发现"工单自己消失了"，比留着更让人不安
              const n = r.removedTasks ?? 0;
              const kept = r.keptTasks ?? 0;
              if (n || kept) {
                setNotice(
                  `已删会话，连带清掉 ${n} 张工单${kept ? `（还有 ${kept} 张目录被占用，留在台账里）` : ""}。`,
                );
              } else if (r.threadsLeft === 0) {
                setNotice("会话都删光了。说一句话就会顺手再开一条。");
              }
              return refresh();
            })
            .catch((err) => setNotice(`删除会话失败：${err instanceof Error ? err.message : String(err)}`));
        }}
        onTaskFeed={(taskId) => rpc("task.feed", { taskId })}
        onCancelTask={(taskId) => {
          void rpc("task.cancel", { taskId }).then(async (r) => {
            if (!r.ok) setNotice(rpcResultError(r, "停不下来"));
            await refresh();
          });
        }}
        onDismissTask={(taskId) => {
          setNotice(null);
          void rpc("task.dismiss", { taskId })
            .then(async (r) => {
              if (!r.ok) setNotice(rpcResultError(r, "取消失败"));
              await refresh();
            })
            .catch((err) => setNotice(rpcErrorText(err, "取消失败")));
        }}
        onRemoveTask={(taskId) => {
          setNotice(null);
          void rpc("task.remove", { taskId })
            .then(async (r) => {
              if (!r.ok) setNotice(rpcResultError(r, "删除失败"));
              else if (r.kept?.length) setNotice(`已删工单与卷宗；${r.kept.join("、")} 里的文件没动。`);
              await refresh();
            })
            .catch((err) => setNotice(rpcErrorText(err, "删除失败")));
        }}
        onGrantRead={onGrantRead}
        onRevokeRead={(taskId) => {
          setNotice(null);
          void rpc("task.revokeRead", { taskId })
            .then(async (r) => {
              if (!r.ok) setNotice(rpcResultError(r, "撤销失败"));
              await refresh();
            })
            .catch((err) => setNotice(rpcErrorText(err, "撤销失败")));
        }}
        onCreateTeam={(name) => {
          void rpc("team.create", { name }).then(async (r) => {
            if (!r.ok) setNotice(`建团队失败：${r.error ?? "未知原因"}`);
            await refresh();
          });
        }}
        captureShot={captureShot && captureShot.threadId === desk.thread.id ? captureShot.shot : null}
      />
      )}
      {/* 有控制台可用、但当前不在控制台时才给入口（插件停用 → 卡槽空 → 入口一并消失） */}
      {consoleSlot && !ConsoleHost && !settingsOpen && (
        <div className="cs-viewswitch" role="group" aria-label={i18nStrings["app.viewSwitch"]}>
          <span className="cs-vs-cur">{i18nStrings["app.desk"]}</span>
          <button type="button" onClick={() => chooseStage("console")} title={i18nStrings["app.toConsole"]}>
            {i18nStrings["app.console"]} <span aria-hidden="true">›</span>
          </button>
        </div>
      )}
      {fullAsk && (
        <div
          className="perm-overlay"
          onClick={(e) => e.target === e.currentTarget && setFullAsk(false)}
        >
          <div
            className="perm-ask"
            role="dialog"
            aria-modal="true"
            aria-label={i18nStrings["perm.fullAsk.title"] ?? "切到全权？"}
          >
            <div className="perm-ask-head">
              <Icon name="warn" size="sm" />
              <span>{i18nStrings["perm.fullAsk.title"] ?? "切到全权？"}</span>
            </div>
            <p className="perm-ask-body">
              {i18nStrings["perm.fullAsk.body"] ??
                "风铃将不再逐项征询你的同意：可读写工作区文件、执行命令、操作浏览器。确认后随时可以切回其它档位。"}
            </p>
            <div className="perm-ask-acts">
              <button type="button" className="perm-btn" onClick={() => setFullAsk(false)}>
                {i18nStrings["perm.fullAsk.cancel"] ?? "取消"}
              </button>
              <button
                type="button"
                className="perm-btn go"
                onClick={() => {
                  setFullAsk(false);
                  void applyPermission("full");
                }}
              >
                {i18nStrings["perm.fullAsk.confirm"] ?? "确认开启"}
              </button>
            </div>
          </div>
        </div>
      )}
      {/* 信任询问（2026-11-13）：选完目录当场问，不把用户扔去设置里自己找 */}
      {trustAsk && (
        <div
          className="perm-overlay"
          onClick={(e) => e.target === e.currentTarget && setTrustAsk(null)}
        >
          <div className="perm-ask" role="dialog" aria-modal="true" aria-label={i18nStrings["trust.askTitle"]}>
            <div className="perm-ask-head">
              <Icon name="shield" size="sm" />
              <span>{i18nStrings["trust.askTitle"] ?? "信任这个项目？"}</span>
            </div>
            <p className="perm-ask-body">
              {i18nStrings["trust.askBody"]?.replace("{root}", trustAsk.root).replace(
                "{items}",
                trustAsk.withheld.join("与"),
              ) ??
                `这个目录里有${trustAsk.withheld.join("与")}。信任后会加载它们（项目级 MCP 会启动外部进程）；不信任也能干活，只是这些不会生效。`}
            </p>
            {/* 审计 #7：信任前让用户看到到底会跑什么命令，别闭眼点头 */}
            {trustAsk.servers.length > 0 && (
              <div className="perm-ask-servers">
                <div className="perm-ask-servers-cap">
                  {i18nStrings["trust.askServers"] ?? "信任后将启动这些外部进程："}
                </div>
                {trustAsk.servers.map((s) => (
                  <div key={s.id} className="perm-ask-server">
                    <span className="mono">{s.id}</span>
                    <span className="mono">{[s.command, ...s.args].join(" ")}</span>
                    {s.envKeys.length > 0 && <span className="perm-ask-env">env: {s.envKeys.join(", ")}</span>}
                  </div>
                ))}
              </div>
            )}
            <div className="perm-ask-acts">
              <button type="button" className="perm-btn" onClick={() => setTrustAsk(null)}>
                {i18nStrings["trust.askSkip"] ?? "先不信任"}
              </button>
              <button type="button" className="perm-btn go" onClick={() => void onTrustProject(true)}>
                {i18nStrings["trust.askAccept"] ?? "信任并加载"}
              </button>
            </div>
          </div>
        </div>
      )}
      {settingsOpen && (
        <SettingsModal
          current={snap.model}
          theme={theme.id}
          mode={theme.mode}
          avatar={avatar}
          ambientMode={ambientMode}
          members={desk.members.map((m) => ({ name: m.name, role: m.role }))}
          autoStart={snap.prefs.autoStart}
          trayOnClose={snap.prefs.trayOnClose}
          notify={snap.prefs.notify}
          lang={snap.prefs.lang}
          voiceEnabled={snap.prefs.voiceEnabled ?? true}
          voiceId={snap.prefs.voiceId ?? "zh-CN-XiaoxiaoNeural"}
          voiceRate={snap.prefs.voiceRate ?? "+0%"}
          voiceVolume={snap.prefs.voiceVolume ?? "+0%"}
          voiceScope={snap.prefs.voiceScope ?? "brief"}
          voiceMaxChars={snap.prefs.voiceMaxChars ?? 120}
          voiceWhenHidden={snap.prefs.voiceWhenHidden ?? false}
          voiceProxy={snap.prefs.voiceProxy ?? ""}
          wallpaper={snap.prefs.wallpaper ?? ""}
          wallpaperStrength={snap.prefs.wallpaperStrength ?? 60}
          wallpaperLayers={snap.prefs.wallpaperLayers}
          project={snap.project}
          usage={snap.usage}
          onTheme={changeTheme}
          onAvatar={changeAvatar}
          onPack={applyPack}
          onApplyThemeTokens={(tokens) => applyPluginTokens(tokens)}
          onApplyPluginStyle={(id, css) => applyPluginStyle(id, css)}
          onAmbient={(m) => {
            setAmbientMode(m);
            localStorage.setItem("lynn.ambient", m);
          }}
          onAutoStart={(v) => {
            void rpc("config.prefs", { autoStart: v }).then(() => refresh());
          }}
          onPrefs={(p) => {
            void rpc("config.prefs", { autoStart: snap.prefs.autoStart, ...p }).then(() => refresh());
          }}
          onTrust={(trusted) => {
            void rpc("trust.set", { trusted }).then(() => {
              // MCP 重连是后台的：等它落完再刷快照
              setTimeout(() => void refresh(), 800);
            });
          }}
          onClose={() => setSettingsOpen(false)}
          onSaved={() => void refresh()}
          initialTab={settingsTab}
        />
      )}
    </I18nProvider>
  );
}
