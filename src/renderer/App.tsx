import { useCallback, useEffect, useState } from "react";
import type {
  Evidence,
  PermissionMode,
  RpcContracts,
  RpcMethod,
  SessionSnapshot,
} from "../shared/contract";
import { TopBar } from "./components/TopBar";
import { ChannelHead, Feed } from "./components/Channel";
import { Board } from "./components/Board";
import { Composer } from "./components/Composer";
import { EvidenceModal } from "./components/EvidenceModal";

/** 渲染层只认 contract.ts 里的类型化 RPC；不感知内核是 Mock 还是 Pi。 */
async function rpc<M extends RpcMethod>(
  method: M,
  ...args: RpcContracts[M]["params"] extends void ? [] : [RpcContracts[M]["params"]]
): Promise<RpcContracts[M]["result"]> {
  return window.lynn.rpc(method, ...args);
}

const NAV_ITEMS: { icon: string; title: string; badge?: number }[] = [
  { icon: "◉", title: "指挥台" },
  { icon: "☰", title: "团队编制", badge: 2 },
  { icon: "▤", title: "任务卷宗" },
  { icon: "❑", title: "知识库" },
  { icon: "▦", title: "日程" },
  { icon: "◫", title: "插件" },
];

export default function App() {
  const [snap, setSnap] = useState<SessionSnapshot | null>(null);
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [nav, setNav] = useState(0);
  const [evidence, setEvidence] = useState<Evidence | null>(null);

  const refresh = useCallback(async () => {
    const s = await rpc("session.snapshot");
    setSnap(s);
  }, []);

  useEffect(() => {
    void refresh();
    // Mock 阶段轮询快照（成员进度/流水线推进）；接 Pi 后换成事件推送
    const t = setInterval(() => void refresh(), 10_000);
    return () => clearInterval(t);
  }, [refresh]);

  useEffect(() => {
    document.body.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    if (snap) document.body.dataset.mode = snap.permission;
  }, [snap]);

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
    await rpc("feed.send", { text });
    await refresh();
    // 滚到最新
    requestAnimationFrame(() => {
      document.querySelector(".feed")?.scrollTo({ top: 1e9, behavior: "smooth" });
    });
  };

  const onDecision = async (id: string, action: "approve" | "reject" | "ask") => {
    await rpc("decision.resolve", { id, action });
    await refresh();
  };

  const onEvidence = (e: Evidence) => setEvidence(e);

  return (
    <div className="app">
      <TopBar snap={snap} theme={theme} onMode={onMode} onTheme={() => setTheme(theme === "dark" ? "light" : "dark")} />

      <nav className="rail">
        {NAV_ITEMS.map((n, i) => (
          <button key={n.title} className={`nav${i === nav ? " on" : ""}`} title={n.title} onClick={() => setNav(i)}>
            {n.icon}
            {n.badge && <span className="badge">{n.badge}</span>}
          </button>
        ))}
        <div className="spacer" />
        <div className="avatar-mini" title="风铃" />
        <button className="nav" title="设置">⚙</button>
      </nav>

      <main className="center">
        <div className="col">
          {snap.task && <ChannelHead task={snap.task} />}
          <Feed cards={snap.feed} onEvidence={onEvidence} onDecision={onDecision} />
          <Composer permission={snap.permission} onSend={onSend} />
        </div>
      </main>

      <Board board={snap.board} onDecision={onDecision} />

      <EvidenceModal evidence={evidence} onClose={() => setEvidence(null)} />
    </div>
  );
}
