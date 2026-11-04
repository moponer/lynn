import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  FeedCard,
  KernelEvent,
  PermissionMode,
  RpcContracts,
  RpcMethod,
  SessionSnapshot,
} from "../shared/contract";
import { SettingsModal } from "./components/SettingsModal";
import { Icon } from "./components/Icon";
import { DeskView } from "./desk/Desk";
import { deskFromSnapshot, type Desk } from "./desk/model";
import { applyPluginTokens, applyTheme, loadTheme, type ThemeId, type ThemeMode } from "./desk/theme";
import type { LynnPack } from "./desk/lynnpack";
import { Wizard, type WizardResult } from "./desk/Wizard";
import { Standby } from "./desk/Standby";
import { Pet } from "./desk/Pet";
import { ambientForTheme, type AmbientMode } from "../shared/ambient";
import { ZH_STRINGS } from "../shared/i18n-strings";
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
  if (i < 0) return [...feed, card];
  const next = feed.slice();
  next[i] = card;
  return next;
}

export default function App() {
  /** 桌宠小窗：同一个渲染层，只挂形象 */
  const isPet = typeof location !== "undefined" && new URLSearchParams(location.search).get("pet") === "1";
  const [snap, setSnap] = useState<SessionSnapshot | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [theme, setTheme] = useState(() => loadTheme());
  const [wizardOpen, setWizardOpen] = useState(() => !localStorage.getItem("lynn.onboarded"));
  const [standby, setStandby] = useState(false);
  const [ambientMode, setAmbientMode] = useState<AmbientMode>(
    () => (localStorage.getItem("lynn.ambient") as AmbientMode) || "low",
  );
  const ambient = useMemo(() => ambientForTheme(theme.id), [theme.id]);
  const [avatar, setAvatar] = useState(() => localStorage.getItem("lynn.avatar") !== "0");
  const [notice, setNotice] = useState<string | null>(null);
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

  // 版本握手：旧内核没有 app.info（返回 {error}）或构建时间落后于界面 → 顶部提示「重启应用」
  useEffect(() => {
    let dead = false;
    rpc("app.info")
      .then((r) => {
        if (dead) return;
        const res = r as { buildAt?: string; error?: string };
        if (res.error || !res.buildAt) {
          setStaleBackend(true);
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
    setTheme({ id, mode });
  }, []);

  const changeAvatar = useCallback((on: boolean) => {
    setAvatar(on);
    localStorage.setItem("lynn.avatar", on ? "1" : "0");
  }, []);

  /** .lynnpack 导入：只应用配置（主题 / 形象），不含 Key、不含记忆 */
  const applyPack = useCallback(
    (p: LynnPack) => {
      changeTheme(p.theme.id, p.theme.mode);
      changeAvatar(p.avatar);
    },
    [changeAvatar, changeTheme],
  );

  const refresh = useCallback(async () => {
    try {
      setSnap(await rpc("session.snapshot"));
    } catch (err) {
      setNotice(`读取会话失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }, []);

  /** 造铃完成：主题立即生效；Key 有才写盘 */
  const finishWizard = useCallback(
    async (r: WizardResult) => {
      changeTheme(r.theme, r.mode);
      if (r.apiKey) {
        try {
          await rpc("config.save", {
            provider: r.provider,
            baseUrl: r.baseUrl,
            model: r.model,
            apiKey: r.apiKey,
          });
        } catch {
          // 存 Key 失败不阻塞进入主界面；用户可在「我的风铃」里重填
        }
      }
      localStorage.setItem("lynn.onboarded", "1");
      changeAvatar(r.avatar);
      setWizardOpen(false);
      await refresh();
    },
    [changeAvatar, changeTheme, refresh],
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

  // 流式补字合帧（对齐蓝本 tether-ai 的 rAF 合并）：一帧最多一次 setState，
  // 否则每个 delta 都重建整棵 feed，长回复会一顿一顿
  const pendingDelta = useRef<{ id: string; text: string } | null>(null);
  const deltaFrame = useRef<number | null>(null);

  useEffect(() => {
    // 增量事件：卡片 upsert / 流式补字 / 回合状态；只有完成与错误才拉权威快照
    const off = window.lynn.onEvent((ev: KernelEvent) => {
      if (ev.type === "card") {
        setSnap((s) => (s ? { ...s, feed: upsertCard(s.feed, ev.card) } : s));
        return;
      }
      if (ev.type === "delta" && ev.cardId) {
        pendingDelta.current = { id: ev.cardId, text: ev.text };
        if (deltaFrame.current === null) {
          deltaFrame.current = window.requestAnimationFrame(() => {
            deltaFrame.current = null;
            const d = pendingDelta.current;
            pendingDelta.current = null;
            if (!d) return;
            setSnap((s) => (s ? { ...s, feed: s.feed.map((c) => (c.id === d.id ? { ...c, text: d.text } : c)) } : s));
          });
        }
        return;
      }
      if (ev.type === "turn") {
        setSnap((s) => (s ? { ...s, turn: ev.turn } : s));
        return;
      }
      // 窗口事件只关系到自绘标题栏的按钮态，不触发快照重拉
      if (ev.type === "window") return;
      void refresh();
    });
    return () => {
      off();
      if (deltaFrame.current !== null) {
        window.cancelAnimationFrame(deltaFrame.current);
        deltaFrame.current = null;
      }
    };
  }, [refresh]);

  const desk: Desk | null = useMemo(() => (snap ? deskFromSnapshot(snap) : null), [snap]);

  const onPermission = useCallback(
    async (mode: PermissionMode) => {
      await rpc("permission.set", { mode });
      await refresh();
    },
    [refresh],
  );

  /** 发送失败必须可见：之前用 void 吞掉了 rejection，界面一片空白 */
  const onSend = useCallback(
    async (text: string, mode: "queue" | "steer" = "queue", attachments?: { files?: string[]; images?: { name: string; data: string }[] }) => {
      setNotice(null);
      try {
        const r = await rpc("feed.send", { text, mode, ...(attachments ? { attachments } : {}) });
        if (r.queued) setNotice(`已排队（${text.slice(0, 20)}${text.length > 20 ? "…" : ""}）`);
        await refresh();
      } catch (err) {
        setNotice(`发送失败：${err instanceof Error ? err.message : String(err)}`);
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

  const onQueue = useCallback(
    async (action: "clear" | "remove", id?: string) => {
      await rpc("session.queue", { action, id });
      await refresh();
    },
    [refresh],
  );

  /**
   * 新对话：先问"这个会话用哪个工作区"（取消 = 沿用当前）。
   * 不同会话各带一个工作区，"审查 A 项目"和"整理 B 资料"不会串目录。
   */
  const onNew = useCallback(async () => {
    setNotice(null);
    try {
      let projectRoot: string | undefined;
      try {
        const picked = await rpc("app.pickDir", { title: "新会话的工作区（取消 = 沿用当前工作区）" });
        projectRoot = picked?.path;
      } catch {
        // 旧内核没有 app.pickDir：沿用当前工作区，不打断新建
        projectRoot = undefined;
      }
      await rpc("session.new", projectRoot ? { projectRoot } : {});
      await refresh();
    } catch (err) {
      setNotice(`新对话失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }, [refresh]);

  /** 换当前会话的工作区（点顶栏面包屑里的项目名） */
  const onPickProject = useCallback(async () => {
    setNotice(null);
    try {
      const picked = await rpc("app.pickDir", { title: "选择这个会话的工作区" });
      if (!picked?.path) return;
      const r = await rpc("project.setRoot", { root: picked.path });
      if (!r.ok) setNotice(r.error ?? "换工作区失败");
      else if (!r.trusted) setNotice("工作区已切换；这个目录还没被信任，项目级插件与 MCP 不会加载。");
      await refresh();
    } catch (err) {
      setNotice(rpcErrorText(err, "换工作区失败"));
    }
  }, [refresh]);

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

  const onDecision = useCallback(
    async (
      taskId: string,
      action: "approve" | "reject",
      reason?: { what: string; expect: string; deadline: string },
    ) => {
      if (!taskId) return;
      try {
        const r = await rpc("task.decide", { taskId, action, reason });
        if (!r.ok) {
          // 规则不允许（证据缺失 / 无拍板 / 三要素不全）：如实回显，不假装成功
          setNotice(`裁不了：${r.error}`);
        }
      } catch (err) {
        setNotice(`裁决失败：${err instanceof Error ? err.message : String(err)}`);
      }
      await refresh();
    },
    [refresh],
  );

  const onDecisionResolve = useCallback(
    async (id: string, action: "answer" | "start" | "revise" | "reject", text?: string) => {
      try {
        const r = await rpc("decision.resolve", { id, action, text });
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

  if (isPet) return <Pet />;

  if (!desk || !snap) {
    return (
      <div className="boot">
        <div className="boot-mark">风铃</div>
        <p className="mono">正在展开图纸…</p>
      </div>
    );
  }

  if (wizardOpen) {
    return (
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
    );
  }

  if (standby) {
    return <Standby desk={desk} ambient={ambient} mode={ambientMode} onExit={() => setStandby(false)} />;
  }

  return (
    <I18nProvider strings={i18nStrings}>
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
          <button type="button" className="icon-btn" onClick={() => setStaleBackend(false)} aria-label="close">
            <Icon name="x" size="sm" />
          </button>
        </div>
      )}
      <DeskView
        desk={desk}
        permission={snap.permission}
        configured={snap.model.configured}
        ambient={ambient}
        ambientMode={ambientMode}
        onPermission={(m) => void onPermission(m)}
        onSend={(t, mode, att) => void onSend(t, mode, att)}
        onFileSearch={(q) => rpc("files.search", { q }).then((r) => r.files)}
        onAbort={() => void onAbort()}
        onQueue={(a, id) => void onQueue(a, id)}
        onDecision={(id, a, reason) => void onDecision(id, a, reason)}
        onDecisionResolve={(id, a, text) => void onDecisionResolve(id, a, text)}
        onFeedAction={onFeedAction}
        onOpenSettings={() => setSettingsOpen(true)}
        onPickProject={() => void onPickProject()}
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
        onThreadRemove={(id) => {
          setNotice(null);
          void rpc("thread.remove", { id })
            .then(() => refresh())
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
              await refresh();
            })
            .catch((err) => setNotice(rpcErrorText(err, "删除失败")));
        }}
        onGrantRead={(taskId) => {
          setNotice(null);
          // 目录由用户在原生的选择框里点选——模型不能替用户授权
          void rpc("app.pickDir", { title: "选择要授权只读访问的目录" })
            .then(async (p) => {
              if (!p.path) return;
              const r = await rpc("task.grantRead", { taskId, dir: p.path });
              if (!r.ok) setNotice(rpcResultError(r, "授权失败"));
              await refresh();
            })
            .catch((err) => setNotice(rpcErrorText(err, "授权失败")));
        }}
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
        notice={notice}
      />
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
          project={snap.project}
          usage={snap.usage}
          onTheme={changeTheme}
          onAvatar={changeAvatar}
          onPack={applyPack}
          onApplyThemeTokens={(tokens) => applyPluginTokens(tokens)}
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
        />
      )}
    </I18nProvider>
  );
}
