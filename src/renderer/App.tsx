import { useCallback, useEffect, useRef, useState } from "react";
import type {
  FeedCard,
  KernelEvent,
  PermissionMode,
  RpcContracts,
  RpcMethod,
  SessionSnapshot,
} from "../shared/contract";
import { TopBar } from "./components/TopBar";
import { Feed } from "./components/Channel";
import { Board } from "./components/Board";
import { Composer } from "./components/Composer";
import { SettingsModal } from "./components/SettingsModal";

/** 渲染层只认 contract.ts 里的类型化 RPC；不感知内核实现是直连还是 Pi。 */
async function rpc<M extends RpcMethod>(
  method: M,
  ...args: RpcContracts[M]["params"] extends void ? [] : [RpcContracts[M]["params"]]
): Promise<RpcContracts[M]["result"]> {
  return window.lynn.rpc(method, ...args);
}

const NAV_ITEMS: { icon: string; title: string }[] = [
  { icon: "◉", title: "指挥台" },
  { icon: "☰", title: "团队编制" },
  { icon: "▤", title: "任务卷宗" },
  { icon: "❑", title: "知识库" },
  { icon: "▦", title: "日程" },
  { icon: "◫", title: "插件" },
];

export default function App() {
  const [snap, setSnap] = useState<SessionSnapshot | null>(null);
  const [theme, setTheme] = useState<"dark" | "light">("light");
  const [nav, setNav] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** 本地流式层：delta 追加到她的话；done 后用权威快照覆盖 */
  const [liveText, setLiveText] = useState<string | null>(null);
  const [liveTools, setLiveTools] = useState<FeedCard[]>([]);
  const feedRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    setSnap(await rpc("session.snapshot"));
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    document.body.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    if (snap) document.body.dataset.mode = snap.permission;
  }, [snap]);

  // 内核事件 → 本地流式层；done/error 后拉权威快照
  useEffect(() => {
    const off = window.lynn.onEvent((ev: KernelEvent) => {
      if (ev.type === "delta") {
        setLiveText((t) => (t ?? "") + ev.text);
      } else if (ev.type === "tool") {
        setLiveTools((cards) => [
          ...cards,
          {
            id: `live-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            kind: "tool",
            createdAt: "",
            badge: ev.badge,
            title: ev.title,
            meta: ev.meta,
            body: ev.body,
            members: ev.members,
          },
        ]);
      } else {
        // done / error：快照为准
        setLiveText(null);
        setLiveTools([]);
        void refresh();
      }
    });
    return off;
  }, [refresh]);

  useEffect(() => {
    feedRef.current?.scrollTo({ top: 1e9 });
  }, [snap, liveText, liveTools]);

  if (!snap) {
    return (
      <div style={{ display: "grid", placeItems: "center", height: "100vh", color: "var(--text-dim)" }}>
        风铃正在启动……
      </div>
    );
  }

  const onMode = async (m: PermissionMode) => {
    await rpc("permission.set", { mode: m });
    await refresh();
  };

  const onSend = async (text: string) => {
    setLiveText("");
    setLiveTools([]);
    await rpc("feed.send", { text });
  };

  const onDecision = async (id: string, action: "approve" | "reject" | "ask") => {
    await rpc("decision.resolve", { id, action });
    await refresh();
  };

  return (
    <div className="app">
      <TopBar
        snap={snap}
        theme={theme}
        onMode={onMode}
        onTheme={() => setTheme(theme === "dark" ? "light" : "dark")}
        onSettings={() => setSettingsOpen(true)}
      />

      <nav className="rail">
        {NAV_ITEMS.map((n, i) => (
          <button
            key={n.title}
            className={`nav${i === nav ? " on" : ""}`}
            title={n.title}
            onClick={() => setNav(i)}
          >
            {n.icon}
          </button>
        ))}
        <div className="spacer" />
        <div className="avatar-mini" title="风铃" />
        <button className="nav" title="设置" onClick={() => setSettingsOpen(true)}>⚙</button>
      </nav>

      <main className="center">
        <div className="col">
          <Feed
            feed={snap.feed}
            liveText={liveText}
            liveTools={liveTools}
            scrollRef={feedRef}
          />
          <Composer permission={snap.permission} configured={snap.model.configured} onSend={onSend} />
        </div>
      </main>

      <Board board={snap.board} onDecision={onDecision} />

      {settingsOpen && (
        <SettingsModal
          current={snap.model}
          onClose={() => setSettingsOpen(false)}
          onSaved={() => void refresh()}
        />
      )}
    </div>
  );
}
