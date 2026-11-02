import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  FeedCard,
  KernelEvent,
  PermissionMode,
  RpcContracts,
  RpcMethod,
  SessionSnapshot,
} from "../shared/contract";
import { SettingsModal } from "./components/SettingsModal";
import { DeskView } from "./desk/Desk";
import { deskFromSnapshot, type Desk } from "./desk/model";
import { applyPluginTokens, applyTheme, loadTheme, type ThemeId, type ThemeMode } from "./desk/theme";
import type { LynnPack } from "./desk/lynnpack";
import { Wizard, type WizardResult } from "./desk/Wizard";
import { Standby } from "./desk/Standby";
import { Pet } from "./desk/Pet";
import { ambientForTheme, type AmbientMode } from "../shared/ambient";

/** 渲染层只认 contract.ts 里的类型化 RPC；不感知内核实现是直连还是 Pi。 */
async function rpc<M extends RpcMethod>(
  method: M,
  ...args: RpcContracts[M]["params"] extends void ? [] : [RpcContracts[M]["params"]]
): Promise<RpcContracts[M]["result"]> {
  return window.lynn.rpc(method, ...args);
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

  useEffect(() => {
    // 增量事件：卡片 upsert / 流式补字 / 回合状态；只有完成与错误才拉权威快照
    const off = window.lynn.onEvent((ev: KernelEvent) => {
      if (ev.type === "card") {
        setSnap((s) => (s ? { ...s, feed: upsertCard(s.feed, ev.card) } : s));
        return;
      }
      if (ev.type === "delta" && ev.cardId) {
        setSnap((s) =>
          s
            ? {
                ...s,
                feed: s.feed.map((c) => (c.id === ev.cardId ? { ...c, text: ev.text } : c)),
              }
            : s,
        );
        return;
      }
      if (ev.type === "turn") {
        setSnap((s) => (s ? { ...s, turn: ev.turn } : s));
        return;
      }
      void refresh();
    });
    return off;
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
    async (text: string, mode: "queue" | "steer" = "queue") => {
      setNotice(null);
      try {
        const r = await rpc("feed.send", { text, mode });
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

  /** 新对话：清空当前会话（工单、卷宗、成员档案保留） */
  const onNew = useCallback(async () => {
    setNotice(null);
    try {
      await rpc("session.new");
      await refresh();
    } catch (err) {
      setNotice(`新对话失败：${err instanceof Error ? err.message : String(err)}`);
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
    <>
      <DeskView
        desk={desk}
        permission={snap.permission}
        configured={snap.model.configured}
        ambient={ambient}
        ambientMode={ambientMode}
        onPermission={(m) => void onPermission(m)}
        onSend={(t, mode) => void onSend(t, mode)}
        onAbort={() => void onAbort()}
        onQueue={(a, id) => void onQueue(a, id)}
        onDecision={(id, a, reason) => void onDecision(id, a, reason)}
        onDecisionResolve={(id, a, text) => void onDecisionResolve(id, a, text)}
        onFeedAction={onFeedAction}
        onOpenSettings={() => setSettingsOpen(true)}
        onStandby={() => setStandby(true)}
        onNew={() => void onNew()}
        onUndo={() => void onUndo()}
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
          onClose={() => setSettingsOpen(false)}
          onSaved={() => void refresh()}
        />
      )}
    </>
  );
}
