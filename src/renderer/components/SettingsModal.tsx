import { useEffect, useMemo, useRef, useState } from "react";
import type { ModelConfigView, UsageView } from "../../shared/contract";
import { THEMES, type ThemeId, type ThemeMode } from "../desk/theme";
import { buildPack, checkPack, describePack, downloadPack, type LynnPack } from "../desk/lynnpack";
import { useUiPlugins } from "../desk/ui-host";
import { AvatarStage } from "../desk/AvatarStage";
import type { AvatarState } from "../../shared/avatar";
import { AMBIENT_MODE_LABEL, type AmbientMode } from "../../shared/ambient";
import { Icon, type IconName } from "./Icon";

const BUBBLE: Record<AvatarState, string> = {
  idle: "我在。今天想先做哪件？",
  thinking: "先看看这个表有几行…",
  running: "成员在跑，我盯着证据。",
  success: "这单可以收，等你盖章。",
  failed: "这次没过，我把原因写清楚了。",
  waiting_confirm: "这里要你拍板，我不敢替你定。",
  standby: "待机中，随时叫我。",
};

const PRESETS = [
  { name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat" },
  { name: "智谱 GLM", baseUrl: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4.6" },
  { name: "Kimi", baseUrl: "https://api.moonshot.cn/v1", model: "kimi-k2-0905-preview" },
  { name: "Qwen", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus" },
  { name: "MiniMax", baseUrl: "https://api.minimax.chat/v1", model: "MiniMax-M2" },
];

type Tab = "overview" | "model" | "plugins" | "safety" | "look" | "data";

const NAV: { k: Tab; label: string; icon: IconName }[] = [
  { k: "overview", label: "概览", icon: "home" },
  { k: "model", label: "模型", icon: "cpu" },
  { k: "plugins", label: "能力与插件", icon: "layers" },
  { k: "safety", label: "权限与安全", icon: "shield" },
  { k: "look", label: "外观", icon: "pen" },
  { k: "data", label: "数据与日志", icon: "folder" },
];

/**
 * 「我的风铃」：六页导航（概览 / 模型 / 能力与插件 / 权限与安全 / 外观 / 数据与日志）。
 * 每一页只放真实可用的配置；没实现的能力不在这里出现（不做占位）。
 */
export function SettingsModal({
  current,
  theme,
  mode,
  avatar,
  ambientMode,
  members,
  autoStart,
  project,
  usage,
  onTheme,
  onAvatar,
  onPack,
  onAmbient,
  onApplyThemeTokens,
  onAutoStart,
  onTrust,
  onClose,
  onSaved,
}: {
  current: ModelConfigView;
  theme: ThemeId;
  mode: ThemeMode;
  avatar: boolean;
  ambientMode: AmbientMode;
  members: { name: string; role: string }[];
  autoStart: boolean;
  project?: { root: string; trusted: boolean; hasMcp: boolean };
  usage: UsageView;
  onTheme: (id: ThemeId, mode: ThemeMode) => void;
  onAvatar: (on: boolean) => void;
  onPack: (p: LynnPack) => void;
  onAmbient: (m: AmbientMode) => void;
  onApplyThemeTokens: (tokens?: Record<string, string>) => void;
  onAutoStart: (v: boolean) => void;
  onTrust?: (trusted: boolean) => void;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [tab, setTab] = useState<Tab>("overview");
  const [provider, setProvider] = useState(current.provider || "DeepSeek");
  const [baseUrl, setBaseUrl] = useState(current.baseUrl || "https://api.deepseek.com/v1");
  const [model, setModel] = useState(current.model || "deepseek-chat");
  const [apiKey, setApiKey] = useState("");
  const [avState, setAvState] = useState<AvatarState>("waiting_confirm");
  const [busy, setBusy] = useState<"" | "save" | "test" | "clear">("");
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [packMsg, setPackMsg] = useState<string>("");
  const [preview, setPreview] = useState<{ pack: LynnPack; lines: string[] } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const { all: uiPlugins, disabled: uiDisabled, errors: uiErrors, toggle: toggleUi } = useUiPlugins();

  const [plugins, setPlugins] = useState<
    { id: string; name: string; version: string; tier: string; enabled: boolean; loadable: boolean }[]
  >([]);
  const [themePlugins, setThemePlugins] = useState<
    { id: string; name: string; theme?: { dark?: Record<string, string>; light?: Record<string, string> } }[]
  >([]);
  const [setStatus, setSetStatus] = useState<{
    fingerprint: string;
    count: number;
    safeMode: boolean;
    safeModeReason?: string;
  } | null>(null);

  const refreshPlugins = async () => {
    try {
      const r = await window.lynn.rpc("plugins.list");
      const list = Array.isArray(r?.plugins) ? r.plugins : [];
      setPlugins(list.map((p) => ({ id: p.id, name: p.name, version: p.version, tier: p.tier, enabled: p.enabled, loadable: p.loadable })));
      setThemePlugins(list.filter((p) => p.theme).map((p) => ({ id: p.id, name: p.name, theme: p.theme })));
    } catch {
      /* 无内核时忽略 */
    }
    try {
      const s = await window.lynn.rpc("plugins.status");
      if (s && typeof s.fingerprint === "string") {
        setSetStatus({ fingerprint: s.fingerprint, count: s.count, safeMode: s.safeMode, safeModeReason: s.safeModeReason });
      }
    } catch {
      /* 同上 */
    }
  };

  useEffect(() => {
    void refreshPlugins();
  }, []);

  // Esc 关闭 + 焦点不逃逸（模态基本盘）
  const cardRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key !== "Tab" || !cardRef.current) return;
      const nodes = cardRef.current.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (nodes.length === 0) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    cardRef.current?.querySelector<HTMLElement>("button, input")?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const save = async () => {
    if (!provider.trim() || !baseUrl.trim() || !model.trim()) {
      setResult({ ok: false, text: "服务商、Base URL、模型都要填。" });
      return;
    }
    setBusy("save");
    setResult(null);
    try {
      await window.lynn.rpc("config.save", {
        provider: provider.trim(),
        baseUrl: baseUrl.trim(),
        model: model.trim(),
        apiKey: apiKey.trim() || undefined,
      });
      setResult({ ok: true, text: "已保存；下一条消息生效。" });
      setApiKey("");
      onSaved();
    } catch (err) {
      setResult({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy("");
    }
  };

  const testConn = async () => {
    setBusy("test");
    setResult(null);
    try {
      const r = await window.lynn.rpc("config.test", {
        baseUrl: baseUrl.trim(),
        apiKey: apiKey.trim(),
        model: model.trim(),
      });
      setResult(r.ok ? { ok: true, text: `连通正常，延迟 ${r.latencyMs}ms` } : { ok: false, text: r.error });
    } catch (err) {
      setResult({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy("");
    }
  };

  const clearKey = async () => {
    setBusy("clear");
    try {
      const r = await window.lynn.rpc("config.clearKey");
      setResult(r.ok ? { ok: true, text: "已清除本机保存的 Key。" } : { ok: false, text: "没有已保存的 Key。" });
      onSaved();
    } finally {
      setBusy("");
    }
  };

  const exportPack = () => {
    const pack = buildPack({
      theme: { id: theme, mode },
      avatar,
      model: { provider: provider.trim(), baseUrl: baseUrl.trim(), model: model.trim() },
      capabilities: [],
      roles: members.map((m) => ({ name: m.name, role: m.role, goal: "", tools: [] })),
      teamName: "我的班底",
    });
    const name = downloadPack(pack);
    setPackMsg(`已导出 ${name}（只含配置，不含记忆 / 会话 / 凭据）`);
  };

  const pickPack = async (file: File) => {
    setPackMsg("");
    setPreview(null);
    const text = await file.text();
    const r = checkPack(text);
    if (!r.ok || !r.pack) {
      setPackMsg(`导入失败：${r.issues.join("；")}`);
      return;
    }
    setPreview({ pack: r.pack, lines: describePack(r.pack) });
  };

  const ctxPct = usage.contextWindow > 0 ? Math.round((usage.contextTokens / usage.contextWindow) * 100) : 0;
  const statusBadge = current.configured && current.apiKeySet ? "ok" : current.configured ? "warn" : "bad";
  const statusText = statusBadge === "ok" ? "已配置" : statusBadge === "warn" ? "缺 Key" : "未配置";

  const page = useMemo(() => {
    if (tab === "model") {
      return (
        <div className="sf-pane">
          <h3>模型</h3>
          <div className="sf-inline">
            {PRESETS.map((p) => (
              <button
                type="button"
                key={p.name}
                className={`sf-btn${provider === p.name ? " primary" : ""}`}
                onClick={() => {
                  setProvider(p.name);
                  setBaseUrl(p.baseUrl);
                  setModel(p.model);
                  setResult(null);
                }}
              >
                {p.name}
              </button>
            ))}
          </div>
          <div className="sf-grid2">
            <label className="sf-field">
              <span className="sf-label">服务商</span>
              <input className="sf-input" value={provider} onChange={(e) => setProvider(e.target.value)} />
            </label>
            <label className="sf-field">
              <span className="sf-label">模型</span>
              <input className="sf-input" value={model} onChange={(e) => setModel(e.target.value)} />
            </label>
          </div>
          <label className="sf-field">
            <span className="sf-label">Base URL</span>
            <input className="sf-input" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
          </label>
          <label className="sf-field">
            <span className="sf-label">API Key</span>
            <input
              className="sf-input"
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={current.apiKeySet ? "已加密保存 · 留空沿用" : "sk-…"}
            />
            <small className="sf-hint">safeStorage 加密，只存本机；不会下发给渲染层</small>
          </label>
          {result && <div className={`sf-result ${result.ok ? "ok" : "bad"}`}>{result.text}</div>}
          <div className="sf-actions">
            <button type="button" className="sf-btn" onClick={() => void testConn()} disabled={busy !== "" || (!apiKey.trim() && !current.apiKeySet)}>
              {busy === "test" ? "测试中…" : "测试连接"}
            </button>
            <button type="button" className="sf-btn primary" onClick={() => void save()} disabled={busy !== ""}>
              {busy === "save" ? "保存中…" : "保存"}
            </button>
            <button type="button" className="sf-btn" onClick={() => void clearKey()} disabled={busy !== "" || !current.apiKeySet}>
              {busy === "clear" ? "清除中…" : "清除 Key"}
            </button>
          </div>
        </div>
      );
    }

    if (tab === "plugins") {
      return (
        <div className="sf-pane">
          <h3>能力与插件</h3>
          <div className="sf-hint">
            插件集指纹 <span className="mono">{setStatus?.fingerprint.slice(0, 12) ?? "—"}</span> · {setStatus?.count ?? 0} 个
            {setStatus?.safeMode && <span className="sf-badge bad">安全模式：{setStatus.safeModeReason ?? "多次启动失败"}</span>}
          </div>
          {plugins.length === 0 ? (
            <p className="sf-empty">还没有装插件。把插件目录放进 ~/.lynn/plugins/ 后重开这里。</p>
          ) : (
            <div className="sf-list">
              {plugins.map((p) => (
                <div className="sf-row" key={p.id}>
                  <div className="sf-row-main">
                    <b>{p.name}</b>
                    <small className="mono">
                      {p.id} · v{p.version} · {p.tier}
                    </small>
                  </div>
                  <button
                    type="button"
                    className={`sf-btn${p.enabled ? " primary" : ""}`}
                    onClick={() =>
                      void window.lynn.rpc("plugins.toggle", { id: p.id, enabled: !p.enabled }).then(() => refreshPlugins())
                    }
                  >
                    {p.enabled ? "停用" : "启用"}
                  </button>
                  <button
                    type="button"
                    className="sf-btn"
                    onClick={() =>
                      void window.lynn.rpc("plugins.probe", { id: p.id }).then((r) =>
                        setResult({ ok: r.ok, text: `试装 ${p.id}：${r.detail}` }),
                      )
                    }
                  >
                    试装
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="sf-actions">
            <button
              type="button"
              className="sf-btn"
              onClick={() =>
                void window.lynn.rpc("plugins.rollback", {}).then((r) => {
                  setResult({ ok: r.ok, text: r.ok ? "已回滚到上一次插件集（不动用户数据）。" : r.detail });
                  if (r.ok) void refreshPlugins();
                })
              }
            >
              回滚上次变更
            </button>
          </div>
          {themePlugins.length > 0 && (
            <div className="sf-sub">
              <span className="sf-label">主题插件</span>
              <div className="sf-inline">
                {themePlugins.map((p) => (
                  <button
                    type="button"
                    key={p.id}
                    className="sf-btn"
                    onClick={() => onApplyThemeTokens(p.theme?.[mode] ?? p.theme?.dark ?? p.theme?.light)}
                  >
                    {p.name}
                  </button>
                ))}
                <button type="button" className="sf-btn" onClick={() => onApplyThemeTokens(undefined)}>
                  恢复主题
                </button>
              </div>
            </div>
          )}
          <div className="sf-sub">
            <span className="sf-label">界面卡槽 · U 档（{uiPlugins.length}）</span>
            {uiPlugins.length === 0 ? (
              <p className="sf-empty">没有 U 档插件。第三方一律 iframe 沙箱，只回传一条动作。</p>
            ) : (
              <div className="sf-list">
                {uiPlugins.map((p) => (
                  <div className="sf-row" key={p.id}>
                    <div className="sf-row-main">
                      <b>{p.name}</b>
                      <small className="mono">
                        {p.id} · {p.slots.join(" / ")}
                      </small>
                    </div>
                    <button type="button" className={`sf-btn${uiDisabled.includes(p.id) ? "" : " primary"}`} onClick={() => toggleUi(p.id)}>
                      {uiDisabled.includes(p.id) ? "启用" : "停用"}
                    </button>
                  </div>
                ))}
              </div>
            )}
            {uiErrors.length > 0 && <div className="sf-result bad">{uiErrors.join("；")}</div>}
          </div>
          {result && <div className={`sf-result ${result.ok ? "ok" : "bad"}`}>{result.text}</div>}
        </div>
      );
    }

    if (tab === "safety") {
      return (
        <div className="sf-pane">
          <h3>权限与安全</h3>
          <div className="sf-row">
            <div className="sf-row-main">
              <b>任务契约每次确认</b>
              <small>动手前先给你看「目标 / 验收标准 / 谁来做 / 预算」，你点开始才开工。</small>
            </div>
            <button
              type="button"
              className={`sf-btn${autoStart ? "" : " primary"}`}
              onClick={() => onAutoStart(false)}
            >
              每次确认
            </button>
            <button type="button" className={`sf-btn${autoStart ? " primary" : ""}`} onClick={() => onAutoStart(true)}>
              自动开始
            </button>
          </div>
          <div className="sf-sub">
            <span className="sf-label">顶栏四档权限</span>
            <p className="sf-hint">计划 / 询问 / 自动 / 全权：决定她能不能直接调工具、哪些必须问你。设置里看当前档位，改档在顶栏。</p>
          </div>
          <div className="sf-row">
            <div className="sf-row-main">
              <b>
                当前项目
                <span className={`sf-badge ${project?.trusted ? "ok" : "warn"}`}>
                  {project?.trusted ? "已信任" : "未信任"}
                </span>
              </b>
              <small className="mono">{project?.root ?? "—"}</small>
              <small>
                {project?.hasMcp
                  ? "这个项目带 .lynn/mcp.json：未信任时不会加载，信任后重连。"
                  : "项目里没有 .lynn/mcp.json。"}
              </small>
            </div>
            <button type="button" className="sf-btn" onClick={() => onTrust?.(!project?.trusted)}>
              {project?.trusted ? "取消信任" : "信任此项目"}
            </button>
          </div>

          <div className="sf-sub">
            <span className="sf-label">成员的执行边界（纵深防御，不是沙箱）</span>
            <p className="sf-hint">
              文件只能动本单工作区；明显破坏/提权/远程直执行的命令会被拦下；出站命令逐条写
              <span className="mono"> audit.jsonl</span>。**不是 OS 级隔离**——不承诺挡住恶意二进制，只保证越界可查。
            </p>
          </div>
          <div className="sf-sub">
            <span className="sf-label">数据与遥测</span>
            <p className="sf-hint">
              全部落在 <span className="mono">~/.lynn/</span>；不引入遥测（Pi 的 PI_TELEMETRY=0），出站只有你配置的模型端点。
            </p>
          </div>
        </div>
      );
    }

    if (tab === "look") {
      return (
        <div className="sf-pane">
          <h3>外观</h3>
          <span className="sf-label">主题</span>
          <div className="theme-row">
            {THEMES.map((t) => {
              const c = t[mode];
              return (
                <button
                  type="button"
                  key={t.id}
                  className={`theme${theme === t.id ? " on" : ""}`}
                  onClick={() => onTheme(t.id, mode)}
                  title={`${t.name} · ${t.hint}`}
                >
                  <div className="swatches">
                    <i style={{ background: c.desk }} />
                    <i style={{ background: c.blue }} />
                    <i style={{ background: c.seal }} />
                    <i style={{ background: c.brass }} />
                  </div>
                  <div className="theme-name">
                    <span className="t">{t.name}</span>
                  </div>
                  <div className="theme-desc">{t.hint}</div>
                </button>
              );
            })}
          </div>
          <div className="sf-inline">
            <button type="button" className={`sf-btn${mode === "dark" ? " primary" : ""}`} onClick={() => onTheme(theme, "dark")}>
              暗色
            </button>
            <button type="button" className={`sf-btn${mode === "light" ? " primary" : ""}`} onClick={() => onTheme(theme, "light")}>
              亮色
            </button>
          </div>
          <span className="sf-label">动效</span>
          <div className="sf-inline">
            {(["full", "low", "off"] as AmbientMode[]).map((m) => (
              <button type="button" key={m} className={`sf-btn${ambientMode === m ? " primary" : ""}`} onClick={() => onAmbient(m)}>
                {AMBIENT_MODE_LABEL[m]}
              </button>
            ))}
          </div>
          <span className="sf-label">形象（只在设置与桌宠里出现）</span>
          <div className="sf-inline">
            <button type="button" className={`sf-btn${avatar ? " primary" : ""}`} onClick={() => onAvatar(true)}>
              启用
            </button>
            <button type="button" className={`sf-btn${!avatar ? " primary" : ""}`} onClick={() => onAvatar(false)}>
              关闭
            </button>
            <button type="button" className="sf-btn" onClick={() => void window.lynn.rpc("pet.open")}>
              唤出桌宠
            </button>
          </div>
          {avatar && <AvatarStage state={avState} onState={setAvState} bubble={BUBBLE[avState]} height={200} />}
        </div>
      );
    }

    if (tab === "data") {
      return (
        <div className="sf-pane">
          <h3>数据与日志</h3>
          <div className="sf-actions">
            <button type="button" className="sf-btn" onClick={() => void window.lynn.rpc("app.openData", { kind: "data" })}>
              打开数据目录
            </button>
            <button type="button" className="sf-btn" onClick={() => void window.lynn.rpc("app.openData", { kind: "logs" })}>
              打开日志目录
            </button>
            <button
              type="button"
              className="sf-btn"
              onClick={() => {
                if (!window.confirm("清空当前会话？工单与卷宗会保留。")) return;
                void window.lynn.rpc("session.new").then(() => {
                  setPackMsg("当前会话已清空（卷宗仍在）。");
                  onSaved();
                });
              }}
            >
              清空当前会话
            </button>
          </div>
          <span className="sf-label">配置包</span>
          <div className="sf-actions">
            <button type="button" className="sf-btn" onClick={exportPack}>
              导出 .lynnpack
            </button>
            <button type="button" className="sf-btn" onClick={() => fileRef.current?.click()}>
              导入 .lynnpack
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".lynnpack,.json"
              style={{ display: "none" }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void pickPack(f);
              }}
            />
          </div>
          {packMsg && <div className="sf-hint">{packMsg}</div>}
          {preview && (
            <div className="sf-preview">
              <ul>
                {preview.lines.map((l, i) => (
                  <li key={i}>{l}</li>
                ))}
              </ul>
              <div className="sf-actions">
                <button
                  type="button"
                  className="sf-btn primary"
                  onClick={() => {
                    onPack(preview.pack);
                    setPreview(null);
                    setPackMsg("配置包已应用（只含主题 / 形象 / 模型）。");
                  }}
                >
                  应用
                </button>
                <button type="button" className="sf-btn" onClick={() => setPreview(null)}>
                  取消
                </button>
              </div>
            </div>
          )}
        </div>
      );
    }

    return (
      <div className="sf-pane">
        <h3>概览</h3>
        <div className="sf-grid2">
          <div className="sf-tile">
            <span className="sf-label">模型</span>
            <b>
              {current.model || "未配置"} <span className={`sf-badge ${statusBadge}`}>{statusText}</span>
            </b>
            <small className="mono">{current.baseUrl || "—"}</small>
          </div>
          <div className="sf-tile">
            <span className="sf-label">上下文</span>
            <b>{ctxPct}%</b>
            <small className="mono">
              {usage.contextTokens} / {usage.contextWindow}
            </small>
          </div>
          <div className="sf-tile">
            <span className="sf-label">会话用量</span>
            <b>{usage.sessionIn + usage.sessionOut} tokens</b>
            <small className="mono">
              入 {usage.sessionIn} · 出 {usage.sessionOut}
            </small>
          </div>
          <div className="sf-tile">
            <span className="sf-label">任务契约</span>
            <b>{autoStart ? "自动开始" : "每次确认"}</b>
            <small>改动在「权限与安全」</small>
          </div>
        </div>
        <div className="sf-row">
          <div className="sf-row-main">
            <b>她的班底 · {members.length} 人</b>
            <small>{members.length === 0 ? "还没有编制。派一件需要动手的活，她会自己招人。" : members.map((m) => m.name).join("、")}</small>
          </div>
        </div>
        <div className="sf-actions">
          <button type="button" className="sf-btn primary" onClick={() => setTab("model")}>
            {current.configured ? "调整模型" : "去配置模型"}
          </button>
        </div>
      </div>
    );
  }, [
    tab,
    provider,
    baseUrl,
    model,
    apiKey,
    current,
    mode,
    theme,
    avatar,
    avState,
    ambientMode,
    autoStart,
    usage,
    members,
    busy,
    result,
    plugins,
    themePlugins,
    setStatus,
    uiPlugins,
    uiDisabled,
    uiErrors,
    preview,
    packMsg,
    ctxPct,
    statusBadge,
    statusText,
    onAmbient,
    onApplyThemeTokens,
    onAutoStart,
    onAvatar,
    onTheme,
    toggleUi,
  ]);

  return (
    <div className="sf-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sf-card wide" ref={cardRef} role="dialog" aria-modal="true" aria-label="我的风铃">
        <header className="sf-head">
          <div>
            <b>我的风铃</b>
            <span className="sf-sub">皮 · 形 · 脑 · 班底 · 数据</span>
          </div>
          <button type="button" className="sf-x" onClick={onClose} title="关闭（Esc）">
            ✕
          </button>
        </header>
        <div className="sf-shell">
          <nav className="sf-nav">
            {NAV.map((n) => (
              <button type="button" key={n.k} className={`sf-nav-item${tab === n.k ? " on" : ""}`} onClick={() => setTab(n.k)}>
                <Icon name={n.icon} size="sm" />
                {n.label}
              </button>
            ))}
          </nav>
          <div className="sf-body">{page}</div>
        </div>
      </div>
    </div>
  );
}
